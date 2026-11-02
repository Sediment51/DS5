import * as THREE from 'three';
import { BatchedText, type Text } from 'troika-three-text';
import type { GrabState } from '../../lib/grab';
import type { Kit } from '../lib/kit';
import { LAYOUT, layoutKit, type SectionLayout } from '../lib/layout';
import { cornerTicks, rectPath, ribbonGeometry } from './outlines';
import { BadgeBatch, FootprintBatch } from './slotBatches';
import { BADGE_RADIUS, SlotView } from './SlotView';
import { COLORS, makeText, setTextOpacity, textMaterial } from './text';

/** A section's header (number in a circle, group name) and the line under it, lying flat on the mat. */
interface SectionView {
  page: number;
  group: THREE.Group;
  texts: Text[];
  circle: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  divider: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
}
const SECTION_CIRCLE = 0.011;
const FLAT = -Math.PI / 2;

/** Lift above the table so lines don't flicker against virtual fills. */
const LINE_LIFT = 0.0015;
/** Strength of the other slots in step mode. */
const STEP_DIM = 0.2;

/** How long the edge pulses when the mat is placed (s). */
const PULSE_SECONDS = 1.2;

const matInverse = new THREE.Matrix4();
const WHITE = new THREE.Color('#ffffff');
const badgeMatrix = new THREE.Matrix4();

/**
 * The mat: a frame on the table (origin at the rectangle's centre, +Y up,
 * +Z towards the user, +X to their right), positioned from its anchor, with
 * the kit laid out on it. All slots draw through shared batches (outlines,
 * badges, text), so the whole mat is about a dozen draw calls.
 */
export class MatView {
  /** Placed in world space from the anchor every frame. */
  readonly root = new THREE.Group();
  /** Everything that fades with the overlay opacity. */
  readonly overlay = new THREE.Group();
  width = 0;
  depth = 0;
  pages = 1;
  page = 0;
  private slots: SlotView[] = [];
  private sections: SectionView[] = [];
  private readonly footprints = new FootprintBatch();
  private badges: BadgeBatch | null = null;
  private labels: BatchedText | null = null;
  private outline: THREE.Mesh | null = null;
  private ticks: THREE.Mesh | null = null;
  private readonly outlineMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.accent,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  private readonly tickMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.accent,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  private opacity = 1;
  /** Highlighted items (selected, the current step, or used in this build stage). */
  private readonly lit = new Set<number>();
  /** Step mode: everything but the highlighted items is dimmed. */
  private dimOthers = false;
  private grabState: GrabState = 'none';
  private accent = new THREE.Color(COLORS.accent);
  private labelsShown = true;
  /** Seconds left of the "placed" pulse of the edge. */
  private pulseFor = 0;

  constructor() {
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.root.add(this.overlay);
    this.overlay.add(this.footprints.mesh);
  }

  get itemCount() {
    return this.slots.length;
  }

  /** The page an item is on. */
  pageOf(item: number) {
    return this.slots[item]?.page ?? 0;
  }

  /** Creates the slots for a kit (once per session). */
  setKit(kit: Kit) {
    for (const slot of this.slots) {
      this.overlay.remove(slot.visual, slot.label);
      slot.dispose();
    }
    if (this.badges) {
      this.overlay.remove(this.badges.mesh);
      this.badges.dispose();
    }
    if (this.labels) {
      this.overlay.remove(this.labels);
      this.labels.dispose();
    }
    this.slots = kit.items.map((item) => new SlotView(item));
    this.badges = new BadgeBatch(BADGE_RADIUS, this.slots.length);
    this.badges.setColor(`#${this.accent.getHexString()}`);
    this.labels = new BatchedText();
    this.labels.material = textMaterial();
    this.labels.renderOrder = 20;
    for (const slot of this.slots) {
      this.overlay.add(slot.visual, slot.label);
      for (const text of slot.texts) this.labels.addText(text);
    }
    this.overlay.add(this.badges.mesh, this.labels);
    this.setLabelsVisible(this.labelsShown);
    this.lit.clear();
  }

