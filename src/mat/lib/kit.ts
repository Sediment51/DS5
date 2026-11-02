/**
 * The kit: what goes on the mat. Loaded at run time from
 * public/material-mat/materials.json (sizes in centimetres there), checked,
 * and converted to metres here.
 */

/** Footprint shapes as written in materials.json (cm). A pill or rect runs left to right. */
export type FootprintJson =
  | { shape: 'circle'; diameter: number }
  | { shape: 'rect'; width: number; depth: number }
  | { shape: 'pill'; length: number; width: number };

/** An optional true-scale model of "how much" (cm / ml). */
export type QuantityVisualJson =
  | { type: 'sphere'; diameter: number; color?: string }
  | { type: 'blob'; volumeMl: number; color?: string }
  | { type: 'drops'; count: number; dropMl?: number; color?: string };

export interface KitItemJson {
  id: string;
  step: number;
  name: string;
  purpose: string;
  quantity: string;
  footprint: FootprintJson;
  quantityVisual?: QuantityVisualJson | null;
  /** Related items share a group; each group starts a new row. */
  group?: string;
  /** Build stages (1–6) the item is used in. */
  stages?: number[];
}

export interface KitJson {
  $schema?: string;
  title: string;
  items: KitItemJson[];
}

/** A footprint in metres: `width` along the mat's X (left to right), `depth` along Z. */
export interface Footprint {
  shape: 'circle' | 'rect' | 'pill';
  width: number;
  depth: number;
}

/** A quantity model in metres, with the space it takes on the table. */
export type QuantityVisual = { color: string; width: number; depth: number } & (
  | { type: 'sphere'; radius: number }
  /** A dome: `radius` across, `height` tall (half its radius). */
  | { type: 'blob'; radius: number; height: number }
  | { type: 'drops'; count: number; radius: number; height: number; spacing: number }
);

export interface KitItem {
  id: string;
  step: number;
  name: string;
  purpose: string;
  quantity: string;
  footprint: Footprint;
  visual: QuantityVisual | null;
  group: string | null;
  /** Build stages it's used in (empty: none given). */
  stages: number[];
}

export interface Kit {
  title: string;
  /** In step order. */
  items: KitItem[];
}

export type KitResult = { ok: true; kit: Kit } | { ok: false; errors: string[] };

const CM = 0.01;
/** Most items the mat can draw (its per-slot shader array). */
export const MAX_ITEMS = 64;
/** Anything bigger than this (cm) is surely a typo. */
const MAX_SIZE_CM = 200;
const MAX_GROUP_LENGTH = 24;
const MAX_STAGE = 20;
/** Volume of one drop if not given (ml). */
const DEFAULT_DROP_ML = 0.05;
/** Gap between drops (m). */
const DROP_GAP = 0.004;
const DEFAULT_COLORS = { sphere: '#e8c8ad', blob: '#7a0d12', drops: '#9c1016' };

/** Radius of a dome of volume `ml` whose height is half its radius: V = (1/3)πr³. */
export function domeRadius(ml: number): number {
  return Math.cbrt((3 * ml) / Math.PI) * CM;
}

/** Checks parsed JSON and converts it to a Kit, or lists every problem found. */
export function parseKit(json: unknown): KitResult {
  const errors: string[] = [];
  if (!isObject(json)) return { ok: false, errors: ['The file must contain a JSON object with "title" and "items".'] };
  const title = typeof json.title === 'string' && json.title.trim() ? json.title.trim() : '';
  if (!title) errors.push('"title" must be a non-empty string.');
  if (!Array.isArray(json.items) || json.items.length === 0) {
    errors.push('"items" must be a non-empty list.');
    return { ok: false, errors };
  }
  if (json.items.length > MAX_ITEMS) errors.push(`"items" can hold at most ${MAX_ITEMS} items.`);

  const items: KitItem[] = [];
  const ids = new Set<string>();
  json.items.forEach((raw: unknown, index: number) => {
    const where = isObject(raw) && typeof raw.id === 'string' ? `items[${index}] (${raw.id})` : `items[${index}]`;
    const fail = (message: string) => errors.push(`${where}: ${message}`);
    if (!isObject(raw)) return fail('must be an object.');

    const id = raw.id;
    if (typeof id !== 'string' || !id.trim()) fail('"id" must be a non-empty string.');
    else if (ids.has(id)) fail(`"id" "${id}" is used twice.`);
    else ids.add(id);
    if (typeof raw.step !== 'number' || !Number.isFinite(raw.step)) fail('"step" must be a number.');
    for (const key of ['name', 'purpose', 'quantity'] as const) {
      if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) fail(`"${key}" must be a non-empty string.`);
    }
    const footprint = parseFootprint(raw.footprint, fail);
    const visual = raw.quantityVisual == null ? null : parseVisual(raw.quantityVisual, fail);
    let group: string | null = null;
    if (raw.group !== undefined) {
      if (typeof raw.group !== 'string' || !raw.group.trim() || raw.group.trim().length > MAX_GROUP_LENGTH) {
        fail(`"group" must be a short name (1 to ${MAX_GROUP_LENGTH} characters).`);
      } else group = raw.group.trim();
    }
    let stages: number[] = [];
    if (raw.stages !== undefined) {
      if (!Array.isArray(raw.stages) || !raw.stages.every((s) => Number.isInteger(s) && s >= 1 && s <= MAX_STAGE)) {
        fail(`"stages" must be a list of stage numbers from 1 to ${MAX_STAGE}.`);
      } else stages = [...new Set(raw.stages as number[])];
    }
    if (typeof id === 'string' && footprint && visual !== undefined && typeof raw.step === 'number') {
      items.push({
        id,
        step: raw.step,
        name: String(raw.name).trim(),
        purpose: String(raw.purpose).trim(),
        quantity: String(raw.quantity).trim(),
        footprint,
        visual,
        group,
        stages,
      });
    }
  });
  if (errors.length) return { ok: false, errors };
  // Stable: items with the same step keep their file order.
  items.sort((a, b) => a.step - b.step);
  return { ok: true, kit: { title, items } };
}

