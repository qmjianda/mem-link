/**
 * Built-in node registry.
 *
 * The three original built-ins (file / number / element) keep their dedicated
 * evaluator branches because they own buffers or produce dynamic field ports.
 * Everything else is declarative: ports, inspector options and a pure `run`
 * that maps resolved inputs (+ the inherited file buffer) to output values.
 * This keeps the evaluator, the palette and the quick-add list in sync.
 */

import { Memory } from '../core/mem';
import type { BufferValue, PortSpec } from './types';

export const BUILTIN_IDS = [
  'file', 'slice',
  'number', 'string', 'note',
  'element', 'readint', 'text', 'arrayread',
  'expr', 'bitfield', 'enum', 'timestamp',
  'address', 'ptrwalk', 'prp',
  'checksum', 'compare',
] as const;

export type BuiltinId = typeof BUILTIN_IDS[number];

/** Palette groups, in display order. */
export const BUILTIN_GROUPS = [
  '数据源', '常量', '解析', '数值', '地址', '校验',
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
  mem: Memory;
  params: Record<string, string>;
  endian: 'little' | 'big';
  pointerSize: 4 | 8;
  /** Why the buffer is missing, when the node does have a source instruction. */
  sourceNote?: string;
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
  defaults?: Record<string, string>;
  options?: BuiltinOption[];
  run?: (v: Record<string, unknown>, ctx: BuiltinCtx) => Record<string, unknown>;
  /** multi-line text shown in the inspector's detail pane */
  detail?: (v: Record<string, unknown>, out: Record<string, unknown>, ctx: BuiltinCtx) => string;
}

/* ------------------------------------------------------------------ helpers */

const n = (v: unknown, d = 0): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : d;
};
const int = (v: unknown, d = 0): number => Math.trunc(n(v, d));
const hex = (v: unknown): string => {
  const x = n(v, 0);
  return x < 0 ? `-0x${(-x).toString(16)}` : `0x${x.toString(16)}`;
};
const hexN = (v: number, width: number): string => `0x${(v >>> 0).toString(16).padStart(width, '0')}`;

const ctxPort = (): PortSpec => ({
  name: 'buffer', type: 'buffer', label: '数据源', context: true,
  hint: '接文件，或留空由上游继承',
});
const numPort = (name: string, label: string): PortSpec => ({ name, type: 'number', label });
const strPort = (name: string, label: string): PortSpec => ({ name, type: 'string', label });

const select = (key: string, label: string, choices: [string, string][], dflt: string): BuiltinOption => ({
  key, label, kind: 'select', default: dflt,
  choices: choices.map(([value, name]) => ({ value, label: name })),
});

const SIZE_OPTION = select('size', '宽度', [['1', 'u8 / i8'], ['2', 'u16 / i16'], ['4', 'u32 / i32'], ['8', 'u64 / i64']], '4');
/** 「数值读取」专用：整数宽度 + 浮点宽度共用一个下拉。 */
const NUM_SIZE_OPTION = select('size', '宽度', [
  ['1', 'u8 / i8'], ['2', 'u16 / i16'], ['4', 'u32 / i32'], ['8', 'u64 / i64'],
  ['f4', 'f32'], ['f8', 'f64'],
], '4');
const SIGN_OPTION = select('signed', '符号', [['0', '无符号'], ['1', '有符号']], '0');
const ENDIAN_OPTION = select('endian', '字节序', [['little', '小端'], ['big', '大端']], 'little');

function needBuffer(ctx: BuiltinCtx): BufferValue {
  if (!ctx.buffer) throw new Error(ctx.sourceNote ?? '需要缓冲区：把文件节点接到数据源');
  return ctx.buffer;
}

/** Clamp reads to a sane ceiling so a bad length cannot allocate a huge view. */
const MAX_READ = 1 << 20;

