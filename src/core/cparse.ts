/**
 * A small C declaration parser, tuned for the subset people actually use when
 * describing on-disk / in-memory layouts:
 *
 *   typedef struct Node { int next; char name[16]; } Node;
 *   struct Entry { unsigned kind : 3; unsigned flags : 5; } __attribute__((packed));
 *   #pragma pack(push, 1) ... #pragma pack(pop)
 *
 * Deliberately NOT supported (reported as issues instead of silently guessing):
 * anonymous nested structs, function pointers with arguments, macro expansion.
 */

import {
  type CType, type Endian, type Field, type ParseIssue, type RecordDecl, type Schema,
  BOOL, CHAR, INT, PTR,
} from './types';

export interface ParseOptions {
  ptrSize?: 4 | 8;
  endian?: Endian;
}

interface Tok { k: 'id' | 'num' | 'punct'; v: string; pos: number; line: number }

const QUALIFIERS = new Set([
  'const', 'volatile', 'restrict', '__restrict', 'static', 'extern', 'register',
  'inline', '__inline', '__inline__', 'auto', 'mutable', 'struct_', '_Atomic',
]);

const BUILTIN_WORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  '_Bool', 'bool', '_Complex', '__int8', '__int16', '__int32', '__int64',
]);

/** fixed width typedefs -> CType */
function fixedWidthType(name: string, ptrSize: number): CType | null {
  const m = /^(u?int)(8|16|32|64)(_t)?$/.exec(name.replace(/^__/, ''));
  if (m) {
    const size = Number(m[2]) / 8;
    return INT(size, m[1] === 'int');
  }
  switch (name) {
    case 'size_t': case 'uintptr_t': case 'uintmax_t': return INT(ptrSize, false);
    case 'ssize_t': case 'intptr_t': case 'ptrdiff_t': case 'intmax_t': return INT(ptrSize, true);
    case 'u8': return INT(1, false);
    case 'u16': return INT(2, false);
    case 'u32': return INT(4, false);
    case 'u64': return INT(8, false);
    case 's8': return INT(1, true);
    case 's16': return INT(2, true);
    case 's32': return INT(4, true);
    case 's64': return INT(8, true);
    case 'byte': case 'uint8': return INT(1, false);
    case 'ushort': return INT(2, false);
    case 'uint': return INT(4, false);
    case 'ulong': return INT(ptrSize, false);
    default: return null;
  }
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'") {
      const quote = c;
      out += c; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += src[i]; i++; if (i < n) { out += src[i]; i++; } continue; }
        out += src[i] === '\n' ? '\n' : src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

interface PragmaEvent { pos: number; pack: number }

/** Blanks out preprocessor lines, remembering the active packing at each offset. */
function stripDirectives(src: string): { text: string; pragmas: PragmaEvent[] } {
  const pragmas: PragmaEvent[] = [];
  const stack: number[] = [];
  let pos = 0;
  let out = '';
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const m = /^#\s*pragma\s+pack\s*\(\s*(push\s*,\s*(\d+)|pop\s*\(\s*\)|(\d+)|pop)\s*\)/.exec(trimmed);
      if (m) {
        if (m[1] && m[1].startsWith('push')) stack.push(Number(m[2]));
        else if (m[1] && m[1].startsWith('pop')) stack.pop();
        else if (m[3]) stack.push(Number(m[3]));
        pragmas.push({ pos, pack: stack.length ? stack[stack.length - 1] : 0 });
      }
      // keep the newline so token line numbers stay right
      out += ' '.repeat(line.length) + '\n';
    } else {
      out += line + '\n';
    }
    pos += line.length + 1;
  }
  return { text: out, pragmas };
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
      toks.push({ k: 'id', v: src.slice(start, i), pos: start, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      if (src.startsWith('0x', i) || src.startsWith('0X', i)) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < src.length && /[0-9.]/.test(src[i])) i++;
        while (i < src.length && /[uUlLfF]/.test(src[i])) i++;
      }
      toks.push({ k: 'num', v: src.slice(start, i), pos: start, line });
      continue;
    }
    toks.push({ k: 'punct', v: c, pos: i, line });
    i++;
  }
  return toks;
}

function alignUp(v: number, a: number): number {
  if (a <= 1) return v;
  return Math.ceil(v / a) * a;
}

