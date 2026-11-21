/**
 * Pure, immutable authoring operations for the structure designer.
 *
 * Every operation returns a candidate `layouts` array plus diagnostics. The
 * caller decides whether to commit through the document history. Operations
 * never touch React or the document store.
 */

import {
  analyzeLayouts, measureLayout, LAYOUT_FIELD_TYPES, MAX_LAYOUT_FIELDS, MAX_LAYOUTS,
  type BinaryLayout, type LayoutField, type LayoutKind, type LayoutProblem,
} from '../layouts';
import type { LayoutUsageIndex } from './usage';

export interface DesignerModel {
  layouts: BinaryLayout[];
  currentId: string;
}

export interface OpResult {
  ok: boolean;
  layouts?: BinaryLayout[];
  layout?: BinaryLayout;
  problems?: LayoutProblem[];
  message?: string;
  selectedIds?: string[];
}

export interface FieldInput {
  kind: LayoutKind;
  name?: string;
  of?: string;
  count?: number;
  size?: number;
  unit?: number;
  bit?: number;
  width?: number;
  values?: Record<string, string>;
  role?: LayoutField['role'];
  endian?: 'little' | 'big';
}

export interface FieldPatch {
  name?: string;
  kind?: LayoutKind;
  at?: string | null;
  size?: string | null;
  count?: string | null;
  of?: string | null;
  endian?: 'little' | 'big' | null;
  unit?: string | null;
  bit?: string | null;
  width?: string | null;
  values?: Record<string, string> | null;
  role?: LayoutField['role'] | null;
}

export interface FieldClipItem {
  field: LayoutField;
  offset: number;
}

export interface FieldClip {
  items: FieldClipItem[];
}

export interface LayoutPatch {
  name?: string;
  endian?: 'little' | 'big';
  union?: boolean;
  size?: string | null;
}

function currentLayout(model: DesignerModel): BinaryLayout | undefined {
  return model.layouts.find((l) => l.id === model.currentId) ?? model.layouts[0];
}

function withLayout(model: DesignerModel, layout: BinaryLayout): BinaryLayout[] {
  return model.layouts.map((l) => l.id === layout.id ? layout : l);
}

function errorCategory(p: LayoutProblem): string {
  return `${p.code}|${p.layoutId}`;
}

export interface LayoutReview {
  ok: boolean;
  problems: LayoutProblem[];
  message?: string;
}

/**
 * Shared commit gate for the designer and the document layer.
 *
 * An already-invalid layout stays repairable: an edit may keep or reduce the
 * error count as long as it does not introduce a new error category. A valid
 * layout cannot accept any error at all.
 */
export function reviewLayouts(
  beforeLayouts: readonly BinaryLayout[],
  afterLayouts: readonly BinaryLayout[],
): LayoutReview {
  const before = analyzeLayouts(beforeLayouts);
  const after = analyzeLayouts(afterLayouts);
  const beforeErrors = before.problems.filter(p => p.severity === 'error');
  const afterErrors = after.problems.filter(p => p.severity === 'error');
  const beforeCategories = new Set(beforeErrors.map(errorCategory));
  const newCategory = afterErrors.find(p => !beforeCategories.has(errorCategory(p)));
  const grew = afterErrors.length > beforeErrors.length;
  if (newCategory || grew) {
    return {
      ok: false,
      problems: after.problems,
      message: (newCategory ?? afterErrors[0])?.message ?? '修改会引入新的布局错误',
    };
  }
  return { ok: true, problems: after.problems };
}

function finish(
  model: DesignerModel,
  nextLayouts: BinaryLayout[],
  currentId: string,
  message?: string,
  selectedIds?: string[],
): OpResult {
  const review = reviewLayouts(model.layouts, nextLayouts);
  const layout = nextLayouts.find((l) => l.id === currentId);
  if (!review.ok) {
    return {
      ok: false, layouts: nextLayouts, layout, problems: review.problems,
      message: message ?? review.message,
    };
  }
  return { ok: true, layouts: nextLayouts, layout, problems: review.problems, ...(selectedIds ? { selectedIds } : {}) };
}

export function nextFieldId(layout: BinaryLayout): string {
  const used = new Set(layout.fields.map((f) => f.id));
  let n = 1;
  while (used.has(`f${n}`)) n += 1;
  return `f${n}`;
}

