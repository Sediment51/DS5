import * as THREE from 'three';
import { MAX_ITEMS } from '../lib/kit';
import { dashPath, fillGeometry, footprintPath, ribbonGeometry, type FootprintShape } from './outlines';
import { COLORS } from './text';

/**
 * Batched drawing for the mat's slots, so the whole kit costs a handful of
 * draw calls instead of several per item: every outline and fill in one
 * mesh, every step badge in one instanced mesh. Per-slot strength (overlay
 * opacity × step-mode dimming) comes from a uniform array / attribute, so
 * fades and step changes never rebuild geometry.
 */

/** Most items a kit may have (size of the per-slot uniform array). */
export const MAX_SLOTS = MAX_ITEMS;

const LINE_LIFT = 0.0015;
const FILL_LIFT = 0.0006;
const KIND = { dashed: 0, solid: 1, fill: 2, cell: 3, compare: 4 };
/** Corner radius of a cell's outline (m). */
const CELL_RADIUS = 0.008;

/** A cell's rounded outline, centred on the origin (built once per size). */
const cellCache = new Map<string, THREE.BufferGeometry>();
function cellGeometry(width: number, depth: number) {
  const key = `${width.toFixed(4)}:${depth.toFixed(4)}`;
  let geometry = cellCache.get(key);
  if (!geometry) {
    const path = roundedRectPath(width, depth, CELL_RADIUS);
    geometry = ribbonGeometry([{ points: path, closed: true }], 0.0012);
    cellCache.set(key, geometry);
  }
  return geometry;
}

/** A compare spot: a dashed ring (built once per size). */
const compareCache = new Map<string, THREE.BufferGeometry>();
function compareGeometry(diameter: number) {
  const key = diameter.toFixed(4);
  let geometry = compareCache.get(key);
  if (!geometry) {
    const path = footprintPath({ shape: 'circle', width: diameter, depth: diameter });
    geometry = ribbonGeometry(dashPath(path, 0.004, 0.003), 0.0016);
    compareCache.set(key, geometry);
  }
  return geometry;
}

function roundedRectPath(width: number, depth: number, radius: number): number[] {
  const w = width / 2;
  const d = depth / 2;
  const r = Math.min(radius, w, d);
  const out: number[] = [];
  const corner = (cx: number, cz: number, from: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = from + (i / 4) * (Math.PI / 2);
      out.push(cx + r * Math.cos(a), cz + r * Math.sin(a));
    }
  };
  corner(w - r, -d + r, -Math.PI / 2);
  corner(w - r, d - r, 0);
  corner(-w + r, d - r, Math.PI / 2);
  corner(-w + r, -d + r, Math.PI);
  return out;
}

/** Per footprint shape: dashed and solid outlines and the fill, built once and reused. */
const shapeCache = new Map<string, { dashed: THREE.BufferGeometry; solid: THREE.BufferGeometry; fill: THREE.BufferGeometry }>();
function shapeGeometry(shape: FootprintShape) {
  const key = `${shape.shape}:${shape.width.toFixed(4)}:${shape.depth.toFixed(4)}`;
  let entry = shapeCache.get(key);
  if (!entry) {
    const path = footprintPath(shape);
    entry = {
      dashed: ribbonGeometry(dashPath(path, 0.01, 0.006), 0.0025),
      solid: ribbonGeometry([{ points: path, closed: true }], 0.004),
      fill: fillGeometry(path),
    };
    shapeCache.set(key, entry);
  }
  return entry;
}