export function isRecord(t: CType): t is Extract<CType, { k: 'record' }> {
  return t.k === 'record';
}

export function unwrapType(t: CType): CType {
  let cur = t;
  while (cur.k === 'array') cur = cur.elem;
  return cur;
}

export function sizeOfType(t: CType, schema: Schema): number {
  switch (t.k) {
    case 'int': case 'float': case 'ptr': return t.size;
    case 'char': case 'bool': return 1;
    case 'array': return sizeOfType(t.elem, schema) * t.count;
    case 'record': return schema.records[t.name]?.size ?? 0;
  }
}

export function alignOfType(t: CType, schema: Schema, pack?: number): number {
  let natural: number;
  switch (t.k) {
    case 'int': case 'float': case 'ptr': natural = t.size; break;
    case 'char': case 'bool': natural = 1; break;
    case 'array': natural = alignOfType(t.elem, schema, pack); break;
    case 'record': natural = schema.records[t.name]?.align ?? 1; break;
  }
  if (pack && pack > 0) return Math.min(natural, pack);
  return natural;
}

/* --------------------------------------------------------------- parsing */

class Parser {
  toks: Tok[];
  i = 0;
  schema: Schema;
  pragmas: PragmaEvent[];

  constructor(toks: Tok[], schema: Schema, pragmas: PragmaEvent[]) {
    this.toks = toks;
    this.schema = schema;
    this.pragmas = pragmas;
  }

  get cur(): Tok | undefined { return this.toks[this.i]; }
  at(v: string): boolean { return this.cur?.v === v; }
  eat(v: string): boolean { if (this.at(v)) { this.i++; return true; } return false; }
  peek(o = 1): Tok | undefined { return this.toks[this.i + o]; }

  issue(message: string, line?: number, severity: 'error' | 'warn' = 'warn') {
    this.schema.issues.push({ message, line, severity });
  }

  packAt(pos: number): number {
    let pack = 0;
    for (const p of this.pragmas) { if (p.pos <= pos) pack = p.pack; else break; }
    return pack;
  }

  parseTop(): void {
    while (this.i < this.toks.length) {
      const t = this.cur!;
      if (t.v === 'typedef') {
        this.i++;
        if (this.at('struct') || this.at('union')) this.parseRecord(true);
        else this.parseTypedefAlias();
        continue;
      }
      if (t.v === 'struct' || t.v === 'union') {
        const start = this.i;
        this.parseRecord(false);
        if (this.i === start) this.i++;
        continue;
      }
      this.i++;
    }
  }

  parseTypedefAlias(): void {
    // typedef <type> Alias;
    const start = this.i;
    const type = this.parseBaseType();
    if (!type) { this.i = start + 1; return; }
    const nameTok = this.cur;
    if (nameTok?.k === 'id') {
      this.schema.typedefs[nameTok.v] = type;
      this.i++;
    }
    while (this.cur && !this.at(';')) this.i++;
    this.eat(';');
  }

  /** Skips __attribute__((...)) / __declspec(...) and reports whether it said packed/aligned. */
  skipAttributes(): { packed: boolean; aligned?: number } {
    let packed = false;
    let aligned: number | undefined;
    for (;;) {
      const t = this.cur;
      if (!t) break;
      if (t.v === '__attribute__' || t.v === '__attribute' || t.v === '__declspec') {
        this.i++;
        if (!this.at('(')) continue;
        let depth = 0;
        const words: string[] = [];
        do {
          const tok = this.cur;
          if (!tok) break;
          if (tok.v === '(') depth++;
          if (tok.v === ')') depth--;
          words.push(tok.v);
          this.i++;
        } while (depth > 0 && this.cur);
        const joined = words.join('');
        if (joined.includes('packed')) packed = true;
        const m = /aligned\((\d+)\)/.exec(joined);
        if (m) aligned = Number(m[1]);
        continue;
      }
      if (t.v === '__packed') { packed = true; this.i++; continue; }
      break;
    }
    return { packed, aligned };
  }

