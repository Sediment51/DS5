import * as THREE from 'three';
import type { Grabbable, GrabState } from '../../lib/grab';
import { uiSound } from '../../lib/uiSound';
import { woundLink } from '../../lib/woundSteps';
import { workspace, type MatControls } from '../../lib/workspaceFlow';
import { MAT_ACCENTS, xrPrefs } from '../../lib/xrPrefs';
import type { Kit } from '../lib/kit';
import { clearSavedMat, loadOpacity, saveMat, saveOpacity, type SavedMat } from '../lib/matStore';
import { PalmUpToggle } from '../lib/palmUp';
import { PinchDetector } from '../lib/pinch';
import { fitRectangle, isBigEnough, orientToViewer, type MatPlacement } from '../lib/rectFit';
import { StrokeBuffer } from '../lib/stroke';
import { medianY, pointInPolygon, surfaceFromPen } from '../lib/surface';
import { HandTracker, type HandState } from './hands';
import { MatPreview } from './MatPreview';
import { MatView } from './MatView';
import { StrokeView } from './StrokeView';
import { detectedHorizontalPlanes, findSurfacePlane, SurfaceProbe } from './surfaceProbe';

export interface MatSystemEvents {
  /** A mat was saved for restoring later (or cleared, with null). */
  onSavedMatChange?: (mat: SavedMat | null) => void;
}

export interface StartOptions {
  /** What to lay out on the mat. */
  kit: Kit;
  /** Restore this mat from its persistent anchor instead of drawing a new one. */
  restore?: SavedMat | null;
}

/**
 * draw: waiting for a pinch · drawing: recording the stroke · settling:
 * waiting on the table height · placed: the mat is on the table ·
 * restoring: looking for a saved mat.
 */
type Phase = 'draw' | 'drawing' | 'settling' | 'placed' | 'restoring';

/** Fewer pen points than this is an accidental pinch, not a drawing. */
const MIN_STROKE_POINTS = 12;
/** Pen points more than this above the table are the hand arriving or leaving. */
const STROKE_LIFT = 0.04;
/** The live preview is refitted every this many new pen points. */
const PREVIEW_EVERY = 6;
/** Give up looking for a restored mat after this long (s). */
const RESTORE_TIMEOUT = 12;
/** How quickly the overlay follows the opacity slider (1/s). */
const OPACITY_RATE = 12;
/** Fingertip radius assumed when the stroke has no hand (the ?test trace). */
const DEFAULT_PEN_RADIUS = 0.008;
/** Selecting an item: a straight index fingertip comes down within this of the table (m)… */
const SELECT_TOUCH = 0.006;
/** …having been lifted at least this far first. */
const SELECT_LIFT = 0.015;

const DRAW_TITLE = 'Set up your workspace';
const DRAW_DETAIL = 'Below eye level: pinch on the table and trace your mat';

const cm = (m: number) => Math.round(m * 100);
/** Let go within this of a detected table's surface (m), the mat settles flush onto it; otherwise it stays where it was let go. */
const RETABLE_RANGE = 0.06;

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();

/**
 * The material mat, inside the injury simulation's mixed-reality session:
 * pinch-trace a rectangle on the table and the kit is laid out on it. It
 * adds `root` to the scene and is updated from the scene's XR frames; the
 * session and renderer are the injury simulation's. Its pose is the
 * workspace frame the menus and Buddy are placed by; the menus drive it
 * through MatControls.
 */
export class MatSystem implements MatControls {
  /** Everything the mat draws; add it to the scene once. */
  readonly root = new THREE.Group();
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly hands = new HandTracker();
  private readonly pinches = { left: new PinchDetector(), right: new PinchDetector() };
  private readonly stroke = new StrokeBuffer();
  private readonly strokeView = new StrokeView();
  private readonly preview = new MatPreview();
  private readonly probe = new SurfaceProbe();
  private readonly mat = new MatView();
  private readonly palmUp = new PalmUpToggle();

