import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';
import { mentor, requestFeedback } from '../lib/mentorAnalysis';
import { uiSound } from '../lib/uiSound';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import { WoundOutline } from '../lib/woundOutline';
import { workspace } from '../lib/workspaceFlow';
import { XRHandModel, prepareHandModel } from '../lib/xrHandModel';
import { conformWound } from '../lib/xrWoundConform';
import { SKIN_PRESETS, setAutoWorking, xrPrefs, type HandSide } from '../lib/xrPrefs';
import { XRSkinSampler } from '../lib/xrSkinSampler';
import { createXRWoundMaterial, skinToneColor } from '../lib/xrWoundMaterial';
import { MISS_RANGE, PINCH_RANGE, STAGE_COUNT, STAGE_LABELS, StageFlow, woundLink } from '../lib/woundSteps';
import { COLORS } from '../mat/xr/text';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/**
 * The wound's length (cm) on an average hand (REFERENCE_PALM_CM from wrist to
 * middle knuckle); it's scaled with the user's own palm…
 */
export const LENGTH_CM = 8.5;
export const REFERENCE_PALM_CM = 9.5;
/** …turned this far from the palm's long axis towards the thumb (degrees)… */
export const ANGLE_DEG = 35;
/** …this far above the skin (mm; the panel's Height slider adds ±5)… */
export const OFFSET_MM = 0.5;
/** …and moved on the palm (mm): [towards the thumb, towards the fingers], from the metacarpals' centre (their joints sit at the base of the palm). */
export const PALM_OFFSET_MM: readonly [number, number] = [0, 20];

/** The ring shown at the wound while the other hand is in pinch range: radius and line width (m), lift above the palm. */
const RING_RADIUS = 0.014;
const RING_WIDTH = 0.0018;
const RING_LIFT = 0.004;

/** How often the palm's colour is read from the camera, when allowed (s). */
const SKIN_SAMPLE_SECONDS = 0.5;

/** After the hand is lost the wound stays put this long (s)… */
const HOLD_SECONDS = 0.5;
/** …then fades out over this long (s). */
const FADE_SECONDS = 0.2;
/** While working, a hand lost this long (s) gets a "can't see your hand" message. */
const LOST_NOTICE_SECONDS = 0.6;
/** Entering work: the hand model's wireframe sweeps over the hand this long (s), to show it's aligned. */
const ALIGN_SWEEP_SECONDS = 1.6;
/** The wireframe's opacity during the sweep, and its usual (Mesh on) opacity. */
const SWEEP_OPACITY = 0.5;
const WIRE_OPACITY = 0.15;
/** Photos for mentor feedback: longest side (px). */
const PHOTO_SIZE = 768;

const scratchAxis = new THREE.Vector3();

const METACARPALS = [
  'index-finger-metacarpal',
  'middle-finger-metacarpal',
  'ring-finger-metacarpal',
  'pinky-finger-metacarpal',
] as const;

interface PalmFrame {
  /** Point on the palm's skin where the wound's centre goes (world). */
  point: THREE.Vector3;
  /** The wound's orientation: +Y out of the palm, +Z along its length. */
  quaternion: THREE.Quaternion;
}

/**
 * The palm, straight from the chosen hand's joints this frame:
 * origin at the four metacarpals' centre, normal = −Y of the middle
 * metacarpal (WebXR: out of the palm, on either hand), long axis from the
 * middle metacarpal to the middle knuckle, skin = origin + normal × the
 * metacarpals' mean radius.
 */
class PalmFrameReader {
  readonly origin = new THREE.Vector3();
  /** Along the palm (towards the fingers) and across it (towards the thumb), unit. */
  readonly along = new THREE.Vector3();
  readonly across = new THREE.Vector3();
  /** Out of the palm (unit). */
  readonly normal = new THREE.Vector3();
  /** On the skin above the metacarpals' centre. */
  readonly skin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly x = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  radius = 0.01;

