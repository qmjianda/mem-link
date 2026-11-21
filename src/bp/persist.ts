/**
 * 图文档持久化。面板宽度、
 * 折叠、分组折叠归 `memlink:ui:v1`，UI 操作不会触发这里的写入。
 *
 * 降级原则（D1）：写入失败不回滚内存文档，只把持久化副本停在上一成功版本。
 */

import type { Problem } from '../core/types';
import type { BPEdge, BPNode } from './types';
import type { DocState, LoadedPack, PackStoreRef } from './docstate';
import { isPackEnabled } from './docstate';
import { loadBlueprintPack } from './load';
import { addressInteger } from './precision';
import { validLayoutDocument, type BinaryLayout } from './layouts';
import { sessionBytesOf } from './doc';

export const GRAPH_VERSION = 3;
export const KEY_GRAPH = `memlink:graph:v${GRAPH_VERSION}`;
/** 单次写入上限：2MB */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export interface StoredPack {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  store?: PackStoreRef;
}

export interface GraphPayload {
  version: number;
  savedAt: number;
  packs: StoredPack[];
  nodes: BPNode[];
  edges: BPEdge[];
  layouts?: BinaryLayout[];
}

/** 因超限被裁掉 buffer 的 File 节点 */
export interface DroppedBuffer { nodeId: string; name: string; bytes: number }

export type PersistCode = 'OK' | 'TRIMMED' | 'TOO_LARGE' | 'NO_STORAGE' | 'BAD_DATA';
export interface PersistResult {
  ok: boolean;
  code: PersistCode;
  bytes: number;
  droppedBuffers: number;
  /** 被裁掉的转储明细，用于在状态区列出需要重新载入的来源 */
  dropped: DroppedBuffer[];
}

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
      ...(p.store ? { store: p.store } : {}),
    })),
    nodes: doc.nodes,
    edges: doc.edges,
    ...(doc.layouts ? { layouts: doc.layouts } : {}),
  };
}

/** 去掉内联 buffer 后的文档：只复制 File 节点，其余节点按引用复用。 */
function withoutBuffers(doc: DocState): DocState {
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!n.source?.data) return n;
    changed = true;
    return { ...n, source: { ...n.source, data: '' } };
  });
  return changed ? { ...doc, nodes } : doc;
}

/**
 * 容量裁剪：序列化超过 `limit` 时按字节数从大到小丢掉 File 节点的 buffer
 * （保留 name/base），直到能写进缓存或没有可丢的内容。只丢必要的部分，
 * 避免一个超大转储把同一张图里其它小转储一起清空。
 *
 * 不要把整份文档（含 100 MB 级 base64）`JSON.stringify` 一遍再判断超限：
 * 64 MB 转储每次自动缓存都会因此停 0.4 s。这里先用「元数据 JSON + 各
 * base64 字符串长度」精确算大小，只对最终要写入的小文档做一次序列化。
 */
export function trimForQuota(
  doc: DocState,
  limit = MAX_WRITE_BYTES,
): { doc: DocState; dropped: DroppedBuffer[]; bytes: number } {
  // 大文件只活在会话内（data 为空）：JSON 里本来就没有它们，写入缓存后
  // 需要重新载入，一并列进 dropped 让状态栏与提示说清楚。
  const sessionOnly: DroppedBuffer[] = [];
  for (const n of doc.nodes) {
    const bytes = n.source && !n.source.data ? sessionBytesOf(n.source) : undefined;
    if (bytes?.length) sessionOnly.push({ nodeId: n.id, name: n.source!.name, bytes: bytes.length });
  }

  const candidates = doc.nodes
    .filter((n) => n.source?.data)
    .map((n) => ({ node: n, size: n.source!.data!.length }))
    .sort((a, b) => b.size - a.size);
  if (!candidates.length) {
    return { doc, dropped: sessionOnly, bytes: bytesOf(JSON.stringify(payloadOf(doc))) };
  }

  // 先按「元数据 + base64 字符串长度」估算。本应用写出的 base64 只含
  // A-Za-z0-9+/=，JSON.stringify 不会转义；外部图若塞入需要转义的字符，
  // 估算会略小，但 saveDoc 在真正写入前还会做一次精确字节检查。
  const metaBytes = bytesOf(JSON.stringify(payloadOf(withoutBuffers(doc))));
  const totalBytes = metaBytes + candidates.reduce((sum, c) => sum + c.size, 0);
  if (totalBytes <= limit) return { doc, dropped: sessionOnly, bytes: totalBytes };

  const dropped: DroppedBuffer[] = [];
  let bytes = totalBytes;
  for (const { node, size } of candidates) {
    dropped.push({ nodeId: node.id, name: node.source!.name, bytes: size });
    bytes -= size;
    if (bytes <= limit) break;
  }
  const emptied = new Set(dropped.map((d) => d.nodeId));
  const nodes = doc.nodes.map((n) => (emptied.has(n.id) && n.source
    ? { ...n, source: { ...n.source, data: '' } }
    : n));
  return { doc: { ...doc, nodes }, dropped: [...dropped, ...sessionOnly], bytes };
}

