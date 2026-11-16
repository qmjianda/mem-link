/**
 * Tiny C-expression engine (no eval / new Function, CSP-safe).
 *
 *   v - 1
 *   (p - base) / 16
 *   self.hdr.next_off
 *   v & 0xFFFF
 *   v == 0 ? -1 : v - 1
 *
 * Supported: literals, identifiers, member access (. and ->), indexing,
 * unary +/-/!/~/cast, * / % + - << >> < <= > >= == != & ^ | && || ?:.
 * Integer bit-ops are done in 64-bit space so masks like 0xFFFFFFFF behave.
 */

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; name: string }
  | { t: 'member'; obj: Expr; name: string }
  | { t: 'index'; obj: Expr; idx: Expr }
  | { t: 'call'; fn: Expr; args: Expr[] }
  | { t: 'unary'; op: string; e: Expr }
  | { t: 'cast'; to: string; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr };

export type EvalValue = number | string | boolean | null | EvalValue[] | { [k: string]: EvalValue };

export interface EvalContext {
  vars: Record<string, EvalValue>;
  functions: Record<string, (...args: EvalValue[]) => EvalValue>;
}

const TYPE_WORDS = new Set([
  'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64', 'int', 'unsigned', 'long',
  'short', 'char', 'float', 'double', 'ptr', 'bool', 'size_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uintptr_t',
]);

interface Tok { k: 'num' | 'id' | 'str' | 'op'; v: string; pos: number }

class ExprError extends Error {}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (src.startsWith('0x', i) || src.startsWith('0X', i)) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
      } else if (src.startsWith('0b', i) || src.startsWith('0B', i)) {
        j = i + 2;
        while (j < src.length && /[01]/.test(src[j])) j++;
      } else {
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      while (j < src.length && /[uUlL]/.test(src[j])) j++;
      out.push({ k: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          val += e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '\0' : e;
          j += 2;
          continue;
        }
        val += src[j];
        j++;
      }
      out.push({ k: quote === '"' ? 'str' : 'num', v: quote === '"' ? val : String(val.charCodeAt(0)), pos: i });
      i = j + 1;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['<<=', '>>='].includes(three)) { out.push({ k: 'op', v: three, pos: i }); i += 3; continue; }
    if (['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '->'].includes(two)) {
      out.push({ k: 'op', v: two, pos: i }); i += 2; continue;
    }
    if ('+-*/%&|^~!<>?:()[].,'.includes(c)) {
      out.push({ k: 'op', v: c, pos: i }); i++; continue;
    }
    throw new ExprError(`不认识的字符 '${c}'（位置 ${i}）`);
  }
  return out;
}

class ExprParser {
  private toks: Tok[];
  private i = 0;

  constructor(toks: Tok[]) { this.toks = toks; }

  get cur(): Tok | undefined { return this.toks[this.i]; }
  at(v: string): boolean { return this.cur?.v === v && this.cur.k === 'op'; }
  eat(v: string): boolean { if (this.at(v)) { this.i++; return true; } return false; }

  parse(): Expr {
    const e = this.ternary();
    if (this.i < this.toks.length) throw new ExprError(`多余的内容 '${this.cur!.v}'`);
    return e;
  }

  ternary(): Expr {
    const c = this.binary(0);
    if (this.eat('?')) {
      const a = this.ternary();
      if (!this.eat(':')) throw new ExprError('三元表达式缺少 :');
      const b = this.ternary();
      return { t: 'cond', c, a, b };
    }
    return c;
  }

