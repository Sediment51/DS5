import * as THREE from 'three';
import { STROKE_CAPACITY, type StrokeBuffer } from '../lib/stroke';
import { COLORS } from './text';

const CORE_RADIUS = 0.0022;
const GLOW_RADIUS = 0.0065;
const FADE_RATE = 5;

const UP = new THREE.Vector3(0, 1, 0);
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const dir = new THREE.Vector3();
const q = new THREE.Quaternion();
const scale = new THREE.Vector3();
const m = new THREE.Matrix4();

/**
 * The stroke being drawn, as a glowing mint tube: one instanced cylinder per
 * segment between recorded pen points (core plus a soft additive halo).
 */
export class StrokeView {
  readonly group = new THREE.Group();
  private readonly core: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedMesh;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private segments = 0;
  private opacity = 0;
  private targetOpacity = 0;

  constructor() {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.coreMaterial = new THREE.MeshBasicMaterial({ color: '#e9fbf1', transparent: true, depthWrite: false, toneMapped: false });
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.accent,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.core = new THREE.InstancedMesh(geometry, this.coreMaterial, STROKE_CAPACITY);
    this.glow = new THREE.InstancedMesh(geometry, this.glowMaterial, STROKE_CAPACITY);
    for (const mesh of [this.core, this.glow]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.core.renderOrder = 31;
    this.glow.renderOrder = 30;
    this.group.add(this.glow, this.core);
    this.group.visible = false;
  }

  /** Clears the tube and shows it at full strength for a new stroke. */
  begin() {
    this.segments = 0;
    this.core.count = 0;
    this.glow.count = 0;
    this.opacity = this.targetOpacity = 1;
    this.applyOpacity();
    this.group.visible = true;
  }

  /** Adds tube segments for points recorded since the last call. */
  sync(stroke: StrokeBuffer) {
    const p = stroke.positions;
    let added = false;
    while (this.segments < stroke.count - 1) {
      const i = this.segments * 3;
      a.set(p[i], p[i + 1], p[i + 2]);
      b.set(p[i + 3], p[i + 4], p[i + 5]);
      dir.subVectors(b, a);
      const length = dir.length();
      q.setFromUnitVectors(UP, dir.divideScalar(length || 1));
      a.add(b).multiplyScalar(0.5);
      m.compose(a, q, scale.set(CORE_RADIUS, length + CORE_RADIUS, CORE_RADIUS));
      this.core.setMatrixAt(this.segments, m);
      m.compose(a, q, scale.set(GLOW_RADIUS, length + GLOW_RADIUS, GLOW_RADIUS));
      this.glow.setMatrixAt(this.segments, m);
      this.segments++;
      added = true;
    }
    if (added) {
      this.core.count = this.glow.count = this.segments;
      this.core.instanceMatrix.needsUpdate = true;
      this.glow.instanceMatrix.needsUpdate = true;
    }
  }

  /** Fades the tube away (after the stroke is turned into a mat, or rejected). */
  fadeOut() {
    this.targetOpacity = 0;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    if (this.opacity !== this.targetOpacity) {
      this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-FADE_RATE * dt));
      if (Math.abs(this.opacity - this.targetOpacity) < 0.01) this.opacity = this.targetOpacity;
      this.applyOpacity();
    }
    if (this.opacity === 0) this.group.visible = false;
  }

  private applyOpacity() {
    this.coreMaterial.opacity = this.opacity;
    this.glowMaterial.opacity = 0.35 * this.opacity;
  }
}
