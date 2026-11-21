import { describe, expect, it } from 'vitest';
import { detectAutoParse } from '../src/bp/autoparse';
import type { TypeDef } from '../src/core/pack';
import type { BlueprintPack, BufferValue } from '../src/bp/types';
import { packStructureId } from '../src/bp/structure';

const type = (name: string, size: number): TypeDef => ({ name, size, fields: [] });

function elfPack(includeTables = true): BlueprintPack {
  const types: Record<string, TypeDef> = {
    Elf64Header: type('Elf64Header', 64),
    Elf32Header: type('Elf32Header', 52),
    ProgramHeader64: type('ProgramHeader64', 56),
    ProgramHeader32: type('ProgramHeader32', 32),
    SectionHeader64: type('SectionHeader64', 64),
    SectionHeader32: type('SectionHeader32', 40),
  };
  const nodes: BlueprintPack['nodes'] = {
    header64: { kind: 'struct', type: types.Elf64Header, label: 'ELF64 文件头' },
    header32: { kind: 'struct', type: types.Elf32Header, label: 'ELF32 文件头' },
  };
  if (includeTables) {
    nodes.programHeaders64 = { kind: 'array', type: types.ProgramHeader64, offset: true, label: 'ELF64 程序头表' };
    nodes.sectionHeaders64 = { kind: 'array', type: types.SectionHeader64, offset: true, label: 'ELF64 节头表' };
    nodes.programHeaders32 = { kind: 'array', type: types.ProgramHeader32, offset: true, label: 'ELF32 程序头表' };
    nodes.sectionHeaders32 = { kind: 'array', type: types.SectionHeader32, offset: true, label: 'ELF32 节头表' };
  }
  return { name: 'ELF', endian: 'little', pointerSize: 8, constants: {}, types, nodes };
}

function buffer(cls: number, data: number): BufferValue {
  assertBytes(cls, data);
  return {
    assetId: 'test', name: 'sample.elf', base: 0,
    bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, cls, data, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
}

function assertBytes(cls: number, data: number) {
  if (cls !== 1 && cls !== 2) throw new Error('bad class');
  if (data !== 1 && data !== 2) throw new Error('bad data');
}

describe('auto parse detection', () => {
  it('plans an ELF64 header and both table nodes', () => {
    const r = detectAutoParse(buffer(2, 1), new Map([['p1', elfPack()]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({
      format: 'elf', label: 'ELF64', packId: 'p1', headerNodeId: 'header64',
    });
    expect(r.plan.tables.map((t) => t.nodeId)).toEqual(['programHeaders64', 'sectionHeaders64']);
    expect(r.plan.warning).toBeUndefined();
  });

  it('plans ELF32 and warns for big-endian data', () => {
    const r = detectAutoParse(buffer(1, 2), new Map([['p1', elfPack()]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.headerNodeId).toBe('header32');
    expect(r.plan.tables.map((t) => t.nodeId)).toEqual(['programHeaders32', 'sectionHeaders32']);
    expect(r.plan.warning).toMatch(/大端/);
  });

  it('falls back to pack structure types when table nodes are absent', () => {
    const r = detectAutoParse(buffer(2, 1), new Map([['p1', elfPack(false)]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tables.map((t) => t.structureId)).toEqual([
      packStructureId('p1', 'ProgramHeader64'),
      packStructureId('p1', 'SectionHeader64'),
    ]);
    expect(r.plan.tables.every((t) => !t.nodeId)).toBe(true);
  });

  it('reports a missing pack and non-ELF input', () => {
    const noPack = detectAutoParse(buffer(2, 1), new Map());
    expect(noPack).toMatchObject({ ok: false, needsPack: true });
    const text = detectAutoParse({ ...buffer(2, 1), bytes: new Uint8Array([1, 2, 3, 4, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, new Map());
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.reason).toMatch(/未识别/);
  });
});
