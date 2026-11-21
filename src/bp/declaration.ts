/**
 * Pure C-like declaration importer. It never executes input. The supported
 * subset is intentionally small: struct/union/typedef, fixed arrays, bitfields,
 * comments, explicit-width enums, existing-layout references and nested
 * anonymous struct/union definitions. Packing is compact; the user can add
 * `at` anchors afterwards.
 */

import type { Endian } from '../core/types';
import type { BinaryLayout, LayoutField, LayoutKind } from './layouts';

export interface DeclarationProblem {
  line: number;
  column: number;
  message: string;
}

export interface DeclarationResult {
  layouts: BinaryLayout[];
  problems: DeclarationProblem[];
}

interface Token { kind: 'id' | 'num' | 'punct'; value: string; line: number; column: number }
interface ParsedField {
  name: string;
  typeName?: string;
  scalar?: LayoutKind;
  pointer?: boolean;
  charType?: boolean;
  array?: number;
  bits?: number;
  nested?: ParsedType;
  enumValues?: Record<string, string>;
  line: number;
}
interface ParsedType {
  name: string;
  union: boolean;
  fields: ParsedField[];
  line: number;
  anonymous?: boolean;
}
interface EnumDef {
  name: string;
  kind: LayoutKind;
  values: Record<string, string>;
}

class DeclError extends Error {
  constructor(readonly line: number, readonly column: number, message: string) {
    super(message);
  }
}

const KEYWORDS = new Set([
  'struct', 'union', 'enum', 'typedef', 'unsigned', 'signed', 'short', 'long', 'int', 'char',
  'float', 'double', 'const', 'volatile', 'void',
]);

