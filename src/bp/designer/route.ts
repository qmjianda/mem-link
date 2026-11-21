/**
 * Hash route for the full-screen structure designer.
 *
 * The designer keeps the graph mounted; the hash is the only navigation
 * record. `popstate` is the source of truth in BlueprintApp, so this module
 * stays pure and easy to test.
 */

import { layoutIdValid } from '../layouts';

export interface DesignerRoute {
  /** Layout ids from outer to inner. Empty means the designer's layout chooser. */
  stack: string[];
}

export function parseDesignerHash(hash: string): DesignerRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] !== 'design') return null;
  const stack = parts.slice(1);
  if (!stack.every((id) => layoutIdValid(id))) return null;
  return { stack };
}

export function designerHash(stack: readonly string[]): string {
  if (!stack.length) return '#design';
  return '#design/' + stack.map((id) => encodeURIComponent(id)).join('/');
}

export function isDesignerHash(hash: string): boolean {
  return parseDesignerHash(hash) !== null;
}
