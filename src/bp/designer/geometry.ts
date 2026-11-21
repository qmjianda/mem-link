/**
 * Pure geometry for the structure designer.
 *
 * Everything here works in logical canvas coordinates. The React layer applies
 * pan/zoom with a CSS transform and converts pointer coordinates back with
 * these helpers; no document data is stored in pixels.
 */

export type RowBytes = 4 | 8 | 16 | 32;
export type BitOrder = 'lsb' | 'msb';
export const ROW_BYTES_OPTIONS: readonly RowBytes[] = [4, 8, 16, 32] as const;
export const CANVAS_ROW_H = 58;
export const CANVAS_GUTTER = 58;
export const CANVAS_PAD = 18;
export const CANVAS_RULER_H = 28;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

export interface CanvasGeometry {
  rowBytes: RowBytes;
  cellW: number;
  rowH: number;
  gutter: number;
  pad: number;
  rulerH: number;
  rows: number;
  width: number;
  height: number;
}

export interface FieldSegment {
  row: number;
  col: number;
  len: number;
  offset: number;
  first: boolean;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function cellWidth(rowBytes: RowBytes): number {
  return rowBytes <= 4 ? 112 : rowBytes <= 8 ? 76 : 54;
}

export function canvasGeometry(size: number, rowBytes: RowBytes): CanvasGeometry {
  const rows = Math.max(1, Math.ceil(Math.max(1, size) / rowBytes));
  const cellW = cellWidth(rowBytes);
  return {
    rowBytes,
    cellW,
    rowH: CANVAS_ROW_H,
    gutter: CANVAS_GUTTER,
    pad: CANVAS_PAD,
    rulerH: CANVAS_RULER_H,
    rows,
    width: CANVAS_PAD * 2 + CANVAS_GUTTER + rowBytes * cellW,
    height: CANVAS_PAD * 2 + CANVAS_RULER_H + rows * CANVAS_ROW_H,
  };
}

/** Split a field into row segments. Advances by the segment length, not row width. */
export function segments(offset: number, size: number, rowBytes: RowBytes): FieldSegment[] {
  const out: FieldSegment[] = [];
  const end = offset + size;
  let start = offset;
  while (start < end) {
    const row = Math.floor(start / rowBytes);
    const col = start % rowBytes;
    const len = Math.min(rowBytes - col, end - start);
    out.push({ row, col, len, offset: start, first: start === offset });
    start += len;
  }
  return out;
}

export function segmentRect(segment: FieldSegment, geo: CanvasGeometry): Rect {
  return {
    left: geo.pad + geo.gutter + segment.col * geo.cellW,
    top: geo.pad + geo.rulerH + segment.row * geo.rowH,
    width: segment.len * geo.cellW,
    height: geo.rowH,
  };
}

/** Raw logical offset under a point; row/column are not clamped to layout size. */
export function offsetAtPoint(x: number, y: number, geo: CanvasGeometry): number | null {
  const col = Math.floor((x - geo.pad - geo.gutter) / geo.cellW);
  const row = Math.floor((y - geo.pad - geo.rulerH) / geo.rowH);
  if (col < 0 || col >= geo.rowBytes || row < 0) return null;
  return row * geo.rowBytes + col;
}

export function pointAtOffset(offset: number, geo: CanvasGeometry): { x: number; y: number } {
  const row = Math.floor(offset / geo.rowBytes);
  const col = offset % geo.rowBytes;
  return {
    x: geo.pad + geo.gutter + col * geo.cellW + geo.cellW / 2,
    y: geo.pad + geo.rulerH + row * geo.rowH + geo.rowH / 2,
  };
}

export function clampOffset(offset: number, size: number): number {
  return Math.max(0, Math.min(Math.max(0, size - 1), Math.round(offset)));
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 100) / 100));
}

export function fitZoom(
  contentWidth: number, contentHeight: number,
  viewportWidth: number, viewportHeight: number,
): number {
  if (contentWidth <= 0 || contentHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return clampZoom(Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight, 1));
}

export interface BitGeometry {
  unit: number;
  bits: number;
  laneWidth: number;
  bitW: number;
  order: BitOrder;
}

export function bitGeometry(unit: number, laneWidth: number, order: BitOrder): BitGeometry {
  const bits = Math.max(1, unit * 8);
  const width = Math.max(1, laneWidth);
  return { unit, bits, laneWidth: width, bitW: width / bits, order };
}

export function bitRect(
  bit: number, width: number, geo: BitGeometry,
): { left: number; width: number } {
  const w = Math.max(1, Math.min(width, geo.bits));
  const b = Math.max(0, Math.min(bit, geo.bits - 1));
  const pos = geo.order === 'lsb' ? b : geo.bits - b - w;
  return { left: pos * geo.bitW, width: Math.max(1, w * geo.bitW) };
}

export function bitAtPoint(x: number, geo: BitGeometry): number {
  const p = Math.max(0, Math.min(0.999999, x / geo.laneWidth));
  const raw = Math.floor(p * geo.bits);
  return geo.order === 'lsb' ? raw : geo.bits - 1 - raw;
}

/** Positions of ruler ticks for a bit lane; labels are actual bit indices. */
export function bitTicks(bits: number, step: number): Array<{ pos: number; label: number }> {
  const out: Array<{ pos: number; label: number }> = [];
  for (let pos = 0; pos < bits; pos += Math.max(1, step)) out.push({ pos, label: pos });
  return out;
}
