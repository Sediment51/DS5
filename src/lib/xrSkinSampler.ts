import * as THREE from 'three';

/**
 * Reads the real palm's colour from the headset's camera, when the session
 * grants WebXR raw camera access ('camera-access'): the camera image for the
 * first view is read back at a few points on the palm (projected with that
 * view), and their colour is averaged over time.
 *
 * Without camera access (the usual case for passthrough, which pages can't
 * see) `sample` returns false and the panel's skin presets are used.
 */
type CameraView = XRView & { camera?: { width: number; height: number } };
type CameraBinding = XRWebGLBinding & { getCameraImage?: (camera: unknown) => WebGLTexture | null };

/** Pixels averaged around each point (an n×n block). */
const BLOCK = 3;
/** How quickly the colour follows a new reading (0..1 per reading). */
const EASE = 0.35;

export class XRSkinSampler {
  /** Whether a camera image has been seen this session. */
  available = false;
  private fbo: WebGLFramebuffer | null = null;
  private readonly pixels = new Uint8Array(BLOCK * BLOCK * 4);
  private readonly viewInverse = new THREE.Matrix4();
  private readonly projection = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  /** Per orientation (as is / flipped vertically): summed colour and squared colour. */
  private readonly sum = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly sq = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly mean = new THREE.Vector3();
  private has = false;
  /** The palm colour (sRGB, 0..1). */
  readonly srgb = new THREE.Vector3();

  /**
   * Samples the camera image at the given world points (on the palm's skin).
   * @returns whether a reading was taken.
   */
  sample(renderer: THREE.WebGLRenderer, points: readonly THREE.Vector3[]): boolean {
    const frame = renderer.xr.getFrame();
    const space = renderer.xr.getReferenceSpace();
    if (!frame || !space) return false;
    const view = frame.getViewerPose(space)?.views[0] as CameraView | undefined;
    const camera = view?.camera;
    if (!view || !camera) return false;
    const binding = renderer.xr.getBinding() as CameraBinding | null;
    const texture = binding?.getCameraImage?.(camera);
    if (!texture) return false;
    this.available = true;

    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.fbo ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      this.viewInverse.fromArray(view.transform.inverse.matrix);
      this.projection.fromArray(view.projectionMatrix);
      for (let o = 0; o < 2; o++) {
        this.sum[o].set(0, 0, 0);
        this.sq[o].set(0, 0, 0);
      }
      const { width, height } = camera;
      for (const point of points) {
        this.p.copy(point).applyMatrix4(this.viewInverse).applyMatrix4(this.projection);
        const x = Math.round((this.p.x * 0.5 + 0.5) * width) - 1;
        const y = Math.round((this.p.y * 0.5 + 0.5) * height) - 1;
        // The image's row order isn't specified: read both and keep the more skin-like.
        this.read(gl, x, y, width, height, 0);
        this.read(gl, x, height - 1 - y - BLOCK + 1, width, height, 1);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderer.resetState();
    if (!ok) return false;

    // The orientation whose samples agree best and look like skin (red ≥ green ≥ blue).
    let best = -1;
    let bestSpread = Infinity;
    for (let o = 0; o < 2; o++) {
      const m = this.mean.copy(this.sum[o]).divideScalar(points.length);
      const spread = this.sq[o].x / points.length - m.x * m.x + (this.sq[o].y / points.length - m.y * m.y) + (this.sq[o].z / points.length - m.z * m.z);
      const skinLike = m.x > 0.12 && m.x >= m.y && m.y >= m.z * 0.8;
      if (skinLike && spread < bestSpread) {
        best = o;
        bestSpread = spread;
      }
    }
    if (best < 0) return false;
    this.mean.copy(this.sum[best]).divideScalar(points.length);
    if (!this.has) this.srgb.copy(this.mean);
    else this.srgb.lerp(this.mean, EASE);
    this.has = true;
    return true;
  }

  /**
   * A photo from the headset camera (the first view's image), scaled to at
   * most `maxSize` pixels on its long side, as a JPEG data URL; null without
   * camera access. Call inside an XR frame.
   */
  captureImage(renderer: THREE.WebGLRenderer, maxSize: number): string | null {
    const frame = renderer.xr.getFrame();
    const space = renderer.xr.getReferenceSpace();
    if (!frame || !space) return null;
    const view = frame.getViewerPose(space)?.views[0] as CameraView | undefined;
    const camera = view?.camera;
    if (!view || !camera) return null;
    const binding = renderer.xr.getBinding() as CameraBinding | null;
    const texture = binding?.getCameraImage?.(camera);
    if (!texture) return null;
    this.available = true;

    const { width, height } = camera;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.fbo ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    let pixels: Uint8ClampedArray | null = null;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      pixels = new Uint8ClampedArray(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderer.resetState();
    if (!pixels) return null;

    // GL rows run bottom to top: flip them so the photo is upright.
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    const image = new ImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    full.getContext('2d')!.putImageData(image, 0, 0);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    out.getContext('2d')!.drawImage(full, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.85);
  }

  /** Adds the mean colour of a block at (x, y) to orientation o's sums. */
  private read(gl: WebGL2RenderingContext, x: number, y: number, width: number, height: number, o: number) {
    x = THREE.MathUtils.clamp(x, 0, width - BLOCK);
    y = THREE.MathUtils.clamp(y, 0, height - BLOCK);
    gl.readPixels(x, y, BLOCK, BLOCK, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < BLOCK * BLOCK; i++) {
      r += this.pixels[i * 4];
      g += this.pixels[i * 4 + 1];
      b += this.pixels[i * 4 + 2];
    }
    const n = BLOCK * BLOCK * 255;
    r /= n;
    g /= n;
    b /= n;
    this.sum[o].x += r;
    this.sum[o].y += g;
    this.sum[o].z += b;
    this.sq[o].x += r * r;
    this.sq[o].y += g * g;
    this.sq[o].z += b * b;
  }

  reset() {
    this.has = false;
  }
}
