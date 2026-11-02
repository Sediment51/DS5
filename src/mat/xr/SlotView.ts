import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import type { KitItem, QuantityVisual } from '../lib/kit';
import type { SlotLayout } from '../lib/layout';
import { COLORS, makeText, setTextOpacity } from './text';

/** Labels lie flat on the mat, this far above it (they never stand up or float). */
const LABEL_LIFT = 0.0012;
export const BADGE_RADIUS = 0.0072;
const TEXT_GAP = 0.0018;
/** Recipe-card hierarchy: the amount largest, then the name, then the steps it's used in. */
const SIZES = { quantity: 0.0118, name: 0.0098, steps: 0.0074, purpose: 0.0086, badge: 0.009 };
const ACTIVE_LABEL_SCALE = 1.08;
/** The hologram: its colour, and how it breathes and hovers. */
const HOLO_COLOR = new THREE.Color('#8fd0ff');
const HOLO_LIFT = 0.0015;
const HOLO_BOB = 0.0012;

const sphereGeometry = new THREE.SphereGeometry(1, 28, 18);
/** Upper half of a unit sphere: a dome for creams and liquids, scaled flat. */
const domeGeometry = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);

const offset = new THREE.Matrix4();
const toMat = new THREE.Matrix4();

/**
 * A holographic material: see-through blue with a bright rim and faint scan
 * lines, so it reads as a reference, not a real object, and the real material
 * placed in the same spot shows through it.
 */
function hologramMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: HOLO_COLOR.clone() }, opacity: { value: 1 }, time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        vHeight = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float opacity;
      uniform float time;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
        float scan = 0.5 + 0.5 * sin(vHeight * 1400.0 - time * 5.0);
        float alpha = (0.14 + 0.7 * rim + 0.1 * scan) * opacity;
        gl_FragColor = vec4(color * (0.75 + 0.6 * rim), alpha);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * One material on the mat, in its own cell: where its outline goes, a
 * hologram of the amount to take (shown on its compare spot while it's
 * needed), and its flat label (number, amount, name, the steps it's used
 * in, and when highlighted its purpose). The outlines, badge and text are
 * drawn by the mat's shared batches; this keeps their state and works out
 * the label's pose.
 */
export class SlotView {
  /** The amount's hologram, resting on its compare spot (shown only while highlighted). */
  readonly visual = new THREE.Group();
  /** An empty frame lying flat on the mat; the label's texts and badge follow it. */
  readonly label = new THREE.Group();
  /** Every text of this slot, for the shared text batch. */
  readonly texts: Text[];
  page = 0;
  alpha = 1;
  active = false;
  footprintX = 0;
  footprintZ = 0;
  /** The compare spot's centre and diameter (0: none). */
  compareX = 0;
  compareZ = 0;
  compare = 0;
  /** The whole cell (outline and label), for pressing it: centre and size. */
  cellX = 0;
  cellZ = 0;
  cellWidth = 0;
  cellDepth = 0;

  private readonly hologram: THREE.ShaderMaterial | null;
  private readonly badgeText: Text;
  private readonly quantity: Text;
  private readonly name: Text;
  private readonly steps: Text | null;
  private readonly purpose: Text;
  private readonly badgePosition = new THREE.Vector3();

  constructor(readonly item: KitItem) {
    this.hologram = item.visual ? hologramMaterial() : null;
    if (item.visual && this.hologram) buildVisual(this.visual, item.visual, this.hologram);
    this.visual.visible = false;

    // Flat on the mat, its text's "up" pointing away from the user, so it reads from the seat.
    this.label.rotation.x = -Math.PI / 2;
    this.badgeText = makeText(String(item.step), {
      size: SIZES.badge,
      weight: 'bold',
      color: COLORS.ink,
      anchorX: 'center',
      anchorY: 'middle',
      halo: false,
    });
    this.quantity = makeText(item.quantity, { size: SIZES.quantity, weight: 'bold', color: COLORS.accent, anchorY: 'bottom' });
    this.name = makeText(item.name, { size: SIZES.name, weight: 'bold', color: COLORS.label, anchorY: 'bottom' });
    this.steps = item.stages.length
      ? makeText(`${item.stages.length > 1 ? 'Steps' : 'Step'} ${item.stages.join(' · ')}`, {
          size: SIZES.steps,
          color: COLORS.muted,
          anchorY: 'bottom',
        })
      : null;
    this.purpose = makeText(item.purpose, { size: SIZES.purpose, weight: 'bold', color: COLORS.label, anchorY: 'bottom' });
    this.texts = [this.badgeText, this.quantity, this.name, ...(this.steps ? [this.steps] : []), this.purpose];
    for (const text of this.texts) text.matrixAutoUpdate = false;
    setTextOpacity(this.purpose, 0);
    for (const text of this.stacked()) text.sync(this.stackLabel);
  }

