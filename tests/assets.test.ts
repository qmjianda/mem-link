/**
 * 资产身份：内容决定 id，名称/基址/长度都不参与。
 * 覆盖 spec `buffer-assets`：同名同长不同内容不互相顶替、同内容只留一份字节、
 * 旧文档内联字节自动登记。
 */
import { describe, expect, it } from 'vitest';
import demoDoc from '../samples/demo.blueprint.json';
import { assetIdOf, cachedAssetIdOf, createAssetTable, fnv1a64 } from '../src/bp/assets';
import { bytesToBase64, parseDoc, rebaseStored, withSessionBytes } from '../src/bp/doc';
import { deserialize } from '../src/bp/persist';
import { evaluateGraph } from '../src/bp/eval';
import { loadBlueprintPack } from '../src/bp/load';
import type { BPEdge, BPNode, BlueprintPack } from '../src/bp/types';

function fileNode(id: string, name: string, base: number, bytes: Uint8Array): BPNode {
  return {
    id, packId: '', nodeId: 'file', x: 0, y: 0,
    params: { name },
    source: { name, base, data: bytesToBase64(bytes) },
  };
}

function evalFiles(nodes: BPNode[], edges: BPEdge[] = []) {
  return evaluateGraph(nodes, edges, new Map());
}

describe('FNV-1a 64', () => {
  it('匹配公开测试向量', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(fnv1a64(enc(''))).toBe('cbf29ce484222325');
    expect(fnv1a64(enc('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(enc('foobar'))).toBe('85944171f73967e8');
  });

  it('1 MiB 输入在 10 ms 内完成', () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    // 取三次最好的一次：单次计时会被 JIT 预热与机器负载放大，
    // 这里要证明的是算法本身的量级，不是某一次调度的运气
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      assetIdOf(bytes);
      best = Math.min(best, performance.now() - t);
    }
    expect(assetIdOf(bytes)).toMatch(/^a1:[0-9a-f]{16}$/);
    expect(best).toBeLessThan(10);
  });

  it('分块载入的不同前缀不会得到同一个 id', () => {
    expect(assetIdOf(new Uint8Array([1, 2, 3]))).not.toBe(assetIdOf(new Uint8Array([1, 2, 3, 4])));
  });
});

describe('内容哈希缓存', () => {
  it('同一 buffer 与范围复用同一个 id', () => {
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 17) & 0xff);
    expect(cachedAssetIdOf(bytes)).toBe(assetIdOf(bytes));
    expect(cachedAssetIdOf(bytes)).toBe(cachedAssetIdOf(bytes));
    const range = bytes.subarray(100, 900);
    expect(cachedAssetIdOf(range)).toBe(assetIdOf(range));
    // 共享 ArrayBuffer 的另一个 view 命中同一范围缓存
    expect(cachedAssetIdOf(bytes.subarray(100, 900))).toBe(cachedAssetIdOf(range));
    expect(cachedAssetIdOf(bytes.subarray(100, 901))).not.toBe(cachedAssetIdOf(range));
  });
});

describe('AssetTable 去重', () => {
  it('同内容返回同一个条目（字节对象同一）', () => {
    const table = createAssetTable();
    const a = table.ensure(new Uint8Array([1, 2, 3]));
    const b = table.ensure(new Uint8Array([1, 2, 3]));
    expect(b.id).toBe(a.id);
    expect(b.bytes).toBe(a.bytes);
    expect(table.size).toBe(1);
  });

  it('不同内容各自登记', () => {
    const table = createAssetTable();
    table.ensure(new Uint8Array([1, 2, 3]));
    table.ensure(new Uint8Array([3, 2, 1]));
    expect(table.size).toBe(2);
  });
});

