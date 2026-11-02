import * as THREE from 'three';
import { FistDetector, fistRatio } from './fist';

/**
 * Moving things in the headset with a fist: put your hand on something (or
 * point your hand at it), close your fist, and it follows your fist until
 * you open your hand, where it stays.
 */

/**
 * 'table': follows the fist in 3D and turns with it about the vertical,
 * staying level (a mat). 'panel': follows the fist in 3D and turns to face you.
 */
export type GrabStyle = 'table' | 'panel';
export type GrabState = 'none' | 'hover' | 'held';

/** A carried panel's tint: normal, with a hand on it, and while it's carried. */
export const PANEL_GRAB_TINT: Record<GrabState, THREE.Color> = {
  none: new THREE.Color('#ffffff'),
  hover: new THREE.Color('#dbe8ff'),
  held: new THREE.Color('#bcd4ff'),
};

export interface Grabbable {
  /** The part you can touch or point at, in the target's own frame (metres). */
  readonly bounds: THREE.Box3;
  readonly style: GrabStyle;
  /** Whether it can be grabbed now (shown, placed). */
  canGrab(): boolean;
  /** Writes the target's current world pose into `out`. */
  worldMatrix(out: THREE.Matrix4): void;
  begin?(): void;
  /** Moves the target to a world pose. */
  move(world: THREE.Matrix4): void;
  /** Let go: the target is where it should stay. */
  end?(): void;
  /** Feedback: highlight when a hand is on/pointing at it, stronger while held. */
  setGrabState?(state: GrabState): void;
}

/** One hand's joints, in world space. */
export interface GrabHand {
  tracked: boolean;
  wrist: THREE.Vector3;
  /** Middle finger's knuckle (phalanx-proximal joint). */
  knuckle: THREE.Vector3;
  /** Index, middle, ring and pinky tips. */
  tips: THREE.Vector3[];
}

export function createGrabHand(): GrabHand {
  return {
    tracked: false,
    wrist: new THREE.Vector3(),
    knuckle: new THREE.Vector3(),
    tips: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
  };
}

/** A hand on (or within this of) a target's bounds touches it. */
export const TOUCH_MARGIN = 0.04;
/** Pointing reaches this far (m). */
export const POINT_REACH = 2.5;
/** How quickly a held target catches up with the fist (1/s); smooths tracking jitter. */
const FOLLOW_RATE = 25;

interface Entry {
  target: Grabbable;
  state: GrabState;
  next: GrabState;
}