const TYPE_WORDS = new Set([
  ...KEYWORDS,
  ...['u8','uint8_t','int8_t','i8','u16','uint16_t','i16','int16_t','u32','uint32_t','i32','int32_t',
    'u64','uint64_t','i64','int64_t','f32','f64','bool','_Bool','byte','BYTE','WORD','DWORD'],
]);

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: Token['kind'], value: string, l: number, c: number) => out.push({ kind, value, line: l, column: c });
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { i += 1; line += 1; column = 1; continue; }
    if (/\s/.test(c)) { i += 1; column += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { i += 1; column += 1; }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const sl = line; const sc = column;
      i += 2; column += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') { line += 1; column = 1; } else column += 1;
        i += 1;
      }
      if (i >= text.length) throw new DeclError(sl, sc, '注释没有结束');
      i += 2; column += 2;
      continue;
    }
    if (c === '#') throw new DeclError(line, column, '不支持预处理指令（#define / #pragma 等）；请先给出具体值');
    if (/[A-Za-z_]/.test(c)) {
      const s = i; const sc = column;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) { i += 1; column += 1; }
      push('id', text.slice(s, i), line, sc);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const s = i; const sc = column;
      while (i < text.length && /[0-9a-fA-FxX]/.test(text[i])) { i += 1; column += 1; }
      push('num', text.slice(s, i), line, sc);
      continue;
    }
    push('punct', c, line, column);
    i += 1; column += 1;
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly enums = new Map<string, EnumDef>();
  private readonly types: ParsedType[] = [];
  private readonly problems: DeclarationProblem[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): { types: ParsedType[]; enums: Map<string, EnumDef>; problems: DeclarationProblem[] } {
    while (!this.atEnd()) {
      try {
        this.parseDeclaration();
      } catch (e) {
        if (e instanceof DeclError) {
          this.problems.push({ line: e.line, column: e.column, message: e.message });
          this.skipToSemicolon();
        } else throw e;
      }
    }
    return { types: this.types, enums: this.enums, problems: this.problems };
  }

  private atEnd(): boolean { return this.pos >= this.tokens.length; }
  private peek(offset = 0): Token | undefined { return this.tokens[this.pos + offset]; }
  private take(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new DeclError(1, 1, '声明意外结束');
    this.pos += 1;
    return t;
  }
  private is(value: string, offset = 0): boolean { return this.peek(offset)?.value === value; }
  private expect(value: string): Token {
    const t = this.peek();
    if (!t || t.value !== value) {
      throw new DeclError(t?.line ?? 1, t?.column ?? 1, `期望 "${value}"，实际是 "${t?.value ?? '结束'}"`);
    }
    return this.take();
  }
  private skipToSemicolon(): void {
    while (!this.atEnd()) {
      const t = this.take();
      if (t.value === ';') return;
      if (t.value === '}') return;
    }
  }

  private parseDeclaration(): void {
    if (this.is('typedef')) {
      this.take();
      if (this.is('struct') || this.is('union')) {
        const type = this.parseAggregate(true);
        const alias = this.expectName();
        this.expect(';');
        type.name = alias;
        this.types.push(type);
        return;
      }
      const t = this.peek();
      throw new DeclError(t?.line ?? 1, t?.column ?? 1, '只支持 typedef struct / union / enum');
    }
    if (this.is('struct') || this.is('union')) {
      this.types.push(this.parseAggregate(false));
      this.expect(';');
      return;
    }
    if (this.is('enum')) {
      this.parseEnum();
      this.expect(';');
      return;
    }
    const t = this.peek();
    throw new DeclError(t?.line ?? 1, t?.column ?? 1, `无法识别的声明 "${t?.value ?? '结束'}"`);
  }

  private parseAggregate(typedef: boolean): ParsedType {
    const kw = this.take();
    const union = kw.value === 'union';
    let name = `${union ? 'Union' : 'Struct'}${this.types.length + 1}`;
    let anonymous = true;
    if (this.peek()?.kind === 'id' && !this.is('{')) {
      name = this.take().value;
      anonymous = false;
    }
    const body = this.parseBody(name);
    return { name, union, fields: body, line: kw.line, anonymous };
  }

  private parseBody(parentName: string): ParsedField[] {
    this.expect('{');
    const fields: ParsedField[] = [];
    while (!this.is('}')) {
      if (this.atEnd()) throw new DeclError(1, 1, '结构体没有结束的 }');
      fields.push(this.parseField(parentName, fields.length));
    }
    this.expect('}');
    return fields;
  }

  private parseField(parentName: string, index: number): ParsedField {
    const start = this.peek();
    if (!start) throw new DeclError(1, 1, '字段意外结束');
    // struct/union/enum field types.
    if (this.is('struct') || this.is('union')) {
      if (this.peek(1)?.value === '{') {
        const nested = this.parseAggregate(false);
        const name = this.expectName();
        nested.name = `${parentName}_${name}`;
        nested.anonymous = true;
        this.types.push(nested);
        this.expect(';');
        return { name, nested, line: start.line };
      }
      this.take();
      const tag = this.expectName();
      const name = this.expectName();
      this.expect(';');
      return { name, typeName: tag, line: start.line };
    }
    if (this.is('enum')) {
      this.take();
      const tag = this.expectName();
      const def = this.enums.get(tag);
      const name = this.expectName();
      this.expect(';');
      if (!def) throw new DeclError(start.line, start.column, `未知枚举：${tag}`);
      return { name, typeName: tag, scalar: def.kind, enumValues: def.values, line: start.line };
    }
    const { typeName, scalar, pointer } = this.parseType();
    const name = this.expectName();
    const charType = typeName?.trim() === 'char';
    let array: number | undefined;
    let bits: number | undefined;
    if (this.is('[')) {
      this.take();
      const n = this.takeNum();
      this.expect(']');
      array = n;
    } else if (this.is(':')) {
      this.take();
      bits = this.takeNum();
    }
    this.expect(';');
    return { name, typeName, scalar, pointer, charType, array, bits, line: start.line };
  }

  private parseType(): { typeName?: string; scalar?: LayoutKind; pointer?: boolean } {
    const first = this.peek();
    if (!first || first.kind !== 'id') throw new DeclError(first?.line ?? 1, first?.column ?? 1, '期望字段类型');
    const words: string[] = [this.take().value];
    if (TYPE_WORDS.has(words[0])) {
      while (this.peek()?.kind === 'id' && TYPE_WORDS.has(this.peek()!.value)) {
        words.push(this.take().value);
      }
    }
    let pointer = false;
    if (this.is('*')) { this.take(); pointer = true; }
    const text = words.join(' ');
    return { typeName: text || undefined, scalar: scalarOf(text), pointer };
  }

  private parseEnum(): void {
    this.take(); // enum
    const t = this.peek();
    const name = t?.kind === 'id' ? this.take().value : `Enum${this.enums.size + 1}`;
    let kind: LayoutKind = 'i32';
    if (this.is(':')) {
      this.take();
      const typeWords: string[] = [];
      while (this.peek() && !this.is('{')) typeWords.push(this.take().value);
      const scalar = scalarOf(typeWords.join(' '));
      if (!scalar || !['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64'].includes(scalar)) {
        throw new DeclError(t?.line ?? 1, t?.column ?? 1, 'enum 的底层类型必须是定宽整数');
      }
      kind = scalar;
    } else {
      throw new DeclError(t?.line ?? 1, t?.column ?? 1, 'enum 必须显式指定底层整数类型，例如 enum State : uint16_t');
    }
    this.expect('{');
    const values: Record<string, string> = {};
    let next = 0;
    while (!this.is('}')) {
      const id = this.expectName();
      if (this.is('=')) {
        this.take();
        next = this.takeEnumValue();
      }
      values[String(next)] = id;
      next += 1;
      if (this.is(',')) this.take();
    }
    this.expect('}');
    this.enums.set(name, { name, kind, values });
  }

  private expectName(): string {
    const t = this.peek();
    if (!t || t.kind !== 'id') throw new DeclError(t?.line ?? 1, t?.column ?? 1, `期望名称，实际是 "${t?.value ?? '结束'}"`);
    this.take();
    return t.value;
  }

  private takeEnumValue(): number {
    const t = this.peek();
    if (!t || t.kind !== 'num') throw new DeclError(t?.line ?? 1, t?.column ?? 1, `枚举值必须是数字，实际是 "${t?.value ?? '结束'}"`);
    this.take();
    const n = /^0x/i.test(t.value) ? Number.parseInt(t.value, 16) : Number(t.value);
    if (!Number.isSafeInteger(n) || n < 0) throw new DeclError(t.line, t.column, `枚举值必须是非负整数：${t.value}`);
    return n;
  }

  private takeNum(): number {
    const t = this.peek();
    if (!t || t.kind !== 'num') throw new DeclError(t?.line ?? 1, t?.column ?? 1, `数组长度/位宽必须是具体数字；未知标识符 ${t?.value ?? '结束'}`);
    this.take();
    const n = /^0x/i.test(t.value) ? Number.parseInt(t.value, 16) : Number(t.value);
    if (!Number.isSafeInteger(n) || n < 1) throw new DeclError(t.line, t.column, `数字必须是正整数：${t.value}`);
    return n;
  }
}