  read(hand: THREE.XRHandSpace, out: PalmFrame): boolean {
    const j = hand.joints;
    const middle = j['middle-finger-metacarpal'];
    const knuckle = j['middle-finger-phalanx-proximal'];
    const thumb = j['thumb-metacarpal'];
    if (!middle?.visible || !knuckle || !thumb) return false;
    this.origin.set(0, 0, 0);
    let radius = 0;
    for (const name of METACARPALS) {
      const joint = j[name];
      if (!joint) return false;
      this.origin.add(joint.position);
      radius += joint.jointRadius ?? 0.01;
    }
    this.origin.multiplyScalar(1 / METACARPALS.length);
    this.radius = radius / METACARPALS.length;

    this.normal.set(0, -1, 0).applyQuaternion(middle.quaternion);
    this.along.subVectors(knuckle.position, middle.position);
    this.along.addScaledVector(this.normal, -this.along.dot(this.normal)).normalize();
    // Across the palm, signed so + points to the thumb side (either hand).
    this.across.crossVectors(this.normal, this.along);
    if (this.dir.subVectors(thumb.position, this.origin).dot(this.across) < 0) this.across.negate();

    this.skin.copy(this.origin).addScaledVector(this.normal, this.radius);
    out.point
      .copy(this.origin)
      .addScaledVector(this.normal, this.radius + OFFSET_MM / 1000)
      .addScaledVector(this.across, PALM_OFFSET_MM[0] / 1000)
      .addScaledVector(this.along, PALM_OFFSET_MM[1] / 1000);
    // Length runs ANGLE_DEG from the long axis towards the thumb.
    const a = THREE.MathUtils.degToRad(ANGLE_DEG);
    this.dir.copy(this.along).multiplyScalar(Math.cos(a)).addScaledVector(this.across, Math.sin(a));
    this.x.crossVectors(this.normal, this.dir);
    this.basis.makeBasis(this.x, this.normal, this.dir);
    out.quaternion.setFromRotationMatrix(this.basis);
    return true;
  }
}

/** Tracks which hand space is which hand (they connect in any order). */
function useHandSpaces() {
  const gl = useThree((s) => s.gl);
  // Slot per hand space: its handedness while connected (no per-frame allocation to look up).
  const slots = useMemo(() => [null, null] as (XRHandedness | null)[], []);
  useEffect(() => {
    const offs = [0, 1].map((i) => {
      const hand = gl.xr.getHand(i);
      const onConnected = (event: { data: XRInputSource }) => {
        if (event.data.hand) slots[i] = event.data.handedness;
      };
      const onDisconnected = () => (slots[i] = null);
      hand.addEventListener('connected', onConnected);
      hand.addEventListener('disconnected', onDisconnected);
      return () => {
        hand.removeEventListener('connected', onConnected);
        hand.removeEventListener('disconnected', onDisconnected);
      };
    });
    return () => offs.forEach((off) => off());
  }, [gl, slots]);
  return (side: HandSide): THREE.XRHandSpace | null => {
    for (let i = 0; i < 2; i++) if (slots[i] === side) return gl.xr.getHand(i);
    return null;
  };
}

interface XRWoundProps {
  /** Wound opacity 0..1 (the shared slider). */
  strength: RefObject<number>;
}

/** Fix the wound to the hand model's skin (it then deforms with the hand); false: rigid on the palm frame. */
export const USE_SKINNING = true;

const HAND_URL = `${import.meta.env.BASE_URL}models/Hand.glb`;

const FINGERTIPS = [
  ['index-finger-phalanx-proximal', 'index-finger-tip'],
  ['middle-finger-phalanx-proximal', 'middle-finger-tip'],
  ['ring-finger-phalanx-proximal', 'ring-finger-tip'],
  ['pinky-finger-phalanx-proximal', 'pinky-finger-tip'],
] as const;
/** A hand counts as open when its fingertips are this far from the wrist, relative to its knuckles (flat ≈ 2, fist ≈ 1). */
const OPEN_RATIO = 1.6;

