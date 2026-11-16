/**
 * 图文档持久化（`memlink:graph:v1`）。只放 `{packs, nodes, edges}`；面板宽度、
 * 折叠、分组折叠归 `memlink:ui:v1`，UI 操作不会触发这里的写入。
 *
 * 降级原则（D1）：写入失败不回滚内存文档，只把持久化副本停在上一成功版本。
 */

import type { Problem } from '../core/types';
import { migrateNode, type BPEdge, type BPNode } from './types';
import type { DocState, LoadedPack } from './docstate';
import { isPackEnabled } from './docstate';
import { loadBlueprintPack } from './load';

export const KEY_GRAPH = 'memlink:graph:v1';
export const GRAPH_VERSION = 1;
/** 单次写入上限：2MB */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export interface StoredPack { id: string; name: string; source: string; enabled: boolean }

export interface GraphPayload {
  version: number;
  savedAt: number;
  packs: StoredPack[];
  nodes: BPNode[];
  edges: BPEdge[];
}

/** 因超限被裁掉 buffer 的 File 节点 */
export interface DroppedBuffer { nodeId: string; name: string; bytes: number }

export type PersistCode = 'OK' | 'TRIMMED' | 'TOO_LARGE' | 'NO_STORAGE' | 'BAD_DATA';
export interface PersistResult { ok: boolean; code: PersistCode; bytes: number; droppedBuffers: number }

export type LoadCode = 'OK' | 'MISSING' | 'BAD_JSON' | 'VERSION' | 'BAD_DATA';
export interface LoadResult { doc?: DocState; code: LoadCode; problems: Problem[] }

/** UTF-8 字节数（payload 含中文标签，不能用 `string.length` 估算） */
export function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function payloadOf(doc: DocState, savedAt = Date.now()): GraphPayload {
  return {
    version: GRAPH_VERSION,
    savedAt,
    packs: doc.packs.map((p) => ({
      id: p.id,
      name: p.name,
      source: p.source,
      // 显式写出启用态；旧缓存没有这个字段，读回时按 true 处理
      enabled: isPackEnabled(p),
    })),
    nodes: doc.nodes,
    edges: doc.edges,
  };
}

/**
 * 容量裁剪：序列化超过 `limit` 时先把各 File 节点的 buffer 置空（保留 name/base），
 * 返回裁剪后的文档与被裁列表。仍超限由调用方判定 `TOO_LARGE`。
 */
export function trimForQuota(
  doc: DocState,
  limit = MAX_WRITE_BYTES,
): { doc: DocState; dropped: DroppedBuffer[]; bytes: number } {
  const full = JSON.stringify(payloadOf(doc));
  const fullBytes = bytesOf(full);
  if (fullBytes <= limit) return { doc, dropped: [], bytes: fullBytes };

  const dropped: DroppedBuffer[] = [];
  const nodes = doc.nodes.map((n) => {
    if (!n.source || !n.source.data) return n;
    dropped.push({ nodeId: n.id, name: n.source.name, bytes: n.source.data.length });
    return { ...n, source: { ...n.source, data: '' } };
  });
  if (!dropped.length) return { doc, dropped: [], bytes: fullBytes };
  const trimmed: DocState = { ...doc, nodes };
  return { doc: trimmed, dropped, bytes: bytesOf(JSON.stringify(payloadOf(trimmed))) };
}

/** 待写入的 JSON（已按容量裁剪） */
export function serialize(doc: DocState, limit = MAX_WRITE_BYTES): string {
  return JSON.stringify(payloadOf(trimForQuota(doc, limit).doc));
}

function isNode(v: unknown): v is BPNode {
  const n = v as Partial<BPNode>;
  if (!n || typeof n.id !== 'string' || typeof n.packId !== 'string' || typeof n.nodeId !== 'string') return false;
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
  if (n.source && (typeof n.source.name !== 'string'
    || !Number.isFinite(n.source.base) || typeof n.source.data !== 'string')) return false;
  return true;
}

