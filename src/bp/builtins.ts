/**
 * Built-in node registry.
 *
 * The three original built-ins (file / number / element) keep their dedicated
 * evaluator branches because they own buffers or produce dynamic field ports.
 * Everything else is declarative: ports, inspector options and a pure `run`
 * that maps resolved inputs (+ the inherited file buffer) to output values.
 * This keeps the evaluator, the palette and the quick-add list in sync.
 */

import { isInstanceView, type BufferValue, type ByteOrigin, type NodeView, type PortSpec, type PortType } from './types';
import { addressHex, exactInteger, mappedAddress, MAX_ADDRESS, MIN_INTEGER } from './precision';
import {
  addOffset, addressIn, byteSpan, integerInput, isByteSpan, pointerRead, ReadIssue, requireSource, scalarRead, stringRead,
  type TextEncoding,
} from './binary-read';
import { compileLayout, layoutPorts, readLayout, type BinaryLayout } from './layouts';
import { expandArray, walkList, type WalkResult } from './collections';
import { compileFor, emptyStructureRegistry, expandEntryArray, readStructureEntry, structurePorts, walkEntryList, type StructureEntry, type StructureRegistry } from './structure';
import { assertNumeric, checksum } from './validation';

export const BUILTIN_IDS = [
  'file', 'slice',
  'number', 'string', 'note',
  'element', 'readint', 'text', 'structread', 'arrayread', 'listread', 'item',
  'expr',
  'address', 'ptrwalk',
  'checksum', 'assert',
] as const;

export type BuiltinId = typeof BUILTIN_IDS[number];

/** Palette groups, in display order. */
export const BUILTIN_GROUPS = [
  '数据源', '读取', '定位', '集合', '校验', '辅助',
] as const;

export interface BuiltinOption {
  key: string;
  label: string;
  kind: 'select' | 'text';
  choices?: { value: string; label: string }[];
  /** default stored in node.params */
  default: string;
}

export interface BuiltinCtx {
  buffer?: BufferValue;
  params: Record<string, string>;
  endian: 'little' | 'big';
  /** Why the buffer is missing, when the node does have a source instruction. */
  sourceNote?: string;
  structures: StructureRegistry;
  report?: (issue: ReadIssue, warning?: boolean, origin?: ByteOrigin) => void;
  inputOrigin?: (port: string) => ByteOrigin | undefined;
  publishOrigin?: (port: string, origin: ByteOrigin) => void;
}

export interface BuiltinDef {
  id: BuiltinId;
  label: string;
  group: typeof BUILTIN_GROUPS[number];
  /** short noun phrase used in the palette and quick-add list */
  hint: string;
  /** handled by dedicated evaluator branches (file / number / element) */
  inputs: PortSpec[];
  outputs: PortSpec[];
  /** 当此节点被用作「在此地址解析」时绑定的输入端口。 */
  followPort?: string;
  precise?: boolean;
  acceptMissing?: boolean;
  /** A selector inherits the context of the selected value, not of its index. */
  inheritSourceFrom?: string;
  ports?: (params: Record<string, string>, structures: StructureRegistry, view?: NodeView) => { inputs: PortSpec[]; outputs: PortSpec[] };
  defaults?: Record<string, string>;
  options?: BuiltinOption[];
  run?: (v: Record<string, unknown>, ctx: BuiltinCtx) => Record<string, unknown>;
  view?: (produced: Record<string, unknown>) => NodeView;
  /** multi-line text shown in the inspector's detail pane */
  detail?: (v: Record<string, unknown>, out: Record<string, unknown>, ctx: BuiltinCtx) => string;
}

/* ------------------------------------------------------------------ helpers */

const n = (v: unknown, d = 0): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : d;
};
const hex = (v: unknown): string => {
  const x = n(v, 0);
  return x < 0 ? `-0x${(-x).toString(16)}` : `0x${x.toString(16)}`;
};