  private static PREC: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
    '==': 6, '!=': 6,
    '<': 7, '<=': 7, '>': 7, '>=': 7,
    '<<': 8, '>>': 8,
    '+': 9, '-': 9,
    '*': 10, '/': 10, '%': 10,
  };

  binary(minPrec: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.cur;
      if (!t || t.k !== 'op') break;
      const prec = ExprParser.PREC[t.v];
      if (prec == null || prec < minPrec) break;
      this.i++;
      const right = this.binary(prec + 1);
      left = { t: 'bin', op: t.v, l: left, r: right };
    }
    return left;
  }

  unary(): Expr {
    const t = this.cur;
    if (!t) throw new ExprError('表达式意外结束');
    if (t.k === 'op' && ['!', '~', '-', '+'].includes(t.v)) {
      this.i++;
      return { t: 'unary', op: t.v, e: this.unary() };
    }
    if (t.k === 'op' && t.v === '(' && this.looksLikeCast()) {
      this.i++;
      let name = '';
      while (this.cur && !this.at(')')) { name += this.cur.v; this.i++; }
      this.eat(')');
      return { t: 'cast', to: name.replace(/\s+/g, ''), e: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private looksLikeCast(): boolean {
    // ( u32 ) expr  /  (unsigned int) expr
    let j = this.i + 1;
    const parts: string[] = [];
    while (j < this.toks.length && this.toks[j].k === 'id') { parts.push(this.toks[j].v); j++; }
    if (j >= this.toks.length || this.toks[j].v !== ')') return false;
    if (!parts.length) return false;
    if (parts.length > 2) return false;
    return parts.every((p) => TYPE_WORDS.has(p)) && !(parts.length === 1 && parts[0] === 'v');
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat('.')) {
        const id = this.cur;
        if (!id || id.k !== 'id') throw new ExprError('. 后需要字段名');
        this.i++;
        e = { t: 'member', obj: e, name: id.v };
        continue;
      }
      if (this.eat('->')) {
        const id = this.cur;
        if (!id || id.k !== 'id') throw new ExprError('-> 后需要字段名');
        this.i++;
        e = { t: 'member', obj: e, name: id.v };
        continue;
      }
      if (this.eat('[')) {
        const idx = this.ternary();
        if (!this.eat(']')) throw new ExprError('缺少 ]');
        e = { t: 'index', obj: e, idx };
        continue;
      }
      if (this.at('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.at(')')) {
          do { args.push(this.ternary()); } while (this.eat(','));
        }
        if (!this.eat(')')) throw new ExprError('缺少 )');
        e = { t: 'call', fn: e, args };
        continue;
      }
      break;
    }
    return e;
  }

  private primary(): Expr {
    const t = this.cur;
    if (!t) throw new ExprError('表达式意外结束');
    if (t.k === 'num') {
      this.i++;
      return { t: 'num', v: parseNum(t.v) };
    }
    if (t.k === 'str') {
      this.i++;
      return { t: 'str', v: t.v };
    }
    if (t.k === 'id') {
      this.i++;
      return { t: 'id', name: t.v };
    }
    if (this.eat('(')) {
      const e = this.ternary();
      if (!this.eat(')')) throw new ExprError('缺少 )');
      return e;
    }
    throw new ExprError(`无法解析 '${t.v}'（位置 ${t.pos}）`);
  }
}

function parseNum(raw: string): number {
  const s = raw.replace(/[uUlL]+$/g, '');
  if (/^0x/i.test(s)) return parseInt(s.slice(2), 16);
  if (/^0b/i.test(s)) return parseInt(s.slice(2), 2);
  return Number(s);
}

/* ------------------------------------------------------------- evaluator */

const I64 = (n: number): bigint => {
  const b = BigInt(Math.trunc(n));
  const mask = (1n << 64n) - 1n;
  return b & mask;
};

function wrap64(b: bigint): number {
  const m = b & ((1n << 64n) - 1n);
  const sign = (m >> 63n) & 1n;
  return Number(sign ? m - (1n << 64n) : m);
}

function toNum(v: EvalValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v.length ? Number(v) : 0;
  if (v == null) return 0;
  return 0;
}

export function evalExpr(e: Expr, ctx: EvalContext): EvalValue {
  switch (e.t) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'id': {
      if (e.name === 'true') return true;
      if (e.name === 'false') return false;
      if (e.name === 'NULL') return 0;
      if (e.name in ctx.vars) return ctx.vars[e.name];
      if (e.name in ctx.functions) return e.name;
      throw new ExprError(`未知标识符 '${e.name}'`);
    }
    case 'member': {
      const obj = evalExpr(e.obj, ctx);
      if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new ExprError(`无法从非结构值读取 .${e.name}`);
      }
      const rec = obj as Record<string, EvalValue>;
      if (!(e.name in rec)) throw new ExprError(`没有字段 '${e.name}'`);
      return rec[e.name];
    }
    case 'index': {
      const obj = evalExpr(e.obj, ctx);
      const idx = Math.trunc(toNum(evalExpr(e.idx, ctx)));
      if (typeof obj === 'string') return obj[idx] ?? 0;
      if (!Array.isArray(obj)) throw new ExprError('对非数组取下标');
      if (idx < 0 || idx >= obj.length) throw new ExprError(`下标 ${idx} 越界（长度 ${obj.length}）`);
      return obj[idx];
    }
    case 'call': {
      if (e.fn.t !== 'id') throw new ExprError('只支持直接调用函数名');
      const fn = ctx.functions[e.fn.name];
      if (!fn) throw new ExprError(`未知函数 '${e.fn.name}'`);
      const args = e.args.map((a) => evalExpr(a, ctx));
      return fn(...args);
    }
    case 'unary': {
      if (e.op === '!') return !truthy(evalExpr(e.e, ctx));
      const v = toNum(evalExpr(e.e, ctx));
      if (e.op === '-') return -v;
      if (e.op === '+') return v;
      return wrap64(~I64(v));
    }
    case 'cast': return castTo(e.to, evalExpr(e.e, ctx));
    case 'bin': return binop(e.op, e.l, e.r, ctx);
    case 'cond': return truthy(evalExpr(e.c, ctx)) ? evalExpr(e.a, ctx) : evalExpr(e.b, ctx);
  }
}

