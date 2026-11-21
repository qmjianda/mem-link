import { describe, expect, it } from 'vitest';
import {
  analyzeLayouts, buildLayout, compileLayout, measureLayout,
  type BinaryLayout, type LayoutField,
} from '../src/bp/layouts';
import {
  addBit, anchorFields, copyFields, createField, createLayout, deleteLayout,
  duplicateFields, moveFields, pasteFields, reorderFields, resizeField, restoreAuto, setBitGroupUnit,
  setFieldProp, type DesignerModel,
} from '../src/bp/designer/operations';
import {
  bitAtPoint, bitGeometry, bitRect, canvasGeometry, fitZoom, offsetAtPoint, segments,
} from '../src/bp/designer/geometry';
import { designerHash, parseDesignerHash } from '../src/bp/designer/route';
import { buildLayoutUsage, layoutsEqual } from '../src/bp/designer/usage';
import { createTemplate } from '../src/bp/designer/templates';
import type { BPEdge, BPNode, BlueprintPack } from '../src/bp/types';
import type { LoadedPack } from '../src/bp/docstate';
import type { TypeDef } from '../src/core/pack';

const field = (id: string, name: string, patch: Partial<LayoutField> = {}): LayoutField => ({
  id, name, kind: 'u8', ...patch,
});

const layout = (id: string, name: string, fields: LayoutField[], patch: Partial<BinaryLayout> = {}): BinaryLayout => ({
  id, name, endian: 'little', fields, ...patch,
});

const model = (layouts: BinaryLayout[], currentId = layouts[0].id): DesignerModel => ({ layouts, currentId });

describe('layout build and diagnostics', () => {
  it('computes auto offsets and an empty warning', () => {
    const l = layout('l1', 'T', [field('f1', 'a', { kind: 'u16' }), field('f2', 'b', { kind: 'u32' })]);
    const b = buildLayout(l);
    expect(b.fields.map(f => f.offset)).toEqual([0, 2]);
    expect(b.size).toBe(6);
    const empty = buildLayout(layout('e', 'Empty', []));
    expect(empty.size).toBe(0);
    expect(empty.problems.some(p => p.code === 'EMPTY_LAYOUT' && p.severity === 'warning')).toBe(true);
  });

  it('anchors fields and reports byte overlap', () => {
    const b = buildLayout(layout('l', 'T', [
      field('f1', 'a', { kind: 'u16', at: '0' }),
      field('f2', 'b', { kind: 'u16', at: '1' }),
    ]));
    expect(b.fields[1].offset).toBe(1);
    expect(b.problems.some(p => p.code === 'OVERLAP')).toBe(true);
  });

  it('reports every overlapping span, including a long field that contains others', () => {
    const b = buildLayout(layout('l', 'Nested overlap', [
      field('f1', 'outer', { kind: 'bytes', size: '10', at: '0' }),
      field('f2', 'small', { kind: 'u8', at: '1' }),
      field('f3', 'late', { kind: 'u8', at: '3' }),
    ]));
    expect(b.byteOverlaps).toHaveLength(2);
    expect(b.problems.filter(p => p.code === 'OVERLAP')).toHaveLength(2);
    expect(b.problems.some(p => p.message.includes('outer / late'))).toBe(true);
  });

  it('rejects bit range overlap and keeps adjacent bits legal', () => {
    const bad = layout('l', 'Bits', [
      field('f1', 'kind', { kind: 'bits', at: '0', bit: '0', width: '2', unit: '2' }),
      field('f2', 'active', { kind: 'bits', at: '0', bit: '1', width: '1', unit: '2' }),
    ]);
    const badBuild = buildLayout(bad);
    expect(badBuild.problems.some(p => p.code === 'BIT_OVERLAP')).toBe(true);
    expect(() => compileLayout(bad)).toThrow(/位域重叠/);
    const good = buildLayout(layout('g', 'Bits', [
      field('f1', 'kind', { kind: 'bits', at: '0', bit: '0', width: '2', unit: '2' }),
      field('f2', 'active', { kind: 'bits', at: '0', bit: '2', width: '1', unit: '2' }),
    ]));
    expect(good.problems.some(p => p.code === 'BIT_OVERLAP')).toBe(false);
    expect(good.bitGroups[0].used).toBe(3);
  });

  it('collects nested missing and cycle problems', () => {
    const a = layout('a', 'A', [field('f1', 'b', { kind: 'record', of: 'layout/b' })]);
    const b = layout('b', 'B', [field('f1', 'a', { kind: 'record', of: 'layout/a' })]);
    const analysis = analyzeLayouts([a, b]);
    expect(analysis.problems.some(p => p.code === 'CYCLE')).toBe(true);
    const missing = analyzeLayouts([layout('m', 'M', [field('f1', 'x', { kind: 'record', of: 'layout/nope' })])]);
    expect(missing.problems.some(p => p.code === 'MISSING_LAYOUT')).toBe(true);
  });

  it('bounds huge offsets and sizes instead of scanning them', () => {
    const l = layout('huge', 'Huge', [
      field('f1', 'body', { kind: 'string', at: '1000000000000', size: '9000000' }),
    ]);
    const started = Date.now();
    const b = buildLayout(l);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(b.problems.some(p => p.code === 'BAD_NUMBER' || p.code === 'FIELD_TOO_LARGE')).toBe(true);
    expect(b.size).toBeLessThanOrEqual(1 << 20);
    expect(b.fields[0].size).toBeLessThanOrEqual(1 << 20);
  });

  it('measures multi-row strings without throwing', () => {
    const l = layout('l', 'M', [field('f1', 'body', { kind: 'string', at: '3', size: '8' })]);
    const b = measureLayout(l);
    expect(b.fields[0]).toMatchObject({ offset: 3, size: 8 });
    expect(segments(3, 8, 4)).toEqual([
      { row: 0, col: 3, len: 1, offset: 3, first: true },
      { row: 1, col: 0, len: 4, offset: 4, first: false },
      { row: 2, col: 0, len: 3, offset: 8, first: false },
    ]);
  });
});

