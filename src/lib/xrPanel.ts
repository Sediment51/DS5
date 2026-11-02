import * as THREE from 'three';
import { FingerCursor } from './fingerCursor';
import { isPointing } from './fist';
import type { Grabbable, GrabState } from './grab';
import { SliderGrip, type PokeSliderLayout, type SliderGripState } from './pokeSlider';
import { uiSound } from './uiSound';
import { workspace } from './workspaceFlow';

/** A fingertip counts as pressing within this distance of the face (m)… */
const TOUCH = 0.015;
/** …and must pull back this far before it can press again. */
const RELEASE = 0.03;
/** A pressed button flashes this long (s). */
const PRESS_FLASH = 0.3;
/** Canvas resolution. */
const PX_PER_METRE = 4400;

/** A control on a panel: a rectangle in panel space (metres, origin at the centre, y up). */
export interface PanelRegion {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** A slider (pressed and slid) rather than a button (pressed). */
  slider?: boolean;
  /** Greyed out: hover shows, a press does nothing. */
  enabled?: boolean;
  /** Sliders only: engage only for a pointing hand (index out, others curled). */
  needsPoint?: boolean;
}

export interface PanelOptions {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, panel: XRPanel) => void;
  onPress?: (id: string) => void;
  /** A slider was grabbed ('start'), moved, or let go ('end'). */
  onSlide?: (id: string, value: number, phase: 'start' | 'move' | 'end') => void;
}

