import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import { COLORS, hex, makeText, setTextOpacity } from '../mat/xr/text';

/** Text size (m, em; capitals ≈ 1 cm), bubble's maximum width and lines. */
export const BUBBLE_TEXT_SIZE = 0.0135;
const MIN_TEXT_SIZE = 0.0105;
export const BUBBLE_MAX_WIDTH = 0.14;
const MAX_LINES = 4;
const PAD = 0.009;
const RADIUS = 0.012;
/** Backing: the panels' ink, a little denser so text reads over any room. */
const BACKING_OPACITY = 0.72;
const TAIL = 0.009;
/** Typewriter speed (characters per second). */
export const TEXT_SPEED = 35;
const DOT_RADIUS = 0.0026;
const DOT_SPACING = 0.0105;
const DOTS_ROW = 0.012;

/** A rounded rectangle drawn by its distance field: crisp at any size, no new geometry per message. */
function roundedMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      size: { value: new THREE.Vector2(0.1, 0.05) },
      radius: { value: RADIUS },
      color: { value: new THREE.Color(COLORS.ink) },
      opacity: { value: BACKING_OPACITY },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec2 size;
      uniform float radius;
      uniform vec3 color;
      uniform float opacity;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * size;
        vec2 q = abs(p) - size * 0.5 + radius;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
        float aa = fwidth(d);
        gl_FragColor = vec4(color, opacity * (1.0 - smoothstep(-aa, aa, d)));
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Buddy's speech bubble: text typed out at TEXT_SPEED on the app's ink
 * panel, an optional row of progress dots, and a tail pointing at Buddy.
 * Drawn over everything; the caller places it and turns it to the viewer.
 */
export class SpeechBubble {
  readonly group = new THREE.Group();
  /** Size of the bubble body (m). */
  width = 0.1;
  height = 0.04;
  private readonly backing: THREE.Mesh;
  private readonly backingMaterial: THREE.ShaderMaterial;
  private readonly tail: THREE.Mesh;
  private readonly tailMaterial: THREE.MeshBasicMaterial;
  private readonly text: Text;
  private readonly dots: THREE.Mesh[] = [];
  private readonly dotMaterials: THREE.MeshBasicMaterial[] = [];
  private message = '';
  private wrapped = '';
  private shown = 0;
  private typed = 0;
  private laidOut = false;
  private layoutId = 0;
  private stageDots: number | null = null;
  private opacity = 1;

