import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GrabSystem } from '../lib/grab';
import { createHandPose, type HandPose } from '../lib/handPose';
import { startHeadsetCameraIfAllowed, stopHeadsetCamera } from '../lib/headsetCamera';
import { checkMentorService } from '../lib/mentorAnalysis';
import { workspace } from '../lib/workspaceFlow';
import { GrabController } from './GrabController';
import type { Kit } from '../mat/lib/kit';
import { MaterialMat } from '../mat/MaterialMat';
import type { MatSystem } from '../mat/xr/MatSystem';
import type { HandStatus } from './Hud';
import { XRMenus } from './XRMenus';
import { XRPoseSource } from './XRPoseSource';
import { XRBuddy } from './XRBuddy';
import { XRWound } from './XRWound';

export type XRMode = 'ar' | 'vr';

interface XRSceneProps {
  /** The active session's mode, or null before entering / after leaving. */
  mode: XRMode | null;
  /** Height of the floor in the session's reference space (below 0 without a floor-level space). */
  floorY: number;
  rendererRef: RefObject<THREE.WebGLRenderer | null>;
  onHandStatus: (status: HandStatus) => void;
  /** Wound opacity 0..1, shared with the page's slider. */
  woundOpacity: RefObject<number>;
  /** Called when the in-headset Opacity panel changes the wound's opacity. */
  onWoundOpacityChange: (value: number) => void;
  /** The material mat's kit (mixed reality only), or null if it didn't load. */
  kit: Kit | null;
  onMatSystem?: (system: MatSystem | null) => void;
}

/**
 * The headset scene: a workspace introduced step by step (see
 * workspaceFlow.ts): first the material mat, then Buddy, then the menus,
 * and the wound on the user's palm only while they work. In VR it adds
 * virtual hands and a simple room; in mixed reality the real room and hands
 * show through passthrough.
 */
export const XRScene = memo(function XRScene({
  mode,
  floorY,
  rendererRef,
  onHandStatus,
  woundOpacity,
  onWoundOpacityChange,
  kit,
  onMatSystem,
}: XRSceneProps) {
  const pose = useRef<HandPose>(createHandPose());
  // Panels, Buddy and the material mat can be carried with a fist.
  const grab = useMemo(() => new GrabSystem(), []);
  const isVR = mode !== 'ar';
  // Mixed reality with a kit starts by setting up the mat; otherwise there's no mat.
  const withMat = mode === 'ar' && kit !== null;

  return (
    <Canvas
      gl={createXRRenderer}
      dpr={[1, 2]}
      camera={{ fov: 60, near: 0.01, far: 50, position: [0, 1.5, 0.8] }}
      onCreated={({ gl }) => {
        rendererRef.current = gl;
      }}
    >
      {isVR && <VRRoom floorY={floorY} />}
      <hemisphereLight args={['#ffffff', '#c9cfc7', 0.8]} />
      <directionalLight position={[0.6, 2.2, 0.8]} intensity={1} />
      <FlowDriver mode={mode} withMat={withMat} />
      <XRPoseSource pose={pose} showHands={isVR} />
      <XRWound strength={woundOpacity} />
      <XRBuddy active={mode !== null} grab={grab} />
      <XRMenus grab={grab} woundOpacity={woundOpacity} onWoundOpacityChange={onWoundOpacityChange} />
      <StatusReporter pose={pose} onHandStatus={onHandStatus} />
      <MaterialMat active={withMat} kit={kit} onSystem={onMatSystem} grab={grab} />
      <GrabController grab={grab} active={mode !== null} />
    </Canvas>
  );
});

/**
 * Creates the WebGL context XR-compatible from the start. Otherwise three.js
 * converts it when the session starts, which on laptops with two GPUs can
 * lose the context and make the session fail to start.
 */
function createXRRenderer(props: { canvas: unknown }) {
  const canvas = props.canvas as HTMLCanvasElement;
  const attributes = {
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    xrCompatible: true,
  } as const;
  const context = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null;
  return new THREE.WebGLRenderer({ canvas, ...attributes, ...(context ? { context } : {}) });
}

/** A calm, light room so VR isn't a black void: backdrop, floor and a grid. */
function VRRoom({ floorY }: { floorY: number }) {
  return (
    <>
      <color attach="background" args={['#e9ece8']} />
      <group position={[0, floorY, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[6, 64]} />
          <meshStandardMaterial color="#d6dbd4" roughness={1} />
        </mesh>
        <gridHelper args={[12, 24, '#b9c1b7', '#c8cec6']} position={[0, 0.001, 0]} />
      </group>
    </>
  );
}

/** Without a mat, the workspace is a fixed spot this far ahead of the eyes and this far below them (m). */
const NO_MAT_AHEAD = 0.5;
const NO_MAT_BELOW = 0.45;
const NO_MAT_SIZE = { width: 0.5, depth: 0.35 };

/**
 * Starts the workspace flow when a session starts (with the mat setup, or
 * straight to the intro without a mat), places the fixed workspace when
 * there's no mat, and checks whether mentor feedback is available.
 */
function FlowDriver({ mode, withMat }: { mode: XRMode | null; withMat: boolean }) {
  const gl = useThree((s) => s.gl);
  const s = useMemo(() => ({ needsFrame: false, head: new THREE.Vector3(), forward: new THREE.Vector3(), frame: new THREE.Matrix4() }), []);

  useEffect(() => {
    workspace.reset();
    workspace.flow.start(withMat);
    s.needsFrame = mode !== null && !withMat;
    if (mode !== null) {
      void checkMentorService();
      // The headset camera, for Check my work: started only if already allowed (no prompt in the headset).
      if (mode === 'ar') void startHeadsetCameraIfAllowed();
    } else stopHeadsetCamera();
  }, [mode, withMat, s]);
  useEffect(() => () => stopHeadsetCamera(), []);

  useFrame((_, delta) => {
    workspace.flow.update(delta);
    if (!s.needsFrame || !gl.xr.isPresenting) return;
    const head = gl.xr.getCamera();
    head.getWorldPosition(s.head);
    if (s.head.lengthSq() === 0) return; // no head pose yet
    head.getWorldDirection(s.forward);
    s.forward.y = 0;
    if (s.forward.lengthSq() < 1e-6) return;
    s.forward.normalize();
    // Frame +Z points back at the user, so the "front" of the workspace faces them.
    const yaw = Math.atan2(-s.forward.x, -s.forward.z);
    s.frame.makeRotationY(yaw).setPosition(
      s.head.x + s.forward.x * NO_MAT_AHEAD,
      s.head.y - NO_MAT_BELOW,
      s.head.z + s.forward.z * NO_MAT_AHEAD,
    );
    workspace.setFrame(s.frame, NO_MAT_SIZE.width, NO_MAT_SIZE.depth);
    s.needsFrame = false;
  });
  return null;
}

/** Tells the page (outside the headset) whether a hand is tracked. */
function StatusReporter({
  pose,
  onHandStatus,
}: {
  pose: RefObject<HandPose>;
  onHandStatus: (status: HandStatus) => void;
}) {
  const last = useRef<HandStatus>('none');
  useFrame(() => {
    const hand = pose.current;
    if (!hand) return;
    const status: HandStatus = hand.tracked ? 'open' : 'none';
    if (status !== last.current) {
      last.current = status;
      onHandStatus(status);
    }
  });
  return null;
}
