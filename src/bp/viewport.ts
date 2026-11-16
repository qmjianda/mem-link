/**
 * 视口计算与降级判定（纯函数，零 React 依赖）。
 *
 * 坐标系约定：`Rect` 一律是世界坐标；`view` 是画布的平移/缩放
 * （`screen = world * k + {x,y}`），`size` 是画布容器的 CSS 像素尺寸。
 */

import type { DocState } from './docstate';
import type { BPEdge } from './types';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Viewport { x: number; y: number; k: number }

export interface Size { w: number; h: number }

/** 三档细节：full 全量 / compact 只标题+端口点 / minimal 直线+色块 */
export type Lod = 'full' | 'compact' | 'minimal';

/** 视口外扩倍数：可见区 = 屏幕范围 × VIEW_PAD */
export const VIEW_PAD = 1.5;

/** 节点数低于该值时关闭裁剪，避免小图抖动与 DOM 反复增删 */
export const CULL_THRESHOLD = 80;

/** 缩放阈值 */
export const LOD_COMPACT = 0.5;
export const LOD_MINIMAL = 0.25;

export function lodFor(k: number): Lod {
  if (!Number.isFinite(k)) return 'full';
  if (k < LOD_MINIMAL) return 'minimal';
  if (k < LOD_COMPACT) return 'compact';
  return 'full';
}

/**
 * 当前可见的世界矩形。语义：可见世界范围 = 屏幕范围 ×(1 + pad)，
 * 即每边各留 `pad/2` 屏的余量（默认 pad=1.5 → 每边 0.75 屏），
 * 这样平移到边缘时节点不会「贴边才出现」。
 */
export function worldViewRect(view: Viewport, size: Size, pad = VIEW_PAD): Rect {
  const k = Number.isFinite(view.k) && view.k > 0 ? view.k : 1;
  const w = Math.max(0, size.w);
  const h = Math.max(0, size.h);
  const scale = Math.max(0, pad);
  const marginX = (w * scale) / 2;
  const marginY = (h * scale) / 2;
  return {
    x: (-marginX - view.x) / k,
    y: (-marginY - view.y) / k,
    w: (w + marginX * 2) / k,
    h: (h + marginY * 2) / k,
  };
}

/** 闭区间相交：刚好相切（边贴边）也算可见，避免临界闪烁 */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export interface NodeSize { w: number; h: number }

/** 节点 bbox 与视口矩形相交即可见（只依赖 nodes，便于画布直接传入） */
export function visibleNodeIds(
  doc: Pick<DocState, 'nodes'>,
  metas: Map<string, NodeSize>,
  rect: Rect,
): Set<string> {
  const out = new Set<string>();
  for (const n of doc.nodes) {
    const m = metas.get(n.id);
    if (!m) continue;
    if (intersects(rect, { x: n.x, y: n.y, w: m.w, h: m.h })) out.add(n.id);
  }
  return out;
}

/**
 * 连线可见性：两端节点都可见才画。
 * 例外：显式选中的连线始终可见（否则选中态会随着平移「消失」）。
 * 悬空端（端点节点不存在）交给 problem 解释，不在这里兜。
 */
export function visibleEdgeIds(
  edges: BPEdge[],
  visible: Set<string>,
  selectedEdges: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (selectedEdges.has(e.id)) { out.add(e.id); continue; }
    if (visible.has(e.from.node) && visible.has(e.to.node)) out.add(e.id);
  }
  return out;
}

/** 节点集合的包围盒（小地图与「适配选中」共用）；空集返回 null */
export function boundsOf(
  ids: Iterable<string>,
  nodes: { id: string; x: number; y: number }[],
  metas: Map<string, NodeSize>,
): Rect | null {
  const want = ids instanceof Set ? ids : new Set(ids);
  if (!want.size) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) {
    if (!want.has(n.id)) continue;
    const m = metas.get(n.id);
    if (!m) continue;
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + m.w);
    y1 = Math.max(y1, n.y + m.h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 把世界矩形适配进画布尺寸，返回新的 view（居中 + 留边），k 夹在 [minK, maxK] */
export function fitView(
  target: Rect,
  size: Size,
  pad = 46,
  minK = 0.12,
  maxK = 1.25,
): Viewport {
  const w = Math.max(1, target.w);
  const h = Math.max(1, target.h);
  const k = Math.min(maxK, Math.max(minK, Math.min(
    (size.w - pad * 2) / w,
    (size.h - pad * 2) / h,
  )));
  return { k, x: pad - target.x * k, y: pad - target.y * k };
}

/** 首次打开时优先保证可读的缩放；「适配」仍用 fitView 看全貌 */
export const READABLE_K = 0.85;

/**
 * 打开文档时用的视角：整图能塞进可读缩放就用 fit（看全貌），
 * 塞不下则保持可读缩放、从内容左上角铺开，让用户先看清起点。
 * 此时内容必然超出画布，所以不做居中，避免起点被推到屏幕外。
 */
export function openView(
  target: Rect,
  size: Size,
  pad = 46,
  readableK = READABLE_K,
): Viewport {
  const fit = fitView(target, size, pad);
  if (fit.k >= readableK) return fit;
  const k = Math.min(1.25, Math.max(0.12, readableK));
  return { k, x: pad - target.x * k, y: pad - target.y * k };
}

/** 世界点 → 屏幕点 / 屏幕点 → 世界点（小地图与端口直写共用） */
export function worldToScreen(view: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.k + view.x, y: wy * view.k + view.y };
}

export function screenToWorld(view: Viewport, sx: number, sy: number): { x: number; y: number } {
  const k = Number.isFinite(view.k) && view.k > 0 ? view.k : 1;
  return { x: (sx - view.x) / k, y: (sy - view.y) / k };
}

/** 以画布中心为锚点设置缩放（「100%」按钮用） */
export function zoomAtCenter(view: Viewport, size: Size, nextK: number): Viewport {
  const k = Math.max(0.12, Math.min(2.4, nextK));
  const cx = size.w / 2;
  const cy = size.h / 2;
  const w = screenToWorld(view, cx, cy);
  return { k, x: cx - w.x * k, y: cy - w.y * k };
}
