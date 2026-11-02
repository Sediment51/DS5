import * as THREE from 'three';

/**
 * The headset workspace's phases, introduced one after another so a first
 * visit is never everything at once:
 *
 *   setup  — only the instruction: trace your material mat on the table.
 *   intro  — the mat, and Buddy in the middle of the view introducing itself.
 *   browse — the mat, Buddy parked to its left, the menu and its two chips.
 *   work   — all of that plus the wound on your hand and the step flow.
 *
 * Without a mat (the VR fallback, or a kit that didn't load) it starts at intro.
 */
export type WorkspacePhase = 'setup' | 'intro' | 'browse' | 'work';

export class WorkspaceFlow {
  phase: WorkspacePhase = 'setup';
  /** Bumps on every phase change. */
  version = 0;
  /** Seconds in the current phase. */
  time = 0;
  /** Buddy has introduced itself this session (a redrawn mat skips the intro). */
  introduced = false;

  /** A session starts: draw the mat first, or go straight to the intro without one. */
  start(withMat: boolean) {
    this.introduced = false;
    this.go(withMat ? 'setup' : 'intro');
  }

  /** The mat is down (drawn, or restored from last time). */
  matPlaced() {
    if (this.phase === 'setup') this.go(this.introduced ? 'browse' : 'intro');
  }

  /** The mat was removed to draw a new one. */
  matRemoved() {
    this.go('setup');
  }

  introDone() {
    if (this.phase !== 'intro') return;
    this.introduced = true;
    this.go('browse');
  }

  startWork() {
    if (this.phase === 'browse') this.go('work');
  }

  stopWork() {
    if (this.phase === 'work') this.go('browse');
  }

  update(dt: number) {
    this.time += dt;
  }

  private go(phase: WorkspacePhase) {
    if (phase === this.phase && this.version > 0) return;
    this.phase = phase;
    this.time = 0;
    this.version++;
  }
}

export type MessageTone = 'info' | 'ok' | 'warn';

/**
 * Where a cue appears: on the thing it's about (the mat, the wound hand), or
 * just below the view when there's nothing to put it on yet.
 */
export type CueAnchor = 'view' | 'mat' | 'hand';

/**
 * One cue: a few glowing words with an icon (no card), shown at what it's
 * about. Most feedback is visual on the objects themselves; a cue names it.
 */
export interface WorkspaceMessage {
  id: number;
  /** A few words: "Mat placed", "Step 2 done". */
  title: string;
  /** Only when the picture isn't enough: one short line of how. */
  detail: string;
  tone: MessageTone;
  /** How long it shows (s), or Infinity until replaced or dismissed. */
  seconds: number;
  at: CueAnchor;
}

/** What the menus need from the material mat (MatSystem), without importing it. */
export interface MatControls {
  readonly itemCount: number;
  readonly stepMode: boolean;
  /** "Step 3 of 9 · Scar wax", "All 9 items · …". */
  readonly status: string;
  readonly canPrev: boolean;
  readonly canNext: boolean;
  prev(): void;
  next(): void;
  toggleStep(): void;
  redraw(): void;
  /** Overlay opacity 0..1 (done: the change is final, so save it). */
  readonly opacity: number;
  setOpacity(value: number, done: boolean): void;
}

/**
 * Shared, per-frame workspace state (read every frame; no React state):
 * the flow, where the workspace is, the current cue and the mat.
 */
export const workspace = {
  flow: new WorkspaceFlow(),
  /**
   * The workspace frame in world space: the mat's pose (origin at its centre,
   * +X to the user's right, +Y up, +Z towards the user); in VR a fixed frame
   * in front of the user. Panels and Buddy are placed relative to it.
   */
  frame: new THREE.Matrix4(),
  frameValid: false,
  /** The mat's size (m), or the VR frame's. */
  width: 0.5,
  depth: 0.35,
  /** Palm-up toggle: all panels hidden. */
  panelsHidden: false,
  /**
   * Where the user put Buddy, in world space (null: its spot beside the mat).
   * Once moved it stays there, even when the mat is moved.
   */
  buddyWorld: null as THREE.Vector3 | null,
  /** The wound hand's palm, last seen (for cues about the hand). */
  handPoint: new THREE.Vector3(),
  handSeen: false,
  /** The material mat's controls while it's running. */
  mat: null as MatControls | null,
  message: { id: 0, title: '', detail: '', tone: 'info', seconds: 0, at: 'view' } as WorkspaceMessage,

  /**
   * Shows a cue: a few words at what it's about. Returns its id (for `dismiss`).
   * @param detail one short line, only when it's needed to know what to do.
   */
  notify(title: string, at: CueAnchor = 'view', tone: MessageTone = 'info', seconds = 2.5, detail = ''): number {
    const m = this.message;
    m.id++;
    m.title = title;
    m.detail = detail;
    m.tone = tone;
    m.seconds = seconds;
    m.at = at;
    return m.id;
  },

  /** Hides the cue if it's still the one with this id. */
  dismiss(id: number) {
    if (this.message.id === id) this.clear();
  },

  /** Hides any cue. */
  clear() {
    this.notify('', 'view', 'info', 0);
  },

  setFrame(matrix: THREE.Matrix4 | ArrayLike<number>, width: number, depth: number) {
    if (matrix instanceof THREE.Matrix4) this.frame.copy(matrix);
    else this.frame.fromArray(matrix as number[]);
    this.width = width;
    this.depth = depth;
    this.frameValid = true;
  },

  /** A session ended. */
  reset() {
    this.frameValid = false;
    this.panelsHidden = false;
    this.buddyWorld = null;
    this.handSeen = false;
    this.clear();
  },
};