  /** Sizes the mat to width × depth (m) and lays the kit out on it. */
  build(width: number, depth: number) {
    this.width = width;
    this.depth = depth;
    this.outline?.geometry.dispose();
    this.ticks?.geometry.dispose();
    if (this.outline) this.overlay.remove(this.outline);
    if (this.ticks) this.overlay.remove(this.ticks);
    this.outline = new THREE.Mesh(ribbonGeometry([{ points: rectPath(width, depth), closed: true }], 0.0025), this.outlineMaterial);
    this.ticks = new THREE.Mesh(ribbonGeometry(cornerTicks(width, depth, 0.035), 0.006), this.tickMaterial);
    this.outline.position.y = this.ticks.position.y = LINE_LIFT;
    this.outline.renderOrder = this.ticks.renderOrder = 2;
    this.overlay.add(this.outline, this.ticks);

    const layout = layoutKit(
      this.slots.map((s) => s.item),
      width,
      depth,
    );
    layout.slots.forEach((slot, i) => this.slots[i].place(slot));
    this.footprints.build(
      this.slots.map((s) => ({
        shape: s.item.footprint,
        x: s.footprintX,
        z: s.footprintZ,
        cell: { x: s.cellX, z: s.cellZ, width: s.cellWidth, depth: s.cellDepth },
        compare: s.compare ? { x: s.compareX, z: s.compareZ, diameter: s.compare } : null,
      })),
    );
    this.buildSections(layout.sections);
    this.pages = layout.pages;
    this.lit.clear();
    this.dimOthers = false;
    this.setPage(0);
  }

  setPage(page: number) {
    this.page = Math.min(Math.max(page, 0), this.pages - 1);
    this.applySlots();
  }

