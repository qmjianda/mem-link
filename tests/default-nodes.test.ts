import { describe, expect, it } from 'vitest';
import { bytesToBase64, makeDoc, parseDoc } from '../src/bp/doc';
import { isByteSpan } from '../src/bp/binary-read';
import { fieldPort, type BinaryLayout } from '../src/bp/layouts';
import { interpretValue } from '../src/bp/interpret';
import { currentDoc, initHistory, push, undo } from '../src/bp/history';
import { assertNumeric } from '../src/bp/validation';
import tableExample from '../samples/header-array.blueprint.json';
import poolExample from '../samples/pool-list.blueprint.json';
import { evaluateGraph } from '../src/bp/eval';
import { followAddress } from '../src/bp/follow';
import { addressInteger, exactInteger, isMappedAddress, MAX_ADDRESS } from '../src/bp/precision';
import { deserialize, serialize } from '../src/bp/persist';
import { canConnect, type BPEdge, type BPNode } from '../src/bp/types';

const high = 0xffff800000000001n;
const f = (base: string | number, bytes = [1, 2, 3]): BPNode => ({
  id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: {},
  source: { name: 'dump.bin', data: bytesToBase64(Uint8Array.from(bytes)), base },
});
const n = (id: string, nodeId: string, params: Record<string, string> = {}): BPNode =>
  ({ id, packId: '', nodeId, x: 0, y: 0, params });
const wire = (from: string, port: string, to: string, input: string): BPEdge =>
  ({ id: `${from}.${port}-${to}.${input}`, from: { node: from, port }, to: { node: to, port: input } });
const run = (nodes: BPNode[], edges: BPEdge[] = []) => evaluateGraph(nodes, edges, new Map());

