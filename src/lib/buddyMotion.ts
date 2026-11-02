import * as THREE from 'three';
import { VIEW_CONE_DEG } from './buddy';

/**
 * How Buddy gets about: it rests where it is (drifting, glancing) while its
 * home stays close and it's in view; when not, it notices, reacts after a
 * moment and flies there along a gentle arc (steering: accelerates, cruises,
 * brakes), leaning into the motion, then overshoots a little, bobs and
 * settles. Events add their own moves (visit the wound, wobble, orbit the
 * hand, doze off, zip back). Everything reuses its own vectors: no
 * allocation per frame.
 */

/** Home may wander this far (cm) before Buddy goes after it. */
export const COMFORT_ZONE_CM = 6;
/** Buddy reacts this long (s, random in the range) after deciding to move. */
export const REACTION_DELAY_S: readonly [number, number] = [0.25, 0.5];
/** Flight (m/s, m/s²): top speed, top acceleration; the zip back after dozing is faster. */
export const MAX_SPEED = 0.6;
export const MAX_ACCEL = 1.5;
export const ZIP_SPEED = 1.0;
/** The arc's rise at its middle (m): min, max (scaled by the trip's length). */
export const ARC_HEIGHT: readonly [number, number] = [0.03, 0.06];
/** Lean into the motion (pitch) and into turns (roll), degrees at most. */
export const LEAN_MAX_DEG = 20;
export const ROLL_MAX_DEG = 15;
/** Stretch along the flight at top speed, squash on landing (fractions). */
export const STRETCH_AMOUNT = 0.06;
export const SQUASH_AMOUNT = 0.05;
/** Idle drift: position (cm) and rotation (degrees) amplitude, and its rate (Hz). */
export const DRIFT_CM = 1.2;
export const DRIFT_DEG = 4;
const DRIFT_HZ = 0.15;
/** Glances at the hand (s between, random in the range) and an idle flourish (loop or hop). */
export const GLANCE_INTERVAL_S: readonly [number, number] = [4, 9];
export const FLOURISH_INTERVAL_S: readonly [number, number] = [20, 40];

const COMFORT = COMFORT_ZONE_CM / 100;
/** Arrived within this of home (m); slows down within SLOW_RADIUS. */
const ARRIVE = 0.015;
const SLOW_RADIUS = 0.08;
/** Steering: how quickly velocity turns towards the desired one (s). */
const STEER_TIME = 0.15;
/** The carrot on the arc runs this far ahead of Buddy (m). */
const LOOKAHEAD = 0.05;
/** Bend the arc so it passes at least this far from the palm and the eyes (m). */
const PALM_CLEARANCE = 0.06;
const EYE_CLEARANCE = 0.3;
/** A trip longer than this starts with a little dip (m); its time (s) and depth (m). */
const DIP_TRIP = 0.15;
const DIP_SECONDS = 0.15;
const DIP_DEPTH = 0.01;
/** Trips longer than this fade the bubble while flying (m). */
const FADE_TRIP = 0.2;
/** Facing: the travel direction until this close (m), turning in about this long (s). */
const FACE_TRAVEL_UNTIL = 0.1;
const TURN_TRAVEL_S = 0.2;
const TURN_REST_S = 0.25;
const MAX_TILT_RAD = THREE.MathUtils.degToRad(15);
/** Landing: an underdamped spring on the arrival offset, a bob, a squash. */
const SETTLE_OMEGA = 14;
const SETTLE_ZETA = 0.45;
const BOB_SECONDS = 0.7;
const BOB_DEPTH = 0.008;
const SQUASH_SECONDS = 0.35;
/** Visiting the wound: hold there this long (s). */
const VISIT_HOLD = 1;
/** Orbit of the hand when the flow is done: radius (m), time (s). */
const ORBIT_RADIUS = 0.12;
const ORBIT_SECONDS = 2;
/** Flourishes: loop radius (m) and time (s); hop height (m) and time (s). */
const LOOP_RADIUS = 0.04;
const LOOP_SECONDS = 1.2;
const HOP_HEIGHT = 0.03;
const HOP_SECONDS = 0.5;
/** Shake-no wobble: amplitude (m), rate (Hz), time (s). */
const WOBBLE = 0.012;
const WOBBLE_HZ = 2.5;
const WOBBLE_SECONDS = 1;
/** Dozing: sink this far below home (m), slowly (m/s); never closer to the viewer. Asleep, it still moves (at DOZE_SPEED) if home moves away. */
const SLEEP_DROP = 0.05;
const SLEEP_SPEED = 0.05;
const DOZE_SPEED = 0.3;
/** Greeting: enter from this far round from the gaze (degrees), this far away (m). */
const ENTER_DEG = VIEW_CONE_DEG + 12;
const ENTER_DISTANCE = 0.45;

