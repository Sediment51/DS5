import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal in-memory localStorage (vitest runs in Node). */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    data,
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resetDemo', () => {
  it('forgets the mat, the opacities and the settings, keeping the anchor to delete next session', async () => {
    storage.setItem('material-mat:last', JSON.stringify({ handle: 'anchor-1', width: 0.6, depth: 0.4, savedAt: 1 }));
    storage.setItem('material-mat:opacity', '0.4');
    storage.setItem('palm-injury:wound-opacity', '0.3');
    storage.setItem('palm-injury.xr-prefs', JSON.stringify({ hand: 'right', skinAuto: false, buddy: false }));

    const { resetDemo } = await import('./demoReset');
    const { loadSavedMat, loadOpacity, takeAnchorsToForget } = await import('../mat/lib/matStore');
    const { loadWoundOpacity } = await import('./woundOpacity');
    const { xrPrefs, DEFAULT_PREFS } = await import('./xrPrefs');
    expect(xrPrefs.hand).toBe('right');

    resetDemo();

    expect(loadSavedMat()).toBeNull();
    expect(loadOpacity()).toBe(0.85);
    expect(loadWoundOpacity()).toBe(1);
    expect(xrPrefs.hand).toBe(DEFAULT_PREFS.hand);
    expect(xrPrefs.buddy).toBe(true);
    expect(JSON.parse(storage.getItem('palm-injury.xr-prefs')!)).toMatchObject({ hand: 'left', skinAuto: true, buddy: true });
    // The anchor is deleted once, when the next session starts.
    expect(takeAnchorsToForget()).toEqual(['anchor-1']);
    expect(takeAnchorsToForget()).toEqual([]);
  });

  it('does nothing harmful with nothing saved', async () => {
    const { resetDemo } = await import('./demoReset');
    const { takeAnchorsToForget } = await import('../mat/lib/matStore');
    resetDemo();
    expect(takeAnchorsToForget()).toEqual([]);
  });
});