function truthy(v: EvalValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return v != null;
}

function castTo(to: string, v: EvalValue): number {
  const n = toNum(v);
  const m = /^(u|s)?(8|16|32|64)$/.exec(to);
  if (m) {
    const bits = Number(m[2]);
    const unsigned = m[1] !== 's';
    const mod = 2 ** bits;
    let r = ((Math.trunc(n) % mod) + mod) % mod;
    if (!unsigned && r >= mod / 2) r -= mod;
    return r;
  }
  if (to === 'float' || to === 'double') return n;
  if (to === 'int' || to === 'unsigned' || to === 'long' || to === 'short') return Math.trunc(n);
  if (to === 'char') return Math.trunc(n) & 0xff;
  if (to === 'bool') return n !== 0 ? 1 : 0;
  return n;
}

function binop(op: string, le: Expr, re: Expr, ctx: EvalContext): EvalValue {
  // short circuit
  if (op === '&&') return truthy(evalExpr(le, ctx)) && truthy(evalExpr(re, ctx));
  if (op === '||') return truthy(evalExpr(le, ctx)) || truthy(evalExpr(re, ctx));
  const a = evalExpr(le, ctx);
  const b = evalExpr(re, ctx);
  switch (op) {
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return String(toNum(a) + toNum(b));
      return toNum(a) + toNum(b);
    case '-': return toNum(a) - toNum(b);
    case '*': return toNum(a) * toNum(b);
    case '/': {
      const d = toNum(b);
      if (d === 0) throw new ExprError('除以零');
      return toNum(a) / d;
    }
    case '%': {
      const d = toNum(b);
      if (d === 0) throw new ExprError('对零取模');
      return toNum(a) % d;
    }
    case '<<': return wrap64(I64(toNum(a)) << I64(toNum(b) & 63));
    case '>>': return wrap64(I64(toNum(a)) >> I64(toNum(b) & 63));
    case '&': return wrap64(I64(toNum(a)) & I64(toNum(b)));
    case '|': return wrap64(I64(toNum(a)) | I64(toNum(b)));
    case '^': return wrap64(I64(toNum(a)) ^ I64(toNum(b)));
    case '<': return toNum(a) < toNum(b);
    case '<=': return toNum(a) <= toNum(b);
    case '>': return toNum(a) > toNum(b);
    case '>=': return toNum(a) >= toNum(b);
    case '==': return a === b || toNum(a) === toNum(b);
    case '!=': return !(a === b || toNum(a) === toNum(b));
    default: throw new ExprError(`未知运算符 ${op}`);
  }
}

/* ---------------------------------------------------------------- public */

export interface CompiledExpr {
  src: string;
  ast: Expr | null;
  error?: string;
  /** Evaluate; returns value or throws Error with a readable message. */
  eval(ctx: EvalContext): EvalValue;
}

export function compileExpr(src: string): CompiledExpr {
  const text = (src ?? '').trim();
  if (!text) return { src, ast: null, error: '空表达式', eval() { throw new Error('空表达式'); } };
  try {
    const ast = new ExprParser(lex(text)).parse();
    return { src, ast, eval: (ctx) => evalExpr(ast, ctx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { src, ast: null, error: msg, eval() { throw new Error(msg); } };
  }
}

export function evalNumber(src: string, ctx: EvalContext): { value: number; error?: string } {
  try {
    const c = compileExpr(src);
    if (c.error) return { value: NaN, error: c.error };
    const v = c.eval(ctx);
    if (typeof v === 'boolean') return { value: v ? 1 : 0 };
    if (typeof v !== 'number') return { value: NaN, error: '表达式结果不是数字' };
    return { value: v };
  } catch (e) {
    return { value: NaN, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Format a computed value for compact display. */
export function fmtNum(n: number, opts: { hex?: boolean } = {}): string {
  if (!Number.isFinite(n)) return 'NaN';
  if (opts.hex) {
    const neg = n < 0;
    const abs = Math.abs(Math.trunc(n));
    return `${neg ? '-' : ''}0x${abs.toString(16)}`;
  }
  return String(n);
}