  parseRecord(isTypedef: boolean): void {
    const kindTok = this.cur!;
    const kind: 'struct' | 'union' = kindTok.v === 'union' ? 'union' : 'struct';
    const startPos = kindTok.pos;
    this.i++;

    const attr1 = this.skipAttributes();
    let tag = '';
    if (this.cur?.k === 'id' && !this.at('{')) { tag = this.cur.v; this.i++; }
    const attr2 = this.skipAttributes();

    if (!this.at('{')) {
      // forward declaration or `typedef struct Foo Foo;`
      while (this.cur && !this.at(';')) this.i++;
      this.eat(';');
      if (isTypedef && tag) this.schema.typedefs[tag] = { k: 'record', name: tag, union: kind === 'union' };
      return;
    }

    this.i++; // {
    const bodyStart = this.cur?.pos ?? startPos;
    const rawFields: { name: string; type: CType; bitWidth?: number; line: number }[] = [];
    const depthGuard = this.i;

    while (this.cur && !this.at('}')) {
      const stmtStart = this.i;
      // collect one statement up to ';' or '}'
      const stmt: Tok[] = [];
      let depth = 0;
      while (this.cur) {
        const t = this.cur;
        if (t.v === '{') depth++;
        if (t.v === '}') {
          if (depth === 0) break;
          depth--;
        }
        if (t.v === ';' && depth === 0) break;
        stmt.push(t);
        this.i++;
      }
      this.eat(';');
      if (stmt.length) this.parseFieldStatement(stmt, rawFields, kind);
      if (this.i === stmtStart) this.i++; // safety
    }
    this.eat('}');

    // aliases after the body
    const aliases: string[] = [];
    const attr3 = this.skipAttributes();
    while (this.cur && !this.at(';')) {
      if (this.cur.k === 'id') {
        aliases.push(this.cur.v);
        this.i++;
        while (this.at('[')) { // ignore array suffix on alias
          while (this.cur && !this.at(']')) this.i++;
          this.eat(']');
        }
      } else this.i++;
    }
    this.eat(';');

    const name = aliases[0] || tag || `anon_${startPos}`;
    const packed = attr1.packed || attr2.packed || attr3.packed;
    const pack = packed ? 1 : this.packAt(bodyStart) || undefined;

    const rec: RecordDecl = {
      name, kind, fields: [], size: 0, align: 1, pack,
      endian: this.schema.endian,
    };
    rec.fields = rawFields.map((rf, idx) => ({
      id: `${name}.${rf.name || `_pad${idx}`}`,
      name: rf.name || '',
      type: rf.type,
      offset: 0,
      size: 0,
      bitWidth: rf.bitWidth,
      endian: this.schema.endian,
    }));

    this.schema.records[name] = rec;
    if (tag && tag !== name) this.schema.typedefs[tag] = { k: 'record', name, union: kind === 'union' };
    for (const a of aliases) this.schema.typedefs[a] = { k: 'record', name, union: kind === 'union' };
  }

  parseFieldStatement(
    stmt: Tok[],
    out: { name: string; type: CType; bitWidth?: number; line: number }[],
    kind: 'struct' | 'union',
  ): void {
    // reject nested definitions
    if (stmt.some((t) => t.v === '{')) {
      this.issue('暂不支持内嵌匿名 struct/union，请先单独定义再引用', stmt[0].line);
      return;
    }
    const p = new StmtParser(stmt, this);
    const base = p.parseBaseType();
    if (!base) return;

    for (;;) {
      const d = p.parseDeclarator();
      if (!d) break;
      let type = base;
      if (d.stars > 0) type = PTR(this.schema.ptrSize);
      for (let k = d.dims.length - 1; k >= 0; k--) type = { k: 'array', elem: type, count: d.dims[k] };
      if (d.bits != null && (type.k === 'int' || type.k === 'char' || type.k === 'bool')) {
        out.push({ name: d.name, type, bitWidth: d.bits, line: stmt[0].line });
      } else if (d.bits != null) {
        this.issue(`位域 ${d.name} 的基类型不是整型`, stmt[0].line);
      } else {
        out.push({ name: d.name, type, line: stmt[0].line });
      }
      if (!p.eat(',')) break;
    }
  }

  parseBaseType(): CType | null {
    const p = new StmtParser(this.toks.slice(this.i), this);
    const t = p.parseBaseType();
    this.i = p.baseIndex + this.i;
    return t;
  }
}

class StmtParser {
  toks: Tok[];
  i = 0;
  baseIndex = 0;
  parser: Parser;