  private session: XRSession | null = null;
  private kit: Kit | null = null;
  private phase: Phase = 'draw';
  private lastTime = 0;
  /** The hand drawing the current stroke. */
  private pen: HandState | null = null;
  private previewAt = 0;
  private restoreWaited = 0;
  private _stepMode = false;
  /** Index of the current item in step mode. */
  private step = 0;
  /** The item picked by touching it (-1: none). */
  private selected = -1;
  private readonly selectArmed = { left: false, right: false };
  private highlightKey = '';
  private opacityTarget = 1;
  private opacityShown = 1;
  private prefsVersion = -1;

  private anchor: XRAnchor | null = null;
  private readonly anchorSpaces: XRSpace[] = [];
  private readonly anchorPose = new Float32Array(16);
  private savedHandle: string | null = null;
  /** Bumped on every redraw so late anchor promises from an old mat are ignored. */
  private generation = 0;
  private testTraceRequested = false;
  /** The mat is being carried: its anchor doesn't move it. */
  private moving = false;
  /** It was put down: anchor it where it is, next frame. */
  private reanchorRequested = false;
  /** The mat, to move with a fist (see GrabSystem). */
  readonly grabbables: Grabbable[];

  private readonly head = new THREE.Vector3();
  private readonly headMatrix = new THREE.Matrix4();

  constructor(private readonly events: MatSystemEvents = {}) {
    this.grabbables = [this.matGrabbable()];
    this.root.add(this.strokeView.group, this.preview.group, this.mat.root);
    this.root.visible = false;
    if (import.meta.env.DEV) (window as unknown as { __mat?: MatSystem }).__mat = this;
  }

  get active() {
    return this.session !== null;
  }

  /** Starts with a running mixed-reality session (rendered by `renderer`). */
  start(session: XRSession, renderer: THREE.WebGLRenderer, options: StartOptions) {
    this.session = session;
    this.renderer = renderer;
    if (options.kit !== this.kit) {
      this.kit = options.kit;
      this.mat.setKit(options.kit);
    }
    this.opacityTarget = this.opacityShown = loadOpacity();
    this.mat.setOpacity(this.opacityShown);
    this.prefsVersion = -1;
    this.lastTime = 0;
    this.root.visible = true;
    this.resetToDraw();
    if (options.restore) this.restore(session, options.restore);
  }

  /** The session ended: anchors die with it (a persistent one can be restored next time). */
  stop() {
    this.probe.cancel();
    this.anchor = null;
    this.session = null;
    this.renderer = null;
    this.root.visible = false;
    this.mat.setVisible(false);
    this.preview.hide();
    workspace.frameValid = false;
  }

  /** Removes the mat (and its saved anchor) and starts drawing again. */
  redraw() {
    const session = this.session;
    this.anchor?.delete();
    this.anchor = null;
    if (this.savedHandle && session?.deletePersistentAnchor) {
      void session.deletePersistentAnchor(this.savedHandle).catch(() => {});
    }
    if (this.savedHandle) {
      this.savedHandle = null;
      clearSavedMat();
      this.events.onSavedMatChange?.(null);
    }
    this.resetToDraw();
    workspace.flow.matRemoved();
  }

  /**
   * Test aid (the page's ?test mode, for the emulator): next frame, trace a
   * 60 × 40 cm rectangle on the table 50 cm ahead as if it had been
   * pinch-drawn, then place it through the usual steps.
   */
  traceTestRectangle() {
    if (this.phase === 'draw') this.testTraceRequested = true;
  }

  // MatControls, for the menus.

  get itemCount() {
    return this.mat.itemCount;
  }

  get stepMode() {
    return this._stepMode;
  }

  get canPrev() {
    return this._stepMode ? this.step > 0 : this.mat.page > 0;
  }

  get canNext() {
    return this._stepMode ? this.step < this.mat.itemCount - 1 : this.mat.page < this.mat.pages - 1;
  }

