/**
 * Pack DSL for the blueprint editor.
 *
 * Type helpers (`struct`, `u16`, ...) come from the existing pack module so a
 * pack file has one set of layout primitives. Node helpers live here and are
 * injected next to them by the loader.
 */

import type { Endian } from '../core/types';
import type { TypeDef } from '../core/pack';
import { PACK_DSL, collectTypes, finalizeTypes } from '../core/pack';
import type {
  ArrayNodeDef, BlueprintPack, CalcNodeDef, ListNodeDef, NodeDef, PortType,
  StructNodeDef,
} from './types';

export interface BlueprintPackInput {
  name?: string;
  endian?: Endian;
  pointerSize?: 4 | 8;
  constants?: Record<string, number>;
  types: Record<string, TypeDef> | TypeDef[];
  nodes: Record<string, NodeDef>;
}

export function definePack(input: BlueprintPackInput): BlueprintPack {
  const roots = Array.isArray(input.types) ? input.types : Object.values(input.types);
  const types = collectTypes(roots);
  finalizeTypes(types, input.pointerSize ?? 4);
  return {
    name: input.name ?? 'pack',
    endian: input.endian ?? 'little',
    pointerSize: input.pointerSize ?? 4,
    constants: input.constants ?? {},
    types: Object.fromEntries(types),
    nodes: input.nodes,
  };
}

export interface StructNodeOptions {
  label?: string;
  description?: string;
}

export function structNode(type: TypeDef, opts: StructNodeOptions = {}): StructNodeDef {
  return {
    kind: 'struct',
    type,
    label: opts.label ?? type.name,
    description: opts.description,
  };
}

export interface ListNodeOptions {
  next: ListNodeDef['next'];
  nulls?: number[];
  max?: number;
  label?: string;
  description?: string;
}

export function listNode(type: TypeDef, opts: ListNodeOptions): ListNodeDef {
  return {
    kind: 'list',
    type,
    next: opts.next,
    nulls: opts.nulls,
    max: opts.max,
    label: opts.label ?? `${type.name} 链表`,
    description: opts.description,
  };
}

export interface ArrayNodeOptions {
  count?: number;
  stride?: number;
  label?: string;
  description?: string;
}

export function arrayNode(type: TypeDef, opts: ArrayNodeOptions = {}): ArrayNodeDef {
  return {
    kind: 'array',
    type,
    count: opts.count,
    stride: opts.stride,
    label: opts.label ?? `${type.name} 数组`,
    description: opts.description,
  };
}

export interface CalcNodeOptions {
  inputs: Record<string, PortType>;
  outputs: Record<string, PortType>;
  run: CalcNodeDef['run'];
  label?: string;
  description?: string;
}

export function calcNode(opts: CalcNodeOptions): CalcNodeDef {
  return {
    kind: 'calc',
    inputs: opts.inputs,
    outputs: opts.outputs,
    run: opts.run,
    label: opts.label,
    description: opts.description,
  };
}

/** Names injected as globals into a `.pack.ts` file. */
export const BP_DSL_NAMES = [
  ...Object.keys(PACK_DSL),
  'structNode',
  'listNode',
  'arrayNode',
  'calcNode',
];

export const BP_DSL: Record<string, unknown> = {
  ...PACK_DSL,
  definePack,
  structNode,
  listNode,
  arrayNode,
  calcNode,
};

export const BP_DSL_VALUES = BP_DSL_NAMES.map((name) => BP_DSL[name]);
