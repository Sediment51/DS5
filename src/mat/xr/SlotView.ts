import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import type { KitItem, QuantityVisual } from '../lib/kit';
import type { SlotLayout } from '../lib/layout';
import { COLORS, makeText, setTextOpacity } from './text';

/** The label's lowest point, above the table. */
const LABEL_LIFT = 0.004;
export const BADGE_RADIUS = 0.0075;
const TEXT_GAP = 0.0025;
const SIZES = { name: 0.0125, quantity: 0.0095, purpose: 0.0115, badge: 0.0095 };
const ACTIVE_LABEL_SCALE = 1.15;
/**
 * Labels lie on the table in front of their outline, raised this far (degrees)
 * from flat towards the user: readable from a seat, never standing up.
 */
const LABEL_TILT_DEG = 30;

const sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
/** Upper half of a unit sphere: a dome for liquids, scaled flat. */
const domeGeometry = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);

const offset = new THREE.Matrix4();
const toMat = new THREE.Matrix4();

/**
 * One item on the mat: where its outline goes, its quantity model, and its
 * label (step badge, name, quantity, and when highlighted its purpose),
 * lying on the table tilted towards the user. The outline, badge and text are
 * drawn by the mat's shared batches; this keeps their state and works out
 * the label's pose.
 */
export class SlotView {
  /** The quantity model, resting on the table. */
  readonly visual = new THREE.Group();
  /** An empty frame lying on the table, tilted up towards the user; the label's texts and badge follow it. */
  readonly label = new THREE.Group();
  /** Every text of this slot, for the shared text batch. */
  readonly texts: Text[];
  page = 0;
  alpha = 1;
  active = false;
  footprintX = 0;
  footprintZ = 0;
  /** The whole cell (outline and label), for pressing it: centre and size. */
  cellX = 0;
  cellZ = 0;
  cellWidth = 0;
  cellDepth = 0;

  private readonly visualMaterial: THREE.MeshStandardMaterial | null;
  private readonly badgeText: Text;
  private readonly name: Text;
  private readonly quantity: Text;
  private readonly purpose: Text;
  private readonly badgePosition = new THREE.Vector3();

  constructor(readonly item: KitItem) {
    this.visualMaterial = item.visual
      ? new THREE.MeshStandardMaterial({ color: item.visual.color, roughness: 0.45, transparent: true })
      : null;
    if (item.visual && this.visualMaterial) buildVisual(this.visual, item.visual, this.visualMaterial);

    // Flat (text up = away from the user), then raised towards them.
    this.label.rotation.x = THREE.MathUtils.degToRad(-90 + LABEL_TILT_DEG);
    this.badgeText = makeText(String(item.step), {
      size: SIZES.badge,
      weight: 'bold',
      color: COLORS.ink,
      anchorX: 'center',
      anchorY: 'middle',
      halo: false,
    });
    // The name is the main line; the quantity is secondary; the purpose shows only when highlighted.
    this.name = makeText(item.name, { size: SIZES.name, weight: 'bold', color: COLORS.label, anchorY: 'bottom' });
    this.quantity = makeText(item.quantity, { size: SIZES.quantity, color: COLORS.muted, anchorY: 'bottom' });
    this.purpose = makeText(item.purpose, { size: SIZES.purpose, weight: 'bold', color: COLORS.mint, anchorY: 'bottom' });
    this.texts = [this.badgeText, this.name, this.quantity, this.purpose];
    for (const text of this.texts) text.matrixAutoUpdate = false;
    setTextOpacity(this.purpose, 0);
    for (const text of [this.name, this.quantity, this.purpose]) text.sync(this.stackLabel);
  }

  /** Moves the slot to its cell. */
  place(slot: SlotLayout) {
    this.page = slot.page;
    this.footprintX = slot.footprintX;
    this.footprintZ = slot.footprintZ;
    this.cellX = slot.left + slot.width / 2;
    this.cellZ = slot.back + slot.depth / 2;
    this.cellWidth = slot.width;
    this.cellDepth = slot.depth;
    this.visual.position.set(slot.visualX, 0, slot.visualZ);
    this.label.position.set(slot.labelX, LABEL_LIFT, slot.labelZ);
    this.name.maxWidth = slot.width - (2 * BADGE_RADIUS + 0.004);
    this.quantity.maxWidth = slot.width;
    this.purpose.maxWidth = Math.max(slot.width + 0.04, 0.16);
    for (const text of [this.name, this.quantity, this.purpose]) text.sync(this.stackLabel);
  }

