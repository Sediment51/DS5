import * as THREE from 'three';

/**
 * A detailed hand model (public/models/Hand.glb: a sculpted left hand whose
 * bones are named as in BONES below)
 * driven by the headset's hand joints: every bone is put on the matching
 * joint, aimed at the next one and turned with the palm. The model keeps its
 * own shape and proportions and is only scaled as a whole to the user's hand
 * (palm length). Its palm is then a real curved surface the wound can be
 * fixed to, and the hand itself hides the wound behind it.
 *
 * At load it's baked to metres (a 9.5 cm palm, wrist → middle knuckle; it's
 * resized to the user's hand afterwards), its palm side worked out from its
 * bones, and it's mirrored for a right hand.
 */

type Joint = XRHandJoint;

interface BoneSpec {
  /** Where the bone's head goes: a joint, or 'rigid' (fixed to the wrist bone). */
  head: Joint | 'rigid';
  /** The joint it aims at (none: rigid). */
  aim?: Joint;
  /** Its roll: the joint whose −Y is the palm side here, or 'palm' (the hand's palm normal). */
  roll?: Joint | 'palm';
}

const FINGERS = [
  ['index', 'index-finger'],
  ['midd', 'middle-finger'],
  ['ring', 'ring-finger'],
  ['pinky', 'pinky-finger'],
] as const;

/** How each of the model's bones follows the XR joints. */
const BONES: Record<string, BoneSpec> = {
  forearm: { head: 'rigid' },
  radius_ulna: { head: 'wrist', aim: 'middle-finger-phalanx-proximal', roll: 'palm' },
  thumb_trapez: { head: 'rigid' },
  thumb_meta: { head: 'thumb-metacarpal', aim: 'thumb-phalanx-proximal', roll: 'palm' },
  thumb_prox: { head: 'thumb-phalanx-proximal', aim: 'thumb-phalanx-distal', roll: 'palm' },
  thumb_dist: { head: 'thumb-phalanx-distal', aim: 'thumb-tip', roll: 'palm' },
};
for (const [m, x] of FINGERS) {
  BONES[`${m}_meta`] = { head: `${x}-metacarpal` as Joint, aim: `${x}-phalanx-proximal` as Joint, roll: `${x}-metacarpal` as Joint };
  BONES[`${m}_prox`] = { head: `${x}-phalanx-proximal` as Joint, aim: `${x}-phalanx-intermediate` as Joint, roll: `${x}-phalanx-proximal` as Joint };
  BONES[`${m}_midd`] = { head: `${x}-phalanx-intermediate` as Joint, aim: `${x}-phalanx-distal` as Joint, roll: `${x}-phalanx-intermediate` as Joint };
  BONES[`${m}_dist`] = { head: `${x}-phalanx-distal` as Joint, aim: `${x}-tip` as Joint, roll: `${x}-phalanx-distal` as Joint };
}

/** One hand (left as modelled, or mirrored to a right hand), ready to drive. */
export interface HandModelData {
  geometry: THREE.BufferGeometry;
  names: string[];
  specs: BoneSpec[];
  /** Rest pose (metres): each bone's head, and its frame (aim, palm side). */
  restHead: THREE.Vector3[];
  restFrame: THREE.Quaternion[];
  /** Rigid bones: head offset and frame relative to the wrist bone, at rest. */
  rigidOffset: THREE.Vector3[];
  rigidRotation: THREE.Quaternion[];
  /** Rest length wrist → middle knuckle (metres). */
  restSpan: number;
}

/** An orthonormal frame from an aim direction and a palm-side direction (made perpendicular). */
function frame(aim: THREE.Vector3, palm: THREE.Vector3, out: THREE.Quaternion, m = new THREE.Matrix4()) {
  const f = aim;
  const n = _n.copy(palm).addScaledVector(f, -palm.dot(f));
  if (n.lengthSq() < 1e-10) n.set(f.y, f.z, f.x).addScaledVector(f, -f.dot(_n.set(f.y, f.z, f.x)));
  n.normalize();
  _s.crossVectors(f, n);
  m.makeBasis(f, n, _s);
  return out.setFromRotationMatrix(m);
}
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Bakes the model's rest pose to metres and records how its bones map to the
 * XR joints; `mirror` makes a right hand.
 */
