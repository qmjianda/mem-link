import { describe, expect, it } from 'vitest';
import { parseCSource } from '../src/core/cparse';
import { compileExpr, evalNumber } from '../src/core/expr';
import { Memory } from '../src/core/mem';
import { buildGraph } from '../src/core/graph';
import { DEMO_SOURCE, defaultProject, demoBinary, parseProject, serializeProject } from '../src/core/project';
import type { EvalContext } from '../src/core/expr';

const schema = parseCSource(DEMO_SOURCE, { ptrSize: 4, endian: 'little' });

describe('C parser', () => {
  it('parses the demo records with correct sizes', () => {
    expect(schema.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(Object.keys(schema.records).sort()).toEqual(['Entry', 'Header', 'Meta']);
    expect(schema.records.Header.size).toBe(8);
    expect(schema.records.Entry.size).toBe(24);
    expect(schema.records.Meta.size).toBe(2);
  });

  it('lays out field offsets', () => {
    const e = schema.records.Entry;
    const off = Object.fromEntries(e.fields.map((f) => [f.name, f.offset]));
    expect(off.next).toBe(0);
    expect(off.prev).toBe(2);
    expect(off.flags).toBe(4);
    expect(off.refcount).toBe(6);
    expect(off.name).toBe(8);
    expect(off.ts).toBe(20);
    expect(e.align).toBe(4);
  });

  it('packs bitfields into one byte', () => {
    const m = schema.records.Meta;
    const [kind, dirty, flags, refs] = m.fields;
    expect(kind.bitWidth).toBe(3);
    expect(kind.bitOffset).toBe(0);
    expect(dirty.bitOffset).toBe(3);
    expect(flags.bitOffset).toBe(4);
    expect(refs.bitWidth).toBeUndefined();
    expect(refs.offset).toBe(1);
  });

  it('honours #pragma pack(push, 1)', () => {
    const s = parseCSource('typedef struct { char a; int b; } P;', { ptrSize: 4 });
    expect(s.records.P.size).toBe(8);
    const p = parseCSource('#pragma pack(push, 1)\ntypedef struct { char a; int b; } P;\n#pragma pack(pop)', { ptrSize: 4 });
    expect(p.records.P.size).toBe(5);
  });

  it('handles pointers, nested records and arrays', () => {
    const s = parseCSource(`
      typedef struct { int x; } Inner;
      typedef struct {
        Inner in;
        Inner *ptr;
        char name[8];
        unsigned flags : 1;
      } Outer;
    `, { ptrSize: 8 });
    expect(s.records.Inner.size).toBe(4);
    expect(s.records.Outer.fields[1].type).toEqual({ k: 'ptr', size: 8 });
    expect(s.records.Outer.size).toBe(32); // 4 + pad4 + 8 + 8 + 4(bit unit) -> 28 -> align 8
  });

  it('supports __attribute__((packed))', () => {
    const s = parseCSource('typedef struct { char a; int b; } __attribute__((packed)) P;', { ptrSize: 4 });
    expect(s.records.P.size).toBe(5);
  });
});

describe('expression engine', () => {
  const ctx: EvalContext = { vars: { v: 5, self: { next: 9 } }, functions: { min: (a, b) => Math.min(Number(a), Number(b)) } };

  it('evaluates arithmetic and precedence', () => {
    expect(evalNumber('1 + 2 * 3', ctx).value).toBe(7);
    expect(evalNumber('(1 + 2) * 3', ctx).value).toBe(9);
    expect(evalNumber('v - 1', ctx).value).toBe(4);
  });

  it('handles hex, shifts, masks and ternaries', () => {
    expect(evalNumber('0xFF & 0x0F', ctx).value).toBe(15);
    expect(evalNumber('1 << 4', ctx).value).toBe(16);
    expect(evalNumber('v > 3 ? 10 : 20', ctx).value).toBe(10);
    expect(evalNumber('0xFFFFFFFF & 0xFFFF', ctx).value).toBe(0xffff);
    expect(evalNumber('~0 & 0xFF', ctx).value).toBe(0xff);
  });

  it('reads members and calls functions', () => {
    expect(evalNumber('self.next', ctx).value).toBe(9);
    expect(evalNumber('min(v, 3)', ctx).value).toBe(3);
    expect(evalNumber('(v + 3) * 2', { ...ctx, vars: { ...ctx.vars, base: 100 } }).value).toBe(16);
  });

  it('reports errors instead of throwing', () => {
    expect(evalNumber('v +', ctx).error).toBeTruthy();
    expect(evalNumber('nope', ctx).error).toContain('未知标识符');
    expect(evalNumber('1/0', ctx).error).toContain('除以零');
  });

  it('supports casts', () => {
    expect(evalNumber('(u8)300', ctx).value).toBe(44);
    expect(evalNumber('(s8)255', ctx).value).toBe(-1);
  });
});

describe('graph builder', () => {
  const project = defaultProject();
  const mem = new Memory(demoBinary(), 0);

  it('walks the index chain and reports the broken link', () => {
    const g = buildGraph(schema, project, mem, {});
    const types = g.nodes.map((n) => `${n.type}@${n.addr.toString(16)}`);
    expect(types).toContain('Header@0');
    expect(types).toContain('Entry@130'); // 0x100 + 2*24
    expect(g.problems.some((p) => p.message.includes('越界'))).toBe(true);
    const ghosts = g.nodes.filter((n) => n.ghost);
    expect(ghosts.length).toBe(1);
    expect(ghosts[0].addr).toBe(0x100 + 12 * 24);
  });

  it('decodes values and follows next pointers', () => {
    const g = buildGraph(schema, project, mem, {});
    const head = g.nodes.find((n) => n.type === 'Entry' && n.addr === 0x130)!;
    expect(head.values['Entry.next']).toBe(5);
    expect(String(head.values['Entry.name'])).toBe('alpha');
    expect(g.edges.some((e) => e.from === head.key && e.to.includes('Entry'))).toBe(true);
  });

  it('is fast enough for live mode', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) buildGraph(schema, project, mem, {});
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(50);
  });
});

describe('project file', () => {
  it('round-trips schema and embedded memory', () => {
    const p = defaultProject();
    const bytes = demoBinary();
    const text = serializeProject(p, { name: 'demo.bin', base: 0x1000, bytes });
    const r = parseProject(text);
    expect(r.error).toBeUndefined();
    expect(r.project?.source).toBe(p.source);
    expect(r.project?.pools[0].name).toBe('Entries');
    expect(r.memory?.name).toBe('demo.bin');
    expect(r.memory?.base).toBe(0x1000);
    expect(r.memory?.bytes.length).toBe(0x200);
    expect(r.memory?.bytes[0]).toBe(0xef);
    expect(r.memory?.bytes[1]).toBe(0xbe);
  });

  it('rejects a file without roots', () => {
    expect(parseProject('{"version":1}').error).toContain('roots');
  });
});