describe('designer geometry and route', () => {
  it('maps points to cells and bit positions', () => {
    const geo = canvasGeometry(16, 4);
    expect(geo.rows).toBe(4);
    expect(offsetAtPoint(geo.pad + geo.gutter + geo.cellW / 2, geo.pad + geo.rulerH + geo.rowH / 2, geo)).toBe(0);
    expect(offsetAtPoint(geo.pad + geo.gutter + geo.cellW * 2.5, geo.pad + geo.rulerH + geo.rowH * 1.5, geo)).toBe(6);
    expect(offsetAtPoint(1, 1, geo)).toBeNull();
    const bits = bitGeometry(2, 320, 'lsb');
    expect(bitRect(2, 3, bits)).toEqual({ left: 40, width: 60 });
    expect(bitAtPoint(59, bits)).toBe(2);
    expect(bitGeometry(2, 320, 'msb').bits).toBe(16);
    expect(bitRect(2, 3, bitGeometry(2, 320, 'msb')).left).toBe(220);
    expect(fitZoom(1000, 400, 500, 400)).toBe(0.5);
  });

  it('round-trips designer hashes', () => {
    expect(parseDesignerHash('#design/header/entry')).toEqual({ stack: ['header', 'entry'] });
    expect(parseDesignerHash('#design')).toEqual({ stack: [] });
    expect(parseDesignerHash('#other')).toBeNull();
    expect(designerHash(['header', 'entry'])).toBe('#design/header/entry');
  });
});

