import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { evaluateGraph, portsFor } from '../src/bp/eval';
import { bytesToBase64, makeDoc, parseDoc } from '../src/bp/doc';
import type { BPEdge, BPNode } from '../src/bp/types';
import { canConnect, dropPosition } from '../src/bp/types';
import { demoBinary } from '../src/core/project';

function loadDemo() {
  const r = loadBlueprintPack(demoSource);
  expect(r.error).toBeUndefined();
  expect(r.pack).toBeTruthy();
  return r.pack!;
}

function node(id: string, packId: string, nodeId: string, params: Record<string, string> = {}, x = 0, y = 0): BPNode {
  return { id, packId, nodeId, x, y, params };
}

function fileNode(id = 'f', bytes = demoBinary(), base = 0, name = 'demo.bin'): BPNode {
  return {
    ...node(id, '', 'file', { name }),
    source: { name, base, data: bytesToBase64(bytes) },
  };
}

function edge(id: string, from: [string, string], to: [string, string]): BPEdge {
  return { id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } };
}

describe('blueprint pack', () => {
  it('loads types and nodes from a .bp.ts source', () => {
    const pack = loadDemo();
    expect(pack.name).toBe('demo-index-list');
    expect(pack.types.Header.size).toBe(8);
    expect(pack.types.Entry.size).toBe(24);
    expect(Object.keys(pack.nodes)).toEqual(
      expect.arrayContaining(['header', 'entryList', 'entryArray', 'indexToAddr']),
    );
  });

  it('keeps file buffers inside nodes when saving a graph', () => {
    const doc = makeDoc([], [fileNode()], []);
    expect((doc as unknown as { memory?: unknown }).memory).toBeUndefined();
    expect(doc.nodes[0].source?.name).toBe('demo.bin');
    const r = parseDoc(JSON.stringify(doc));
    expect(r.error).toBeUndefined();
    expect(r.doc?.nodes[0].source?.data.length).toBeGreaterThan(100);
  });

  it('rejects a pack with no types', () => {
    const r = loadBlueprintPack(`export default definePack({ types: {}, nodes: {} });`);
    expect(r.error).toBeTruthy();
    expect(r.issues.some((p) => p.severity === 'error')).toBe(true);
  });
});

