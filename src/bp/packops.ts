/**
 * pack 生命周期操作（纯函数，无 React、无 IO）。
 *
 * 约定：所有函数返回新 `DocState`，未改动的数组与元素按引用复用——
 * 这样 `sameDoc` 能判定「没有实质变化」，历史栈也不会因一次点击翻倍。
 * 禁用只踢出求值（见 `isPackEnabled`），绝不删节点与连线。
 */

import type { DocState, LoadedPack } from './docstate';
import { isPackEnabled } from './docstate';

/** 删除 / 禁用 / 清理的影响面 */
export interface PackImpact {
  /** 属于该 pack 的节点数 */
  nodes: number;
  /** 任一端属于该 pack 节点的连线数 */
  edges: number;
}

export type RenameCode = 'OK' | 'EMPTY' | 'UNCHANGED' | 'MISSING';

/** pack 显示名长度上限 */
export const MAX_PACK_NAME = 48;

/** 该 pack 拥有的节点 id 集合 */
function nodeIdsOf(doc: DocState, packId: string): Set<string> {
  const ids = new Set<string>();
  for (const n of doc.nodes) if (n.packId === packId) ids.add(n.id);
  return ids;
}

/** 删除 / 禁用影响面：节点数与「任一端落在该 pack」的连线数 */
export function packImpact(doc: DocState, packId: string): PackImpact {
  const ids = nodeIdsOf(doc, packId);
  if (!ids.size) return { nodes: 0, edges: 0 };
  let edges = 0;
  for (const e of doc.edges) if (ids.has(e.from.node) || ids.has(e.to.node)) edges += 1;
  return { nodes: ids.size, edges };
}

/** 启用/禁用：只改 pack 元数据，节点与连线原样保留 */
export function setPackEnabled(doc: DocState, packId: string, enabled: boolean): DocState {
  const idx = doc.packs.findIndex((p) => p.id === packId);
  if (idx < 0) return doc;
  if (isPackEnabled(doc.packs[idx]) === enabled) return doc;
  const packs = doc.packs.slice();
  packs[idx] = { ...packs[idx], enabled };
  return { ...doc, packs };
}

/** 名字被占用时追加 ` (2)`、` (3)`… */
export function uniquePackName(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  const root = base.slice(0, MAX_PACK_NAME).trim() || 'pack';
  if (!used.has(root)) return root;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${root} (${i})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${root} (${Date.now()})`;
}

/**
 * 重命名：去首尾空格、折叠连续空格；空名拒绝；重名自动加后缀。
 * 返回码让 UI 能区分「拒绝」与「无变化」。
 */
export function renamePack(
  doc: DocState,
  packId: string,
  rawName: string,
): { doc: DocState; code: RenameCode; name?: string } {
  const idx = doc.packs.findIndex((p) => p.id === packId);
  if (idx < 0) return { doc, code: 'MISSING' };
  const cleaned = rawName.trim().replace(/\s+/g, ' ');
  if (!cleaned) return { doc, code: 'EMPTY' };
  const current = doc.packs[idx];
  if (cleaned === current.name) return { doc, code: 'UNCHANGED', name: cleaned };
  const taken = doc.packs.filter((p) => p.id !== packId).map((p) => p.name);
  const name = uniquePackName(taken, cleaned);
  const packs = doc.packs.slice();
  packs[idx] = { ...current, name };
  return { doc: { ...doc, packs }, code: 'OK', name };
}

/**
 * 删除 pack：pack + 其节点 + 相关连线一次产出，绝不留孤儿连线。
 * 撤销时三者整体回来（一次 commit 一条历史）。
 */
export function removePackAtomic(doc: DocState, packId: string): DocState {
  if (!doc.packs.some((p) => p.id === packId)) return doc;
  const nodes = doc.nodes.filter((n) => n.packId !== packId);
  const alive = new Set(nodes.map((n) => n.id));
  const edges = doc.edges.filter((e) => alive.has(e.from.node) && alive.has(e.to.node));
  return { ...doc, packs: doc.packs.filter((p) => p.id !== packId), nodes, edges };
}

/** 清理 N 个节点：只删该 pack 的节点与关联连线，pack 本身留在文档里 */
export function cleanupPackNodes(doc: DocState, packId: string): DocState {
  const nodes = doc.nodes.filter((n) => n.packId !== packId);
  if (nodes.length === doc.nodes.length) return doc;
  const alive = new Set(nodes.map((n) => n.id));
  const edges = doc.edges.filter((e) => alive.has(e.from.node) && alive.has(e.to.node));
  return { ...doc, nodes, edges };
}

/** 追加 pack；id 冲突时重新分配（返回最终落库的 pack，便于 UI 提示） */
export function addPack(doc: DocState, pack: LoadedPack): { doc: DocState; pack: LoadedPack } {
  const ids = new Set(doc.packs.map((p) => p.id));
  const names = doc.packs.map((p) => p.name);
  let id = pack.id;
  for (let i = 2; ids.has(id); i += 1) id = `${pack.id}-${i}`;
  const next: LoadedPack = {
    ...pack,
    id,
    name: uniquePackName(names, pack.name),
    enabled: pack.enabled !== false,
  };
  return { doc: { ...doc, packs: [...doc.packs, next] }, pack: next };
}

/** 求值用的 pack 映射：只含启用的 pack */
export function enabledPackMap(packs: LoadedPack[]): Map<string, LoadedPack['pack']> {
  const map = new Map<string, LoadedPack['pack']>();
  for (const p of packs) if (isPackEnabled(p)) map.set(p.id, p.pack);
  return map;
}

/** 被禁用 pack 的 id 集合（画布据此显示「已禁用」错误态） */
export function disabledPackIds(packs: LoadedPack[]): Set<string> {
  const out = new Set<string>();
  for (const p of packs) if (!isPackEnabled(p)) out.add(p.id);
  return out;
}
