import type * as THREE from 'three';

/**
 * How curled a hand is: the distance from the middle of the palm to the
 * least-curled of the four fingertips (index to pinky), over the palm's
 * length (wrist to middle knuckle). Every finger has to curl for it to drop:
 * on Meta's hand poses an open hand is ~1.5 and a fist ~0.35, while pointing
 * (1.4), a pinch (1.4) and fingers wrapped round a real object (~0.8) stay
 * above the fist threshold.
 */
export function fistRatio(wrist: THREE.Vector3, knuckle: THREE.Vector3, tips: readonly THREE.Vector3[]): number {
  const palm = wrist.distanceTo(knuckle);
  if (palm < 1e-4) return Infinity;
  // Middle of the palm, without allocating.
  const cx = (wrist.x + knuckle.x) / 2;
  const cy = (wrist.y + knuckle.y) / 2;
  const cz = (wrist.z + knuckle.z) / 2;
  let farthest = 0;
  for (let i = 0; i < tips.length; i++) {
    const t = tips[i];
    farthest = Math.max(farthest, Math.hypot(t.x - cx, t.y - cy, t.z - cz));
  }
  return farthest / palm;
}

/** Pointing: the index fingertip at least this far from the middle of the palm (palm lengths)… */
export const POINT_INDEX_OUT = 1.0;
/** …while the other three fingertips are curled in within this. */
export const POINT_OTHERS_IN = 0.85;

/**
 * Whether the hand is pointing: index finger out, middle, ring and pinky
 * curled. An open hand passing by (every finger out) or a fist (every finger
 * in) doesn't count, so only a deliberate point drives the opacity slider.
 * @param others the middle, ring and pinky tips.
 */
export function isPointing(
  wrist: THREE.Vector3,
  knuckle: THREE.Vector3,
  indexTip: THREE.Vector3,
  others: readonly THREE.Vector3[],
): boolean {
  const palm = wrist.distanceTo(knuckle);
  if (palm < 1e-4) return false;
  const cx = (wrist.x + knuckle.x) / 2;
  const cy = (wrist.y + knuckle.y) / 2;
  const cz = (wrist.z + knuckle.z) / 2;
  const reach = (t: THREE.Vector3) => Math.hypot(t.x - cx, t.y - cy, t.z - cz) / palm;
  if (reach(indexTip) < POINT_INDEX_OUT) return false;
  for (let i = 0; i < others.length; i++) if (reach(others[i]) > POINT_OTHERS_IN) return false;
  return true;
}

/** Below this the hand counts as a fist… */
export const FIST_CLOSE = 0.6;
/** …and above this it's open again (hysteresis against flicker). */
export const FIST_OPEN = 0.85;
/** A fist must be held this long (s) before it grabs, so a passing curl doesn't. */
export const GRAB_DWELL = 0.2;
/** A grab survives tracking dropping out for this long (s). */
export const GRAB_LOST_GRACE = 0.3;

export type FistEvent = 'grab' | 'release';

/** A fist that grabs after a short hold and lets go when the hand opens. */
export class FistDetector {
  /** The hand is curled into a fist (with hysteresis). */
  closed = false;
  /** A grab is in progress. */
  holding = false;
  private closedFor = 0;
  private lostFor = 0;

  /** @param ratio fistRatio, or null when the hand isn't tracked. */
  update(ratio: number | null, dt: number): FistEvent | null {
    if (ratio === null) {
      this.lostFor += dt;
      if (this.lostFor < GRAB_LOST_GRACE) return null;
      return this.reset();
    }
    this.lostFor = 0;
    if (!this.closed && ratio < FIST_CLOSE) {
      this.closed = true;
      this.closedFor = 0;
    } else if (this.closed && ratio > FIST_OPEN) {
      return this.reset();
    }
    if (!this.closed || this.holding) return null;
    this.closedFor += dt;
    if (this.closedFor < GRAB_DWELL) return null;
    this.holding = true;
    return 'grab';
  }

  /** Opens the hand (state only). Returns 'release' if it was holding. */
  reset(): FistEvent | null {
    const wasHolding = this.holding;
    this.closed = false;
    this.holding = false;
    this.closedFor = 0;
    this.lostFor = 0;
    return wasHolding ? 'release' : null;
  }
}
