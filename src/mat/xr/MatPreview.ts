import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import type { MatPlacement } from '../lib/rectFit';
import { rectPath, ribbonGeometry } from './outlines';
import { COLORS, hex, makeText, setTextContent } from './text';

const GOOD = new THREE.Color(COLORS.accent);
const SHORT = new THREE.Color(COLORS.warn);
/** Lift over the table so the ghost outline doesn't flicker against it. */
const LIFT = 0.002;

/**
 * While the user traces the mat: a ghost of the rectangle it would become,
 * with its size, amber until it's big enough and blue once letting go would
 * place it.
 */
export class MatPreview {
  readonly group = new THREE.Group();
  private readonly outline: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly label: Text;
  private width = 0;
  private depth = 0;

  constructor() {
    this.outline = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.outline.renderOrder = 29;
    this.label = makeText('', { size: 0.018, weight: 'bold', anchorX: 'center', anchorY: 'bottom' });
    this.group.add(this.outline, this.label);
    this.group.visible = false;
  }

  /** Shows the rectangle at height y; `bigEnough` picks the colour and the wording. */
  show(placement: MatPlacement, y: number, bigEnough: boolean, head: THREE.Vector3) {
    if (Math.abs(placement.width - this.width) > 0.002 || Math.abs(placement.depth - this.depth) > 0.002) {
      this.width = placement.width;
      this.depth = placement.depth;
      this.outline.geometry.dispose();
      this.outline.geometry = ribbonGeometry([{ points: rectPath(placement.width, placement.depth), closed: true }], 0.004);
    }
    this.outline.position.set(placement.cx, y + LIFT, placement.cz);
    this.outline.rotation.set(0, placement.yaw, 0);
    this.outline.material.color.copy(bigEnough ? GOOD : SHORT);
    const size = `${Math.round(placement.width * 100)} × ${Math.round(placement.depth * 100)} cm`;
    setTextContent(this.label, bigEnough ? `Let go to place · ${size}` : `Keep going · ${size}`);
    this.label.color = hex(bigEnough ? COLORS.accent : COLORS.warn);
    this.label.position.set(placement.cx, y + 0.03, placement.cz);
    this.label.lookAt(head);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
    this.width = this.depth = 0;
  }
}
