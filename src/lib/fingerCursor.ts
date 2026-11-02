import * as THREE from 'three';

/** How far in front of a panel (m) the cursor starts to show. */
export const CURSOR_RANGE = 0.08;

const IDLE = new THREE.Color('#1f2a24');
const TOUCH = new THREE.Color('#2563eb');

/**
 * Where your fingertip is on a panel: a ring on its face under the finger,
 * shrinking and darkening as the finger comes closer and turning blue on
 * contact, so you can see what you're about to press.
 */
export class FingerCursor {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  constructor(radius = 0.006) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.55, radius, 32),
      new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 45;
    this.mesh.visible = false;
  }

  /**
   * @param x,y the fingertip's spot on the panel face (panel space), z its distance in front (m); x = null hides it.
   * @param touching it's pressing or holding something.
   */
  update(x: number | null, y: number, z: number, touching: boolean) {
    const near = x !== null && z < CURSOR_RANGE && z > -0.04;
    this.mesh.visible = near;
    if (!near) return;
    const closeness = 1 - Math.min(Math.max(z, 0) / CURSOR_RANGE, 1);
    this.mesh.position.set(x, y, 0.003);
    this.mesh.scale.setScalar(touching ? 0.8 : 1.6 - 0.8 * closeness);
    this.mesh.material.color.copy(touching ? TOUCH : IDLE);
    this.mesh.material.opacity = touching ? 0.95 : 0.25 + 0.55 * closeness;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