function parseFootprint(raw: unknown, fail: (message: string) => void): Footprint | null {
  if (!isObject(raw)) {
    fail('"footprint" must be an object with a "shape".');
    return null;
  }
  const size = (key: string) => {
    const value = raw[key];
    if (typeof value !== 'number' || !(value > 0) || value > MAX_SIZE_CM) {
      fail(`"footprint.${key}" must be a size in cm (more than 0, at most ${MAX_SIZE_CM}).`);
      return NaN;
    }
    return value * CM;
  };
  switch (raw.shape) {
    case 'circle': {
      const d = size('diameter');
      return Number.isNaN(d) ? null : { shape: 'circle', width: d, depth: d };
    }
    case 'rect': {
      const w = size('width');
      const d = size('depth');
      return Number.isNaN(w + d) ? null : { shape: 'rect', width: w, depth: d };
    }
    case 'pill': {
      const l = size('length');
      const w = size('width');
      if (Number.isNaN(l + w)) return null;
      if (w > l) {
        fail('"footprint.width" of a pill must not exceed its "length".');
        return null;
      }
      return { shape: 'pill', width: l, depth: w };
    }
    default:
      fail('"footprint.shape" must be "circle", "rect" or "pill".');
      return null;
  }
}

/** The visual in metres; null for none; undefined if invalid. */
function parseVisual(raw: unknown, fail: (message: string) => void): QuantityVisual | null | undefined {
  if (!isObject(raw)) {
    fail('"quantityVisual" must be an object or null.');
    return undefined;
  }
  const color = raw.color === undefined ? undefined : raw.color;
  if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) {
    fail('"quantityVisual.color" must be a colour like "#7a0d12".');
    return undefined;
  }
  const positive = (key: string, max: number) => {
    const value = raw[key];
    if (typeof value !== 'number' || !(value > 0) || value > max) {
      fail(`"quantityVisual.${key}" must be more than 0 and at most ${max}.`);
      return NaN;
    }
    return value;
  };
  switch (raw.type) {
    case 'sphere': {
      const d = positive('diameter', 20);
      if (Number.isNaN(d)) return undefined;
      const r = (d / 2) * CM;
      return { type: 'sphere', radius: r, width: 2 * r, depth: 2 * r, color: color ?? DEFAULT_COLORS.sphere };
    }
    case 'blob': {
      const ml = positive('volumeMl', 100);
      if (Number.isNaN(ml)) return undefined;
      const r = domeRadius(ml);
      return { type: 'blob', radius: r, height: r / 2, width: 2 * r, depth: 2 * r, color: color ?? DEFAULT_COLORS.blob };
    }
    case 'drops': {
      const count = positive('count', 12);
      if (Number.isNaN(count) || !Number.isInteger(count)) {
        if (!Number.isNaN(count)) fail('"quantityVisual.count" must be a whole number.');
        return undefined;
      }
      const ml = raw.dropMl === undefined ? DEFAULT_DROP_ML : positive('dropMl', 5);
      if (Number.isNaN(ml)) return undefined;
      const r = domeRadius(ml);
      const spacing = 2 * r + DROP_GAP;
      return {
        type: 'drops',
        count,
        radius: r,
        height: r / 2,
        spacing,
        width: spacing * (count - 1) + 2 * r,
        depth: 2 * r,
        color: color ?? DEFAULT_COLORS.drops,
      };
    }
    default:
      fail('"quantityVisual.type" must be "sphere", "blob" or "drops".');
      return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fetches and checks the kit file next to the page. */
export async function loadKit(): Promise<KitResult> {
  const url = new URL('material-mat/materials.json', document.baseURI);
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    return { ok: false, errors: [`Couldn’t load ${url.pathname}: ${String(err)}`] };
  }
  if (!response.ok) return { ok: false, errors: [`Couldn’t load ${url.pathname} (HTTP ${response.status}).`] };
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { ok: false, errors: [`materials.json isn’t valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return parseKit(json);
}
