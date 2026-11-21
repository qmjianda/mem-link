import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { bytesToBase64, parseDoc, withSessionBytes } from '../src/bp/doc';
import { docJson, type DocState, type LoadedPack } from '../src/bp/docstate';
import {
  GRAPH_VERSION, KEY_GRAPH, MAX_WRITE_BYTES, bytesOf, clearStored, deserialize, loadStored, payloadOf,
  saveDoc, serialize, storageAvailable, trimForQuota,
} from '../src/bp/persist';
import type { BPNode } from '../src/bp/types';
import { demoBinary } from './demo-bin';

function demoPack(): LoadedPack {
  const r = loadBlueprintPack(demoSource);
  if (!r.pack) throw new Error(`demo pack 编译失败：${r.error}`);
  return { id: 'p1', name: r.pack.name, source: demoSource, pack: r.pack };
}

function fileNode(id = 'f', bytes = demoBinary()): BPNode {
  return {
    id,
    packId: '',
    nodeId: 'file',
    x: 0,
    y: 0,
    params: { name: 'demo.bin' },
    source: { name: 'demo.bin', base: 0x1000, data: bytesToBase64(bytes) },
  };
}

function parserNode(id = 'h'): BPNode {
  return { id, packId: 'p1', nodeId: 'header', x: 300, y: 40, params: { address: '0x0' } };
}

function sampleDoc(): DocState {
  return {
    packs: [demoPack()],
    nodes: [fileNode(), parserNode()],
    edges: [{ id: 'e1', from: { node: 'f', port: 'buffer' }, to: { node: 'h', port: 'buffer' } }],
  };
}

describe('persist: round-trip', () => {
  it('序列化再解析后文档深度相等', () => {
    const doc = sampleDoc();
    const r = deserialize(serialize(doc));
    expect(r.code).toBe('OK');
    expect(r.doc).toBeTruthy();
    expect(docJson(r.doc!)).toBe(docJson(doc));
  });

  it('pack 重新编译后可继续求值（源码原文保留）', () => {
    const r = deserialize(serialize(sampleDoc()));
    expect(r.doc!.packs[0].source).toBe(demoSource);
    expect(Object.keys(r.doc!.packs[0].pack.types)).toContain('Header');
  });

  it('损坏的边被丢弃，节点保留', () => {
    const doc = sampleDoc();
    const broken = JSON.parse(serialize(doc));
    broken.edges.push({ id: 'e9', from: { node: 'nope', port: 'a' }, to: { node: 'h', port: 'b' } });
    const r = deserialize(JSON.stringify(broken));
    expect(r.code).toBe('OK');
    expect(r.doc!.edges.length).toBe(1);
    expect(r.doc!.nodes.length).toBe(2);
  });
});

describe('persist: 坏数据回退', () => {
  it('空值 → MISSING', () => {
    expect(deserialize(null).code).toBe('MISSING');
    expect(deserialize('').code).toBe('MISSING');
    expect(deserialize(null).doc).toBeUndefined();
  });

  it('坏 JSON → BAD_JSON 且不抛错', () => {
    expect(() => deserialize('{oops')).not.toThrow();
    expect(deserialize('{oops').code).toBe('BAD_JSON');
  });

  it('版本不匹配 → VERSION', () => {
    const env = JSON.parse(serialize(sampleDoc()));
    env.version = GRAPH_VERSION + 1;
    expect(deserialize(JSON.stringify(env)).code).toBe('VERSION');
  });

  it('结构非法 → BAD_DATA', () => {
    expect(deserialize(JSON.stringify({ version: GRAPH_VERSION })).code).toBe('BAD_DATA');
    expect(deserialize(JSON.stringify({ version: GRAPH_VERSION, packs: [], nodes: [{}], edges: [] })).code).toBe('BAD_DATA');
  });

  it('pack 编译失败只丢该 pack 并记一条 problem', () => {
    const env = JSON.parse(serialize(sampleDoc()));
    env.packs[0].source = 'export const = ;';
    const r = deserialize(JSON.stringify(env));
    expect(r.code).toBe('OK');
    expect(r.doc!.packs.length).toBe(0);
    expect(r.doc!.nodes.length).toBe(2);
    expect(r.problems.some((p) => p.severity === 'error')).toBe(true);
  });
});

