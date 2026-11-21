import { describe, expect, it } from 'vitest';
import { loadBlueprintPack } from '../src/bp/load';
import { formatPackValue } from '../src/core/packgraph';
import type { FieldDef } from '../src/core/pack';
import { compileLayout, readLayout, type BinaryLayout } from '../src/bp/layouts';
import { buildStructureRegistry } from '../src/bp/structure';
import { parseDeclarations, layoutToPackSource } from '../src/bp/declaration';
import type { BPEdge, BPNode, BufferValue } from '../src/bp/types';
import { evaluateGraph } from '../src/bp/eval';
import { bytesToBase64, parseDoc } from '../src/bp/doc';
import reuseDoc from '../samples/structure-reuse.blueprint.json';

function load(source: string) {
  return loadBlueprintPack(`export default definePack({ name: 't', endian: 'little', pointerSize: 4, types: {}, nodes: {}, ...${source} });`);
}

function buffer(bytes: number[], base = 0x1000): BufferValue {
  const arr = new Uint8Array(bytes);
  return { assetId: 'test', name: 't.bin', base, bytes: arr };
}

describe('pack auto layout', () => {
  it('computes offsets and length in declaration order', () => {
    const r = loadBlueprintPack(`export default definePack({
      name: 'auto', endian: 'little', pointerSize: 4,
      types: { Header: struct('Header', [u16('magic'), u16('head'), u32('count')]) },
      nodes: {},
    });`);
    expect(r.error).toBeUndefined();
    const t = r.pack!.types.Header;
    expect(t.fields.map(f => f.offset)).toEqual([0, 2, 4]);
    expect(t.size).toBe(8);
  });

  it('anchors fields and supports pad / align', () => {
    const r = loadBlueprintPack(`export default definePack({
      name: 'anchor', endian: 'little', pointerSize: 4,
      types: { T: struct('T', [u8('a'), align(4), u32('b'), pad(2)]) },
      nodes: {},
    });`);
    expect(r.error).toBeUndefined();
    const t = r.pack!.types.T;
    expect(t.fields[0].offset).toBe(0);
    expect(t.fields[1].offset).toBe(4);
    expect(t.size).toBe(10);
  });

  it('registers direct nested types and scalar arrays', () => {
    const r = loadBlueprintPack(`const Point = struct('Point', [i32('x'), i32('y')]);
    export default definePack({
      name: 'nested', endian: 'little', pointerSize: 4,
      types: { Point, Shape: struct('Shape', [record('origin', Point), array('points', Point, 2), array('ids', 'u16', 3)]) },
      nodes: {},
    });`);
    expect(r.error).toBeUndefined();
    const shape = r.pack!.types.Shape;
    expect(shape.fields.map(f => f.kind)).toEqual(['record', 'array', 'array']);
    expect(shape.fields[0].ofType?.name).toBe('Point');
    expect(shape.size).toBe(8 + 16 + 6);
  });

  it('groups bit fields and keeps explicit containers', () => {
    const r = loadBlueprintPack(`export default definePack({
      name: 'bits', endian: 'little', pointerSize: 4,
      types: { Flags: struct('Flags', [bits('kind', 2), bits('active', 1), bits('mode', 3), u8('reserved')]) },
      nodes: {},
    });`);
    expect(r.error).toBeUndefined();
    const t = r.pack!.types.Flags;
    expect(t.fields[0].offset).toBe(0);
    expect(t.fields[0].bits).toMatchObject({ offset: 0, width: 2, unit: 1 });
    expect(t.fields[1].bits).toMatchObject({ offset: 2, width: 1, unit: 1 });
    expect(t.fields[3].offset).toBe(1);
    expect(t.size).toBe(2);
  });

  it('allows union overlap and rejects struct overlap', () => {
    const u = loadBlueprintPack(`export default definePack({
      name: 'u', endian: 'little', pointerSize: 4,
      types: { V: union('V', [u32('asU32'), f32('asF32')]) }, nodes: {},
    });`);
    expect(u.error).toBeUndefined();
    expect(u.pack!.types.V.fields.map(f => f.offset)).toEqual([0, 0]);
    const s = loadBlueprintPack(`export default definePack({
      name: 's', endian: 'little', pointerSize: 4,
      types: { V: struct('V', [u32('a', { at: 0 }), u32('b', { at: 0 })], { size: 8 }) }, nodes: {},
    });`);
    expect(s.error).toContain('重叠');
  });

  it('maps enum values for display without changing the value', () => {
    const f: FieldDef = { name: 'state', kind: 'u16', offset: 0, values: { 1: 'Run' } };
    expect(formatPackValue(f, 1)).toBe('Run');
    expect(formatPackValue(f, 2)).toBe('2');
  });
});

