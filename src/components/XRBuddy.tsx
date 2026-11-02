import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BUDDY_COLOR,
  BUDDY_SCALE,
  BUDDY_SIZE_CM,
  GROWTH,
  GROWTH_TARGETS,
  AWAY_RELOCK_DEG,
  NO_BLINK,
  buddyTarget,
  expressionOffset,
  growthForStage,
  springStep,
  type Expression,
} from '../lib/buddy';
import { BuddyMotion, type MotionInput } from '../lib/buddyMotion';
import type { GrabSystem } from '../lib/grab';
import { mentor } from '../lib/mentorAnalysis';
import { uiSound } from '../lib/uiSound';
import { STAGE_COUNT, STAGE_LABELS, woundLink } from '../lib/woundSteps';
import { workspace, type WorkspacePhase } from '../lib/workspaceFlow';
import { xrPrefs } from '../lib/xrPrefs';
import { SpeechBubble } from '../lib/xrSpeechBubble';
import { buddyHome } from './XRMenus';

const BUDDY_URL = `${import.meta.env.BASE_URL}models/buddy_character.glb`;

/** What Buddy says on its own occasions (the stage instructions are STAGE_LABELS). */
export const BUDDY_LINES = {
  hello: 'Hi! I’m Buddy, your mentor. Your mat’s ready, and those are your materials. Tap Start working when you’d like to begin.',
  ready: 'I’ll wait over here. Tap Start working when you’re ready.',
  work: 'Let’s begin! Pinch near the wound with your other hand to go step by step.',
  paused: 'Paused. Tap Start working to carry on.',
  closer: 'Pinch a little closer to the wound.',
  done: 'You did it! That’s the full wound.',
  checking: 'Let me have a look at your work…',
};

/** Idle_Float's weight: the only animation that always plays, kept gentle. */
const IDLE_WEIGHT = 0.6;
/** While flying, Idle_Float gives way to Excited (arm flapping), up to this weight at top speed. */
const FLAP_WEIGHT = 0.7;
/** Frame time is clamped to this (s), so motion stays frame-rate independent without leaps. */
const MAX_DT = 0.05;
/** Cross-fades between clips (s). */
const FADE = 0.3;
/** Blinks: this long (s), every 2.2–5.2 s; talking flips the mouth every TALK_FLIP s. */
const BLINK_SECONDS = 0.12;
const TALK_FLIP = 0.14;
/** The flower grows a stage over this long (s). */
const GROW_SECONDS = 1;
/** A passing line ("closer") stays this long after typing (s), then the current instruction returns. */
const PASSING_SECONDS = 3.5;
/** The bubble's gap beside Buddy (m). */
const BUBBLE_GAP = 0.012;
const ENV_INTENSITY = 0.35;
/** The introduction: in the middle of the view this far ahead (m) and this far below the eyes (m)… */
const INTRO_AHEAD = 0.55;
const INTRO_BELOW = 0.08;
/** …and once its line is typed out it waits this long (s) before moving aside (or "Got it" moves it at once). */
const INTRO_HOLD = 4;
/** Carried with a fist, it grows a little so you can see you've got it. */
const HELD_SCALE = 1.12;

type Clip = 'Idle_Float' | 'Wave' | 'Happy_Bounce' | 'Excited' | 'Sleepy' | 'Nod_Yes' | 'Shake_No';

interface BuddyRig {
  root: THREE.Object3D;
  /** The "Buddy" node: squash and stretch go here (the clips move bones only). */
  body: THREE.Object3D;
  bodyScale: THREE.Vector3;
  /** Excited, looping, for flapping while flying (its own action: the Excited occasion uses the other). */
  flap: THREE.AnimationAction | null;
  mixer: THREE.AnimationMixer;
  actions: Map<Clip, THREE.AnimationAction>;
  face: THREE.MeshStandardMaterial | null;
  sprouts: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
}