describe('blueprint evaluator', () => {
  const pack = loadDemo();
  const packs = new Map([['p', pack]]);

  const header = node('h', 'p', 'header', { address: '0x0' });
  const list = node('l', 'p', 'entryList', { address: '0x130' });
  const f = fileNode();

  it('decodes a struct from a file node buffer', () => {
    const r = evaluateGraph([f, header], [edge('e0', ['f', 'buffer'], ['h', 'buffer'])], packs);
    expect(r.outputs.get('h')?.head).toBe(0x130);
    expect(r.outputs.get('h')?.tail).toBe(0x1a8);
    expect(r.outputs.get('h')?.magic).toBe(0xbeef);
    expect(r.views.get('h')?.kind).toBe('struct');
  });

  it('walks an index-linked list inside one node', () => {
    const r = evaluateGraph([f, list], [edge('e0', ['f', 'buffer'], ['l', 'buffer'])], packs);
    const view = r.views.get('l');
    expect(view?.kind).toBe('list');
    if (view?.kind !== 'list') throw new Error('not a list');
    expect(view.items.map((x) => x.addr)).toEqual([0x130, 0x178, 0x118, 0x1a8]);
    expect(view.items.map((x) => x.fields.find((f) => f.name === 'name')?.value))
      .toEqual(['alpha', 'gamma', 'beta', 'delta']);
    expect(view.count).toBe(4);
  });

  it('wires a field into a list address', () => {
    const r = evaluateGraph(
      [f, header, list],
      [
        edge('e0', ['f', 'buffer'], ['h', 'buffer']),
        edge('e1', ['f', 'buffer'], ['l', 'buffer']),
        edge('e2', ['h', 'head'], ['l', 'address']),
      ],
      packs,
    );
    const view = r.views.get('l');
    if (view?.kind !== 'list') throw new Error('not a list');
    expect(view.items).toHaveLength(4);
  });

  it('parses two files independently through two file nodes', () => {
    const bytes = demoBinary();
    bytes[2] = 7; // second file's header.head = 7
    const f2 = fileNode('f2', bytes);
    const h2 = node('h2', 'p', 'header', { address: '0x0' });
    const r = evaluateGraph(
      [f, f2, header, h2],
      [
        edge('e0', ['f', 'buffer'], ['h', 'buffer']),
        edge('e1', ['f2', 'buffer'], ['h2', 'buffer']),
      ],
      packs,
    );
    expect(r.outputs.get('h')?.head).toBe(0x130);
    expect(r.outputs.get('h2')?.head).toBe(0x1a8);
  });

  it('requires a buffer for parsing nodes', () => {
    const r = evaluateGraph([header], [], packs);
    expect(r.problems.some((p) => p.message.includes('需要缓冲区'))).toBe(true);
  });

  it('adds an element node and exposes the selected entry fields', () => {
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Entry', index: '2' });
    const r = evaluateGraph(
      [f, list, el],
      [
        edge('e0', ['f', 'buffer'], ['l', 'buffer']),
        edge('e1', ['l', 'list'], ['e', 'list']),
      ],
      packs,
    );
    expect(r.outputs.get('e')?.name).toBe('beta');
    expect(r.outputs.get('e')?.addr).toBeUndefined();
    const view = r.views.get('e');
    expect(view?.kind).toBe('element');
    if (view?.kind === 'element') expect(view.inst?.addr).toBe(0x118);
  });

  it('runs a calc node and resolves its output port type', () => {
    const calc = node('c', 'p', 'indexToAddr', { index: '5' });
    const r = evaluateGraph([calc], [], packs);
    expect(r.outputs.get('c')?.address).toBe(0x178);
    const ports = portsFor(calc, packs);
    // every non-constant node has an optional data-source (context) input
    expect(ports.inputs.map((p) => p.name)).toEqual(['buffer', 'index']);
    expect(ports.outputs.map((p) => p.name)).toEqual(['address']);
  });

  it('reports out-of-bounds addresses', () => {
    const bad = node('b', 'p', 'header', { address: '0x400' });
    const r = evaluateGraph([f, bad], [edge('e0', ['f', 'buffer'], ['b', 'buffer'])], packs);
    expect(r.problems.some((p) => p.message.includes('求值失败') || p.message.includes('不在缓冲区'))).toBe(true);
  });
});

