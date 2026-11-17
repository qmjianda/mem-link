/**
 * 结构树模型：给 struct / list / array 节点提供「进去逐层看」的数据源。
 *
 * 与图上求值分开：图只解码到能画节点为止，并且把链表/数组截断在 4096 项；
 * 这里按展开与跳转逐步读内存，所以长链表的尾巴、大数组的高位下标都能到。
 *
 * 模型是纯逻辑（不依赖 React/DOM），行按 path 缓存，UI 只负责虚拟滚动。
 */

import { Memory, toHex } from '../core/mem';
import {
  fieldSize, kindSize,
  type FieldDef, type FieldKind, type Pack, type TypeDef,
} from '../core/pack';
import { decodeFieldRaw, formatPackValue, packMemApi } from '../core/packgraph';
import { createEntryReader } from './eval';
import type { BlueprintPack, EntryView, ListNodeDef } from './types';

/** 每次展开/加载更多时追加的行数。 */
export const TREE_PAGE = 200;
/** 链表遍历的硬上限（pack 自己声明的 max 优先，且不超过它）。 */
const HARD_MAX = 200_000;

export interface TreeRootSpec {
  kind: 'struct' | 'list' | 'array';
  pack: BlueprintPack;
  /** 根类型（list/array 的元素类型） */
  type: TypeDef;
  mem: Memory;
  /** struct/array 的基址；list 的头元素地址 */
  addr: number;
  /** 根行显示名（默认用类型名） */
  label?: string;
  /** 链表遍历（来自 pack 的 listNode） */
  next?: ListNodeDef['next'];
  nulls?: number[];
  max?: number;
  /** 数组元素个数与步长 */
  count?: number;
  stride?: number;
}

export interface TreeRow {
  path: string;
  depth: number;
  label: string;
  typeText: string;
  addr: number;
  /** 相对根地址的偏移；根行为 0 */
  offset: number;
  size: number;
  valueText: string;
  /** 转换前的原始值；和 valueText 相同则不显示 */
  rawText?: string;
  /** 指针/地址字段：可在图上解析 */
  ref?: { addr: number; hint: string };
  expandable: boolean;
  tone: 'root' | 'instance' | 'field' | 'element' | 'more' | 'error' | 'note';
  /** more 行点击后由 UI 调 loadMore(path) */
  more?: true;
  /** more 行对应的父 path（loadMore 用） */
  moreOf?: string;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatValue(f: FieldDef, v: unknown, forceHex = false): string {
  if (forceHex && typeof v === 'number' && Number.isFinite(v)) return toHex(v);
  return formatPackValue(f, v);
}

export class StructTree {
  readonly root: TreeRootSpec;
  readonly rootPath: string;

  private readonly compat: Pack;
  private readonly reader: ReturnType<typeof createEntryReader>;
  private readonly builders = new Map<string, () => TreeRow[]>();
  private readonly cache = new Map<string, TreeRow[]>();
  /** path → 已加载的元素数（数组/链表分页） */
  private readonly pages = new Map<string, number>();
  private readonly rootRow: TreeRow;

  /* 链表遍历状态 */
  private readonly listSeen = new Set<number>();
  private readonly listNulls: Set<number>;
  private readonly listMax: number;
  private listAddrs: number[] = [];
  private listCursor: number;
  private listDone = false;
  private listCycle = false;
  private listError?: string;

  constructor(root: TreeRootSpec) {
    this.root = root;
    this.rootPath = root.type.name;
    this.compat = {
      name: root.pack.name,
      endian: root.pack.endian,
      pointerSize: root.pack.pointerSize,
      constants: root.pack.constants,
      types: Object.values(root.pack.types),
      roots: [],
    };
    this.reader = createEntryReader(root.mem, root.pack);
    this.listCursor = root.addr;
    this.listNulls = new Set(root.nulls ?? []);
    this.listMax = Math.min(root.max ?? 4096, HARD_MAX);
    this.rootRow = this.makeRootRow();
  }

  /* ------------------------------------------------------------- 对外 API */

  /** 当前展开状态下可见的行（搜索只在这些行里过滤）。 */
  rows(expanded: Set<string>, query = ''): TreeRow[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      const out: TreeRow[] = [];
      const visit = (rows: TreeRow[]) => {
        for (const r of rows) {
          out.push(r);
          if (r.expandable && expanded.has(r.path)) visit(this.children(r.path));
        }
      };
      visit([this.rootRow]);
      return out;
    }