interface HandSlot {
  fist: FistDetector;
  /** What the open hand is on or pointing at; kept while the fist closes. */
  candidate: Entry | null;
  held: Entry | null;
  startGrip: THREE.Vector3;
  startYaw: number;
  startPos: THREE.Vector3;
  startQuat: THREE.Quaternion;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const grip = new THREE.Vector3();
const forward = new THREE.Vector3();
const local = new THREE.Vector3();
const offset = new THREE.Vector3();
const targetPos = new THREE.Vector3();
const scale = new THREE.Vector3();
const targetQuat = new THREE.Quaternion();
const yawQuat = new THREE.Quaternion();
const matrix = new THREE.Matrix4();
const inverse = new THREE.Matrix4();
const look = new THREE.Matrix4();
const ray = new THREE.Ray();
const hit = new THREE.Vector3();

const yawOf = (dir: THREE.Vector3) => Math.atan2(dir.x, dir.z);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class GrabSystem {
  private readonly entries: Entry[] = [];
  private readonly slots: HandSlot[] = [0, 1].map(() => ({
    fist: new FistDetector(),
    candidate: null,
    held: null,
    startGrip: new THREE.Vector3(),
    startYaw: 0,
    startPos: new THREE.Vector3(),
    startQuat: new THREE.Quaternion(),
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
  }));

  /** Makes a target grabbable. Returns a function that removes it. */
  add(target: Grabbable): () => void {
    const entry: Entry = { target, state: 'none', next: 'none' };
    this.entries.push(entry);
    return () => {
      for (const slot of this.slots) {
        if (slot.held === entry) this.release(slot);
        if (slot.candidate === entry) slot.candidate = null;
      }
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** Whether either hand is holding something. */
  get holding() {
    return this.slots[0].held !== null || this.slots[1].held !== null;
  }

  /** Per frame, with both hands (world space) and the eyes. */
  update(dt: number, hands: readonly GrabHand[], head: THREE.Vector3) {
    for (let i = 0; i < this.entries.length; i++) this.entries[i].next = 'none';

    for (let h = 0; h < this.slots.length; h++) {
      const slot = this.slots[h];
      const hand = hands[h];
      const event = slot.fist.update(hand?.tracked ? fistRatio(hand.wrist, hand.knuckle, hand.tips) : null, dt);
      if (event === 'release' && slot.held) this.release(slot);
      if (!hand?.tracked) {
        if (!slot.fist.holding) slot.candidate = null;
        if (slot.held) slot.held.next = 'held';
        continue;
      }
      grip.addVectors(hand.wrist, hand.knuckle).multiplyScalar(0.5);
      forward.subVectors(hand.knuckle, hand.wrist).normalize();

      if (slot.held) {
        this.follow(slot, dt, head);
        slot.held.next = 'held';
        continue;
      }
      // Aim while the hand is open; once it starts closing, keep that target.
      if (!slot.fist.closed) slot.candidate = this.findTarget(grip, forward, slot);
      else if (slot.candidate && !slot.candidate.target.canGrab()) slot.candidate = null;
      if (event === 'grab' && slot.candidate) this.grab(slot, slot.candidate);
      else if (slot.candidate && slot.candidate.next === 'none') slot.candidate.next = 'hover';
    }

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.next !== entry.state) {
        entry.state = entry.next;
        entry.target.setGrabState?.(entry.state);
      }
    }
  }

  /** The target the hand is on (nearest), else the one it points at (nearest along the ray). */
  private findTarget(point: THREE.Vector3, dir: THREE.Vector3, slot: HandSlot): Entry | null {
    let touched: Entry | null = null;
    let touchDistance = Infinity;
    let pointed: Entry | null = null;
    let pointDistance = Infinity;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const { target } = entry;
      if (!target.canGrab() || this.heldByOther(entry, slot)) continue;
      target.worldMatrix(matrix);
      inverse.copy(matrix).invert();
      local.copy(point).applyMatrix4(inverse);
      const d = target.bounds.distanceToPoint(local);
      // Smaller things win ties (a panel lying over the mat).
      const size = target.bounds.getSize(scale).lengthSq() * 1e-6;
      if (d <= TOUCH_MARGIN && d + size < touchDistance) {
        touched = entry;
        touchDistance = d + size;
        continue;
      }
      ray.origin.copy(point).applyMatrix4(inverse);
      ray.direction.copy(dir).transformDirection(inverse);
      if (ray.intersectBox(target.bounds, hit)) {
        const t = hit.distanceTo(ray.origin);
        if (t <= POINT_REACH && t < pointDistance) {
          pointed = entry;
          pointDistance = t;
        }
      }
    }
    return touched ?? pointed;
  }

  private heldByOther(entry: Entry, slot: HandSlot) {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i] !== slot && this.slots[i].held === entry) return true;
    return false;
  }

  private grab(slot: HandSlot, entry: Entry) {
    if (this.heldByOther(entry, slot)) return;
    slot.held = entry;
    slot.candidate = null;
    slot.startGrip.copy(grip);
    slot.startYaw = yawOf(forward);
    entry.target.worldMatrix(matrix);
    matrix.decompose(slot.startPos, slot.startQuat, scale);
    slot.pos.copy(slot.startPos);
    slot.quat.copy(slot.startQuat);
    entry.target.begin?.();
  }

  private follow(slot: HandSlot, dt: number, head: THREE.Vector3) {
    const entry = slot.held!;
    offset.subVectors(slot.startPos, slot.startGrip);
    if (entry.target.style === 'table') {
      // Follow the fist (up and down too) and turn with it about the vertical, staying level.
      const dyaw = wrapAngle(yawOf(forward) - slot.startYaw);
      yawQuat.setFromAxisAngle(UP, dyaw);
      offset.applyQuaternion(yawQuat);
      targetPos.addVectors(grip, offset);
      targetQuat.multiplyQuaternions(yawQuat, slot.startQuat);
    } else {
      // Move with the fist and face the eyes.
      targetPos.addVectors(grip, offset);
      look.lookAt(head, targetPos, UP);
      targetQuat.setFromRotationMatrix(look);
    }
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    slot.pos.lerp(targetPos, k);
    slot.quat.slerp(targetQuat, k);
    matrix.compose(slot.pos, slot.quat, ONE);
    entry.target.move(matrix);
  }

  private release(slot: HandSlot) {
    const entry = slot.held;
    slot.held = null;
    slot.candidate = null;
    entry?.target.end?.();
  }
}
