import { describe, expect, it } from 'vitest';
import autoLayout from '../samples/templates/auto-layout.bp.ts?raw';
import bitfields from '../samples/templates/bitfields.bp.ts?raw';
import nestedArray from '../samples/templates/nested-array.bp.ts?raw';
import poolList from '../samples/templates/pool-list.bp.ts?raw';
import layoutRef from '../samples/templates/layout-ref.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { buildStructureRegistry } from '../src/bp/structure';
import type { BinaryLayout } from '../src/bp/layouts';

const templates = [
  ['auto-layout', autoLayout],
  ['bitfields', bitfields],
  ['nested-array', nestedArray],
  ['pool-list', poolList],
  ['layout-ref', layoutRef],
] as const;

describe('pack templates', () => {
  for (const [name, source] of templates) {
    it(`${name} loads`, () => {
      const r = loadBlueprintPack(source);
      expect(r.error).toBeUndefined();
      expect(r.pack).toBeTruthy();
    });
  }

  it('layout-ref materializes against a document layout', () => {
    const pack = loadBlueprintPack(layoutRef).pack!;
    const layout: BinaryLayout = {
      id: 'header', name: 'Header', endian: 'little',
      fields: [{ id: 'f1', name: 'x', kind: 'u16' }],
    };
    const reg = buildStructureRegistry([layout], new Map([['p1', pack]]));
    const typeName = Object.keys(pack.types)[0];
    const entry = reg.get(`pack/p1/${encodeURIComponent(typeName)}`);
    expect(entry?.size).toBe(2);
  });
});