const ctxPort = (): PortSpec => ({
  name: 'buffer', type: 'buffer', label: '数据源', context: true,
  hint: '接文件，或留空由上游继承',
});
const numPort = (name: string, label: string): PortSpec => ({ name, type: 'number', label });
const strPort = (name: string, label: string): PortSpec => ({ name, type: 'string', label });
const typed = (name: string, type: PortType, label: string): PortSpec => ({ name, type, label });
const addrPort = () => typed('address', 'address', '地址');
const intPort = (name: string, label: string): PortSpec => typed(name, 'integer', label);

const select = (key: string, label: string, choices: [string, string][], dflt: string): BuiltinOption => ({
  key, label, kind: 'select', default: dflt,
  choices: choices.map(([value, name]) => ({ value, label: name })),
});

const SCALAR_TYPES = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'];
const SCALAR_OPTION = select('scalar', '类型', SCALAR_TYPES.map((k) => [k, k]), 'u32');
const ENDIAN_OPTION = select('endian', '字节序', [['little', '小端'], ['big', '大端']], 'little');

function printable(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  return s;
}

function hexCells(bytes: Uint8Array, width: number): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(width * 3 - 1, ' ');
}

function hexDump(bytes: Uint8Array, start: bigint, width = 16, maxLines = 16): string {
  const lines: string[] = [];
  const total = Math.min(bytes.length, width * maxLines);
  for (let i = 0; i < total; i += width) {
    const chunk = bytes.subarray(i, Math.min(i + width, bytes.length));
    lines.push(`${(start + BigInt(i)).toString(16).padStart(8, '0')}  ${hexCells(chunk, width)}  |${printable(chunk)}|`);
  }
  if (bytes.length > total) lines.push(`… 还有 ${bytes.length - total} 字节`);
  return lines.join('\n');
}

/**
 * 解析多级指针的偏移链输入：`+0x10, +0x24` / `0x10 0x24` / `16, -8` 均可。
 * 空串表示单级直接跟随。
 */
export function parseOffsetChain(text: string): { offsets: bigint[]; error?: string } {
  const parts = (text ?? '').split(/[\s,;，；]+/).filter(Boolean);
  if (parts.length > 32) return { offsets: [], error: '偏移链最多支持 32 级' };
  const offsets: bigint[] = [];
  for (const p of parts) {
    const offset = exactInteger(p);
    if (offset === undefined || offset < MIN_INTEGER || offset > MAX_ADDRESS) return { offsets: [], error: `无法解析偏移「${p}」` };
    offsets.push(offset);
  }
  return { offsets };
}

/* ---------------------------------------------------------- expression eval */

const EXPR_PRECEDENCE: Record<string, number> = {
  '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

/** A small, side-effect-free arithmetic/bitwise expression evaluator. */
export function evalExpression(src: string, vars: Record<string, number>): number {
  let i = 0;
  const s = src ?? '';
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };

  const primary = (): number => {
    ws();
    if (s[i] === '(') {
      i += 1;
      const v = parse(0);
      ws();
      if (s[i] !== ')') throw new Error('表达式缺少右括号');
      i += 1;
      return v;
    }
    if (s[i] === '-' || s[i] === '~') {
      const op = s[i];
      i += 1;
      const v = primary();
      return op === '-' ? -v : ~v;
    }
    if (s[i] === '+') { i += 1; return primary(); }
    const number = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)/.exec(s.slice(i));
    if (number) { i += number[0].length; return Number(number[0]); }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (name) {
      i += name[0].length;
      const key = name[0].toLowerCase();
      if (!(key in vars)) throw new Error(`未知变量 ${name[0]}`);
      return vars[key];
    }
    throw new Error(`表达式无法解析：${s.slice(i, i + 8) || '末尾'}`);
  };

  const parse = (minPrec: number): number => {
    let lhs = primary();
    for (;;) {
      ws();
      const m = /^(<<|>>|\+|-|\*|\/|%|&|\||\^)/.exec(s.slice(i));
      if (!m) break;
      const op = m[0];
      const prec = EXPR_PRECEDENCE[op];
      if (prec < minPrec) break;
      i += op.length;
      const rhs = parse(prec + 1);
      switch (op) {
        case '+': lhs += rhs; break;
        case '-': lhs -= rhs; break;
        case '*': lhs *= rhs; break;
        case '/': lhs /= rhs; break;
        case '%': lhs %= rhs; break;
        case '&': lhs = (lhs | 0) & (rhs | 0); break;
        case '|': lhs = (lhs | 0) | (rhs | 0); break;
        case '^': lhs = (lhs | 0) ^ (rhs | 0); break;
        case '<<': lhs = (lhs | 0) << (rhs | 0); break;
        case '>>': lhs = (lhs | 0) >> (rhs | 0); break;
      }
    }
    return lhs;
  };

  const value = parse(0);
  ws();
  if (i < s.length) throw new Error(`表达式多余内容：${s.slice(i, i + 12)}`);
  if (!Number.isFinite(value)) throw new Error('表达式结果无效');
  return value;
}