    // 有搜索词时保留「命中行的祖先」，否则缩进会失去上下文。
    const kept = new Set<string>();
    const mark = (row: TreeRow): boolean => {
      let hit = row.tone !== 'more' && row.tone !== 'note' && matches(row, q);
      if (row.expandable && expanded.has(row.path)) {
        for (const child of this.children(row.path)) {
          if (mark(child)) hit = true;
        }
      }
      if (hit) kept.add(row.path);
      return hit;
    };
    mark(this.rootRow);

    const out: TreeRow[] = [];
    const visit = (rows: TreeRow[]) => {
      for (const r of rows) {
        if (!kept.has(r.path)) continue;
        out.push(r);
        if (r.expandable && expanded.has(r.path)) visit(this.children(r.path));
      }
    };
    visit([this.rootRow]);
    return out;
  }

  children(path: string): TreeRow[] {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const build = this.builders.get(path);
    if (!build) return [];
    const rows = build();
    this.cache.set(path, rows);
    return rows;
  }

  /** 追加一页；返回是否还有更多。 */
  loadMore(path: string): boolean {
    const loaded = this.pages.get(path) ?? TREE_PAGE;
    this.pages.set(path, loaded + TREE_PAGE);
    this.cache.delete(path);
    return true;
  }

  /** 头部摘要：链表显示已走到的条数，数组显示总数。 */
  summary(): string {
    if (this.root.kind === 'list') {
      return `${this.listAddrs.length}${this.listDone ? '' : '+'} 项`;
    }
    if (this.root.kind === 'array') return `${this.root.count ?? 0} 项`;
    return `${this.root.type.size} B`;
  }

  /** 下标跳转：把该下标对应的行加载出来，返回它的 path。 */
  locateIndex(index: number): { path?: string; error?: string } {
    if (!Number.isInteger(index) || index < 0) return { error: '下标必须是非负整数' };
    if (this.root.kind === 'array') {
      const count = this.root.count ?? 0;
      if (index >= count) return { error: `下标 ${index} 越界（共 ${count} 项）` };
      const need = Math.min(count, Math.ceil((index + 1) / TREE_PAGE) * TREE_PAGE);
      const loaded = this.pages.get(this.rootPath) ?? TREE_PAGE;
      if (need > loaded) {
        this.pages.set(this.rootPath, need);
        this.cache.delete(this.rootPath);
      }
      return { path: `${this.rootPath}[${index}]` };
    }
    if (this.root.kind === 'list') {
      if (index >= this.listMax) return { error: `下标 ${index} 超过链表上限 ${this.listMax}` };
      this.walkList(index + 1);
      if (index >= this.listAddrs.length) {
        return { error: this.listError ?? (this.listCycle ? '链表有环，已停止' : `链表只有 ${this.listAddrs.length} 项`) };
      }
      const loaded = this.pages.get(this.rootPath) ?? TREE_PAGE;
      if (index + 1 > loaded) {
        this.pages.set(this.rootPath, Math.ceil((index + 1) / TREE_PAGE) * TREE_PAGE);
        this.cache.delete(this.rootPath);
      }
      return { path: `${this.rootPath}[${index}]` };
    }
    return { error: '当前根是单个结构体，没有下标' };
  }

  /* ------------------------------------------------------------- 根与行 */

  private makeRootRow(): TreeRow {
    const { type, addr, kind } = this.root;
    const valueText = kind === 'struct' ? `@${toHex(addr)}` : kind === 'array'
      ? `[${this.root.count ?? 0}]`
      : `@${toHex(addr)}`;
    const row: TreeRow = {
      path: this.rootPath,
      depth: 0,
      label: this.root.label ?? type.name,
      typeText: type.name,
      addr,
      offset: 0,
      size: type.size,
      valueText,
      expandable: kind === 'struct' ? type.fields.length > 0 : (kind === 'array' ? (this.root.count ?? 0) > 0 : true),
      tone: 'root',
    };
    this.builders.set(row.path, () => {
      if (kind === 'struct') return this.instanceRows(row.path, type, addr, 1);
      if (kind === 'array') {
        return this.arrayRows(row.path, type, addr, this.root.count ?? 0, this.root.stride ?? type.size, 1);
      }
      return this.listRows(row.path, 1);
    });
    return row;
  }

