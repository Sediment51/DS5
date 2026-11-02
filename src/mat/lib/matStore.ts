/** The last mat, so it can be restored in a later session (persistent anchors only). */
export interface SavedMat {
  /** Persistent anchor handle (UUID) from XRAnchor.requestPersistentHandle(). */
  handle: string;
  /** Mat size in metres. */
  width: number;
  depth: number;
  savedAt: number;
  /** Where its control panel was moved to: a 4×4 pose relative to the mat. */
  panel?: number[];
}

const MAT_KEY = 'material-mat:last';
const OPACITY_KEY = 'material-mat:opacity';
/** Persistent anchors of forgotten mats, deleted when the next session starts. */
const FORGET_KEY = 'material-mat:forget';

export function loadSavedMat(): SavedMat | null {
  try {
    const value = JSON.parse(localStorage.getItem(MAT_KEY) ?? 'null') as Partial<SavedMat> | null;
    if (
      value &&
      typeof value.handle === 'string' &&
      typeof value.width === 'number' &&
      typeof value.depth === 'number' &&
      value.width > 0 &&
      value.depth > 0
    ) {
      const panel =
        Array.isArray(value.panel) && value.panel.length === 16 && value.panel.every(Number.isFinite)
          ? value.panel
          : undefined;
      return { handle: value.handle, width: value.width, depth: value.depth, savedAt: value.savedAt ?? 0, panel };
    }
  } catch {
    // Storage blocked or bad JSON: nothing to restore.
  }
  return null;
}

export function saveMat(mat: SavedMat) {
  try {
    localStorage.setItem(MAT_KEY, JSON.stringify(mat));
  } catch {
    // Not fatal: the mat just won't be restorable.
  }
}

export function clearSavedMat() {
  try {
    localStorage.removeItem(MAT_KEY);
  } catch {
    // ignore
  }
}

/** Overlay opacity 0..1, default 0.85. */
export function loadOpacity(): number {
  try {
    const value = Number(localStorage.getItem(OPACITY_KEY));
    if (localStorage.getItem(OPACITY_KEY) !== null && Number.isFinite(value)) return Math.min(Math.max(value, 0), 1);
  } catch {
    // ignore
  }
  return 0.85;
}

export function saveOpacity(value: number) {
  try {
    localStorage.setItem(OPACITY_KEY, String(Math.round(value * 100) / 100));
  } catch {
    // ignore
  }
}

/**
 * Forgets the mat and its opacity (Reset demo). Its persistent anchor can
 * only be deleted inside a session, so its handle is kept to delete next
 * time one starts (see takeAnchorsToForget).
 */
export function forgetMat() {
  try {
    const saved = loadSavedMat();
    if (saved) {
      const pending = anchorsToForget();
      if (!pending.includes(saved.handle)) pending.push(saved.handle);
      localStorage.setItem(FORGET_KEY, JSON.stringify(pending));
    }
    localStorage.removeItem(MAT_KEY);
    localStorage.removeItem(OPACITY_KEY);
  } catch {
    // Storage blocked: there's nothing saved to forget.
  }
}

/** Persistent anchors still to delete (and forgets the list): call once a session has started. */
export function takeAnchorsToForget(): string[] {
  const handles = anchorsToForget();
  try {
    localStorage.removeItem(FORGET_KEY);
  } catch {
    // ignore
  }
  return handles;
}

function anchorsToForget(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(FORGET_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}
