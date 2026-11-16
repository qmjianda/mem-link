import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { deserialize, serialize } from '../src/bp/persist';
import { isPackEnabled, type DocState, type LoadedPack } from '../src/bp/docstate';
import {
  TEMPLATE_PACK_SOURCE, addPack, cleanupPackNodes, disabledPackIds, enabledPackMap, packImpact,
  removePackAtomic, renamePack, setPackEnabled, uniquePackName,
} from '../src/bp/packops';
import type { BPNode } from '../src/bp/types';

function mkPack(id: string, name: string, enabled?: boolean): LoadedPack {
  const r = loadBlueprintPack(demoSource);
  if (!r.pack) throw new Error(`demo pack 编译失败：${r.error}`);
  return { id, name, source: demoSource, pack: r.pack, enabled };
}

function node(id: string, packId: string, x = 0): BPNode {
  return { id, packId, nodeId: packId ? 'header' : 'file', x, y: 0, params: {} };
}

/**
 * p1: n1, n2   p2: n3   内置: nf
 * e1 p1↔p1 / e2 p1↔p2 / e3 内置↔p1 / e4 p2↔内置
 */
function sampleDoc(): DocState {
  return {
    packs: [mkPack('p1', 'Alpha', true), mkPack('p2', 'Beta', true)],
    nodes: [node('n1', 'p1'), node('n2', 'p1', 100), node('n3', 'p2', 200), node('nf', '', 300)],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'buffer' }, to: { node: 'n2', port: 'buffer' } },
      { id: 'e2', from: { node: 'n2', port: 'head' }, to: { node: 'n3', port: 'address' } },
      { id: 'e3', from: { node: 'nf', port: 'buffer' }, to: { node: 'n1', port: 'buffer' } },
      { id: 'e4', from: { node: 'n3', port: 'head' }, to: { node: 'nf', port: 'address' } },
    ],
  };
}

const ids = (list: { id: string }[]): string[] => list.map((x) => x.id);

describe('packImpact', () => {
  it('统计节点数与任一端落在该 pack 的连线数', () => {
    const doc = sampleDoc();
    expect(packImpact(doc, 'p1')).toEqual({ nodes: 2, edges: 3 });
    expect(packImpact(doc, 'p2')).toEqual({ nodes: 1, edges: 2 });
  });

  it('未涉及任何节点的 pack 返回 0', () => {
    expect(packImpact(sampleDoc(), 'nope')).toEqual({ nodes: 0, edges: 0 });
  });
});

describe('removePackAtomic', () => {
  it('删 pack 后不留孤儿连线', () => {
    const doc = sampleDoc();
    const next = removePackAtomic(doc, 'p2');
    expect(ids(next.packs)).toEqual(['p1']);
    expect(ids(next.nodes)).toEqual(['n1', 'n2', 'nf']);
    expect(ids(next.edges)).toEqual(['e1', 'e3']);
    const alive = new Set(next.nodes.map((n) => n.id));
    expect(next.edges.every((e) => alive.has(e.from.node) && alive.has(e.to.node))).toBe(true);
  });

  it('未涉及的节点与连线保持同一引用（历史栈不翻倍）', () => {
    const doc = sampleDoc();
    const next = removePackAtomic(doc, 'p2');
    expect(next.nodes[0]).toBe(doc.nodes[0]);
    expect(next.nodes[2]).toBe(doc.nodes[3]);
    expect(next.edges[0]).toBe(doc.edges[0]);
    expect(next.packs[0]).toBe(doc.packs[0]);
  });

  it('pack 不存在时原样返回', () => {
    const doc = sampleDoc();
    expect(removePackAtomic(doc, 'nope')).toBe(doc);
  });
});

describe('setPackEnabled', () => {
  it('禁用只改 enabled，节点与连线数量不变', () => {
    const doc = sampleDoc();
    const off = setPackEnabled(doc, 'p1', false);
    expect(off.packs[0].enabled).toBe(false);
    expect(isPackEnabled(off.packs[0])).toBe(false);
    expect(off.nodes).toBe(doc.nodes);
    expect(off.edges).toBe(doc.edges);
    expect(off.nodes.length).toBe(4);
    expect(off.edges.length).toBe(4);
  });

  it('再次启用恢复', () => {
    const doc = setPackEnabled(sampleDoc(), 'p1', false);
    const on = setPackEnabled(doc, 'p1', true);
    expect(isPackEnabled(on.packs[0])).toBe(true);
    expect(on.nodes.length).toBe(4);
  });

  it('状态未变化或 pack 不存在时原样返回', () => {
    const doc = sampleDoc();
    expect(setPackEnabled(doc, 'p1', true)).toBe(doc);
    expect(setPackEnabled(doc, 'nope', false)).toBe(doc);
  });

  it('enabledPackMap 只含启用的 pack，disabledPackIds 反之', () => {
    const doc = setPackEnabled(sampleDoc(), 'p2', false);
    const map = enabledPackMap(doc.packs);
    expect([...map.keys()]).toEqual(['p1']);
    expect([...disabledPackIds(doc.packs)]).toEqual(['p2']);
  });
});

