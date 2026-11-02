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

/** One message for the status board in front of the user. */
export interface WorkspaceMessage {
  id: number;
  title: string;
  detail: string;
  tone: MessageTone;
  /** How long it shows (s), or Infinity until replaced or dismissed. */
  seconds: number;
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
 * the flow, where the workspace is, the status message and the mat.
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
  /** Where the user put Buddy, in frame space (null: its default spot). */
  buddyLocal: null as THREE.Vector3 | null,
  /** The material mat's controls while it's running. */
  mat: null as MatControls | null,
  message: { id: 0, title: '', detail: '', tone: 'info', seconds: 0 } as WorkspaceMessage,

  /** Shows a message on the status board. Returns its id (for `dismiss`). */
  notify(title: string, detail = '', tone: MessageTone = 'info', seconds = 4): number {
    const m = this.message;
    m.id++;
    m.title = title;
    m.detail = detail;
    m.tone = tone;
    m.seconds = seconds;
    return m.id;
  },

  /** Hides the message if it's still the one with this id. */
  dismiss(id: number) {
    if (this.message.id === id) this.notify('', '', 'info', 0);
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
    this.buddyLocal = null;
    this.notify('', '', 'info', 0);
  },
};
