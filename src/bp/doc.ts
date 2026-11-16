/** Save/load a blueprint document (pack sources + graph + optional buffer). */

import { migrateNode, type BPEdge, type BPDoc, type BPNode } from './types';

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function makeDoc(
  packs: { id: string; name: string; source: string }[],
  nodes: BPNode[],
  edges: BPEdge[],
): BPDoc {
  return { format: 'memlink-blueprint/1', packs, nodes, edges };
}

export function parseDoc(text: string): { doc?: BPDoc; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const d = raw as Partial<BPDoc>;
  if (!d || d.format !== 'memlink-blueprint/1') {
    return { error: '不是 memlink-blueprint/1 文件' };
  }
  if (!Array.isArray(d.packs) || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) {
    return { error: '文件缺少 packs/nodes/edges' };
  }
  for (const p of d.packs) {
    if (!p || typeof p.id !== 'string' || typeof p.source !== 'string') {
      return { error: 'pack 条目缺少 id/source' };
    }
  }
  for (const n of d.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.packId !== 'string' || typeof n.nodeId !== 'string') {
      return { error: '节点条目缺少 id/packId/nodeId' };
    }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return { error: `节点 ${n.id} 的坐标非法` };
    if (n.source && (typeof n.source.name !== 'string' || !Number.isFinite(n.source.base) || typeof n.source.data !== 'string')) {
      return { error: `节点 ${n.id} 的 buffer 数据非法` };
    }
  }
  for (const e of d.edges) {
    if (!e || !e.from?.node || !e.to?.node || !e.from.port || !e.to.port) {
      return { error: '边缺少 from/to' };
    }
  }

  // `buffer` is a real context input again, so both old and new graphs keep
  // their source wires verbatim. Only drop edges whose endpoints disappeared.
  // 打开图时同样套用旧内置节点的合并迁移。
  const nodeList: BPNode[] = d.nodes.map((n) => migrateNode({ ...n, params: { ...(n.params ?? {}) } }));
  const ids = new Set(nodeList.map((n) => n.id));
  const edgeList: BPEdge[] = (d.edges as BPEdge[]).filter(
    (e) => ids.has(e.from.node) && ids.has(e.to.node) && !!e.from.port && !!e.to.port,
  );
  return { doc: { ...d, nodes: nodeList, edges: edgeList } as BPDoc };
}