/** 待写入的 JSON（已按容量裁剪） */
export function serialize(doc: DocState, limit = MAX_WRITE_BYTES): string {
  return JSON.stringify(payloadOf(trimForQuota(doc, limit).doc));
}

function isStoreRef(v: unknown): v is PackStoreRef {
  const s = v as Partial<PackStoreRef>;
  return !!s && typeof s.url === 'string' && typeof s.packId === 'string' && typeof s.version === 'string'
    && (s.sha256 === undefined || typeof s.sha256 === 'string')
    && (s.path === undefined || typeof s.path === 'string')
    && (s.coverage === undefined || s.coverage === 'complete' || s.coverage === 'partial')
    && (s.helpers === undefined || (typeof s.helpers === 'number' && s.helpers >= 0));
}

function isNode(v: unknown): v is BPNode {
  const n = v as Partial<BPNode>;
  if (!n || typeof n.id !== 'string' || typeof n.packId !== 'string' || typeof n.nodeId !== 'string') return false;
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
  if (n.source && (typeof n.source.name !== 'string'
    || addressInteger(n.source.base) === undefined || typeof n.source.data !== 'string')) return false;
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
  if (env.layouts !== undefined && !validLayoutDocument(env.layouts)) return { code: 'BAD_DATA', problems: [] };

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
    const stored = p as { enabled?: boolean; store?: unknown };
    packs.push({
      id: p.id,
      name: p.name,
      source: p.source,
      pack: r.pack,
      enabled: stored.enabled !== false,
      ...(isStoreRef(stored.store) ? { store: stored.store } : {}),
    });
  }

  const nodes = env.nodes.map((n) => ({ ...n, params: { ...(n.params ?? {}) } }));
  const alive = new Set(nodes.map((n) => n.id));
  const edges = env.edges.filter((e) => alive.has(e.from.node) && alive.has(e.to.node));
  return { code: 'OK', doc: { packs, nodes, edges, ...(env.layouts ? { layouts: env.layouts } : {}) }, problems };
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
  // 超限时不再为「确认超限」序列化一遍大文档；裁剪结果已经算好了字节数。
  if (trim.bytes > limit) {
    return {
      ok: false, code: 'TOO_LARGE', bytes: trim.bytes,
      droppedBuffers: trim.dropped.length, dropped: trim.dropped,
    };
  }
  let json: string;
  try {
    json = JSON.stringify(payloadOf(trim.doc));
  } catch {
    return { ok: false, code: 'BAD_DATA', bytes: 0, droppedBuffers: 0, dropped: [] };
  }
  const bytes = bytesOf(json);
  if (bytes > limit) {
    return {
      ok: false, code: 'TOO_LARGE', bytes,
      droppedBuffers: trim.dropped.length, dropped: trim.dropped,
    };
  }
  try {
    window.localStorage.setItem(KEY_GRAPH, json);
  } catch {
    return {
      ok: false, code: 'NO_STORAGE', bytes,
      droppedBuffers: trim.dropped.length, dropped: trim.dropped,
    };
  }
  return {
    ok: true,
    code: trim.dropped.length ? 'TRIMMED' : 'OK',
    bytes,
    droppedBuffers: trim.dropped.length,
    dropped: trim.dropped,
  };
}

export function clearStored(): void {
  try {
    window.localStorage.removeItem(KEY_GRAPH);
  } catch {
    /* 忽略 */
  }
}
