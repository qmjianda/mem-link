/**
 * Coverage for the declarative built-in node registry: every node must be
 * well-formed and produce real values from a real buffer.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFS, BUILTIN_GROUPS, BUILTIN_IDS, builtinDefaults, builtinLabel,
  builtinSubtitle, evalExpression, getBuiltin, inheritOptions, makeBuiltinCtx, parseOffsetChain,
} from '../src/bp/builtins';
import { evaluateGraph, portsFor } from '../src/bp/eval';
import { byteSpan, isByteSpan } from '../src/bp/binary-read';
import { assetIdOf } from '../src/bp/assets';
import { bytesToBase64 } from '../src/bp/doc';
import type { BPNode, BufferValue } from '../src/bp/types';

function buffer(bytes: number[] | Uint8Array, base = 0): BufferValue {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { assetId: assetIdOf(arr), name: 't.bin', base, bytes: arr };
}
function ctx(bytes: number[], params: Record<string, string> = {}, base = 0) {
  return makeBuiltinCtx(buffer(bytes, base), params);
}

const crcInput = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]; // "123456789"

describe('built-in registry', () => {
  it('has unique ids, valid groups and a run function for every data node', () => {
    expect(BUILTIN_DEFS).toHaveLength(BUILTIN_IDS.length);
    expect(new Set(BUILTIN_IDS).size).toBe(BUILTIN_IDS.length);
    for (const d of BUILTIN_DEFS) {
      expect(BUILTIN_GROUPS).toContain(d.group);
      expect(d.label).toBeTruthy();
      expect(d.hint).toBeTruthy();
      // file / number / element 走求值器的专门分支；其余内置节点都必须自带 run
      if (d.id !== 'file' && d.id !== 'number' && d.id !== 'element') {
        expect(typeof d.run).toBe('function');
      }
      const inputs = d.inputs.map((p) => p.name);
      const outputs = d.outputs.map((p) => p.name);
      expect(new Set(inputs).size).toBe(inputs.length);
      expect(new Set(outputs).size).toBe(outputs.length);
      if (d.followPort) expect(inputs).toContain(d.followPort);
    }
  });

  it('publishes the built-in labels and defaults', () => {
    expect(builtinLabel('file')).toBe('载入转储');
    expect(builtinLabel('number')).toBe('数值');
    expect(builtinLabel('element')).toBe('元素解析');
    expect(builtinLabel('unknown')).toBe('unknown');
    expect(builtinDefaults('number')).toEqual({ value: '0' });
    expect(builtinDefaults('readint').scalar).toBe('u32');
    expect(builtinDefaults('readint').endian).toBe('little');
    expect(getBuiltin('prp')).toBeUndefined(); // 协议逻辑只属于 NVMe pack
    expect(builtinDefaults('missing')).toEqual({});
  });

  it('summarises the active configuration in the node header', () => {
    expect(builtinSubtitle({ nodeId: 'number', params: {} })).toBe('内置');
    const sub = builtinSubtitle({ nodeId: 'readint', params: { scalar: 'i64', endian: 'big' } });
    expect(sub).toContain('i64');
    expect(sub).toContain('大端');
  });

  it('publishes registry ports through portsFor', () => {
    const packs = new Map();
    const read = portsFor({ id: 'r', packId: '', nodeId: 'readint', x: 0, y: 0, params: {} }, packs as never);
    expect(read.inputs.map((p) => p.name)).toEqual(['buffer', 'address']);
    expect(read.inputs[0].context).toBe(true);
    expect(read.outputs).toMatchObject([{ name: 'value', type: 'integer' }]);
    expect(getBuiltin('nope')).toBeUndefined();
  });
});
describe('expression evaluator', () => {
  it('respects precedence, parentheses, hex literals and bitwise operators', () => {
    expect(evalExpression('(a + 1) * b', { a: 5, b: 512 })).toBe(3072);
    expect(evalExpression('a + b * 2', { a: 3, b: 4 })).toBe(11);
    expect(evalExpression('(0x10 | 0x03) << 2', {})).toBe(76);
    expect(evalExpression('~0 & 0xff', {})).toBe(255);
    expect(evalExpression('-a + 0b1010', { a: 2 })).toBe(8);
  });

  it('rejects unknown names, bad syntax and non-finite results', () => {
    expect(() => evalExpression('a + z', { a: 1 })).toThrow(/未知变量/);
    expect(() => evalExpression('(a + 1', { a: 1 })).toThrow(/右括号/);
    expect(() => evalExpression('a / 0', { a: 1 })).toThrow(/无效/);
  });
});

describe('built-in evaluation', () => {
  const run = (id: string, values: Record<string, unknown>, bytes: number[], params: Record<string, string> = {}) =>
    getBuiltin(id)!.run!(values, ctx(bytes, params));

  it('slices a buffer without losing provenance', () => {
    const out = run('slice', { address: 2, length: 5 }, [0, 1, 0x41, 0x42, 0x43, 0x00, 0xff]);
    expect(isByteSpan(out.span)).toBe(true);
    if (isByteSpan(out.span)) {
      expect(out.span.buffer.base).toBe(2n);
      expect(out.span.buffer.bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43, 0x00, 0xff]));
    }
  });

  it('reads integers with width, sign and endian options', () => {
    expect(run('readint', { address: 0 }, [0x78, 0x56, 0x34, 0x12], { scalar: 'u32' }).value).toBe(0x12345678n);
    expect(run('readint', { address: 0 }, [0x12, 0x34], { scalar: 'u16', endian: 'big' }).value).toBe(0x1234n);
    expect(run('readint', { address: 0 }, [0xff], { scalar: 'i8' }).value).toBe(-1n);
    expect(run('readint', { address: 0 }, [0xff], { scalar: 'u8' }).value).toBe(255n);
  });

  it('reads floats and strings', () => {
    const f = new Float32Array([1.5]);
    const fbytes = [...new Uint8Array(f.buffer)];
    // 原始位模式只供检查器展示。
    const fl = run('readint', { address: 0 }, fbytes, { scalar: 'f32' });
    expect(fl.value).toBe(1.5);
    expect(fl.raw).toBe(0x3fc00000n);
    const text = [...'NVMe\0rest'].map((c) => c.charCodeAt(0));
    expect(run('text', { address: 0, length: 12 }, text, { mode: 'nul' })).toEqual({ text: 'NVMe', length: 5n });
  });

  it('reads arrays with a stride', () => {
    const out = run('arrayread', { address: 0, count: 3, stride: 2 }, [1, 0, 2, 0, 3, 0], { scalar: 'u16' });
    expect(out.list).toMatchObject([1n, 2n, 3n].map(value => ({ fields: [{ value }] })));
  });

  it('evaluates expressions', () => {
    expect(run('expr', { a: 5, b: 512 }, [], { formula: '(a + 1) * b' }).value).toBe(3072);
    // 位运算已并入表达式求值器：& | ^ << >> ~ 都是合法操作符
    expect(run('expr', { a: 0xf0, b: 0x0f }, [], { formula: 'a | b' }).value).toBe(0xff);
    expect(run('expr', { a: 1, b: 4 }, [], { formula: 'a << b' }).value).toBe(16);
  });

  it('computes addresses without requiring the target to be mapped', () => {
    expect(run('address', { base: 0x1000, index: 4, stride: 0x40 }, [0], { mode: 'index' }).address)
      .toMatchObject({ value: 0x1100n });
  });

  it('computes the selected checksum only', () => {
    const span = byteSpan(buffer([0, ...crcInput, 0]), 1n, 9n);
    expect(run('checksum', { span }, [])).toEqual({ value: 0xcbf43926n });
    expect(run('checksum', { span }, [], { algorithm: 'sum32' }).value).toBe(BigInt(crcInput.reduce((a, b) => a + b, 0)));
  });

  it('asserts numbers without inventing a result for missing inputs', () => {
    expect(run('assert', { actual: 7n, expected: 7 }, [])).toEqual({ status: '通过', ok: true });
    expect(run('assert', { actual: 7n, expected: 3n }, [])).toEqual({ status: '不通过', ok: false });
    expect(run('assert', {}, [])).toEqual({ status: '未能校验', ok: undefined });
  });

  it('读指针按宽度区分目标和读取越界', () => {
    const bytes = new Uint8Array(0x40);
    // 注意不要用 `>>>` 填 8 字节：它的移位量取 mod 32，i≥4 会循环重复。
    const put = (off: number, v: number, n = 8) => {
      for (let i = 0; i < n; i += 1) bytes[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
    };
    put(0x10, 0x2000);
    put(0x20, 0x30, 4);
    const ctx8 = ctx([...bytes], { pointerSize: '8' });

    expect(() => getBuiltin('ptrwalk')!.run!({ address: 0x10 }, ctx8)).toThrow(/目标未映射：0x2000/);
    expect(() => getBuiltin('ptrwalk')!.run!({ address: 0x3c }, ctx8)).toThrow(/超出可读范围/);

    const ctx4 = ctx([...bytes], { pointerSize: '4' });
    const back = getBuiltin('ptrwalk')!.run!({ address: 0x20 }, ctx4);
    expect(back.at).toBe(0x20n);
    expect(back.target).toMatchObject({ value: 0x30n });
    expect(back.state).toBe('mapped');
  });

  it('标注节点不携带文件上下文，端口行为空', () => {
    const note: BPNode = {
      id: 'n', packId: '', nodeId: 'note', x: 0, y: 0,
      params: { text: '结论：CRC 头在 0x100', tone: 'warn' },
    };
    const ports = portsFor(note, new Map());
    expect(ports.inputs).toEqual([]);
    expect(ports.outputs).toEqual([]);

    const r = evaluateGraph([note], [], new Map());
    // outputs 为空是刻意的：标注是文档不是数据流，内容走 detail 与画布便签。
    const v = r.views.get('n');
    expect(v?.kind).toBe('calc');
    if (v?.kind === 'calc') expect(v.detail).toContain('结论：CRC 头在 0x100');
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([]);

    // 旁边有文件节点也不会被归入它的数据源链
    const file: BPNode = {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 't.bin' },
      source: { name: 't.bin', base: 0, data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) },
    };
    const r2 = evaluateGraph([file, note], [], new Map());
    expect(r2.sources.get('n')?.buffer).toBeUndefined();
  });

  it('新节点继承最近同类节点的下拉配置', () => {
    type P = { packId: string; nodeId: string; params: Record<string, string> };
    const nodes: P[] = [
      { packId: '', nodeId: 'readint', params: { address: '0x0' } },
      { packId: '', nodeId: 'readint', params: { address: '0x10', scalar: 'u16', endian: 'big' } },
      { packId: 'p1', nodeId: 'sq', params: { size: '99' } },
    ];
    // 只继承与默认值不同的下拉项，且 pack 节点不参与
    expect(inheritOptions('readint', nodes)).toEqual({ scalar: 'u16', endian: 'big' });
    expect(inheritOptions('sq', nodes)).toEqual({});
    expect(inheritOptions('checksum', nodes)).toEqual({});
    // 「最近」生效：新出现的一组配置覆盖更早的
    const more: P[] = [...nodes, { packId: '', nodeId: 'readint', params: { address: '0x20', scalar: 'u8' } }];
    expect(inheritOptions('readint', more)).toEqual({ scalar: 'u8' });
  });

  it('解析多级指针偏移链输入', () => {
    expect(parseOffsetChain('+0x10, +0x24').offsets).toEqual([16n, 36n]);
    expect(parseOffsetChain('0x10 0x24').offsets).toEqual([16n, 36n]);
    expect(parseOffsetChain('16,-8').offsets).toEqual([16n, -8n]);
    expect(parseOffsetChain('0x10；-0x8').offsets).toEqual([16n, -8n]);
    expect(parseOffsetChain('')).toEqual({ offsets: [] });
    expect(parseOffsetChain('0xzz').error).toContain('无法解析偏移');
  });

  it('reports out-of-range reads as a problem, not a crash', () => {
    const file: BPNode = {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 't.bin' },
      source: { name: 't.bin', base: 0, data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) },
    };
    const slice: BPNode = {
      id: 's', packId: '', nodeId: 'slice', x: 0, y: 0,
      params: { address: '0x100', length: '16' },
    };
    const r = evaluateGraph([file, slice], [{ id: 'e', from: { node: 'f', port: 'buffer' }, to: { node: 's', port: 'buffer' } }], new Map());
    expect(r.problems.some((p) => p.severity === 'error')).toBe(true);
    expect(r.views.get('s')?.kind).toBe('calc');
  });
});
