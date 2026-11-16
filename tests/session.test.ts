import { describe, expect, it } from 'vitest';
import type { Pack } from '../src/core/pack';
import { hashPack, pruneSession, sessionKeyFor } from '../src/v2/session';

const pack: Pack = {
  name: 'tiny',
  endian: 'little',
  pointerSize: 4,
  constants: {},
  types: [
    {
      name: 'Header',
      size: 4,
      fields: [{ name: 'magic', offset: 0, kind: 'u16' }],
    },
  ],
  roots: [{ type: 'Header', address: 0 }],
};

describe('session edits', () => {
  it('keys the same source the same way, different source apart', () => {
    expect(hashPack('a')).toBe(hashPack('a'));
    expect(hashPack('a')).not.toBe(hashPack('b'));
    expect(sessionKeyFor('demo.pack.ts', 'a')).toBe(sessionKeyFor('demo.pack.ts', 'a'));
    expect(sessionKeyFor('x.pack.ts', 'a')).not.toBe(sessionKeyFor('y.pack.ts', 'a'));
  });

  it('drops overrides and roots that no longer exist in the pack', () => {
    const out = pruneSession(pack, {
      overrides: {
        'Header.magic': { code: '(v) => Number(v) + 1' },
        'Header.gone': { code: '(v) => v' },
      },
      roots: [
        { type: 'Header', address: 0, label: '临时根' },
        { type: 'Missing', address: 4 },
      ],
    });
    expect(Object.keys(out.overrides)).toEqual(['Header.magic']);
    expect(out.roots.map((r) => r.type)).toEqual(['Header']);
  });

  it('keeps the session intact when no pack is available', () => {
    const session = { overrides: { 'A.b': { code: '(v) => v' } }, roots: [{ type: 'A', address: 8 }] };
    expect(pruneSession(undefined, session)).toEqual(session);
  });
});
