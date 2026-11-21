import type { Endian } from '../core/types';
import { fieldSize, type FieldDef, type TypeDef } from '../core/pack';
import { decodeFieldRaw, formatPackValue, packMemApi } from '../core/packgraph';
import { Memory } from '../core/mem';
import { checkedBytes, ReadIssue, scalarRead } from './binary-read';
import { addressHex, mappedAddress } from './precision';
import { brandInstance, type BlueprintPack, type BufferValue, type FieldView, type InstanceView, type PortSpec, type PortType } from './types';

export const SCALARS = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'] as const;
export const LAYOUT_FIELD_TYPES = [...SCALARS, 'bytes', 'string', 'bits', 'record', 'array'] as const;
export type ScalarType = typeof SCALARS[number];
export type LayoutKind = typeof LAYOUT_FIELD_TYPES[number];
export const MAX_LAYOUT_BYTES = 1 << 20;
export const MAX_LAYOUT_FIELDS = 128;
export const MAX_LAYOUTS = 512;
export const MAX_FIELD_BYTES = 8 << 20;

/** Plain document data: numeric inputs are stored as text and validated before reads. */
export interface LayoutField {
  id: string;
  name: string;
  kind: LayoutKind;
  /** byte offset anchor; omitted = current cursor */
  at?: string;
  /** bytes/string length */
  size?: string;
  /** array element count */
  count?: string;
  /** record / array target: layout/<id> or a scalar kind for arrays */
  of?: string;
  endian?: Endian;
  /** bits storage unit in bytes */
  unit?: string;
  /** bits offset inside the unit */
  bit?: string;
  /** bits width */
  width?: string;
  /** numeric value → display label */
  values?: Record<string, string>;
  role?: 'address' | 'offset' | 'index';
}

export interface BinaryLayout {
  id: string;
  name: string;
  endian: Endian;
  fields: LayoutField[];
  /** optional total length override; derived from the cursor when omitted */
  size?: string;
  /** fields share byte offsets; overlaps are allowed */
  union?: boolean;
}