export function nextLayoutId(layouts: readonly BinaryLayout[]): string {
  let max = 0;
  for (const layout of layouts) {
    const m = /^l(\d+)$/.exec(layout.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  const used = new Set(layouts.map((l) => l.id));
  while (used.has(`l${n}`)) n += 1;
  return `l${n}`;
}

export function uniqueName(layout: BinaryLayout, base: string): string {
  const root = base.trim() || 'field';
  const used = new Set(layout.fields.map((f) => f.name));
  if (!used.has(root)) return root;
  let n = 2;
  while (used.has(`${root}${n}`)) n += 1;
  return `${root}${n}`;
}

export function uniqueLayoutName(layouts: readonly BinaryLayout[], base: string): string {
  const root = base.trim() || '布局';
  const used = new Set(layouts.map((l) => l.name));
  if (!used.has(root)) return root;
  let n = 2;
  while (used.has(`${root}${n}`)) n += 1;
  return `${root}${n}`;
}

function normalizeOf(model: DesignerModel, of: string | undefined): string | undefined {
  if (!of) return undefined;
  if (of.startsWith('layout/')) return of;
  if (model.layouts.some((l) => l.id === of)) return `layout/${of}`;
  return of;
}

function defaultFieldName(spec: FieldInput, model: DesignerModel): string {
  if (spec.name?.trim()) return spec.name.trim();
  if (spec.kind === 'record' || spec.kind === 'array') {
    const target = spec.of?.replace(/^layout\//, '');
    const layout = model.layouts.find((l) => l.id === target);
    return layout?.name?.toLowerCase() || spec.kind;
  }
  if (spec.kind === 'string') return 'text';
  if (spec.kind === 'bits') return 'bit';
  return spec.kind;
}

function makeField(model: DesignerModel, spec: FieldInput, offset: number): { field?: LayoutField; error?: string } {
  if (!LAYOUT_FIELD_TYPES.includes(spec.kind)) return { error: `未知字段类型：${spec.kind}` };
  const layout = currentLayout(model);
  if (!layout) return { error: '当前没有可编辑布局' };
  if (layout.fields.length >= MAX_LAYOUT_FIELDS) return { error: `字段数不能超过 ${MAX_LAYOUT_FIELDS}` };
  const of = normalizeOf(model, spec.of);
  if (spec.kind === 'record' && !of) return { error: '请选择嵌套布局目标' };
  if (spec.kind === 'array' && !of) return { error: '请选择数组元素类型' };
  const field: LayoutField = {
    id: nextFieldId(layout),
    name: uniqueName(layout, defaultFieldName(spec, model)),
    kind: spec.kind,
    at: String(Math.max(0, Math.round(offset))),
    ...(spec.endian ? { endian: spec.endian } : {}),
    ...(spec.role ? { role: spec.role } : {}),
    ...(spec.values ? { values: { ...spec.values } } : {}),
  };
  if (spec.kind === 'bits') {
    field.bit = String(Math.max(0, spec.bit ?? 0));
    field.width = String(Math.max(1, spec.width ?? 1));
    field.unit = String(spec.unit ?? 1);
  } else if (spec.kind === 'string' || spec.kind === 'bytes') {
    field.size = String(Math.max(1, spec.size ?? 4));
  } else if (spec.kind === 'array') {
    field.of = of;
    field.count = String(Math.max(1, spec.count ?? 2));
  } else if (spec.kind === 'record') {
    field.of = of;
  }
  return { field };
}

export function createField(model: DesignerModel, spec: FieldInput, offset: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const made = makeField(model, spec, offset);
  if (!made.field) return { ok: false, message: made.error ?? '无法创建字段' };
  const next = { ...layout, fields: [...layout.fields, made.field] };
  const result = finish(model, withLayout(model, next), layout.id, undefined, [made.field.id]);
  return result;
}

function applyFieldPatch(model: DesignerModel, source: LayoutField, patch: FieldPatch): { field?: LayoutField; error?: string } {
  const field: LayoutField = { ...source };
  if (patch.kind !== undefined) {
    if (!LAYOUT_FIELD_TYPES.includes(patch.kind)) return { error: `未知字段类型：${patch.kind}` };
    field.kind = patch.kind;
    if (patch.kind === 'bits') {
      field.bit = field.bit ?? '0';
      field.width = field.width ?? '1';
      field.unit = field.unit ?? '1';
      delete field.size;
      delete field.count;
      delete field.of;
    } else if (patch.kind === 'string' || patch.kind === 'bytes') {
      field.size = field.size ?? '4';
      delete field.bit;
      delete field.width;
      delete field.unit;
      delete field.count;
      delete field.of;
    } else if (patch.kind === 'record' || patch.kind === 'array') {
      field.of = field.of ?? '';
      if (patch.kind === 'array') field.count = field.count ?? '2'; else delete field.count;
      delete field.bit;
      delete field.width;
      delete field.unit;
      delete field.size;
    } else {
      delete field.bit;
      delete field.width;
      delete field.unit;
      delete field.size;
      delete field.count;
      delete field.of;
    }
  }

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { error: '字段名不能为空' };
    field.name = name;
  }
  if (patch.at !== undefined) {
    if (patch.at === null || patch.at.trim() === '') delete field.at;
    else field.at = patch.at.trim();
  }
  for (const key of ['size', 'count', 'of', 'endian', 'unit', 'bit', 'width', 'values', 'role'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      delete field[key];
    } else if (key === 'of') {
      field.of = normalizeOf(model, String(value));
    } else if (key === 'values') {
      field.values = { ...(value as Record<string, string>) };
    } else {
      (field as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return { field };
}

export function setFieldProp(model: DesignerModel, id: string, patch: FieldPatch): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const index = layout.fields.findIndex((f) => f.id === id);
  if (index < 0) return { ok: false, message: '字段不存在' };
  const applied = applyFieldPatch(model, layout.fields[index], patch);
  if (!applied.field) return { ok: false, message: applied.error ?? '字段修改无效' };
  const next = { ...layout, fields: layout.fields.map((f, i) => i === index ? applied.field! : f) };
  return finish(model, withLayout(model, next), layout.id);
}

export function patchFields(model: DesignerModel, ids: readonly string[], patch: FieldPatch): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const wanted = new Set(ids);
  if (!wanted.size) return { ok: false, message: '请先选择字段' };
  const fields: LayoutField[] = [];
  for (const field of layout.fields) {
    if (!wanted.has(field.id)) { fields.push(field); continue; }
    const applied = applyFieldPatch(model, field, patch);
    if (!applied.field) return { ok: false, message: applied.error ?? '字段修改无效' };
    fields.push(applied.field);
  }
  return finish(model, withLayout(model, { ...layout, fields }), layout.id);
}

export function moveFields(model: DesignerModel, ids: readonly string[], target: number, anchorId?: string): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const unique = Array.from(new Set(ids));
  if (!unique.length) return { ok: false, message: '请先选择字段' };
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const targetOffset = Math.max(0, Math.round(target));
  if (unique.length > 1) {
    const group = measured.bitGroups.find(g => unique.every(id => g.members.some(m => m.id === id)));
    if (group) {
      if (targetOffset === group.offset) return { ok: false, message: '位置未变化' };
      const memberIds = new Set(group.members.map(m => m.id));
      const next = {
        ...layout,
        fields: layout.fields.map(f => memberIds.has(f.id) ? { ...f, at: String(targetOffset) } : f),
      };
      return finish(model, withLayout(model, next), layout.id);
    }
    const positioned = unique.map(id => measured.fields.find(f => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f);
    if (positioned.length !== unique.length || positioned.some(f => f.kind === 'bits')) {
      return { ok: false, message: '多选拖动需要字段类型一致；位域和字节字段不能一起拖动' };
    }
    const kinds = new Set(positioned.map(f => f.kind));
    const targets = new Set(positioned.map(f => f.of ?? ''));
    if (kinds.size > 1 || targets.size > 1) {
      return { ok: false, message: '多选拖动只支持同类型字段；请分开拖动不同大小的标量或不同目标的嵌套字段' };
    }
    const anchor = measured.fields.find(f => f.id === (anchorId ?? unique[0]));
    if (!anchor) return { ok: false, message: '找不到拖动锚点' };
    const delta = targetOffset - anchor.offset;
    if (!delta) return { ok: false, message: '位置未变化' };
    if (positioned.some(f => f.offset + delta < 0)) return { ok: false, message: '拖动后字段会小于偏移 0' };
    const wanted = new Set(unique);
    const next = {
      ...layout,
      fields: layout.fields.map(f => {
        if (!wanted.has(f.id)) return f;
        const p = measured.fields.find(x => x.id === f.id)!;
        return { ...f, at: String(p.offset + delta) };
      }),
    };
    return finish(model, withLayout(model, next), layout.id);
  }
  const id = unique[0];
  const field = layout.fields.find(f => f.id === id);
  const positioned = measured.fields.find(f => f.id === id);
  if (!field || !positioned) return { ok: false, message: '字段不存在' };
  if (field.kind === 'bits') {
    return { ok: false, message: '位域请在位视图中拖动；整组移动请选择位域组' };
  }
  if (targetOffset === positioned.offset) return { ok: false, message: '位置未变化' };
  const next = {
    ...layout,
    fields: layout.fields.map(f => f.id === id ? { ...f, at: String(targetOffset) } : f),
  };
  return finish(model, withLayout(model, next), layout.id);
}

export function resizeField(model: DesignerModel, id: string, size: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const field = layout.fields.find(f => f.id === id);
  if (!field) return { ok: false, message: '字段不存在' };
  if (field.kind !== 'string' && field.kind !== 'bytes') return { ok: false, message: '只有字符串和字节字段可以拖动改长度' };
  const nextSize = Math.max(1, Math.round(size));
  if (String(nextSize) === field.size) return { ok: false, message: '长度未变化' };
  const next = {
    ...layout,
    fields: layout.fields.map(f => f.id === id ? { ...f, size: String(nextSize) } : f),
  };
  return finish(model, withLayout(model, next), layout.id);
}

export function reorderFields(model: DesignerModel, ids: readonly string[], targetIndex: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const selected = Array.from(new Set(ids));
  if (!selected.length) return { ok: false, message: '请先选择字段' };
  const moving = layout.fields.filter(f => selected.includes(f.id));
  if (moving.some(f => f.at !== undefined && f.at !== '')) {
    return { ok: false, message: '只有自动字段可以用重排手柄调整顺序' };
  }
  const rest = layout.fields.filter(f => !selected.includes(f.id));
  const index = Math.max(0, Math.min(rest.length, Math.round(targetIndex)));
  const fields = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if (fields.every((f, i) => f === layout.fields[i])) return { ok: false, message: '顺序未变化' };
  return finish(model, withLayout(model, { ...layout, fields }), layout.id);
}

export function anchorFields(model: DesignerModel, ids: readonly string[]): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const wanted = new Set(ids);
  const bitsGroups = measured.bitGroups.filter(g => g.members.some(m => wanted.has(m.id)));
  let changed = false;
  const nextFields = layout.fields.map(f => {
    if (wanted.has(f.id)) {
      const positioned = measured.fields.find(p => p.id === f.id);
      if (!positioned) return f;
      const at = String(positioned.offset);
      if (f.at === at) return f;
      changed = true;
      return { ...f, at };
    }
    return f;
  });
  for (const group of bitsGroups) {
    for (const member of group.members) {
      const index = nextFields.findIndex(f => f.id === member.id);
      if (index >= 0 && nextFields[index].at !== String(group.offset)) {
        nextFields[index] = { ...nextFields[index], at: String(group.offset) };
        changed = true;
      }
    }
  }
  if (!changed) return { ok: false, message: '字段已经锚定' };
  return finish(model, withLayout(model, { ...layout, fields: nextFields }), layout.id);
}

export function restoreAuto(model: DesignerModel, ids: readonly string[]): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const wanted = new Set(ids);
  const bitsGroups = measured.bitGroups.filter(g => g.members.some(m => wanted.has(m.id)));
  const all = new Set(wanted);
  for (const group of bitsGroups) for (const member of group.members) all.add(member.id);
  let changed = false;
  const fields = layout.fields.map(f => {
    if (!all.has(f.id) || f.at === undefined || f.at === '') return f;
    changed = true;
    const copy = { ...f };
    delete copy.at;
    return copy;
  });
  if (!changed) return { ok: false, message: '没有可恢复自动的字段' };
  return finish(model, withLayout(model, { ...layout, fields }), layout.id);
}

export function deleteFields(model: DesignerModel, ids: readonly string[]): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const wanted = new Set(ids);
  if (!wanted.size) return { ok: false, message: '请先选择字段' };
  const fields = layout.fields.filter(f => !wanted.has(f.id));
  if (fields.length === layout.fields.length) return { ok: false, message: '字段不存在' };
  return finish(model, withLayout(model, { ...layout, fields }), layout.id);
}

