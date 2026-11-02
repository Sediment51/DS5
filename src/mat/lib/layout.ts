/**
 * Lays the kit out on the mat like a recipe card: one numbered section per
 * group of the workflow (Prep, Build, Colour, Finish), from the back of the
 * mat to the front, each with its number and name in a column on the left
 * and a line under it. In a section every material has its own outlined
 * cell: the true-size outline where the real thing goes, beside it (when
 * the amount matters) a spot to compare the amount with a hologram, and in
 * front a flat label. More pages when it doesn't all fit. Units are metres
 * in mat space: x to the right, z towards the user, origin at the mat's centre.
 */

export const LAYOUT = {
  /** Clear border inside the mat's edge. */
  margin: 0.025,
  /** Space between cells in a row. */
  gutter: 0.012,
  /** Space between rows of a section… */
  rowGap: 0.01,
  /** …and the extra space between sections (the divider sits in it). */
  sectionGap: 0.012,
  /** The column on the left of each section with its number and name (when items have groups). */
  header: 0.064,
  /** Padding inside a cell's outline. */
  pad: 0.007,
  /** Strip at the front of each cell where its flat label lies. */
  labelDepth: 0.04,
  /** A cell is at least this wide so its label has room. */
  minCellWidth: 0.11,
  /** Space between a footprint and its compare spot. */
  visualGap: 0.012,
  /** The compare spot: the amount's own size plus this, and at least `compareMin` across. */
  compareMargin: 0.014,
  compareMin: 0.03,
};

export interface LayoutItem {
  footprint: { width: number; depth: number };
  /** The amount's true size, when it matters (a hologram shows it on a compare spot). */
  visual: { width: number; depth: number } | null;
  /** Items of a group sit together in a numbered section. */
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
  /** Centre of the compare spot (when there is one), and its diameter. */
  visualX: number;
  visualZ: number;
  compare: number;
  /** Where the flat label starts: its left end, at the front of the cell (it stacks back from there). */
  labelX: number;
  labelZ: number;
  /** The cell is bigger than the whole mat. */
  oversize: boolean;
}

/** A section's header and extent on a page (for its number, name and dividing line). */
export interface SectionLayout {
  page: number;
  /** 1-based section number, and its group's name. */
  number: number;
  label: string;
  /** Header column's left edge, the section's back edge and depth, and the block's width. */
  left: number;
  back: number;
  depth: number;
  width: number;
  /** The last section on its page (no line under it). */
  last: boolean;
}

export interface MatLayout {
  pages: number;
  slots: SlotLayout[];
  sections: SectionLayout[];
}

interface Cell {
  item: number;
  width: number;
  depth: number;
}

interface Row {
  cells: Cell[];
  /** Index of the row's group (sections), and whether it starts that group on its page. */
  group: number;
}

/** The compare spot's diameter for an amount, or 0. */
export function compareSize(visual: LayoutItem['visual']): number {
  if (!visual) return 0;
  return Math.max(Math.max(visual.width, visual.depth) + LAYOUT.compareMargin, LAYOUT.compareMin);
}

export function cellSize(item: LayoutItem): { width: number; depth: number } {
  const compare = compareSize(item.visual);
  const content = item.footprint.width + (compare ? LAYOUT.visualGap + compare : 0);
  const width = Math.max(content, LAYOUT.minCellWidth) + 2 * LAYOUT.pad;
  const depth = Math.max(item.footprint.depth, compare) + LAYOUT.labelDepth + 2 * LAYOUT.pad;
  return { width, depth };
}