/* ----------------------------------------------------------------- registry */

function optionDefaults(def: BuiltinDef): Record<string, string> {
  const out: Record<string, string> = { ...def.defaults };
  for (const o of def.options ?? []) if (!(o.key in out)) out[o.key] = o.default;
  return out;
}

const collectionOutputs = () => [typed('list', 'list', '集合'), intPort('count', '已读项数')];
const arrayInputs = () => [ctxPort(), addrPort(), intPort('count', '项数'), intPort('stride', '字节步长（默认类型长度）')];
const recordOutputs = () => [typed('instance', 'instance', '记录'), addrPort()];
const ADDRESS_MODE = select('addressMode', '位置来源', [['address', '映射地址'], ['offset', '文件偏移']], 'address');
const positionInputs = (params: Record<string, string>): PortSpec[] => [
  ctxPort(),
  params.addressMode === 'offset'
    ? { ...typed('offset', 'offset', '文件偏移'), hint: '相对当前数据源基址的字节偏移' }
    : addrPort(),
];
const positionOf = (
  v: Record<string, unknown>,
  params: Record<string, string>,
  src: BufferValue,
): bigint => params.addressMode === 'offset'
  ? addOffset(BigInt(src.base), integerInput(v.offset, '文件偏移', 0n))
  : addressIn(v.address, src);
const structureOf = (ctx: BuiltinCtx): StructureEntry | undefined => ctx.structures.get(ctx.params.structureId);
const walkView = (kind: 'list' | 'array', result: WalkResult): NodeView => ({
  kind, items: result.items, count: result.items.length, local: true,
  stop: ({ complete: '自然结束', limit: '达到上限', cycle: '发现环', unreadable: '遇到不可读记录' })[result.stop],
  truncated: result.stop === 'limit', trunc: result.trunc, error: result.notice?.message,
});