export function prepareHandModel(source: THREE.SkinnedMesh, mirror: boolean): HandModelData {
  source.updateMatrixWorld(true);
  source.skeleton.bones.forEach((b) => b.updateMatrixWorld(true));
  const sx = mirror ? -1 : 1;
  // To metres, for a 9.5 cm palm (wrist bone → middle knuckle).
  const bones = source.skeleton.bones;
  const names = bones.map((b) => b.name);
  const rawHead = (name: string) => bones[names.indexOf(name)].getWorldPosition(new THREE.Vector3());
  const cm = 0.095 / rawHead('midd_prox').distanceTo(rawHead('radius_ulna'));
  const src = source.geometry;
  const count = src.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    source.getVertexPosition(i, v).applyMatrix4(source.matrixWorld);
    pos[i * 3] = v.x * cm * sx;
    pos[i * 3 + 1] = v.y * cm;
    pos[i * 3 + 2] = v.z * cm;
  }
  const index = Array.from(src.getIndex()!.array as ArrayLike<number>);
  if (mirror) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('skinIndex', src.getAttribute('skinIndex').clone());
  geometry.setAttribute('skinWeight', src.getAttribute('skinWeight').clone());
  geometry.setIndex(index);
  geometry.computeVertexNormals();

  const head = (name: string) => {
    const p = bones[names.indexOf(name)].getWorldPosition(new THREE.Vector3()).multiplyScalar(cm);
    p.x *= sx;
    return p;
  };
  const yAxis = (name: string) => {
    const e = bones[names.indexOf(name)].matrixWorld.elements;
    return new THREE.Vector3(e[4] * sx, e[5], e[6]).normalize();
  };
  // The palm side (a left hand): fingers × thumb side.
  const fingers = head('midd_prox').sub(head('radius_ulna')).normalize();
  const thumbSide = head('thumb_meta').sub(head('radius_ulna'));
  thumbSide.addScaledVector(fingers, -thumbSide.dot(fingers)).normalize();
  const palm = new THREE.Vector3().crossVectors(fingers, thumbSide).multiplyScalar(sx).normalize();
  const specs = names.map((n) => {
    const spec = BONES[n];
    if (!spec) throw new Error(`Hand model: no mapping for bone ${n}`);
    return spec;
  });
  const restHead = names.map(head);
  const restFrame = names.map((name, i) => {
    const spec = specs[i];
    // Aim at the next bone's head along the chain, or along the bone itself at the ends.
    const child = bones.find((b) => b.parent === bones[i] && BONES[b.name]?.head !== 'rigid');
    let aim: THREE.Vector3;
    if (name === 'radius_ulna') aim = head('midd_prox').sub(restHead[i]).normalize();
    else if (name.endsWith('_meta') && name !== 'thumb_meta') aim = head(name.replace('_meta', '_prox')).sub(restHead[i]).normalize();
    else if (child && spec.head !== 'rigid') aim = head(child.name).sub(restHead[i]).normalize();
    else aim = yAxis(name);
    return frame(aim, palm, new THREE.Quaternion());
  });
  const root = names.indexOf('radius_ulna');
  const rootInv = restFrame[root].clone().invert();
  const rigidOffset = names.map((_, i) => restHead[i].clone().sub(restHead[root]).applyQuaternion(rootInv));
  const rigidRotation = names.map((_, i) => rootInv.clone().multiply(restFrame[i]));
  const restSpan = head('midd_prox').distanceTo(restHead[root]);
  return { geometry, names, specs, restHead, restFrame, rigidOffset, rigidRotation, restSpan };
}

/**
 * The occluding copy of the hand is pushed this far away from the viewer
 * along each line of sight (m): its outline on screen is unchanged, but the
 * skin right under the wound (or a bump of the model next to it) can never
 * cover it, while fingers in front of the palm and the back of the hand
 * (centimetres in front) still do.
 */
const OCCLUDER_PUSH = 0.004;
/** Frames averaged when calibrating to a hand (~0.5 s). */
const CALIBRATION_FRAMES = 36;

/**
 * The driven hand: bones (world matrices set from the joints every frame),
 * an invisible depth-only copy that hides what's behind the real hand, and
 * a wireframe to show how it lines up.
 */
export class XRHandModel {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[];
  readonly occluder: THREE.SkinnedMesh;
  readonly wire: THREE.SkinnedMesh;
  /** The user's palm length, wrist → middle knuckle (m), as calibrated (live until then). */
  palmLength = 0.095;
  /** Whether the hand's sizes have been captured (they're live and noisier until then). */
  calibrated = false;
  private calibrating = false;
  private calFrames = 0;
  private calPalm = 0;
  private readonly push = { value: OCCLUDER_PUSH };
  private readonly heads: THREE.Vector3[];
  private readonly frames: THREE.Quaternion[];
  /** The whole hand's scale (user / model), the same for every bone. */
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly a = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly palm = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly root_ = { head: new THREE.Vector3(), frame: new THREE.Quaternion() };

