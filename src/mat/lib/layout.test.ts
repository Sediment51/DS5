import { describe, expect, it } from 'vitest';
import seedFile from '../../../public/material-mat/materials.json';
import { parseKit } from './kit';
import { LAYOUT, cellSize, compareSize, layoutKit, type SlotLayout } from './layout';

const seed = parseKit(structuredClone(seedFile));
if (!seed.ok) throw new Error(seed.errors.join('\n'));
const items = seed.kit.items;
const count = items.length;

const overlaps = (a: SlotLayout, b: SlotLayout) =>
  a.left < b.left + b.width - 1e-9 &&
  b.left < a.left + a.width - 1e-9 &&
  a.back < b.back + b.depth - 1e-9 &&
  b.back < a.back + a.depth - 1e-9;

describe('layoutKit', () => {
  it('fits the whole kit on one page of an 80 × 60 cm mat, inside the margins, without overlaps', () => {
    const layout = layoutKit(items, 0.8, 0.6);
    expect(layout.pages).toBe(1);
    expect(layout.slots).toHaveLength(count);
    for (const s of layout.slots) {
      expect(s.left).toBeGreaterThanOrEqual(-0.4 + LAYOUT.margin - 1e-9);
      expect(s.left + s.width).toBeLessThanOrEqual(0.4 - LAYOUT.margin + 1e-9);
      expect(s.back).toBeGreaterThanOrEqual(-0.3 + LAYOUT.margin - 1e-9);
      expect(s.back + s.depth).toBeLessThanOrEqual(0.3 - LAYOUT.margin + 1e-9);
      expect(s.oversize).toBe(false);
    }
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(overlaps(layout.slots[i], layout.slots[j])).toBe(false);
  });

  it('keeps step order: left to right, then the next row further forward', () => {
    const { slots } = layoutKit(items, 0.8, 0.6);
    for (let i = 1; i < slots.length; i++) {
      const [a, b] = [slots[i - 1], slots[i]];
      const sameRow = Math.abs(a.back - b.back) < 1e-9;
      if (sameRow) expect(b.left).toBeGreaterThan(a.left);
      else expect(b.back).toBeGreaterThan(a.back);
    }
  });

  it('starts a new row for each group', () => {
    const { slots } = layoutKit(items, 0.8, 0.6);
    for (let i = 1; i < slots.length; i++) {
      if (items[i].group !== items[i - 1].group) expect(slots[i].back).toBeGreaterThan(slots[i - 1].back);
    }
  });

  it('pages a small mat, every item exactly once, each page within the mat', () => {
    const layout = layoutKit(items, 0.3, 0.22);
    expect(layout.pages).toBeGreaterThan(2);
    expect(layout.slots.map((s) => s.item)).toEqual(items.map((_, i) => i));
    const pages = layout.slots.map((s) => s.page);
    expect(pages).toEqual([...pages].sort((a, b) => a - b)); // step order runs through the pages
    for (const s of layout.slots) {
      expect(s.back).toBeGreaterThanOrEqual(-0.11 + LAYOUT.margin - 1e-9);
      expect(s.back + s.depth).toBeLessThanOrEqual(0.11 - LAYOUT.margin + 1e-9);
    }
  });

  it('keeps footprints at true scale, each in its own padded cell, with a compare spot beside them', () => {
    const withVisual = [{ footprint: { width: 0.06, depth: 0.06 }, visual: { width: 0.016, depth: 0.016 } }];
    const [slot] = layoutKit(withVisual, 0.8, 0.5).slots;
    const compare = compareSize(withVisual[0].visual);
    expect(compare).toBeCloseTo(0.03, 9);
    expect(slot.compare).toBeCloseTo(compare, 9);
    expect(slot.footprintX).toBeCloseTo(slot.left + LAYOUT.pad + 0.03, 9);
    expect(slot.visualX - slot.footprintX).toBeCloseTo(0.03 + LAYOUT.visualGap + compare / 2, 9);
    expect(slot.width).toBeCloseTo(cellSize(withVisual[0]).width, 9);
  });

  it('numbers one section per group, with a header column on the left', () => {
    const layout = layoutKit(items, 0.8, 0.6);
    expect(layout.sections.map((s) => [s.number, s.label])).toEqual([
      [1, 'Prep'],
      [2, 'Build'],
      [3, 'Colour'],
      [4, 'Finish'],
    ]);
    expect(layout.sections.map((s) => s.last)).toEqual([false, false, false, true]);
    for (const s of layout.slots) expect(s.left).toBeGreaterThanOrEqual(layout.sections[0].left + LAYOUT.header - 1e-9);
  });

  it('has no header column without groups', () => {
    const plain = [{ footprint: { width: 0.05, depth: 0.05 }, visual: null }];
    const layout = layoutKit(plain, 0.4, 0.3);
    expect(layout.sections).toEqual([]);
    expect(layout.slots[0].left).toBeCloseTo(-cellSize(plain[0]).width / 2, 9);
  });

  it('flags an item bigger than the mat', () => {
    const big = [{ footprint: { width: 0.5, depth: 0.1 }, visual: null }];
    expect(layoutKit(big, 0.3, 0.3).slots[0].oversize).toBe(true);
  });
});