/** Lays out `items` (already in step order) on a matWidth × matDepth mat. */
export function layoutKit(items: LayoutItem[], matWidth: number, matDepth: number): MatLayout {
  const grouped = items.some((item) => item.group);
  const header = grouped ? LAYOUT.header : 0;
  const innerWidth = matWidth - 2 * LAYOUT.margin - header;
  const innerDepth = matDepth - 2 * LAYOUT.margin;

  // Group names in order of first appearance: the section numbers.
  const groups: string[] = [];
  const groupOf = items.map((item) => {
    const name = item.group ?? '';
    let index = groups.indexOf(name);
    if (index < 0) index = groups.push(name) - 1;
    return index;
  });

  // Pack cells into rows (a new group starts a new row), and rows into pages.
  const rowDepth = (r: Row) => Math.max(...r.cells.map((c) => c.depth));
  const gapBefore = (page: Row[], r: Row) => (page.length === 0 ? 0 : page[page.length - 1].group === r.group ? LAYOUT.rowGap : LAYOUT.rowGap + LAYOUT.sectionGap);
  const pageDepth = (p: Row[]) => p.reduce((sum, r, i) => sum + rowDepth(r) + gapBefore(p.slice(0, i), r), 0);
  const pages: Row[][] = [];
  let page: Row[] = [];
  let row: Row = { cells: [], group: 0 };
  let rowWidth = 0;
  const closeRow = () => {
    if (row.cells.length === 0) return;
    if (page.length > 0 && pageDepth(page) + gapBefore(page, row) + rowDepth(row) > innerDepth) {
      pages.push(page);
      page = [];
    }
    page.push(row);
    row = { cells: [], group: 0 };
    rowWidth = 0;
  };
  items.forEach((item, index) => {
    const { width, depth } = cellSize(item);
    const added = row.cells.length ? LAYOUT.gutter + width : width;
    const newGroup = index > 0 && groupOf[index] !== groupOf[index - 1];
    if (row.cells.length > 0 && (newGroup || rowWidth + added > innerWidth)) closeRow();
    rowWidth += row.cells.length ? LAYOUT.gutter + width : width;
    row.group = groupOf[index];
    row.cells.push({ item: index, width, depth });
  });
  closeRow();
  if (page.length) pages.push(page);

  // Place each page's block of rows in the middle of the mat, the header column on its left.
  const slots: SlotLayout[] = [];
  const sections: SectionLayout[] = [];
  pages.forEach((rows, pageIndex) => {
    const rowsWidth = Math.max(...rows.map((r) => r.cells.reduce((w, c) => w + c.width, 0) + LAYOUT.gutter * (r.cells.length - 1)));
    const blockWidth = header + rowsWidth;
    const blockLeft = -blockWidth / 2;
    let back = -pageDepth(rows) / 2;
    rows.forEach((r, i) => {
      back += gapBefore(rows.slice(0, i), r);
      const depth = rowDepth(r);
      // A section starts here (its header and extent grow with each of its rows).
      if (grouped) {
        const current = sections[sections.length - 1];
        if (!current || current.page !== pageIndex || current.number !== r.group + 1) {
          sections.push({ page: pageIndex, number: r.group + 1, label: groups[r.group], left: blockLeft, back, depth, width: blockWidth, last: false });
        } else current.depth = back + depth - current.back;
      }
      let left = blockLeft + header;
      for (const cell of r.cells) {
        const item = items[cell.item];
        const fw = item.footprint.width;
        const compare = compareSize(item.visual);
        const contentDepth = cell.depth - LAYOUT.labelDepth - 2 * LAYOUT.pad;
        const footprintZ = back + LAYOUT.pad + contentDepth / 2;
        const inner = left + LAYOUT.pad;
        slots.push({
          item: cell.item,
          page: pageIndex,
          left,
          back,
          width: cell.width,
          depth: cell.depth,
          footprintX: inner + fw / 2,
          footprintZ,
          visualX: compare ? inner + fw + LAYOUT.visualGap + compare / 2 : inner,
          visualZ: footprintZ,
          compare,
          labelX: inner,
          labelZ: back + cell.depth - LAYOUT.pad,
          oversize: cell.width > innerWidth + 1e-9 || cell.depth > innerDepth + 1e-9,
        });
        left += cell.width + LAYOUT.gutter;
      }
      back += depth;
    });
  });
  for (let i = 0; i < sections.length; i++) sections[i].last = i === sections.length - 1 || sections[i + 1].page !== sections[i].page;
  slots.sort((a, b) => a.item - b.item);
  return { pages: pages.length, slots, sections };
}