describe('implicit source tracing', () => {
  const pack = loadDemo();
  const packs = new Map([['p', pack]]);

  it('decodes without any buffer wire by falling back to the graph file', () => {
    const r = evaluateGraph([fileNode(), node('h', 'p', 'header', { address: '0x0' })], [], packs);
    expect(r.outputs.get('h')?.head).toBe(0x130);
    expect(r.sources.get('h')?.mode).toBe('default');
    expect(r.sources.get('h')?.buffer?.name).toBe('demo.bin');
    expect(r.problems.some((p) => p.message.includes('需要缓冲区'))).toBe(false);
  });

  it('traces the file back through upstream edges', () => {
    const h = node('h', 'p', 'header', { address: '0x0' });
    const l = node('l', 'p', 'entryList');
    const r = evaluateGraph(
      [fileNode(), h, l],
      [edge('e1', ['h', 'head'], ['l', 'address'])],
      packs,
    );
    const v = r.views.get('l');
    expect(v?.kind).toBe('list');
    if (v?.kind === 'list') expect(v.items.map((x) => x.addr)).toEqual([0x130, 0x178, 0x118, 0x1a8]);
    expect(r.sources.get('l')?.mode).toBe('upstream');
  });

  it('lets a node pin a file explicitly when several are loaded', () => {
    const bytes = demoBinary();
    bytes[2] = 7;
    const a = fileNode('f1');
    const b = fileNode('f2', bytes);
    b.source = { ...b.source!, name: 'second.bin' };
    const h1 = node('h1', 'p', 'header', { address: '0x0' });
    const h2 = node('h2', 'p', 'header', { address: '0x0', sourceId: 'f2' });
    const r = evaluateGraph(
      [a, b, h1, h2],
      [edge('e0', ['f1', 'buffer'], ['h1', 'buffer'])],
      packs,
    );
    expect(r.outputs.get('h1')?.head).toBe(0x130);
    expect(r.outputs.get('h2')?.head).toBe(0x1a8);
    expect(r.sources.get('h2')?.mode).toBe('override');
    expect(r.sources.get('h2')?.buffer?.name).toBe('second.bin');
  });

  it('prefers a data-source wire over a stale pinned file', () => {
    const bytes = demoBinary();
    bytes[2] = 7;
    const a = fileNode('f1');
    const b = fileNode('f2', bytes);
    b.source = { ...b.source!, name: 'second.bin' };
    // 复制节点带过来的 sourceId 指向 f1，用户随后把 f2 画到了数据源上。
    const h = node('h', 'p', 'header', { address: '0x0', sourceId: 'f1' });
    const r = evaluateGraph([a, b, h], [edge('e0', ['f2', 'buffer'], ['h', 'buffer'])], packs);
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.buffer?.name).toBe('second.bin');
    expect(r.outputs.get('h')?.head).toBe(0x1a8);
  });

  it('keeps an empty data-source wire authoritative instead of decoding another file', () => {
    const empty = node('f2', '', 'file', { name: 'empty.bin' });
    const h = node('h', 'p', 'header', { address: '0x0' });
    const r = evaluateGraph([fileNode('f1'), empty, h], [edge('e0', ['f2', 'buffer'], ['h', 'buffer'])], packs);
    // 用户画了线 = 明确指定：不能再悄悄读 f1
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.wireMissing).toBe(true);
    expect(r.sources.get('h')?.buffer).toBeUndefined();
    expect(r.outputs.get('h')?.head).toBeUndefined();
    expect(r.problems.some((p) => p.message.includes('来源没有文件内容'))).toBe(true);
  });

  it('keeps an empty pinned file authoritative too', () => {
    const empty = node('f2', '', 'file', { name: 'empty.bin' });
    const h = node('h', 'p', 'header', { address: '0x0', sourceId: 'f2' });
    const r = evaluateGraph([fileNode('f1'), empty, h], [], packs);
    expect(r.sources.get('h')?.mode).toBe('override');
    expect(r.sources.get('h')?.pinMissing).toBe(true);
    expect(r.sources.get('h')?.buffer).toBeUndefined();
    expect(r.outputs.get('h')?.head).toBeUndefined();
    expect(r.problems.some((p) => p.message.includes('指定的文件还没有载入内容'))).toBe(true);
  });

  it('uses a string handed over by a data-source wire as the buffer', () => {
    const constant = node('c', '', 'string', { value: 'hello world' });
    const t = node('t', '', 'text', { address: '0x0', length: '5' });
    const r = evaluateGraph([fileNode('f1'), constant, t], [edge('e0', ['c', 'text'], ['t', 'buffer'])], packs);
    const src = r.sources.get('t');
    expect(src?.mode).toBe('explicit');
    expect(src?.wireMissing).toBeUndefined();
    expect(src?.buffer?.base).toBe(0);
    expect(src?.buffer?.name).toContain('字符串');
    expect(new TextDecoder().decode(src?.buffer?.bytes)).toBe('hello world');
    expect(r.outputs.get('t')?.text).toBe('hello');
    expect(r.problems).toHaveLength(0);
  });

  it('still reports a fileless number handed to a data-source port', () => {
    const constant = node('c', '', 'number', { value: '16' });
    const h = node('h', 'p', 'header', { address: '0x0' });
    const r = evaluateGraph([fileNode('f1'), constant, h], [edge('e0', ['c', 'value'], ['h', 'buffer'])], packs);
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.wireMissing).toBe(true);
    expect(r.sources.get('h')?.buffer).toBeUndefined();
    expect(r.outputs.get('h')?.head).toBeUndefined();
    expect(r.problems.some((p) => p.message.includes('来源没有文件内容'))).toBe(true);
  });

  it('exposes an optional, connectable data-source input on parsing nodes', () => {
    const hp = portsFor(node('h', 'p', 'header'), packs).inputs;
    expect(hp.map((p) => p.name)).toEqual(['buffer', 'address']);
    expect(hp[0].context).toBe(true);
    expect(portsFor(node('a', 'p', 'entryArray'), packs).inputs.map((p) => p.name)).toEqual(['buffer', 'address']);
    // the File node is no longer an empty island
    expect(portsFor(fileNode(), packs).outputs.map((p) => p.name)).toEqual(['buffer', 'base', 'size']);
  });

  it('keeps source wires verbatim when opening a saved graph', () => {
    const doc = {
      format: 'memlink-blueprint/1',
      packs: [],
      nodes: [fileNode(), node('h', 'p', 'header', { address: '0x0' })],
      edges: [edge('e0', ['f', 'buffer'], ['h', 'buffer'])],
    };
    const r = parseDoc(JSON.stringify(doc));
    expect(r.error).toBeUndefined();
    expect(r.doc?.edges).toHaveLength(1);
    expect(r.doc?.edges[0].to.port).toBe('buffer');
    expect(r.doc?.nodes[1].params.sourceId).toBeUndefined();
  });

  it('drops dangling edges whose endpoints no longer exist', () => {
    const doc = makeDoc(
      [],
      [fileNode(), node('h', 'p', 'header', { address: '0x0' })],
      [edge('e0', ['f', 'buffer'], ['h', 'buffer']), edge('e1', ['ghost', 'x'], ['h', 'address'])],
    );
    expect(parseDoc(JSON.stringify(doc)).doc?.edges).toHaveLength(1);
  });
});