  /** Moves the slot to its cell. */
  place(slot: SlotLayout) {
    this.page = slot.page;
    this.footprintX = slot.footprintX;
    this.footprintZ = slot.footprintZ;
    this.compareX = slot.visualX;
    this.compareZ = slot.visualZ;
    this.compare = slot.compare;
    this.cellX = slot.left + slot.width / 2;
    this.cellZ = slot.back + slot.depth / 2;
    this.cellWidth = slot.width;
    this.cellDepth = slot.depth;
    this.visual.position.set(slot.visualX, HOLO_LIFT, slot.visualZ);
    this.label.position.set(slot.labelX, LABEL_LIFT, slot.labelZ);
    const inner = slot.width - 0.014;
    this.quantity.maxWidth = inner - (2 * BADGE_RADIUS + 0.003);
    this.name.maxWidth = inner;
    if (this.steps) this.steps.maxWidth = inner;
    this.purpose.maxWidth = inner;
    for (const text of this.stacked()) text.sync(this.stackLabel);
  }

  /**
   * Strength (overlay opacity × step-mode dimming; 0 when off the page) and
   * whether it's highlighted (selected, the current step, or used in this
   * build stage): that shows its purpose and its hologram.
   */
  setState(alpha: number, active: boolean) {
    if (alpha === this.alpha && active === this.active) return;
    const restack = active !== this.active;
    this.alpha = alpha;
    this.active = active;
    this.visual.visible = active && alpha > 0.002 && this.hologram !== null;
    if (this.hologram) this.hologram.uniforms.opacity.value = alpha;
    for (let i = 0; i < this.texts.length; i++) setTextOpacity(this.texts[i], alpha);
    if (!active) setTextOpacity(this.purpose, 0);
    if (restack) {
      this.label.scale.setScalar(active ? ACTIVE_LABEL_SCALE : 1);
      this.stackLabel();
    }
  }

  /** Per frame while shown: the hologram breathes and hovers a little. */
  animate(time: number) {
    if (!this.visual.visible || !this.hologram) return;
    this.hologram.uniforms.time.value = time;
    this.visual.position.y = HOLO_LIFT + HOLO_BOB * (0.5 + 0.5 * Math.sin(time * 2.2));
    this.visual.rotation.y = time * 0.6;
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
    this.hologram?.dispose();
  }

  private stacked(): Text[] {
    return [this.quantity, this.name, ...(this.steps ? [this.steps] : []), this.purpose];
  }

  /**
   * Stacks the flat label from the front of the cell back (its "up" runs away
   * from the user): purpose (when highlighted) nearest, then the steps, the
   * name, and the badge with the amount furthest — so from the seat it reads
   * like a recipe card: amount, name, steps, purpose.
   */
  private readonly stackLabel = () => {
    const height = (text: Text) => {
      const b = text.textRenderInfo?.blockBounds;
      return b ? b[3] - b[1] : text.fontSize * 1.2;
    };
    let y = 0;
    if (this.active) {
      this.purpose.position.set(0, y, 0);
      y += height(this.purpose) + TEXT_GAP;
    }
    if (this.steps) {
      this.steps.position.set(0, y, 0);
      y += height(this.steps) + TEXT_GAP;
    }
    this.name.position.set(0, y, 0);
    y += height(this.name) + TEXT_GAP;
    const textX = 2 * BADGE_RADIUS + 0.003;
    this.quantity.position.set(textX, y, 0);
    const lineHeight = SIZES.quantity * 1.18;
    this.badgePosition.set(BADGE_RADIUS, y + height(this.quantity) - lineHeight / 2, -0.0005);
  };
}

/** The amount as a true-scale hologram, resting on the mat. */
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
  for (const child of group.children) child.renderOrder = 25;
}
