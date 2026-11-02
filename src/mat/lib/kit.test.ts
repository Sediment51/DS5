import { describe, expect, it } from 'vitest';
import seedFile from '../../../public/material-mat/materials.json';
import { domeRadius, parseKit } from './kit';

/** The seed file, loosely typed so tests can break it. */
const seedJson = () => structuredClone(seedFile) as unknown as { items: Record<string, unknown>[] };

describe('parseKit', () => {
  it('accepts the bundled materials.json: 9 items in step order, sizes in metres', () => {
    const result = parseKit(seedJson());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { items } = result.kit;
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const wax = items.find((i) => i.id === 'scar-wax')!;
    expect(wax.footprint).toEqual({ shape: 'circle', width: 0.07, depth: 0.07 });
    expect(wax.visual).toMatchObject({ type: 'sphere', radius: 0.008 });
    const tool = items.find((i) => i.id === 'sculpting-tool')!;
    expect(tool.footprint).toEqual({ shape: 'pill', width: 0.16, depth: 0.016 });
  });

  it('reads groups and stages', () => {
    const result = parseKit(seedJson());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { items } = result.kit;
    expect([...new Set(items.map((i) => i.group))]).toEqual(['Prep', 'Build', 'Colour', 'Finish']);
    expect(items.find((i) => i.id === 'fake-blood')!.stages).toEqual([5]);
  });

  it('sorts by step, keeping file order for equal steps', () => {
    const json = seedJson();
    json.items = [json.items[2], json.items[0], { ...json.items[1], id: 'x', step: 1 }];
    const result = parseKit(json);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.kit.items.map((i) => i.id)).toEqual(['cotton-pads', 'x', 'scar-wax']);
  });

  it('lists every problem with where it is', () => {
    const json = seedJson();
    json.items[0].footprint = { shape: 'circle' };
    json.items[1].quantity = '';
    json.items[2].id = 'cotton-pads';
    json.items[3].quantityVisual = { type: 'cube', size: 2 };
    json.items[4].stages = [0, 'two'];
    json.items[5].group = '';
    const result = parseKit(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'items[0] (cotton-pads): "footprint.diameter" must be a size in cm (more than 0, at most 200).',
      'items[1] (petroleum-jelly): "quantity" must be a non-empty string.',
      'items[2] (cotton-pads): "id" "cotton-pads" is used twice.',
      'items[3] (sculpting-tool): "quantityVisual.type" must be "sphere", "blob" or "drops".',
      'items[4] (colour-palette): "stages" must be a list of stage numbers from 1 to 20.',
      'items[5] (eyeshadow-palette): "group" must be a short name (1 to 24 characters).',
    ]);
  });

  it('sizes a ½ teaspoon blob of blood by its volume', () => {
    // A dome r across and r/2 tall holds (1/3)πr³: 2.5 ml → r ≈ 1.34 cm.
    expect(domeRadius(2.5)).toBeCloseTo(0.01337, 4);
  });
});