  get status() {
    const count = this.mat.itemCount;
    if (this._stepMode) {
      const item = this.kit?.items[this.step];
      return `Step ${item?.step ?? this.step + 1} of ${count} · ${item?.name ?? ''}`;
    }
    if (this.selected >= 0) return `Selected · ${this.kit?.items[this.selected]?.name ?? ''}`;
    if (this.mat.pages > 1) return `Page ${this.mat.page + 1} of ${this.mat.pages}`;
    return `All ${count} materials`;
  }

  get opacity() {
    return this.opacityTarget;
  }

  setOpacity(value: number, done: boolean) {
    this.opacityTarget = Math.min(Math.max(value, 0), 1);
    if (done) saveOpacity(this.opacityTarget);
  }

  prev() {
    this.turn(-1);
  }

  next() {
    this.turn(1);
  }

  toggleStep() {
    this._stepMode = !this._stepMode;
    // Start from the selected item, else the first one on the page in view.
    if (this._stepMode) this.step = this.selected >= 0 ? this.selected : Math.max(this.firstItemOnPage(this.mat.page), 0);
    this.refreshHighlight(true);
  }

  private turn(delta: number) {
    if (this._stepMode) this.step = Math.min(Math.max(this.step + delta, 0), this.mat.itemCount - 1);
    else this.mat.setPage(this.mat.page + delta);
    this.refreshHighlight(true);
  }

  private resetToDraw() {
    this.generation++;
    this.moving = false;
    this.reanchorRequested = false;
    this.phase = 'draw';
    this._stepMode = false;
    this.selected = -1;
    this.pen = null;
    this.stroke.reset();
    this.probe.cancel();
    this.preview.hide();
    this.mat.setVisible(false);
    workspace.frameValid = false;
    workspace.notify(DRAW_TITLE, 'view', 'info', Infinity, DRAW_DETAIL);
  }

  /** Per XR frame, before the scene renders. `time` in ms. */
  update(time: number, frame: XRFrame) {
    const space = this.renderer?.xr.getReferenceSpace();
    if (!this.session || !space) return;
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    this.readHead();
    this.hands.update(frame, space);
    const leftEvent = this.pinches.left.update(this.hands.left.tracked ? this.hands.left.pinchDistance : null, dt);
    const rightEvent = this.pinches.right.update(this.hands.right.tracked ? this.hands.right.pinchDistance : null, dt);
    this.applyPrefs();

    switch (this.phase) {
      case 'draw':
        if (this.testTraceRequested) {
          this.testTraceRequested = false;
          this.runTestTrace(frame, space);
        } else if (rightEvent === 'start') this.beginStroke(this.hands.right);
        else if (leftEvent === 'start') this.beginStroke(this.hands.left);
        break;
      case 'drawing': {
        const hand = this.pen!;
        if (hand.tracked) this.stroke.add(hand.pen.x, hand.pen.y, hand.pen.z);
        this.strokeView.sync(this.stroke);
        if (this.stroke.count >= this.previewAt + PREVIEW_EVERY) this.updatePreview();
        const event = hand === this.hands.right ? rightEvent : leftEvent;
        if (event === 'end') this.finishStroke(frame, space);
        break;
      }
      case 'settling': {
        const y = this.probe.poll(frame, space, dt);
        if (y !== undefined) this.place(frame, space, y ?? this.penSurface());
        break;
      }
      case 'restoring':
        this.restoreWaited += dt;
        if (this.trackAnchor(frame, space)) {
          this.phase = 'placed';
          this.mat.setVisible(true);
          this.mat.pulse();
          uiSound.success();
          workspace.notify('Mat found', 'mat', 'ok', 2);
          workspace.flow.matPlaced();
        } else if (this.restoreWaited > RESTORE_TIMEOUT) {
          this.restoreFailed();
        }
        break;
      case 'placed':
        if (this.reanchorRequested) this.reanchor(frame, space);
        if (!this.moving) this.trackAnchor(frame, space);
        this.updateControls(dt);
        break;
    }
    if (this.phase === 'placed' && this.mat.root.visible) {
      this.mat.root.updateMatrixWorld();
      workspace.setFrame(this.mat.root.matrixWorld, this.mat.width, this.mat.depth);
    }
    this.mat.update(dt, time / 1000);
    this.strokeView.update(dt);
  }