export const BUILTIN_DEFS: BuiltinDef[] = [
  {
    id: 'file', label: '载入转储', group: '数据源', hint: '载入二进制文件或粘贴 Hex 作为只读数据源',
    inputs: [],
    outputs: [
      { name: 'buffer', type: 'buffer', label: '缓冲区' },
      { name: 'base', type: 'address', label: '基址' },
      numPort('size', '大小'),
    ],
    defaults: { name: '未载入' },
  },
  {
    id: 'slice', label: '字节范围', group: '数据源', hint: '截取有来源的字节范围，下游不能越过其边界',
    followPort: 'address',
    precise: true,
    inputs: [ctxPort(), addrPort(), intPort('length', '长度 (B)')],
    outputs: [typed('span', 'span', '字节范围')],
    defaults: { address: '0x0', length: '64' },
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      return { span: byteSpan(src, addressIn(v.address, src), integerInput(v.length, '长度', 0n)) };
    },
    detail: (_v, out) => isByteSpan(out.span)
      ? hexDump(out.span.buffer.bytes, BigInt(out.span.buffer.base)) : '',
  },
  {
    id: 'number', label: '数值', group: '辅助', hint: '十进制或 0x 常量',
    inputs: [], outputs: [numPort('value', '值')], defaults: { value: '0' },
  },
  {
    id: 'string', label: '文本常量', group: '辅助', hint: '可复用的文本输入',
    inputs: [], outputs: [strPort('text', '文本'), numPort('length', '长度')],
    options: [{ key: 'value', label: '内容', kind: 'text', default: '' }],
    run: (_v, ctx) => {
      const text = ctx.params.value ?? '';
      return { text, length: text.length };
    },
  },
  {
    id: 'note', label: '标注 / Note', group: '辅助', hint: '把分析结论、待办钉在图上，随图保存',
    // 故意不声明任何输入：不携带文件上下文、不参与数据源继承，画布上也没有端口行。
    inputs: [],
    outputs: [],
    defaults: { text: '', tone: 'note' },
    options: [
      select('tone', '标记', [['note', '标注'], ['info', '说明'], ['warn', '疑点'], ['key', '重点']], 'note'),
    ],
    run: (_v, ctx) => ({ text: ctx.params.text ?? '' }),
    // `outputs` 为空，内容只能从 params 取：run 的入参只包含连线输入。
    detail: (_v, out, ctx) => String(ctx.params.text || '（空标注）'),
  },
  {
    id: 'element', label: '元素解析', group: '集合',
    hint: '按地址 + 类型解析字段，或展开已连接的元素',
    inputs: [
      ctxPort(),
      numPort('address', '地址'),
      { name: 'instance', type: 'instance', label: '元素' },
      { name: 'list', type: 'list', label: '列表' },
      numPort('index', '下标'),
    ],
    outputs: [],
    defaults: { index: '0' },
  },
  {
    id: 'readint', label: '读数值', group: '读取', hint: '按固定类型和字节序读取一个整数或浮点数',
    followPort: 'address',
    precise: true,
    inputs: [ctxPort(), addrPort()],
    outputs: [intPort('value', '值')],
    ports: (params) => ({
      inputs: [ctxPort(), addrPort()],
      outputs: [typed('value', params.scalar?.startsWith('f') ? 'number' : 'integer', '值')],
    }),
    defaults: { address: '0x0' },
    options: [SCALAR_OPTION, ENDIAN_OPTION],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const address = addressIn(v.address, src);
      const result = scalarRead(src, address, ctx.params.scalar ?? 'u32', ctx.endian);
      ctx.publishOrigin?.('value', { buffer: src, address, length: result.width });
      return result;
    },
    detail: (_v, out) => {
      const raw = out.raw as bigint;
      const width = Number(out.width);
      return `十进制  ${out.value}\n十六进制  0x${raw.toString(16).toUpperCase().padStart(width * 2, '0')}\n二进制  ${raw.toString(2).padStart(width * 8, '0').replace(/(.{8})(?=.)/g, '$1 ')}`;
    },
  },
  {
    id: 'text', label: '读字符串', group: '读取', hint: '按明确编码和字节限制读取文本',
    followPort: 'address',
    precise: true,
    inputs: [ctxPort(), addrPort(), intPort('length', '长度 / 上限 (B)')],
    outputs: [strPort('text', '文本'), intPort('length', '实际读取 (B)')],
    defaults: { address: '0x0', length: '64' },
    options: [
      select('mode', '结束方式', [['nul', '零终止'], ['fixed', '定长']], 'nul'),
      select('encoding', '编码', [['ascii', 'ASCII'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16LE'], ['utf-16be', 'UTF-16BE']], 'utf-8'),
    ],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const encoding = ctx.params.encoding ?? 'utf-8';
      if (!['ascii', 'utf-8', 'utf-16le', 'utf-16be'].includes(encoding)) throw new ReadIssue('BAD_INPUT', '未知文本编码');
      const { text, length } = stringRead(src, addressIn(v.address, src), integerInput(v.length, '字节长度', 0n),
        ctx.params.mode === 'fixed' ? 'fixed' : 'nul', encoding as TextEncoding);
      return { text, length: BigInt(length) };
    },
  },
  {
    id: 'structread', label: '读结构', group: '读取', hint: '引用一份布局，读取一条记录及其字段',
    followPort: 'address',
    precise: true,
    inputs: [ctxPort(), addrPort()], outputs: recordOutputs(),
    ports: (params, structures) => {
      const entry = structures.get(params.structureId);
      return {
        inputs: positionInputs(params),
        outputs: [...recordOutputs(), ...(entry ? structurePorts(entry) : [])],
      };
    },
    defaults: { address: '0x0' },
    options: [ADDRESS_MODE],
    run: (v, ctx) => {
      const entry = structureOf(ctx);
      if (!entry) throw new ReadIssue('INVALID_LAYOUT', '请选择有效的结构');
      if (entry.error) throw new ReadIssue('INVALID_LAYOUT', entry.error);
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const instance = readStructureEntry(entry, ctx.structures, src, positionOf(v, ctx.params, src));
      return { instance, address: instance.location, ...Object.fromEntries(instance.fields.map(f => [f.name, f.value])) };
    },
    view: ({ instance }) => ({ kind: 'struct', inst: isInstanceView(instance) ? instance : undefined }),
  },
  {
    id: 'arrayread', label: '展开数组', group: '集合', hint: '按起点、项数和步长读取标量或结构集合',
    followPort: 'address', precise: true,
    inputs: arrayInputs(), outputs: collectionOutputs(),
    defaults: { address: '0x0', count: '1' },
    ports: (params) => ({
      inputs: [...positionInputs(params), intPort('count', '项数'), intPort('stride', '字节步长（默认类型长度）')],
      outputs: collectionOutputs(),
    }),
    options: [ADDRESS_MODE, select('elementType', '元素类型', [['scalar', '标量'], ['record', '结构布局']], 'scalar'), SCALAR_OPTION, ENDIAN_OPTION],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const entry = ctx.params.elementType === 'record' ? structureOf(ctx) : undefined;
      if (ctx.params.elementType === 'record' && !entry) throw new ReadIssue('INVALID_LAYOUT', '请选择有效的元素结构');
      const at = positionOf(v, ctx.params, src);
      const walk = entry
        ? expandEntryArray(src, at, integerInput(v.count, '项数', 0n),
          v.stride === undefined ? undefined : integerInput(v.stride, '步长', 1n), entry, ctx.structures)
        : expandArray(src, at, integerInput(v.count, '项数', 0n),
          v.stride === undefined ? undefined : integerInput(v.stride, '步长', 1n), ctx.params.scalar ?? 'u32', ctx.endian);
      if (walk.notice) ctx.report?.(walk.notice, walk.stop === 'limit');
      return { list: walk.items, count: BigInt(walk.items.length), walk };
    },
    view: ({ walk }) => walkView('array', walk as WalkResult),
  },
  {
    id: 'listread', label: '遍历链表', group: '集合', hint: '按记录的 next 字段读取链表（绝对地址或池下标）',
    followPort: 'address', precise: true,
    inputs: [ctxPort(), addrPort(), intPort('limit', '最多项数')],
    outputs: collectionOutputs(),
    ports: (params) => ({
      inputs: [ctxPort(), addrPort(), intPort('limit', '最多项数'),
        ...(params.mode === 'index' ? [typed('poolBase', 'address', '池基址'), intPort('stride', '字节步长（默认结构长度）')] : [])],
      outputs: collectionOutputs(),
    }),
    defaults: { address: '0x0', limit: '256' },
    options: [
      select('mode', 'next 寻址', [['address', '绝对地址'], ['index', '池下标']], 'address'),
      { key: 'stopValue', label: '结束值', kind: 'text', default: '0' },
    ],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const entry = structureOf(ctx);
      if (!entry) throw new ReadIssue('INVALID_LAYOUT', '请选择有效的结构');
      if (entry.error) throw new ReadIssue('INVALID_LAYOUT', entry.error);
      const pool = ctx.params.mode === 'index' ? {
        base: addressIn(v.poolBase ?? BigInt(src.base), src),
        stride: v.stride === undefined ? BigInt(entry.size) : integerInput(v.stride, '步长', 1n),
      } : undefined;
      const config = {
        start: addressIn(v.address, src), nextField: ctx.params.nextField ?? '',
        stopValue: integerInput(ctx.params.stopValue ?? '0', '结束值'), max: Number(integerInput(v.limit, '最多项数', 1n, 0xffffffffn)),
        pool,
      };
      const walk = entry.layout
        ? walkList(src, entry.layout, config, (id) => ctx.structures.layout(id))
        : walkEntryList(src, entry, ctx.structures, config);
      if (walk.notice) ctx.report?.(walk.notice, walk.stop === 'limit' || walk.stop === 'cycle');
      return { list: walk.items, count: BigInt(walk.items.length), walk };
    },
    view: ({ walk }) => walkView('list', walk as WalkResult),
  },
  {
    id: 'item', label: '按下标取项', group: '集合', hint: '从已读集合取一项，不重新读转储',
    precise: true,
    inheritSourceFrom: 'list',
    inputs: [typed('list', 'list', '集合'), typed('index', 'index', '下标')],
    outputs: recordOutputs(),
    ports: (_params, _layouts, view) => ({
      inputs: [typed('list', 'list', '集合'), typed('index', 'index', '下标')],
      outputs: [...recordOutputs(), ...(view?.kind === 'element' && view.inst?.fields
        ? view.inst.fields.map(f => typed(f.name, f.portType ?? 'number', f.label ?? f.name)) : [])],
    }),
    defaults: { index: '0' },
    run: (v) => {
      const index = integerInput(v.index, '下标', 0n);
      const items = v.list;
      const item = Array.isArray(items) && index < BigInt(items.length) ? items[Number(index)] : undefined;
      if (!isInstanceView(item)) throw new ReadIssue('INDEX_OUT_OF_RANGE', `集合中没有已读的第 ${index} 项`);
      return { instance: item, address: item.location, ...Object.fromEntries(item.fields.map(f => [f.name, f.value])) };
    },
    view: ({ instance }) => ({ kind: 'element', inst: isInstanceView(instance) ? instance : undefined }),
  },
  {
    id: 'expr', label: '表达式', group: '辅助', hint: '算术与位表达式，变量 a / b / c',
    inputs: [numPort('a', 'a'), numPort('b', 'b'), numPort('c', 'c')],
    outputs: [numPort('value', '结果'), strPort('hex', '十六进制')],
    defaults: { a: '0', b: '0', c: '0' },
    options: [{ key: 'formula', label: '表达式', kind: 'text', default: '(a + 1) * b' }],
    run: (v, ctx) => {
      const value = evalExpression(ctx.params.formula ?? 'a', {
        a: n(v.a), b: n(v.b), c: n(v.c),
      });
      return { value, hex: hex(value) };
    },
    detail: (_v, out, ctx) => `${ctx.params.formula ?? 'a'}  =  ${out.value}  (${out.hex})`,
  },
  {
    id: 'address', label: '换算地址', group: '定位', hint: '将字节偏移或池下标换算成地址，不读取内存',
    precise: true,
    inputs: [ctxPort(), typed('base', 'address', '基准地址'), typed('offset', 'offset', '字节偏移')],
    outputs: [addrPort()],
    ports: (params) => ({
      inputs: [ctxPort(), typed('base', 'address', '基准地址'), ...(params.mode === 'index'
        ? [typed('index', 'index', '池下标'), intPort('stride', '字节步长')]
        : [typed('offset', 'offset', '字节偏移')])],
      outputs: [addrPort()],
    }),
    defaults: { offset: '0', index: '0', stride: '1' },
    options: [select('mode', '换算方式', [['offset', '字节偏移'], ['index', '池下标 × 字节步长']], 'offset')],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const base = addressIn(v.base ?? BigInt(src.base), src);
      const delta = ctx.params.mode === 'index'
        ? integerInput(v.index, '池下标', 0n) * integerInput(v.stride, '步长', 1n)
        : integerInput(v.offset, '偏移');
      return { address: mappedAddress(src, addOffset(base, delta)) };
    },
  },
  {
    id: 'ptrwalk', label: '读指针', group: '定位', hint: '读一个指针并检查目标是否映射，不解析目标',
    followPort: 'address',
    precise: true,
    inputs: [ctxPort(), addrPort()],
    outputs: [typed('target', 'address', '目标')],
    defaults: { address: '0x0' },
    options: [
      select('pointerSize', '指针宽度', [['4', '4 字节'], ['8', '8 字节']], '8'), ENDIAN_OPTION,
      { key: 'nullValue', label: '空指针值', kind: 'text', default: '0x0' },
    ],
    run: (v, ctx) => {
      const src = requireSource(ctx.buffer, ctx.sourceNote);
      const width = ctx.params.pointerSize === '4' ? 4 : 8;
      const at = addressIn(v.address, src);
      const result = pointerRead(src, at, width, ctx.endian, integerInput(ctx.params.nullValue ?? '0', '空指针值', 0n, (1n << BigInt(width * 8)) - 1n));
      if (result.state === 'unmapped') throw new ReadIssue('UNMAPPED_POINTER', `目标未映射：${addressHex(result.raw)}`, at);
      return { ...result, at };
    },
    detail: (_v, out) => {
      return `读取地址  ${addressHex(out.at as bigint)}\n${out.state === 'null' ? '空指针' : '目标'}  ${addressHex(out.raw as bigint)}`;
    },
  },
  {
    id: 'checksum', label: '算校验和', group: '校验', hint: '对完整的字节范围计算实际校验值，不作通过判断',
    precise: true,
    inputs: [typed('span', 'span', '字节范围')],
    outputs: [intPort('value', '实际校验值')],
    options: [select('algorithm', '算法', [['crc32', 'CRC-32 / ISO-HDLC'], ['sum32', '32 位字节累加']], 'crc32')],
    run: (v, ctx) => {
      const value = checksum(v.span, ctx.params.algorithm ?? 'crc32');
      if (isByteSpan(v.span)) {
        const buffer = v.span.buffer;
        ctx.publishOrigin?.('value', { buffer, address: BigInt(buffer.base), length: buffer.bytes.length });
      }
      return { value };
    },
    detail: (_v, out) => `0x${(out.value as bigint).toString(16).padStart(8, '0')}`,
  },
  {
    id: 'assert', label: '断言', group: '校验', hint: '判断实际值是否等于预期或落在范围内',
    precise: true, acceptMissing: true,
    inputs: [typed('actual', 'numeric', '实际值'), typed('expected', 'numeric', '预期值')],
    outputs: [
      strPort('status', '状态'), typed('ok', 'boolean', '通过'),
    ],
    ports: (params) => ({
      inputs: params.mode === 'range'
        ? [typed('actual', 'numeric', '实际值'), typed('min', 'numeric', '最小值'), typed('max', 'numeric', '最大值')]
        : [typed('actual', 'numeric', '实际值'), typed('expected', 'numeric', '预期值')],
      outputs: [strPort('status', '状态'), typed('ok', 'boolean', '通过')],
    }),
    options: [select('mode', '条件', [['eq', '相等'], ['range', '闭区间']], 'eq')],
    run: (v, ctx) => {
      const range = ctx.params.mode === 'range';
      const expected = range ? v.min : v.expected;
      const status = assertNumeric(v.actual, expected, v.max, range);
      if (status !== '通过') {
        const origin = ctx.inputOrigin?.('actual') ?? ctx.inputOrigin?.(range ? 'min' : 'expected');
        const desc = status === '未能校验' ? '实际值或预期条件缺失、无效或上游求值失败'
          : `实际 ${v.actual}，预期 ${range ? `${v.min}–${v.max}` : v.expected}`;
        ctx.report?.(new ReadIssue(status === '不通过' ? 'ASSERT_FAILED' : 'ASSERT_UNAVAILABLE', `${status}：${desc}`, origin?.address), false, origin);
      }
      return { status, ok: status === '未能校验' ? undefined : status === '通过' };
    },
    detail: (v, out, ctx) => `${out.status}\n实际 ${v.actual ?? '—'}\n预期 ${ctx.params.mode === 'range' ? `${v.min ?? '—'}–${v.max ?? '—'}` : v.expected ?? '—'}`,
  },
];