  /** The recipe card's sections: a numbered header in the left column and a line under each. */
  private buildSections(layouts: readonly SectionLayout[]) {
    for (const s of this.sections) {
      this.overlay.remove(s.group);
      for (const t of s.texts) t.dispose();
      s.circle.geometry.dispose();
      s.circle.material.dispose();
      s.divider?.geometry.dispose();
      s.divider?.material.dispose();
    }
    this.sections = layouts.map((layout) => {
      const group = new THREE.Group();
      const cx = layout.left + LAYOUT.header / 2;
      const circle = new THREE.Mesh(
        new THREE.CircleGeometry(SECTION_CIRCLE, 32),
        new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, depthWrite: false, toneMapped: false }),
      );
      circle.rotation.x = FLAT;
      circle.position.set(cx, LINE_LIFT, layout.back + SECTION_CIRCLE + 0.004);
      circle.renderOrder = 19;
      const number = makeText(String(layout.number), { size: 0.013, weight: 'bold', color: COLORS.ink, anchorX: 'center', anchorY: 'middle', halo: false });
      number.rotation.x = FLAT;
      number.position.set(cx, LINE_LIFT + 0.0005, circle.position.z);
      number.renderOrder = 21;
      const name = makeText(layout.label.toUpperCase(), {
        size: 0.0078,
        weight: 'bold',
        color: COLORS.accent,
        anchorX: 'center',
        anchorY: 'top',
        maxWidth: LAYOUT.header - 0.006,
      });
      name.rotation.x = FLAT;
      name.position.set(cx, LINE_LIFT, circle.position.z + SECTION_CIRCLE + 0.004);
      name.renderOrder = 21;
      group.add(circle, number, name);
      let divider: SectionView['divider'] = null;
      if (!layout.last) {
        const z = layout.back + layout.depth + (LAYOUT.rowGap + LAYOUT.sectionGap) / 2;
        divider = new THREE.Mesh(
          ribbonGeometry([{ points: [layout.left, z, layout.left + layout.width, z], closed: false }], 0.0014),
          new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
        );
        divider.position.y = LINE_LIFT;
        divider.renderOrder = 2;
        group.add(divider);
      }
      this.overlay.add(group);
      return { page: layout.page, group, texts: [number, name], circle, divider };
    });
  }

  private applySections() {
    for (const s of this.sections) {
      const shown = s.page === this.page && this.opacity > 0.002;
      s.group.visible = shown;
      if (!shown) continue;
      s.circle.material.color.copy(this.accent);
      s.circle.material.opacity = this.opacity;
      if (s.divider) {
        s.divider.material.color.copy(this.accent);
        s.divider.material.opacity = 0.35 * this.opacity;
      }
      for (const t of s.texts) setTextOpacity(t, this.opacity);
      (s.texts[1] as Text).color = this.accent.getHex();
    }
  }

  /**
   * Highlights these items (none: an empty list) and, in step mode, dims the
   * rest. The page turns to the first highlighted item if it's elsewhere.
   */
  setHighlight(items: readonly number[], dimOthers: boolean) {
    this.lit.clear();
    for (const i of items) if (i >= 0 && i < this.slots.length) this.lit.add(i);
    this.dimOthers = dimOthers && this.lit.size > 0;
    const first = items.find((i) => this.lit.has(i));
    if (first !== undefined && ![...this.lit].some((i) => this.pageOf(i) === this.page)) this.page = this.pageOf(first);
    this.applySlots();
  }

  /** The item whose cell (outline and label) contains this mat-space point, on the page in view; -1 if none. */
  hitSlot(x: number, z: number): number {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.page !== this.page) continue;
      if (Math.abs(x - s.cellX) <= s.cellWidth / 2 && Math.abs(z - s.cellZ) <= s.cellDepth / 2) return i;
    }
    return -1;
  }

  /** The mat's accent colour: edge, corner ticks, outlines and badges. */
  setAccent(color: string) {
    this.accent.set(color);
    this.footprints.setColor(color);
    this.badges?.setColor(color);
    this.applyEdge();
    this.applySections();
  }

  /** Shows or hides the material names and step badges (the outlines stay). */
  setLabelsVisible(visible: boolean) {
    this.labelsShown = visible;
    if (this.labels) this.labels.visible = visible;
    if (this.badges) this.badges.mesh.visible = visible;
  }

  /** One soft pulse of the edge: "placed". */
  pulse() {
    this.pulseFor = PULSE_SECONDS;
  }

  /** Places the mat at a centre on the table, turned by yaw about +Y. */
  setPose(x: number, y: number, z: number, yaw: number) {
    this.root.matrix.makeRotationY(yaw).setPosition(x, y, z);
    this.root.matrixWorldNeedsUpdate = true;
  }

  /** Places the mat from a column-major 4×4 pose (an anchor's). */
  setMatrix(elements: ArrayLike<number>, offset = 0) {
    this.root.matrix.fromArray(elements as number[], offset);
    this.root.matrixWorldNeedsUpdate = true;
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** Overlay opacity, 0..1. */
  setOpacity(opacity: number) {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    this.applyEdge();
    this.overlay.visible = opacity > 0.002;
    this.applySlots();
  }

  /** Brightens the mat's edge while a hand is on it, white while it's carried. */
  setGrabState(state: GrabState) {
    this.grabState = state;
    this.applyEdge();
  }

  private applyEdge() {
    const handled = this.grabState !== 'none';
    const color = this.grabState === 'held' ? WHITE : this.accent;
    this.outlineMaterial.color.copy(color);
    this.tickMaterial.color.copy(color);
    const pulse = this.pulseFor > 0 ? Math.sin((this.pulseFor / PULSE_SECONDS) * Math.PI) : 0;
    this.outlineMaterial.opacity = Math.min((handled ? 1 : 0.55) + 0.45 * pulse, 1) * this.opacity;
    this.tickMaterial.opacity = this.opacity;
  }

  /** Per frame: label and badge poses; the highlighted items' fill and the placed pulse. */
  update(dt: number, time: number) {
    if (this.pulseFor > 0) {
      this.pulseFor = Math.max(this.pulseFor - dt, 0);
      this.applyEdge();
    }
    if (!this.root.visible || !this.overlay.visible || !this.badges) return;
    this.root.updateMatrixWorld(true);
    matInverse.copy(this.overlay.matrixWorld).invert();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.alpha <= 0.002) continue;
      slot.pose(matInverse, badgeMatrix);
      slot.animate(time);
      this.badges.setMatrix(i, badgeMatrix);
    }
    this.footprints.setTime(time);
  }

  private applySlots() {
    // Runs every frame while the opacity eases: a plain loop, no closures.
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const onPage = slot.page === this.page;
      const lit = this.lit.has(i);
      const alpha = onPage ? this.opacity * (this.dimOthers && !lit ? STEP_DIM : 1) : 0;
      slot.setState(alpha, lit);
      this.footprints.setAlpha(i, alpha);
      this.footprints.setLit(i, lit);
      this.badges?.setAlpha(i, alpha);
    }
    this.applySections();
  }
}
