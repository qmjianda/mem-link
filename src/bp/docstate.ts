/**
 * 文档状态：`packs / nodes / edges` 合并为单一对象，所有编辑以整份新文档提交。
 *
 * 快照策略：只复制被改动的数组，未改动的元素与数组按引用复用——历史栈因此不会
 * 复制 File 节点的 base64 字符串（100 层历史的内存增量只有指针）。
 */

import type { BlueprintPack, BPEdge, BPNode } from './types';
import { makeDoc } from './doc';

/** 已编译的 pack：`source` 是原文（可序列化），`pack` 是编译产物（不可序列化） */
export interface LoadedPack {
  id: string;
  name: string;
  source: string;
  pack: BlueprintPack;
  /**
   * 启用开关。`undefined` 视为启用——旧缓存与 `memlink-blueprint/1` 的
   * `packs[]` 都没有这个字段，缺省就是 true。
   * 禁用只影响求值：pack、节点、连线都留在文档里。
   */
  enabled?: boolean;
}

/** 唯一判定入口：只有显式 false 才算禁用 */
export function isPackEnabled(pack: LoadedPack): boolean {
  return pack.enabled !== false;
}

/** 三份状态合并后的单一文档对象 */
export interface DocState {
  packs: LoadedPack[];
  nodes: BPNode[];
  edges: BPEdge[];
}

export const EMPTY_DOC: DocState = { packs: [], nodes: [], edges: [] };

/** 三个数组是否全部按引用相等（判定「没有实质变化」的最快办法） */
export function sameDoc(a: DocState, b: DocState): boolean {
  return a === b || (a.packs === b.packs && a.nodes === b.nodes && a.edges === b.edges);
}

/**
 * 校准 id 生成器：从文档里出现的最大编号起步，保证新 id 永不复用。
 * 节点 `n<num>`、连线 `e<num>`、pack `p<num>` 共用同一序列，与历史栈无关。
 */
export function maxIdSeq(doc: DocState, floor = 100): number {
  let max = floor;
  const scan = (id: string, prefix: string): void => {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const n of doc.nodes) scan(n.id, 'n');
  for (const e of doc.edges) scan(e.id, 'e');
  for (const p of doc.packs) scan(p.id, 'p');
  return max;
}

/** 文档的深度可序列化视图：保持 `memlink-blueprint/1` 结构，导出与持久化共用 */
export function docJson(doc: DocState): string {
  return JSON.stringify(makeDoc(
    doc.packs.map((p) => ({ id: p.id, name: p.name, source: p.source })),
    doc.nodes,
    doc.edges,
  ));
}