const rand = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth 1D value noise in −1..1 (two octaves), cheap and allocation-free. */
function hash(i: number, seed: number) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function octave(p: number, seed: number) {
  const i = Math.floor(p);
  const u = smooth(p - i);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}
function noise(t: number, seed: number) {
  return (octave(t, seed) * 0.7 + octave(t * 2.3, seed + 17) * 0.3) * 2 - 1;
}

/** Notable moments, for the caller's animations and speech. */
export type MotionEvent = 'arrived' | 'visitArrived' | 'visitLeft' | 'orbitDone' | null;

export interface MotionInput {
  eye: THREE.Vector3;
  gaze: THREE.Vector3;
  /** The viewer's right and up (unit). */
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** Where the placement rules want Buddy now. */
  home: THREE.Vector3;
  /** The wound's centre, or null without the hand. */
  wound: THREE.Vector3 | null;
  /** Look at the wound now (the other hand is about to pinch). */
  watchWound: boolean;
  /** Face the viewer exactly (speaking). */
  facingViewer: boolean;
  /** Buddy is making an expression (a reaction, talking, an occasion's clip): turn its face to the viewer, whatever else it's doing. */
  expressive: boolean;
  /** Nothing else is going on: a flourish may play. */
  idle: boolean;
}

export class BuddyMotion {
  /** Outputs: where Buddy is, how it's turned, its root's squash/stretch, its speed (0..1 of top speed), the bubble's opacity. */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly stretch = new THREE.Vector3(1, 1, 1);
  speed01 = 0;
  bubbleOpacity = 1;

  mode: 'rest' | 'travel' | 'orbit' = 'rest';
  asleep = false;
  /** Calm: no idle flourishes or glances, and half the drift, so it never draws the eye while you work. */
  calm = false;
  private started = false;
  private readonly body = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly accel = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  // Trip.
  private readonly tripStart = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private readonly control = new THREE.Vector3();
  private readonly carrot = new THREE.Vector3();
  private tripU = 0;
  private tripMaxSpeed = MAX_SPEED;
  private tripLong = false;
  private needsTripLength = false;
  private reactIn = -1;
  private dipT = -1;
  private readonly dipDir = new THREE.Vector3();
  // Overrides: visiting the wound, dozing.
  private visit: 'none' | 'going' | 'holding' | 'returning' = 'none';
  private visitFor = 0;
  // Landing.
  private readonly settle = new THREE.Vector3();
  private readonly settleVel = new THREE.Vector3();
  private bobT = Infinity;
  private squashT = Infinity;
  // Moves on the spot.
  private wobbleT = Infinity;
  private flourish: 'none' | 'loop' | 'hop' = 'none';
  private flourishT = 0;
  private nextFlourish = rand(FLOURISH_INTERVAL_S);
  private nextGlance = rand(GLANCE_INTERVAL_S);
  private glanceFor = 0;
  // Orbit.
  private orbitT = 0;
  private orbitAngle0 = 0;
  private orbitRadius0 = 0;
  // Turning.
  private readonly tilt = new THREE.Vector3();
  private time = Math.random() * 100;
  private stretchNow = 0;