function readBytes(ctx: BuiltinCtx, addr: number, len: number): Uint8Array {
  needBuffer(ctx);
  const size = Math.max(0, Math.min(int(len, 0), MAX_READ));
  if (size === 0) return new Uint8Array(0);
  if (!ctx.mem.contains(addr, size)) {
    throw new Error(`读取越界：${hex(addr)} + ${size} B，缓冲区 ${hex(ctx.mem.base)}–${hex(ctx.mem.end)}`);
  }
  return ctx.mem.bytesAt(addr, size);
}

function readInt(ctx: BuiltinCtx, addr: number, size: number, signed: boolean, endian: 'little' | 'big'): number {
  needBuffer(ctx);
  const width = [1, 2, 4, 8].includes(size) ? size : 4;
  if (!ctx.mem.contains(addr, width)) throw new Error(`读取越界：${hex(addr)} + ${width}`);
  if (width === 8) {
    const big = ctx.mem.readBig(addr, 8, endian, signed);
    return Number(big);
  }
  return ctx.mem.readUInt(addr, width, endian, signed);
}

function printable(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  return s;
}

function hexCells(bytes: Uint8Array, width: number): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(width * 3 - 1, ' ');
}

function hexDump(bytes: Uint8Array, start: number, width = 16, maxLines = 16): string {
  const lines: string[] = [];
  const total = Math.min(bytes.length, width * maxLines);
  for (let i = 0; i < total; i += width) {
    const chunk = bytes.subarray(i, Math.min(i + width, bytes.length));
    lines.push(`${(start + i).toString(16).padStart(8, '0')}  ${hexCells(chunk, width)}  |${printable(chunk)}|`);
  }
  if (bytes.length > total) lines.push(`… 还有 ${bytes.length - total} 字节`);
  return lines.join('\n');
}

function cstr(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0) break;
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function sum8(bytes: Uint8Array): number {
  let s = 0;
  for (const b of bytes) s = (s + b) >>> 0;
  return s;
}

/**
 * 解析多级指针的偏移链输入：`+0x10, +0x24` / `0x10 0x24` / `16, -8` 均可。
 * 空串表示单级直接跟随。
 */
