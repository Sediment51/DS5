/**
 * Lays the kit out on the mat at true scale: one cell per item, in step
 * order, left to right in rows that run from the back of the mat to the
 * front (like reading a page lying on the table), with more pages when it
 * doesn't all fit. Units are metres in mat space: x to the right, z towards
 * the user, origin at the mat's centre.
 *
 * A cell is the item's footprint (where the real object goes), its quantity
 * model to the right of it, and a strip in front for the label.
 */

export const LAYOUT = {
  /** Clear border inside the mat's edge. */
  margin: 0.025,
  /** Space between cells in a row. */
  gutter: 0.02,
  /** Space between rows. */
  rowGap: 0.015,
  /**
   * Strip in front of each footprint where its label stands. Deep enough
   * that a label leaning back towards the user's eyes stays clear of the
   * outline behind it.
   */
  labelDepth: 0.06,
  /** A cell is at least this wide so its label has room. */
  minCellWidth: 0.12,
  /** Space between a footprint and its quantity model. */
  visualGap: 0.012,
};

export interface LayoutItem {
  footprint: { width: number; depth: number };
  visual: { width: number; depth: number } | null;
  /** Items of a group sit together: a new group starts a new row. */
  group?: string | null;
}

export interface SlotLayout {
  /** Index into the items given. */
  item: number;
  page: number;
  /** The cell: left edge, back edge, and size. */
  left: number;
  back: number;
  width: number;
  depth: number;
  /** Centre of the footprint outline. */
  footprintX: number;
  footprintZ: number;
  /** Centre of the quantity model (when there is one). */
  visualX: number;
  visualZ: number;
  /** Where the label stands: its left end, on the table. */
  labelX: number;
  labelZ: number;
  /** The cell is bigger than the whole mat. */
  oversize: boolean;
}

export interface MatLayout {
  pages: number;
  slots: SlotLayout[];
}

interface Cell {
  item: number;
  width: number;
  depth: number;
}

export function cellSize(item: LayoutItem): { width: number; depth: number } {
  const visualWidth = item.visual ? LAYOUT.visualGap + item.visual.width : 0;
  const width = Math.max(item.footprint.width + visualWidth, LAYOUT.minCellWidth);
  const depth = Math.max(item.footprint.depth, item.visual?.depth ?? 0) + LAYOUT.labelDepth;
  return { width, depth };
}

/** Lays out `items` (already in step order) on a matWidth × matDepth mat. */
export function layoutKit(items: LayoutItem[], matWidth: number, matDepth: number): MatLayout {
  const innerWidth = matWidth - 2 * LAYOUT.margin;
  const innerDepth = matDepth - 2 * LAYOUT.margin;

  // Pack cells into rows, and rows into pages.
  const pages: Cell[][][] = [];
  let page: Cell[][] = [];
  let row: Cell[] = [];
  let rowWidth = 0;
  const rowDepth = (r: Cell[]) => Math.max(...r.map((c) => c.depth));
  const pageDepth = (p: Cell[][]) => p.reduce((sum, r) => sum + rowDepth(r), 0) + LAYOUT.rowGap * Math.max(p.length - 1, 0);
  const closeRow = () => {
    if (row.length === 0) return;
    if (page.length > 0 && pageDepth(page) + LAYOUT.rowGap + rowDepth(row) > innerDepth) {
      pages.push(page);
      page = [];
    }
    page.push(row);
    row = [];
    rowWidth = 0;
  };
  items.forEach((item, index) => {
    const { width, depth } = cellSize(item);
    const added = row.length ? LAYOUT.gutter + width : width;
    const newGroup = index > 0 && (item.group ?? null) !== (items[index - 1].group ?? null);
    if (row.length > 0 && (newGroup || rowWidth + added > innerWidth)) closeRow();
    rowWidth += row.length ? LAYOUT.gutter + width : width;
    row.push({ item: index, width, depth });
  });
  closeRow();
  if (page.length) pages.push(page);

  // Place each page's block of rows in the middle of the mat.
  const slots: SlotLayout[] = [];
  pages.forEach((rows, pageIndex) => {
    const blockWidth = Math.max(...rows.map((r) => r.reduce((w, c) => w + c.width, 0) + LAYOUT.gutter * (r.length - 1)));
    let back = -pageDepth(rows) / 2;
    for (const r of rows) {
      let left = -blockWidth / 2;
      const depth = rowDepth(r);
      for (const cell of r) {
        const item = items[cell.item];
        const fw = item.footprint.width;
        const contentDepth = cell.depth - LAYOUT.labelDepth;
        const footprintZ = back + contentDepth / 2;
        slots.push({
          item: cell.item,
          page: pageIndex,
          left,
          back,
          width: cell.width,
          depth: cell.depth,
          footprintX: left + fw / 2,
          footprintZ,
          visualX: item.visual ? left + fw + LAYOUT.visualGap + item.visual.width / 2 : left,
          visualZ: footprintZ,
          labelX: left,
          labelZ: back + contentDepth + LAYOUT.labelDepth * 0.92,
          oversize: cell.width > innerWidth + 1e-9 || cell.depth > innerDepth + 1e-9,
        });
        left += cell.width + LAYOUT.gutter;
      }
      back += depth + LAYOUT.rowGap;
    }
  });
  slots.sort((a, b) => a.item - b.item);
  return { pages: pages.length, slots };
}
