import { describe, expect, it } from 'vitest';
import type { DocState } from '../src/bp/docstate';
import { docJson } from '../src/bp/docstate';
import {
  PASTE_STEP, duplicateSelection, extractFragment, pasteFragment, pasteOffset,
} from '../src/bp/clipboard';
import {
  addNodes, clearSelection, countSelection, deleteSelection, emptySelection, isEmptySelection, primarySelection,
  retainSelection, selectAll, selectOnlyEdge, selectOnlyNode, setEntry, summaryOf, toggleEdge, toggleNode,
} from '../src/bp/selection';
import { bytesToBase64 } from '../src/bp/doc';
import type { BPNode } from '../src/bp/types';

function node(id: string, x = 0, params: Record<string, string> = {}): BPNode {
  return { id, packId: 'p1', nodeId: 'header', x, y: 0, params: { ...params } };
}

function fileNode(id = 'nf'): BPNode {
  return {
    id,
    packId: '',
    nodeId: 'file',
    x: 0,
    y: 100,
    params: { name: 'demo.bin' },
    source: { name: 'demo.bin', base: 0x1000, data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) },
  };
}

/**
 * n1 ——e1——> n2        n3（独立）
 * nf ——e2——> n1        n1 ——e3——> n3（跨到未选中节点）
 */
function sampleDoc(): DocState {
  return {
    packs: [],
    nodes: [node('n1', 0), node('n2', 300), node('n3', 600), fileNode()],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'head' }, to: { node: 'n2', port: 'address' } },
      { id: 'e2', from: { node: 'nf', port: 'buffer' }, to: { node: 'n1', port: 'buffer' } },
      { id: 'e3', from: { node: 'n1', port: 'head' }, to: { node: 'n3', port: 'address' } },
    ],
  };
}

let counter = 0;
function idGen(prefix = 'x'): () => string {
  return () => `${prefix}${++counter}`;
}