function contentEnd(model: DesignerModel, layout: BinaryLayout): number {
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  return measured.fields.reduce((max, f) => Math.max(max, f.offset + f.size), 0);
}

function fieldSizeOf(field: LayoutField): number {
  if (field.kind === 'bits') return Math.max(1, Number(field.unit ?? 1));
  if (field.kind === 'string' || field.kind === 'bytes') return Math.max(1, Number(field.size ?? 1));
  if (field.kind === 'array') return Math.max(1, Number(field.count ?? 1));
  return 1;
}

export function duplicateFields(model: DesignerModel, ids: readonly string[]): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const wanted = new Set(ids);
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const selected = layout.fields
    .map((field, index) => ({ field, index, positioned: measured.fields.find(p => p.id === field.id) }))
    .filter(x => wanted.has(x.field.id) && x.positioned);
  if (!selected.length) return { ok: false, message: '请先选择字段' };
  if (layout.fields.length + selected.length > MAX_LAYOUT_FIELDS) {
    return { ok: false, message: `字段数不能超过 ${MAX_LAYOUT_FIELDS}` };
  }
  const minOffset = Math.min(...selected.map(x => x.positioned!.offset));
  const base = contentEnd(model, layout);
  const required = base + Math.max(...selected.map(x => x.positioned!.offset - minOffset + x.positioned!.size));
  if (layout.size !== undefined && layout.size !== '' && Number(layout.size) < required) {
    return { ok: false, message: '没有足够空间放置副本；请先增大布局长度或删除字段' };
  }
  const added: LayoutField[] = [];
  const nextFields = [...layout.fields];
  for (const item of selected) {
    const copy: LayoutField = {
      ...item.field,
      ...(item.field.values ? { values: { ...item.field.values } } : {}),
      id: nextFieldId({ ...layout, fields: nextFields }),
      name: uniqueName({ ...layout, fields: nextFields }, item.field.name),
      at: String(base + (item.positioned!.offset - minOffset)),
    };
    nextFields.push(copy);
    added.push(copy);
  }
  return finish(model, withLayout(model, { ...layout, fields: nextFields }), layout.id, undefined, added.map(f => f.id));
}