export function layoutIdValid(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

const isText = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

export function validLayoutDocument(value: unknown): value is BinaryLayout[] {
  if (!Array.isArray(value) || value.length > MAX_LAYOUTS) return false;
  const used = new Set<string>();
  return value.every((v) => {
    const l = v as Partial<BinaryLayout> | null;
    if (!l || !layoutIdValid(l.id) || used.has(l.id) || typeof l.name !== 'string'
      || !['little', 'big'].includes(l.endian ?? '') || !isText(l.size) || (l.union !== undefined && typeof l.union !== 'boolean')
      || !Array.isArray(l.fields) || l.fields.length > MAX_LAYOUT_FIELDS) return false;
    used.add(l.id);
    const ids = new Set<string>();
    return l.fields.every((f) => {
      if (!f || !layoutIdValid(f.id) || ids.has(f.id) || typeof f.name !== 'string'
        || !LAYOUT_FIELD_TYPES.includes(f.kind)) return false;
      ids.add(f.id);
      return [f.at, f.size, f.count, f.of, f.unit, f.bit, f.width].every(isText)
        && (f.endian === undefined || ['little', 'big'].includes(f.endian))
        && (f.role === undefined || ['address', 'offset', 'index'].includes(f.role))
        && (f.values === undefined || (typeof f.values === 'object' && f.values !== null
          && Object.values(f.values).every((x) => typeof x === 'string')));
    });
  });
}

export const fieldPort = (structureId: string, id: string) => `field:${structureId}:${id}`;

export function layoutFieldType(field: LayoutField): PortType {
  if (field.kind === 'bytes' || field.kind === 'string') return field.kind;
  if (field.kind === 'record') return 'instance';
  if (field.kind === 'array') return 'list';
  if (field.kind.startsWith('f')) return 'number';
  return field.role ?? 'integer';
}

export function layoutPorts(layout?: BinaryLayout): PortSpec[] {
  if (!layout) return [];
  const structureId = `layout/${layout.id}`;
  return layout.fields.map(f => ({
    name: fieldPort(structureId, f.id),
    label: f.name || '未命名字段',
    type: layoutFieldType(f),
  }));
}

export interface CompiledLayout {
  layout: BinaryLayout;
  type: TypeDef;
  size: number;
}

export type LayoutResolver = (id: string) => BinaryLayout | undefined;

function resolveNested(of: string | undefined, resolve?: LayoutResolver): BinaryLayout | undefined {
  if (!of) return undefined;
  const id = of.startsWith('layout/') ? of.slice('layout/'.length) : of;
  return resolve?.(id);
}

function layoutFieldRaw(layout: BinaryLayout, f: LayoutField): LayoutField {
  return { ...f, endian: f.endian ?? layout.endian };
}

export type LayoutProblemSeverity = 'error' | 'warning';

export interface LayoutProblem {
  severity: LayoutProblemSeverity;
  code: string;
  message: string;
  layoutId: string;
  layoutName: string;
  fieldId?: string;
  fieldName?: string;
}

export interface PositionedField {
  id: string;
  name: string;
  kind: LayoutKind;
  offset: number;
  size: number;
  auto: boolean;
  /** 原始锚定文本；undefined/'' 表示自动排布 */
  at?: string;
  field: LayoutField;
  bits?: { offset: number; width: number; unit: number };
  count?: number;
  of?: string;
  ofType?: TypeDef;
  endian: Endian;
  values?: Record<string, string>;
  role?: LayoutField['role'];
}

export interface LayoutSpan {
  start: number;
  end: number;
  fieldId?: string;
  name: string;
  bits?: boolean;
  groupKey?: string;
}

export interface BitOverlap {
  a: string;
  b: string;
  aName: string;
  bName: string;
  from: number;
  to: number;
}

export interface LayoutBitGroup {
  key: string;
  offset: number;
  unit: number;
  members: PositionedField[];
  used: number;
  free: number;
  overlapIds: Set<string>;
  overlapPairs: number;
}

export interface LayoutBuild {
  layout: BinaryLayout;
  type: TypeDef;
  size: number;
  cursor: number;
  fields: PositionedField[];
  spans: LayoutSpan[];
  bitGroups: LayoutBitGroup[];
  free: LayoutSpan[];
  byteOverlaps: Array<[LayoutSpan, LayoutSpan]>;
  bitOverlaps: BitOverlap[];
  problems: LayoutProblem[];
}

export interface LayoutAnalysis {
  builds: Map<string, LayoutBuild>;
  problems: LayoutProblem[];
}

interface BuildOptions {
  collect: boolean;
  preview?: boolean;
  stack?: Set<string>;
  /** compileLayout needs the child's exact first error; analyzeLayouts only needs a summary. */
  includeChildProblems?: boolean;
}

const BIT_UNITS = [1, 2, 4, 8] as const;
const SCALAR_LAYOUT_KINDS = new Set<string>(SCALARS);

function pushProblem(
  problems: LayoutProblem[], layout: BinaryLayout, code: string, message: string,
  field?: LayoutField, severity: LayoutProblemSeverity = 'error',
): void {
  problems.push({
    severity, code, message, layoutId: layout.id, layoutName: layout.name,
    ...(field ? { fieldId: field.id, fieldName: field.name } : {}),
  });
}

function parseOptionalInt(
  raw: string | undefined, label: string, min: number, max: number,
  problems: LayoutProblem[], layout: BinaryLayout, field?: LayoutField,
): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    pushProblem(problems, layout, 'BAD_NUMBER', `${label}：需要 ${min}–${max} 内的整数`, field);
    return undefined;
  }
  return n;
}

/** Silent numeric read used only to decide bit-group membership; problems are reported later. */
function intOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseIntOr(
  raw: string | undefined, label: string, min: number, max: number, fallback: number,
  problems: LayoutProblem[], layout: BinaryLayout, field?: LayoutField,
): number {
  return parseOptionalInt(raw, label, min, max, problems, layout, field) ?? fallback;
}