  /** 结构体字段（浅解码：嵌套 record/array 只给一行，展开时才读）。 */
  private instanceRows(path: string, type: TypeDef, addr: number, depth: number): TreeRow[] {
    const mem = this.root.mem;
    if (!mem.contains(addr, Math.max(1, type.size))) {
      return [this.noteRow(`${path}~err`, depth, `地址 ${toHex(addr)} 不在缓冲区 [${toHex(mem.base)}, ${toHex(mem.end)}) 内`, 'error')];
    }

    // 先浅解码所有标量，transform 的 self 参数因此拿到兄弟字段
    const raw: Record<string, unknown> = {};
    for (const f of type.fields) {
      if (f.kind === 'record' || f.kind === 'array') continue;
      try {
        raw[f.name] = decodeFieldRaw(mem, this.compat, type, f, addr);
      } catch {
        raw[f.name] = null;
      }
    }

    return type.fields.map((f) => this.fieldRow(path, type, addr, f, raw, depth));
  }

  private fieldRow(
    parent: string, type: TypeDef, addr: number, f: FieldDef, raw: Record<string, unknown>, depth: number,
  ): TreeRow {
    const mem = this.root.mem;
    const at = addr + f.offset;
    const path = `${parent}.${f.name}`;
    const size = fieldSize(f, this.compat);
    const typeText = f.kind === 'record' || f.kind === 'array' ? (f.of ?? f.kind) : f.kind;
    const rawValue = raw[f.name];
    let value: unknown = rawValue;
    let error: string | undefined;
    if (f.transform) {
      try {
        value = f.transform(rawValue, {
          v: rawValue,
          addr: at,
          self: raw,
          mem: packMemApi(mem),
          consts: this.root.pack.constants,
          type: type.name,
          field: f.name,
        });
      } catch (e) {
        error = msgOf(e);
      }
    }

    if (f.kind === 'record' || f.kind === 'array') {
      const count = f.kind === 'array' ? (f.count ?? 0) : 0;
      const elem = f.of ? this.root.pack.types[f.of] : undefined;
      const row: TreeRow = {
        path,
        depth,
        label: f.label ?? f.name,
        typeText,
        addr: at,
        offset: at - this.root.addr,
        size,
        valueText: f.kind === 'array' ? `[${count}]` : `@${toHex(at)}`,
        expandable: f.kind === 'record' ? !!elem && elem.size > 0 : count > 0,
        tone: 'field',
      };
      if (f.kind === 'record' && elem) {
        this.builders.set(path, () => this.instanceRows(path, elem, at, depth + 1));
      } else if (f.kind === 'array') {
        const stride = elem ? elem.size : kindSize((f.of ?? 'u8') as FieldKind, this.root.pack.pointerSize);
        this.builders.set(path, () => this.arrayRows(path, elem, at, count, stride, depth + 1));
      }
      return row;
    }

    const valueText = error
      ? `⚠ ${error}`
      : f.transform
        ? formatValue(f, value, typeof value === 'number')
        : formatPackValue(f, value);
    const rawText = f.transform && !error ? formatValue(f, rawValue) : undefined;

    // 指针/地址字段：能定位到合法地址时，允许在树里展开目标结构、或在图上解析。
    // 除了 ptr 与 follow，带 hex 格式的整数字段（NVMe 的 PRP1/MPTR 之类）也按地址处理。
    let refAddr: number | undefined;
    let refTypeName: string | undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const followName = f.follow === 'self' ? type.name : f.follow;
      const followType = followName ? this.root.pack.types[followName] : undefined;
      if (followType && mem.contains(value, Math.max(1, followType.size))) {
        refAddr = value;
        refTypeName = followType.name;
      } else if ((f.kind === 'ptr' || f.format === 'hex') && mem.contains(value, 1)) {
        refAddr = value;
      }
    }