  // Scratch.
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly qFace = new THREE.Quaternion();
  private readonly qTilt = new THREE.Quaternion();

  /** Whether new speech may start: not while flying somewhere (but yes on the way back from the wound). */
  get speechReady() {
    if (this.visit === 'returning') return true;
    return this.mode === 'rest' && this.visit === 'none' && this.dipT < 0;
  }

  get travelling() {
    return this.mode !== 'rest' || this.visit === 'going';
  }

  /** Session start: appear just outside the view, on `side` (+1 right, −1 left), and fly home. */
  enter(input: MotionInput, side: number) {
    const angle = THREE.MathUtils.degToRad(ENTER_DEG) * Math.sign(side || 1);
    this.a.copy(input.gaze).applyAxisAngle(input.up, -angle);
    this.body.copy(input.eye).addScaledVector(this.a, ENTER_DISTANCE);
    this.vel.set(0, 0, 0);
    this.anchor.copy(this.body);
    this.position.copy(this.body);
    this.started = true;
    this.startTrip(MAX_SPEED, false);
  }

  /** Carried by hand: it's exactly here, at rest (the caller makes this its home too). */
  place(position: THREE.Vector3) {
    this.mode = 'rest';
    this.visit = 'none';
    this.endFlourish();
    this.body.copy(position);
    this.anchor.copy(position);
    this.position.copy(position);
    this.vel.set(0, 0, 0);
    this.settle.set(0, 0, 0);
    this.settleVel.set(0, 0, 0);
    this.reactIn = -1;
    this.dipT = -1;
    this.tripLong = false;
    this.started = true;
  }

  /** New step: fly to hover over the wound, hold, then glide home. */
  visitWound() {
    if (this.asleep) return;
    this.visit = 'going';
    this.visitFor = 0;
    this.endFlourish();
    this.startTrip(MAX_SPEED, false);
  }

  /** Near miss: wobble on the spot. */
  wobble() {
    this.wobbleT = 0;
  }

  /** Flow done: one loop around the hand, then home. */
  orbitHand(wound: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3) {
    if (this.asleep) return;
    this.visit = 'none';
    this.endFlourish();
    this.a.subVectors(this.body, wound);
    this.orbitAngle0 = Math.atan2(this.a.dot(up), this.a.dot(right));
    this.orbitRadius0 = Math.hypot(this.a.dot(up), this.a.dot(right));
    this.orbitT = 0;
    this.mode = 'orbit';
    this.bubbleOpacity = 0.4;
  }

  /** Doze off: sink a little, slowly. */
  sleep() {
    this.asleep = true;
    this.visit = 'none';
    this.endFlourish();
    this.startTrip(SLEEP_SPEED, true);
  }

  /** Wake: zip home, fast. */
  wake() {
    this.asleep = false;
    this.startTrip(ZIP_SPEED, true);
  }

  private endFlourish() {
    this.flourish = 'none';
  }

  private startTrip(maxSpeed: number, noDip: boolean) {
    this.mode = 'travel';
    this.reactIn = -1;
    this.tripStart.copy(this.body);
    this.tripU = 0;
    this.tripMaxSpeed = maxSpeed;
    this.tripLong = false;
    this.dipT = -1;
    this.needsTripLength = !noDip;
  }

  /** The current destination. */
  private destination(input: MotionInput, out: THREE.Vector3) {
    if (this.asleep) {
      out.copy(input.home);
      out.y -= SLEEP_DROP;
      return out;
    }
    if ((this.visit === 'going' || this.visit === 'holding') && input.wound) {
      return out.copy(input.wound).addScaledVector(THREE.Object3D.DEFAULT_UP, 0.06);
    }
    return out.copy(input.home);
  }