  /** The look settings from the menus: mat colour and the labels toggle. */
  private applyPrefs() {
    if (this.prefsVersion === xrPrefs.version) return;
    this.prefsVersion = xrPrefs.version;
    this.mat.setAccent(MAT_ACCENTS[xrPrefs.matAccent]?.color ?? MAT_ACCENTS[0].color);
    this.mat.setLabelsVisible(xrPrefs.labels);
  }

  private beginStroke(hand: HandState) {
    this.pen = hand;
    this.phase = 'drawing';
    this.previewAt = 0;
    this.stroke.reset();
    this.stroke.add(hand.pen.x, hand.pen.y, hand.pen.z);
    this.strokeView.begin();
    // The preview of the mat (its size, amber or blue) is the feedback from here.
    workspace.clear();
  }

  /** The rectangle the stroke so far would make, drawn as a ghost with its size. */
  private updatePreview() {
    this.previewAt = this.stroke.count;
    const rect = fitRectangle(this.stroke.positions, this.stroke.count);
    if (!rect) return;
    const placement = orientToViewer(rect, this.head.x, this.head.z);
    const y = surfaceFromPen(medianY(this.stroke.positions, this.stroke.count), this.pen?.penRadius ?? DEFAULT_PEN_RADIUS);
    this.preview.show(placement, y, isBigEnough(placement.width, placement.depth), this.head);
  }

  /** Works out the table height under the stroke: a detected plane, else hit test, else the pen. */
  private finishStroke(frame: XRFrame, space: XRReferenceSpace) {
    this.preview.hide();
    if (this.stroke.count < MIN_STROKE_POINTS) {
      this.strokeView.fadeOut();
      this.resetToDraw();
      return;
    }
    const { x, z } = this.strokeCentre();
    const penY = medianY(this.stroke.positions, this.stroke.count);
    const plane = findSurfacePlane(frame, space, x, z, penY, this.pen?.penRadius ?? DEFAULT_PEN_RADIUS);
    if (plane !== null) {
      this.place(frame, space, plane);
      return;
    }
    if (this.session && this.probe.begin(this.session, space, x, penY, z)) {
      this.phase = 'settling';
      workspace.notify('Finding the table…', 'view', 'info', Infinity);
      return;
    }
    this.place(frame, space, this.penSurface());
  }

  /** Table height from the pen alone: its median height, one fingertip radius down. */
  private penSurface() {
    return surfaceFromPen(medianY(this.stroke.positions, this.stroke.count), this.pen?.penRadius ?? DEFAULT_PEN_RADIUS);
  }