    const row: TreeRow = {
      path,
      depth,
      label: f.label ?? f.name,
      typeText,
      addr: at,
      offset: at - this.root.addr,
      size,
      valueText,
      rawText,
      ref: refAddr != null ? { addr: refAddr, hint: `${type.name}.${f.name}` } : undefined,
      expandable: !!refTypeName,
      tone: error ? 'error' : 'field',
    };
    if (refTypeName && refAddr != null) {
      const target = this.root.pack.types[refTypeName];
      this.builders.set(path, () => this.instanceRows(`${path}>${refTypeName}`, target, refAddr!, depth + 1));
    }
    return row;
  }

  /** 数组元素；超出已加载数量的部分用「加载更多」行代替。 */
  private arrayRows(
    path: string, elem: TypeDef | undefined, base: number, count: number, stride: number, depth: number,
  ): TreeRow[] {
    const loaded = Math.min(count, this.pages.get(path) ?? TREE_PAGE);
    const rows: TreeRow[] = [];
    for (let i = 0; i < loaded; i++) {
      const at = base + i * stride;
      const row: TreeRow = {
        path: `${path}[${i}]`,
        depth,
        label: `[${i}]`,
        typeText: elem?.name ?? 'scalar',
        addr: at,
        offset: at - this.root.addr,
        size: stride,
        valueText: elem ? `@${toHex(at)}` : this.scalarAt(at, stride),
        expandable: !!elem,
        tone: 'element',
      };
      if (elem) this.builders.set(row.path, () => this.instanceRows(row.path, elem, at, depth + 1));
      rows.push(row);
    }
    if (loaded < count) rows.push(this.moreRow(path, depth, `已显示 ${loaded} / ${count}`));
    return rows;
  }

  private listRows(path: string, depth: number): TreeRow[] {
    const loaded = Math.min(this.listMax, this.pages.get(path) ?? TREE_PAGE);
    this.walkList(loaded);
    const type = this.root.type;
    const rows: TreeRow[] = this.listAddrs.map((addr, i) => {
      const row: TreeRow = {
        path: `${path}[${i}]`,
        depth,
        label: `[${i}]`,
        typeText: type.name,
        addr,
        offset: addr - this.root.addr,
        size: type.size,
        valueText: `@${toHex(addr)}`,
        expandable: type.fields.length > 0,
        tone: 'element',
      };
      this.builders.set(row.path, () => this.instanceRows(row.path, type, addr, depth + 1));
      return row;
    });
    if (!this.listDone && this.listAddrs.length >= loaded) {
      const total = this.listAddrs.length;
      rows.push(this.moreRow(path, depth, `${total} 条${this.listMax ? ` / 上限 ${this.listMax}` : ''}`));
    }
    if (this.listCycle) rows.push(this.noteRow(`${path}~cycle`, depth, '检测到回环，已停止遍历', 'note'));
    if (this.listError) rows.push(this.noteRow(`${path}~err`, depth, this.listError, 'error'));
    return rows;
  }

  private walkList(limit: number): void {
    const type = this.root.type;
    while (!this.listDone && this.listAddrs.length < limit) {
      if (this.listAddrs.length >= this.listMax) { this.listDone = true; return; }
      const addr = this.listCursor;
      if (this.listSeen.has(addr)) { this.listCycle = true; this.listDone = true; return; }
      let entry: EntryView;
      try {
        entry = this.reader.read(type.name, addr, this.listAddrs.length);
      } catch (e) {
        this.listError = msgOf(e);
        this.listDone = true;
        return;
      }
      this.listSeen.add(addr);
      this.listAddrs.push(addr);
      if (!this.root.next) { this.listDone = true; return; }
      let next: unknown;
      try {
        next = this.root.next(entry, this.reader.ctx);
      } catch (e) {
        this.listError = `next() 失败：${msgOf(e)}`;
        this.listDone = true;
        return;
      }
      if (next == null) { this.listDone = true; return; }
      const n = typeof next === 'number' ? next : Number(next);
      if (!Number.isFinite(n)) {
        this.listError = `next 返回了非数字：${String(next)}`;
        this.listDone = true;
        return;
      }
      if (this.listNulls.has(n)) { this.listDone = true; return; }
      this.listCursor = n;
    }
  }

  private scalarAt(addr: number, size: number): string {
    try {
      const kind: FieldKind = size === 1 ? 'u8' : size === 2 ? 'u16' : size === 4 ? 'u32' : 'u64';
      const f = { name: '', offset: 0, kind } as FieldDef;
      const v = decodeFieldRaw(this.root.mem, this.compat, this.root.type, f, addr);
      return formatPackValue(f, v);
    } catch {
      return '—';
    }
  }

  private moreRow(path: string, depth: number, label: string): TreeRow {
    return {
      path: `${path}~more`,
      depth,
      label: '加载更多…',
      typeText: '',
      addr: 0,
      offset: 0,
      size: 0,
      valueText: label,
      expandable: false,
      tone: 'more',
      more: true,
      moreOf: path,
    };
  }

  private noteRow(path: string, depth: number, text: string, tone: 'note' | 'error'): TreeRow {
    return {
      path,
      depth,
      label: text,
      typeText: '',
      addr: 0,
      offset: 0,
      size: 0,
      valueText: '',
      expandable: false,
      tone,
    };
  }
}

function matches(row: TreeRow, q: string): boolean {
  return row.label.toLowerCase().includes(q)
    || row.typeText.toLowerCase().includes(q)
    || row.valueText.toLowerCase().includes(q)
    || row.path.toLowerCase().includes(q);
}
