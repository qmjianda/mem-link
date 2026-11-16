import { describe, expect, it } from 'vitest';
import demoPackSource from '../samples/demo.pack.ts?raw';
import { loadPack } from '../src/core/tspack';
import { buildPackGraph } from '../src/core/packgraph';
import { Memory } from '../src/core/mem';
import { demoBinary } from '../src/core/project';
import { packToSchema } from '../src/core/pack';
import { applyOverrides } from '../src/v2/overrides';
import { runProgram } from '../src/core/program';

const loaded = loadPack(demoPackSource);

describe('ts pack loader', () => {
  it('compiles and evaluates the demo pack', () => {
    expect(loaded.error).toBeUndefined();
    expect(loaded.pack).toBeTruthy();
    expect(loaded.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(loaded.pack!.types.map((t) => t.name)).toEqual(['Header', 'Entry', 'Meta']);
    expect(loaded.pack!.roots).toHaveLength(3);
    expect(loaded.pack!.constants.BASE).toBe(0x100);
    expect(loaded.compile).toBeTypeOf('function');
  });

  it('runs a program that walks the index chain', () => {
    const r = runProgram(loaded.pack!, new Memory(demoBinary()));
    expect(r.error).toBeUndefined();
    expect(r.roots.map((x) => x.address)).toEqual([0x130, 0x178, 0x118, 0x1a8]);
    expect(r.logs.join(' ')).toContain('4');
  });

  it('compiles overrides inside the pack closure', () => {
    const pack = applyOverrides(
      loaded.pack!,
      { 'Header.head': { code: '(v) => idxToAddr(Number(v)) + 8' } },
      loaded.compile,
    );
    const g = buildPackGraph(pack, new Memory(demoBinary()), { maxNodes: 100 });
    const head = g.nodes.find((n) => n.type === 'Header')!;
    expect(head.values['Header.head']).toBe(0x138);
    expect(g.edges.some((e) => e.fieldId === 'Header.head' && e.value === 0x138)).toBe(true);
  });

  it('keeps transform functions live (closures work)', () => {
    const h = loaded.pack!.types.find((t) => t.name === 'Header')!;
    const head = h.fields.find((f) => f.name === 'head')!;
    expect(typeof head.transform).toBe('function');
    expect(head.transform!(2, {} as never)).toBe(0x130);
    expect(head.transform!(-1, {} as never)).toBeNull();
  });

  it('rejects a pack without export default', () => {
    const r = loadPack(`const x = 1;`);
    expect(r.error).toContain('export default');
  });

  it('rejects a syntax error with a useful message', () => {
    const r = loadPack(`export default definePack({ types: [ struct('X', 1, [`);
    expect(r.error).toBeTruthy();
  });

  it('rejects unknown follow types during validation', () => {
    const r = loadPack(`
      export default definePack({
        endian: 'little', pointerSize: 4,
        types: [struct('T', 2, [u16('next', 0, { follow: 'Nope' })])],
        roots: [{ type: 'T', address: 0 }],
      });
    `);
    expect(r.error).toContain('Nope');
  });
});

describe('pack graph', () => {
  const pack = loaded.pack!;
  const mem = new Memory(demoBinary());
  const graph = buildPackGraph(pack, mem);

  it('walks the index chain through transforms', () => {
    const keys = graph.nodes.map((n) => n.key).sort();
    expect(keys).toContain('0:Header');
    expect(keys).toContain('304:Entry'); // 0x130
    expect(keys).toContain('376:Entry'); // 0x178
    expect(keys).toContain('280:Entry'); // 0x118
    expect(keys).toContain('424:Entry'); // 0x1a8
  });

  it('shows raw -> transformed on the node', () => {
    const header = graph.nodes.find((n) => n.key === '0:Header')!;
    const headId = 'Header.head';
    expect(header.rawValues![headId]).toBe(2);
    expect(header.values[headId]).toBe(0x130);
    expect(header.display[headId]).toBe('2 → 0x130');

    const e = graph.nodes.find((n) => n.key === '304:Entry')!;
    expect(e.display['Entry.next']).toBe('5 → 0x178');
    expect(e.display['Entry.flags']).toBe('0x2 → "WRITE"');
  });

  it('turns a NULL index into a null edge, not a node', () => {
    const last = graph.nodes.find((n) => n.key === '424:Entry')!;
    expect(last.values['Entry.next']).toBeNull();
    const e = graph.edges.find((x) => x.from === '424:Entry' && x.fieldId === 'Entry.next')!;
    expect(e.kind).toBe('null');
    expect(e.to).toBe('');
  });

  it('creates a ghost node for an out-of-range index', () => {
    const ghost = graph.nodes.find((n) => n.ghost)!;
    expect(ghost).toBeTruthy();
    expect(ghost.addr).toBe(0x220);
    expect(ghost.ghostReason).toContain('不在缓冲区');
    const edge = graph.edges.find((x) => x.from === '352:Entry' && x.fieldId === 'Entry.next')!;
    expect(edge.kind).toBe('broken');
    expect(edge.to).toBe(ghost.key);
  });

  it('decodes bitfields', () => {
    const meta = graph.nodes.find((n) => n.type === 'Meta')!;
    expect(meta.values['Meta.kind']).toBe(1);
    expect(meta.values['Meta.active']).toBe(1);
    expect(meta.values['Meta.mode']).toBe(3);
  });

  it('does not promote nodes already reached by an earlier root', () => {
    const withExtraRoot = {
      ...pack,
      roots: [...pack.roots, { type: 'Entry', address: 0x130, label: 'scan #0' }],
    };
    const g = buildPackGraph(withExtraRoot, new Memory(demoBinary()));
    expect(g.nodes.find((n) => n.type === 'Entry' && n.addr === 0x130)!.depth).toBe(1);
    expect(g.nodes.find((n) => n.type === 'Entry' && n.addr === 0x160)!.depth).toBe(0);
  });
});

describe('pack transform context', () => {
  it('exposes all siblings through ctx.self', () => {
    const r = loadPack(`
      export default definePack({
        endian: 'little', pointerSize: 4,
        types: [struct('T', 4, [
          u8('a', 0),
          u8('b', 1, { transform: (v, ctx) => Number(ctx.self.a) + Number(v) }),
        ])],
        roots: [{ type: 'T', address: 0 }],
      });
    `);
    expect(r.error).toBeUndefined();
    const g = buildPackGraph(r.pack!, new Memory(Uint8Array.from([1, 2, 0, 0])));
    const n = g.nodes[0];
    expect(n.values['T.b']).toBe(3);
    expect(n.display['T.b']).toBe('2 → 0x3');
  });

  it('maps pack fields into the canvas schema', () => {
    const s = packToSchema(loaded.pack!);
    expect(Object.keys(s.records).sort()).toEqual(['Entry', 'Header', 'Meta']);
    expect(s.records.Entry.fields.map((f) => f.id)).toContain('Entry.next');
    expect(s.records.Entry.size).toBe(24);
  });
});