function makeRig(gltf: GLTF): BuddyRig {
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<Clip, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name as Clip, mixer.clipAction(clip));
  let face: THREE.MeshStandardMaterial | null = null;
  const sprouts: THREE.Mesh[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.name === 'MAT_Buddy_Face') {
      // A decal just above the body: drawn after it, without writing depth. Its own copy of the atlas, to move per expression.
      face = material;
      material.depthWrite = false;
      if (material.map) {
        material.map = material.map.clone();
        material.map.needsUpdate = true;
      }
      mesh.renderOrder = 6;
    } else {
      mesh.renderOrder = 5;
      if (!materials.includes(material)) materials.push(material);
      if (material.name === 'MAT_Buddy_Body') material.color.set(BUDDY_COLOR);
    }
    if (mesh.morphTargetDictionary && GROWTH_TARGETS.every((name) => name in mesh.morphTargetDictionary!)) sprouts.push(mesh);
  });
  const body = root.getObjectByName('Buddy') ?? root;
  const excited = gltf.animations.find((clip) => clip.name === 'Excited');
  const flap = excited ? mixer.clipAction(excited.clone()) : null;
  if (flap) {
    flap.setLoop(THREE.LoopRepeat, Infinity);
    flap.weight = 0;
    flap.play();
  }
  return { root, body, bodyScale: body.scale.clone(), flap, mixer, actions, face, sprouts, materials };
}

/**
 * Buddy, the mentor, in the headset. It appears once the mat is down, in the
 * middle of the view, introduces itself, then flies to its spot on the left
 * of the mat and stays there, out of the way of the hand and the mat (carry
 * it with a fist to put it anywhere else). It speaks only when there's
 * something to say: a new phase, each step of the flow, a near miss, and
 * feedback on your work. Calm at rest (a gentle float, no flourishes). Reads
 * the wound through `woundLink`; never stops the wound: any error hides
 * Buddy instead.
 */