export function parseOffsetChain(text: string): { offsets: number[]; error?: string } {
  const parts = (text ?? '').split(/[\s,;，；]+/).filter(Boolean);
  const offsets: number[] = [];
  for (const p of parts) {
    const hexish = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(p);
    if (hexish) {
      const v = Number.parseInt(hexish[2], 16);
      offsets.push(hexish[1] === '-' ? -v : v);
      continue;
    }
    if (/^[+-]?\d+$/.test(p)) { offsets.push(Number(p)); continue; }
    return { offsets: [], error: `无法解析偏移「${p}」` };
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

export const BUILTIN_DEFS: BuiltinDef[] = [
  {
    id: 'file', label: '文件 / Buffer', group: '数据源', hint: '载入二进制文件作为解析源',
    inputs: [],
    outputs: [
      { name: 'buffer', type: 'buffer', label: '缓冲区' },
      numPort('base', '基址'),
      numPort('size', '大小'),
    ],
    defaults: { name: '未载入' },
  },
  {
    id: 'slice', label: '缓冲区切片', group: '数据源', hint: '按地址与长度截取字节',
    inputs: [ctxPort(), numPort('address', '地址'), numPort('length', '长度')],
    outputs: [
      { name: 'bytes', type: 'bytes', label: '字节' },
      numPort('size', '大小'),
      strPort('hex', '十六进制'),
      strPort('ascii', 'ASCII'),
    ],
    defaults: { address: '0x0', length: '64' },
    run: (v, ctx) => {
      const bytes = readBytes(ctx, int(v.address), int(v.length, 64));
      return {
        bytes,
        size: bytes.length,
        hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ').slice(0, 512),
        ascii: printable(bytes).slice(0, 512),
      };
    },
    detail: (v, out) => hexDump((out.bytes as Uint8Array) ?? new Uint8Array(0), int(v.address)),
  },
  {
    id: 'number', label: '数值', group: '常量', hint: '十进制或 0x 常量',
    inputs: [], outputs: [numPort('value', '值')], defaults: { value: '0' },
  },
  {
    id: 'string', label: '文本常量', group: '常量', hint: '文本或注释字符串',
    inputs: [], outputs: [strPort('text', '文本'), numPort('length', '长度')],
    options: [{ key: 'value', label: '内容', kind: 'text', default: '' }],
    run: (_v, ctx) => {
      const text = ctx.params.value ?? '';
      return { text, length: text.length };
    },
  },
  {
    id: 'note', label: '标注 / Note', group: '常量', hint: '把分析结论、待办钉在图上，随图保存',
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
    id: 'element', label: '元素解析', group: '解析',
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
    id: 'readint', label: '数值读取', group: '解析', hint: '整数或浮点：宽度、符号与字节序',
    inputs: [ctxPort(), numPort('address', '地址')],
    outputs: [numPort('value', '值'), strPort('hex', '十六进制'), strPort('binary', '二进制'), numPort('width', '宽度')],
    defaults: { address: '0x0' },
    options: [NUM_SIZE_OPTION, SIGN_OPTION, ENDIAN_OPTION],
    run: (v, ctx) => {
      const size = ctx.params.size ?? '4';
      const addr = int(v.address);
      // 浮点分支：f32 / f64 恒有符号，binary 输出 IEEE 754 位模式。
      if (size === 'f4' || size === 'f8') {
        const width: 4 | 8 = size === 'f8' ? 8 : 4;
        if (!ctx.mem.contains(addr, width)) throw new Error(`读取越界：${hex(addr)} + ${width}`);
        const value = ctx.mem.readFloat(addr, width, ctx.endian);
        const raw = ctx.mem.readBig(addr, width, ctx.endian);
        const bitHex = `0x${raw.toString(16).toUpperCase().padStart(width * 2, '0')}`;
        const binary = raw.toString(2).padStart(width * 8, '0').replace(/(.{8})(?=.)/g, '$1 ');
        return { value, hex: bitHex, width, binary };
      }
      const width = [1, 2, 4, 8].includes(int(size, 4)) ? int(size, 4) : 4;
      const value = readInt(ctx, addr, width, ctx.params.signed === '1', ctx.endian);
      const bits = BigInt.asUintN(width * 8, BigInt(value)).toString(2).padStart(width * 8, '0');
      return {
        value, hex: hex(value), width,
        binary: bits.replace(/(.{8})(?=.)/g, '$1 '),
      };
    },
    detail: (_v, out) => `十进制  ${out.value}\n十六进制  ${out.hex}\n二进制  ${out.binary}`,
  },
  {
    id: 'text', label: '字符串读取', group: '解析', hint: '定长字符串或 C 字符串',
    inputs: [ctxPort(), numPort('address', '地址'), numPort('length', '最大长度')],
    outputs: [strPort('text', '文本'), numPort('length', '长度'), strPort('hex', '十六进制')],
    defaults: { address: '0x0', length: '64' },
    options: [
      select('mode', '结束方式', [['cstr', 'C 字符串 (\\0)'], ['fixed', '定长']], 'cstr'),
      select('encoding', '编码', [['ascii', 'ASCII / UTF-8'], ['utf16le', 'UTF-16LE'], ['utf16be', 'UTF-16BE']], 'ascii'),
    ],
    run: (v, ctx) => {
      // `length` is a maximum: a C string near the end of the file must not
      // turn into an out-of-bounds error.
      const addr = int(v.address);
      const available = Math.max(0, ctx.mem.end - addr);
      const raw = readBytes(ctx, addr, Math.min(int(v.length, 64), available));
      const enc = ctx.params.encoding ?? 'ascii';
      let text: string;
      if (enc === 'utf16le' || enc === 'utf16be') {
        const view = new DataView(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2) * 2);
        const parts: string[] = [];
        for (let i = 0; i + 1 < view.byteLength; i += 2) {
          const code = view.getUint16(i, enc === 'utf16le');
          if (code === 0 && ctx.params.mode !== 'fixed') break;
          parts.push(String.fromCharCode(code));
        }
        text = parts.join('');
      } else {
        text = ctx.params.mode === 'fixed' ? printable(raw).replace(/\.+$/, '') : cstr(raw);
      }
      return {
        text, length: text.length,
        hex: [...raw.subarray(0, Math.min(raw.length, text.length + 1))]
          .map((b) => b.toString(16).padStart(2, '0')).join(' ').slice(0, 512),
      };
    },
  },
  {
    id: 'arrayread', label: '数组读取', group: '解析', hint: '按步长连续读取整数数组',
    inputs: [ctxPort(), numPort('address', '地址'), numPort('count', '数量'), numPort('stride', '步长')],
    outputs: [numPort('count', '数量'), strPort('values', '值列表'), strPort('hex', '十六进制')],
    defaults: { address: '0x0', count: '8', stride: '4' },
    options: [SIZE_OPTION, SIGN_OPTION, ENDIAN_OPTION],
    run: (v, ctx) => {
      const width = [1, 2, 4, 8].includes(int(ctx.params.size, 4)) ? int(ctx.params.size, 4) : 4;
      const count = Math.max(0, Math.min(int(v.count, 8), 4096));
      const stride = int(v.stride, width) || width;
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        values.push(readInt(ctx, int(v.address) + i * stride, width, ctx.params.signed === '1', ctx.endian));
      }
      return {
        count: values.length,
        values: values.map((x) => String(x)).join(', ').slice(0, 512),
        hex: values.map((x) => hex(x)).join(' ').slice(0, 512),
      };
    },
    detail: (_v, out) => String(out.values ?? ''),
  },
  {
    id: 'expr', label: '表达式', group: '数值', hint: '算术与位表达式，变量 a / b / c',
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
    id: 'bitfield', label: '位域', group: '数值', hint: '按位展开、置位下标与置位数',
    inputs: [numPort('value', '值')],
    outputs: [strPort('binary', '二进制'), strPort('set', '置位下标'), numPort('popcount', '置位数'), numPort('lsb', '最低置位'), numPort('msb', '最高置位')],
    defaults: { value: '0' },
    options: [select('width', '位宽', [['8', '8'], ['16', '16'], ['32', '32'], ['64', '64']], '32')],
    run: (v, ctx) => {
      const width = [8, 16, 32, 64].includes(int(ctx.params.width, 32)) ? int(ctx.params.width, 32) : 32;
      const big = BigInt.asUintN(width, BigInt(int(v.value)));
      const set: number[] = [];
      let pop = 0;
      for (let i = 0; i < width; i++) {
        if ((big >> BigInt(i)) & 1n) { set.push(i); pop += 1; }
      }
      const lsb = set.length ? set[0] : -1;
      const msb = set.length ? set[set.length - 1] : -1;
      return {
        binary: big.toString(2).padStart(width, '0').replace(/(.{8})(?=.)/g, '$1 '),
        set: set.join(', '), popcount: pop, lsb, msb,
      };
    },
    detail: (_v, out) => String(out.binary ?? ''),
  },
  {
    id: 'enum', label: '枚举 / 标志', group: '数值', hint: '数值到名称的映射与置位标志',
    inputs: [numPort('value', '值')],
    outputs: [strPort('name', '名称'), strPort('flags', '标志'), { name: 'known', type: 'boolean', label: '已定义' }],
    defaults: { value: '0' },
    options: [{ key: 'mapping', label: '映射 (值=名称)', kind: 'text', default: '0=Flush,1=Write,2=Read,6=Identify' }],
    run: (v, ctx) => {
      const value = int(v.value);
      const entries = (ctx.params.mapping ?? '')
        .split(/[,;\n]/)
        .map((s) => /^\s*(0[xX][0-9a-fA-F]+|\d+)\s*=\s*(.+?)\s*$/.exec(s))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ value: Number(m[1]), name: m[2] }));
      const hit = entries.find((e) => e.value === value);
      const flags = entries.filter((e) => e.value !== 0 && (value & e.value) === e.value)
        .map((e) => e.name).join(' | ');
      return { name: hit?.name ?? `未知 (${hex(value)})`, flags: flags || '—', known: !!hit };
    },
  },
  {
    id: 'timestamp', label: '时间戳', group: '数值', hint: 'Unix 时间转 UTC 日历时间',
    inputs: [numPort('value', '时间戳')],
    outputs: [strPort('utc', 'UTC'), numPort('unix', '秒'), strPort('hex', '十六进制')],
    defaults: { value: '0' },
    options: [select('unit', '单位', [['s', '秒'], ['ms', '毫秒'], ['us', '微秒']], 's')],
    run: (v, ctx) => {
      const unit = ctx.params.unit ?? 's';
      const seconds = n(v.value) / (unit === 'us' ? 1e6 : unit === 'ms' ? 1e3 : 1);
      const d = new Date(seconds * 1000);
      const utc = Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '超出范围';
      return { utc, unix: Math.trunc(seconds), hex: hex(int(v.value)) };
    },
  },
  {
    id: 'address', label: '地址计算', group: '地址', hint: 'base + offset × scale',
    inputs: [numPort('base', '基址'), numPort('offset', '偏移'), numPort('scale', '比例')],
    outputs: [numPort('address', '地址'), strPort('hex', '十六进制')],
    defaults: { base: '0x0', offset: '0', scale: '1' },
    run: (v) => {
      const address = int(v.base) + int(v.offset) * int(v.scale, 1);
      return { address, hex: hex(address) };
    },
  },
  {
    id: 'ptrwalk', label: '指针步进', group: '地址', hint: '在 base+offset 处读出一个指针',
    inputs: [ctxPort(), numPort('base', '基址'), numPort('offset', '偏移')],
    outputs: [
      numPort('address', '读取地址'),
      numPort('target', '目标'),
      strPort('hex', '十六进制'),
      { name: 'valid', type: 'boolean', label: '范围有效' },
    ],
    defaults: { base: '0x0', offset: '0x0' },
    options: [select('pointerSize', '指针宽度', [['4', '4 字节'], ['8', '8 字节']], '8'), ENDIAN_OPTION],
    run: (v, ctx) => {
      needBuffer(ctx);
      const width: 4 | 8 = int(ctx.params.pointerSize, 8) === 4 ? 4 : 8;
      const addr = int(v.base) + int(v.offset);
      // 断链不中断求值：target 置 0 并把 valid 置 false，用户能看出断在哪一级。
      const ok = ctx.mem.contains(addr, width);
      const target = ok ? readInt(ctx, addr, width, false, ctx.endian) : 0;
      return {
        address: addr, target,
        hex: hex(target),
        valid: ok && ctx.mem.contains(target, 1),
      };
    },
    detail: (_v, out) => {
      const addr = Number(out.address ?? 0);
      const target = Number(out.target ?? 0);
      return `读取地址  ${hex(addr)}\n目标      ${out.valid ? hex(target) : '0x0（断链）'}`;
    },
  },
  {
    id: 'prp', label: 'PRP / 分散页', group: '地址', hint: '展开 NVMe PRP 列表及对应数据页',
    inputs: [ctxPort(), numPort('prp1', 'PRP1'), numPort('prp2', 'PRP2'), numPort('count', '页数')],
    outputs: [
      numPort('pages', '页数'), numPort('first', '首页'),
      numPort('p0', '页 0'), numPort('p1', '页 1'), numPort('p2', '页 2'), numPort('p3', '页 3'),
      strPort('list', '地址列表'),
    ],
    defaults: { prp1: '0x0', prp2: '0x0', count: '1' },
    options: [
      select('pageSize', '页大小', [['512', '512 B'], ['4096', '4 KiB']], '512'),
      select('pointerSize', 'PRP 宽度', [['4', '4 字节'], ['8', '8 字节']], '8'),
      ENDIAN_OPTION,
    ],
    run: (v, ctx) => {
      const wanted = Math.max(0, Math.min(int(v.count, 1), 512));
      const p1 = int(v.prp1);
      const p2 = int(v.prp2);
      const width: 4 | 8 = int(ctx.params.pointerSize, 8) === 4 ? 4 : 8;
      const list: number[] = [];
      if (wanted >= 1) list.push(p1);
      if (wanted === 2) {
        list.push(p2);
      } else if (wanted > 2 && p2) {
        for (let i = 0; i < wanted - 1; i++) {
          list.push(readInt(ctx, p2 + i * width, width, false, ctx.endian));
        }
      }
      const out: Record<string, unknown> = {
        pages: list.length,
        first: list[0] ?? 0,
        list: list.map((a) => hex(a)).join('  '),
      };
      for (let i = 0; i < 4; i++) out[`p${i}`] = list[i] ?? 0;
      return out;
    },
    detail: (_v, out, ctx) => {
      const list = String(out.list ?? '').split(/\s+/).filter(Boolean);
      const size = int(ctx.params.pageSize, 512);
      return list.map((text, i) => {
        const addr = Number(text);
        let head = '缓冲区外';
        let data = '—';
        try {
          const bytes = readBytes(ctx, addr, Math.min(16, size));
          head = `${hexCells(bytes, 16)} |${printable(bytes)}|`;
          const payload = readBytes(ctx, addr + 16, Math.min(48, size - 16));
          data = cstr(payload).slice(0, 44) || '—';
        } catch { /* 地址落在缓冲区外时保留占位标记 */ }
        return `页 ${i}  ${text.padEnd(12)}  ${head}\n          ↳ ${data}`;
      }).join('\n');
    },
  },
  {
    id: 'checksum', label: '校验和', group: '校验', hint: 'CRC32 / 累加和 / FNV-1a',
    inputs: [ctxPort(), numPort('address', '地址'), numPort('length', '长度')],
    outputs: [numPort('crc32', 'CRC32'), numPort('sum', '累加和'), numPort('fnv1a', 'FNV-1a'), strPort('hex', 'CRC32 十六进制')],
    defaults: { address: '0x0', length: '64' },
    run: (v, ctx) => {
      const bytes = readBytes(ctx, int(v.address), int(v.length, 64));
      const crc = crc32(bytes);
      return { crc32: crc, sum: sum8(bytes), fnv1a: fnv1a(bytes), hex: hexN(crc, 8) };
    },
    detail: (_v, out) => `CRC32     ${out.hex}\n累加和    ${out.sum}\nFNV-1a    0x${Number(out.fnv1a).toString(16)}`,
  },
  {
    id: 'compare', label: '数值比较', group: '校验', hint: '相等 / 大小 / 差值',
    inputs: [numPort('a', 'a'), numPort('b', 'b')],
    outputs: [
      { name: 'equal', type: 'boolean', label: '相等' },
      { name: 'greater', type: 'boolean', label: 'a > b' },
      { name: 'less', type: 'boolean', label: 'a < b' },
      numPort('delta', '差值'),
    ],
    defaults: { a: '0', b: '0' },
    run: (v) => {
      const a = n(v.a);
      const b = n(v.b);
      return { equal: a === b, greater: a > b, less: a < b, delta: a - b };
    },
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
): BuiltinCtx {
  return {
    buffer,
    mem: new Memory(buffer?.bytes ?? new Uint8Array(0), buffer?.base ?? 0),
    params,
    endian: params.endian === 'big' ? 'big' : 'little',
    pointerSize: params.pointerSize === '4' ? 4 : 8,
    sourceNote,
  };
}