describe('layout model', () => {
  const entry: BinaryLayout = {
    id: 'entry', name: 'Entry', endian: 'little',
    fields: [{ id: 'f1', name: 'id', kind: 'u16' }, { id: 'f2', name: 'value', kind: 'u16' }],
  };
  const header: BinaryLayout = {
    id: 'header', name: 'Header', endian: 'little',
    fields: [
      { id: 'f1', name: 'count', kind: 'u16' },
      { id: 'f2', name: 'entries', kind: 'array', of: 'layout/entry', count: '2' },
    ],
  };

  it('compiles nested layouts and reads instances', () => {
    const map = new Map([entry, header].map(l => [l.id, l]));
    const compiled = compileLayout(header, id => map.get(id));
    expect(compiled.size).toBe(10);
    const src = buffer([2, 0, 10, 0, 20, 0, 30, 0, 40, 0]);
    const inst = readLayout(src, 0x1000n, compiled);
    expect(inst.fields[0].value).toBe(2n);
    const list = inst.fields[1].value as unknown[];
    expect(list).toHaveLength(2);
    expect((list[0] as { fields: Array<{ value: unknown }> }).fields[0].value).toBe(10n);
  });

  it('handles union layouts and rejects non-union overlap', () => {
    const union: BinaryLayout = {
      id: 'v', name: 'V', endian: 'little', union: true,
      fields: [{ id: 'f1', name: 'a', kind: 'u32' }, { id: 'f2', name: 'b', kind: 'f32' }],
    };
    expect(compileLayout(union).size).toBe(4);
    const bad: BinaryLayout = {
      id: 'bad', name: 'Bad', endian: 'little',
      fields: [{ id: 'f1', name: 'a', kind: 'u32', at: '0' }, { id: 'f2', name: 'b', kind: 'u32', at: '0' }],
      size: '8',
    };
    expect(() => compileLayout(bad)).toThrow(/重叠/);
  });
});

describe('declaration import', () => {
  it('parses structs, arrays, nested refs and bitfields', () => {
    const r = parseDeclarations(`
      struct Entry { uint16_t id; uint16_t value; };
      struct Header { uint16_t count; Entry entries[4]; };
      struct Flags { uint16_t kind : 2; uint16_t active : 1; };
    `);
    expect(r.problems).toEqual([]);
    expect(r.layouts.map(l => l.name)).toEqual(['Entry', 'Header', 'Flags']);
    const header = r.layouts.find(l => l.name === 'Header')!;
    expect(header.fields[1]).toMatchObject({ kind: 'array', count: '4', of: 'layout/entry' });
    const flags = r.layouts.find(l => l.name === 'Flags')!;
    expect(flags.fields.map(f => f.kind)).toEqual(['bits', 'bits']);
  });

  it('handles typedef, union and explicit-width enums', () => {
    const r = parseDeclarations(`
      typedef struct { uint16_t a; uint16_t b; } Pair;
      union Value { uint32_t asU32; float asF32; };
      enum State : uint16_t { Idle = 0, Run = 1 };
      struct Row { Pair pair; enum State state; };
    `);
    expect(r.problems).toEqual([]);
    expect(r.layouts.find(l => l.name === 'Pair')?.fields).toHaveLength(2);
    expect(r.layouts.find(l => l.name === 'Value')?.union).toBe(true);
    expect(r.layouts.find(l => l.name === 'Row')?.fields[1].values).toEqual({ '0': 'Idle', '1': 'Run' });
  });

  it('reports macros and unknown types instead of guessing', () => {
    const macro = parseDeclarations('struct A { Entry items[COUNT]; };');
    expect(macro.layouts).toEqual([]);
    expect(macro.problems[0].message).toContain('COUNT');
    const hash = parseDeclarations('#define COUNT 4\nstruct A { uint16_t x; };');
    expect(hash.layouts).toEqual([]);
    expect(hash.problems[0].message).toContain('预处理');
  });

  it('exports a layout as compilable pack source', () => {
    const source = layoutToPackSource({
      id: 'header', name: 'Header', endian: 'little',
      fields: [{ id: 'f1', name: 'count', kind: 'u16' }, { id: 'f2', name: 'flag', kind: 'bits', unit: '1', bit: '0', width: '1' }],
    }, []);
    expect(source).toContain('const Header = struct');
    expect(source).toContain('bits("flag"');
    const loaded = loadBlueprintPack(`${source}\nexport default definePack({ name: 'exported', endian: 'little', pointerSize: 4, types: { Header }, nodes: {} });`);
    expect(loaded.error).toBeUndefined();
    expect(loaded.pack!.types.Header.size).toBe(3);
  });
});