  constructor(toks: Tok[], parser: Parser) { this.toks = toks; this.parser = parser; }

  get cur(): Tok | undefined { return this.toks[this.i]; }
  at(v: string): boolean { return this.cur?.v === v; }
  eat(v: string): boolean { if (this.at(v)) { this.i++; return true; } return false; }

  parseBaseType(): CType | null {
    const schema = this.parser.schema;
    const words: string[] = [];
    for (;;) {
      const t = this.cur;
      if (!t) break;
      if (t.k === 'punct') break;
      if (QUALIFIERS.has(t.v)) { this.i++; continue; }
      if (t.v === '__attribute__' || t.v === '__declspec') {
        // skip attribute inside declaration
        this.i++;
        if (this.at('(')) { let d = 0; do { if (this.at('(')) d++; if (this.at(')')) d--; this.i++; } while (d > 0 && this.cur); }
        continue;
      }
      if (t.v === 'struct' || t.v === 'union') {
        const union = t.v === 'union';
        this.i++;
        const nm = this.cur?.k === 'id' ? this.cur.v : '';
        if (nm) this.i++;
        this.baseIndex = this.i;
        return nm ? { k: 'record', name: nm, union } : null;
      }
      if (t.v === 'enum') {
        this.i++;
        if (this.cur?.k === 'id') this.i++;
        this.baseIndex = this.i;
        return INT(4, true);
      }
      if (BUILTIN_WORDS.has(t.v)) { words.push(t.v); this.i++; continue; }
      const fw = fixedWidthType(t.v, this.parser.schema.ptrSize);
      if (fw) {
        this.i++;
        this.baseIndex = this.i;
        return fw;
      }
      if (schema.typedefs[t.v]) {
        const tt = schema.typedefs[t.v];
        this.i++;
        // e.g. `Node *p` handled by declarator; `Node p` returns the record
        this.baseIndex = this.i;
        return tt;
      }
      if (schema.records[t.v]) {
        this.i++;
        this.baseIndex = this.i;
        return { k: 'record', name: t.v, union: schema.records[t.v].kind === 'union' };
      }
      break;
    }
    this.baseIndex = this.i;
    if (!words.length) return null;
    return this.builtin(words);
  }

  builtin(words: string[]): CType {
    const has = (w: string) => words.includes(w);
    const unsigned = has('unsigned');
    if (has('_Bool') || has('bool')) return BOOL;
    if (has('double')) return { k: 'float', size: 8 };
    if (has('float')) return { k: 'float', size: 4 };
    if (has('void')) return INT(0, false);
    if (has('char')) return CHAR(!unsigned);
    if (has('short')) return INT(2, !unsigned);
    if (has('long')) {
      const count = words.filter((w) => w === 'long').length;
      if (count >= 2) return INT(8, !unsigned);
      return INT(this.parser.schema.ptrSize, !unsigned);
    }
    return INT(4, !unsigned);
  }

  parseDeclarator(): { name: string; stars: number; dims: number[]; bits?: number } | null {
    let stars = 0;
    while (this.at('*')) {
      stars++;
      this.i++;
      while (this.cur && QUALIFIERS.has(this.cur.v)) this.i++;
    }
    if (this.at('(')) {
      // function pointer or parenthesised declarator: treat as pointer, skip the group
      let depth = 0;
      do {
        if (this.at('(')) depth++;
        if (this.at(')')) depth--;
        this.i++;
      } while (depth > 0 && this.cur);
      stars = Math.max(stars, 1);
      while (this.at('(')) {
        let d = 0;
        do { if (this.at('(')) d++; if (this.at(')')) d--; this.i++; } while (d > 0 && this.cur);
      }
      return { name: 'fn', stars, dims: [] };
    }
    const nt = this.cur;
    if (!nt || nt.k !== 'id') return null;
    const name = nt.v;
    this.i++;
    const dims: number[] = [];
    while (this.at('[')) {
      this.i++;
      let n = 0;
      let sign = 1;
      if (this.at('-')) { sign = -1; this.i++; }
      if (this.cur?.k === 'num') { n = Number(this.cur.v.replace(/[uUlL]+$/, '')); this.i++; }
      while (this.cur && !this.at(']')) this.i++;
      this.eat(']');
      dims.push(Math.max(1, sign * n));
    }
    let bits: number | undefined;
    if (this.at(':')) {
      this.i++;
      if (this.cur?.k === 'num') { bits = Number(this.cur.v); this.i++; }
    }
    // initializer
    if (this.at('=')) {
      while (this.cur && !this.at(',') && !this.at(';')) this.i++;
    }
    return { name, stars, dims, bits };
  }
}

