/**
 * Blueprint model: a pack declares both memory layout (`types`) and the
 * nodes that know how to turn a buffer into instances (`nodes`). A saved
 * graph is just node instances + typed edges; the evaluator walks it.
 */

import type { Endian, Problem } from '../core/types';
import type { FieldDef, MemApi, TypeDef } from '../core/pack';
import type { Memory } from '../core/mem';
import type { AssetTable } from './assets';
import type { AddressInt, MappedAddress } from './precision';
import type { BinaryLayout } from './layouts';

export type PortType =
  | 'number'
  | 'integer'
  | 'numeric'
  | 'address'
  | 'offset'
  | 'index'
  | 'pack-address'
  | 'string'
  | 'bytes'
  | 'span'
  | 'boolean'
  | 'instance'
  | 'list'
  | 'buffer';

export interface PortDef {
  type: PortType;
  label?: string;
}

export interface PortSpec extends PortDef {
  name: string;
  /** generated at runtime from decoded data (one port per list element / nested member) */
  dynamic?: boolean;
  /** short extra text shown on the canvas row */
  hint?: string;
  /**
   * A context input: it does not carry a value into the node body, it selects
   * which File buffer the node (and everything downstream of it) belongs to.
   * Leaving it unconnected means "inherit from upstream".
   */
  context?: boolean;
}

export interface NodeBase {
  label?: string;
  description?: string;
}

export interface StructNodeDef extends NodeBase {
  kind: 'struct';
  type: TypeDef;
}

export interface ListNodeDef extends NodeBase {
  kind: 'list';
  type: TypeDef;
  /** return the address of the next element, or null/undefined to stop */
  next: (entry: EntryView, ctx: EvalCtx) => number | null | undefined;
  /** values that mean "end" (e.g. -1) */
  nulls?: number[];
  /** hard stop, default 4096 */
  max?: number;
}

export interface ArrayNodeDef extends NodeBase {
  kind: 'array';
  type: TypeDef;
  /** default count; when omitted the node exposes a `count` input */
  count?: number;
  /** default type.size */
  stride?: number;
  /** expose a raw file offset instead of a mapped address input */
  offset?: boolean;
}

export interface CalcNodeDef extends NodeBase {
  kind: 'calc';
  inputs: Record<string, PortType>;
  outputs: Record<string, PortType>;
  run: (inputs: Record<string, unknown>, ctx: EvalCtx) => Record<string, unknown>;
}

export type NodeDef = StructNodeDef | ListNodeDef | ArrayNodeDef | CalcNodeDef;

export interface BlueprintPack {
  name: string;
  endian: Endian;
  pointerSize: 4 | 8;
  constants: Record<string, number>;
  types: Record<string, TypeDef>;
  nodes: Record<string, NodeDef>;
}

/** What a list/array element looks like to a pack's `next` function. */
export interface EntryView {
  addr: number;
  index?: number;
  type: TypeDef;
  raw: Record<string, unknown>;
  value: Record<string, unknown>;
}

export interface EvalCtx {
  /** Pack-facing memory API (u8/u16/...), matching BPMemApi in the pack DSL. */
  mem: MemApi;
  pack: BlueprintPack;
  nodeId: string;
  endian: Endian;
  pointerSize: 4 | 8;
  consts: Record<string, number>;
  /** decode another type at an address (used by custom next functions) */
  read: (type: TypeDef, addr: number) => EntryView;
}

/* ------------------------------------------------------------------- graph */

export { builtinLabel, type BuiltinId } from './builtins';

export interface BPNode {
  id: string;
  /** pack id, or '' for built-ins */
  packId: string;
  /** node key inside the pack, or BuiltinId */
  nodeId: string;
  x: number;
  y: number;
  /** inline values for unconnected input ports, kept as text */
  params: Record<string, string>;
  /** parser nodes can expose transformed or raw field values */
  portMode?: 'value' | 'raw';
  /** file nodes carry their own buffer; base64 keeps the doc JSON-safe */
  source?: StoredMemory;
}

export interface BPEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface StoredMemory {
  name: string;
  /** Exact literals are saved as text; numeric bases must be safe integers. */
  base: string | number;
  /** base64；大文件在会话内可以为空，原始字节见 doc.ts 的 sessionBytes */
  data: string;
}

export const BLUEPRINT_FORMAT = 'memlink-blueprint/3';

/** 商店安装来源：用于显示版本、检查更新与重新安装 */
export interface PackStoreRef {
  /** 商店 index.json 的规范化地址 */
  url: string;
  /** 商店内唯一 id（不等于 LoadedPack.id） */
  packId: string;
  version: string;
  sha256?: string;
  path?: string;
  provider?: string;
  coverage?: 'complete' | 'partial';
  helpers?: number;
  /** 商店里的参考蓝图；装包后仍可一键打开 */
  reference?: { path: string; sha256?: string; size?: number };
}