export function copyFields(model: DesignerModel, ids: readonly string[]): FieldClip | null {
  const layout = currentLayout(model);
  if (!layout) return null;
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const wanted = new Set(ids);
  const items = layout.fields
    .map(field => {
      const positioned = measured.fields.find(p => p.id === field.id);
      return positioned && wanted.has(field.id) ? { field: { ...field }, offset: positioned.offset } : null;
    })
    .filter((x): x is FieldClipItem => !!x);
  return items.length ? { items } : null;
}

export function pasteFields(model: DesignerModel, clip: FieldClip | null, targetOffset?: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  if (!clip?.items.length) return { ok: false, message: '剪贴板没有字段' };
  if (layout.fields.length + clip.items.length > MAX_LAYOUT_FIELDS) {
    return { ok: false, message: `字段数不能超过 ${MAX_LAYOUT_FIELDS}` };
  }
  const minOffset = Math.min(...clip.items.map(i => i.offset));
  const base = targetOffset ?? contentEnd(model, layout);
  const required = base + Math.max(...clip.items.map(i => i.offset - minOffset + fieldSizeOf(i.field)));
  if (layout.size !== undefined && layout.size !== '' && Number(layout.size) < required) {
    return { ok: false, message: '没有足够空间粘贴字段；请先增大布局长度或选择其他位置' };
  }
  const fields = [...layout.fields];
  const added: LayoutField[] = [];
  for (const item of clip.items) {
    const field: LayoutField = {
      ...item.field,
      ...(item.field.values ? { values: { ...item.field.values } } : {}),
      id: nextFieldId({ ...layout, fields }),
      name: uniqueName({ ...layout, fields }, item.field.name),
      at: String(base + (item.offset - minOffset)),
    };
    fields.push(field);
    added.push(field);
  }
  return finish(model, withLayout(model, { ...layout, fields }), layout.id, undefined, added.map(f => f.id));
}