describe('designer operations', () => {
  it('creates and moves fields with explicit anchoring', () => {
    const base = layout('l1', 'T', []);
    const m = model([base]);
    const created = createField(m, { kind: 'u16' }, 0);
    expect(created.ok).toBe(true);
    expect(created.layout!.fields[0]).toMatchObject({ kind: 'u16', at: '0' });
    const moved = moveFields({ ...m, layouts: created.layouts! }, [created.selectedIds![0]], 4);
    expect(moved.ok).toBe(true);
    expect(moved.layout!.fields[0].at).toBe('4');
    const anchored = anchorFields({ ...m, layouts: moved.layouts! }, [created.selectedIds![0]]);
    expect(anchored.ok).toBe(false); // already anchored
  });

  it('rejects invalid overlap and supports reorder', () => {
    const l = layout('l', 'T', [
      field('f1', 'a', { kind: 'u16' }),
      field('f2', 'b', { kind: 'u16' }),
    ]);
    const m = model([l]);
    const bad = moveFields(m, ['f2'], 1);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/重叠/);
    const reordered = reorderFields(m, ['f2'], 0);
    expect(reordered.ok).toBe(true);
    expect(reordered.layout!.fields.map(f => f.name)).toEqual(['b', 'a']);
    expect(reordered.layout!.fields.every(f => f.at == null)).toBe(true);
  });

  it('resizes strings and rejects scalar resize', () => {
    const l = layout('l', 'T', [
      field('f1', 'body', { kind: 'string', size: '4' }),
      field('f2', 'n', { kind: 'u16' }),
    ]);
    const resized = resizeField(model([l]), 'f1', 8);
    expect(resized.ok).toBe(true);
    expect(resized.layout!.fields[0].size).toBe('8');
    expect(resizeField(model([l]), 'f2', 1).ok).toBe(false);
  });

  it('adds and moves bits inside a group', () => {
    const l = layout('l', 'Bits', [
      field('f1', 'kind', { kind: 'bits', at: '0', bit: '0', width: '2', unit: '2' }),
    ]);
    const m = model([l]);
    const added = addBit(m, '0:2');
    expect(added.ok).toBe(true);
    const newId = added.selectedIds![0];
    const moved = moveFields({ ...m, layouts: added.layouts! }, [newId], 2);
    // Bits are moved by the bit view, not byte drag.
    expect(moved.ok).toBe(false);
    const unit = setBitGroupUnit({ ...m, layouts: added.layouts! }, '0:2', 1);
    expect(unit.ok).toBe(true);
    expect(unit.layout!.fields.every(f => f.unit === '1')).toBe(true);
  });

  it('keeps bit members in one storage slot after unit changes and restore-auto', () => {
    const l = layout('b', 'Bits', [
      field('f1', 'a', { kind: 'bits', at: '0', bit: '0', width: '2', unit: '2' }),
      field('f2', 'b', { kind: 'bits', at: '0', bit: '2', width: '1', unit: '2' }),
    ]);
    const m = model([l]);
    const changed = setBitGroupUnit(m, '0:2', 4);
    expect(changed.ok).toBe(true);
    const auto = restoreAuto({ ...m, layouts: changed.layouts! }, ['f1', 'f2']);
    expect(auto.ok).toBe(true);
    expect(auto.layout!.fields.every(f => f.at === undefined)).toBe(true);
    const built = buildLayout(auto.layout!);
    expect(built.bitGroups).toHaveLength(1);
    expect(built.bitGroups[0]).toMatchObject({ offset: 0, unit: 4 });
    expect(built.size).toBe(4);

    // Imported declarations only carry the unit on the first member.
    const imported = layout('i', 'Imported', [
      field('f1', 'a', { kind: 'bits', bit: '0', width: '2', unit: '2' }),
      field('f2', 'b', { kind: 'bits', bit: '2', width: '1' }),
    ]);
    const resized = setBitGroupUnit(model([imported]), '0:2', 4);
    expect(resized.ok).toBe(true);
    const importedBuilt = buildLayout(resized.layout!);
    expect(importedBuilt.bitGroups).toHaveLength(1);
    expect(importedBuilt.bitGroups[0]).toMatchObject({ offset: 0, unit: 4 });
    expect(importedBuilt.size).toBe(4);
  });

  it('moves multiple byte fields together and rejects mixed kinds', () => {
    const l = layout('l', 'T', [
      field('f1', 'a', { kind: 'u16' }),
      field('f2', 'b', { kind: 'u16' }),
    ]);
    const moved = moveFields(model([l]), ['f1', 'f2'], 4, 'f1');
    expect(moved.ok).toBe(true);
    expect(moved.layout!.fields.map(f => f.at)).toEqual(['4', '6']);
    const mixed = layout('m', 'M', [
      field('f1', 'a', { kind: 'u8' }),
      field('f2', 'b', { kind: 'u16' }),
    ]);
    const rejected = moveFields(model([mixed]), ['f1', 'f2'], 4, 'f1');
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toMatch(/同类型/);
  });

  it('keeps repairing an invalid layout without new error categories', () => {
    const l = layout('l', 'T', [
      field('f1', 'body', { kind: 'string', size: '4' }),
    ], { size: '2' });
    const resized = setFieldProp(model([l]), 'f1', { size: '3' });
    expect(resized.ok).toBe(true);
    expect(resized.layout!.fields[0].size).toBe('3');
    const introduced = setFieldProp(model([l]), 'f1', { kind: 'record', of: 'layout/nope' });
    expect(introduced.ok).toBe(false);
    expect(introduced.message).toMatch(/不存在/);
  });

  it('duplicates, copies and pastes fields after content', () => {
    const l = layout('l', 'T', [field('f1', 'a', { kind: 'u16', at: '0' })]);
    const m = model([l]);
    const dup = duplicateFields(m, ['f1']);
    expect(dup.ok).toBe(true);
    expect(dup.layout!.fields).toHaveLength(2);
    expect(dup.layout!.fields[1].at).toBe('2');
    const clip = copyFields({ ...m, layouts: dup.layouts! }, ['f1']);
    const pasted = pasteFields({ ...m, layouts: dup.layouts! }, clip);
    expect(pasted.ok).toBe(true);
    expect(pasted.layout!.fields).toHaveLength(3);
  });

  it('guards layout deletion by usage', () => {
    const a = layout('a', 'A', []);
    const b = layout('b', 'B', [field('f1', 'x', { kind: 'record', of: 'layout/a' })]);
    const m = model([a, b], 'a');
    const blocked = deleteLayout(m, 'a', buildLayoutUsage({ layouts: [a, b], nodes: [], edges: [], packs: [] }));
    expect(blocked.ok).toBe(false);
    const free = layout('c', 'C', []);
    const deleted = deleteLayout(model([a, free], 'a'), 'c');
    expect(deleted.ok).toBe(true);
    expect(deleted.layouts!.map(x => x.id)).toEqual(['a']);
  });

  it('creates a valid layout with an initial field', () => {
    const created = createLayout(model([], ''));
    expect(created.ok).toBe(true);
    expect(created.layout!.fields).toHaveLength(1);
    expect(created.layouts).toHaveLength(1);
  });

  it('creates a nested-array template with valid stable references', () => {
    const existing = layout('l1', 'Existing', [field('f1', 'x', { kind: 'u8' })]);
    const added = createTemplate('nested-array', [existing]);
    expect(added).toHaveLength(2);
    const table = added.find(l => l.name.startsWith('Table'))!;
    const entry = added.find(l => l.name.startsWith('Entry'))!;
    expect(table.fields.find(f => f.kind === 'array')?.of).toBe(`layout/${entry.id}`);
    expect(analyzeLayouts([existing, ...added]).problems.filter(p => p.severity === 'error')).toEqual([]);
  });

  it('keeps template bitfields inside one shared storage unit', () => {
    for (const template of ['header', 'bitfield'] as const) {
      const l = createTemplate(template, [])[0];
      const b = buildLayout(l);
      const expectedOffset = template === 'header' ? 8 : 0;
      expect(b.size).toBe(template === 'header' ? 10 : 2);
      expect(b.bitGroups).toHaveLength(1);
      expect(b.bitGroups[0].offset).toBe(expectedOffset);
      expect(b.bitGroups[0].members).toHaveLength(template === 'header' ? 3 : 5);
      expect(b.problems.filter(p => p.severity === 'error')).toEqual([]);
    }
  });
});