export interface BPDoc {
  format: typeof BLUEPRINT_FORMAT;
  packs: { id: string; name: string; source: string; store?: PackStoreRef }[];
  /** file nodes embed their own buffer in `source` */
  nodes: BPNode[];
  edges: BPEdge[];
  layouts?: BinaryLayout[];
}

/** Runtime value carried on a `buffer` edge. */
export interface BufferValue {
  /** 内容哈希（见 assets.ts）；名称与基址都不参与身份 */
  assetId: string;
  name: string;
  base: AddressInt;
  /** For restricted views, the base of the originating file mapping. */
  mappingBase?: AddressInt;
  bytes: Uint8Array;
}

export interface ByteOrigin {
  buffer: BufferValue;
  address: bigint;
  length: number;
  fieldId?: string;
}

/* --------------------------------------------------------------- runtime */

export interface FieldView {
  name: string;
  label?: string;
  kind: FieldDef['kind'];
  portType?: PortType;
  type: string;
  offset: number;
  size: number;
  raw: unknown;
  value: unknown;
  display: string;
  rawDisplay: string;
}

export interface InstanceView {
  addr: number;
  /** Built-in records carry exact, absolute position separately from the preview's local byte index. */
  location?: MappedAddress;
  layoutId?: string;
  index?: number;
  typeName: string;
  size: number;
  fields: FieldView[];
  /** the buffer this instance was decoded from (for hex highlighting) */
  mem?: Memory;
}

/** Where a node got its buffer from, and the chain it inherited through. */
export interface SourceInfo {
  buffer?: BufferValue;
  /** 实际读到的字节的身份；与上游 File 一致（内容相同即相同） */
  assetId?: string;
  /** id of the File node that actually supplied the bytes */
  fileId?: string;
  /** override = pinned in the inspector, explicit = a source wire,
   *  upstream = inherited along edges, default = graph's first File,
   *  file = this node is the File itself, none = unavailable */
  mode: 'override' | 'explicit' | 'upstream' | 'default' | 'file' | 'none';
  /** node ids starting at this node and ending at the File node */
  chain: string[];
  /** the edge that carried the file context into this node */
  via?: { node: string; port: string };
  /** 数据源由上游的字符串/字节输出提供：字节要等求值该端口时才算（值依赖） */
  pendingValue?: boolean;
  /** 声明值来源的端点，沿后续上下文继承保留到整条读取链。 */
  valueSource?: { node: string; port: string };
  /** 继承链自身成环：没有可用的数据源，且与值依赖环是两回事 */
  sourceCycle?: boolean;
  /** incoming edges point at different files */
  conflict?: boolean;
  /** names of the disagreeing files */
  candidates?: string[];
  /** a source wire exists, but it carried no loaded file, so this node fell
   *  back to inheritance/default — surfaced as a warning instead of silently
   *  decoding from a different file than the one the user drew */
  wireMissing?: boolean;
  /** the inspector's pinned file has no loaded contents (unloaded or deleted),
   *  so the node fell back to inheritance/default */
  pinMissing?: boolean;
}

/**
 * The resolved value of an input port. The canvas and inspector use this to
 * replace an editable box with the value actually arriving over a wire.
 */
export interface InputValue {
  /** value the evaluator really used */
  value: unknown;
  /** formatted text shown in place of the inline input */
  display: string;
  /** an edge feeds this port */
  wired: boolean;
  /** upstream endpoint, when wired */
  from?: { node: string; port: string; label: string };
  /** the text the user typed, kept so unwiring restores it */
  inline: string;
  /** the upstream value could not be resolved */
  invalid?: boolean;
}

/**
 * 截断的位置信息：区分"恰好等于上限且自然结束"（不产生本对象）与
 * "因上限停止"。`unit` 决定 `at` 是字节地址还是元素下标。
 */
export interface Truncation {
  limit: number;
  at: AddressInt;
  unit: 'index' | 'address';
  canContinue: boolean;
}

export type NodeView =
  | { kind: 'file'; name: string; size: number; base: AddressInt; error?: string }
  | { kind: 'number'; value: number | bigint; error?: string }
  | { kind: 'struct'; inst?: InstanceView; error?: string }
  | {
      kind: 'list';
      items: InstanceView[];
      count: number;
      truncated?: boolean;
      trunc?: Truncation;
      cycle?: boolean;
      local?: boolean;
      stop?: string;
      error?: string;
    }
  | { kind: 'array'; items: InstanceView[]; count: number; truncated?: boolean; trunc?: Truncation; error?: string; local?: boolean; stop?: string }
  | { kind: 'element'; inst?: InstanceView; error?: string }
  | { kind: 'calc'; outputs: Record<string, unknown>; detail?: string; error?: string };