export function moveBit(model: DesignerModel, id: string, bit: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const field = layout.fields.find(f => f.id === id);
  if (!field || field.kind !== 'bits') return { ok: false, message: '字段不是位域' };
  const measured = measureLayout(layout, (x) => model.layouts.find(l => l.id === x));
  const group = measured.bitGroups.find(g => g.members.some(m => m.id === id));
  if (!group) return { ok: false, message: '位域组不存在' };
  const width = Number(field.width ?? 1);
  const nextBit = Math.max(0, Math.min(group.unit * 8 - width, Math.round(bit)));
  if (nextBit === Number(field.bit ?? 0)) return { ok: false, message: '位置未变化' };
  const next = { ...layout, fields: layout.fields.map(f => f.id === id ? { ...f, bit: String(nextBit) } : f) };
  return finish(model, withLayout(model, next), layout.id);
}

export function resizeBit(model: DesignerModel, id: string, width: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const field = layout.fields.find(f => f.id === id);
  if (!field || field.kind !== 'bits') return { ok: false, message: '字段不是位域' };
  const measured = measureLayout(layout, (x) => model.layouts.find(l => l.id === x));
  const group = measured.bitGroups.find(g => g.members.some(m => m.id === id));
  if (!group) return { ok: false, message: '位域组不存在' };
  const nextWidth = Math.max(1, Math.min(group.unit * 8 - Number(field.bit ?? 0), Math.round(width)));
  if (nextWidth === Number(field.width ?? 1)) return { ok: false, message: '位宽未变化' };
  const next = { ...layout, fields: layout.fields.map(f => f.id === id ? { ...f, width: String(nextWidth) } : f) };
  return finish(model, withLayout(model, next), layout.id);
}

