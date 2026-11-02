/**
 * Headset-mode settings, chosen on the in-headset menus and kept in
 * localStorage. Read every frame (no React state), so a change applies on the
 * next frame.
 */

export type HandSide = 'left' | 'right';

export interface XRPrefs {
  /** The only hand the wound goes on (never switches by itself). */
  hand: HandSide;
  /** Match the real palm's colour from the camera, when the headset allows it. */
  skinAuto: boolean;
  /** Skin tone preset (index into SKIN_PRESETS)… */
  skinPreset: number;
  /** …and a fine adjustment, 0..1 (0.5 = the preset as is). */
  skinFine: number;
  /** Show the tracked hand model as a wireframe over the real hand. */
  showHandMesh: boolean;
  /** Raise (+) or sink (−) the wound on the skin, mm. */
  skinHeightMm: number;
  /** Show the material names on the mat. */
  labels: boolean;
  /** Show Buddy, the mentor. */
  buddy: boolean;
  /** The mat's outline colour (index into MAT_ACCENTS). */
  matAccent: number;
  /** What the Opacity panel adjusts. */
  opacityTarget: 'wound' | 'mat';
}

const STORAGE_KEY = 'palm-injury.xr-prefs';

/** Skin tones from light to deep (sRGB). */
export const SKIN_PRESETS = ['#f1d3c2', '#e3b597', '#cf9a78', '#b07a57', '#8a5a3c', '#5e3b27'] as const;

/** Mat outline colours, for seeing it on light or dark tables. */
export const MAT_ACCENTS = [
  { name: 'Blue', color: '#7cc4ff' },
  { name: 'White', color: '#f4f3ee' },
  { name: 'Amber', color: '#ffc46b' },
] as const;

export const DEFAULT_PREFS: Readonly<XRPrefs> = {
  hand: 'left',
  skinAuto: true,
  skinPreset: 2,
  skinFine: 0.5,
  showHandMesh: false,
  skinHeightMm: 0,
  labels: true,
  buddy: true,
  matAccent: 0,
  opacityTarget: 'wound',
};

function load(): XRPrefs {
  const defaults = { ...DEFAULT_PREFS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<XRPrefs> | null;
    if (!saved) return defaults;
    const index = (value: unknown, length: number, fallback: number) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) < length ? (value as number) : fallback;
    return {
      hand: saved.hand === 'right' ? 'right' : 'left',
      skinAuto: saved.skinAuto !== false,
      skinPreset: index(saved.skinPreset, SKIN_PRESETS.length, defaults.skinPreset),
      skinFine: typeof saved.skinFine === 'number' ? Math.min(Math.max(saved.skinFine, 0), 1) : defaults.skinFine,
      showHandMesh: saved.showHandMesh === true,
      skinHeightMm: typeof saved.skinHeightMm === 'number' ? Math.min(Math.max(saved.skinHeightMm, -5), 5) : 0,
      labels: saved.labels !== false,
      buddy: saved.buddy !== false,
      matAccent: index(saved.matAccent, MAT_ACCENTS.length, defaults.matAccent),
      opacityTarget: saved.opacityTarget === 'mat' ? 'mat' : 'wound',
    };
  } catch {
    return defaults;
  }
}

/**
 * Current settings; `version` bumps on every change, `reattach` on every
 * Calibrate press. `autoWorking`: whether the camera colour is being read
 * (set by the wound; shown on the Colour panel).
 */
export const xrPrefs: XRPrefs & { version: number; reattach: number; autoWorking: boolean } = {
  ...load(),
  version: 0,
  reattach: 0,
  autoWorking: false,
};

export function setXRPrefs(patch: Partial<XRPrefs>) {
  Object.assign(xrPrefs, patch);
  xrPrefs.version++;
  try {
    const saved: XRPrefs = {
      hand: xrPrefs.hand,
      skinAuto: xrPrefs.skinAuto,
      skinPreset: xrPrefs.skinPreset,
      skinFine: xrPrefs.skinFine,
      showHandMesh: xrPrefs.showHandMesh,
      skinHeightMm: xrPrefs.skinHeightMm,
      labels: xrPrefs.labels,
      buddy: xrPrefs.buddy,
      matAccent: xrPrefs.matAccent,
      opacityTarget: xrPrefs.opacityTarget,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable: the settings last for this visit.
  }
}

/** Back to the defaults (the wound hand is kept: that's who's using it, not a look). */
export function resetXRPrefs() {
  setXRPrefs({ ...DEFAULT_PREFS, hand: xrPrefs.hand });
}

/** Everything back to the defaults, the wound hand too (Reset demo: as for a new user). */
export function resetAllXRPrefs() {
  setXRPrefs({ ...DEFAULT_PREFS });
}

/** Runtime status (not saved): redraws the panels when it changes. */
export function setAutoWorking(working: boolean) {
  if (xrPrefs.autoWorking === working) return;
  xrPrefs.autoWorking = working;
  xrPrefs.version++;
}

export function requestReattach() {
  xrPrefs.reattach++;
}