describe('无 pack 的结构布局和集合', () => {
  const header: BinaryLayout = {
    id: 'header', name: '文件头', size: '4', endian: 'little',
    fields: [
      { id: 'offset', name: 'tableOffset', at: '0', kind: 'u16', role: 'offset' },
      { id: 'count', name: 'count', at: '2', kind: 'u8' },
      { id: 'flag', name: 'enabled', at: '3', kind: 'bits', unit: '1', bit: '1', width: '1' },
    ],
  };
  const record: BinaryLayout = {
    id: 'entry', name: '记录', size: '4', endian: 'little',
    fields: [
      { id: 'next', name: 'next', at: '0', kind: 'i16', role: 'index' },
      { id: 'val', name: 'value', at: '2', kind: 'u16', endian: 'big' },
    ],
  };
  const arrNodes = [f(`0x${high.toString(16)}`, [4, 0, 2, 2, 1, 0, 0, 11, 255, 255, 0, 22]),
    n('h', 'structread', { structureId: `layout/${header.id}` }), n('a', 'address'), n('arr', 'arrayread', { elementType: 'record', structureId: `layout/${record.id}` }),
    n('i', 'item', { index: '1' })];
  const arrWires = [wire('f', 'base', 'h', 'address'), wire('h', fieldPort(`layout/${header.id}`, 'offset'), 'a', 'offset'),
    wire('a', 'address', 'arr', 'address'), wire('h', fieldPort(`layout/${header.id}`, 'count'), 'arr', 'count'), wire('arr', 'list', 'i', 'list')];

  it('表头驱动数组，按下标取真实值和原地址，不重新读', () => {
    const r = evaluateGraph(arrNodes, arrWires, new Map(), { layouts: [header, record] });
    expect(r.problems).toEqual([]);
    expect(r.outputs.get('h')?.[fieldPort(`layout/${header.id}`, 'flag')]).toBe(1n);
    expect(r.outputs.get('arr')?.count).toBe(2n);
    expect(r.outputs.get('i')?.[fieldPort(`layout/${record.id}`, 'val')]).toBe(22n);
    expect(r.outputs.get('i')?.address).toMatchObject({ value: high + 8n });
    const items = r.outputs.get('arr')?.list as unknown[];
    expect(r.outputs.get('i')?.instance).toBe(items[1]);
  });

  it('取项下标可以随上游接线变化，未读索引不回退到默认项', () => {
    const file = f(0, [7, 9]);
    const indexFile = { ...f(0, [1]), id: 'g' };
    const nodes = [file, indexFile, n('a', 'arrayread', { scalar: 'u8', count: '2', sourceId: 'f' }),
      n('index', 'readint', { address: '0', scalar: 'u8', sourceId: 'g' }), n('picked', 'item')];
    const edges = [wire('a', 'list', 'picked', 'list'), wire('index', 'value', 'picked', 'index')];
    const r = run(nodes, edges);
    expect(r.outputs.get('picked')?.value).toBe(9n);
    expect(r.origins?.get('picked')?.value.buffer.assetId).toBe(r.sources.get('f')?.assetId);
    const replaced = [file, { ...f(0, [3]), id: 'g' }, ...nodes.slice(2)];
    expect(run(replaced, edges).outputs.get('picked')?.value).toBeUndefined();
  });

  it('数组触及读取上限时发布前缀和准确的下一项', () => {
    const file = f(0, Array.from({ length: 4098 }, () => 7));
    const result = run([file, n('a', 'arrayread', { count: '4098', scalar: 'u8' })]);
    expect(result.views.get('a')).toMatchObject({ count: 4096, truncated: true,
      trunc: { at: 4096, unit: 'index', limit: 4096, canContinue: true } });
  });

  it('共享布局重命名不改端口，并能通过历史、导出与缓存恢复', () => {
    const nodes = [...arrNodes, n('h2', 'structread', { structureId: `layout/${header.id}` })];
    const edges = [...arrWires, wire('f', 'base', 'h2', 'address')];
    const before = { packs: [], nodes, edges, layouts: [header, record] };
    const renamed = { ...header, name: '共享表头', fields: header.fields.map(f => f.id !== 'count' ? f : { ...f, name: '记录项数' }) };
    const after = { ...before, layouts: [renamed, record] };
    const history = push(initHistory(before), after, '修改结构布局', { now: 1 });
    expect(currentDoc(undo(history))).toBe(before);
    const doc = parseDoc(JSON.stringify(makeDoc([], nodes, edges, after.layouts))).doc!;
    const cache = deserialize(serialize({ ...doc, packs: [] })).doc!;
    const result = evaluateGraph(cache.nodes, cache.edges, new Map(), { layouts: cache.layouts });
    const countPort = result.ports.get('h')?.outputs.find(p => p.name === fieldPort(`layout/${header.id}`, 'count'));
    expect(countPort?.label).toBe('记录项数');
    expect(result.ports.get('h2')?.outputs.find(p => p.name === countPort?.name)?.label).toBe('记录项数');
    expect(result.outputs.get('arr')?.count).toBe(2n);
  });

  it('布局缺失或字段出界不使用别的布局或假字段', () => {
    const missing = evaluateGraph(arrNodes, arrWires, new Map(), { layouts: [record] });
    expect(missing.problems).toContainEqual(expect.objectContaining({ nodeKey: 'h', code: 'INVALID_LAYOUT' }));
    const invalid = evaluateGraph(arrNodes, arrWires, new Map(), { layouts: [{ ...header, size: '2' }, record] });
    expect(invalid.problems).toContainEqual(expect.objectContaining({ nodeKey: 'h', code: 'INVALID_LAYOUT' }));
    expect(invalid.outputs.get('h')?.instance).toBeUndefined();
  });

  it('布局有效但结构跨越限定字节范围时不发布半条记录', () => {
    const nodes = [f(0, [1, 2, 3, 4]), n('range', 'slice', { length: '2' }), n('h', 'structread', { structureId: `layout/${header.id}` })];
    const result = evaluateGraph(nodes, [wire('range', 'span', 'h', 'buffer')], new Map(), { layouts: [header] });
    expect(result.problems).toContainEqual(expect.objectContaining({ nodeKey: 'h', code: 'OUT_OF_BOUNDS' }));
    expect(result.outputs.get('h')?.instance).toBeUndefined();
  });

  it('数组保留成功前缀并拒绝取未读项；空集合是正常结果', () => {
    const file = f(0, [1, 2]);
    const a = n('a', 'arrayread', { scalar: 'u8', count: '4' });
    const r = run([file, a, n('x', 'item', { index: '2' }), n('empty', 'arrayread', { count: '0' })],
      [wire('a', 'list', 'x', 'list')]);
    expect(r.outputs.get('a')?.count).toBe(2n);
    expect(r.outputs.get('x')?.instance).toBeUndefined();
    expect(r.outputs.get('empty')?.list).toEqual([]);
    expect(r.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: 'a', code: 'OUT_OF_BOUNDS', addr: 2n }),
      expect.objectContaining({ nodeKey: 'x', code: 'INDEX_OUT_OF_RANGE' }),
    ]));
  });

  it.each([
    [255, 255, '2', '自然结束', undefined],
    [1, 0, '2', '发现环', 'RECORD_CYCLE'],
    [3, 0, '2', '遇到不可读记录', 'OUT_OF_BOUNDS'],
    [2, 0, '2', '达到上限', 'TRUNCATED'],
  ])('池下标链表停止状态：%s %s', (lo, hi, limit, stop, code) => {
    const file = f(0x1000, [lo, hi, 0, 10, 0, 0, 0, 20, 255, 255, 0, 30]); // 下标 1 -> 0
    const list = n('list', 'listread', { structureId: `layout/${record.id}`, address: '0x1004', mode: 'index', limit, nextField: 'next', stopValue: '-1' });
    const r = evaluateGraph([file, list], [], new Map(), { layouts: [record] });
    expect(r.views.get('list')).toMatchObject({ stop, count: 2, truncated: code === 'TRUNCATED' });
    expect(r.problems.find(p => p.nodeKey === 'list')?.code).toBe(code);
    expect(r.outputs.get('list')?.list).toMatchObject([{ location: { value: 0x1004n } }, { location: { value: 0x1000n } }]);
  });

  it('绝对地址链表先判定定制结束值，即使结束值不是一个合法地址', () => {
    const layout = { ...record, fields: [{ ...record.fields[0], role: 'address' as const }, record.fields[1]] };
    const file = f(0x1000, [4, 16, 0, 10, 255, 255, 0, 20]);
    const list = n('list', 'listread', { structureId: `layout/${layout.id}`, address: '0x1000', nextField: 'next', stopValue: '-1' });
    const result = evaluateGraph([file, list], [], new Map(), { layouts: [layout] });
    expect(result.views.get('list')).toMatchObject({ count: 2, stop: '自然结束' });
    expect(result.problems).toEqual([]);
  });

  it('检查器枚举、标志位与时间解读不需要节点或损失高位', () => {
    expect(interpretValue(0n, 'time')).toBe('1970-01-01T00:00:00.000Z');
    expect(interpretValue(1n << 63n, 'flags', '0x8000000000000000=High')).toBe('High');
    expect(interpretValue(2n, 'enum', '1=Ready,2=Busy')).toBe('Busy');
    expect(interpretValue((1n << 64n) - 1n, 'hex')).toBe('0xffffffffffffffff');
  });
});
describe('精确基址与端口', () => {
  it('共享数值常量也能精确连接到 64 位断言', () => {
    const value = '0xfedcba9876543211';
    const r = run([n('hi', 'number', { value }), n('a', 'assert', { expected: value })], [wire('hi', 'value', 'a', 'actual')]);
    expect(r.outputs.get('hi')?.value).toBe(0xfedcba9876543211n);
    expect(r.outputs.get('a')?.status).toBe('通过');
  });
  it('区分安全整数、可精确解析的字面量和非法值', () => {
    expect(exactInteger('-0x8000000000000000')).toBe(-(1n << 63n));
    expect(addressInteger('0xFFFFFFFFFFFFFFFF')).toBe(MAX_ADDRESS);
    expect(addressInteger('18446744073709551616')).toBeUndefined();
    for (const v of [-1, Number.MAX_SAFE_INTEGER + 1, '1.5', '0x', '', 'Infinity']) {
      expect(addressInteger(v)).toBeUndefined();
    }
  });

  it('地址、已声明的偏移和下标不是通用数值端口', () => {
    expect(canConnect('address', 'number')).toBe(false);
    expect(canConnect('address', 'index')).toBe(false);
    expect(canConnect('offset', 'index')).toBe(false);
    expect(canConnect('index', 'address')).toBe(false);
    expect(canConnect('integer', 'offset')).toBe(true); // 显式绑定到偏移输入
  });

  it('精确基址通过保存、缓存和求值保留来源及最低位', () => {
    const nodes = [f('0xffff800000000001')];
    const exported = parseDoc(JSON.stringify(makeDoc([], nodes, []))).doc!;
    const stored = deserialize(serialize({ ...exported, packs: [] })).doc!;
    const result = evaluateGraph(stored.nodes, [], new Map());
    const addr = result.outputs.get('f')?.base;
    expect(result.problems).toEqual([]);
    expect(stored.nodes[0].source?.base).toBe('0xffff800000000001');
    expect(isMappedAddress(addr)).toBe(true);
    expect(followAddress(addr)).toBe(high);
    expect(addr).toMatchObject({ value: high, assetId: result.sources.get('f')?.assetId });
  });

  it('不发布越过 64 位地址空间的文件映射', () => {
    const result = evaluateGraph([f('0xffffffffffffffff')], [], new Map());
    expect(result.outputs.get('f')?.buffer).toBeUndefined();
    expect(result.problems.some((p) => p.code === 'BAD_INPUT' && p.nodeKey === 'f')).toBe(true);
  });
});

