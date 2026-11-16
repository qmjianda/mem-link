/**
 * Session-level edits: inspector transform overrides and temporary roots.
 *
 * They are deliberately kept out of the pack file, but losing them on every
 * refresh is annoying. Persist them in localStorage under a key derived from
 * the pack name + a hash of its source, so editing one pack does not leak into
 * another. Any storage failure (private mode, sandboxed file://) is ignored.
 */

import type { Pack, RootDef } from '../core/pack';
import { fieldId } from '../core/pack';
import type { FieldOverride } from './overrides';

export interface SavedSession {
  overrides: Record<string, FieldOverride>;
  roots: RootDef[];
}

const PREFIX = 'memlink:session:';
const MAX_CODE = 20_000;
const MAX_ROOTS = 50;

/** FNV-1a, just to keep different pack revisions apart. */
export function hashPack(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function sessionKeyFor(name: string, source: string): string {
  return `${PREFIX}${name}:${hashPack(source)}`;
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

function sanitizeOverrides(value: unknown): Record<string, FieldOverride> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, FieldOverride> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const code = (raw as { code?: unknown }).code;
    const follow = (raw as { follow?: unknown }).follow;
    if (typeof code !== 'string' || code.length > MAX_CODE) continue;
    if (follow !== undefined && follow !== null && typeof follow !== 'string') continue;
    out[key] = follow === undefined ? { code } : { code, follow };
  }
  return out;
}

function sanitizeRoots(value: unknown): RootDef[] {
  if (!Array.isArray(value)) return [];
  const out: RootDef[] = [];
  for (const raw of value.slice(0, MAX_ROOTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const { type, address, label } = raw as { type?: unknown; address?: unknown; label?: unknown };
    if (typeof type !== 'string' || !type) continue;
    if (typeof address !== 'number' || !Number.isFinite(address) || address < 0) continue;
    out.push({ type, address: Math.floor(address), label: typeof label === 'string' ? label : '临时根' });
  }
  return out;
}

export function loadSession(key: string): SavedSession | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(key);
    if (!raw) return undefined;
    const doc = JSON.parse(raw) as { overrides?: unknown; roots?: unknown };
    return { overrides: sanitizeOverrides(doc.overrides), roots: sanitizeRoots(doc.roots) };
  } catch {
    return undefined;
  }
}

/** Drop overrides/roots that no longer exist in the current pack. */
export function pruneSession(pack: Pack | undefined, session: SavedSession): SavedSession {
  if (!pack) return session;
  const fields = new Set<string>();
  for (const t of pack.types) {
    for (const f of t.fields) fields.add(fieldId(t.name, f.name));
  }
  const types = new Set(pack.types.map((t) => t.name));
  return {
    overrides: Object.fromEntries(
      Object.entries(session.overrides).filter(([id]) => fields.has(id)),
    ),
    roots: session.roots.filter((r) => types.has(r.type)),
  };
}

export function saveSession(key: string, session: SavedSession): void {
  const store = storage();
  if (!store) return;
  const roots = session.roots.slice(0, MAX_ROOTS);
  const overrides = sanitizeOverrides(session.overrides);
  try {
    if (!roots.length && !Object.keys(overrides).length) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ overrides, roots }));
  } catch {
    /* quota / disabled storage: session simply stays in memory */
  }
}

export function clearSession(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}