describe('renamePack', () => {
  it('去首尾空格并折叠连续空格', () => {
    const r = renamePack(sampleDoc(), 'p1', '  Delta   Force  ');
    expect(r.code).toBe('OK');
    expect(r.name).toBe('Delta Force');
    expect(r.doc.packs[0].name).toBe('Delta Force');
    expect(r.doc.packs[1].name).toBe('Beta');
  });

  it('空名拒绝，文档不变', () => {
    const doc = sampleDoc();
    const r = renamePack(doc, 'p1', '   ');
    expect(r.code).toBe('EMPTY');
    expect(r.doc).toBe(doc);
  });

  it('重名自动加后缀', () => {
    const r = renamePack(sampleDoc(), 'p1', 'Beta');
    expect(r.code).toBe('OK');
    expect(r.name).toBe('Beta (2)');
    expect(new Set(r.doc.packs.map((p) => p.name)).size).toBe(2);
  });

  it('同名视为无变化，pack 不存在返回 MISSING', () => {
    const doc = sampleDoc();
    expect(renamePack(doc, 'p1', 'Alpha').code).toBe('UNCHANGED');
    expect(renamePack(doc, 'nope', 'x').code).toBe('MISSING');
  });

  it('uniquePackName 从 (2) 起递增', () => {
    expect(uniquePackName([], 'x')).toBe('x');
    expect(uniquePackName(['x'], 'x')).toBe('x (2)');
    expect(uniquePackName(['x', 'x (2)'], 'x')).toBe('x (3)');
  });
});

describe('cleanupPackNodes', () => {
  it('只删该 pack 的节点与关联连线，pack 仍在', () => {
    const doc = sampleDoc();
    const next = cleanupPackNodes(doc, 'p1');
    expect(ids(next.packs)).toEqual(['p1', 'p2']);
    expect(ids(next.nodes)).toEqual(['n3', 'nf']);
    expect(ids(next.edges)).toEqual(['e4']);
  });

  it('没有该 pack 的节点时原样返回', () => {
    const doc = sampleDoc();
    expect(cleanupPackNodes(doc, 'nope')).toBe(doc);
  });
});

describe('addPack', () => {
  it('id 冲突时重新分配，名字冲突时加后缀', () => {
    const doc = sampleDoc();
    const added = addPack(doc, mkPack('p1', 'Alpha'));
    expect(added.pack.id).toBe('p1-2');
    expect(added.pack.name).toBe('Alpha (2)');
    expect(ids(added.doc.packs)).toEqual(['p1', 'p2', 'p1-2']);
    expect(added.doc.packs[2]).toBe(added.pack);
    expect(isPackEnabled(added.pack)).toBe(true);
  });

  it('id 不冲突时保持原 id', () => {
    const added = addPack(sampleDoc(), mkPack('p9', 'Gamma'));
    expect(added.pack.id).toBe('p9');
    expect(added.pack.name).toBe('Gamma');
  });
});

describe('模板 pack', () => {
  it('模板源码能通过 loadBlueprintPack 校验且含 struct + structNode', () => {
    const r = loadBlueprintPack(TEMPLATE_PACK_SOURCE);
    expect(r.error).toBeUndefined();
    expect(r.pack).toBeTruthy();
    expect(Object.keys(r.pack!.types)).toContain('Head');
    expect(Object.keys(r.pack!.nodes)).toContain('head');
    expect(r.pack!.nodes.head.kind).toBe('struct');
  });
});

describe('persist：enabled 向后兼容', () => {
  it('旧缓存没有 enabled 字段 → 反序列化后视为启用', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 1,
      packs: [{ id: 'p1', name: 'Alpha', source: demoSource }],
      nodes: [],
      edges: [],
    });
    const r = deserialize(raw);
    expect(r.code).toBe('OK');
    expect(r.doc!.packs[0].enabled).toBe(true);
    expect(isPackEnabled(r.doc!.packs[0])).toBe(true);
  });

  it('显式 false 被保留，且序列化写回 enabled', () => {
    const doc = setPackEnabled(sampleDoc(), 'p2', false);
    const r = deserialize(serialize(doc));
    expect(r.doc!.packs[0].enabled).toBe(true);
    expect(r.doc!.packs[1].enabled).toBe(false);
    const payload = JSON.parse(serialize(doc));
    expect(payload.packs[1]).toMatchObject({ id: 'p2', enabled: false });
  });
});
