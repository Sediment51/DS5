import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { isPointing } from './fist';

// A palm 9 cm long along +Y: wrist at the origin, middle knuckle at 9 cm.
const wrist = new THREE.Vector3(0, 0, 0);
const knuckle = new THREE.Vector3(0, 0.09, 0);
const out = (x: number) => new THREE.Vector3(x, 0.17, 0); // fingertip stretched out
const curled = (x: number) => new THREE.Vector3(x, 0.06, 0.03); // fingertip folded into the palm

describe('isPointing', () => {
  it('is true with the index out and the others curled', () => {
    expect(isPointing(wrist, knuckle, out(0.02), [curled(0), curled(-0.015), curled(-0.03)])).toBe(true);
  });

  it('is false for an open hand passing by', () => {
    expect(isPointing(wrist, knuckle, out(0.02), [out(0), out(-0.015), out(-0.03)])).toBe(false);
  });

  it('is false for a fist', () => {
    expect(isPointing(wrist, knuckle, curled(0.02), [curled(0), curled(-0.015), curled(-0.03)])).toBe(false);
  });

  it('is false with a second finger out (a V)', () => {
    expect(isPointing(wrist, knuckle, out(0.02), [out(0), curled(-0.015), curled(-0.03)])).toBe(false);
  });
});