const tip = new THREE.Vector3();
const wristV = new THREE.Vector3();
const knuckleV = new THREE.Vector3();
const indexV = new THREE.Vector3();
const others = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const OTHER_TIPS = ['middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;

/** Whether this headset hand is pointing (see isPointing). */
export function handIsPointing(hand: THREE.XRHandSpace): boolean {
  const j = hand.joints;
  const wrist = j.wrist;
  const knuckle = j['middle-finger-phalanx-proximal'];
  const index = j['index-finger-tip'];
  if (!wrist?.visible || !knuckle?.visible || !index?.visible) return false;
  wrist.getWorldPosition(wristV);
  knuckle.getWorldPosition(knuckleV);
  index.getWorldPosition(indexV);
  for (let i = 0; i < OTHER_TIPS.length; i++) {
    const t = j[OTHER_TIPS[i]];
    if (!t?.visible) return false;
    t.getWorldPosition(others[i]);
  }
  return isPointing(wristV, knuckleV, indexV, others);
}

/**
 * A headset panel pressed with a fingertip: a canvas-drawn card with
 * buttons and sliders. It handles the fingertip (nearest index tip, press
 * arming, slider grips that can't be lost), the cursor ring, the sounds, and
 * redraws only when something it shows changed.
 */
export class XRPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly width: number;
  readonly height: number;
  regions: PanelRegion[] = [];
  /** The region under the fingertip, and the one just pressed (flashing). */
  hover: string | null = null;
  pressed: string | null = null;
  /** A slider a non-pointing finger is touching (the panel says "point to slide"). */
  pointHint: string | null = null;
  /** The slider being slid. */
  sliding: string | null = null;
  /** The panel is being carried, and whether a hand is on it. */
  held = false;
  grabState: GrabState = 'none';
  /** Seconds since a fingertip was last near the panel. */
  idleFor = 0;
  private readonly grips = new Map<string, SliderGrip>();
  private readonly armed = [true, true];
  private owner = -1;
  private pressedFor = 0;
  private readonly cursor = new FingerCursor();
  private drawnKey = '';
  private dirty = true;

  constructor(private readonly options: PanelOptions) {
    this.width = options.width;
    this.height = options.height;
    this.canvas.width = Math.round(options.width * PX_PER_METRE);
    this.canvas.height = Math.round(options.height * PX_PER_METRE);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(options.width, options.height), material);
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
    this.mesh.add(this.cursor.mesh);
  }

  /** Pixels per metre of the canvas. */
  get k() {
    return PX_PER_METRE;
  }

  /** A region's rectangle in canvas pixels. */
  rect(id: string) {
    const r = this.regions.find((region) => region.id === id);
    if (!r) return { x: 0, y: 0, w: 0, h: 0 };
    const k = PX_PER_METRE;
    return { x: (r.x0 + this.width / 2) * k, y: (this.height / 2 - r.y1) * k, w: (r.x1 - r.x0) * k, h: (r.y1 - r.y0) * k };
  }

  /** A slider's grip state, for drawing. */
  gripState(id: string): SliderGripState {
    return this.grips.get(id)?.state ?? 'idle';
  }

  /** Redraw on the next update (the data it shows changed). */
  invalidate() {
    this.dirty = true;
  }

  /** Per frame, while shown: the fingertips, presses, slides and the redraw. */
  update(dt: number, renderer: THREE.WebGLRenderer) {
    const mesh = this.mesh;
    this.idleFor += dt;
    for (const r of this.regions) if (r.slider && !this.grips.has(r.id)) this.grips.set(r.id, new SliderGrip());

    // The nearest index fingertip over the panel (once a slider is grabbed, only that hand's); none while it's carried.
    let finger = -1;
    let fx = 0, fy = 0, fz = Infinity;
    for (let i = 0; i < 2 && !this.held; i++) {
      if (this.sliding && this.owner !== i) continue;
      const joint = renderer.xr.getHand(i).joints['index-finger-tip'];
      if (!joint?.visible) continue;
      mesh.worldToLocal(joint.getWorldPosition(tip));
      if (Math.abs(tip.z) > RELEASE) this.armed[i] = true;
      if (Math.abs(tip.x) > this.width / 2 + 0.05 || Math.abs(tip.y) > this.height / 2 + 0.05) {
        this.armed[i] = true;
        continue;
      }
      if (Math.abs(tip.z) >= Math.abs(fz)) continue;
      finger = i;
      fx = tip.x;
      fy = tip.y;
      fz = tip.z;
    }
    if (finger >= 0 && fz < 0.12) this.idleFor = 0;

    // Sliders: a touch grabs one; from then on only sideways movement counts, until the finger is pulled away.
    let holding = false;
    this.pointHint = null;
    for (const r of this.regions) {
      if (!r.slider) continue;
      if (this.sliding && this.sliding !== r.id) continue;
      const grip = this.grips.get(r.id)!;
      const wasHeld = grip.state === 'held';
      const centre = (r.y0 + r.y1) / 2;
      let x: number | null = finger >= 0 ? fx : null;
      if (x !== null && !wasHeld && r.needsPoint && !handIsPointing(renderer.xr.getHand(finger))) {
        // A finger on the slider that isn't pointing: say how, change nothing.
        if (Math.abs(fy - centre) < (r.y1 - r.y0) / 2 + 0.02 && fz < 0.06 && fx > r.x0 - 0.02 && fx < r.x1 + 0.02) this.pointHint = r.id;
        x = null;
      }
      const layout: PokeSliderLayout = { width: this.width, height: r.y1 - r.y0, trackStart: r.x0, trackEnd: r.x1, touchDepth: TOUCH };
      const held = grip.update(x, fy - centre, fz, layout, dt);
      if (held && !wasHeld) {
        uiSound.press();
        this.sliding = r.id;
        this.owner = finger;
        this.options.onSlide?.(r.id, grip.value, 'start');
      } else if (!held && wasHeld) {
        uiSound.release();
        this.sliding = null;
        this.options.onSlide?.(r.id, grip.value, 'end');
      } else if (held) this.options.onSlide?.(r.id, grip.value, 'move');
      if (held) holding = true;
    }

    // Buttons: lit while the finger is over one, flashed and clicked when pressed.
    this.hover = null;
    if (finger >= 0 && !holding && fz < 0.06 && fz > -RELEASE) {
      for (const r of this.regions) {
        if (r.slider) continue;
        if (fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1) this.hover = r.id;
      }
      const region = this.hover ? this.regions.find((r) => r.id === this.hover) : undefined;
      if (region && region.enabled !== false && Math.abs(fz) <= TOUCH && this.armed[finger]) {
        this.armed[finger] = false;
        this.pressed = region.id;
        this.pressedFor = PRESS_FLASH;
        uiSound.press();
        this.options.onPress?.(region.id);
        this.dirty = true;
      }
    }
    if (this.pressedFor > 0) {
      this.pressedFor -= dt;
      if (this.pressedFor <= 0) this.pressed = null;
    }
    this.cursor.update(finger >= 0 ? fx : null, fy, fz, holding || (this.hover !== null && Math.abs(fz) <= TOUCH));

    let key = `${this.hover}|${this.pressed}|${this.pointHint}|${this.grabState}`;
    for (const [id, grip] of this.grips) key += `|${id}:${grip.state}`;
    if (this.dirty || key !== this.drawnKey) {
      this.dirty = false;
      this.drawnKey = key;
      this.options.draw(this.ctx, this);
      this.texture.needsUpdate = true;
    }
  }

  /** Lets go of any slider and forgets the hover (the panel was hidden). */
  reset() {
    for (const grip of this.grips.values()) grip.state = 'idle';
    this.sliding = null;
    this.hover = null;
    this.idleFor = 0;
    this.cursor.update(null, 0, 0, false);
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.cursor.dispose();
  }
}