/** Whether the hand is open enough to lay the wound on its palm. */
function isHandOpen(hand: THREE.XRHandSpace): boolean {
  const wrist = hand.joints.wrist;
  if (!wrist) return false;
  let sum = 0;
  for (const [knuckleName, tipName] of FINGERTIPS) {
    const knuckle = hand.joints[knuckleName];
    const tip = hand.joints[tipName];
    if (!knuckle || !tip) return false;
    sum += wrist.position.distanceTo(tip.position) / Math.max(wrist.position.distanceTo(knuckle.position), 1e-6);
  }
  return sum / FINGERTIPS.length > OPEN_RATIO;
}

/** Adds (empty) skin index/weight attributes, filled at each bind. */
function addSkinAttributes(geometry: THREE.BufferGeometry) {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
}

/**
 * The wound in the headset: on the chosen hand only, and only while the user
 * is working (the workspace's `work` phase; browsing the mat and the menus
 * shows no hand and no wound). A detailed hand model is posed on that hand's
 * joints every frame (no smoothing: the runtime already predicts poses); the
 * wound is laid onto the model's palm skin and skinned with the model's own
 * weights, so it stays on that skin as the hand moves and bends. The model,
 * drawn depth-only, hides the wound behind the real hand. When the hand is
 * lost the wound stays put for 0.5 s, then fades, and reappears at once at
 * the new pose; the status board says what happened and how to recover.
 */