function childBuild(
  target: BinaryLayout, resolve: LayoutResolver | undefined, options: BuildOptions,
  problems: LayoutProblem[], layout: BinaryLayout, field: LayoutField, display: string,
): LayoutBuild | undefined {
  if (!target) {
    pushProblem(problems, layout, 'MISSING_LAYOUT',
      `字段「${display}」引用的布局不存在：${field.of ?? '?'}`, field);
    return undefined;
  }
  if (options.stack?.has(target.id)) {
    pushProblem(problems, layout, 'CYCLE', `布局 ${target.name} 存在循环引用`, field);
    return undefined;
  }
  const child = buildLayout(target, resolve, {
    ...options,
    collect: true,
    stack: options.stack,
  });
  const childErrors = child.problems.filter(p => p.severity === 'error');
  if (childErrors.length) {
    if (options.includeChildProblems) {
      problems.push(...childErrors);
    } else if (childErrors.some(p => p.code === 'CYCLE')) {
      pushProblem(problems, layout, 'CYCLE',
        `字段「${display}」引用的布局「${target.name}」存在循环引用`, field);
    } else {
      pushProblem(problems, layout, 'NESTED_INVALID',
        `字段「${display}」引用的布局「${target.name}」无效：${childErrors[0].message}`, field);
    }
  }
  return child;
}

function fieldType(f: PositionedField): FieldDef {
  return {
    name: f.id,
    label: f.name,
    kind: f.kind,
    offset: f.offset,
    size: f.size,
    ...(f.bits ? { bits: { offset: f.bits.offset, width: f.bits.width, unit: f.bits.unit } } : {}),
    ...(f.count !== undefined ? { count: f.count } : {}),
    ...(f.of ? { of: f.of } : {}),
    ...(f.ofType ? { ofType: f.ofType } : {}),
    endian: f.endian,
    ...(f.values ? { values: f.values } : {}),
    ...(f.role ? { role: f.role } : {}),
  };
}

/**
 * One geometry authority. `collect` mode returns diagnostics instead of
 * throwing; preview mode keeps best-effort offsets so a drag can show where a
 * field would land even when the candidate is invalid.
 */
