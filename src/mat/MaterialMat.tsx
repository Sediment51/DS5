import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { GrabSystem } from '../lib/grab';
import { workspace } from '../lib/workspaceFlow';
import type { Kit } from './lib/kit';
import { loadSavedMat } from './lib/matStore';
import { MatSystem } from './xr/MatSystem';

interface MaterialMatProps {
  /** On in the mixed-reality injury session (not the VR fallback). */
  active: boolean;
  /** The kit from materials.json, or null if it didn't load. */
  kit: Kit | null;
  /** Receives the system so the page can drive it (the ?test shortcut). */
  onSystem?: (system: MatSystem | null) => void;
  /** The mat and its control panel can be carried with a fist. */
  grab: GrabSystem;
}

/**
 * The material mat inside the injury simulation: while the mixed-reality
 * session runs, pinch-trace a rectangle on the table and the kit is laid
 * out on it, next to the wound on your palm. A mat saved last time is
 * restored automatically.
 */
export function MaterialMat({ active, kit, onSystem, grab }: MaterialMatProps) {
  const gl = useThree((s) => s.gl);
  const system = useMemo(() => new MatSystem(), []);

  useEffect(() => {
    const removers = system.grabbables.map((target) => grab.add(target));
    return () => removers.forEach((remove) => remove());
  }, [grab, system]);

  useEffect(() => {
    onSystem?.(system);
    return () => onSystem?.(null);
  }, [system, onSystem]);

  useEffect(() => {
    if (!active || !kit) return;
    const begin = () => {
      const session = gl.xr.getSession();
      if (session && !system.active) system.start(session, gl, { kit, restore: loadSavedMat() });
    };
    // The menus drive the mat (prev/next, step mode, opacity, redraw).
    workspace.mat = system;
    // The session is attached to the renderer just after the mode switches.
    if (gl.xr.isPresenting) begin();
    gl.xr.addEventListener('sessionstart', begin);
    return () => {
      gl.xr.removeEventListener('sessionstart', begin);
      system.stop();
      if (workspace.mat === system) workspace.mat = null;
    };
  }, [active, kit, gl, system]);

  useFrame((_, __, frame) => {
    if (active && frame) system.update(performance.now(), frame as XRFrame);
  });

  return <primitive object={system.root} />;
}
