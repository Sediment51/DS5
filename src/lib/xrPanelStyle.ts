/**
 * One look for every headset panel, drawn on canvases: the app's light card,
 * DM Sans, ink text and one green accent. Every control has the same states,
 * and each state shows by shape, icon or words as well as colour:
 *
 *   default      light fill
 *   hover        green outline (a fingertip is over it)
 *   selected     green fill, white text (an option that's on)
 *   active       green fill + ▾ (a menu that's open)
 *   processing   "…" after the label, a soft green fill
 *   completed    ✓ before the label
 *   unavailable  pale, muted text, ⚠ before the label
 */
export type UIState = 'default' | 'hover' | 'selected' | 'active' | 'processing' | 'completed' | 'unavailable';

export const UI = {
  card: 'rgba(251, 250, 247, 0.95)',
  ink: '#1f2a24',
  muted: '#6b746f',
  line: '#d6dbd8',
  fill: '#e4e8e5',
  green: '#2f9e63',
  greenSoft: 'rgba(47, 158, 99, 0.14)',
  greenGlow: 'rgba(47, 158, 99, 0.22)',
  amber: '#c98a1a',
  white: '#ffffff',
  font: '"DM Sans", system-ui, sans-serif',
} as const;

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function font(ctx: CanvasRenderingContext2D, px: number, weight = 600) {
  ctx.font = `${weight} ${Math.round(px)}px ${UI.font}`;
}

function roundRect(ctx: CanvasRenderingContext2D, r: PxRect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.h / 2, r.w / 2));
}

/** The panel's card. A hand on it (to carry it) turns its border green. */
export function drawCard(ctx: CanvasRenderingContext2D, w: number, h: number, grab: 'none' | 'hover' | 'held' = 'none') {
  ctx.clearRect(0, 0, w, h);
  const r: PxRect = { x: 4, y: 4, w: w - 8, h: h - 8 };
  ctx.fillStyle = grab === 'held' ? '#e6f6ec' : UI.card;
  roundRect(ctx, r, 44);
  ctx.fill();
  if (grab !== 'none') {
    ctx.lineWidth = 8;
    ctx.strokeStyle = UI.green;
    ctx.stroke();
  }
}

/** A panel title, with an optional value on the right ("Opacity … 80%"). */
export function drawTitle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, title: string, value?: string, px = 46) {
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = UI.ink;
  font(ctx, px, 700);
  ctx.fillText(title, x, y);
  if (value) {
    ctx.textAlign = 'right';
    ctx.fillStyle = UI.green;
    ctx.fillText(value, x + w, y);
  }
}

/** A small line of status or help text, with an optional leading icon tone. */
export function drawNote(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  tone: 'muted' | 'ok' | 'warn' = 'muted',
  px = 32,
  align: CanvasTextAlign = 'left',
) {
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  font(ctx, px, 500);
  ctx.fillStyle = tone === 'ok' ? UI.green : tone === 'warn' ? UI.amber : UI.muted;
  ctx.fillText(text, x, y);
}

/** A button. `primary` makes it the green call to action. */
export function drawButton(
  ctx: CanvasRenderingContext2D,
  r: PxRect,
  label: string,
  state: UIState,
  { primary = false, px = 38 }: { primary?: boolean; px?: number } = {},
) {
  const on = primary || state === 'selected' || state === 'active' || state === 'completed';
  const off = state === 'unavailable';
  ctx.fillStyle = off ? '#eef0ee' : state === 'processing' ? UI.greenSoft : on ? UI.green : UI.fill;
  roundRect(ctx, r, 26);
  ctx.fill();
  if (state === 'hover') {
    ctx.lineWidth = 8;
    ctx.strokeStyle = primary ? UI.ink : UI.green;
    ctx.stroke();
  }
  let text = label;
  if (state === 'completed') text = `✓ ${label}`;
  else if (state === 'processing') text = `${label}…`;
  else if (state === 'active') text = `${label} ▾`;
  else if (off) text = `⚠ ${label}`;
  ctx.fillStyle = off ? UI.muted : on && state !== 'processing' ? UI.white : UI.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  font(ctx, px, 600);
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + 2, r.w - 24);
}

