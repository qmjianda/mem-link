/**
 * Reference index for a layout, used by the designer's delete guards and
 * "被引用" panel. It intentionally scans both document data and compiled packs:
 * a layout referenced only by a pack's layoutType is still a live dependency.
 */

import type { TypeDef } from '../../core/pack';
import type { BinaryLayout } from '../layouts';
import type { BPEdge, BPNode } from '../types';
import { isPackEnabled, type LoadedPack } from '../docstate';

export type LayoutUsageKind = 'layout' | 'node' | 'edge' | 'pack';

export interface LayoutUsageRef {
  kind: LayoutUsageKind;
  id: string;
  label: string;
  detail?: string;
  fieldId?: string;
}

export interface LayoutUsageIndex {
  byLayout: Map<string, LayoutUsageRef[]>;
  fieldEdgeCounts: Map<string, number>;
  fieldRefs: Map<string, LayoutUsageRef[]>;
}

export interface LayoutUsageInput {
  layouts?: BinaryLayout[];
  nodes: BPNode[];
  edges: BPEdge[];
  packs: LoadedPack[];
}

export interface LayoutUsageOptions {
  nodeLabel?: (node: BPNode) => string;
}

export function buildLayoutUsage(
  input: LayoutUsageInput,
  options: LayoutUsageOptions = {},
): LayoutUsageIndex {
  const byLayout = new Map<string, LayoutUsageRef[]>();
  const fieldEdgeCounts = new Map<string, number>();
  const fieldRefs = new Map<string, LayoutUsageRef[]>();

  const add = (layoutId: string, ref: LayoutUsageRef) => {
    if (!byLayout.has(layoutId)) byLayout.set(layoutId, []);
    byLayout.get(layoutId)!.push(ref);
    if (ref.fieldId) {
      const key = `${layoutId}:${ref.fieldId}`;
      if (!fieldRefs.has(key)) fieldRefs.set(key, []);
      fieldRefs.get(key)!.push(ref);
    }
  };

  for (const layout of input.layouts ?? []) {
    for (const field of layout.fields) {
      if (!field.of?.startsWith('layout/')) continue;
      const target = field.of.slice('layout/'.length);
      add(target, {
        kind: 'layout', id: layout.id,
        label: `${layout.name}.${field.name}`,
        detail: `字段 ${field.id}`, fieldId: field.id,
      });
    }
  }

  for (const node of input.nodes) {
    const structureId = node.params?.structureId;
    if (!structureId?.startsWith('layout/')) continue;
    const target = structureId.slice('layout/'.length);
    add(target, {
      kind: 'node', id: node.id,
      label: options.nodeLabel?.(node) ?? node.id,
      detail: node.packId ? `${node.packId}/${node.nodeId}` : node.nodeId,
    });
  }

  const edgeFieldKeys = new Set<string>();
  for (const edge of input.edges) {
    const ports = [edge.from.port, edge.to.port];
    for (const port of ports) {
      const match = /^field:layout\/([^:]+):([^:]+)$/.exec(port);
      if (!match) continue;
      const [, layoutId, fieldId] = match;
      const key = `${edge.id}:${layoutId}:${fieldId}`;
      if (edgeFieldKeys.has(key)) continue;
      edgeFieldKeys.add(key);
      const ref: LayoutUsageRef = {
        kind: 'edge', id: edge.id,
        label: `${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}`,
        detail: `字段 ${fieldId}`, fieldId,
      };
      add(layoutId, ref);
      const fieldKey = `${layoutId}:${fieldId}`;
      fieldEdgeCounts.set(fieldKey, (fieldEdgeCounts.get(fieldKey) ?? 0) + 1);
    }
  }

  const scanType = (type: TypeDef | undefined, seen: Set<string>) => {
    if (!type || seen.has(type.name)) return;
    seen.add(type.name);
    if (type.ref?.kind === 'layout') {
      const target = type.ref.id.replace(/^layout\//, '');
      seen.add(`layout:${target}`);
    }
    for (const field of type.fields) scanType(field.ofType, seen);
  };

  for (const loaded of input.packs) {
    if (!isPackEnabled(loaded)) continue;
    const layouts = new Set<string>();
    const seen = new Set<string>();
    for (const type of Object.values(loaded.pack.types)) {
      const before = new Set(seen);
      scanType(type, seen);
      // scanType records layout ids in `seen`; collect only newly seen ones.
      for (const entry of seen) {
        if (!before.has(entry) && entry.startsWith('layout:')) layouts.add(entry.slice('layout:'.length));
      }
    }
    for (const def of Object.values(loaded.pack.nodes)) {
      if ('type' in def && def.type) {
        const before = new Set(seen);
        scanType(def.type, seen);
        for (const entry of seen) {
          if (!before.has(entry) && entry.startsWith('layout:')) layouts.add(entry.slice('layout:'.length));
        }
      }
    }
    for (const layoutId of layouts) {
      add(layoutId, {
        kind: 'pack', id: loaded.id,
        label: loaded.name,
        detail: '通过 layoutType 引用',
      });
    }
  }

  return { byLayout, fieldEdgeCounts, fieldRefs };
}

export function layoutHasReferences(index: LayoutUsageIndex, layoutId: string): boolean {
  return (index.byLayout.get(layoutId)?.length ?? 0) > 0;
}

export function fieldEdgeUsage(index: LayoutUsageIndex, layoutId: string, fieldId: string): number {
  return index.fieldEdgeCounts.get(`${layoutId}:${fieldId}`) ?? 0;
}

export function layoutsEqual(a: readonly BinaryLayout[] | undefined, b: readonly BinaryLayout[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