describe('element output ports', () => {
  const pack = loadDemo();
  const packs = new Map([['p', pack]]);
  const list = node('l', 'p', 'entryList', { address: '0x130' });

  it('exposes one instance port per list/array element', () => {
    const r = evaluateGraph([fileNode(), list], [], packs);
    const dyn = r.ports.get('l')?.outputs.filter((p) => p.dynamic) ?? [];
    expect(dyn.map((p) => p.name)).toEqual(['elem:0', 'elem:1', 'elem:2', 'elem:3']);
    expect(dyn.every((p) => p.type === 'instance')).toBe(true);
    const third = r.outputs.get('l')?.['elem:2'] as { addr: number; fields: { name: string; value: unknown }[] };
    expect(third.addr).toBe(0x118);
    expect(third.fields.find((x) => x.name === 'name')?.value).toBe('beta');

    const arr = node('a', 'p', 'entryArray', { address: '0x100' });
    const r2 = evaluateGraph([fileNode(), arr], [], packs);
    expect(r2.ports.get('a')?.outputs.filter((p) => p.dynamic)).toHaveLength(8);
  });

  it('wires an element straight into another node address, keeping the same file', () => {
    const h = node('h', 'p', 'header');
    const r = evaluateGraph([fileNode(), list, h], [edge('e1', ['l', 'elem:2'], ['h', 'address'])], packs);
    const v = r.views.get('h');
    expect(v?.kind).toBe('struct');
    if (v?.kind === 'struct') expect(v.inst?.addr).toBe(0x118);
    expect(r.sources.get('h')?.mode).toBe('upstream');
    expect(r.problems.some((p) => p.message.includes('需要缓冲区'))).toBe(false);
  });

  it('lets an Element node take a direct instance', () => {
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Entry' });
    const r = evaluateGraph([fileNode(), list, el], [edge('e1', ['l', 'elem:1'], ['e', 'instance'])], packs);
    expect(r.outputs.get('e')?.name).toBe('gamma');
    const v = r.views.get('e');
    if (v?.kind === 'element') expect(v.inst?.addr).toBe(0x178);
  });

  it('drives its ports from the wired element, not the inspector template', () => {
    // The template deliberately says Header: the wire must win, otherwise the
    // node keeps showing magic/head while actually decoding an Entry.
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Header' });
    const r = evaluateGraph([fileNode(), list, el], [edge('e1', ['l', 'elem:1'], ['e', 'instance'])], packs);
    const names = r.ports.get('e')?.outputs.map((p) => p.name) ?? [];
    expect(names).toEqual(['next', 'prev', 'flags', 'refcount', 'name', 'ts']);
    expect(names).not.toContain('magic');
    expect(r.outputs.get('e')?.name).toBe('gamma');
  });

  it('follows the list type when wired through list + index', () => {
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Header', index: '1' });
    const r = evaluateGraph([fileNode(), list, el], [edge('e1', ['l', 'list'], ['e', 'list'])], packs);
    expect(r.ports.get('e')?.outputs.map((p) => p.name))
      .toEqual(['next', 'prev', 'flags', 'refcount', 'name', 'ts']);
  });

  it('空元素节点不铺模板字段，接元素后才生成端口', () => {
    const el = node('e', '', 'element', {});
    const r = evaluateGraph([fileNode(), el], [], packs);
    expect(r.ports.get('e')?.inputs.map((p) => p.name))
      .toEqual(['buffer', 'instance', 'list', 'index']);
    expect(r.ports.get('e')?.outputs).toEqual([]);
    const v = r.views.get('e');
    expect(v?.kind).toBe('element');
    if (v?.kind === 'element') {
      expect(v.inst).toBeUndefined();
      expect(v.error).toBeUndefined();
    }
    // 空节点是合法状态，不进问题列表
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('元素节点可按地址 + 模板类型解码，端口随类型生成', () => {
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Entry', address: '0x130' });
    expect(portsFor(el, packs).inputs.map((p) => p.name))
      .toEqual(['buffer', 'address', 'instance', 'list', 'index']);
    const r = evaluateGraph([fileNode(), el], [], packs);
    const v = r.views.get('e');
    expect(v?.kind).toBe('element');
    if (v?.kind === 'element') {
      expect(v.inst?.addr).toBe(0x130);
      expect(v.inst?.typeName).toBe('Entry');
    }
    expect(r.outputs.get('e')?.name).toBe('alpha');
    expect(r.ports.get('e')?.outputs.map((p) => p.name))
      .toEqual(['next', 'prev', 'flags', 'refcount', 'name', 'ts']);
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('已连线元素优先于地址端口', () => {
    const el = node('e', '', 'element', { packId: 'p', typeId: 'Header', address: '0x0' });
    const r = evaluateGraph(
      [fileNode(), list, el],
      [
        edge('e1', ['l', 'elem:1'], ['e', 'instance']),
        edge('e2', ['l', 'count'], ['e', 'address']),
      ],
      packs,
    );
    const v = r.views.get('e');
    if (v?.kind === 'element') expect(v.inst?.addr).toBe(0x178);
    expect(r.outputs.get('e')?.name).toBe('gamma');
  });

  it('expands nested members for an element that has array/record fields', () => {
    const source = `
      const Inner = struct('Inner', 2, [u16('x', 0)]);
      const Outer = struct('Outer', 8, [array('vals', 0, 'Inner', 3), record('sub', 6, 'Inner')]);
      export default definePack({
        name: 'nested-array', types: { Inner, Outer },
        nodes: { outerArr: arrayNode(Outer, { count: 1 }) },
      });`;
    const loaded = loadBlueprintPack(source);
    expect(loaded.error).toBeUndefined();
    const nested = new Map([['q', loaded.pack!]]);
    const el = node('e', '', 'element', { packId: 'q', typeId: 'Inner' });
    const r = evaluateGraph(
      [fileNode(), node('o', 'q', 'outerArr', { address: '0x0' }), el],
      [edge('e1', ['o', 'elem:0'], ['e', 'instance'])],
      nested,
    );
    const outs = r.ports.get('e')?.outputs.map((p) => p.name) ?? [];
    expect(outs).toEqual(
      expect.arrayContaining(['vals', 'sub', 'elem:vals:0', 'elem:vals:1', 'elem:sub:x']),
    );
    expect(outs).not.toContain('magic');
  });

  it('allows instance -> number connections only', () => {
    expect(canConnect('instance', 'number')).toBe(true);
    expect(canConnect('instance', 'instance')).toBe(true);
    expect(canConnect('instance', 'list')).toBe(false);
    expect(canConnect('number', 'instance')).toBe(false);
  });

  it('exposes every nested array/record member of a struct as its own port', () => {
    const source = `
      const Inner = struct('Inner', 2, [u16('x', 0)]);
      const Outer = struct('Outer', 8, [array('vals', 0, 'Inner', 3), record('sub', 6, 'Inner')]);
      export default definePack({
        name: 'nested', types: { Inner, Outer },
        nodes: { outer: structNode(Outer) },
      });`;
    const loaded = loadBlueprintPack(source);
    expect(loaded.error).toBeUndefined();
    const nested = new Map([['q', loaded.pack!]]);
    const r = evaluateGraph([fileNode(), node('o', 'q', 'outer', { address: '0x0' })], [], nested);
    const dyn = r.ports.get('o')?.outputs.filter((p) => p.dynamic) ?? [];
    expect(dyn.map((p) => p.name)).toEqual([
      'elem:vals:0', 'elem:vals:1', 'elem:vals:2', 'elem:sub:x',
    ]);
    expect(r.outputs.get('o')?.['elem:vals:0']).toEqual({ x: 0xbeef });
    expect(typeof r.outputs.get('o')?.['elem:sub:x']).toBe('number');
  });
});

describe('file source inheritance', () => {
  const pack = loadDemo();
  const packs = new Map([['p', pack]]);

  it('uses an explicit File -> data-source wire and reports the origin', () => {
    const f = fileNode();
    const h = node('h', 'p', 'header', { address: '0x0' });
    const r = evaluateGraph([f, h], [edge('e0', ['f', 'buffer'], ['h', 'buffer'])], packs);
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.fileId).toBe('f');
    expect(r.inputs.get('h')?.buffer?.display).toBe('demo.bin');
  });

  it('inherits the file hop by hop, recording the full chain', () => {
    const f = fileNode();
    const h = node('h', 'p', 'header', { address: '0x0' });
    const l = node('l', 'p', 'entryList', { address: '' });
    const d = node('d', 'p', 'header', { address: '' });
    const r = evaluateGraph(
      [f, h, l, d],
      [
        edge('e0', ['f', 'buffer'], ['h', 'buffer']),
        edge('e1', ['h', 'head'], ['l', 'address']),
        edge('e2', ['l', 'elem:0'], ['d', 'address']),
      ],
      packs,
    );
    expect(r.sources.get('l')?.chain).toEqual(['l', 'h', 'f']);
    expect(r.sources.get('d')?.chain).toEqual(['d', 'l', 'h', 'f']);
    expect(r.sources.get('d')?.mode).toBe('upstream');
    const v = r.views.get('d');
    if (v?.kind === 'struct') expect(v.inst?.addr).toBe(0x130);
    expect(r.problems.some((p) => p.message.includes('需要缓冲区'))).toBe(false);
  });

  it('lets any upstream output feed a data-source input to inherit its file', () => {
    expect(canConnect('number', 'buffer')).toBe(true);
    expect(canConnect('instance', 'buffer')).toBe(true);
    expect(canConnect('buffer', 'number')).toBe(false);
    const l = node('l', 'p', 'entryList', { address: '0x130' });
    const d = node('d', 'p', 'header', { address: '0x0' });
    const r = evaluateGraph([fileNode(), l, d], [edge('e0', ['l', 'elem:1'], ['d', 'buffer'])], packs);
    expect(r.sources.get('d')?.mode).toBe('explicit');
    expect(r.sources.get('d')?.fileId).toBe('f');
  });

  it('does not treat a Number constant as a second, conflicting file', () => {
    const bytes = demoBinary();
    bytes[2] = 7;
    // second.bin is first in the array and would become the default file
    const f2 = fileNode('f2', bytes, 0, 'second.bin');
    const f1 = fileNode('f1');
    const num = node('n', '', 'number', { value: '0x0' });
    const h = node('h', 'p', 'header', { address: '' });
    const r = evaluateGraph(
      [f2, f1, num, h],
      [edge('e0', ['f1', 'buffer'], ['h', 'buffer']), edge('e1', ['n', 'value'], ['h', 'address'])],
      packs,
    );
    expect(r.sources.get('h')?.conflict).toBeUndefined();
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.outputs.get('h')?.head).toBe(0x130);
  });

  it('warns when two genuinely different files meet upstream', () => {
    const bytes = demoBinary();
    bytes[2] = 7;
    const f2 = fileNode('f2', bytes, 0, 'second.bin');
    const h1 = node('h1', 'p', 'header', { address: '0x0' });
    const h2 = node('h2', 'p', 'header', { address: '0x0' });
    const loaded = loadBlueprintPack(`export default definePack({
      name: 'two', types: { T: struct('T', 2, [u16('x', 0)]) },
      nodes: { both: calcNode({ inputs: { a: 'number', b: 'number' }, outputs: { sum: 'number' },
        run: ({ a, b }) => ({ sum: Number(a) + Number(b) }) }) } });`);
    expect(loaded.error).toBeUndefined();
    const both = node('both', 'q', 'both');
    const r = evaluateGraph(
      [fileNode('f1'), f2, h1, h2, both],
      [
        edge('a0', ['f1', 'buffer'], ['h1', 'buffer']),
        edge('a1', ['f2', 'buffer'], ['h2', 'buffer']),
        edge('a2', ['h1', 'head'], ['both', 'a']),
        edge('a3', ['h2', 'head'], ['both', 'b']),
      ],
      new Map([['p', pack], ['q', loaded.pack!]]),
    );
    expect(r.sources.get('both')?.conflict).toBe(true);
    expect(r.problems.some((p) => p.message.includes('不同的输入文件'))).toBe(true);
  });
});

describe('wired input values', () => {
  const pack = loadDemo();
  const packs = new Map([['p', pack]]);

  it('mirrors a wired number input as the real upstream value', () => {
    const h = node('h', 'p', 'header', { address: '0x0' });
    const l = node('l', 'p', 'entryList', { address: '0x999' });
    const r = evaluateGraph(
      [fileNode(), h, l],
      [edge('e0', ['f', 'buffer'], ['h', 'buffer']), edge('e1', ['h', 'head'], ['l', 'address'])],
      packs,
    );
    const iv = r.inputs.get('l')?.address;
    expect(iv?.wired).toBe(true);
    expect(iv?.value).toBe(0x130);
    expect(iv?.display).toBe('0x130');
    expect(iv?.inline).toBe('0x999');
    expect(iv?.from?.label).toContain('Header');
  });

  it('keeps inline values editable when no wire is attached', () => {
    const r = evaluateGraph([fileNode(), node('h', 'p', 'header', { address: '0x0' })], [], packs);
    expect(r.inputs.get('h')?.address).toMatchObject({ wired: false, inline: '0x0', value: 0 });
    expect(Object.keys(r.inputs.get('h') ?? {}).sort()).toEqual(['address', 'buffer']);
  });

  it('shows an element address for a wired instance input', () => {
    const l = node('l', 'p', 'entryList', { address: '0x130' });
    const e = node('e', '', 'element', { packId: 'p', typeId: 'Entry' });
    const r = evaluateGraph([fileNode(), l, e], [edge('e0', ['l', 'elem:1'], ['e', 'instance'])], packs);
    expect(r.outputs.get('e')?.name).toBe('gamma');
    expect(r.inputs.get('e')?.instance?.display).toContain('0x178');
  });

  it('publishes File base and size as connectable numbers', () => {
    const r = evaluateGraph([fileNode('f', demoBinary(), 0x1000)], [], packs);
    expect(r.outputs.get('f')?.base).toBe(0x1000);
    expect(r.outputs.get('f')?.size).toBe(demoBinary().length);
  });
});

describe('drag-to-add placement', () => {
  it('centres the new node under the drop point with the cursor on its title bar', () => {
    expect(dropPosition({ x: 500, y: 300 })).toEqual({ x: 357, y: 284 });
  });

  it('handles negative world coords from a panned canvas', () => {
    expect(dropPosition({ x: -120, y: -40 })).toEqual({ x: -263, y: -56 });
  });

  it('takes an already converted screen → world point at any zoom', () => {
    const k = 0.92, vx = 40, vy = 30, rectLeft = 137, rectTop = 89;
    const world = { x: (765.8 - rectLeft - vx) / k, y: (468.6 - rectTop - vy) / k };
    expect(dropPosition(world)).toEqual({
      x: Math.round(world.x - 143),
      y: Math.round(world.y - 16),
    });
  });

  it('honours explicit width/header overrides', () => {
    expect(dropPosition({ x: 100, y: 100 }, 200, 20)).toEqual({ x: 0, y: 90 });
  });
});