export interface BPResult {
  /** node id -> output port -> value */
  outputs: Map<string, Record<string, unknown>>;
  /** node id -> what the canvas draws inside the node */
  views: Map<string, NodeView>;
  /** port types resolved for each node (used by the canvas) */
  ports: Map<string, { inputs: PortSpec[]; outputs: PortSpec[] }>;
  /** node id -> which File buffer it decoded from, and how that was decided */
  sources: Map<string, SourceInfo>;
  /** node id -> input port -> value actually used (mirrors wires into the UI) */
  inputs: Map<string, Record<string, InputValue>>;
  /** 字段或单值的读位置；只用于显示与诊断，不随图保存。 */
  origins?: Map<string, Record<string, ByteOrigin>>;
  problemOrigins?: Map<string, ByteOrigin>;
  /** 本次求值登记的全部资产：内容哈希 → 共享字节 */
  assets: AssetTable;
  problems: Problem[];
  ms: number;
  /** 其中"只读图结构算来源"的耗时；用于确认它没有随规模失控 */
  msSource?: number;
}

/**
 * A decoded element travels on `instance` edges together with its own Memory.
 *
 * 真实性由品牌登记表决定，而不是字段形状：pack 代码与宿主同 realm，
 * 只要拿到任意一个真实元素就能用 `Object.getOwnPropertySymbols` 复制品牌
 * 符号，而 WeakSet 只在模块内可见，外部无法把自己造的对象登记进来。
 */
const brandedInstances = new WeakSet<object>();

/** 由 `makeView` 调用；pack 代码拿不到这个函数。 */
export function brandInstance<T extends InstanceView>(view: T): T {
  brandedInstances.add(view);
  return view;
}

export function isInstanceView(v: unknown): v is InstanceView {
  return !!v && typeof v === 'object' && brandedInstances.has(v as object);
}

/**
 * 形状像元素、但未经登记的值（典型来源：calc 节点自行拼出一个对象）。
 * 仅用于产生告警，判定结果本身不构成"这是元素"。
 */
export function looksLikeInstance(v: unknown): boolean {
  if (!v || typeof v !== 'object' || isInstanceView(v)) return false;
  const o = v as Partial<InstanceView>;
  return typeof o.addr === 'number' && typeof o.typeName === 'string' && Array.isArray(o.fields);
}

/**
 * Port compatibility. An `instance` (list element / nested record) can feed a
 * number input: its address is used. A `buffer` input is a context port — any
 * upstream output may be wired to it, meaning "decode from that upstream node's
 * file"; whether that works depends on the source node carrying a file, so the
 * evaluator reports a warning when the wire carries none.
 */
export function canConnect(from: PortType, to: PortType): boolean {
  if (from === to) return true;
  if (to === 'buffer') return true;
  if (to === 'numeric') return from === 'integer' || from === 'number' || from === 'offset' || from === 'index';
  if (to === 'pack-address') return from === 'address' || from === 'number' || from === 'integer' || from === 'instance';
  if (to === 'offset' || to === 'index' || to === 'integer') return from === 'integer' || from === 'number';
  if (to === 'address') return from === 'instance' || from === 'pack-address';
  return to === 'number' && (from === 'instance' || from === 'integer' || from === 'pack-address');
}

/** Shared by the canvas renderer and drag-to-add placement. */
export const NODE_WIDTH = 286;
export const NODE_HEADER = 32;

/**
 * Convert a pointer drop point (canvas world coords) into the top-left corner
 * of the new node, so the cursor ends up on its title bar and the card is
 * centred horizontally under it.
 */
export function dropPosition(
  world: { x: number; y: number },
  width = NODE_WIDTH,
  header = NODE_HEADER,
): { x: number; y: number } {
  return { x: Math.round(world.x - width / 2), y: Math.round(world.y - header / 2) };
}

/**
 * Optional user caption (F2) lives in `params` so it travels with the document
 * and needs no schema migration. Empty means "use the model label".
 */
export function displayTitle(node: { params?: Record<string, string> }, fallback: string): string {
  return node.params?.__title?.trim() || fallback;
}

export function fieldPortType(f: FieldDef): PortType {
  switch (f.kind) {
    case 'string': return 'string';
    case 'bytes': return 'bytes';
    case 'bool': return 'boolean';
    case 'ptr': return 'pack-address';
    case 'record': return 'instance';
    case 'array': return 'list';
    default: return 'number';
  }
}

export function fieldPorts(type: TypeDef): PortSpec[] {
  return type.fields.map((f) => ({
    name: f.name,
    type: fieldPortType(f),
    label: f.label ?? f.name,
  }));
}
