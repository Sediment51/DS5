import * as THREE from 'three';
import { ribbonGeometry } from '../mat/xr/outlines';
import { FEEDBACK } from '../mat/xr/text';
import { MENTOR_ZONES, type MentorZone } from '../server/mentorPrompt';

/**
 * Feedback drawn on the wound itself: an outline around it in five parts
 * (both ends, both long edges, and a mark in the middle), each coloured by
 * what it means, so the user sees where to look instead of reading:
 *
 *   cyan   correct (the AI's check found this part fine; a step done)
 *   amber  needs attention (refine here; pulses; also: the hand was lost)
 *   blue   working on it (a sweep goes round while the photo is checked)
 *
 * Wound frame: +Y out of the palm, +Z along the cut (towards the fingers),
 * +X across it.
 */

/** The parts of the wound the mentor's verdict talks about. */
export const ZONES = MENTOR_ZONES;
export type Zone = MentorZone;
export type ZoneState = 'ok' | 'refine';

/** How far outside the wound the outline runs (m), and how high above the skin. */
const MARGIN = 0.006;
const LIFT = 0.004;
const WIDTH = 0.0026;
const GAP_DEG = 7;
/** A step-done flash and the verdict's display time (s). */
const FLASH_SECONDS = 1.3;
const VERDICT_SECONDS = 25;

const COLOR = {
  ok: new THREE.Color(FEEDBACK.correct),
  refine: new THREE.Color(FEEDBACK.attention),
  scan: new THREE.Color(FEEDBACK.selected),
};

type Mode = 'off' | 'verdict' | 'scan' | 'flash' | 'lost';
const up = new THREE.Vector3();

export class WoundOutline {
  readonly group = new THREE.Group();
  private readonly parts = new Map<Zone, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>();
  private mode: Mode = 'off';
  private time = 0;
  private left = 0;
  private states: Record<Zone, ZoneState> = { finger_end: 'ok', wrist_end: 'ok', thumb_edge: 'ok', little_finger_edge: 'ok', centre: 'ok' };
  /** +1 when the wound's +X edge is on the thumb side, −1 when it's the little finger's. */
  thumbSign = 1;
  private sizeKey = '';

  constructor() {
    for (const zone of ZONES) {
      const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
      );
      mesh.renderOrder = 18;
      this.parts.set(zone, mesh);
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  /** Builds the outline for a wound this wide and long (half-sizes, m). */
  setSize(halfWidth: number, halfLength: number) {
    const a = halfWidth + MARGIN;
    const b = halfLength + MARGIN;
    const key = `${a.toFixed(4)}:${b.toFixed(4)}:${this.thumbSign}`;
    if (key === this.sizeKey) return;
    this.sizeKey = key;
    const arc = (from: number, to: number) => {
      const points: number[] = [];
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const t = THREE.MathUtils.degToRad(from + ((to - from) * i) / steps);
        points.push(a * Math.cos(t), b * Math.sin(t));
      }
      return ribbonGeometry([{ points, closed: false }], WIDTH);
    };
    const g = GAP_DEG / 2;
    // Angles round the ellipse: 0° = +X edge, 90° = +Z end (fingers), 180° = −X edge, 270° = −Z end (wrist).
    const plusX = arc(-45 + g, 45 - g);
    const minusX = arc(135 + g, 225 - g);
    this.set('finger_end', arc(45 + g, 135 - g));
    this.set('wrist_end', arc(225 + g, 315 - g));
    this.set('thumb_edge', this.thumbSign > 0 ? plusX : minusX);
    this.set('little_finger_edge', this.thumbSign > 0 ? minusX : plusX);
    // The middle: a small ring.
    const ring: number[] = [];
    const r = Math.min(a, b) * 0.28;
    for (let i = 0; i < 24; i++) ring.push(r * Math.cos((i / 24) * Math.PI * 2), r * Math.sin((i / 24) * Math.PI * 2));
    this.set('centre', ribbonGeometry([{ points: ring, closed: true }], WIDTH * 0.8));
  }

  private set(zone: Zone, geometry: THREE.BufferGeometry) {
    const mesh = this.parts.get(zone)!;
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }

  /** The mentor's verdict: each part cyan (fine) or amber (refine here). */
  showVerdict(states: Partial<Record<Zone, ZoneState>>) {
    for (const zone of ZONES) this.states[zone] = states[zone] === 'refine' ? 'refine' : 'ok';
    this.start('verdict', VERDICT_SECONDS);
  }

  /** A sweep going round: the photo is being checked. */
  scan(on: boolean) {
    if (on) this.start('scan', Infinity);
    else if (this.mode === 'scan') this.stop();
  }

  /** A short cyan flash: a step done. */
  flash() {
    if (this.mode === 'verdict' || this.mode === 'scan') return;
    this.start('flash', FLASH_SECONDS);
  }

  /** Amber pulsing where the hand was last seen; false clears it. */
  lost(on: boolean) {
    if (on) this.start('lost', Infinity);
    else if (this.mode === 'lost') this.stop();
  }

  stop() {
    this.mode = 'off';
    this.group.visible = false;
  }

  private start(mode: Mode, seconds: number) {
    this.mode = mode;
    this.left = seconds;
    this.time = 0;
  }

  /**
   * Per frame: placed on the wound (its centre and orientation, +Y out of
   * the palm), unless the hand is lost (it stays where it was).
   */
  update(dt: number, point: THREE.Vector3 | null, quaternion: THREE.Quaternion | null, scale: number, opacity = 1) {
    if (this.mode === 'off') return;
    this.time += dt;
    if (this.left !== Infinity) {
      this.left -= dt;
      if (this.left <= 0) {
        this.stop();
        return;
      }
    }
    if (point && quaternion) {
      this.group.quaternion.copy(quaternion);
      this.group.position.copy(point).add(up.set(0, LIFT, 0).applyQuaternion(quaternion));
      this.group.scale.setScalar(scale);
    }
    this.group.visible = true;
    const fadeOut = this.left === Infinity ? 1 : Math.min(this.left / 0.6, 1);
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 6);
    ZONES.forEach((zone, i) => {
      const m = this.parts.get(zone)!.material;
      let alpha = 1;
      switch (this.mode) {
        case 'verdict': {
          const refine = this.states[zone] === 'refine';
          m.color.copy(refine ? COLOR.refine : COLOR.ok);
          alpha = refine ? pulse : 0.8;
          break;
        }
        case 'scan': {
          // One part lit at a time, going round.
          m.color.copy(COLOR.scan);
          const lit = Math.floor(this.time * 5) % ZONES.length;
          alpha = i === lit ? 1 : 0.25;
          break;
        }
        case 'flash':
          m.color.copy(COLOR.ok);
          alpha = Math.min(this.left / FLASH_SECONDS, 1);
          break;
        case 'lost':
          m.color.copy(COLOR.refine);
          alpha = zone === 'centre' ? 0 : pulse;
          break;
      }
      m.opacity = alpha * fadeOut * opacity;
    });
  }

  dispose() {
    for (const mesh of this.parts.values()) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