  private runTestTrace(frame: XRFrame, space: XRReferenceSpace) {
    const e = this.headMatrix.elements;
    let fx = -e[8];
    let fz = -e[10];
    const length = Math.hypot(fx, fz) || 1;
    fx /= length;
    fz /= length;
    const cx = this.head.x + fx * 0.5;
    const cz = this.head.z + fz * 0.5;
    // The highest detected table under that point, else a seated desk 45 cm below the eyes.
    let tableY = this.head.y - 0.45;
    let found = false;
    for (const plane of detectedHorizontalPlanes(frame, space)) {
      if (plane.y < this.head.y - 0.15 && (!found || plane.y > tableY) && pointInPolygon(cx, cz, plane.polygon)) {
        tableY = plane.y;
        found = true;
      }
    }
    const penY = tableY + DEFAULT_PEN_RADIUS;
    // Corners of 60 × 40 cm, the width across the view; walk the outline every 1 cm.
    const corners = [
      [-0.3, -0.2],
      [0.3, -0.2],
      [0.3, 0.2],
      [-0.3, 0.2],
      [-0.3, -0.2],
    ];
    this.pen = null;
    this.stroke.reset();
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[k + 1];
      for (let i = 0; i < 60; i++) {
        const t = i / 60;
        const lx = ax + (bx - ax) * t; // across: along (−fz, fx)
        const lz = az + (bz - az) * t; // away: along −forward
        this.stroke.add(cx - fz * lx - fx * lz, penY, cz + fx * lx - fz * lz);
      }
    }
    this.strokeView.begin();
    this.strokeView.sync(this.stroke);
    this.finishStroke(frame, space);
  }

  private strokeCentre() {
    const p = this.stroke.positions;
    let x = 0;
    let z = 0;
    for (let i = 0; i < this.stroke.count; i++) {
      x += p[i * 3];
      z += p[i * 3 + 2];
    }
    return { x: x / this.stroke.count, z: z / this.stroke.count };
  }

  /** Fits the rectangle on the table at height y and puts the mat there. */
  private place(frame: XRFrame, space: XRReferenceSpace, y: number) {
    const p = this.stroke.positions;
    const rect = fitRectangle(p, this.stroke.count, (i) => p[i * 3 + 1] < y + STROKE_LIFT);
    this.strokeView.fadeOut();
    if (!rect) {
      this.resetToDraw();
      return;
    }
    const placement = orientToViewer(rect, this.head.x, this.head.z);
    if (!isBigEnough(placement.width, placement.depth)) {
      this.resetToDraw();
      uiSound.alert();
      workspace.notify(`Too small · ${cm(placement.width)} × ${cm(placement.depth)} cm`, 'view', 'warn', Infinity, 'Trace at least 25 × 20 cm');
      return;
    }
    this.showMat(placement, y);
    this.anchorMat(frame, space, placement.cx, y, placement.cz, placement.yaw);
    this.mat.pulse();
    uiSound.success();
    workspace.notify('Mat placed', 'mat', 'ok', 2.5);
    workspace.flow.matPlaced();
  }

  private showMat(placement: MatPlacement, y: number) {
    this.mat.build(placement.width, placement.depth);
    this.mat.setPose(placement.cx, y, placement.cz, placement.yaw);
    this.mat.setVisible(true);
    this.phase = 'placed';
    this.highlightKey = '';
  }

  /** Per frame while the mat is down: touching items, the palm-up toggle, highlights, the opacity fade. */
  private updateControls(dt: number) {
    // The palm without the wound: turning the wound's palm up is someone
    // looking at the wound, and must never hide the controls.
    const freeSide = xrPrefs.hand === 'left' ? 'right' : 'left';
    const free = this.hands[freeSide];
    const busy = !free.tracked || free.pinchDistance < 0.03 || !this.hands[xrPrefs.hand].tracked;
    if (this.palmUp.update(busy ? null : free.palmNormal.y, dt)) {
      workspace.panelsHidden = !workspace.panelsHidden;
      workspace.notify(workspace.panelsHidden ? 'Menus hidden' : 'Menus shown', 'mat', 'info', 2);
    }
    this.pickItems();
    this.refreshHighlight(false);
    if (this.opacityShown !== this.opacityTarget) {
      this.opacityShown += (this.opacityTarget - this.opacityShown) * (1 - Math.exp(-OPACITY_RATE * dt));
      if (Math.abs(this.opacityShown - this.opacityTarget) < 0.003) this.opacityShown = this.opacityTarget;
      this.mat.setOpacity(this.opacityShown);
    }
  }

  /**
   * Touching an item with a straight index fingertip selects it (shows its
   * purpose); touching it again lets go. A fist never selects, so carrying
   * the mat can't pick things by accident.
   */
  private pickItems() {
    const phase = workspace.flow.phase;
    if (phase !== 'browse' && phase !== 'work') return;
    this.mat.root.updateMatrixWorld();
    inverse.copy(this.mat.root.matrixWorld).invert();
    for (const hand of [this.hands.left, this.hands.right]) {
      const side = hand.handedness;
      if (!hand.tracked || !hand.indexStraight || hand.pinchDistance < 0.03 || this.moving) {
        this.selectArmed[side] = false;
        continue;
      }
      local.copy(hand.indexTip).applyMatrix4(inverse);
      const height = local.y - hand.indexTipRadius;
      if (height > SELECT_LIFT) {
        this.selectArmed[side] = true;
        continue;
      }
      if (!this.selectArmed[side] || height > SELECT_TOUCH || height < -0.03) continue;
      const hit = this.mat.hitSlot(local.x, local.z);
      if (hit < 0) continue;
      this.selectArmed[side] = false;
      this.selected = this.selected === hit ? -1 : hit;
      if (this._stepMode && this.selected >= 0) this.step = this.selected;
      uiSound.press();
    }
  }

  /**
   * What's highlighted: in step mode the current step (others dimmed);
   * while working, the items the current build stage uses; else the
   * selected item.
   */
  private refreshHighlight(force: boolean) {
    const stage = workspace.flow.phase === 'work' ? (woundLink.flow?.stage ?? 0) : 0;
    const key = `${this._stepMode}:${this.step}:${stage}:${this.selected}`;
    if (!force && key === this.highlightKey) return;
    this.highlightKey = key;
    if (this._stepMode) this.mat.setHighlight([this.step], true);
    else if (stage > 0 && this.kit) {
      const used: number[] = [];
      this.kit.items.forEach((item, i) => item.stages.includes(stage) && used.push(i));
      if (this.selected >= 0 && !used.includes(this.selected)) used.push(this.selected);
      this.mat.setHighlight(used, false);
    } else this.mat.setHighlight(this.selected >= 0 ? [this.selected] : [], false);
  }

  private firstItemOnPage(page: number) {
    for (let i = 0; i < this.mat.itemCount; i++) if (this.mat.pageOf(i) === page) return i;
    return -1;
  }

  /** Locks the mat to the table with an anchor (kept across sessions when supported). */
  private anchorMat(frame: XRFrame, space: XRReferenceSpace, x: number, y: number, z: number, yaw: number) {
    if (!frame.createAnchor) return; // No anchors: the mat stays at its reference-space pose.
    const generation = this.generation;
    const half = yaw / 2;
    const pose = new XRRigidTransform({ x, y, z, w: 1 }, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    const request = frame.createAnchor(pose, space);
    if (!request) return;
    request.then(
      (anchor) => {
        if (generation !== this.generation || !this.session) {
          anchor.delete();
          return;
        }
        this.anchor = anchor;
        this.persist(anchor, this.mat.width, this.mat.depth);
      },
      (err: unknown) => console.warn('Anchor not created; the mat keeps its first pose.', err),
    );
  }

  private persist(anchor: XRAnchor, width: number, depth: number) {
    if (!anchor.requestPersistentHandle) return;
    const generation = this.generation;
    const previous = this.savedHandle;
    anchor.requestPersistentHandle().then(
      (handle) => {
        if (generation !== this.generation) return;
        if (previous && previous !== handle) void this.session?.deletePersistentAnchor?.(previous).catch(() => {});
        this.savedHandle = handle;
        const saved = { handle, width, depth, savedAt: Date.now() };
        saveMat(saved);
        this.events.onSavedMatChange?.(saved);
      },
      (err: unknown) => console.warn('Mat anchor not saved for next time.', err),
    );
  }

  private restore(session: XRSession, saved: SavedMat) {
    if (!session.restorePersistentAnchor) {
      this.restoreFailed();
      return;
    }
    const generation = this.generation;
    this.phase = 'restoring';
    this.restoreWaited = 0;
    this.savedHandle = saved.handle;
    this.mat.build(saved.width, saved.depth);
    workspace.notify('Finding your last mat…', 'view', 'info', Infinity, 'Look at where you left it');
    session.restorePersistentAnchor(saved.handle).then(
      (anchor) => {
        if (generation !== this.generation) anchor.delete();
        else this.anchor = anchor;
      },
      (err: unknown) => {
        console.warn('Saved mat not found.', err);
        if (generation === this.generation) this.restoreFailed();
      },
    );
  }

  private restoreFailed() {
    this.anchor?.delete();
    this.anchor = null;
    this.resetToDraw();
    workspace.notify('Last mat not found', 'view', 'warn', Infinity, 'Trace a new one on your table');
  }

  /**
   * After the mat is let go: settle it flush onto a detected table if it's
   * within a few centimetres of one (otherwise it stays exactly where it was
   * let go), and anchor it there in place of the old anchor.
   */
  private reanchor(frame: XRFrame, space: XRReferenceSpace) {
    this.reanchorRequested = false;
    const e = this.mat.root.matrix.elements;
    const x = e[12];
    const z = e[14];
    const yaw = Math.atan2(e[8], e[10]);
    let y = e[13];
    let best = RETABLE_RANGE;
    for (const plane of detectedHorizontalPlanes(frame, space)) {
      const dy = Math.abs(plane.y - e[13]);
      if (dy < best && pointInPolygon(x, z, plane.polygon)) {
        best = dy;
        y = plane.y;
      }
    }
    this.mat.setPose(x, y, z, yaw);
    this.anchor?.delete();
    this.anchor = null;
    this.anchorMat(frame, space, x, y, z, yaw);
  }

  /** The whole mat: put a fist on it to carry it (up and down too) and turn it. */
  private matGrabbable(): Grabbable {
    const bounds = new THREE.Box3();
    return {
      bounds,
      style: 'table',
      canGrab: () => {
        if (this.phase !== 'placed' || !this.mat.root.visible) return false;
        // A hand on the mat, up to a fist's height above it.
        bounds.min.set(-this.mat.width / 2, -0.03, -this.mat.depth / 2);
        bounds.max.set(this.mat.width / 2, 0.15, this.mat.depth / 2);
        return true;
      },
      worldMatrix: (out) => {
        this.mat.root.updateMatrixWorld();
        out.copy(this.mat.root.matrixWorld);
      },
      begin: () => {
        this.moving = true;
      },
      move: (world) => this.mat.setMatrix(world.elements),
      end: () => {
        this.moving = false;
        this.reanchorRequested = true;
        uiSound.release();
      },
      setGrabState: (state: GrabState) => this.mat.setGrabState(state),
    };
  }

  /** Moves the mat to its anchor's latest pose. Returns whether the anchor is tracked. */
  private trackAnchor(frame: XRFrame, space: XRReferenceSpace): boolean {
    const anchor = this.anchor;
    if (!anchor) return false;
    if (frame.trackedAnchors && !frame.trackedAnchors.has(anchor)) return false;
    if (frame.fillPoses) {
      this.anchorSpaces[0] = anchor.anchorSpace;
      if (!frame.fillPoses(this.anchorSpaces, space, this.anchorPose)) return false;
      this.mat.setMatrix(this.anchorPose);
      return true;
    }
    const pose = frame.getPose(anchor.anchorSpace, space);
    if (!pose) return false;
    this.mat.setMatrix(pose.transform.matrix);
    return true;
  }

  /** Eye midpoint and head orientation, from the per-eye cameras three.js updated for this frame. */
  private readHead() {
    if (!this.renderer) return;
    const cameras: readonly THREE.Camera[] = this.renderer.xr.getCamera().cameras;
    if (cameras.length === 0) return;
    const e = cameras[0].matrix.elements;
    this.headMatrix.copy(cameras[0].matrix);
    this.head.set(e[12], e[13], e[14]);
    if (cameras.length > 1) {
      const r = cameras[1].matrix.elements;
      this.head.set((e[12] + r[12]) / 2, (e[13] + r[13]) / 2, (e[14] + r[14]) / 2);
    }
  }
}
