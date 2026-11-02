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
const KIND = { dashed: 0, solid: 1, fill: 2 };

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
    else kind = current ? 0.14 + 0.04 * sin(uTime * 3.0) : 0.05; // fill: still, gently pulsing only when highlighted
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
        uColor: { value: new THREE.Color(COLORS.mint) },
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

  /** Rebuilds the batch: one entry per slot, its footprint centred at (x, z) in mat space. */
  build(entries: readonly { shape: FootprintShape; x: number; z: number }[]) {
    const positions: number[] = [];
    const slots: number[] = [];
    const kinds: number[] = [];
    const indices: number[] = [];
    entries.forEach((entry, slot) => {
      const shape = shapeGeometry(entry.shape);
      const parts: [THREE.BufferGeometry, number, number][] = [
        [shape.fill, KIND.fill, FILL_LIFT],
        [shape.dashed, KIND.dashed, LINE_LIFT],
        [shape.solid, KIND.solid, LINE_LIFT],
      ];
      for (const [geometry, kind, lift] of parts) {
        const base = positions.length / 3;
        const p = geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          positions.push(p.getX(i) + entry.x, p.getY(i) + lift, p.getZ(i) + entry.z);
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
      uniforms: { uColor: { value: new THREE.Color(COLORS.mint) } },
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