/** A labelled on/off switch: the label on the left, a pill saying On / Off on the right. */
export function drawToggle(ctx: CanvasRenderingContext2D, r: PxRect, label: string, on: boolean, hover: boolean, px = 36) {
  if (hover) {
    ctx.fillStyle = UI.greenSoft;
    roundRect(ctx, r, 22);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = UI.ink;
  font(ctx, px, 500);
  ctx.fillText(label, r.x + 18, r.y + r.h / 2 + 2);
  const pill: PxRect = { x: r.x + r.w - 150, y: r.y + r.h / 2 - 28, w: 132, h: 56 };
  ctx.fillStyle = on ? UI.green : UI.fill;
  roundRect(ctx, pill, 28);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(on ? pill.x + pill.w - 28 : pill.x + 28, pill.y + 28, 21, 0, Math.PI * 2);
  ctx.fillStyle = UI.white;
  ctx.fill();
  ctx.fillStyle = on ? UI.white : UI.muted;
  ctx.textAlign = 'center';
  font(ctx, 26, 700);
  ctx.fillText(on ? 'ON' : 'OFF', on ? pill.x + 46 : pill.x + pill.w - 46, pill.y + 30);
}

/** A row of exclusive options (one selected). */
export function drawSegmented(
  ctx: CanvasRenderingContext2D,
  r: PxRect,
  options: readonly string[],
  selected: number,
  hover: number,
  px = 34,
) {
  ctx.fillStyle = UI.fill;
  roundRect(ctx, r, 26);
  ctx.fill();
  const w = r.w / options.length;
  options.forEach((label, i) => {
    const cell: PxRect = { x: r.x + i * w + 5, y: r.y + 5, w: w - 10, h: r.h - 10 };
    if (i === selected) {
      ctx.fillStyle = UI.green;
      roundRect(ctx, cell, 22);
      ctx.fill();
    } else if (i === hover) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = UI.green;
      roundRect(ctx, cell, 22);
      ctx.stroke();
    }
    ctx.fillStyle = i === selected ? UI.white : UI.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, px, 600);
    ctx.fillText(label, cell.x + cell.w / 2, cell.y + cell.h / 2 + 2, cell.w - 12);
  });
}

/**
 * A slider: the track glows while a finger hovers it; while it's held the knob
 * grows, fills and carries a bubble with the value.
 */
export function drawSlider(
  ctx: CanvasRenderingContext2D,
  r: PxRect,
  value: number,
  grip: 'idle' | 'hover' | 'held',
  bubble?: string,
) {
  const cy = r.y + r.h / 2;
  const x0 = r.x;
  const x1 = r.x + r.w;
  ctx.lineCap = 'round';
  if (grip !== 'idle') {
    ctx.lineWidth = 48;
    ctx.strokeStyle = grip === 'held' ? UI.greenGlow : UI.greenSoft;
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.lineTo(x1, cy);
    ctx.stroke();
  }
  ctx.lineWidth = 14;
  ctx.strokeStyle = UI.line;
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(x1, cy);
  ctx.stroke();
  const knob = x0 + (x1 - x0) * Math.min(Math.max(value, 0), 1);
  ctx.strokeStyle = UI.green;
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(Math.max(knob, x0 + 0.1), cy);
  ctx.stroke();
  ctx.fillStyle = grip === 'held' ? UI.green : UI.white;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(knob, cy, grip === 'held' ? 34 : grip === 'hover' ? 30 : 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (grip === 'held' && bubble) {
    font(ctx, 32, 700);
    const w = ctx.measureText(bubble).width + 36;
    const b: PxRect = { x: knob - w / 2, y: cy - 108, w, h: 56 };
    ctx.fillStyle = UI.ink;
    roundRect(ctx, b, 28);
    ctx.fill();
    ctx.fillStyle = UI.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bubble, knob, b.y + b.h / 2 + 2);
  }
}

/** A colour swatch; the selected one has a ring and a tick. */
export function drawSwatch(ctx: CanvasRenderingContext2D, r: PxRect, color: string, selected: boolean, hover: boolean) {
  ctx.fillStyle = color;
  roundRect(ctx, r, 18);
  ctx.fill();
  if (selected || hover) {
    ctx.lineWidth = selected ? 10 : 6;
    ctx.strokeStyle = UI.green;
    roundRect(ctx, { x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 }, 22);
    ctx.stroke();
  }
  if (selected) {
    ctx.fillStyle = UI.white;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 6;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, 40, 700);
    ctx.strokeText('✓', r.x + r.w / 2, r.y + r.h / 2 + 2);
    ctx.fillText('✓', r.x + r.w / 2, r.y + r.h / 2 + 2);
  }
}

/** A round status icon: ✓ (ok), ! (warn) or i (info). */
export function drawIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, tone: 'info' | 'ok' | 'warn') {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = tone === 'ok' ? UI.green : tone === 'warn' ? UI.amber : UI.ink;
  ctx.fill();
  ctx.fillStyle = UI.white;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  font(ctx, radius * 1.2, 700);
  ctx.fillText(tone === 'ok' ? '✓' : tone === 'warn' ? '!' : 'i', cx, cy + radius * 0.06);
}

/** Splits text into lines that fit `maxWidth` (at the current font), at most `maxLines`. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+\S*$/, '')}…`;
  }
  return lines;
}