  constructor(dotCount: number) {
    this.backingMaterial = roundedMaterial();
    this.backing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backingMaterial);
    this.backing.renderOrder = 20;
    this.tailMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.ink,
      transparent: true,
      opacity: BACKING_OPACITY,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide, // mirrored for the left edge
    });
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, -TAIL * 0.7);
    tailShape.lineTo(0, TAIL * 0.7);
    tailShape.lineTo(-TAIL, -TAIL * 0.2);
    tailShape.closePath();
    this.tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), this.tailMaterial);
    this.tail.renderOrder = 20;
    this.text = makeText('', {
      size: BUBBLE_TEXT_SIZE,
      weight: 'medium',
      anchorX: 'left',
      anchorY: 'top',
      maxWidth: BUBBLE_MAX_WIDTH - 2 * PAD,
      halo: false,
    });
    (this.text.material as THREE.Material).depthTest = false;
    this.text.renderOrder = 21;
    this.group.add(this.backing, this.tail, this.text);
    const dot = new THREE.CircleGeometry(DOT_RADIUS, 16);
    for (let i = 0; i < dotCount; i++) {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, toneMapped: false });
      const mesh = new THREE.Mesh(dot, material);
      mesh.renderOrder = 21;
      this.dots.push(mesh);
      this.dotMaterials.push(material);
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  /** Whether the text is still typing out. */
  get typing() {
    return !this.laidOut || this.typed < this.wrapped.length;
  }

  get hasMessage() {
    return this.message !== '';
  }

  /**
   * Says `message`, typed out unless `instant`; `stage` shows that many of
   * the progress dots filled (null: no dots).
   */
  say(message: string, stage: number | null, instant = false) {
    this.message = message;
    this.stageDots = stage;
    this.laidOut = false;
    this.typed = this.shown = 0;
    this.text.fontSize = BUBBLE_TEXT_SIZE;
    this.layout(instant);
  }

  /** Lays the whole message out once (shrinking it to fit MAX_LINES), then fixes its line breaks so typing never re-wraps. */
  private layout(instant: boolean) {
    const id = ++this.layoutId;
    this.text.text = this.message;
    this.text.visible = false;
    this.text.sync(() => {
      if (id !== this.layoutId) return;
      const info = this.text.textRenderInfo;
      if (!info) return;
      const carets = info.caretPositions;
      const msg = this.message;
      let lines = 1;
      let lastY = NaN;
      let wrapped = '';
      let pendingSpace = '';
      for (let i = 0; i < msg.length; i++) {
        const ch = msg[i];
        if (ch === ' ') {
          pendingSpace += ch;
          continue;
        }
        const y = carets ? carets[i * 4 + 2] : 0;
        if (!Number.isNaN(lastY) && Math.abs(y - lastY) > 1e-5) {
          lines++;
          wrapped += '\n';
        } else {
          wrapped += pendingSpace;
        }
        pendingSpace = '';
        wrapped += ch;
        lastY = y;
      }
      if (lines > MAX_LINES && this.text.fontSize > MIN_TEXT_SIZE) {
        this.text.fontSize = Math.max(this.text.fontSize * 0.9, MIN_TEXT_SIZE);
        this.layout(instant);
        return;
      }
      const [minX, minY, maxX, maxY] = info.blockBounds;
      this.wrapped = wrapped;
      this.width = Math.min(maxX - minX + 2 * PAD, BUBBLE_MAX_WIDTH);
      const dotsHeight = this.stageDots === null ? 0 : DOTS_ROW;
      this.height = maxY - minY + dotsHeight + 2 * PAD;
      this.backing.scale.set(this.width, this.height, 1);
      this.backingMaterial.uniforms.size.value.set(this.width, this.height);
      this.text.position.set(-this.width / 2 + PAD, this.height / 2 - PAD, 0);
      this.dots.forEach((dot, i) => {
        dot.visible = this.stageDots !== null;
        dot.position.set((i - (this.dots.length - 1) / 2) * DOT_SPACING, -this.height / 2 + PAD + DOT_RADIUS, 0);
        this.dotMaterials[i].color.setHex(hex(this.stageDots !== null && i < this.stageDots ? COLORS.accent : COLORS.muted));
      });
      this.typed = instant ? wrapped.length : 0;
      this.shown = -1;
      this.laidOut = true;
      this.text.visible = true;
      this.applyOpacity();
    });
  }

  /** Puts the tail on the bubble's left (−1) or right (+1) edge, pointing out at Buddy. */
  setTailSide(side: 1 | -1) {
    this.tail.scale.x = -side;
    this.tail.position.set(side * this.width / 2, -this.height * 0.15, 0);
  }

  setOpacity(opacity: number) {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    this.applyOpacity();
  }

  private applyOpacity() {
    const o = this.opacity;
    this.group.visible = o > 0.002 && this.laidOut && this.message !== '';
    this.backingMaterial.uniforms.opacity.value = BACKING_OPACITY * o;
    this.tailMaterial.opacity = BACKING_OPACITY * o;
    setTextOpacity(this.text, o);
    this.text.visible = this.laidOut;
    this.dotMaterials.forEach((material, i) => (material.opacity = o * (this.stageDots !== null && i < this.stageDots ? 1 : 0.45)));
  }

  /** Advances the typing; call every frame. */
  update(dt: number) {
    if (!this.laidOut) return;
    if (this.typed < this.wrapped.length) this.typed = Math.min(this.typed + dt * TEXT_SPEED, this.wrapped.length);
    const n = Math.floor(this.typed);
    if (n !== this.shown) {
      this.shown = n;
      this.text.text = this.wrapped.slice(0, n);
      this.text.sync();
    }
  }

  clear() {
    this.message = '';
    this.layoutId++;
    this.group.visible = false;
  }

  dispose() {
    this.text.dispose();
    this.backing.geometry.dispose();
    this.backingMaterial.dispose();
    this.tail.geometry.dispose();
    this.tailMaterial.dispose();
    this.dots[0]?.geometry.dispose();
    this.dotMaterials.forEach((material) => material.dispose());
  }
}