describe('layout usage', () => {
  it('collects parent, node, edge and pack references', () => {
    const header = layout('header', 'Header', [
      field('f1', 'count', { kind: 'u16' }),
      field('f2', 'entries', { kind: 'array', of: 'layout/entry', count: '1' }),
    ]);
    const entry = layout('entry', 'Entry', []);
    const node: BPNode = { id: 'n1', packId: '', nodeId: 'structread', x: 0, y: 0, params: { structureId: 'layout/header' } };
    const edge: BPEdge = { id: 'e1', from: { node: 'n1', port: 'field:layout/header:f1' }, to: { node: 'n2', port: 'in' } };
    const type: TypeDef = { name: 'H', size: 0, fields: [], ref: { kind: 'layout', id: 'layout/header' } };
    const pack: BlueprintPack = { name: 'p', endian: 'little', pointerSize: 4, constants: {}, types: { H: type }, nodes: {} };
    const loaded: LoadedPack = { id: 'p1', name: 'P', source: '', pack };
    const usage = buildLayoutUsage({ layouts: [header, entry], nodes: [node], edges: [edge], packs: [loaded] });
    expect(usage.byLayout.get('header')?.map(r => r.kind).sort()).toEqual(['edge', 'node', 'pack']);
    expect(usage.byLayout.get('entry')?.map(r => r.kind)).toEqual(['layout']);
    expect(usage.fieldEdgeCounts.get('header:f1')).toBe(1);
    expect(layoutsEqual([header], [header])).toBe(true);
    expect(layoutsEqual([header], [entry])).toBe(false);
  });
});
