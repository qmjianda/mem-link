/**
 * Data model for mem-link.
 *
 * A "schema" is a set of C record declarations the user pasted in.
 * A "project" adds pools, roots and link rules on top of a schema.
 * A "graph" is the result of walking a byte buffer with that project.
 */

export type Endian = 'little' | 'big';

export type CType =
  | { k: 'int'; size: number; signed: boolean }
  | { k: 'char'; signed: boolean }
  | { k: 'float'; size: 4 | 8 }
  | { k: 'ptr'; size: number }
  | { k: 'bool' }
  | { k: 'array'; elem: CType; count: number }
  | { k: 'record'; name: string; union: boolean };

export const INT = (size: number, signed = true): CType => ({ k: 'int', size, signed });
export const CHAR = (signed = true): CType => ({ k: 'char', signed });
export const PTR = (size: number): CType => ({ k: 'ptr', size });
export const BOOL: CType = { k: 'bool' };

export interface LinkSpec {
  /** '@abs' for absolute address, or the name of a pool. */
  target: string;
  /** C expression producing the raw number. Environment: v, self, addr, base, idx. */
  expr: string;
  /** Record type of the target node. Defaults to pool type / field record type. */
  type?: string;
}

export interface Field {
  id: string;
  name: string;
  type: CType;
  /** byte offset inside the record */
  offset: number;
  /** bytes occupied in the record (bitfield: size of its storage unit) */
  size: number;
  bitWidth?: number;
  /** bit offset inside the storage unit (LSB numbering for little endian) */
  bitOffset?: number;
  endian?: Endian;
  link?: LinkSpec;
  /** virtual field: value computed from an expression, never read from bytes */
  derived?: string;
  note?: string;
}

export interface RecordDecl {
  name: string;
  kind: 'struct' | 'union';
  fields: Field[];
  size: number;
  align: number;
  pack?: number;
  endian?: Endian;
  error?: string;
  /** true for compiler builtins injected into the schema (u32 etc. handled separately) */
  builtin?: boolean;
}

export interface ParseIssue {
  message: string;
  line?: number;
  severity: 'error' | 'warn';
}

export interface Schema {
  records: Record<string, RecordDecl>;
  typedefs: Record<string, CType>;
  ptrSize: 4 | 8;
  endian: Endian;
  issues: ParseIssue[];
  /** original source text, for round-tripping */
  source: string;
}

export interface Pool {
  name: string;
  /** C expression producing the base address of element 0 */
  base: string;
  stride: number;
  count: number;
  /** record type of pool elements */
  type: string;
}

export interface RootSpec {
  id: string;
  label: string;
  type: string;
  /** C expression producing an address */
  addr: string;
  /** number of consecutive instances starting at addr (default 1) */
  count?: number;
}

export interface Project {
  version: 1;
  source: string;
  ptrSize: 4 | 8;
  endian: Endian;
  pools: Pool[];
  roots: RootSpec[];
  /** per-field link rules, keyed by `${record}.${field}` */
  links: Record<string, LinkSpec>;
  notes?: string;
}

/* ------------------------------------------------------------------ graph */

export type EdgeKind = 'link' | 'cycle' | 'null' | 'broken';

export interface GraphNode {
  key: string;
  addr: number;
  type: string;
  size: number;
  /** decoded field values by field id (after transform) */
  values: Record<string, unknown>;
  /** raw decoded values before transform, when a pack transform exists */
  rawValues?: Record<string, unknown>;
  /** transform errors by field id */
  transformErrors?: Record<string, string>;
  /** formatted display string by field id */
  display: Record<string, string>;
  /** fields that are links */
  links: { fieldId: string; spec: LinkSpec; raw: number | null }[];
  depth: number;
  x: number;
  y: number;
  pinned?: boolean;
  ghost?: boolean;
  ghostReason?: string;
  /** index order of creation, used for stable sorting */
  seq: number;
  /** which root discovered this node */
  rootId?: string;
  height: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  fieldId: string;
  label: string;
  kind: EdgeKind;
  value: number | null;
}

export interface Problem {
  severity: 'error' | 'warn';
  nodeKey?: string;
  fieldId?: string;
  message: string;
  detail?: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  problems: Problem[];
  truncated: boolean;
  stats: { nodes: number; edges: number; ms: number };
}

export const NODE_W = 300;
export const NODE_HEADER_H = 34;
export const NODE_ROW_H = 21;
export const NODE_PAD = 8;
export const NODE_MAX_ROWS = 16;