describe('地址换算与字节范围', () => {
  it('相同内容和基址是一个映射，重复载入不制造来源冲突', () => {
    const result = run([f(0), { ...f('0x0'), id: 'copy' }, n('r', 'readint', { scalar: 'u8' })]);
    expect(result.problems).toEqual([]);
    expect(result.outputs.get('r')?.value).toBe(1n);
  });
  it('同一地址的两份转储不混读，也不自动选第一份', () => {
    const nodes = [f(0x1000), { ...f(0x1000, [9, 8, 7]), id: 'g' },
      n('a', 'address', { offset: '1' }), n('r', 'readint', { scalar: 'u8' }),
      n('none', 'readint', { scalar: 'u8', address: '0x1000' })];
    const edges = [wire('g', 'base', 'a', 'base'), wire('a', 'address', 'r', 'address')];
    const result = run(nodes, edges);
    expect(result.outputs.get('r')?.value).toBe(8n);
    expect(result.outputs.get('none')?.value).toBeUndefined();
    expect(result.problems.some(p => p.nodeKey === 'none' && p.code === 'SOURCE_CONFLICT')).toBe(true);
    const conflict = run(nodes, [...edges, wire('f', 'buffer', 'r', 'buffer')]);
    expect(conflict.outputs.get('r')?.value).toBeUndefined();
    expect(conflict.problems.some(p => p.nodeKey === 'r' && p.code === 'SOURCE_CONFLICT')).toBe(true);
  });

  it('允许负偏移，但拒绝溢出、负下标和零步长', () => {
    const result = run([f(0x1000), n('negative', 'address', { offset: '-1' }),
      n('overflow', 'address', { base: '0xffffffffffffffff', offset: '1' }),
      n('index', 'address', { mode: 'index', index: '-1' }),
      n('stride', 'address', { mode: 'index', index: '0', stride: '0' })]);
    expect(result.outputs.get('negative')?.address).toMatchObject({ value: 0xfffn });
    for (const id of ['overflow', 'index', 'stride']) {
      expect(result.outputs.get(id)?.address).toBeUndefined();
      expect(result.problems.some(p => p.nodeKey === id && p.code === 'BAD_INPUT')).toBe(true);
    }
  });

  it('嵌套范围共享原始字节，越界后下游不回退到全量转储', () => {
    const nodes = [f(0x1000, [1, 2, 3, 4, 5]), n('s', 'slice', { address: '0x1001', length: '2' }),
      n('t', 'slice', { address: '0x1002', length: '1' }), n('r', 'readint', { address: '0x1002', scalar: 'u8' }),
      n('bad', 'slice', { address: '0x1002', length: '2' }), n('blocked', 'readint', { address: '0x1000', scalar: 'u8' })];
    const result = run(nodes, [wire('s', 'span', 't', 'buffer'), wire('t', 'span', 'r', 'buffer'),
      wire('s', 'span', 'bad', 'buffer'), wire('bad', 'span', 'blocked', 'buffer')]);
    const span = result.outputs.get('t')?.span;
    expect(isByteSpan(span)).toBe(true);
    if (isByteSpan(span)) {
      expect(span.buffer.bytes.buffer).toBe(result.sources.get('f')?.buffer?.bytes.buffer);
      expect(span.buffer.assetId).toBe(result.sources.get('f')?.assetId);
      expect(span.buffer.mappingBase).toBe(0x1000);
    }
    expect(result.outputs.get('r')?.value).toBe(3n);
    expect(result.outputs.get('blocked')?.value).toBeUndefined();
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: 'bad', code: 'OUT_OF_BOUNDS' }),
      expect.objectContaining({ nodeKey: 'blocked', code: 'NO_SOURCE' }),
    ]));
  });

  it('有范围值的环报 CYCLE，不会扩大读取范围', () => {
    const result = run([f(0), n('s', 'slice', { address: '0' }), n('r', 'readint', { address: '0', scalar: 'u8' })],
      [wire('s', 'span', 'r', 'buffer'), wire('r', 'value', 's', 'length')]);
    expect(result.problems.some(p => p.code === 'CYCLE')).toBe(true);
    expect(result.outputs.get('r')?.value).toBeUndefined();
  });
});