const footprintVertex = /* glsl */ `
  attribute float aSlot;
  attribute float aKind;
  uniform float uAlpha[${MAX_SLOTS}];
  uniform float uLit[${MAX_SLOTS}];
  uniform float uTime;
  varying float vAlpha;
  void main() {
    int slot = int(aSlot + 0.5);
    float alpha = uAlpha[slot];
    bool current = uLit[slot] > 0.5; // selected, the current step, or used in this build stage
    float kind;
    if (aKind < 0.5) kind = current ? 0.0 : 0.9;          // dashed: the normal outline
    else if (aKind < 1.5) kind = current ? 1.0 : 0.0;     // solid: a highlighted item's outline
    else if (aKind < 2.5) kind = current ? 0.14 + 0.04 * sin(uTime * 3.0) : 0.05; // fill: still, gently pulsing only when highlighted
    else if (aKind < 3.5) kind = current ? 0.6 : 0.2;     // the cell's own space
    else kind = current ? 0.95 : 0.3;                     // the compare spot for the amount
    vAlpha = alpha * kind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const flatFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.002) discard;
    gl_FragColor = vec4(uColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

/** Every slot's footprint outline and fill, in one draw. */
export class FootprintBatch {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly alphas = new Float32Array(MAX_SLOTS);
  private readonly lit = new Float32Array(MAX_SLOTS);

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(COLORS.accent) },
        uAlpha: { value: this.alphas },
        uLit: { value: this.lit },
        uTime: { value: 0 },
      },
      vertexShader: footprintVertex,
      fragmentShader: flatFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * Rebuilds the batch: one entry per slot, its footprint centred at (x, z) in
   * mat space, its cell's outline, and its compare spot if it has one.
   */
  build(
    entries: readonly {
      shape: FootprintShape;
      x: number;
      z: number;
      cell: { x: number; z: number; width: number; depth: number };
      compare: { x: number; z: number; diameter: number } | null;
    }[],
  ) {
    const positions: number[] = [];
    const slots: number[] = [];
    const kinds: number[] = [];
    const indices: number[] = [];
    entries.forEach((entry, slot) => {
      const shape = shapeGeometry(entry.shape);
      const parts: [THREE.BufferGeometry, number, number, number, number][] = [
        [shape.fill, KIND.fill, FILL_LIFT, entry.x, entry.z],
        [shape.dashed, KIND.dashed, LINE_LIFT, entry.x, entry.z],
        [shape.solid, KIND.solid, LINE_LIFT, entry.x, entry.z],
        [cellGeometry(entry.cell.width - 0.002, entry.cell.depth - 0.002), KIND.cell, LINE_LIFT, entry.cell.x, entry.cell.z],
      ];
      if (entry.compare) parts.push([compareGeometry(entry.compare.diameter), KIND.compare, LINE_LIFT, entry.compare.x, entry.compare.z]);
      for (const [geometry, kind, lift, ox, oz] of parts) {
        const base = positions.length / 3;
        const p = geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          positions.push(p.getX(i) + ox, p.getY(i) + lift, p.getZ(i) + oz);
          slots.push(slot);
          kinds.push(kind);
        }
        const index = geometry.getIndex();
        if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
        else for (let i = 0; i < p.count; i++) indices.push(base + i);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSlot', new THREE.Float32BufferAttribute(slots, 1));
    geometry.setAttribute('aKind', new THREE.Float32BufferAttribute(kinds, 1));
    geometry.setIndex(indices);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  setAlpha(slot: number, alpha: number) {
    this.alphas[slot] = alpha;
  }

  /** Highlights a slot (solid outline, a soft fill) or not. */
  setLit(slot: number, lit: boolean) {
    this.lit[slot] = lit ? 1 : 0;
  }

  setColor(color: string) {
    (this.material.uniforms.uColor.value as THREE.Color).set(color);
  }

  setTime(seconds: number) {
    this.material.uniforms.uTime.value = seconds;
  }
}

const badgeVertex = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

/** Every slot's round step badge, in one instanced draw. */
export class BadgeBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius: number, count: number) {
    const geometry = new THREE.CircleGeometry(radius, 28);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAlpha', this.alpha);
    const material = (this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(COLORS.accent) } },
      vertexShader: badgeVertex,
      fragmentShader: flatFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
  }

  setMatrix(slot: number, matrix: THREE.Matrix4) {
    this.mesh.setMatrixAt(slot, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setAlpha(slot: number, alpha: number) {
    if (this.alpha.getX(slot) === alpha) return;
    this.alpha.setX(slot, alpha);
    this.alpha.needsUpdate = true;
  }

  setColor(color: string) {
    (this.material.uniforms.uColor.value as THREE.Color).set(color);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