describe('extractFragment', () => {
  it('只保留两端都在选择内的连线', () => {
    const doc = sampleDoc();
    const sel = addNodes(emptySelection(), ['n1', 'n2']);
    const frag = extractFragment(doc, sel);
    expect(frag).toBeTruthy();
    expect(frag!.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    // e3 的目标 n3 未被选中 → 不进入片段
    expect(frag!.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('只选中连线（端点未选）返回 null，避免悬空', () => {
    const doc = sampleDoc();
    expect(extractFragment(doc, toggleEdge(emptySelection(), 'e1'))).toBeNull();
  });

  it('空选择返回 null', () => {
    expect(extractFragment(sampleDoc(), emptySelection())).toBeNull();
  });

  it('节点参数是深拷贝：改副本不影响原 doc', () => {
    const doc: DocState = { packs: [], nodes: [node('n1', 0, { address: '0x10' })], edges: [] };
    const frag = extractFragment(doc, selectOnlyNode('n1'))!;
    frag.nodes[0].params.address = '0x99';
    expect(doc.nodes[0].params.address).toBe('0x10');
  });
});

describe('pasteFragment', () => {
  it('id 全部重映射且不重复，连线指向新节点', () => {
    const doc = sampleDoc();
    const frag = extractFragment(doc, addNodes(emptySelection(), ['n1', 'n2']))!;
    counter = 0;
    const r = pasteFragment(doc, frag, { offset: PASTE_STEP, nextId: idGen() });
    const ids = r.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('n1');
    expect(r.doc.nodes.length).toBe(doc.nodes.length + 2);
    expect(r.doc.edges.length).toBe(doc.edges.length + 1);
    const pasted = r.edges[0];
    expect(ids).toContain(pasted.from.node);
    expect(ids).toContain(pasted.to.node);
    expect(pasted.from.port).toBe('head');
    expect(pasted.to.port).toBe('address');
  });

  it('坐标整体偏移，参数深拷贝', () => {
    const doc = sampleDoc();
    const frag = extractFragment(doc, selectOnlyNode('n2'))!;
    counter = 0;
    const r = pasteFragment(doc, frag, { offset: PASTE_STEP, nextId: idGen() });
    expect(r.nodes[0].x).toBe(300 + PASTE_STEP);
    expect(r.nodes[0].params).not.toBe(doc.nodes[1].params);
  });

  it('连续两次粘贴 offset 递增 24 / 48', () => {
    const doc = sampleDoc();
    const frag = extractFragment(doc, selectOnlyNode('n1'))!;
    counter = 0;
    const first = pasteFragment(doc, frag, { offset: pasteOffset(1), nextId: idGen() });
    const second = pasteFragment(first.doc, frag, { offset: pasteOffset(2), nextId: idGen() });
    expect(first.nodes[0].x).toBe(PASTE_STEP);
    expect(second.nodes[0].x).toBe(PASTE_STEP * 2);
    expect(pasteOffset(1)).toBe(24);
    expect(pasteOffset(3)).toBe(72);
  });

  it('File 节点 source 引用保留（base64 不复制字节）', () => {
    const doc = sampleDoc();
    const frag = extractFragment(doc, selectOnlyNode('nf'))!;
    counter = 0;
    const r = pasteFragment(doc, frag, { offset: 24, nextId: idGen() });
    expect(r.nodes[0].source?.data).toBe(doc.nodes[3].source!.data);
    expect(r.nodes[0].source?.name).toBe('demo.bin');
    expect(r.nodes[0].source?.base).toBe(0x1000);
  });

  it('生成器撞上已有 id 时跳过，不产生冲突', () => {
    const doc = sampleDoc();
    const frag = extractFragment(doc, selectOnlyNode('n1'))!;
    const seq = ['n1', 'n2', 'fresh'];
    let i = 0;
    const r = pasteFragment(doc, frag, { offset: 24, nextId: () => seq[i++] ?? `z${i}` });
    expect(r.nodes[0].id).toBe('fresh');
    expect(new Set(r.doc.nodes.map((n) => n.id)).size).toBe(r.doc.nodes.length);
  });
});

describe('duplicateSelection', () => {
  it('节点数与连线数正确，原 doc 不变', () => {
    const doc = sampleDoc();
    const before = docJson(doc);
    counter = 0;
    const r = duplicateSelection(doc, addNodes(emptySelection(), ['n1', 'n2']), idGen())!;
    expect(r.nodes.length).toBe(2);
    expect(r.edges.length).toBe(1);
    expect(docJson(doc)).toBe(before);
    expect(docJson(r.doc)).not.toBe(before);
  });

  it('空选择返回 null', () => {
    expect(duplicateSelection(sampleDoc(), emptySelection(), idGen())).toBeNull();
  });
});

describe('deleteSelection', () => {
  it('删节点连带其连线，不留孤儿，未选中对象引用不变', () => {
    const doc = sampleDoc();
    const next = deleteSelection(doc, selectOnlyNode('n1'));
    expect(next.nodes.map((n) => n.id)).toEqual(['n2', 'n3', 'nf']);
    expect(next.edges.map((e) => e.id)).toEqual([]);
    const alive = new Set(next.nodes.map((n) => n.id));
    expect(next.edges.every((e) => alive.has(e.from.node) && alive.has(e.to.node))).toBe(true);
    expect(next.nodes[0]).toBe(doc.nodes[1]);
    expect(next.nodes[2]).toBe(doc.nodes[3]);
  });

  it('同时删节点与连线，一次产出', () => {
    const doc = sampleDoc();
    const sel = addNodes(toggleEdge(emptySelection(), 'e1'), ['n3']);
    const next = deleteSelection(doc, sel);
    expect(next.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'nf']);
    expect(next.edges.map((e) => e.id)).toEqual(['e2']);
  });

  it('空选择或无可删对象时返回原 doc', () => {
    const doc = sampleDoc();
    expect(deleteSelection(doc, emptySelection())).toBe(doc);
    expect(deleteSelection(doc, selectOnlyNode('nope'))).toBe(doc);
  });
});

describe('选择模型', () => {
  it('toggle 切换单个对象，其余不变', () => {
    let s = selectOnlyNode('n1');
    s = toggleNode(s, 'n2');
    expect([...s.nodes]).toEqual(['n1', 'n2']);
    expect(s.primary).toEqual({ kind: 'node', id: 'n2' });
    s = toggleNode(s, 'n1');
    expect([...s.nodes]).toEqual(['n2']);
    expect(s.primary).toEqual({ kind: 'node', id: 'n2' });
    s = toggleNode(s, 'n2');
    expect(isEmptySelection(s)).toBe(true);
    expect(s.primary).toBeNull();
  });

  it('selectAll 覆盖全部节点与连线', () => {
    const s = selectAll(sampleDoc());
    expect(s.nodes.size).toBe(4);
    expect(s.edges.size).toBe(3);
    expect(countSelection(s)).toBe(7);
    expect(s.primary).toEqual({ kind: 'node', id: 'n1' });
  });

  it('primarySelection 给检查器的单值视图：entry 优先', () => {
    expect(primarySelection(emptySelection())).toBeNull();
    expect(primarySelection(selectOnlyNode('n1'))).toEqual({ kind: 'node', id: 'n1' });
    expect(primarySelection(selectOnlyEdge('e1'))).toEqual({ kind: 'edge', id: 'e1' });
    const withEntry = setEntry(selectOnlyNode('n1'), 'n1', 2);
    expect(primarySelection(withEntry)).toEqual({ kind: 'entry', nodeId: 'n1', index: 2 });
  });

  it('retainSelection 把已不存在的对象剔除，并修正 primary', () => {
    const doc = sampleDoc();
    const s = addNodes(emptySelection(), ['n1', 'n2']);
    const after = deleteSelection(doc, selectOnlyNode('n1'));
    const kept = retainSelection(s, after);
    expect([...kept.nodes]).toEqual(['n2']);
    expect(kept.primary).toEqual({ kind: 'node', id: 'n2' });
  });

  it('summaryOf 文案', () => {
    expect(summaryOf(emptySelection()).text).toBe('未选中');
    expect(summaryOf(selectOnlyNode('n1')).text).toBe('选中：节点');
    expect(summaryOf(selectOnlyEdge('e1')).text).toBe('选中：连线');
    expect(summaryOf(setEntry(selectOnlyNode('n1'), 'n1', 0)).text).toBe('选中：元素');
    expect(summaryOf(addNodes(emptySelection(), ['n1', 'n2', 'n3'])).text).toBe('已选 3 个对象');
  });

  it('clearSelection 清空两个集合', () => {
    const s = clearSelection();
    expect(isEmptySelection(s)).toBe(true);
    expect(s.primary).toBeNull();
    expect(s.entry).toBeUndefined();
  });
});