export const BUILTIN_MAP: Map<string, BuiltinDef> = new Map(BUILTIN_DEFS.map((d) => [d.id, d]));

/**
 * 新节点继承最近一个同类内置节点的下拉配置（宽度 / 符号 / 字节序 / 指针宽度）。
 * 连续解析同一结构时不必每次重设下拉；只继承与默认值不同的项，保持文档紧凑。
 * 返回值放在 defaults 之后展开即可（显式传入的参数继续覆盖它）。
 */
export function inheritOptions(
  nodeId: string,
  nodes: { packId: string; nodeId: string; params: Record<string, string> }[],
): Record<string, string> {
  const def = BUILTIN_MAP.get(nodeId);
  if (!def?.options?.length) return {};
  const last = [...nodes].reverse().find((n) => n.packId === '' && n.nodeId === nodeId);
  if (!last) return {};
  const inherited: Record<string, string> = {};
  for (const o of def.options) {
    if (o.kind !== 'select') continue;
    const v = last.params[o.key];
    if (v != null && v !== o.default) inherited[o.key] = v;
  }
  return inherited;
}

export function getBuiltin(id: string): BuiltinDef | undefined {
  return BUILTIN_MAP.get(id);
}

export function isBuiltinId(id: string): id is BuiltinId {
  return BUILTIN_MAP.has(id);
}