/* --------------------------------------------------------------- layout */

function layoutAll(schema: Schema): void {
  const state = new Map<string, 'busy' | 'done'>();

  const layoutRecord = (name: string): void => {
    const rec = schema.records[name];
    if (!rec) return;
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'busy') {
      schema.issues.push({ severity: 'error', message: `记录 ${name} 存在按值自引用环，无法计算大小` });
      return;
    }
    state.set(name, 'busy');

    // make sure every referenced record is sized first
    for (const f of rec.fields) {
      const base = unwrapType(f.type);
      if (base.k === 'record' && schema.records[base.name] && base.name !== name) layoutRecord(base.name);
      else if (base.k === 'record' && base.name === name) {
        schema.issues.push({ severity: 'error', message: `${name} 不能按值包含自身` });
      }
    }

    let off = 0;
    let maxNaturalAlign = 1;
    let unit: { start: number; size: number; used: number } | null = null;
    const pack = rec.pack;

    for (const f of rec.fields) {
      if (f.bitWidth != null) {
        const unitSize = Math.max(1, sizeOfType(f.type, schema));
        const unitAlign = pack ? Math.min(unitSize, pack) : unitSize;
        maxNaturalAlign = Math.max(maxNaturalAlign, unitAlign);
        if (rec.kind === 'union') {
          f.offset = 0; f.bitOffset = 0; f.size = unitSize;
          continue;
        }
        if (!unit || unit.size !== unitSize || unit.used + f.bitWidth > unitSize * 8) {
          off = alignUp(off, unitAlign);
          unit = { start: off, size: unitSize, used: 0 };
          off += unitSize;
        }
        f.offset = unit.start;
        f.size = unitSize;
        f.bitOffset = schema.endian === 'little'
          ? unit.used
          : unitSize * 8 - unit.used - f.bitWidth;
        unit.used += f.bitWidth;
      } else {
        unit = null;
        const a = alignOfType(f.type, schema, pack);
        const s = sizeOfType(f.type, schema);
        maxNaturalAlign = Math.max(maxNaturalAlign, a);
        if (rec.kind === 'union') {
          f.offset = 0;
        } else {
          off = alignUp(off, a);
          f.offset = off;
          off += s;
        }
        f.size = s;
      }
    }

    rec.align = pack ? Math.min(maxNaturalAlign, pack) : maxNaturalAlign;
    const rawSize = rec.kind === 'union'
      ? rec.fields.reduce((m, f) => Math.max(m, f.size), 0)
      : off;
    rec.size = alignUp(rawSize, rec.align || 1);
    if (rec.size === 0) rec.size = 1;
    state.set(name, 'done');
  };

  for (const name of Object.keys(schema.records)) layoutRecord(name);
}

/* ------------------------------------------------------------------ api */

export function parseCSource(source: string, opts: ParseOptions = {}): Schema {
  const ptrSize = opts.ptrSize ?? 8;
  const schema: Schema = {
    records: {},
    typedefs: {},
    ptrSize,
    endian: opts.endian ?? 'little',
    issues: [],
    source,
  };
  const stripped = stripComments(source);
  const { text, pragmas } = stripDirectives(stripped);
  const toks = tokenize(text);
  const p = new Parser(toks, schema, pragmas);
  try {
    p.parseTop();
  } catch (e) {
    schema.issues.push({ severity: 'error', message: `解析中断：${(e as Error).message}` });
  }
  layoutAll(schema);
  // surface empty records
  for (const rec of Object.values(schema.records)) {
    if (!rec.fields.length) schema.issues.push({ severity: 'warn', message: `记录 ${rec.name} 没有字段` });
  }
  return schema;
}

/** Convenience: parse and return only the diagnostics that matter to the UI. */
export function parseIssues(source: string, opts: ParseOptions = {}): ParseIssue[] {
  return parseCSource(source, opts).issues;
}