export function setBitRange(model: DesignerModel, id: string, bit: number, width: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  const field = layout.fields.find(f => f.id === id);
  if (!field || field.kind !== 'bits') return { ok: false, message: '字段不是位域' };
  const measured = measureLayout(layout, (x) => model.layouts.find(l => l.id === x));
  const group = measured.bitGroups.find(g => g.members.some(m => m.id === id));
  if (!group) return { ok: false, message: '位域组不存在' };
  const b = Math.max(0, Math.min(group.unit * 8 - 1, Math.round(bit)));
  const w = Math.max(1, Math.min(group.unit * 8 - b, Math.round(width)));
  if (b === Number(field.bit ?? 0) && w === Number(field.width ?? 1)) return { ok: false, message: '位域未变化' };
  const next = { ...layout, fields: layout.fields.map(f => f.id === id ? { ...f, bit: String(b), width: String(w) } : f) };
  return finish(model, withLayout(model, next), layout.id);
}

export function setBitGroupUnit(model: DesignerModel, groupKey: string, unit: number): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  if (![1, 2, 4, 8].includes(unit)) return { ok: false, message: '存储宽度必须是 1、2、4 或 8 字节' };
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const group = measured.bitGroups.find(g => g.key === groupKey);
  if (!group) return { ok: false, message: '位域组不存在' };
  const need = Math.max(...group.members.map(m => (m.bits?.offset ?? 0) + (m.bits?.width ?? 1)));
  if (need > unit * 8) return { ok: false, message: `成员需要 ${need} bit，放不进 ${unit} B` };
  const ids = new Set(group.members.map(m => m.id));
  const next = {
    ...layout,
    fields: layout.fields.map(f => ids.has(f.id) ? { ...f, unit: String(unit) } : f),
  };
  return finish(model, withLayout(model, next), layout.id);
}