export function XRWound({ strength }: XRWoundProps) {
  const findHand = useHandSpaces();
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const [handSource, setHandSource] = useState<THREE.SkinnedMesh | null>(null);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const material = useMemo(() => createXRWoundMaterial(), []);

  useEffect(() => {
    let cancelled = false;
    let loaded: WoundGeometryInfo | null = null;
    new GLTFLoader()
      .loadAsync(WOUND_URL)
      .then((gltf) => {
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (!geometry && (o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
        });
        if (!geometry || cancelled) return;
        loaded = normaliseWound(geometry, LENGTH_CM / 100);
        (geometry as THREE.BufferGeometry).dispose();
        addSkinAttributes(loaded.geometry);
        // The flat wound as loaded, kept to lay it onto the hand afresh at each bind.
        loaded.geometry.userData.restPositions = (loaded.geometry.getAttribute('position').array as Float32Array).slice();
        loaded.geometry.userData.restNormals = (loaded.geometry.getAttribute('normal').array as Float32Array).slice();
        loaded.geometry.userData.restMoundNormals = (loaded.geometry.getAttribute('moundNormal').array as Float32Array).slice();
        material.userData.uniforms.uHalf.value.set(loaded.halfWidth, loaded.halfLength);
        setInfo(loaded);
      })
      .catch((error) => console.error('Could not load the wound model', error));
    new GLTFLoader()
      .loadAsync(HAND_URL)
      .then((gltf) => {
        let mesh: THREE.SkinnedMesh | null = null;
        gltf.scene.traverse((o) => {
          if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!cancelled) setHandSource(mesh);
      })
      .catch((error) => console.error('Could not load the hand model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
    };
  }, [material]);
  useEffect(() => () => material.dispose(), [material]);

  // The hand model, as a left and a right hand.
  const hands = useMemo(() => {
    if (!handSource) return null;
    return { left: new XRHandModel(prepareHandModel(handSource, false)), right: new XRHandModel(prepareHandModel(handSource, true)) };
  }, [handSource]);
  useEffect(
    () => () => {
      hands?.left.dispose();
      hands?.right.dispose();
    },
    [hands],
  );

  // Soft studio reflections for the wet blood (or the room's own, if the
  // session estimates the real light).
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    material.envMap = envMap;
    material.needsUpdate = true;
    room.dispose();
    pmrem.dispose();

    const estimated = new XREstimatedLight(gl);
    const ownLights: THREE.Light[] = [];
    const onStart = () => {
      // The real room's light replaces the scene's fixed lights.
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight && o.visible) ownLights.push(o as THREE.Light);
      });
      ownLights.forEach((light) => (light.visible = false));
      scene.add(estimated);
      if (estimated.environment) {
        material.envMap = estimated.environment;
        material.needsUpdate = true;
      }
    };
    const onEnd = () => {
      scene.remove(estimated);
      ownLights.forEach((light) => (light.visible = true));
      ownLights.length = 0;
      material.envMap = envMap;
      material.needsUpdate = true;
    };
    estimated.addEventListener('estimationstart', onStart);
    estimated.addEventListener('estimationend', onEnd);
    return () => {
      estimated.removeEventListener('estimationstart', onStart);
      estimated.removeEventListener('estimationend', onEnd);
      onEnd();
      estimated.dispose();
      envMap.dispose();
    };
  }, [gl, scene, material]);

  // The wound, parented to the scene (never to the hand).
  const mesh = useMemo(() => {
    if (!info) return null;
    const o = USE_SKINNING ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
    o.frustumCulled = false;
    o.renderOrder = 3;
    o.visible = false;
    return o;
  }, [info, material]);

  // The ring that shows a pinch would count (Buddy speaks the stages).
  const extras = useMemo(() => {
    const ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(RING_RADIUS - RING_WIDTH / 2, RING_RADIUS + RING_WIDTH / 2, 48).rotateX(-Math.PI / 2),
      ringMaterial,
    );
    ring.renderOrder = 19;
    ring.visible = false;
    return { ring, ringMaterial, ringIdle: new THREE.Color(COLORS.label), ringPinch: new THREE.Color(COLORS.accent), outline: new WoundOutline() };
  }, []);
  useEffect(
    () => () => {
      extras.ring.geometry.dispose();
      extras.ringMaterial.dispose();
      extras.outline.dispose();
    },
    [extras],
  );

  const state = useMemo(
    () => ({
      flow: new StageFlow(),
      pinchPoint: new THREE.Vector3(),
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      bound: false,
      pendingBind: false,
      boundHeight: 0,
      sinceBind: 0,
      lostFor: Infinity,
      boundHand: null as HandSide | null,
      boundReattach: -1,
      skinVersion: -1,
      toWound: new THREE.Matrix4(),
      surface: null as Float32Array | null,
      sampler: new XRSkinSampler(),
      sampleIn: 0,
      samplePoints: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()),
      flowVersion: -1,
      working: false,
      sweep: 0,
      seenSinceWork: false,
      lostNotice: -1,
      tipNotice: -1,
      mentorVersion: -1,
      handScale: 1,
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, mesh, hands, findHand, prefs: xrPrefs, scene, extras };
  }, [state, mesh, hands, findHand, scene, extras]);

  useFrame((_, delta) => {
    if (!mesh || !hands) return;
    if (state.skinVersion !== xrPrefs.version) {
      state.skinVersion = xrPrefs.version;
      if (!(xrPrefs.skinAuto && xrPrefs.autoWorking)) {
        skinToneColor(SKIN_PRESETS[xrPrefs.skinPreset], xrPrefs.skinFine, material.userData.uniforms.skinTone.value);
      }
    }
    const model = xrPrefs.hand === 'left' ? hands.left : hands.right;
    const other = model === hands.left ? hands.right : hands.left;
    other.root.visible = false;

    // Only while working: entering it measures the hand afresh and shows it's tracked.
    if (state.flowVersion !== workspace.flow.version) {
      state.flowVersion = workspace.flow.version;
      const working = workspace.flow.phase === 'work';
      if (working && !state.working) {
        state.boundHand = null; // calibrate and lay the wound on afresh
        state.sweep = ALIGN_SWEEP_SECONDS;
        state.seenSinceWork = false;
        workspace.notify(`Show your ${xrPrefs.hand} palm`, 'view', 'info', Infinity, 'Open, facing up, in front of you');
      } else if (!working && state.working) {
        state.bound = false;
        state.placed = false;
        state.lostFor = Infinity;
        if (state.lostNotice >= 0) workspace.dismiss(state.lostNotice);
        state.lostNotice = -1;
        extras.outline.stop();
      }
      state.working = working;
    }
    if (!state.working) {
      model.root.visible = false;
      mesh.visible = false;
      extras.ring.visible = false;
      woundLink.flow = state.flow;
      woundLink.placed = false;
      woundLink.tracked = false;
      woundLink.otherInRange = false;
      mentor.captureRequested = false;
      return;
    }

    const hand = findHand(xrPrefs.hand);
    // Joints are all-or-nothing: the wrist stands for the whole hand.
    const tracked = !!hand?.joints.wrist?.visible && state.reader.read(hand, state.frame) && model.update(hand);
    if (tracked) {
      if (USE_SKINNING) {
        // Measure the hand (~0.5 s) and then lay the wound on its palm: on the
        // first frame, on Calibrate, and when the hand changes.
        if (state.boundHand !== xrPrefs.hand || state.boundReattach !== xrPrefs.reattach) {
          state.boundHand = xrPrefs.hand;
          state.boundReattach = xrPrefs.reattach;
          model.startCalibration();
          state.pendingBind = true;
        }
        state.sinceBind += delta;
        // Only onto an open palm: with the fingers curled over it, the wound would land on them.
        const open = isHandOpen(hand);
        const heightChanged = state.bound && state.boundHeight !== xrPrefs.skinHeightMm && state.sinceBind > 0.15;
        if (open && ((state.pendingBind && model.calibrated) || heightChanged)) {
          const bound = bind(mesh as unknown as THREE.SkinnedMesh, model);
          state.bound = bound || state.bound;
          state.pendingBind = !bound && state.pendingBind;
          state.boundHeight = xrPrefs.skinHeightMm;
          state.sinceBind = 0;
          model.setOccluderPushExtra(-xrPrefs.skinHeightMm / 1000);
        }
      } else {
        mesh.position.copy(state.frame.point);
        mesh.quaternion.copy(state.frame.quaternion);
      }
      state.placed = state.bound || !USE_SKINNING;
      state.lostFor = 0;
      // Auto skin tone: the real palm's colour from the camera, if the session allows it.
      state.sampleIn -= delta;
      if (xrPrefs.skinAuto && state.sampleIn <= 0) {
        state.sampleIn = SKIN_SAMPLE_SECONDS;
        const r = state.reader;
        const pts = state.samplePoints;
        pts[0].copy(r.skin);
        pts[1].copy(r.skin).addScaledVector(r.along, 0.015);
        pts[2].copy(r.skin).addScaledVector(r.along, -0.015);
        pts[3].copy(r.skin).addScaledVector(r.across, 0.015);
        pts[4].copy(r.skin).addScaledVector(r.across, -0.015);
        if (state.sampler.sample(gl, pts)) {
          const c = state.sampler.srgb;
          material.userData.uniforms.skinTone.value.setRGB(c.x, c.y, c.z, THREE.SRGBColorSpace);
          setAutoWorking(true);
        } else if (!state.sampler.available) {
          setAutoWorking(false);
        }
      }
    } else {
      state.lostFor += delta;
    }
    // Tracking lost while working: say what happened and how to recover; and when it's back.
    if (tracked) {
      workspace.handPoint.copy(state.frame.point);
      workspace.handSeen = true;
      if (state.lostNotice >= 0) {
        workspace.notify('Tracking back', 'hand', 'ok', 1.5);
        extras.outline.lost(false);
        state.lostNotice = -1;
      } else if (!state.seenSinceWork) workspace.notify('Tracking on', 'hand', 'ok', 1.8);
      state.seenSinceWork = true;
    } else if (state.seenSinceWork && state.lostFor > LOST_NOTICE_SECONDS && state.lostNotice < 0) {
      // Where the hand was: an amber outline pulses, with the words above it.
      uiSound.alert();
      extras.outline.lost(true);
      state.lostNotice = workspace.notify(`${xrPrefs.hand === 'left' ? 'Left' : 'Right'} hand lost`, 'hand', 'warn', Infinity, 'Hold it in view, palm open');
    }
    showMentorVerdict();
    extras.outline.update(delta, tracked ? state.frame.point : null, tracked ? state.frame.quaternion : null, 1, state.placed ? 1 : 0.7);
    // Mentor feedback: the photo is taken here, inside the XR frame (the camera image is only readable now).
    if (mentor.captureRequested) {
      mentor.captureRequested = false;
      const photo = state.sampler.captureImage(gl, PHOTO_SIZE);
      if (photo) void requestFeedback(photo, state.flow.stage, STAGE_LABELS[state.flow.stage] ?? '');
      else mentor.set('error', 'I can’t see through the headset camera here: this browser didn’t allow camera access.');
    }
    const fade = state.lostFor <= HOLD_SECONDS ? 1 : 1 - (state.lostFor - HOLD_SECONDS) / FADE_SECONDS;
    const opacity = state.placed ? THREE.MathUtils.clamp(fade, 0, 1) * THREE.MathUtils.clamp(strength.current ?? 1, 0, 1) : 0;
    material.opacity = opacity;
    mesh.visible = opacity > 0;
    stepStages(delta, opacity);
    // Shared with Buddy.
    woundLink.flow = state.flow;
    woundLink.placed = state.placed;
    woundLink.tracked = tracked && state.placed;
    if (tracked) {
      woundLink.point.copy(state.frame.point);
      woundLink.thumbSide.copy(state.reader.across);
      woundLink.normal.copy(state.reader.normal);
    }
    // The hand model: hides the wound behind the real hand. Its wireframe sweeps over the hand
    // once on entering work (so you can see it's lined up), then shows only with "Hand mesh" on.
    if (tracked && state.sweep > 0) state.sweep = Math.max(state.sweep - delta, 0);
    const sweeping = tracked && state.sweep > 0;
    const wireMaterial = model.wire.material as THREE.MeshBasicMaterial;
    wireMaterial.opacity = sweeping ? SWEEP_OPACITY * Math.sin((state.sweep / ALIGN_SWEEP_SECONDS) * Math.PI) : WIRE_OPACITY;
    model.wire.visible = sweeping || xrPrefs.showHandMesh;
    model.root.visible = mesh.visible || (model.wire.visible && tracked);
    model.occluder.visible = mesh.visible;
  });

  /**
   * The build stages: a pinch of the other hand near the wound steps them;
   * the stage drives the wound's own shape and look, so it stays exactly in
   * the wound's place. A ring at the wound shows a pinch would count; Buddy
   * (XRBuddy) says what the stage is.
   */
  /**
   * Check my work, shown on the wound: a blue sweep goes round while the photo
   * is checked; then each part of the outline is cyan (fine) or amber (refine
   * here), with the tip in a few words above the hand.
   */
  function showMentorVerdict() {
    if (state.mentorVersion === mentor.version) return;
    state.mentorVersion = mentor.version;
    const outline = extras.outline;
    if (mentor.status === 'processing') {
      outline.scan(true);
      return;
    }
    outline.scan(false);
    if (mentor.status === 'error') {
      workspace.notify('Couldn’t check', 'hand', 'warn', 4, mentor.text);
      return;
    }
    if (mentor.status !== 'done') return;
    const verdict = mentor.verdict;
    if (!verdict || verdict.overall === 'not_visible') {
      workspace.notify(mentor.text, 'hand', verdict ? 'warn' : 'info', 5);
      return;
    }
    outline.showVerdict(verdict.zones);
    const refine = Object.values(verdict.zones).includes('refine');
    workspace.notify(mentor.text, 'hand', refine ? 'warn' : 'ok', 6);
  }

  function stepStages(delta: number, opacity: number) {
    const { flow, pinchPoint } = state;
    const shown = opacity > 0;
    const other = findHand(xrPrefs.hand === 'left' ? 'right' : 'left');
    const thumb = other?.joints['thumb-tip'];
    const index = other?.joints['index-finger-tip'];
    let distance: number | null = null;
    let inRange = false;
    let near = false;
    if (thumb?.visible && index?.visible) {
      distance = thumb.position.distanceTo(index.position);
      pinchPoint.addVectors(thumb.position, index.position).multiplyScalar(0.5);
      // Against where the wound last was: the pinching hand can hide the wound's hand for a moment.
      const away = pinchPoint.distanceTo(state.frame.point);
      inRange = state.placed && away < PINCH_RANGE;
      near = state.placed && away < MISS_RANGE;
    }
    if (flow.update(delta, distance, inRange, near)) {
      // A step done: a cyan flash round the wound, and its name (Buddy speaks the next one).
      uiSound.success();
      extras.outline.flash();
      if (flow.stage === 0) workspace.notify('All steps done', 'hand', 'ok', 3);
      else if (flow.from > 0) workspace.notify(`Step ${flow.from} of ${STAGE_COUNT} done`, 'hand', 'ok', 1.8);
    }
    woundLink.otherInRange = inRange;
    const u = material.userData.uniforms;
    u.uStage.value = flow.stage;
    u.uStageFrom.value = flow.from;
    u.uStageBlend.value = flow.blend;

    const r = state.reader;
    const { ring } = extras;
    ring.visible = inRange && shown;
    if (ring.visible) {
      ring.position.copy(state.frame.point).addScaledVector(r.normal, RING_LIFT);
      ring.quaternion.copy(state.frame.quaternion);
      const pinching = flow.pinching && flow.armed;
      extras.ringMaterial.color.copy(pinching ? extras.ringPinch : extras.ringIdle);
      extras.ringMaterial.opacity = opacity * (pinching ? 0.95 : 0.5);
    }
  }

  /** Lays the wound onto the hand model's palm skin as it is this frame and binds it to the model's bones. */
  function bind(skinned: THREE.SkinnedMesh, model: XRHandModel): boolean {
    // In proportion to this hand: bigger on a bigger palm, smaller on a smaller one.
    const handScale = model.palmLength / (REFERENCE_PALM_CM / 100);
    skinned.position.copy(state.frame.point);
    skinned.quaternion.copy(state.frame.quaternion);
    skinned.scale.setScalar(handScale);
    skinned.updateMatrixWorld(true);
    const handGeometry = model.data.geometry;
    const count = handGeometry.getAttribute('position').count;
    if (!state.surface || state.surface.length !== count * 3) state.surface = new Float32Array(count * 3);
    model.skinnedPositions(state.surface);
    state.toWound.copy(skinned.matrixWorld).invert();
    const g = skinned.geometry;
    const ok = conformWound(
      {
        restPositions: g.userData.restPositions as Float32Array,
        restNormals: g.userData.restNormals as Float32Array,
        restMoundNormals: g.userData.restMoundNormals as Float32Array,
        halfWidth: info!.halfWidth,
        halfLength: info!.halfLength,
      },
      {
        positions: state.surface,
        index: handGeometry.getIndex()!.array as ArrayLike<number>,
        skinIndex: handGeometry.getAttribute('skinIndex') as THREE.BufferAttribute,
        skinWeight: handGeometry.getAttribute('skinWeight') as THREE.BufferAttribute,
      },
      state.toWound,
      (OFFSET_MM + xrPrefs.skinHeightMm) / 1000 / handScale,
      g,
    );
    if (!ok) return false;
    // The feedback outline fits this wound, and knows which long edge is on the thumb side.
    extras.outline.thumbSign = scratchAxis.set(1, 0, 0).applyQuaternion(state.frame.quaternion).dot(state.reader.across) >= 0 ? 1 : -1;
    extras.outline.setSize(info!.halfWidth * handScale, info!.halfLength * handScale);
    // A new skeleton on the model's bones, so its inverses capture this exact pose.
    const old = skinned.skeleton;
    skinned.bind(new THREE.Skeleton(model.bones), skinned.matrixWorld);
    old?.dispose();
    return true;
  }

  return (
    <>
      {hands && <primitive object={hands.left.root} />}
      {hands && <primitive object={hands.right.root} />}
      {mesh && <primitive object={mesh} />}
      <primitive object={extras.ring} />
      <primitive object={extras.outline.group} />
    </>
  );
}