export function buildLayout(
  layout: BinaryLayout,
  resolve?: LayoutResolver,
  options: BuildOptions = { collect: true, preview: false, stack: new Set<string>() },
): LayoutBuild {
  const problems: LayoutProblem[] = [];
  const stack = options.stack ?? new Set<string>();
  if (!layout.name.trim()) {
    pushProblem(problems, layout, 'LAYOUT_NAME', '请填写布局名称');
  }
  if (stack.has(layout.id)) {
    pushProblem(problems, layout, 'CYCLE', `布局 ${layout.name} 存在循环引用`);
    return {
      layout, size: 0, cursor: 0, fields: [], spans: [], bitGroups: [], free: [],
      byteOverlaps: [], bitOverlaps: [], problems,
      type: { name: layout.name, size: 0, union: layout.union, fields: [] },
    };
  }
  const nextStack = new Set(stack);
  nextStack.add(layout.id);
  const names = new Set<string>();
  const fields: PositionedField[] = [];
  let cursor = 0;

  if (!layout.fields.length) {
    pushProblem(problems, layout, 'EMPTY_LAYOUT', '布局还没有字段', undefined, 'warning');
  }

  for (let i = 0; i < layout.fields.length; i += 1) {
    const raw = layoutFieldRaw(layout, layout.fields[i]);
    const display = raw.name.trim() || raw.id;
    if (!raw.name.trim() || names.has(raw.name.trim())) {
      pushProblem(problems, layout, 'FIELD_NAME',
        `字段名称为空或重复：${display}`, raw);
    }
    names.add(raw.name.trim());

    if (raw.kind === 'bits') {
      const group: LayoutField[] = [raw];
      const groupStart = intOrUndefined(raw.at);
      let groupUnit = intOrUndefined(raw.unit);
      let j = i + 1;
      // Join consecutive bit fields that share the same storage slot. Explicit
      // units are allowed on every member: designer-authored groups keep them
      // on all fields, while imported declarations only set the first one.
      while (j < layout.fields.length) {
        const next = layout.fields[j];
        if (next.kind !== 'bits') break;
        const nextAt = intOrUndefined(next.at);
        if (nextAt !== undefined && nextAt !== (groupStart ?? (layout.union ? 0 : cursor))) break;
        const nextUnit = intOrUndefined(next.unit);
        if (nextUnit !== undefined) {
          if (groupUnit !== undefined && nextUnit !== groupUnit) break;
          groupUnit = nextUnit;
        }
        group.push(next);
        j += 1;
      }
      const first = group[0];
      const firstOffset = parseOptionalInt(first.at, `${display} 的偏移`, 0, MAX_LAYOUT_BYTES, problems, layout, first);
      const start = firstOffset ?? (layout.union ? 0 : cursor);
      let used = 0;
      for (const b of group) {
        const width = parseIntOr(b.width, `${b.name} 的位宽`, 1, 64, 1, problems, layout, b);
        const bit = parseIntOr(b.bit, `${b.name} 的位偏移`, 0, 63, 0, problems, layout, b);
        used = Math.max(used, bit + width);
      }
      const explicitField = group.find(b => b.unit !== undefined && String(b.unit).trim() !== '');
      const explicitRaw = explicitField?.unit;
      let unit = parseOptionalInt(explicitRaw, `${display} 的存储宽度`, 1, 8, problems, layout, explicitField);
      if (unit !== undefined && !BIT_UNITS.includes(unit as 1 | 2 | 4 | 8)) {
        pushProblem(problems, layout, 'BIT_UNIT', `${display} 的存储宽度应为 1、2、4 或 8 字节`, explicitField);
        unit = undefined;
      }
      if (!unit) {
        unit = BIT_UNITS.find(u => used <= u * 8);
        if (!unit) {
          pushProblem(problems, layout, 'BIT_OVERFLOW', `位组需要 ${used} 位，超过 64 位`, first);
          unit = 8;
        }
      }
      if (used > unit * 8) {
        pushProblem(problems, layout, 'BIT_OVERFLOW', `位组需要 ${used} 位，超过 ${unit} 字节`, first);
      }
      for (const b of group) {
        const width = parseIntOr(b.width, `${b.name} 的位宽`, 1, 64, 1, problems, layout, b);
        const bit = parseIntOr(b.bit, `${b.name} 的位偏移`, 0, 63, 0, problems, layout, b);
        fields.push({
          id: b.id, name: b.name.trim() || b.id, kind: 'bits', offset: start, size: unit,
          auto: b.at === undefined || b.at === '', at: b.at, field: b,
          bits: { offset: bit, width, unit }, endian: b.endian ?? layout.endian,
          values: b.values, role: b.role,
        });
      }
      cursor = Math.max(cursor, start + unit);
      i = j - 1;
      continue;
    }

    const kind = raw.kind as LayoutKind;
    let size = 0;
    let of: string | undefined;
    let count: number | undefined;
    let ofType: TypeDef | undefined;
    if (raw.kind === 'record') {
      const target = resolveNested(raw.of, resolve);
      if (!target) {
        pushProblem(problems, layout, 'MISSING_LAYOUT',
          `字段「${display}」引用的布局不存在：${raw.of ?? '?'}`, raw);
      } else {
        const child = childBuild(target, resolve, { ...options, stack: nextStack }, problems, layout, raw, display);
        if (child) { size = child.size; ofType = child.type; }
      }
      of = raw.of;
    } else if (raw.kind === 'array') {
      count = parseIntOr(raw.count, `${display} 的数量`, 1, 1 << 20, 1, problems, layout, raw);
      const target = resolveNested(raw.of, resolve);
      if (target) {
        const child = childBuild(target, resolve, { ...options, stack: nextStack }, problems, layout, raw, display);
        if (child) { size = child.size * count; ofType = child.type; }
        of = raw.of;
      } else if (raw.of && SCALAR_LAYOUT_KINDS.has(raw.of)) {
        size = (Number(raw.of.slice(1)) / 8) * count;
        of = raw.of;
      } else {
        pushProblem(problems, layout, 'BAD_ARRAY', `字段「${display}」的数组元素类型无效：${raw.of ?? '?'}`, raw);
      }
    } else if (raw.kind === 'string' || raw.kind === 'bytes') {
      size = parseIntOr(raw.size, `${display} 的长度`, 1, MAX_FIELD_BYTES, 1, problems, layout, raw);
    } else {
      size = Number(raw.kind.slice(1)) / 8;
      if (!Number.isFinite(size) || size <= 0) {
        pushProblem(problems, layout, 'BAD_SIZE', `字段「${display}」的大小非法`, raw);
        size = 1;
      }
    }

    const at = parseOptionalInt(raw.at, `${display} 的偏移`, 0, MAX_LAYOUT_BYTES, problems, layout, raw);
    const start = at ?? (layout.union ? 0 : cursor);
    if (!Number.isFinite(size) || size < 0 || size > MAX_LAYOUT_BYTES) {
      pushProblem(problems, layout, 'FIELD_TOO_LARGE',
        `字段「${display}」的大小 ${size} 超出布局上限 ${MAX_LAYOUT_BYTES} B`, raw);
      size = Number.isFinite(size) ? Math.max(0, Math.min(MAX_LAYOUT_BYTES, size)) : 0;
    }
    fields.push({
      id: raw.id, name: raw.name.trim() || raw.id, kind, offset: start, size,
      auto: raw.at === undefined || raw.at === '', at: raw.at, field: raw,
      ...(count !== undefined ? { count } : {}),
      ...(of ? { of } : {}),
      ...(ofType ? { ofType } : {}),
      endian: raw.endian ?? layout.endian,
      values: raw.values, role: raw.role,
    });
    cursor = Math.max(cursor, start + size);
  }

  const readBytes = fields.reduce((n, f) => n + Math.max(0, f.size), 0);
  if (readBytes > MAX_FIELD_BYTES) {
    pushProblem(problems, layout, 'READ_BUDGET',
      `字段总读取量 ${readBytes} B 超出预算 ${MAX_FIELD_BYTES} B`);
  }

  // Group bit members by storage unit; this is also the byte-occupancy span.
  const bitMap = new Map<string, LayoutBitGroup>();
  for (const f of fields) {
    if (f.kind !== 'bits' || !f.bits) continue;
    const key = `${f.offset}:${f.bits.unit}`;
    if (!bitMap.has(key)) {
      bitMap.set(key, {
        key, offset: f.offset, unit: f.bits.unit, members: [], used: 0, free: 0,
        overlapIds: new Set(), overlapPairs: 0,
      });
    }
    bitMap.get(key)!.members.push(f);
  }
  const bitGroups = Array.from(bitMap.values()).sort((a, b) => a.offset - b.offset || a.unit - b.unit);
  const bitOverlaps: BitOverlap[] = [];
  for (const group of bitGroups) {
    group.members.sort((a, b) => (a.bits?.offset ?? 0) - (b.bits?.offset ?? 0));
    const usedBits = new Set<number>();
    for (const member of group.members) {
      const bit = member.bits?.offset ?? 0;
      const width = member.bits?.width ?? 1;
      for (let n = bit; n < bit + width; n += 1) usedBits.add(n);
      for (const other of group.members) {
        if (other.id === member.id) continue;
        const otherBit = other.bits?.offset ?? 0;
        const otherWidth = other.bits?.width ?? 1;
        if (member.id > other.id) continue;
        const from = Math.max(bit, otherBit);
        const to = Math.min(bit + width, otherBit + otherWidth);
        if (from < to) {
          group.overlapIds.add(member.id);
          group.overlapIds.add(other.id);
          group.overlapPairs += 1;
          bitOverlaps.push({
            a: member.id, b: other.id, aName: member.name, bName: other.name,
            from, to: to - 1,
          });
          pushProblem(problems, layout, 'BIT_OVERLAP',
            `位域重叠：${member.name} / ${other.name}（bit ${from}–${to - 1}）`, member.field);
        }
      }
    }
    group.used = usedBits.size;
    group.free = Math.max(0, group.unit * 8 - group.used);
  }

  const spans: LayoutSpan[] = [
    ...fields.filter(f => f.kind !== 'bits' && f.size > 0).map(f => ({
      start: f.offset, end: f.offset + f.size, fieldId: f.id, name: f.name,
    })),
    ...bitGroups.map(g => ({
      start: g.offset, end: g.offset + g.unit, name: g.members.map(m => m.name).join(' / '),
      bits: true, groupKey: g.key,
    })),
  ];

  const byteOverlaps: Array<[LayoutSpan, LayoutSpan]> = [];
  if (!layout.union) {
    const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    // Compare against every earlier span, not only the immediate neighbour:
    // a long field that contains a short one can still overlap later fields.
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (ordered[i].start < ordered[j].end) {
          byteOverlaps.push([ordered[j], ordered[i]]);
          pushProblem(problems, layout, 'OVERLAP',
            `字段重叠：${ordered[j].name} / ${ordered[i].name}`);
        }
      }
    }
  }

  const explicitSize = parseOptionalInt(
    layout.size, '结构长度', 1, MAX_LAYOUT_BYTES, problems, layout,
  );
  const contentEnd = cursor;
  let total = explicitSize ?? contentEnd;
  if (explicitSize !== undefined && explicitSize < contentEnd) {
    pushProblem(problems, layout, 'LENGTH_TOO_SMALL',
      `结构长度 ${explicitSize} 小于字段结束位置 ${contentEnd}`);
    total = contentEnd;
  }
  if (contentEnd > MAX_LAYOUT_BYTES || total > MAX_LAYOUT_BYTES) {
    pushProblem(problems, layout, 'LAYOUT_TOO_LARGE',
      `布局长度 ${Math.max(total, contentEnd)} 超过上限 ${MAX_LAYOUT_BYTES} B`);
    total = MAX_LAYOUT_BYTES;
  }
  if (layout.size !== undefined && layout.size.trim() !== '') {
    pushProblem(problems, layout, 'LENGTH_OVERRIDE', '布局使用显式长度覆盖', undefined, 'warning');
  }

  // Merge occupied byte ranges instead of marking every byte; this keeps
  // diagnostics fast even when a layout carries a large array or an invalid
  // field size (which is reported above and clamped for display).
  const occupied: Array<[number, number]> = spans
    .map((span) => [
      Math.max(0, Math.floor(span.start)),
      Math.min(total, Math.ceil(span.end)),
    ] as [number, number])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const free: LayoutSpan[] = [];
  let occupiedEnd = 0;
  for (const [start, end] of occupied) {
    if (start > occupiedEnd) free.push({ start: occupiedEnd, end: start, name: '空闲' });
    occupiedEnd = Math.max(occupiedEnd, end);
  }
  if (occupiedEnd < total) free.push({ start: occupiedEnd, end: total, name: '空闲' });

  const type: TypeDef = {
    name: layout.name,
    size: Math.max(0, total),
    union: layout.union,
    fields: fields.map(fieldType),
  };
  return { layout, type, size: Math.max(0, total), cursor, fields, spans, bitGroups, free, byteOverlaps, bitOverlaps, problems };
}