  private inView(input: MotionInput, point: THREE.Vector3, marginDeg: number) {
    this.c.subVectors(point, input.eye);
    const len = this.c.length();
    if (len < 1e-6) return true;
    return this.c.dot(input.gaze) / len >= Math.cos(THREE.MathUtils.degToRad(VIEW_CONE_DEG + marginDeg));
  }

  /** The arc's control point: the straight path raised, and bent away from the palm and the eyes. */
  private updateControl(input: MotionInput) {
    const s = this.tripStart;
    const g = this.goal;
    const length = s.distanceTo(g);
    this.control.addVectors(s, g).multiplyScalar(0.5);
    this.control.y += 2 * THREE.MathUtils.clamp(length * 0.25, ARC_HEIGHT[0], ARC_HEIGHT[1]);
    if (input.wound) this.bendAround(input.wound, PALM_CLEARANCE);
    this.bendAround(input.eye, EYE_CLEARANCE);
  }

  private bendAround(obstacle: THREE.Vector3, clearance: number) {
    const s = this.tripStart;
    this.a.subVectors(this.goal, s);
    const len2 = this.a.lengthSq();
    if (len2 < 1e-8) return;
    const t = THREE.MathUtils.clamp(this.b.subVectors(obstacle, s).dot(this.a) / len2, 0, 1);
    this.b.copy(s).addScaledVector(this.a, t); // closest point on the straight path
    this.c.subVectors(this.b, obstacle);
    const d = this.c.length();
    if (d >= clearance || t <= 0 || t >= 1) return;
    if (d < 1e-5) this.c.set(0, 1, 0);
    // The curve passes half as far out as its control point.
    this.control.addScaledVector(this.c.normalize(), 2 * (clearance - d));
  }

  private bezier(u: number, out: THREE.Vector3) {
    const v = 1 - u;
    return out
      .copy(this.tripStart)
      .multiplyScalar(v * v)
      .addScaledVector(this.control, 2 * v * u)
      .addScaledVector(this.goal, u * u);
  }

  update(dt: number, input: MotionInput): MotionEvent {
    this.time += dt;
    let event: MotionEvent = null;
    if (!this.started) {
      this.body.copy(input.home);
      this.anchor.copy(input.home);
      this.started = true;
    }
    this.prevVel.copy(this.vel);
    this.destination(input, this.goal);

    if (this.mode === 'rest') {
      this.body.copy(this.anchor);
      this.vel.set(0, 0, 0);
      if (this.visit === 'holding') {
        this.visitFor += dt;
        if (this.visitFor >= VISIT_HOLD) {
          this.visit = 'returning';
          this.startTrip(MAX_SPEED, true);
          event = 'visitLeft';
        }
      } else if (this.wobbleT === Infinity) {
        // Decide: stay while home is close and Buddy's in view; else react, then go.
        const away = this.goal.distanceTo(this.anchor) > COMFORT || !this.inView(input, this.anchor, 2);
        if (!away) this.reactIn = -1;
        else if (this.reactIn < 0) this.reactIn = rand(REACTION_DELAY_S);
        else if ((this.reactIn -= dt) <= 0) this.startTrip(this.asleep ? DOZE_SPEED : MAX_SPEED, this.asleep);
      }
    }

    this.destination(input, this.goal); // a trip may have just begun (back home from the wound)
    if (this.mode === 'travel') event = this.fly(dt, input) ?? event;
    else if (this.mode === 'orbit') event = this.orbit(dt, input) ?? event;

    // The bubble dims on long flights, and comes back on landing.
    const dimmed = this.travelling && (this.tripLong || this.mode === 'orbit');
    this.bubbleOpacity += ((dimmed ? 0.4 : 1) - this.bubbleOpacity) * (1 - Math.exp(-6 * dt));

    this.compose(dt, input);
    return event;
  }