describe('求值中的资产身份', () => {
  it('同名同长不同内容 → 两个资产，各指向自己的字节', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([4, 3, 2, 1]);
    const r = evalFiles([fileNode('f1', 'dump.bin', 0, a), fileNode('f2', 'dump.bin', 0, b)]);
    const id1 = r.sources.get('f1')?.assetId;
    const id2 = r.sources.get('f2')?.assetId;
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(r.assets.size).toBe(2);
    expect(r.outputs.get('f1')?.buffer).toMatchObject({ base: 0 });
    expect(Array.from((r.outputs.get('f1')?.buffer as { bytes: Uint8Array }).bytes)).toEqual([1, 2, 3, 4]);
  });

  it('同内容两个节点 → 同一 assetId 且只有一份字节', () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const r = evalFiles([fileNode('f1', 'a.bin', 0, bytes), fileNode('f2', 'b.bin', 0, bytes)]);
    expect(r.sources.get('f1')?.assetId).toBe(r.sources.get('f2')?.assetId);
    expect(r.assets.size).toBe(1);
    const b1 = r.outputs.get('f1')?.buffer as { bytes: Uint8Array };
    const b2 = r.outputs.get('f2')?.buffer as { bytes: Uint8Array };
    expect(b1.bytes).toBe(b2.bytes);
  });

  it('同内容不同基址：assetId 相同，基址各自保留', () => {
    const bytes = new Uint8Array([7, 7]);
    const r = evalFiles([fileNode('f1', 'a.bin', 0, bytes), fileNode('f2', 'a.bin', 0x1000, bytes)]);
    expect(r.sources.get('f1')?.assetId).toBe(r.sources.get('f2')?.assetId);
    expect(r.sources.get('f1')?.buffer?.base).toBe(0);
    expect(r.sources.get('f2')?.buffer?.base).toBe(0x1000);
  });

  it('继承链上的节点与上游 File 共用 assetId', () => {
    const parsed = parseDoc(JSON.stringify(demoDoc));
    expect(parsed.error).toBeUndefined();
    const doc = parsed.doc!;
    const packs = new Map<string, BlueprintPack>();
    for (const p of doc.packs) {
      const r = loadBlueprintPack(p.source);
      packs.set(p.id, r.pack!);
    }
    const r = evaluateGraph(doc.nodes, doc.edges, packs);
    const file = r.sources.get('n_file')?.assetId;
    expect(file).toBeTruthy();
    expect(r.sources.get('n_header')?.assetId).toBe(file);
    expect(r.sources.get('n_list')?.assetId).toBe(file);
  });
});

describe('会话内大文件', () => {
  it('没有 base64 时直接使用会话字节求值，改基址后复用', () => {
    const bytes = Uint8Array.from({ length: 1024 }, (_, i) => (i * 13) & 0xff);
    const source = withSessionBytes({ name: 'big.sqlite', base: 0, data: '' }, bytes);
    const node: BPNode = { id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: {}, source };
    const first = evalFiles([node]);
    expect(first.sources.get('f')?.assetId).toBe(assetIdOf(bytes));
    expect(first.outputs.get('f')?.buffer).toMatchObject({ name: 'big.sqlite', base: 0 });
    expect((first.outputs.get('f')?.buffer as { bytes: Uint8Array }).bytes).toBe(bytes);

    const rebased: BPNode = { ...node, source: rebaseStored(source, 0x1000) };
    const second = evalFiles([rebased]);
    expect(second.sources.get('f')?.assetId).toBe(assetIdOf(bytes));
    expect(second.sources.get('f')?.buffer?.base).toBe(0x1000);
    expect((second.outputs.get('f')?.buffer as { bytes: Uint8Array }).bytes).toBe(bytes);
  });

  it('重复求值不再重算整份内容哈希', () => {
    const bytes = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
    const source = withSessionBytes({ name: 'big.bin', base: 0, data: '' }, bytes);
    const node: BPNode = { id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: {}, source };
    // 第一次求值做一次完整哈希（8 MB 约几十毫秒），第二次应命中缓存。
    evalFiles([node]);
    const t = performance.now();
    evalFiles([node]);
    expect(performance.now() - t).toBeLessThan(20);
  });
});

describe('当前图文档无需重新载入转储', () => {
  it('当前缓存内联的 base64 在载入后自动登记为资产', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const node = fileNode('f1', 'old.bin', 0, bytes);
    const raw = JSON.stringify({ version: 3, savedAt: 0, packs: [], nodes: [node], edges: [] });
    const loaded = deserialize(raw);
    expect(loaded.code).toBe('OK');
    const r = evaluateGraph(loaded.doc!.nodes, loaded.doc!.edges, new Map());
    expect(r.assets.size).toBe(1);
    expect(r.assets.ids()[0]).toBe(assetIdOf(bytes));
  });
});