  constructor(readonly data: HandModelData) {
    this.bones = data.names.map((name, i) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.matrixAutoUpdate = false;
      bone.matrixWorldAutoUpdate = false;
      bone.matrixWorld.compose(data.restHead[i], data.restFrame[i], new THREE.Vector3(1, 1, 1));
      bone.matrix.copy(bone.matrixWorld);
      this.root.add(bone);
      return bone;
    });
    this.heads = data.names.map(() => new THREE.Vector3());
    this.frames = data.names.map(() => new THREE.Quaternion());
    const skeleton = new THREE.Skeleton(this.bones);
    const occluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
    occluderMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.pushBack = this.push;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float pushBack;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          // Further along the line of sight: same outline, more depth.
          gl_Position = projectionMatrix * vec4(mvPosition.xyz + normalize(mvPosition.xyz) * pushBack, 1.0);`,
        );
    };
    occluderMaterial.customProgramCacheKey = () => 'xr-hand-occluder';
    this.occluder = new THREE.SkinnedMesh(data.geometry, occluderMaterial);
    this.wire = new THREE.SkinnedMesh(
      data.geometry,
      new THREE.MeshBasicMaterial({ color: '#7cc4ff', wireframe: true, transparent: true, opacity: 0.15, depthTest: false }),
    );
    for (const mesh of [this.occluder, this.wire]) {
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
    this.occluder.renderOrder = -1;
    this.wire.renderOrder = 20;
    this.wire.visible = false;
  }

  /** Poses the hand on the given XR hand's joints (this frame). */
  update(hand: THREE.XRHandSpace): boolean {
    const j = hand.joints;
    const d = this.data;
    const wrist = j.wrist;
    const knuckle = j['middle-finger-phalanx-proximal'];
    const middle = j['middle-finger-metacarpal'];
    if (!wrist || !knuckle || !middle) return false;
    // The model keeps its own shape and proportions; it's only scaled as a
    // whole to this hand's size (palm length, averaged when calibrating).
    const palmLength = wrist.position.distanceTo(knuckle.position);
    if (!this.calibrated) this.palmLength = palmLength;
    this.scale.setScalar(this.palmLength / d.restSpan);
    this.palm.set(0, -1, 0).applyQuaternion(middle.quaternion);

    for (let pass = 0; pass < 2; pass++) {
      // Pass 0: bones on joints (incl. the wrist bone); pass 1: bones fixed to the wrist bone.
      for (let i = 0; i < d.specs.length; i++) {
        const spec = d.specs[i];
        const rigid = spec.head === 'rigid';
        if ((pass === 0) === rigid) continue;
        const head = this.heads[i];
        if (rigid) {
          const root = this.root_;
          head.copy(d.rigidOffset[i]).multiply(this.scale).applyQuaternion(root.frame).add(root.head);
        } else {
          const joint = j[spec.head as Joint];
          if (!joint) return false;
          head.copy(joint.position);
        }
        if (spec.aim) {
          const target = j[spec.aim];
          if (!target) return false;
          this.a.subVectors(target.position, head).normalize();
          if (spec.roll === 'palm' || !spec.roll) this.n.copy(this.palm);
          else this.n.set(0, -1, 0).applyQuaternion(j[spec.roll]!.quaternion);
          // The bone's axes are its frame (aim, palm side), as at rest.
          frame(this.a, this.n, this.frames[i], this.m);
        } else {
          this.frames[i].copy(this.root_.frame).multiply(d.rigidRotation[i]);
        }
        if (d.names[i] === 'radius_ulna') {
          this.root_.head.copy(head);
          this.root_.frame.copy(this.frames[i]);
        }
      }
    }
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      bone.matrixWorld.compose(this.heads[i], this.frames[i], this.scale);
      bone.matrix.copy(bone.matrixWorld);
    }
    if (this.calibrating) {
      this.calPalm += palmLength;
      if (++this.calFrames >= CALIBRATION_FRAMES) {
        // Freeze this hand's size: steadier than measuring it every frame.
        this.palmLength = this.calPalm / this.calFrames;
        this.calibrating = false;
        this.calibrated = true;
      }
    }
    return true;
  }

  /** Measures the hand afresh over the next ~0.5 s (sizes are live until it's done). */
  startCalibration() {
    this.calibrating = true;
    this.calibrated = false;
    this.calFrames = 0;
    this.calPalm = 0;
  }

  /** Pushes the occluder further back (m), when the wound is lowered into the skin. */
  setOccluderPushExtra(extra: number) {
    this.push.value = OCCLUDER_PUSH + Math.max(0, extra);
  }

  /** The hand's current surface (world): skinned vertex positions, written into `out` (3 per vertex). */
  skinnedPositions(out: Float32Array) {
    const v = this.a;
    const count = this.data.geometry.getAttribute('position').count;
    this.occluder.skeleton.update();
    for (let i = 0; i < count; i++) {
      this.wire.getVertexPosition(i, v);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
  }

  dispose() {
    this.data.geometry.dispose();
    (this.occluder.material as THREE.Material).dispose();
    (this.wire.material as THREE.Material).dispose();
    this.occluder.skeleton.dispose();
  }
}