export function XRBuddy({ active, grab }: { active: boolean; grab: GrabSystem }) {
  const [rig, setRig] = useState<BuddyRig | null>(null);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    let cancelled = false;
    new GLTFLoader()
      .loadAsync(BUDDY_URL)
      .then((gltf) => {
        if (!cancelled) setRig(makeRig(gltf));
      })
      .catch((error) => console.error('Could not load Buddy', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const holder = useMemo(() => {
    const group = new THREE.Group();
    group.visible = false;
    return group;
  }, []);
  const bubble = useMemo(() => new SpeechBubble(STAGE_COUNT), []);
  useEffect(() => () => bubble.dispose(), [bubble]);

  // Soft studio reflections (the room's light alone leaves Buddy dull), made once when the scene mounts, before any session.
  const envMap = useRef<THREE.Texture | null>(null);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const texture = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    envMap.current = texture;
    return () => texture.dispose();
  }, [gl]);

  useEffect(() => {
    if (!rig) return;
    for (const material of rig.materials) {
      material.envMap = envMap.current;
      material.envMapIntensity = ENV_INTENSITY;
      material.needsUpdate = true;
    }
    rig.root.scale.setScalar(BUDDY_SCALE);
    holder.add(rig.root);
    const idle = rig.actions.get('Idle_Float');
    if (idle) {
      idle.weight = IDLE_WEIGHT;
      idle.play();
    }
    return () => {
      holder.remove(rig.root);
      rig.mixer.stopAllAction();
    };
  }, [rig, holder]);

  const state = useMemo(
    () => ({
      broken: false,
      started: false,
      steps: 0,
      misses: 0,
      flowVersion: -1,
      phase: 'setup' as WorkspacePhase,
      mentorVersion: -1,
      // Clips: the base loop, the one-shot playing and at most one waiting.
      base: 'Idle_Float' as Clip,
      current: null as THREE.AnimationAction | null,
      queued: null as Clip | null,
      queuedRepeats: 1,
      // Face.
      expression: '' as Expression | '',
      eventFace: 'happy' as Expression,
      eventFor: 0,
      typingFace: null as Expression | null,
      talkClock: 0,
      blinkIn: 3,
      blinkFor: 0,
      // Speech: the standing line (with its dots) and a passing one's timer.
      line: '',
      lineDots: null as number | null,
      passingFor: 0,
      // Speech waiting for Buddy to arrive.
      pending: false,
      pendingLine: '',
      pendingDots: null as number | null,
      pendingFace: null as Expression | null,
      pendingPassing: false,
      // A wave when it lands for the introduction.
      waveOnLanding: false,
      // The introduction: its spot, and how long its line has been on show.
      introSpot: new THREE.Vector3(),
      introShown: 0,
      // Growth.
      growth: [1, 1, 1],
      // Carried with a fist.
      carried: false,
      carryPos: new THREE.Vector3(),
      grabState: 'none' as 'none' | 'hover' | 'held',
      // Without a workspace: a spot off to the side, locked until it would leave the view.
      awayLocked: false,
      awayPoint: new THREE.Vector3(),
      awaySide: new THREE.Vector3(),
      // Motion.
      motion: new BuddyMotion(),
      entered: false,
      input: {
        eye: new THREE.Vector3(),
        gaze: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        home: new THREE.Vector3(),
        wound: null,
        watchWound: false,
        facingViewer: false,
        expressive: false,
        idle: false,
      } as MotionInput,
      headTurn: new THREE.Quaternion(),
      scratch: new THREE.Vector3(),
      bubbleSide: -1 as 1 | -1,
      bubbleAt: new THREE.Vector3(),
      bubbleGoal: new THREE.Vector3(),
      bubbleVel: new THREE.Vector3(),
      bubblePlaced: false,
      offset: new THREE.Vector2(),
    }),
    [],
  );
  state.motion.calm = true;

  // A one-shot finished: back to the base loop, then the queued one if any.
  useEffect(() => {
    if (!rig) return;
    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== state.current) return;
      state.current.fadeOut(FADE);
      state.current = null;
      fadeInBase(rig);
      if (state.queued) {
        const next = state.queued;
        state.queued = null;
        startClip(rig, next, state.queuedRepeats);
      }
    };
    rig.mixer.addEventListener('finished', onFinished);
    return () => rig.mixer.removeEventListener('finished', onFinished);
  }, [rig, state]);

  // Carry Buddy with a fist; where you let go becomes its spot (relative to the mat).
  useEffect(
    () =>
      grab.add({
        bounds: new THREE.Box3(new THREE.Vector3(-0.05, -0.05, -0.05), new THREE.Vector3(0.05, 0.05, 0.05)),
        style: 'panel',
        canGrab: () => holder.visible && !state.broken,
        worldMatrix: (out) => {
          holder.updateWorldMatrix(true, false);
          out.copy(holder.matrixWorld);
        },
        begin: () => {
          state.carried = true;
        },
        move: (world) => {
          state.carryPos.setFromMatrixPosition(world);
          state.motion.place(state.carryPos);
        },
        end: () => {
          // It stays exactly here (in the room), even if the mat is moved later.
          state.carried = false;
          workspace.buddyWorld = state.carryPos.clone();
          uiSound.release();
        },
        setGrabState: (grabState) => {
          state.grabState = grabState;
        },
      }),
    [grab, holder, state],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __buddy?: unknown }).__buddy = { rig, state, holder, bubble };
  }, [rig, state, holder, bubble]);

  function fadeInBase(r: BuddyRig) {
    const base = r.actions.get(state.base);
    if (!base) return;
    base.reset();
    base.weight = state.base === 'Idle_Float' ? IDLE_WEIGHT : 1;
    base.fadeIn(FADE).play();
  }

  function startClip(r: BuddyRig, name: Clip, repeats: number) {
    const action = r.actions.get(name);
    if (!action) return;
    action.reset();
    action.setLoop(repeats > 1 ? THREE.LoopRepeat : THREE.LoopOnce, repeats);
    action.clampWhenFinished = true;
    action.weight = 1;
    action.fadeIn(FADE).play();
    r.actions.get(state.base)?.fadeOut(FADE);
    state.current = action;
  }

  /** Plays a one-shot now, or after the one playing (only the newest waits). */
  function play(r: BuddyRig, name: Clip, repeats = 1) {
    if (state.current) {
      state.queued = name;
      state.queuedRepeats = repeats;
      return;
    }
    startClip(r, name, repeats);
  }

  function react(face: Expression, seconds: number) {
    state.eventFace = face;
    state.eventFor = seconds;
  }

  /** The standing line (typed out), shown until the next one; typing waits until Buddy has arrived. */
  function say(line: string, dots: number | null, typingFace: Expression | null) {
    state.line = line;
    state.lineDots = dots;
    queueSpeech(line, dots, typingFace, false);
  }

  /** A passing line: typed out, then the standing line returns. */
  function sayPassing(line: string) {
    queueSpeech(line, null, null, true);
  }

  function queueSpeech(line: string, dots: number | null, face: Expression | null, passing: boolean) {
    state.pending = true;
    state.pendingLine = line;
    state.pendingDots = dots;
    state.pendingFace = face;
    state.pendingPassing = passing;
    flushSpeech();
  }

  function flushSpeech() {
    if (!state.pending || !state.motion.speechReady) return;
    state.pending = false;
    state.typingFace = state.pendingFace;
    state.passingFor = state.pendingPassing ? PASSING_SECONDS : 0;
    bubble.say(state.pendingLine, state.pendingDots);
  }

  useFrame((_, delta) => {
    if (state.broken) return;
    try {
      frame(delta);
    } catch (error) {
      state.broken = true;
      holder.visible = false;
      bubble.group.visible = false;
      console.error('Buddy stopped', error);
    }
  });

  /** Without a workspace: off to the side, at a distance, staying put until it would leave the view. */
  function awaySpot() {
    const input = state.input;
    if (state.awayLocked) {
      state.scratch.subVectors(state.awayPoint, input.eye);
      const off = THREE.MathUtils.radToDeg(state.scratch.angleTo(input.gaze));
      if (off <= AWAY_RELOCK_DEG) return state.awayPoint;
    }
    state.awaySide.copy(input.right).negate();
    buddyTarget(state.awayPoint, input.eye, input.gaze, null, state.awaySide);
    state.awayLocked = true;
    return state.awayPoint;
  }

  /** A new phase of the workspace: what Buddy does and says about it. */
  function enterPhase(r: BuddyRig, phase: WorkspacePhase, from: WorkspacePhase) {
    const input = state.input;
    const flow = woundLink.flow;
    if (flow) {
      state.steps = flow.steps;
      state.misses = flow.misses;
    }
    if (phase === 'setup') {
      bubble.clear();
      state.line = '';
      state.entered = false;
      return;
    }
    if (phase === 'intro') {
      // In the middle of the view, a little below the eyes.
      state.scratch.copy(input.gaze).setY(0);
      if (state.scratch.lengthSq() < 1e-6) state.scratch.set(0, 0, -1);
      state.scratch.normalize();
      state.introSpot.copy(input.eye).addScaledVector(state.scratch, INTRO_AHEAD);
      state.introSpot.y -= INTRO_BELOW;
      state.introShown = 0;
      react('happy', 2.5);
      if (state.motion.travelling || !state.entered) state.waveOnLanding = true;
      else play(r, 'Wave');
      say(BUDDY_LINES.hello, null, null);
      return;
    }
    if (phase === 'browse') {
      say(from === 'work' ? BUDDY_LINES.paused : BUDDY_LINES.ready, null, null);
      return;
    }
    // work
    if (!state.started) {
      state.started = true;
      play(r, 'Excited');
      react('excited', 0.7);
    } else play(r, 'Nod_Yes');
    say(BUDDY_LINES.work, null, 'determined');
  }

  function frame(delta: number) {
    const r = rig;
    const phase = workspace.flow.phase;
    holder.visible = !!r && active && gl.xr.isPresenting && phase !== 'setup' && xrPrefs.buddy;
    if (!r || !holder.visible) {
      bubble.setOpacity(0);
      if (phase === 'setup') state.entered = false;
      return;
    }
    const dt = Math.min(delta, MAX_DT);
    const link = woundLink;
    const flow = link.flow;
    const motion = state.motion;
    const input = state.input;
    const working = phase === 'work';

    // The head.
    const head = gl.xr.getCamera();
    head.getWorldPosition(input.eye);
    input.gaze.set(0, 0, -1).applyQuaternion(head.getWorldQuaternion(state.headTurn));
    input.right.setFromMatrixColumn(head.matrixWorld, 0).normalize();
    input.up.setFromMatrixColumn(head.matrixWorld, 1).normalize();

    // The workspace's phase.
    if (state.flowVersion !== workspace.flow.version) {
      state.flowVersion = workspace.flow.version;
      const from = state.phase;
      state.phase = phase;
      enterPhase(r, phase, from);
    }

    // Home: the middle of the view for the introduction; then its spot left of the mat (or where it was put).
    if (state.carried) input.home.copy(state.carryPos);
    else if (phase === 'intro') input.home.copy(state.introSpot);
    else if (workspace.frameValid || workspace.buddyWorld) buddyHome(input.home);
    else input.home.copy(awaySpot());
    input.wound = working && link.placed ? link.point : null;
    input.watchWound = working && link.otherInRange;
    input.facingViewer = bubble.hasMessage;
    // Any expression faces the viewer: a reaction, talking, an occasion's clip, or curiosity at a coming pinch.
    input.expressive = state.eventFor > 0 || (bubble.typing && bubble.hasMessage) || !!state.current || input.watchWound;
    input.idle = false;
    if (!state.entered) {
      // Fly in from the left of the view.
      state.entered = true;
      motion.enter(input, -1);
    }

    // The introduction moves aside by itself once it's been read.
    if (phase === 'intro' && !bubble.typing && !state.pending && bubble.hasMessage && !motion.travelling) {
      state.introShown += dt;
      if (state.introShown > INTRO_HOLD) workspace.flow.introDone();
    }

    // The step flow's occasions (only while working).
    if (flow && working && flow.steps !== state.steps) {
      state.steps = flow.steps;
      const stage = flow.stage;
      if (stage === 0) {
        react('love', 2.5);
        play(r, 'Happy_Bounce', 2);
        say(BUDDY_LINES.done, null, null);
      } else {
        // A nod where it is: it never comes over to the hand while you work.
        play(r, 'Nod_Yes');
        say(STAGE_LABELS[stage], stage, 'determined');
      }
    }
    if (flow && working && flow.misses !== state.misses) {
      state.misses = flow.misses;
      play(r, 'Shake_No');
      react('confused', 2);
      motion.wobble();
      sayPassing(BUDDY_LINES.closer);
    }

    // Feedback on your work.
    if (state.mentorVersion !== mentor.version) {
      state.mentorVersion = mentor.version;
      if (mentor.status === 'processing') {
        react('thinking', 60);
        say(BUDDY_LINES.checking, null, 'thinking');
      } else if (mentor.status === 'done') {
        react('happy', 2);
        play(r, 'Nod_Yes');
        say(mentor.text, null, 'cheerful');
      } else if (mentor.status === 'error') {
        react('confused', 2);
        say(mentor.text, null, null);
      }
    }

    // Move.
    const event = motion.update(dt, input);
    if (event === 'arrived' && state.waveOnLanding) {
      state.waveOnLanding = false;
      play(r, 'Wave');
    }
    flushSpeech();
    holder.position.copy(motion.position);
    holder.quaternion.copy(motion.quaternion);
    holder.scale.setScalar(state.grabState === 'none' ? 1 : HELD_SCALE);
    r.body.scale.copy(r.bodyScale).multiply(motion.stretch);

    // Flapping while flying: Idle_Float gives way to Excited with speed (not over an occasion's clip).
    const flap = state.current ? 0 : FLAP_WEIGHT * motion.speed01;
    if (r.flap) r.flap.weight = flap;
    const idle = r.actions.get('Idle_Float');
    if (idle && state.base === 'Idle_Float') idle.weight = IDLE_WEIGHT * (1 - flap / FLAP_WEIGHT * 0.8);

    // The flower: the step flow's progress.
    const goal = GROWTH[growthForStage(flow?.stage ?? 0, state.started)];
    const k = dt / GROW_SECONDS;
    for (let i = 0; i < 3; i++) state.growth[i] += THREE.MathUtils.clamp(goal[i] - state.growth[i], -k, k);
    for (const mesh of r.sprouts) {
      for (let i = 0; i < 3; i++) mesh.morphTargetInfluences![mesh.morphTargetDictionary![GROWTH_TARGETS[i]]] = state.growth[i];
    }

    // Speech: a passing line gives way to the standing one.
    bubble.update(dt);
    if (state.passingFor > 0 && !bubble.typing) {
      state.passingFor -= dt;
      if (state.passingFor <= 0) bubble.say(state.line, state.lineDots, true);
    }
    const talking = bubble.typing && bubble.hasMessage;

    // The face: a reaction, else the line's face while it types, else curious near a pinch, else happy.
    state.eventFor -= dt;
    if (mentor.status !== 'processing' && state.eventFace === 'thinking') state.eventFor = Math.min(state.eventFor, 0);
    let face: Expression =
      state.eventFor > 0 ? state.eventFace : talking && state.typingFace ? state.typingFace : input.watchWound ? 'curious' : 'happy';
    state.talkClock = talking ? state.talkClock + dt : 0;
    if (talking && Math.floor(state.talkClock / TALK_FLIP) % 2 === 1) face = 'talk';
    state.blinkIn -= dt;
    if (state.blinkIn <= 0) {
      state.blinkIn = 2.2 + Math.random() * 3;
      if (!NO_BLINK.has(face) && face !== 'talk') state.blinkFor = BLINK_SECONDS;
    }
    if (state.blinkFor > 0) {
      state.blinkFor -= dt;
      if (!NO_BLINK.has(face) && face !== 'talk') face = 'blink';
    }
    if (r.face?.map && face !== state.expression) {
      state.expression = face;
      r.face.map.offset.copy(expressionOffset(face, state.offset));
    }

    r.mixer.update(dt);

    // The bubble: beside Buddy on the side away from the mat, following with a little lag, upright and turned to the viewer.
    const speaking = bubble.hasMessage;
    bubble.setOpacity(speaking ? motion.bubbleOpacity : 0);
    if (!speaking) {
      state.bubblePlaced = false;
      return;
    }
    if (phase !== 'intro' && workspace.frameValid) {
      state.scratch.setFromMatrixPosition(workspace.frame);
      const across = state.scratch.subVectors(holder.position, state.scratch).dot(input.right);
      state.bubbleSide = across >= 0 ? 1 : -1;
    } else state.bubbleSide = 1;
    const half = BUDDY_SIZE_CM / 200;
    state.bubbleGoal
      .copy(holder.position)
      .addScaledVector(input.right, state.bubbleSide * (half + BUBBLE_GAP + bubble.width / 2))
      .addScaledVector(input.up, 0.02);
    if (!state.bubblePlaced) {
      state.bubbleAt.copy(state.bubbleGoal);
      state.bubbleVel.set(0, 0, 0);
      state.bubblePlaced = true;
    }
    springStep(state.bubbleAt, state.bubbleVel, state.bubbleGoal, dt);
    bubble.group.position.copy(state.bubbleAt);
    bubble.group.quaternion.copy(state.headTurn);
    bubble.setTailSide(state.bubbleSide === 1 ? -1 : 1);
  }

  return (
    <>
      <primitive object={holder} />
      <primitive object={bubble.group} />
    </>
  );
}