export function addBit(model: DesignerModel, groupKey: string, bit?: number, width = 1): OpResult {
  const layout = currentLayout(model);
  if (!layout) return { ok: false, message: '当前没有可编辑布局' };
  if (layout.fields.length >= MAX_LAYOUT_FIELDS) return { ok: false, message: `字段数不能超过 ${MAX_LAYOUT_FIELDS}` };
  const measured = measureLayout(layout, (id) => model.layouts.find(l => l.id === id));
  const group = measured.bitGroups.find(g => g.key === groupKey);
  if (!group) return { ok: false, message: '位域组不存在' };
  const bits = group.unit * 8;
  const w = Math.max(1, Math.min(bits, Math.round(width)));
  let start = bit === undefined ? -1 : Math.max(0, Math.min(bits - w, Math.round(bit)));
  if (start < 0) {
    for (let i = 0; i <= bits - w; i += 1) {
      const free = group.members.every(m => {
        const mb = m.bits?.offset ?? 0;
        const mw = m.bits?.width ?? 1;
        return i + w <= mb || i >= mb + mw;
      });
      if (free) { start = i; break; }
    }
  }
  if (start < 0) return { ok: false, message: '这个存储单元没有足够空位' };
  const field: LayoutField = {
    id: nextFieldId(layout),
    name: uniqueName(layout, 'bit'),
    kind: 'bits', at: String(group.offset), bit: String(start), width: String(w), unit: String(group.unit),
  };
  const next = { ...layout, fields: [...layout.fields, field] };
  return finish(model, withLayout(model, next), layout.id, undefined, [field.id]);
}

export function createLayout(model: DesignerModel, name?: string): OpResult {
  if (model.layouts.length >= MAX_LAYOUTS) return { ok: false, message: `布局数不能超过 ${MAX_LAYOUTS}` };
  const id = nextLayoutId(model.layouts);
  const layout: BinaryLayout = {
    id,
    name: uniqueLayoutName(model.layouts, name || '布局'),
    endian: 'little',
    fields: [{ id: 'f1', name: 'field1', kind: 'u8' }],
  };
  return { ok: true, layouts: [...model.layouts, layout], layout };
}

export function renameLayout(model: DesignerModel, id: string, name: string): OpResult {
  const layout = model.layouts.find(l => l.id === id);
  if (!layout) return { ok: false, message: '布局不存在' };
  const nextName = name.trim();
  if (!nextName) return { ok: false, message: '布局名不能为空' };
  if (nextName === layout.name) return { ok: false, message: '名称未变化' };
  const next = { ...layout, name: nextName };
  return finish(model, withLayout(model, next), id);
}

export function duplicateLayout(model: DesignerModel, id: string): OpResult {
  const source = model.layouts.find(l => l.id === id);
  if (!source) return { ok: false, message: '布局不存在' };
  if (model.layouts.length >= MAX_LAYOUTS) return { ok: false, message: `布局数不能超过 ${MAX_LAYOUTS}` };
  const copy: BinaryLayout = {
    ...source,
    id: nextLayoutId(model.layouts),
    name: uniqueLayoutName(model.layouts, `${source.name} 副本`),
    fields: source.fields.map(f => ({ ...f, ...(f.values ? { values: { ...f.values } } : {}) })),
  };
  return { ok: true, layouts: [...model.layouts, copy], layout: copy };
}

export function deleteLayout(model: DesignerModel, id: string, usage?: LayoutUsageIndex): OpResult {
  const layout = model.layouts.find(l => l.id === id);
  if (!layout) return { ok: false, message: '布局不存在' };
  const refs = usage?.byLayout.get(id) ?? [];
  if (refs.length) {
    return { ok: false, message: `布局仍被 ${refs.length} 处引用，先移除引用后再删除` };
  }
  const layouts = model.layouts.filter(l => l.id !== id);
  const nextId = model.currentId === id ? (layouts[0]?.id ?? '') : model.currentId;
  return finish(model, layouts, nextId);
}

export function setLayoutProp(model: DesignerModel, id: string, patch: LayoutPatch): OpResult {
  const layout = model.layouts.find(l => l.id === id);
  if (!layout) return { ok: false, message: '布局不存在' };
  const next = { ...layout };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false, message: '布局名不能为空' };
    next.name = name;
  }
  if (patch.endian !== undefined) next.endian = patch.endian;
  if (patch.union !== undefined) {
    if (patch.union) next.union = true; else delete next.union;
  }
  if (patch.size !== undefined) {
    if (patch.size === null || patch.size.trim() === '') delete next.size;
    else next.size = patch.size.trim();
  }
  return finish(model, withLayout(model, next), id);
}