describe('定宽读数值、文本和指针', () => {
  it('通过精确地址连线读取 u64，显示方式不产生额外输出', () => {
    const nodes = [f(`0x${high.toString(16)}`, [0x11, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]),
      n('r', 'readint', { scalar: 'u64' })];
    const result = run(nodes, [wire('f', 'base', 'r', 'address')]);
    expect(result.outputs.get('r')).toEqual({ value: 0xfedcba9876543211n });
    expect(result.inputs.get('r')?.address.display).toBe(`0x${high.toString(16)}`);
    expect(result.views.get('r')).toMatchObject({ detail: expect.stringContaining('0xFEDCBA9876543211') });
  });

  it.each([
    ['utf-8', [0xe4, 0xb8, 0xad, 0], '中', 4n],
    ['utf-16le', [0x41, 0, 0, 0], 'A', 4n],
    ['utf-16be', [0, 0x41, 0, 0], 'A', 4n],
    ['ascii', [0x41, 0], 'A', 2n],
  ] as const)('按字节从 %s 读到真实终止符', (encoding, bytes, text, length) => {
    expect(run([f(0, [...bytes]), n('t', 'text', { encoding })]).outputs.get('t')).toEqual({ text, length });
  });

  it.each([
    [{ length: '4', mode: 'fixed' }, [0x41], 'OUT_OF_BOUNDS'],
    [{ length: '4' }, [0x41], 'MISSING_TERMINATOR'],
    [{ length: '2', mode: 'fixed' }, [0xc3, 0x41], 'INVALID_ENCODING'],
    [{ length: '1048577' }, [0x41], 'READ_LIMIT'],
  ] as const)('失败的读字符串没有伪造输出：%o', (params, bytes, code) => {
    const result = run([f(0, [...bytes]), n('t', 'text', { ...params })]);
    expect(result.outputs.get('t')?.text).toBeUndefined();
    expect(result.problems).toContainEqual(expect.objectContaining({ nodeKey: 't', code, addr: 0n }));
  });

  it('读指针明确区分空、未映射、越界；失败不会接着读地址 0', () => {
    const nodes = [f(0, [0, 0, 0, 0, 0xcc, 0, 0, 0, 1]),
      n('nil', 'ptrwalk', { address: '0', pointerSize: '4' }), n('outside', 'ptrwalk', { address: '4', pointerSize: '4' }),
      n('broken', 'ptrwalk', { address: '8', pointerSize: '4' }), n('r', 'readint', { address: '0', scalar: 'u8' })];
    const result = run(nodes, [wire('broken', 'target', 'r', 'address')]);
    expect(result.views.get('nil')).toMatchObject({ detail: expect.stringContaining('空指针') });
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: 'outside', code: 'UNMAPPED_POINTER', detail: expect.stringContaining('0xcc') }),
      expect.objectContaining({ nodeKey: 'broken', code: 'OUT_OF_BOUNDS' }),
    ]));
    for (const id of ['nil', 'outside', 'broken']) expect(result.outputs.get(id)?.target).toBeUndefined();
    expect(result.outputs.get('r')?.value).toBeUndefined();
  });

  it('换算偏移与指针读取可组成高位地址链', () => {
    const bytes = new Uint8Array(0x28);
    const data = new DataView(bytes.buffer);
    data.setBigUint64(8, high + 0x18n, true);
    data.setBigUint64(0x10, high + 0x27n, true);
    bytes[0x27] = 42;
    const nodes = [f(`0x${high.toString(16)}`, [...bytes]), n('a', 'address', { offset: '8' }),
      n('p', 'ptrwalk'), n('b', 'address', { offset: '-8' }), n('q', 'ptrwalk'), n('r', 'readint', { scalar: 'u8' })];
    const result = run(nodes, [wire('f', 'base', 'a', 'base'), wire('a', 'address', 'p', 'address'),
      wire('p', 'target', 'b', 'base'), wire('b', 'address', 'q', 'address'), wire('q', 'target', 'r', 'address')]);
    expect(result.problems).toEqual([]);
    expect(result.outputs.get('r')?.value).toBe(42n);
  });
});