const scalarOf = (text: string): LayoutKind | undefined => {
  const t = text.replace(/\b(const|volatile)\b/g, '').replace(/\s+/g, ' ').trim();
  const map: Record<string, LayoutKind> = {
    'u8': 'u8', 'uint8_t': 'u8', 'unsigned char': 'u8', 'byte': 'u8', 'BYTE': 'u8',
    'i8': 'i8', 'int8_t': 'i8', 'signed char': 'i8', 'char': 'u8',
    'u16': 'u16', 'uint16_t': 'u16', 'unsigned short': 'u16', 'WORD': 'u16',
    'i16': 'i16', 'int16_t': 'i16', 'short': 'i16',
    'u32': 'u32', 'uint32_t': 'u32', 'unsigned int': 'u32', 'unsigned': 'u32', 'DWORD': 'u32',
    'i32': 'i32', 'int32_t': 'i32', 'int': 'i32', 'signed int': 'i32',
    'u64': 'u64', 'uint64_t': 'u64', 'unsigned long long': 'u64', 'unsigned long': 'u64',
    'i64': 'i64', 'int64_t': 'i64', 'long long': 'i64', 'long': 'i64',
    'f32': 'f32', 'float': 'f32',
    'f64': 'f64', 'double': 'f64',
    'bool': 'u8', '_Bool': 'u8',
  };
  return map[t];
};

const slug = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'layout';

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) { id = `${base}_${n}`; n += 1; }
  used.add(id);
  return id;
}

