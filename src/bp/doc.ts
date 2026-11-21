/** Save/load a blueprint document (pack sources + graph + optional buffer). */

import {
  BLUEPRINT_FORMAT, type BPEdge, type BPDoc, type BPNode, type PackStoreRef, type StoredMemory,
} from './types';
import { addressInteger } from './precision';
import { validLayoutDocument, type BinaryLayout } from './layouts';

/**
 * 会话内的原始文件字节。放在 WeakMap 而不是 `StoredMemory` 字段里，
 * 这样 JSON.stringify / 历史快照 / 蓝图导出都不会带上它；对象被回收时
 * 字节也随之释放。大于 localStorage 预算的文件只留这份字节，不生成 base64。
 */
const sessionBytes = new WeakMap<StoredMemory, Uint8Array>();

export function withSessionBytes(src: StoredMemory, bytes: Uint8Array): StoredMemory {
  sessionBytes.set(src, bytes);
  return src;
}

export function sessionBytesOf(src: StoredMemory | undefined): Uint8Array | undefined {
  return src ? sessionBytes.get(src) : undefined;
}

/** 文件是否还有可解析的内容（内联 base64 或会话内字节） */
export function hasStoredBytes(src: StoredMemory | undefined): boolean {
  return !!src && (src.data.length > 0 || (sessionBytes.get(src)?.length ?? 0) > 0);
}

/** 改基址：新对象沿用同一份会话字节，避免重新解码整份转储。 */
export function rebaseStored(src: StoredMemory, base: StoredMemory['base']): StoredMemory {
  const next: StoredMemory = { ...src, base };
  const bytes = sessionBytes.get(src);
  if (bytes) sessionBytes.set(next, bytes);
  return next;
}

/**
 * 分块 btoa：块长取 3 的倍数，块内编码没有补齐字符，拼起来就是完整结果。
 * 整块 `btoa` 比在 JS 里逐字节查表快 4–5 倍（64 MB 实测 2.8 s → 0.7 s），
 * 也不会先构造一个 64 MB 的二进制字符串再整体编码。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 3 * 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, end) as unknown as number[])));
  }
  return parts.join('');
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function makeDoc(
  packs: { id: string; name: string; source: string; store?: PackStoreRef }[],
  nodes: BPNode[],
  edges: BPEdge[],
  layouts?: BinaryLayout[],
): BPDoc {
  return { format: BLUEPRINT_FORMAT, packs, nodes, edges, ...(layouts ? { layouts } : {}) };
}

export function parseDoc(text: string): { doc?: BPDoc; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const d = raw as Partial<BPDoc>;
  if (!d || d.format !== BLUEPRINT_FORMAT) {
    return { error: `不支持此蓝图版本，请使用新版蓝图（${BLUEPRINT_FORMAT}）` };
  }
  if (!Array.isArray(d.packs) || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) {
    return { error: '文件缺少 packs/nodes/edges' };
  }
  if (d.layouts !== undefined && !validLayoutDocument(d.layouts)) return { error: '蓝图的结构布局数据非法' };
  for (const p of d.packs) {
    if (!p || typeof p.id !== 'string' || typeof p.source !== 'string') {
      return { error: 'pack 条目缺少 id/source' };
    }
    if (p.store !== undefined) {
      const s = p.store as Partial<PackStoreRef> | null;
      if (!s || typeof s !== 'object' || typeof s.url !== 'string' || typeof s.packId !== 'string' || typeof s.version !== 'string') {
        return { error: `pack ${p.id} 的商店来源信息非法` };
      }
    }
  }
  for (const n of d.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.packId !== 'string' || typeof n.nodeId !== 'string') {
      return { error: '节点条目缺少 id/packId/nodeId' };
    }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return { error: `节点 ${n.id} 的坐标非法` };
    if (n.source && (typeof n.source.name !== 'string' || addressInteger(n.source.base) === undefined || typeof n.source.data !== 'string')) {
      return { error: `节点 ${n.id} 的 buffer 数据非法` };
    }
  }
  for (const e of d.edges) {
    if (!e || !e.from?.node || !e.to?.node || !e.from.port || !e.to.port) {
      return { error: '边缺少 from/to' };
    }
  }

  // Keep source wires verbatim. Only drop edges whose endpoints disappeared.
  const nodeList: BPNode[] = d.nodes.map((n) => ({ ...n, params: { ...(n.params ?? {}) } }));
  const ids = new Set(nodeList.map((n) => n.id));
  const edgeList: BPEdge[] = (d.edges as BPEdge[]).filter(
    (e) => ids.has(e.from.node) && ids.has(e.to.node) && !!e.from.port && !!e.to.port,
  );
  return { doc: { ...d, nodes: nodeList, edges: edgeList } as BPDoc };
}