export function builtinLabel(id: string): string {
  return BUILTIN_MAP.get(id)?.label ?? id;
}

/** Defaults applied when a node is created from the palette / quick add. */
export function builtinDefaults(id: string): Record<string, string> {
  const def = BUILTIN_MAP.get(id);
  return def ? optionDefaults(def) : {};
}

/** Compact configuration summary shown in the node header. */
export function builtinSubtitle(node: { nodeId: string; params: Record<string, string> }): string {
  const def = BUILTIN_MAP.get(node.nodeId);
  if (!def?.options?.length) return '内置';
  const parts: string[] = [];
  for (const o of def.options) {
    if (o.kind === 'text') continue;
    const raw = node.params[o.key] ?? o.default;
    const label = o.choices?.find((c) => c.value === raw)?.label ?? raw;
    parts.push(label);
  }
  return parts.length ? `内置 · ${parts.slice(0, 3).join(' · ')}` : '内置';
}

/** Construct a context for tests and for the evaluator. */
export function makeBuiltinCtx(
  buffer: BufferValue | undefined,
  params: Record<string, string> = {},
  sourceNote?: string,
  structures: StructureRegistry = emptyStructureRegistry(),
  report?: BuiltinCtx['report'],
  inputOrigin?: BuiltinCtx['inputOrigin'],
  publishOrigin?: BuiltinCtx['publishOrigin'],
): BuiltinCtx {
  return {
    buffer,
    params,
    endian: params.endian === 'big' ? 'big' : 'little',
    sourceNote,
    structures,
    report,
    inputOrigin,
    publishOrigin,
  };
}