  /** One frame of flight along the arc; lands when within ARRIVE of the (moving) destination. */
  private fly(dt: number, input: MotionInput): MotionEvent {
    if (this.needsTripLength) {
      this.needsTripLength = false;
      const length = this.tripStart.distanceTo(this.goal);
      this.tripLong = length > FADE_TRIP;
      if (length > DIP_TRIP) {
        this.dipT = 0;
        this.dipDir.subVectors(this.tripStart, this.goal).normalize().multiplyScalar(0.7);
        this.dipDir.y -= 0.7;
        this.dipDir.normalize();
      }
    } else if (this.tripU === 0 && !this.tripLong) {
      this.tripLong = this.tripStart.distanceTo(this.goal) > FADE_TRIP;
    }
    // Anticipation: hold still for the dip, then go.
    if (this.dipT >= 0 && this.dipT < DIP_SECONDS) return null;

    this.updateControl(input);
    // Move the carrot along the arc while Buddy is close to it.
    for (let i = 0; i < 50 && this.tripU < 1; i++) {
      if (this.bezier(this.tripU, this.carrot).distanceTo(this.body) > LOOKAHEAD) break;
      this.tripU = Math.min(1, this.tripU + 0.02);
    }
    this.bezier(this.tripU, this.carrot);
    const remaining = this.body.distanceTo(this.goal);
    if (this.tripU >= 1 && remaining < ARRIVE) return this.land();

    // Arrive steering: cruise, then brake in time.
    const top = this.tripMaxSpeed;
    const speed = Math.min(top, top * (remaining / SLOW_RADIUS), Math.sqrt(2 * MAX_ACCEL * 0.8 * remaining));
    this.a.subVectors(this.tripU >= 1 ? this.goal : this.carrot, this.body);
    const dist = this.a.length();
    if (dist > 1e-6) this.a.multiplyScalar(speed / dist);
    else this.a.set(0, 0, 0);
    this.b.subVectors(this.a, this.vel).divideScalar(STEER_TIME);
    const accel = Math.min(MAX_ACCEL * (top / MAX_SPEED), this.b.length());
    if (accel > 0) this.b.setLength(accel);
    this.vel.addScaledVector(this.b, dt);
    this.body.addScaledVector(this.vel, dt);
    return null;
  }

  private land(): MotionEvent {
    this.mode = 'rest';
    this.anchor.copy(this.goal);
    this.settle.subVectors(this.body, this.anchor);
    this.settleVel.copy(this.vel);
    this.vel.set(0, 0, 0);
    this.body.copy(this.anchor);
    this.bobT = 0;
    this.squashT = 0;
    this.tripLong = false;
    if (this.visit === 'going') {
      this.visit = 'holding';
      this.visitFor = 0;
      return 'visitArrived';
    }
    if (this.visit === 'returning') this.visit = 'none';
    return 'arrived';
  }

  private orbit(dt: number, input: MotionInput): MotionEvent {
    if (!input.wound) {
      this.startTrip(MAX_SPEED, true);
      return 'orbitDone';
    }
    this.orbitT += dt;
    const p = Math.min(this.orbitT / ORBIT_SECONDS, 1);
    const angle = this.orbitAngle0 + 2 * Math.PI * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    const radius = THREE.MathUtils.lerp(this.orbitRadius0, ORBIT_RADIUS, smooth(Math.min(this.orbitT / 0.4, 1)));
    this.a.copy(this.body);
    this.body
      .copy(input.wound)
      .addScaledVector(input.right, radius * Math.cos(angle))
      .addScaledVector(input.up, radius * Math.sin(angle));
    this.vel.subVectors(this.body, this.a).divideScalar(Math.max(dt, 1e-4));
    if (p >= 1) {
      this.startTrip(MAX_SPEED, true);
      return 'orbitDone';
    }
    return null;
  }