export function compileLayout(
  layout?: BinaryLayout,
  resolve?: LayoutResolver,
  stack: Set<string> = new Set(),
): CompiledLayout {
  if (!layout) throw new ReadIssue('INVALID_LAYOUT', '请选择有效的结构布局');
  if (!layout.name.trim()) throw new ReadIssue('INVALID_LAYOUT', '请填写布局名称');
  if (stack.has(layout.id)) throw new ReadIssue('INVALID_LAYOUT', `布局 ${layout.name} 存在循环引用`);
  const build = buildLayout(layout, resolve, {
    collect: false, preview: false, stack, includeChildProblems: true,
  });
  const first = build.problems.find(p => p.severity === 'error');
  if (first) throw new ReadIssue('INVALID_LAYOUT', first.message);
  return { layout, type: build.type, size: build.size };
}

/** Best-effort geometry for drag preview; never throws for user data. */
export function measureLayout(layout: BinaryLayout, resolve?: LayoutResolver): LayoutBuild {
  return buildLayout(layout, resolve, {
    collect: true, preview: true, stack: new Set<string>(), includeChildProblems: false,
  });
}

/** Collect all layout diagnostics with the same builder used by compileLayout. */
export function analyzeLayouts(layouts: readonly BinaryLayout[]): LayoutAnalysis {
  const map = new Map(layouts.map(l => [l.id, l]));
  const builds = new Map<string, LayoutBuild>();
  for (const layout of layouts) {
    builds.set(layout.id, buildLayout(layout, id => map.get(id), {
      collect: true, preview: false, stack: new Set<string>(), includeChildProblems: false,
    }));
  }
  return {
    builds,
    problems: Array.from(builds.values()).flatMap(b => b.problems),
  };
}

