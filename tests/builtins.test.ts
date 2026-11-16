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
    }
  });

  it('keeps the original built-in labels and exposes defaults', () => {
    expect(builtinLabel('file')).toBe('文件 / Buffer');
    expect(builtinLabel('number')).toBe('数值');
    expect(builtinLabel('element')).toBe('元素解析');
    expect(builtinLabel('unknown')).toBe('unknown');
    expect(builtinDefaults('number')).toEqual({ value: '0' });
    expect(builtinDefaults('readint').size).toBe('4');
    expect(builtinDefaults('readint').endian).toBe('little');
    expect(builtinDefaults('prp').pageSize).toBe('512');
    expect(builtinDefaults('missing')).toEqual({});
  });

  it('summarises the active configuration in the node header', () => {
    expect(builtinSubtitle({ nodeId: 'number', params: {} })).toBe('内置');
    const sub = builtinSubtitle({ nodeId: 'readint', params: { size: '8', signed: '1', endian: 'big' } });
    expect(sub).toContain('u64 / i64');
    expect(sub).toContain('大端');
  });

  it('publishes registry ports through portsFor', () => {
    const packs = new Map();
    const read = portsFor({ id: 'r', packId: '', nodeId: 'readint', x: 0, y: 0, params: {} }, packs as never);
    expect(read.inputs.map((p) => p.name)).toEqual(['buffer', 'address']);
    expect(read.inputs[0].context).toBe(true);
    expect(read.outputs.map((p) => p.name)).toEqual(['value', 'hex', 'binary', 'width']);
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

  it('slices a buffer into bytes, hex, ASCII and size', () => {
    const out = run('slice', { address: 2, length: 5 }, [0, 1, 0x41, 0x42, 0x43, 0x00, 0xff]);
    expect(out.size).toBe(5);
    expect((out.bytes as Uint8Array)).toEqual(new Uint8Array([0x41, 0x42, 0x43, 0x00, 0xff]));
    expect(out.hex).toBe('41 42 43 00 ff');
    expect(out.ascii).toBe('ABC..');
  });

  it('reads integers with width, sign and endian options', () => {
    expect(run('readint', { address: 0 }, [0x78, 0x56, 0x34, 0x12], { size: '4' }).value).toBe(0x12345678);
    expect(run('readint', { address: 0 }, [0x12, 0x34], { size: '2', endian: 'big' }).value).toBe(0x1234);
    expect(run('readint', { address: 0 }, [0xff], { size: '1', signed: '1' }).value).toBe(-1);
    expect(run('readint', { address: 0 }, [0xff], { size: '1' }).value).toBe(255);
  });

  it('reads floats and strings', () => {
    const f = new Float32Array([1.5]);
    const fbytes = [...new Uint8Array(f.buffer)];
    // 浮点已并入「数值读取」：size = f4 / f8，hex/binary 是 IEEE 754 位模式
    const fl = run('readint', { address: 0 }, fbytes, { size: 'f4' });
    expect(fl.value).toBe(1.5);
    expect(fl.hex).toBe('0x3FC00000');
    expect(fl.binary).toBe('00111111 11000000 00000000 00000000');
    const text = [...'NVMe\0rest'].map((c) => c.charCodeAt(0));
    expect(run('text', { address: 0, length: 12 }, text, { mode: 'cstr' }).text).toBe('NVMe');
  });

  it('reads arrays with a stride', () => {
    const out = run('arrayread', { address: 0, count: 3, stride: 2 }, [1, 0, 2, 0, 3, 0], { size: '2' });
    expect(out.values).toBe('1, 2, 3');
  });

  it('evaluates expressions and bitfields', () => {
    expect(run('expr', { a: 5, b: 512 }, [], { formula: '(a + 1) * b' }).value).toBe(3072);
    // 位运算已并入表达式求值器：& | ^ << >> ~ 都是合法操作符
    expect(run('expr', { a: 0xf0, b: 0x0f }, [], { formula: 'a | b' }).value).toBe(0xff);
    expect(run('expr', { a: 1, b: 4 }, [], { formula: 'a << b' }).value).toBe(16);
    const bits = run('bitfield', { value: 0b1011 }, [], { width: '8' });
    expect(bits.popcount).toBe(3);
    expect(bits.set).toBe('0, 1, 3');
    expect(bits.lsb).toBe(0);
    expect(bits.msb).toBe(3);
  });

  it('maps enums and timestamps', () => {
    const out = run('enum', { value: 2 }, [], { mapping: '0=Flush,1=Write,2=Read' });
    expect(out.name).toBe('Read');
    expect(out.known).toBe(true);
    expect(run('enum', { value: 9 }, [], { mapping: '0=Flush,2=Read' }).known).toBe(false);
    expect(run('timestamp', { value: 0 }, [], { unit: 's' }).utc).toContain('1970-01-01');
  });

  it('computes addresses, walks pointers and expands PRP lists', () => {
    expect(run('address', { base: 0x1000, offset: 4, scale: 0x40 }, []).address).toBe(0x1100);
    // pointer 已并入「指针步进」：offset = 0 时就是纯解引用
    const ptrBytes = [0x00, 0x12, 0, 0, 0, 0, 0, 0];
    const walked = run('ptrwalk', { base: 0, offset: 0 }, ptrBytes, { pointerSize: '8' });
    expect(walked.target).toBe(0x1200);
    expect(walked.hex).toBe('0x1200');
    expect(walked.valid).toBe(false); // 0x1200 在 8 字节缓冲区之外

    // PRP1 = 0x1200, PRP2 = 0x1100 points at a list of 5 page addresses.
    const img = new Uint8Array(0x1000);
    const put = (off: number, v: number) => {
      for (let i = 0; i < 8; i++) img[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
    };
    [0x1400, 0x1600, 0x1800, 0x1a00, 0x1c00].forEach((a, i) => put(0x100 + i * 8, a));
    const bctx = makeBuiltinCtx({ assetId: assetIdOf(img), name: 't.bin', base: 0x1000, bytes: img }, { pageSize: '512' });
    const prp = getBuiltin('prp')!.run!({ prp1: 0x1200, prp2: 0x1100, count: 6 }, bctx);
    expect(prp.pages).toBe(6);
    expect(prp.p0).toBe(0x1200);
    expect(prp.p1).toBe(0x1400);
    expect(String(prp.list)).toContain('0x1c00');
  });

  it('computes standard CRC32, sum and FNV-1a over input bytes', () => {
    const out = run('checksum', { address: 0, length: 9 }, crcInput);
    expect(out.crc32).toBe(0xcbf43926);
    expect(out.hex).toBe('0xcbf43926');
    expect(out.sum).toBe(crcInput.reduce((a, b) => a + b, 0));
  });

  it('compares numbers and reports booleans', () => {
    const out = run('compare', { a: 7, b: 3 }, []);
    expect(out.equal).toBe(false);
    expect(out.greater).toBe(true);
    expect(out.delta).toBe(4);
  });

  it('指针步进按宽度读指针，断链时 target 置 0 并给出 valid=false', () => {
    const bytes = new Uint8Array(0x40);
    // 注意不要用 `>>>` 填 8 字节：它的移位量取 mod 32，i≥4 会循环重复。
    const put = (off: number, v: number, n = 8) => {
      for (let i = 0; i < n; i += 1) bytes[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
    };
    put(0x10, 0x2000);
    put(0x20, 0x30, 4);
    const ctx8 = ctx([...bytes], { pointerSize: '8' });

    const walk = getBuiltin('ptrwalk')!.run!({ base: 0x10, offset: 0 }, ctx8);
    expect(walk.address).toBe(0x10);
    expect(walk.target).toBe(0x2000);
    expect(walk.valid).toBe(false); // 0x2000 在 0x40 缓冲区之外

    const broken = getBuiltin('ptrwalk')!.run!({ base: 0x38, offset: 4 }, ctx8);
    expect(broken.target).toBe(0);
    expect(broken.valid).toBe(false);

    const ctx4 = ctx([...bytes], { pointerSize: '4' });
    const back = getBuiltin('ptrwalk')!.run!({ base: 0x24, offset: -4 }, ctx4);
    expect(back.address).toBe(0x20);
    expect(back.target).toBe(0x30);
    expect(back.valid).toBe(true);
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
      { packId: '', nodeId: 'readint', params: { address: '0x10', size: '2', endian: 'big' } },
      { packId: 'p1', nodeId: 'sq', params: { size: '99' } },
    ];
    // 只继承与默认值不同的下拉项，且 pack 节点不参与
    expect(inheritOptions('readint', nodes)).toEqual({ size: '2', endian: 'big' });
    expect(inheritOptions('sq', nodes)).toEqual({});
    expect(inheritOptions('checksum', nodes)).toEqual({});
    // 「最近」生效：新出现的一组配置覆盖更早的
    const more: P[] = [...nodes, { packId: '', nodeId: 'readint', params: { address: '0x20', size: '1' } }];
    expect(inheritOptions('readint', more)).toEqual({ size: '1' });
  });

  it('解析多级指针偏移链输入', () => {
    expect(parseOffsetChain('+0x10, +0x24').offsets).toEqual([16, 36]);
    expect(parseOffsetChain('0x10 0x24').offsets).toEqual([16, 36]);
    expect(parseOffsetChain('16,-8').offsets).toEqual([16, -8]);
    expect(parseOffsetChain('0x10；-0x8').offsets).toEqual([16, -8]);
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

describe('多级指针端到端', () => {
  it('连续指针步进解析到最终地址', () => {
    const bytes = new Uint8Array(0x40);
    const put64 = (off: number, v: number) => {
      for (let i = 0; i < 8; i += 1) bytes[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
    };
    put64(0x10, 0x20);
    put64(0x30, 0x38);
    const file: BPNode = {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 't.bin' },
      source: { name: 't.bin', base: 0, data: bytesToBase64(bytes) },
    };
    const walk1: BPNode = {
      id: 'w1', packId: '', nodeId: 'ptrwalk', x: 0, y: 0,
      params: { base: '0x0', offset: '0x10', pointerSize: '8' },
    };
    const walk2: BPNode = {
      id: 'w2', packId: '', nodeId: 'ptrwalk', x: 0, y: 0,
      params: { base: '0x0', offset: '0x10', pointerSize: '8' },
    };
    const r = evaluateGraph([file, walk1, walk2], [
      { id: 'e1', from: { node: 'f', port: 'buffer' }, to: { node: 'w1', port: 'buffer' } },
      { id: 'e2', from: { node: 'w1', port: 'target' }, to: { node: 'w2', port: 'base' } },
    ], new Map());
    expect(r.outputs.get('w1')?.address).toBe(0x10);
    expect(r.outputs.get('w1')?.target).toBe(0x20);
    expect(r.outputs.get('w2')?.address).toBe(0x30);
    expect(r.outputs.get('w2')?.target).toBe(0x38);
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('断链与目标越界都能标记出来，且不中断求值', () => {
    const bytes = new Uint8Array(0x20);
    // 0x10 处放 0x99：读取本身成功，但目标落在 0x20 缓冲区之外。
    for (let i = 0; i < 8; i += 1) bytes[0x10 + i] = Number((BigInt(0x99) >> BigInt(8 * i)) & 0xffn);
    const file: BPNode = {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 't.bin' },
      source: { name: 't.bin', base: 0, data: bytesToBase64(bytes) },
    };
    const walk: BPNode = {
      id: 'w', packId: '', nodeId: 'ptrwalk', x: 0, y: 0,
      params: { base: '0x0', offset: '0x10', pointerSize: '8' },
    };
    const broken: BPNode = {
      id: 'b', packId: '', nodeId: 'ptrwalk', x: 0, y: 0,
      params: { base: '0x18', offset: '0x10', pointerSize: '8' },
    };
    const r = evaluateGraph([file, walk, broken], [
      { id: 'e1', from: { node: 'f', port: 'buffer' }, to: { node: 'walk', port: 'buffer' } },
      { id: 'e2', from: { node: 'f', port: 'buffer' }, to: { node: 'broken', port: 'buffer' } },
    ], new Map());
    const w = r.outputs.get('w')!;
    expect(w.target).toBe(0x99);   // 读到了真实指针值
    expect(w.valid).toBe(false);   // 但目标在缓冲区外
    const b = r.outputs.get('b')!;
    expect(b.address).toBe(0x28);
    expect(b.target).toBe(0);      // 读取地址本身越界
    expect(b.valid).toBe(false);
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });
});