function isEdge(v: unknown): v is BPEdge {
  const e = v as Partial<BPEdge>;
  return !!e && typeof e.id === 'string'
    && typeof e.from?.node === 'string' && typeof e.from?.port === 'string'
    && typeof e.to?.node === 'string' && typeof e.to?.port === 'string';
}

/**
 * 解析缓存。坏 JSON / 版本不符 / 结构非法一律返回空结果（调用方回落到示例图）；
 * 单个 pack 编译失败只丢该 pack 并记一条 problem，其余数据保留。
 */
export function deserialize(raw: string | null | undefined): LoadResult {
  if (!raw) return { code: 'MISSING', problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: 'BAD_JSON', problems: [] };
  }
  const env = parsed as Partial<GraphPayload> | null;
  if (!env || typeof env !== 'object') return { code: 'BAD_DATA', problems: [] };
  if (env.version !== GRAPH_VERSION) return { code: 'VERSION', problems: [] };
  if (!Array.isArray(env.packs) || !Array.isArray(env.nodes) || !Array.isArray(env.edges)) {
    return { code: 'BAD_DATA', problems: [] };
  }
  if (!env.nodes.every(isNode)) return { code: 'BAD_DATA', problems: [] };
  if (!env.edges.every(isEdge)) return { code: 'BAD_DATA', problems: [] };

  const problems: Problem[] = [];
  const packs: LoadedPack[] = [];
  for (const p of env.packs) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.source !== 'string') {
      problems.push({ severity: 'warn', message: `缓存中的 pack 条目非法，已跳过：${String((p as { id?: string })?.id ?? '?')}` });
      continue;
    }
    const r = loadBlueprintPack(p.source);
    if (!r.pack) {
      problems.push({ severity: 'error', message: `pack ${p.name} 加载失败：${r.error ?? '未知错误'}` });
      continue;
    }
    // 旧缓存没有 enabled 字段：缺省视为启用
    const stored = p as { enabled?: boolean };
    packs.push({
      id: p.id,
      name: p.name,
      source: p.source,
      pack: r.pack,
      enabled: stored.enabled !== false,
    });
  }

  const nodes = env.nodes.map((n) => migrateNode({ ...n, params: { ...(n.params ?? {}) } }));
  const alive = new Set(nodes.map((n) => n.id));
  const edges = env.edges.filter((e) => alive.has(e.from.node) && alive.has(e.to.node));
  return { code: 'OK', doc: { packs, nodes, edges }, problems };
}

/** localStorage 写探针：隐私模式下 setItem 会抛错 */
export function storageAvailable(): boolean {
  try {
    const k = 'memlink:probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** 读取缓存；storage 不可用等同于没有缓存 */
export function loadStored(): LoadResult {
  try {
    return deserialize(window.localStorage.getItem(KEY_GRAPH));
  } catch {
    return { code: 'MISSING', problems: [] };
  }
}

/** 写入缓存：超限不写、抛错不抛异常，只回报原因（D1） */
export function saveDoc(doc: DocState, limit = MAX_WRITE_BYTES): PersistResult {
  const trim = trimForQuota(doc, limit);
  let json: string;
  try {
    json = JSON.stringify(payloadOf(trim.doc));
  } catch {
    return { ok: false, code: 'BAD_DATA', bytes: 0, droppedBuffers: 0 };
  }
  const bytes = bytesOf(json);
  if (bytes > limit) {
    return { ok: false, code: 'TOO_LARGE', bytes, droppedBuffers: trim.dropped.length };
  }
  try {
    window.localStorage.setItem(KEY_GRAPH, json);
  } catch {
    return { ok: false, code: 'NO_STORAGE', bytes, droppedBuffers: trim.dropped.length };
  }
  return {
    ok: true,
    code: trim.dropped.length ? 'TRIMMED' : 'OK',
    bytes,
    droppedBuffers: trim.dropped.length,
  };
}

export function clearStored(): void {
  try {
    window.localStorage.removeItem(KEY_GRAPH);
  } catch {
    /* 忽略 */
  }
}