function displayValue(f: FieldDef, value: unknown): string {
  if (typeof value === 'number' && f.values?.[String(value)] !== undefined) return f.values[String(value)];
  if (typeof value === 'bigint' && f.values?.[value.toString()] !== undefined) return f.values[value.toString()];
  if (typeof value === 'bigint') return value.toString();
  return formatPackValue(f, value);
}

function readScalarField(src: BufferValue, at: bigint, f: FieldDef, defaultEndian: Endian): unknown {
  const kind = f.kind;
  const endian = f.endian ?? defaultEndian;
  if (/^(?:[ui](?:8|16|32|64)|f(?:32|64))$/.test(kind)) return scalarRead(src, at, kind, endian).value;
  if (kind === 'bits') {
    const unit = f.bits?.unit ?? f.size ?? 1;
    const raw = scalarRead(src, at, `u${unit * 8}`, endian).raw;
    const width = f.bits?.width ?? 1;
    const offset = f.bits?.offset ?? 0;
    // Big-endian bit offsets count from the most significant bit, matching
    // decodeFieldRaw in packgraph; little-endian counts from the LSB.
    const shift = endian === 'little' ? offset : unit * 8 - offset - width;
    let v = (raw >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
    if (f.bits?.signed && v >= (1n << BigInt(width - 1))) v -= 1n << BigInt(width);
    return v;
  }
  if (kind === 'bool') return checkedBytes(src, at, 1)[0] !== 0;
  if (kind === 'char') return String.fromCharCode(checkedBytes(src, at, 1)[0]);
  return undefined;
}

interface ReadOptions {
  /** Only document layouts use stable field ids as port names. */
  layoutSource: boolean;
  pack?: BlueprintPack;
  packEndian?: Endian;
}

function decodeStruct(
  src: BufferValue,
  at: bigint,
  type: TypeDef,
  structureId: string,
  index: number | undefined,
  depth: number,
  opts: ReadOptions,
): InstanceView {
  if (depth > 32) throw new ReadIssue('READ_LIMIT', '嵌套结构超过深度上限', at);
  const mem = new Memory(src.bytes, 0);
  const localBase = BigInt(src.base);
  const compatible = {
    name: opts.pack?.name ?? type.name,
    endian: opts.pack?.endian ?? 'little' as Endian,
    pointerSize: opts.pack?.pointerSize ?? 4 as const,
    constants: opts.pack?.constants ?? {},
    types: [type, ...(opts.pack ? Object.values(opts.pack.types) : [])],
    roots: [],
  };
  const rawValues: Record<string, unknown> = {};
  const defaultEndian = opts.pack?.endian ?? 'little';
  for (const f of type.fields) {
    const fieldAddr = at + BigInt(f.offset ?? 0);
    const direct = readScalarField(src, fieldAddr, f, defaultEndian);
    rawValues[f.name] = direct !== undefined
      ? direct
      : decodeFieldRaw(mem, compatible, type, { ...f, offset: 0 }, Number(fieldAddr - localBase));
  }
  const fields: FieldView[] = type.fields.map((f) => {
    const fieldAddr = at + BigInt(f.offset ?? 0);
    const valueSize = fieldSize(f, compatible);
    let raw: unknown = rawValues[f.name];
    let value: unknown = raw;
    if (f.kind === 'record' && f.ofType) {
      value = decodeStruct(src, fieldAddr, f.ofType, f.of ?? structureId, undefined, depth + 1, opts);
      raw = decodeFieldRaw(mem, compatible, type, { ...f, offset: 0 }, Number(fieldAddr - localBase));
    } else if (f.kind === 'array') {
      const n = f.count ?? 0;
      if (f.ofType) {
        const stride = f.ofType.size;
        const items: InstanceView[] = [];
        for (let i = 0; i < n; i += 1) {
          items.push(decodeStruct(src, fieldAddr + BigInt(i * stride), f.ofType, f.of ?? structureId, i, depth + 1, opts));
        }
        raw = items.map(x => x.fields.reduce<Record<string, unknown>>((o, q) => { o[q.name] = q.value; return o; }, {}));
        value = items;
      } else {
        const items: unknown[] = [];
        const elemKind = f.of ?? 'u8';
        const elemSize = elemKind === 'ptr'
          ? (opts.pack?.pointerSize ?? 4)
          : Number(elemKind.slice(1)) / 8 || 1;
        for (let i = 0; i < n; i += 1) {
          const item = readScalarField(src, fieldAddr + BigInt(i * elemSize), {
            ...f, kind: elemKind as FieldDef['kind'], offset: 0, ofType: undefined, of: elemKind,
          }, defaultEndian) ?? decodeFieldRaw(mem, compatible, type, {
            ...f, kind: elemKind as FieldDef['kind'], offset: 0, ofType: undefined, of: elemKind,
          }, Number(fieldAddr + BigInt(i * elemSize) - localBase));
          items.push(item);
        }
        raw = items;
        value = items;
      }
    } else if (f.transform && opts.pack) {
      try {
        value = f.transform(raw, {
          v: raw, addr: Number(fieldAddr), self: rawValues, mem: packMemApi(mem),
          consts: opts.pack.constants, type: type.name, field: f.name,
        });
      } catch (e) {
        value = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const portType = f.kind === 'record' ? 'instance'
      : f.kind === 'array' ? 'list'
        : f.kind === 'string' ? 'string'
          : f.kind === 'bytes' ? 'bytes'
            : f.kind === 'bool' ? 'boolean'
              : f.role ?? (f.kind === 'ptr' ? 'pack-address' : 'integer');
    return {
      name: opts.layoutSource ? fieldPort(structureId, f.name) : f.name,
      label: f.label ?? f.name,
      kind: f.kind,
      type: f.kind === 'record' || f.kind === 'array' ? (f.of ?? f.kind) : f.kind,
      portType,
      offset: f.offset ?? 0,
      size: valueSize,
      raw,
      value,
      rawDisplay: displayValue(f, raw),
      display: f.kind === 'record' ? `@${addressHex(fieldAddr)}`
        : f.kind === 'array' ? `[${f.count ?? 0}]` : displayValue(f, value),
    };
  });
  return brandInstance({
    addr: 0, location: mappedAddress(src, at),
    layoutId: opts.layoutSource ? structureId : undefined,
    typeName: type.name, index, size: type.size, fields, mem,
  });
}

export function readLayout(
  src: BufferValue,
  at: bigint,
  spec: CompiledLayout,
  index?: number,
): InstanceView {
  checkedBytes(src, at, spec.size);
  return decodeStruct(src, at, spec.type, `layout/${spec.layout.id}`, index, 0, { layoutSource: true });
}

/** Decode a pack type through the same recursive path, including transforms. */
export function readTypeStructure(
  src: BufferValue,
  at: bigint,
  type: TypeDef,
  structureId: string,
  pack: BlueprintPack,
  index?: number,
): InstanceView {
  checkedBytes(src, at, type.size);
  return decodeStruct(src, at, type, structureId, index, 0, { layoutSource: false, pack });
}

export function readScalarItem(src: BufferValue, at: bigint, kind: string, endian: Endian, index: number): InstanceView {
  const { value, width } = scalarReadCompat(src, at, kind, endian);
  const type = typeof value === 'number' ? 'number' : 'integer';
  return brandInstance({
    addr: 0, location: mappedAddress(src, at), index, typeName: kind, size: width,
    mem: new Memory(checkedBytes(src, at, width)),
    fields: [{
      name: 'value', label: '值', type: kind, kind: kind as ScalarType, portType: type,
      offset: 0, size: width, raw: value, value, rawDisplay: displayField(value), display: displayField(value),
    }],
  });
}

function scalarReadCompat(src: BufferValue, at: bigint, kind: string, endian: Endian): { value: number | bigint; width: number } {
  const width = Number(kind.slice(1)) / 8;
  const bytes = checkedBytes(src, at, width);
  let raw = 0n;
  for (let i = 0; i < width; i++) raw = (raw << 8n) | BigInt(bytes[endian === 'little' ? width - i - 1 : i]);
  if (kind.startsWith('f')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, width);
    return { value: width === 4 ? view.getFloat32(0, endian === 'little') : view.getFloat64(0, endian === 'little'), width };
  }
  return { value: kind.startsWith('i') ? BigInt.asIntN(width * 8, raw) : raw, width };
}

export function displayField(value: unknown): string {
  if (value instanceof Uint8Array) return [...value.subarray(0, 24)].map(b => b.toString(16).padStart(2, '0')).join(' ')
    + (value.length > 24 ? ` … (${value.length} B)` : '');
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return String(value ?? '∅');
}