/** Parse a declaration and return layouts only if every token was understood. */
export function parseDeclarations(text: string, existing: readonly BinaryLayout[] = [], endian: Endian = 'little'): DeclarationResult {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (e) {
    const err = e as DeclError;
    return { layouts: [], problems: [{ line: err.line ?? 1, column: err.column ?? 1, message: err.message }] };
  }
  const parsed = new Parser(tokens).parse();
  if (parsed.problems.length) return { layouts: [], problems: parsed.problems };

  const byName = new Map<string, BinaryLayout>();
  const usedIds = new Set(existing.map(l => l.id));
  for (const l of existing) byName.set(l.name, l);

  const problems: DeclarationProblem[] = [];
  const layoutOfType = new Map<ParsedType, BinaryLayout>();
  const typeByName = new Map(parsed.types.map(t => [t.name, t]));

  const convert = (type: ParsedType, fieldIndex = new Map<string, string>()): BinaryLayout => {
    const id = uniqueId(slug(type.name), usedIds);
    const layout: BinaryLayout = { id, name: type.name, endian, union: type.union || undefined, fields: [] };
    fieldIndex.clear();
    let bitGroup = 0;
    let bitOffset = 0;
    for (const f of type.fields) {
      const fid = `f${layout.fields.length + 1}`;
      if (fieldIndex.has(f.name)) problems.push({ line: f.line, column: 1, message: `字段名重复：${f.name}` });
      fieldIndex.set(f.name, fid);
      const base: LayoutField = { id: fid, name: f.name, kind: 'u8' };
      if (f.nested) {
        const child = convert(f.nested);
        layoutOfType.set(f.nested, child);
        base.kind = f.array ? 'array' : 'record';
        base.of = `layout/${child.id}`;
        if (f.array) base.count = String(f.array);
      } else if (f.enumValues) {
        base.kind = f.scalar ?? 'i32';
        base.values = f.enumValues;
      } else if (f.pointer) {
        if (!f.scalar) {
          problems.push({ line: f.line, column: 1, message: `指针 ${f.name} 需要明确的整数宽度（如 uint32_t*）` });
        } else {
          base.kind = f.scalar;
          base.role = 'address';
        }
      } else if (f.scalar) {
        if (f.array && f.charType) {
          base.kind = 'string';
          base.size = String(f.array);
        } else if (f.array) {
          base.kind = 'array';
          base.of = f.scalar;
          base.count = String(f.array);
        } else {
          base.kind = f.scalar;
        }
      } else if (f.typeName) {
        const target = typeByName.get(f.typeName) ?? byName.get(f.typeName);
        if (!target) {
          problems.push({ line: f.line, column: 1, message: `未知类型：${f.typeName}` });
        } else if (typeByName.has(f.typeName)) {
          const child = layoutOfType.get(target as ParsedType) ?? convert(target as ParsedType);
          layoutOfType.set(target as ParsedType, child);
          base.kind = f.array ? 'array' : 'record';
          base.of = `layout/${child.id}`;
          if (f.array) base.count = String(f.array);
        } else {
          base.kind = f.array ? 'array' : 'record';
          base.of = `layout/${(target as BinaryLayout).id}`;
          if (f.array) base.count = String(f.array);
        }
      } else {
        problems.push({ line: f.line, column: 1, message: `字段 ${f.name} 缺少类型` });
      }
      if (f.bits != null) {
        if (!f.scalar || f.charType || f.array) {
          problems.push({ line: f.line, column: 1, message: `位域 ${f.name} 需要定宽整数底层类型` });
        } else {
          const unit = Number(f.scalar.slice(1)) / 8;
          if (f.bits > unit * 8) problems.push({ line: f.line, column: 1, message: `位域 ${f.name} 宽度 ${f.bits} 超过 ${unit} 字节` });
          base.kind = 'bits';
          base.width = String(f.bits);
          base.bit = String(bitOffset);
          if (bitOffset === 0 || bitGroup !== layout.fields.length) base.unit = String(unit);
          bitOffset += f.bits;
          bitGroup = layout.fields.length + 1;
          if (bitOffset > unit * 8) { bitOffset = 0; }
        }
      } else {
        bitOffset = 0;
        bitGroup = 0;
      }
      layout.fields.push(base);
    }
    return layout;
  };

  const layouts: BinaryLayout[] = [];
  for (const t of parsed.types) {
    if (layoutOfType.has(t)) continue;
    if (t.anonymous) continue;
    const layout = convert(t);
    layoutOfType.set(t, layout);
    layouts.push(layout);
  }
  // Anonymous types reachable from a named type are already emitted by convert.
  for (const layout of layoutOfType.values()) {
    if (!layouts.includes(layout)) layouts.push(layout);
  }
  return { layouts, problems };
}