  /**
   * Strength (overlay opacity × step-mode dimming; 0 when off the page) and
   * whether it's the current step, which shows its purpose and a larger label.
   */
  setState(alpha: number, active: boolean) {
    if (alpha === this.alpha && active === this.active) return;
    const restack = active !== this.active;
    this.alpha = alpha;
    this.active = active;
    this.visual.visible = alpha > 0.002;
    if (this.visualMaterial) {
      this.visualMaterial.opacity = 0.95 * alpha;
      this.visualMaterial.depthWrite = alpha > 0.98;
    }
    for (let i = 0; i < this.texts.length; i++) setTextOpacity(this.texts[i], alpha);
    if (!active) setTextOpacity(this.purpose, 0);
    if (restack) {
      this.label.scale.setScalar(active ? ACTIVE_LABEL_SCALE : 1);
      this.stackLabel();
    }
  }

  /**
   * Poses the label's texts and badge in the space of `matInverse` (the
   * inverse of the mat overlay's world matrix), where the batches draw them.
   * @param badgeMatrix receives the badge's pose.
   */
  pose(matInverse: THREE.Matrix4, badgeMatrix: THREE.Matrix4) {
    this.label.updateMatrixWorld();
    toMat.multiplyMatrices(matInverse, this.label.matrixWorld);
    for (let i = 0; i < this.texts.length; i++) {
      const text = this.texts[i];
      if (text === this.badgeText) {
        const p = this.badgePosition;
        offset.makeTranslation(p.x, p.y, p.z + 0.0005);
      } else {
        offset.makeTranslation(text.position.x, text.position.y, text.position.z);
      }
      text.matrix.multiplyMatrices(toMat, offset);
    }
    offset.makeTranslation(this.badgePosition.x, this.badgePosition.y, this.badgePosition.z);
    badgeMatrix.multiplyMatrices(toMat, offset);
  }

  dispose() {
    for (const text of this.texts) text.dispose();
    this.visualMaterial?.dispose();
  }

  /**
   * Stacks the label from its front edge back (its "up" runs away from the
   * user on the tilted label): purpose (when highlighted) nearest, then
   * quantity, then the badge and name furthest — so it reads name, quantity,
   * purpose from the top, and never dips below the table.
   */
  private readonly stackLabel = () => {
    const height = (text: Text) => {
      const b = text.textRenderInfo?.blockBounds;
      return b ? b[3] - b[1] : text.fontSize * 1.2;
    };
    const textX = 2 * BADGE_RADIUS + 0.004;
    let y = 0;
    if (this.active) {
      this.purpose.position.set(0, y, 0);
      y += height(this.purpose) + TEXT_GAP;
    }
    this.quantity.position.set(0, y, 0);
    y += height(this.quantity) + TEXT_GAP;
    this.name.position.set(textX, y, 0);
    const lineHeight = SIZES.name * 1.18;
    this.badgePosition.set(BADGE_RADIUS, y + height(this.name) - lineHeight / 2, -0.0005);
  };
}

/** True-scale model of the amount, resting on the table. */
function buildVisual(group: THREE.Group, visual: QuantityVisual, material: THREE.Material) {
  switch (visual.type) {
    case 'sphere': {
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.setScalar(visual.radius);
      mesh.position.y = visual.radius;
      group.add(mesh);
      break;
    }
    case 'blob': {
      const mesh = new THREE.Mesh(domeGeometry, material);
      mesh.scale.set(visual.radius, visual.height, visual.radius);
      group.add(mesh);
      break;
    }
    case 'drops': {
      const start = -((visual.count - 1) * visual.spacing) / 2;
      for (let i = 0; i < visual.count; i++) {
        const mesh = new THREE.Mesh(domeGeometry, material);
        mesh.scale.set(visual.radius, visual.height, visual.radius);
        mesh.position.x = start + i * visual.spacing;
        group.add(mesh);
      }
      break;
    }
  }
}