/** Where a user sits relative to the workspace frame: in front of the mat, above it. */
const eye = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const localMatrix = new THREE.Matrix4();
const pos = new THREE.Vector3();

/** All placements, so "Reset settings" can put every panel back. */
const placements = new Set<FramePlacement>();

/**
 * Where something sits in the workspace: a default spot in frame space
 * (turned to face a seated user, moving with the mat), or, once the user
 * has carried it somewhere, exactly there in the room, so moving one thing
 * (the mat, say) never moves another the user placed.
 */
export class FramePlacement {
  readonly defaultLocal = new THREE.Matrix4();
  /** Where the user put it, in world space (null: its default spot). */
  user: THREE.Matrix4 | null = null;

  constructor() {
    placements.add(this);
  }

  /** The default spot, given in frame space; it faces the user's usual eye position. */
  setDefault(x: number, y: number, z: number) {
    pos.set(x, y, z);
    eye.set(0, 0.45, workspace.depth / 2 + 0.35);
    // +Z of the panel points from it towards the eyes.
    this.defaultLocal.lookAt(eye, pos, UP).setPosition(pos);
  }

  /** The world pose now: where the user put it, else frame × default spot. */
  world(out: THREE.Matrix4) {
    return this.user ? out.copy(this.user) : out.multiplyMatrices(workspace.frame, this.defaultLocal);
  }

  /** Puts `object` at the world pose. */
  apply(object: THREE.Object3D) {
    this.world(localMatrix).decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld();
  }

  /** The user put it here (world): it stays exactly there for the session. */
  storeWorld(world: THREE.Matrix4) {
    this.user = world.clone();
  }

  dispose() {
    placements.delete(this);
  }

  /** Every panel back to its default spot. */
  static resetAll() {
    for (const p of placements) p.user = null;
  }
}

/** A panel that a fist can carry; it stays where it's let go, relative to the workspace. */
export function panelGrabbable(panel: XRPanel, placement: FramePlacement, canGrab: () => boolean): Grabbable {
  return {
    bounds: new THREE.Box3(
      new THREE.Vector3(-panel.width / 2, -panel.height / 2, -0.03),
      new THREE.Vector3(panel.width / 2, panel.height / 2, 0.03),
    ),
    style: 'panel',
    canGrab: () => panel.mesh.visible && canGrab(),
    worldMatrix: (out) => {
      panel.mesh.updateWorldMatrix(true, false);
      out.copy(panel.mesh.matrixWorld);
    },
    begin: () => {
      panel.held = true;
      panel.reset();
    },
    move: (world) => {
      world.decompose(panel.mesh.position, panel.mesh.quaternion, panel.mesh.scale);
      panel.mesh.updateMatrixWorld();
    },
    end: () => {
      panel.held = false;
      placement.storeWorld(panel.mesh.matrixWorld);
      uiSound.release();
    },
    setGrabState: (state) => {
      panel.grabState = state;
    },
  };
}
