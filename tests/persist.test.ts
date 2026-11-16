import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { bytesToBase64 } from '../src/bp/doc';
import { docJson, type DocState, type LoadedPack } from '../src/bp/docstate';
import {
  GRAPH_VERSION, KEY_GRAPH, MAX_WRITE_BYTES, clearStored, deserialize, loadStored, saveDoc, serialize,
  storageAvailable, trimForQuota,
} from '../src/bp/persist';
import { migrateNode, type BPNode } from '../src/bp/types';
import { demoBinary } from '../src/core/project';

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

  it('缓存键固定为 memlink:graph:v1', () => {
    expect(KEY_GRAPH).toBe('memlink:graph:v1');
  });
});

describe('旧内置节点合并迁移', () => {
  it('pointer → ptrwalk（offset 恒 0）', () => {
    expect(migrateNode({ id: 'p', packId: '', nodeId: 'pointer', x: 0, y: 0, params: { address: '0x1000', pointerSize: '8' } }))
      .toMatchObject({ nodeId: 'ptrwalk', params: { base: '0x1000', offset: '0x0', pointerSize: '8' } });
  });

  it('bitwise → expr（按运算符生成表达式模板）', () => {
    expect(migrateNode({ id: 'b', packId: '', nodeId: 'bitwise', x: 0, y: 0, params: { a: '0xf0', b: '2', op: '<<' } }))
      .toMatchObject({ nodeId: 'expr', params: { a: '0xf0', b: '2', formula: 'a << b' } });
    expect(migrateNode({ id: 'b2', packId: '', nodeId: 'bitwise', x: 0, y: 0, params: {} }))
      .toMatchObject({ nodeId: 'expr', params: { formula: 'a & b' } });
  });

  it('float → readint（size 映射为 f4 / f8）', () => {
    expect(migrateNode({ id: 'f', packId: '', nodeId: 'float', x: 0, y: 0, params: { address: '0x0', size: '8' } }))
      .toMatchObject({ nodeId: 'readint', params: { size: 'f8' } });
  });

  it('pack 节点与未受影响的内置节点原样返回', () => {
    const pack: BPNode = { id: 's', packId: 'p1', nodeId: 'sq', x: 0, y: 0, params: {} };
    const keep: BPNode = { id: 'n', packId: '', nodeId: 'readint', x: 0, y: 0, params: { address: '0x0' } };
    expect(migrateNode(pack)).toEqual(pack);
    expect(migrateNode(keep)).toEqual(keep);
  });

  it('deserialize 对缓存里的旧节点套用迁移', () => {
    const raw = JSON.stringify({
      version: 1, savedAt: 0, packs: [],
      nodes: [{ id: 'p', packId: '', nodeId: 'pointer', x: 0, y: 0, params: { address: '0x10' } }],
      edges: [],
    });
    const r = deserialize(raw);
    expect(r.doc?.nodes[0]?.nodeId).toBe('ptrwalk');
  });
});