/** Render one layout as a pack DSL type, recursively including dependencies. */
export function layoutToPackSource(layout: BinaryLayout, all: readonly BinaryLayout[]): string {
  const byId = new Map(all.map(l => [l.id, l]));
  const emitted = new Set<string>();
  const lines: string[] = [];
  const RESERVED = new Set([
    'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
    'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
    'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected',
    'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield',
  ]);
  const varNames = new Map<string, string>();
  const usedVarNames = new Set<string>();
  const typeNames = new Map<string, string>();
  const usedTypeNames = new Set<string>();
  const uniqueName = (used: Set<string>, base: string): string => {
    let name = base;
    let n = 2;
    while (used.has(name)) { name = `${base}_${n}`; n += 1; }
    used.add(name);
    return name;
  };
  const varName = (l: BinaryLayout): string => {
    const known = varNames.get(l.id);
    if (known) return known;
    let base = l.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || `Layout_${l.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (RESERVED.has(base)) base = `_${base}`;
    const name = uniqueName(usedVarNames, base);
    varNames.set(l.id, name);
    return name;
  };
  const typeName = (l: BinaryLayout): string => {
    const known = typeNames.get(l.id);
    if (known) return known;
    const base = l.name.trim() || `Layout_${l.id}`;
    const name = uniqueName(usedTypeNames, base);
    typeNames.set(l.id, name);
    return name;
  };
  const metaOpts = (f: LayoutField, endian?: 'little' | 'big'): string[] => {
    const opts: string[] = [];
    if (endian) opts.push(`endian: ${JSON.stringify(endian)}`);
    if (f.role) opts.push(`role: ${JSON.stringify(f.role)}`);
    if (f.values) opts.push(`values: ${JSON.stringify(f.values)}`);
    return opts;
  };
  const fieldExpr = (f: LayoutField, layoutEndian: 'little' | 'big'): string => {
    const name = JSON.stringify(f.name);
    const endian = f.endian ?? layoutEndian;
    if (f.kind === 'bits') {
      const bitOpts: string[] = [];
      if (f.at) bitOpts.push(`at: ${f.at}`);
      if (f.unit) bitOpts.push(`unit: ${f.unit}`);
      if (f.bit) bitOpts.push(`bit: ${f.bit}`);
      bitOpts.push(...metaOpts(f, endian));
      return `bits(${name}, ${f.width ?? '1'}, { ${bitOpts.join(', ')} })`;
    }
    if (f.kind === 'string' || f.kind === 'bytes') {
      const opts = [`size: ${f.size ?? '1'}`];
      if (f.at) opts.push(`at: ${f.at}`);
      opts.push(...metaOpts(f));
      return `${f.kind === 'string' ? 'str' : 'bytes'}(${name}, { ${opts.join(', ')} })`;
    }
    const opts: string[] = [];
    if (f.at) opts.push(`at: ${f.at}`);
    if (f.size) opts.push(`size: ${f.size}`);
    opts.push(...metaOpts(f, f.kind === 'record' ? undefined : endian));
    const opt = opts.length ? `, { ${opts.join(', ')} }` : '';
    if (f.kind === 'record' || f.kind === 'array') {
      const target = f.of?.replace(/^layout\//, '') ?? '';
      const targetLayout = byId.get(target);
      const targetExpr = targetLayout ? varName(targetLayout) : 'undefined';
      if (f.kind === 'array') {
        const scalarTarget = f.of && !f.of.startsWith('layout/') ? JSON.stringify(f.of) : targetExpr;
        return `array(${name}, ${scalarTarget}, ${f.count ?? '0'}${opt})`;
      }
      return `record(${name}, ${targetExpr}${opt})`;
    }
    return `${f.kind}(${name}${opt})`;
  };
  const emit = (l: BinaryLayout): void => {
    if (emitted.has(l.id)) return;
    emitted.add(l.id);
    for (const f of l.fields) {
      if (f.of?.startsWith('layout/')) {
        const dep = byId.get(f.of.slice('layout/'.length));
        if (dep) emit(dep);
      }
    }
    const fs = l.fields.map(f => fieldExpr(f, l.endian)).join(', ');
    const opts = [l.size ? `size: ${l.size}` : '', l.union ? 'union: true' : ''].filter(Boolean).join(', ');
    lines.push(`const ${varName(l)} = ${l.union ? 'union' : 'struct'}(${JSON.stringify(typeName(l))}, [${fs}]${opts ? `, { ${opts} }` : ''});`);
  };
  emit(layout);
  return lines.join('\n');
}
