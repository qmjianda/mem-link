/**
 * 选择模型（纯函数）：节点与连线各自一个集合，`primary` 只决定「检查器显示谁」，
 * `entry` 是检查器里的元素行焦点，不参与批量操作。
 *
 * 不变量：① `primary` 为空 ⇔ 两个集合都空；② `primary ∈ nodes ∪ edges`；
 * ③ 集合内无重复（Set 天然保证）；④ 选择不入历史、不写持久化。
 */

import type { DocState } from './docstate';

/** 检查器兼容视图：单对象详情仍然是单值语义 */
export type BPSelection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'entry'; nodeId: string; index: number }
  | null;

export interface Selectable { kind: 'node' | 'edge'; id: string }

export interface SelectionState {
  nodes: Set<string>;
  edges: Set<string>;
  /** 检查器当前展示的元素行 */
  entry?: { nodeId: string; index: number };
  /** 主选中项：检查器详情与状态栏摘要都以它为准 */
  primary: Selectable | null;
}

export const EMPTY_SELECTION: SelectionState = { nodes: new Set<string>(), edges: new Set<string>(), primary: null };

export function emptySelection(): SelectionState {
  return { nodes: new Set<string>(), edges: new Set<string>(), primary: null };
}

export function clearSelection(): SelectionState {
  return emptySelection();
}

export function isEmptySelection(s: SelectionState): boolean {
  return s.nodes.size === 0 && s.edges.size === 0;
}

export function countSelection(s: SelectionState): number {
  return s.nodes.size + s.edges.size;
}

export function isNodeSelected(s: SelectionState, id: string): boolean {
  return s.nodes.has(id);
}

export function isEdgeSelected(s: SelectionState, id: string): boolean {
  return s.edges.has(id);
}

export function selectOnlyNode(id: string): SelectionState {
  return { nodes: new Set([id]), edges: new Set<string>(), primary: { kind: 'node', id } };
}

export function selectOnlyEdge(id: string): SelectionState {
  return { nodes: new Set<string>(), edges: new Set([id]), primary: { kind: 'edge', id } };
}

/** Shift / Ctrl+点击：切换单个节点的选中状态，其余不变 */
export function toggleNode(s: SelectionState, id: string): SelectionState {
  const nodes = new Set(s.nodes);
  if (nodes.has(id)) {
    nodes.delete(id);
    const primary = s.primary?.kind === 'node' && s.primary.id === id
      ? (nodes.size ? { kind: 'node' as const, id: [...nodes][nodes.size - 1] } : null)
      : s.primary;
    return { ...s, nodes, primary, entry: undefined };
  }
  nodes.add(id);
  return { ...s, nodes, primary: { kind: 'node', id }, entry: undefined };
}

export function toggleEdge(s: SelectionState, id: string): SelectionState {
  const edges = new Set(s.edges);
  if (edges.has(id)) {
    edges.delete(id);
    const primary = s.primary?.kind === 'edge' && s.primary.id === id
      ? (edges.size ? { kind: 'edge' as const, id: [...edges][edges.size - 1] } : null)
      : s.primary;
    return { ...s, edges, primary, entry: undefined };
  }
  edges.add(id);
  return { ...s, edges, primary: { kind: 'edge', id }, entry: undefined };
}

/** 框选 / 粘贴后追加节点（主选中为传入列表的第一个） */
export function addNodes(s: SelectionState, ids: readonly string[]): SelectionState {
  if (!ids.length) return s;
  const nodes = new Set(s.nodes);
  for (const id of ids) nodes.add(id);
  return { ...s, nodes, primary: { kind: 'node', id: ids[0] }, entry: undefined };
}

export function selectAll(doc: DocState): SelectionState {
  const nodes = new Set(doc.nodes.map((n) => n.id));
  const edges = new Set(doc.edges.map((e) => e.id));
  return { nodes, edges, primary: doc.nodes.length ? { kind: 'node', id: doc.nodes[0].id } : null };
}

/** 元素行焦点：只影响检查器，不清空节点集合 */
export function setEntry(s: SelectionState, nodeId: string, index: number): SelectionState {
  return { ...s, entry: { nodeId, index } };
}

/** 删除/撤销后把选择收敛到仍存在的对象上 */
export function retainSelection(s: SelectionState, doc: DocState): SelectionState {
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  const edgeIds = new Set(doc.edges.map((e) => e.id));
  const nodes = new Set([...s.nodes].filter((id) => nodeIds.has(id)));
  const edges = new Set([...s.edges].filter((id) => edgeIds.has(id)));
  const entry = s.entry && nodeIds.has(s.entry.nodeId) ? s.entry : undefined;
  let primary = s.primary;
  if (primary?.kind === 'node' && !nodes.has(primary.id)) primary = null;
  if (primary?.kind === 'edge' && !edges.has(primary.id)) primary = null;
  if (!primary) {
    const firstNode = [...nodes][0];
    const firstEdge = [...edges][0];
    if (firstNode) primary = { kind: 'node', id: firstNode };
    else if (firstEdge) primary = { kind: 'edge', id: firstEdge };
  }
  return { nodes, edges, primary, entry };
}

/** 删除选择里的对象；与被删节点相连的连线一并删除，不留孤儿连线 */
export function deleteSelection(doc: DocState, s: SelectionState): DocState {
  if (isEmptySelection(s)) return doc;
  const nodes = doc.nodes.filter((n) => !s.nodes.has(n.id));
  const alive = new Set(nodes.map((n) => n.id));
  const edges = doc.edges.filter((e) => !s.edges.has(e.id) && alive.has(e.from.node) && alive.has(e.to.node));
  if (nodes.length === doc.nodes.length && edges.length === doc.edges.length) return doc;
  return { ...doc, nodes, edges };
}

/** 压回单值视图：`entry` 优先（与旧行为一致：点元素行后检查器显示该元素） */
export function primarySelection(s: SelectionState): BPSelection {
  if (s.entry) return { kind: 'entry', nodeId: s.entry.nodeId, index: s.entry.index };
  if (s.primary?.kind === 'node') return { kind: 'node', id: s.primary.id };
  if (s.primary?.kind === 'edge') return { kind: 'edge', id: s.primary.id };
  return null;
}

/** 状态栏摘要 */
export function summaryOf(s: SelectionState): { nodes: number; edges: number; total: number; text: string } {
  const total = countSelection(s);
  const nodes = s.nodes.size;
  const edges = s.edges.size;
  let text: string;
  if (s.entry) text = '选中：元素';
  else if (total === 0) text = '未选中';
  else if (total === 1) text = nodes ? '选中：节点' : '选中：连线';
  else text = `已选 ${total} 个对象`;
  return { nodes, edges, total, text };
}