describe('persist: 容量与降级', () => {
  it('未超限时不裁剪 buffer', () => {
    const trim = trimForQuota(sampleDoc());
    expect(trim.dropped).toEqual([]);
    expect(trim.doc.nodes[0].source?.data.length).toBeGreaterThan(0);
    expect(trim.bytes).toBeLessThan(MAX_WRITE_BYTES);
    // 报告的字节数就是真实序列化大小（base64 不会被 JSON 转义）
    expect(trim.bytes).toBe(bytesOf(JSON.stringify(payloadOf(trim.doc))));
  });

  it('超过 2MB 时先裁掉 buffer，只保留文件名与基址', () => {
    const big = new Uint8Array(2.4 * 1024 * 1024);
    big.fill(0x41);
    const doc: DocState = { packs: [], nodes: [fileNode('f', big), parserNode()], edges: [] };
    const trim = trimForQuota(doc);
    expect(trim.dropped.length).toBe(1);
    expect(trim.dropped[0].nodeId).toBe('f');
    expect(trim.doc.nodes[0].source?.data).toBe('');
    expect(trim.doc.nodes[0].source?.name).toBe('demo.bin');
    expect(trim.doc.nodes[0].source?.base).toBe(0x1000);
    expect(trim.bytes).toBeLessThan(MAX_WRITE_BYTES);
    expect(trim.bytes).toBe(bytesOf(JSON.stringify(payloadOf(trim.doc))));
    // 其余节点不受影响
    expect(trim.doc.nodes[1]).toBe(doc.nodes[1]);
  });

  it('裁剪后仍超限 → 写入被拒并回报 TOO_LARGE', () => {
    const hugeNode: BPNode = {
      ...parserNode('h'),
      params: { address: '0x0', blob: 'x'.repeat(MAX_WRITE_BYTES + 1024) },
    };
    const doc: DocState = { packs: [], nodes: [fileNode(), hugeNode], edges: [] };
    const r = saveDoc(doc);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOO_LARGE');
    expect(r.bytes).toBeGreaterThan(MAX_WRITE_BYTES);
  });

  it('会话内大文件不进 JSON，但在 dropped 里提示需要重新载入', () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    const node: BPNode = {
      ...fileNode(),
      source: withSessionBytes({ name: 'big.sqlite', base: 0, data: '' }, bytes),
    };
    const doc: DocState = { packs: [], nodes: [node], edges: [] };
    const trim = trimForQuota(doc);
    expect(trim.dropped).toEqual([{ nodeId: 'f', name: 'big.sqlite', bytes: bytes.length }]);
    expect(trim.doc.nodes[0]).toBe(node);
    expect(trim.bytes).toBeLessThan(MAX_WRITE_BYTES);
    const json = serialize(doc);
    expect(json.length).toBeLessThan(4096);
    expect(deserialize(json).doc!.nodes[0].source?.data).toBe('');
  });

  it('无 localStorage 时 saveDoc 不抛错并回报 NO_STORAGE', () => {
    expect(storageAvailable()).toBe(false);
    let r: ReturnType<typeof saveDoc> | undefined;
    expect(() => { r = saveDoc(sampleDoc()); }).not.toThrow();
    expect(r!.ok).toBe(false);
    expect(r!.code).toBe('NO_STORAGE');
  });

  it('无 localStorage 时 loadStored 返回 MISSING（回落示例图）', () => {
    expect(loadStored().code).toBe('MISSING');
    expect(loadStored().doc).toBeUndefined();
    expect(() => clearStored()).not.toThrow();
  });

  it('新版与旧缓存使用不同的键', () => {
    expect(KEY_GRAPH).toBe('memlink:graph:v3');
  });
});

it('旧蓝图明确报版本不支持，旧缓存不迁移', () => {
  const graph = { packs: [], nodes: [], edges: [] };
  expect(parseDoc(JSON.stringify({ ...graph, format: 'memlink-blueprint/1' })).error).toContain('不支持此蓝图版本');
  expect(deserialize(JSON.stringify({ ...graph, version: 1, savedAt: 0 })).code).toBe('VERSION');
});

describe('persist: 商店来源', () => {
  it('store 元数据随缓存往返', () => {
    const doc = sampleDoc();
    doc.packs[0].store = {
      url: 'https://example.com/index.json',
      packId: 'demo',
      version: '1.2.3',
      sha256: 'a'.repeat(64),
      coverage: 'partial',
    };
    const r = deserialize(serialize(doc));
    expect(r.code).toBe('OK');
    expect(r.doc!.packs[0].store).toEqual(doc.packs[0].store);
  });

  it('非法 store 字段不阻止 pack 加载，只丢掉来源', () => {
    const env = JSON.parse(serialize(sampleDoc()));
    env.packs[0].store = { url: 1 };
    const r = deserialize(JSON.stringify(env));
    expect(r.code).toBe('OK');
    expect(r.doc!.packs[0].store).toBeUndefined();
  });
});