  /** Final pose: flight or rest, plus landing, dip, drift and on-the-spot moves; turned, leaning, squashed. */
  private compose(dt: number, input: MotionInput) {
    const pos = this.position.copy(this.body);
    // Landing: an underdamped spring on the arrival offset (a little overshoot), then a bob.
    if (this.mode === 'rest') {
      this.a.copy(this.settle).multiplyScalar(-SETTLE_OMEGA * SETTLE_OMEGA).addScaledVector(this.settleVel, -2 * SETTLE_ZETA * SETTLE_OMEGA);
      this.settleVel.addScaledVector(this.a, dt);
      this.settle.addScaledVector(this.settleVel, dt);
      pos.add(this.settle);
    } else {
      this.settle.set(0, 0, 0);
      this.settleVel.set(0, 0, 0);
    }
    if (this.bobT < BOB_SECONDS) {
      this.bobT += dt;
      const t = Math.min(this.bobT / BOB_SECONDS, 1);
      pos.y -= BOB_DEPTH * Math.sin(2 * Math.PI * t) * (1 - t);
    }
    // Anticipation dip before a long trip.
    if (this.dipT >= 0) {
      this.dipT += dt;
      const t = this.dipT / (2 * DIP_SECONDS);
      if (t >= 1) this.dipT = -1;
      else pos.addScaledVector(this.dipDir, DIP_DEPTH * Math.sin(Math.PI * t));
    }
    // Speed: drift fades out while flying.
    const speed = this.vel.length();
    this.speed01 = Math.min(speed / MAX_SPEED, 1);
    const calm = (1 - this.speed01) * (this.calm ? 0.5 : 1);
    const t = this.time * DRIFT_HZ;
    const drift = (DRIFT_CM / 100) * calm;
    pos.x += drift * noise(t, 1);
    pos.y += drift * noise(t, 2);
    pos.z += drift * noise(t, 3);
    // Shake-no wobble, side to side.
    if (this.wobbleT < WOBBLE_SECONDS) {
      this.wobbleT += dt;
      const w = Math.min(this.wobbleT / WOBBLE_SECONDS, 1);
      pos.addScaledVector(input.right, WOBBLE * Math.sin(2 * Math.PI * WOBBLE_HZ * this.wobbleT) * (1 - w));
      if (w >= 1) this.wobbleT = Infinity;
    }
    // Idle flourish: a loop-de-loop or a hop, now and then when nothing else is on.
    const resting = this.mode === 'rest' && this.visit === 'none' && !this.asleep && this.reactIn < 0;
    if (this.flourish === 'none') {
      this.nextFlourish -= dt;
      if (this.nextFlourish <= 0 && resting && input.idle && !this.calm) {
        this.flourish = Math.random() < 0.5 ? 'loop' : 'hop';
        this.flourishT = 0;
        this.nextFlourish = rand(FLOURISH_INTERVAL_S);
      }
    } else {
      this.flourishT += dt;
      if (this.flourish === 'loop') {
        const p = Math.min(this.flourishT / LOOP_SECONDS, 1);
        const angle = 2 * Math.PI * smooth(p);
        pos.addScaledVector(input.right, LOOP_RADIUS * Math.sin(angle)).addScaledVector(input.up, LOOP_RADIUS * (1 - Math.cos(angle)));
        if (p >= 1) this.flourish = 'none';
      } else {
        const p = Math.min(this.flourishT / HOP_SECONDS, 1);
        pos.y += HOP_HEIGHT * Math.sin(Math.PI * p);
        if (p >= 1) {
          this.flourish = 'none';
          this.squashT = 0;
        }
      }
    }

    // Where to look: the way it's flying, a glance at the hand, the wound before a pinch, else the viewer.
    if (resting && !this.calm) {
      this.nextGlance -= dt;
      if (this.nextGlance <= 0) {
        this.nextGlance = rand(GLANCE_INTERVAL_S);
        this.glanceFor = 1;
      }
    }
    this.glanceFor -= dt;
    const remaining = this.body.distanceTo(this.goal);
    // An expression is always shown to the viewer; otherwise face the flight, or glance at the wound.
    const facingTravel = !input.expressive && this.mode !== 'rest' && speed > 0.05 && (remaining > FACE_TRAVEL_UNTIL || this.mode === 'orbit');
    let atViewer = false;
    if (facingTravel) this.look.copy(this.vel);
    else if (!input.expressive && input.wound && (input.watchWound || this.glanceFor > 0 || this.visit === 'holding')) this.look.subVectors(input.wound, pos);
    else {
      this.look.subVectors(input.eye, pos);
      atViewer = true;
    }
    const flat = Math.hypot(this.look.x, this.look.z);
    let yaw = Math.atan2(this.look.x, this.look.z);
    let pitch = flat > 1e-5 ? -Math.atan2(this.look.y, flat) : 0;
    if (facingTravel) pitch = 0;
    else if (!(atViewer && (input.facingViewer || input.expressive))) pitch = THREE.MathUtils.clamp(pitch, -MAX_TILT_RAD, MAX_TILT_RAD);
    if (flat < 1e-5) yaw = this.euler.y;
    const driftRot = THREE.MathUtils.degToRad(DRIFT_DEG) * calm * (input.facingViewer || input.expressive ? 0.4 : 1);
    this.euler.set(pitch + driftRot * noise(t, 4), yaw + driftRot * noise(t, 5), driftRot * noise(t, 6), 'YXZ');
    this.qFace.setFromEuler(this.euler);

    // Lean: tilt the top towards the flight (pitch) and into the turn (roll), from speed and acceleration.
    this.accel.subVectors(this.vel, this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.a.set(0, 0, 0);
    if (speed > 1e-3) {
      this.b.copy(this.vel).divideScalar(speed); // flight direction
      const forward = this.accel.dot(this.b);
      const lean = THREE.MathUtils.degToRad(LEAN_MAX_DEG) * THREE.MathUtils.clamp(0.65 * this.speed01 + 0.35 * (forward / MAX_ACCEL), -0.4, 1);
      this.a.copy(this.b).multiplyScalar(lean);
      this.c.copy(this.accel).addScaledVector(this.b, -forward); // sideways: the turn
      const side = this.c.length();
      if (side > 1e-4) this.a.addScaledVector(this.c, (THREE.MathUtils.degToRad(ROLL_MAX_DEG) * Math.min(side / MAX_ACCEL, 1)) / side);
    }
    this.a.y = 0;
    this.tilt.lerp(this.a, 1 - Math.exp(-8 * dt));
    const tiltAngle = Math.min(this.tilt.length(), THREE.MathUtils.degToRad(LEAN_MAX_DEG));
    if (tiltAngle > 1e-4) {
      this.b.crossVectors(THREE.Object3D.DEFAULT_UP, this.tilt).normalize();
      this.qTilt.setFromAxisAngle(this.b, tiltAngle);
      this.qFace.premultiply(this.qTilt);
    }
    this.quaternion.slerp(this.qFace, 1 - Math.exp((-3 / (facingTravel ? TURN_TRAVEL_S : TURN_REST_S)) * dt));

    // Squash and stretch (volume kept): long along the flight at speed, short on landing.
    this.stretchNow += (STRETCH_AMOUNT * (facingTravel ? this.speed01 : 0) - this.stretchNow) * (1 - Math.exp(-10 * dt));
    let squash = 0;
    if (this.squashT < SQUASH_SECONDS) {
      this.squashT += dt;
      squash = SQUASH_AMOUNT * Math.sin(Math.PI * Math.min(this.squashT / SQUASH_SECONDS, 1));
    }
    const along = 1 + this.stretchNow; // local +Z: the flight, when facing it
    const across = 1 / Math.sqrt(along);
    const tall = 1 - squash;
    const wide = 1 / Math.sqrt(tall);
    this.stretch.set(across * wide, across * tall, along * wide);
  }
}
