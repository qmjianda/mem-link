/**
 * 一键自动布局：把解析链按数据流方向从左到右分层排开。
 *
 * 算法是简化的分层布局（Sugiyama）：
 * 1. 分层：`layer = max(layer(preds)) + 1`（最长路径），与数据流向一致；
 * 2. 层内排序：前后各一轮 barycenter（按相邻层邻居的平均位置），减少连线交叉；
 * 3. 位置：列宽统一（节点等宽），层内按实际高度累计排布。
 *
 * 孤立节点（没有任何连线，例如标注、备用常量）不参与重排——它们通常是
 * 手工摆放的草稿，突然飞走反而让人找不到。调用方保留它们的原坐标。
 */
import { NODE_WIDTH } from './types';

export interface AutoLayoutNode {
  id: string;
  h: number;
  preds: string[];
  succs: string[];
}

export interface AutoLayoutOptions {
  /** 层间水平间距 */
  gapX?: number;
  /** 层内垂直间距 */
  gapY?: number;
  /** 布局区域左上角（默认 {0,0}） */
  origin?: { x: number; y: number };
  /** barycenter 迭代轮数（默认 2） */
  sweeps?: number;
  /**
   * 布局结果必须避开的矩形（通常是孤立节点的包围盒：它们保持原位，
   * 主图若与它们重叠则整体下移绕开）。
   */
  avoid?: { x: number; y: number; w: number; h: number }[];
}

export interface AutoLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** 参与重排的节点数（不含孤立节点） */
  arranged: number;
}

const COL_W = NODE_WIDTH + 56;
const DEFAULT_GAP_Y = 44;
const DEFAULT_SWEEPS = 2;

export function autoLayout(nodes: AutoLayoutNode[], opts: AutoLayoutOptions = {}): AutoLayoutResult {
  const gapY = opts.gapY ?? DEFAULT_GAP_Y;
  const sweeps = opts.sweeps ?? DEFAULT_SWEEPS;
  const origin = opts.origin ?? { x: 0, y: 0 };
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // —— 1. 分层（Kahn 拓扑序 + 最长路径）；防御环：剩余节点塞进最后一层。
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, n.preds.filter((p) => byId.has(p)).length);
  const queue: string[] = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of byId.get(id)?.succs ?? []) {
      const left = (indeg.get(s) ?? 0) - 1;
      indeg.set(s, left);
      if (left === 0) queue.push(s);
    }
    layer.set(id, Math.max(0, ...((byId.get(id)?.preds ?? [])
      .filter((p) => layer.has(p))
      .map((p) => (layer.get(p) ?? 0) + 1))));
  }
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, order.length);

  const maxLayer = nodes.reduce((m, n) => Math.max(m, layer.get(n.id) ?? 0), 0);
  // 孤立节点（无任何连线）不参与重排：通常是手工摆放的标注与备用常量。
  const isolated = new Set(nodes.filter((n) => !n.preds.length && !n.succs.length).map((n) => n.id));
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of order) if (!isolated.has(id)) columns[layer.get(id)!]?.push(id);
  // 环里未被拓扑序覆盖的节点也要有位置（防御，蓝图本身是 DAG）。
  for (const n of nodes) {
    if (isolated.has(n.id) || order.includes(n.id)) continue;
    columns[layer.get(n.id)!]?.push(n.id);
  }

  // —— 2. 层内排序：barycenter 前后交替，减少交叉。
  const index = new Map<string, number>();
  columns.forEach((col) => col.forEach((id, i) => index.set(id, i)));
  const avg = (ids: string[]) => {
    const vals = ids
      .filter((x) => index.has(x))
      .map((x) => index.get(x)!)
      .sort((a, b) => a - b);
    if (!vals.length) return Number.POSITIVE_INFINITY;
    // 中位数比平均值更抗长边干扰。
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  };
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    for (let l = 0; l < columns.length; l += 1) {
      columns[l] = [...columns[l]].sort(
        (a, b) => avg(byId.get(a)?.preds ?? []) - avg(byId.get(b)?.preds ?? []),
      );
      columns[l].forEach((id, i) => index.set(id, i));
    }
    for (let l = columns.length - 1; l >= 0; l -= 1) {
      columns[l] = [...columns[l]].sort(
        (a, b) => avg(byId.get(a)?.succs ?? []) - avg(byId.get(b)?.succs ?? []),
      );
      columns[l].forEach((id, i) => index.set(id, i));
    }
  }

  // —— 3. 位置：列宽统一，层内按实际高度累计。
  const positions = new Map<string, { x: number; y: number }>();
  let arranged = 0;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let l = 0; l < columns.length; l += 1) {
    let y = origin.y;
    for (const id of columns[l]) {
      const n = byId.get(id);
      if (!n) continue;
      positions.set(id, { x: origin.x + l * COL_W, y: Math.round(y) });
      box.x0 = Math.min(box.x0, origin.x + l * COL_W);
      box.y0 = Math.min(box.y0, Math.round(y));
      box.x1 = Math.max(box.x1, origin.x + l * COL_W + COL_W);
      box.y1 = Math.max(box.y1, Math.round(y) + n.h);
      y += n.h + gapY;
      arranged += 1;
    }
  }

  // 与 avoid 区域重叠时整体下移绕开：孤立节点保持原位，主图让路。
  if (opts.avoid?.length && arranged > 0) {
    const hit = opts.avoid.some((r) =>
      Math.min(box.x1, r.x + r.w) - Math.max(box.x0, r.x) > 0
      && Math.min(box.y1, r.y + r.h) - Math.max(box.y0, r.y) > 0);
    if (hit) {
      const maxY = Math.max(...opts.avoid.map((r) => r.y + r.h));
      const dy = maxY + 80 - box.y0;
      if (dy > 0) for (const p of positions.values()) p.y += dy;
    }
  }

  return { positions, arranged };
}

/** 从连线关系推导每个节点的上下游（忽略指向不存在节点的边）。 */
export function adjacency(ids: string[], edges: { from: { node: string }; to: { node: string } }[]) {
  const alive = new Set(ids);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!alive.has(e.from.node) || !alive.has(e.to.node) || e.from.node === e.to.node) continue;
    succs.get(e.from.node)!.push(e.to.node);
    preds.get(e.to.node)!.push(e.from.node);
  }
  return { preds, succs };
}