describe('字节校验与定位', () => {
  const nodes = [
    n('s', 'slice', { address: '0x101', length: '9' }),
    n('sum', 'checksum'),
    n('check', 'assert', { expected: '0xcbf43926' }),
    n('other', 'readint', { address: '0x100', scalar: 'u8' }),
  ];
  const edges = [wire('s', 'span', 'sum', 'span'), wire('sum', 'value', 'check', 'actual')];
  const bytes = [17, ...Array.from('123456789', c => c.charCodeAt(0))];

  it.each([
    ['通过', bytes, undefined],
    ['不通过', [...bytes.slice(0, -1), 1], 'ASSERT_FAILED'],
    ['未能校验', bytes.slice(0, -1), 'ASSERT_UNAVAILABLE'],
  ] as const)('校验 %s 和其他分支独立', (status, data, code) => {
    const r = run([f(0x100, [...data]), ...nodes], edges);
    expect(r.outputs.get('check')?.status).toBe(status);
    expect(r.outputs.get('other')?.value).toBe(17n);
    if (!code) expect(r.problems).toEqual([]);
    else {
      expect(r.problems).toContainEqual(expect.objectContaining({ nodeKey: 'check', code, addr: 0x101n }));
      expect(r.problemOrigins?.get('check')?.buffer.assetId).toBe(r.sources.get('f')?.assetId);
    }
  });

  it('闭区间边界精确，缺失和错误类型不会退化为 false 或 0', () => {
    const lower = 0xfffffffffffffff0n;
    expect(assertNumeric(lower, lower, lower + 1n, true)).toBe('通过');
    expect(assertNumeric(lower - 1n, lower, lower + 1n, true)).toBe('不通过');
    expect(assertNumeric(lower, '0xfffffffffffffff0')).toBe('未能校验');
    expect(assertNumeric(lower, lower + 1n, lower, true)).toBe('未能校验');
  });
});

it('两个随附示例无需 pack 即可打开和求值', () => {
  const demo = (data: unknown) => {
    const doc = parseDoc(JSON.stringify(data)).doc!;
    expect(doc.packs).toEqual([]);
    const r = evaluateGraph(doc.nodes, doc.edges, new Map(), { layouts: doc.layouts });
    expect(r.problems).toEqual([]);
    return r;
  };
  const table = demo(tableExample);
  expect(table.outputs.get('item')?.['field:layout/entry:f2']).toBe(20n);
  expect(table.outputs.get('checksumOk')?.status).toBe('通过');
  expect(table.outputs.get('magicOk')?.status).toBe('通过');
  const pool = demo(poolExample);
  expect(pool.views.get('list')).toMatchObject({ count: 3, stop: '自然结束' });
  expect(pool.outputs.get('last')?.['field:layout/entry:f2']).toBe(10n);
});