describe('structure registry', () => {
  it('namespaces layouts and pack types', () => {
    const layout: BinaryLayout = { id: 'h', name: 'H', endian: 'little', fields: [{ id: 'f1', name: 'x', kind: 'u16' }] };
    const pack = loadBlueprintPack(`export default definePack({
      name: 'p', endian: 'little', pointerSize: 4, types: { T: struct('T', [u16('x')]) }, nodes: {},
    });`).pack!;
    const reg = buildStructureRegistry([layout], new Map([['p1', pack]]));
    expect(reg.get('layout/h')?.source).toBe('layout');
    expect(reg.get('pack/p1/T')?.size).toBe(2);
    expect(reg.get('T')).toBeUndefined();
  });

  it('keeps layout-derived field identity and reports deleted layouts', () => {
    const layout: BinaryLayout = {
      id: 'h', name: 'H', endian: 'little',
      fields: [{ id: 'f1', name: 'count', kind: 'u16' }],
    };
    const pack = loadBlueprintPack(`export default definePack({
      name: 'p', endian: 'little', pointerSize: 4,
      types: { H: layoutType('layout/h') }, nodes: { h: structNode(layoutType('layout/h')) },
    });`).pack!;
    const typeName = Object.keys(pack.types)[0];
    const id = `pack/p1/${encodeURIComponent(typeName)}`;
    const first = buildStructureRegistry([layout], new Map([['p1', pack]])).get(id)!;
    expect(first.type.fields[0].name).toBe('f1');
    expect(first.type.fields[0].label).toBe('count');
    const renamed = buildStructureRegistry([{ ...layout, fields: [{ ...layout.fields[0], name: 'itemCount' }] }], new Map([['p1', pack]])).get(id)!;
    expect(renamed.type.fields[0].name).toBe('f1');
    expect(renamed.type.fields[0].label).toBe('itemCount');
    const missing = buildStructureRegistry([], new Map([['p1', pack]])).get(id)!;
    expect(missing.error).toContain('布局');
  });

  it('materializes layout references and auto offsets', () => {
    const layout: BinaryLayout = {
      id: 'h', name: 'H', endian: 'little',
      fields: [{ id: 'f1', name: 'x', kind: 'u16' }, { id: 'f2', name: 'y', kind: 'u32' }],
    };
    const pack = loadBlueprintPack(`export default definePack({
      name: 'p', endian: 'little', pointerSize: 4,
      types: { T: struct('T', [record('h', layoutType('layout/h')), u16('tail')]) }, nodes: {},
    });`).pack!;
    const reg = buildStructureRegistry([layout], new Map([['p1', pack]]));
    const t = reg.get('pack/p1/T')!;
    expect(t.type.fields[0].ofType?.size).toBe(6);
    expect(t.type.fields[1].offset).toBe(6);
    expect(t.type.size).toBe(8);
  });
});


describe('cross-entry consistency', () => {
  it('opens the shipped reuse sample with both entry points', () => {
    const doc = parseDoc(JSON.stringify(reuseDoc)).doc!;
    const packs = new Map(doc.packs.map(p => [p.id, loadBlueprintPack(p.source).pack!]));
    const r = evaluateGraph(doc.nodes, doc.edges, packs, { layouts: doc.layouts });
    expect(r.problems).toEqual([]);
    expect(Number(r.outputs.get('l')?.['field:layout/entry:f1'])).toBe(42);
    expect(Number(r.outputs.get('p')?.value)).toBe(42);
  });

  it('applies pack transforms through structread', () => {
    const pack = loadBlueprintPack(`const T = struct('T', [u16('x', { transform: (v) => Number(v) * 2 })]);
    export default definePack({ name: 'p', endian: 'little', pointerSize: 4, types: { T }, nodes: { t: structNode(T) } });`).pack!;
    const bytes = new Uint8Array([5, 0]);
    const file: BPNode = {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: {},
      source: { name: 't.bin', base: 0, data: bytesToBase64(bytes) },
    };
    const packNode: BPNode = { id: 'p', packId: 'p1', nodeId: 't', x: 0, y: 0, params: { address: '0x0' } };
    const readNode: BPNode = { id: 'r', packId: '', nodeId: 'structread', x: 0, y: 0, params: { structureId: 'pack/p1/T', address: '0x0' } };
    const edges: BPEdge[] = [
      { id: 'e1', from: { node: 'f', port: 'buffer' }, to: { node: 'p', port: 'buffer' } },
      { id: 'e2', from: { node: 'f', port: 'buffer' }, to: { node: 'r', port: 'buffer' } },
    ];
    const r = evaluateGraph([file, packNode, readNode], edges, new Map([['p1', pack]]));
    expect(r.problems).toEqual([]);
    expect(r.outputs.get('p')?.x).toBe(10);
    expect(r.outputs.get('r')?.x).toBe(10);
  });
});
