/**
 * 复制 / 剪切 / 粘贴 / 副本（纯函数，无 React、无 IO）。
 *
 * 只复制「选中节点 + 两端都在选中集合内的连线」：选中的孤立连线不进入片段，
 * 避免粘贴后出现指向不存在节点的悬空边。File 节点的 buffer 只复制 base64
 * 字符串引用，不复制字节。
 */

import type { DocState } from './docstate';
import type { BPEdge, BPNode } from './types';
import type { SelectionState } from './selection';

export interface Fragment {
  nodes: BPNode[];
  edges: BPEdge[];
}

/** 粘贴偏移：首次 24，之后每次 +24 */
export const PASTE_STEP = 24;

/** 从文档里取出选择片段；空选择（或只有孤立连线）返回 null */
export function extractFragment(doc: DocState, sel: SelectionState): Fragment | null {
  if (!sel.nodes.size) return null;
  const picks = doc.nodes.filter((n) => sel.nodes.has(n.id));
  if (!picks.length) return null;
  // 片段是快照：参数深拷贝（都是字符串，浅拷贝即够），buffer 只保留引用
  const nodes = picks.map((n) => ({ ...n, params: { ...n.params } }));
  const inside = new Set(nodes.map((n) => n.id));
  // 只有两端都在片段内的连线才跟着走
  const edges = doc.edges.filter((e) => inside.has(e.from.node) && inside.has(e.to.node));
  return { nodes, edges };
}

export interface PasteOptions {
  /** 世界坐标偏移量 */
  offset: number;
  /** 新 id 生成器（通常是调用方的 `seq`，永不回退） */
  nextId: () => string;
}

export interface PasteResult {
  doc: DocState;
  nodes: BPNode[];
  edges: BPEdge[];
}

/** 把片段贴进文档：id 全部重映射、params 深拷贝、坐标整体偏移 */
export function pasteFragment(doc: DocState, frag: Fragment, opts: PasteOptions): PasteResult {
  const taken = new Set<string>();
  for (const n of doc.nodes) taken.add(n.id);
  for (const e of doc.edges) taken.add(e.id);
  const newId = (): string => {
    let id = opts.nextId();
    while (taken.has(id)) id = opts.nextId();
    taken.add(id);
    return id;
  };

  const idMap = new Map<string, string>();
  const nodes: BPNode[] = frag.nodes.map((n) => {
    const id = newId();
    idMap.set(n.id, id);
    return {
      ...n,
      id,
      x: n.x + opts.offset,
      y: n.y + opts.offset,
      params: { ...n.params },
      // `source` 原样引用：base64 字符串不复制字节
    };
  });

  const edges: BPEdge[] = [];
  for (const e of frag.edges) {
    const from = idMap.get(e.from.node);
    const to = idMap.get(e.to.node);
    if (!from || !to) continue;
    edges.push({ id: newId(), from: { node: from, port: e.from.port }, to: { node: to, port: e.to.port } });
  }

  return {
    doc: { ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges] },
    nodes,
    edges,
  };
}

/** 创建副本 = 取片段 + 偏移 24 贴回；无片段返回 null */
export function duplicateSelection(
  doc: DocState,
  sel: SelectionState,
  nextId: () => string,
): PasteResult | null {
  const frag = extractFragment(doc, sel);
  if (!frag) return null;
  return pasteFragment(doc, frag, { offset: PASTE_STEP, nextId });
}

/** 第 n 次连续粘贴的偏移量（n 从 1 开始 → 24 / 48 / 72…） */
export function pasteOffset(index: number): number {
  return PASTE_STEP * Math.max(1, Math.floor(index));
}
