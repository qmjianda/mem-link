/**
 * Blueprint evaluator.
 *
 * Source model: a `File / Buffer` node owns the bytes and is a real, connectable
 * source. Every other node has an optional `buffer` *context* input. When it is
 * wired, the node takes the file from that wire; when it is left alone, the node
 * inherits the file from any of its upstream edges, recursively. That way a
 * chain like `File -> Header -> Entry list -> element -> another Header` keeps
 * the same buffer all the way down without a wire to every node.
 *
 * Decoded elements are first-class values: list/array nodes expose one output
 * port per element, and struct nodes expose one port per nested array member
 * or record member. An `instance` value can be wired straight into a number
 * input (its address is used).
 *
 * Every input port's resolved value is published on BPResult.inputs, so the UI
 * can show the value arriving over a wire instead of the stale inline text.
 */

import { Memory, toHex } from '../core/mem';

declare global {
  interface Window {
    /** 性能验收钩子：求值次数（拖动期应为 0） */
    __bp?: { evalRuns: number };
  }
}
import type { Pack } from '../core/pack';
import { fieldSize, type FieldDef, type TypeDef } from '../core/pack';
import { decodeRecord, formatPackValue, packMemApi } from '../core/packgraph';
import type { Problem } from '../core/types';
import type {
  BPEdge, BPNode, BlueprintPack, BPResult, EntryView, EvalCtx, FieldView,
  BufferValue, ByteOrigin, InputValue, InstanceView, NodeDef, NodeView, PortSpec, PortType,
  SourceInfo, StoredMemory, Truncation,
} from './types';
import { canConnect, fieldPortType, fieldPorts, builtinLabel, displayTitle, isInstanceView, brandInstance, looksLikeInstance } from './types';
import { createAssetTable, cachedAssetIdOf } from './assets';
import { getBuiltin, makeBuiltinCtx } from './builtins';
import { base64ToBytes, sessionBytesOf } from './doc';
import {
  addressHex, addressInteger, exactInteger, isExactPort, isMappedAddress, mappedAddress, MAX_ADDRESS, packMemory, safeNumber, sameMapping,
} from './precision';
import { addOffset, integerInput, isByteSpan, ReadIssue } from './binary-read';
import { layoutFieldType, type BinaryLayout } from './layouts';
import { buildStructureRegistry, type StructureRegistry } from './structure';

/** Prefix of runtime-generated ports. Names are rebuilt from the node view. */
export const ELEMENT_PORT = 'elem:';
/** Name of the context input that selects/inherits a File buffer. */
export const SOURCE_PORT = 'buffer';
/** Hard ceiling, mirrors the list traversal limit. */
const MAX_DYNAMIC_PORTS = 4096;

const SOURCE_INPUT: PortSpec = {
  name: SOURCE_PORT,
  type: 'buffer',
  label: '数据源',
  context: true,
  hint: '接文件，或留空由上游继承',
};

/* ------------------------------------------------------------------ ports */

function shortValue(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'string') return v.length > 18 ? `${v.slice(0, 17)}…` : v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (isMappedAddress(v)) return addressHex(v.value);
  if (isByteSpan(v)) return `⟨${v.buffer.bytes.length} B @ ${addressHex(v.buffer.base)}⟩`;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) return `⟨${v.length} B⟩`;
  if (Array.isArray(v)) return `[${v.length}]`;
  return '{…}';
}

function elementText(it: InstanceView): string {
  const f = it.fields.find((x) => x.name === 'name') ?? it.fields[0];
  return f ? shortValue(f.value) : it.typeName;
}

function portTypeOf(v: unknown): PortType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Uint8Array) return 'bytes';
  if (Array.isArray(v)) return 'list';
  return 'instance';
}

function isBufferValue(v: unknown): v is BufferValue {
  return !!v && typeof v === 'object'
    && (v as BufferValue).bytes instanceof Uint8Array
    && typeof (v as BufferValue).name === 'string';
}

/**
 * 一根线可以直接把「内容」带进数据源：字符串与字节数组本身就是内存镜像，
 * 归一到基址 0 的缓冲区即可。这样文本常量、十六进制输出等也能当数据源用，
 * 而不是被拒之门外、或悄悄改读上游文件。
 */
export function valueAsBuffer(v: unknown): BufferValue | undefined {
  if (isByteSpan(v)) return v.buffer;
  if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v);
    return { assetId: cachedAssetIdOf(bytes), name: `字符串 ${v.length} 字符`, base: 0, bytes };
  }
  if (v instanceof Uint8Array) {
    return { assetId: cachedAssetIdOf(v), name: `字节 ${v.length} B`, base: 0, bytes: v };
  }
  // 整块缓冲区（File 的 buffer 输出）不在这里接管：它要沿文件来源路径
  // 走，才能保留 fileId 与「上游冲突」的判断。
  return undefined;
}

function nodeLabelOf(node: BPNode | undefined, packs: Map<string, BlueprintPack>): string {
  if (!node) return '?';
  const fallback = node.packId === ''
    ? builtinLabel(node.nodeId)
    : (packs.get(node.packId)?.nodes[node.nodeId]?.label ?? node.nodeId);
  return displayTitle(node, fallback);
}

/** Text shown where an inline input box used to be once a wire feeds it. */
function formatInputValue(v: unknown, portName: string, inline: string, type?: PortType): string {
  if (v == null) return '∅';
  if (isMappedAddress(v)) return addressHex(v.value);
  if (isByteSpan(v)) return `⟨${v.buffer.bytes.length} B @ ${addressHex(v.buffer.base)}⟩`;
  if (typeof v === 'bigint') return type === 'address' || /^-?0x/i.test(inline) ? addressHex(v) : String(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const hexish = type === 'pack-address' || type === 'number' && (portName === 'address' || /^\s*-?0x/i.test(inline));
    if (hexish && Number.isInteger(v) && v >= 0) return `0x${v.toString(16)}`;
    return String(Number(v.toPrecision(8)));
  }
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 23)}…` : v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) return `⟨${v.length} B⟩`;
  if (isBufferValue(v)) return v.name;
  if (isInstanceView(v)) return `#${v.index ?? '?'} · ${addressHex(v.location?.value ?? v.addr)}`;
  if (Array.isArray(v)) return `[${v.length} 项]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/**
 * Runtime output ports: one per list/array element, plus one per nested
 * member of a struct field (array elements or record members). Values are
 * returned alongside the ports so the evaluator can publish them.
 */
function dynamicOf(view?: NodeView): { ports: PortSpec[]; values: Record<string, unknown> } {
  const ports: PortSpec[] = [];
  const values: Record<string, unknown> = {};
  if (!view) return { ports, values };

  if (view.kind === 'list' || view.kind === 'array') {
    view.items.slice(0, MAX_DYNAMIC_PORTS).forEach((item, i) => {
      const name = `${ELEMENT_PORT}${i}`;
      ports.push({
        name,
        type: 'instance',
        label: `#${i}`,
        hint: `${addressHex(item.location?.value ?? item.addr)} · ${elementText(item)}`,
        dynamic: true,
      });
      values[name] = item;
    });
    return { ports, values };
  }

  // Struct nodes and Element nodes both decode a single instance, so both
  // expose the members of their nested array/record fields as ports.
  if ((view.kind === 'struct' || view.kind === 'element') && view.inst) {
    for (const f of view.inst.fields) {
      if (f.portType) continue;
      const v = f.value;
      const label = f.label ?? f.name;
      if (Array.isArray(v)) {
        v.slice(0, 256).forEach((item, i) => {
          const name = `${ELEMENT_PORT}${f.name}:${i}`;
          ports.push({ name, type: portTypeOf(item), label: `${label}[${i}]`, hint: shortValue(item), dynamic: true });
          values[name] = item;
        });
      } else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
        for (const [key, sub] of Object.entries(v as Record<string, unknown>)) {
          const name = `${ELEMENT_PORT}${f.name}:${key}`;
          ports.push({ name, type: portTypeOf(sub), label: `${label}.${key}`, hint: shortValue(sub), dynamic: true });
          values[name] = sub;
        }
      }
    }
  }
  return { ports, values };
}

/**
 * Look up a type by name for an element that arrived over a wire. The decoded
 * instance only carries `typeName`, so prefer the node's own pack and fall back
 * to any loaded pack that declares a type with that name.
 */
function findTypeByName(
  typeName: string | undefined,
  packId: string | undefined,
  packs: Map<string, BlueprintPack>,
): TypeDef | undefined {
  if (!typeName) return undefined;
  const own = packId ? packs.get(packId)?.types[typeName] : undefined;
  if (own) return own;
  for (const p of packs.values()) {
    const t = p.types[typeName];
    if (t) return t;
  }
  return undefined;
}

export function portsFor(
  node: BPNode,
  packs: Map<string, BlueprintPack>,
  view?: NodeView,
  layouts: readonly BinaryLayout[] = [],
  structures?: StructureRegistry,
): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const registry = structures ?? buildStructureRegistry(layouts, packs);
  const activePacks = registry.packs;
  if (node.packId === '') {
    if (node.nodeId === 'element') {
        /**
         * 元素节点只在两种情况下有输出字段：接上元素/列表后按实际类型生成，
         * 或跟随地址时由推断写入 `typeId` 并在该地址解码。
         * 空节点不铺模板字段——否则看起来像已经解析了某个结构体。
         *
         * `address` 端口也只在这时有意义；没有绑定类型时不暴露，避免用户
         * 手动指定类型后解析出错误内容。
         */
        const bound = (node.params.typeId ?? '') !== '';
        const inputs: PortSpec[] = [
          { ...SOURCE_INPUT },
          ...(bound ? [{ name: 'address', type: 'pack-address' as const, label: '地址' }] : []),
          { name: 'instance', type: 'instance', label: '元素' },
          { name: 'list', type: 'list', label: '列表' },
          { name: 'index', type: 'number', label: '下标' },
        ];
        // A decoded element wins over any template: once an `instance` or
        // `list` is wired in, its own fields become the ports. That keeps the
        // rows (and their types) in sync with the values the evaluator
        // publishes, which also come from `item.fields`.
        const inst = view?.kind === 'element' ? view.inst : undefined;
        if (inst) {
          const decl = findTypeByName(inst.typeName, node.params.packId, activePacks);
          const byName = new Map<string, FieldDef>();
          for (const f of decl?.fields ?? []) byName.set(f.name, f);
          return {
            inputs,
            outputs: [
              ...inst.fields.map((f) => {
                const fd = byName.get(f.name);
                return {
                  name: f.name,
                  type: f.portType ?? (fd ? fieldPortType(fd) : portTypeOf(f.value)),
                  label: f.label ?? fd?.label ?? f.name,
                };
              }),
              // Same rule as a struct node: nested array/record members get
              // their own connectable output ports.
              ...dynamicOf(view).ports,
            ],
          };
        }
        // 未连接且没有推断类型：空节点，只有连接端口。
        return { inputs, outputs: [] };
    }
    // Every other built-in is declarative: the registry is the single source
    // for ports, palette entries and evaluation.
    const def = getBuiltin(node.nodeId);
    if (def) return def.ports?.(node.params, registry, view) ?? { inputs: def.inputs, outputs: def.outputs };
    return { inputs: [], outputs: [] };
  }

  const pack = activePacks.get(node.packId);
  const def = pack?.nodes[node.nodeId];
  if (!pack || !def) return { inputs: [], outputs: [] };
  if (def.kind === 'calc') {
    const inputs: PortSpec[] = Object.entries(def.inputs).map(([name, t]) => ({ name, type: t, label: name }));
    // A pack may declare its own buffer input; otherwise add the context port.
    if (!inputs.some((p) => p.name === SOURCE_PORT)) inputs.unshift({ ...SOURCE_INPUT });
    else inputs.forEach((p) => { if (p.name === SOURCE_PORT && p.type === 'buffer') p.context = true; });
    return {
      inputs,
      outputs: Object.entries(def.outputs).map(([name, t]) => ({ name, type: t, label: name })),
    };
  }

  const inputs: PortSpec[] = [
    { ...SOURCE_INPUT },
    def.kind === 'array' && def.offset
      ? { name: 'offset', type: 'offset', label: '文件偏移', hint: '相对当前数据源基址' }
      : { name: 'address', type: 'pack-address', label: '地址' },
  ];
  if (def.kind === 'array' && def.count == null) {
    inputs.push({ name: 'count', type: 'number', label: '数量' });
  }
  const outputs: PortSpec[] = def.kind === 'struct'
    ? [...fieldPorts(def.type), ...dynamicOf(view).ports]
    : [
        { name: 'list', type: 'list' as PortType, label: '列表' },
        { name: 'count', type: 'number' as PortType, label: '数量' },
        ...dynamicOf(view).ports,
      ];
  return { inputs, outputs };
}

/* ------------------------------------------------------------------ decode */

/**
 * base64 → 字节的会话缓存。按 base64 原文做键而不是按 source 对象：
 * 改基址会生成新的 source 对象，但字节没变，不该重新解码、重新哈希。
 * 只保留最近 128 MB，避免切换文件后旧转储一直被这个缓存钉住。
 */
const decodedBuffers = new Map<string, Uint8Array>();
const MAX_DECODED_CACHE_BYTES = 128 * 1024 * 1024;

function decodeBuffer(src: StoredMemory): Uint8Array {
  // 大文件载入时直接把原始字节留在会话里，不需要 base64 往返。
  const session = sessionBytesOf(src);
  if (session) return session;
  const hit = decodedBuffers.get(src.data);
  if (hit) {
    // 触碰即刷新 LRU 顺序
    decodedBuffers.delete(src.data);
    decodedBuffers.set(src.data, hit);
    return hit;
  }
  const bytes = base64ToBytes(src.data);
  decodedBuffers.set(src.data, bytes);
  let total = 0;
  for (const b of decodedBuffers.values()) total += b.byteLength;
  while (total > MAX_DECODED_CACHE_BYTES && decodedBuffers.size > 1) {
    const oldest = decodedBuffers.keys().next().value as string;
    total -= decodedBuffers.get(oldest)!.byteLength;
    decodedBuffers.delete(oldest);
  }
  return bytes;
}

function compatPack(pack: BlueprintPack): Pack {
  return {
    name: pack.name,
    endian: pack.endian,
    pointerSize: pack.pointerSize,
    constants: pack.constants,
    types: Object.values(pack.types),
    roots: [],
  };
}

function formatField(f: FieldDef, v: unknown, forceHex: boolean): string {
  if (forceHex && typeof v === 'number' && Number.isFinite(v)) return toHex(v);
  return formatPackValue(f, v);
}

function makeEntry(
  mem: Memory, pack: BlueprintPack, compat: Pack, memApi: ReturnType<typeof packMemApi>,
  typeName: string, addr: number, index?: number,
): EntryView {
  const type = pack.types[typeName];
  if (!type) throw new Error(`类型 ${typeName} 不存在`);
  if (!mem.contains(addr, type.size)) {
    throw new Error(`地址 ${toHex(addr)} 不在缓冲区 [${toHex(mem.base)}, ${toHex(mem.end)}) 内`);
  }
  const raw = decodeRecord(mem, compat, type, addr);
  const value: Record<string, unknown> = {};
  for (const f of type.fields) {
    const rv = raw[f.name];
    if (!f.transform) {
      value[f.name] = rv;
      continue;
    }
    try {
      value[f.name] = f.transform(rv, {
        v: rv,
        addr: addr + (f.offset ?? 0),
        self: raw,
        mem: memApi,
        consts: pack.constants,
        type: typeName,
        field: f.name,
      });
    } catch (e) {
      value[f.name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { addr, index, type, raw, value };
}

function makeView(entry: EntryView, compat: Pick<Pack, 'pointerSize' | 'types'>, mem: Memory): InstanceView {
  const fields: FieldView[] = entry.type.fields.map((f) => {
    const raw = entry.raw[f.name];
    const value = entry.value[f.name];
    const transformed = !!f.transform;
    return {
      name: f.name,
      label: f.label,
      kind: f.kind,
      type: f.kind === 'record' || f.kind === 'array' ? (f.of ?? f.kind) : f.kind,
      offset: f.offset ?? 0,
      size: fieldSize(f, compat),
      raw,
      value,
      rawDisplay: formatPackValue(f, raw),
      display: transformed
        ? `${formatPackValue(f, raw)} → ${formatField(f, value, typeof value === 'number')}`
        : formatPackValue(f, value),
    };
  });
  return brandInstance({ addr: entry.addr, index: entry.index, typeName: entry.type.name, size: entry.type.size, fields, mem });
}

/* ------------------------------------------------------------------- eval */

/**
 * 按需读取解码结果（结构树用）：复用求值的解码与 transform 语义，
 * 但由调用方决定读哪个地址，不参与图求值、不写视图。
 */
export function createEntryReader(mem: Memory, pack: BlueprintPack, nodeId = '') {
  const compat = compatPack(pack);
  const memApi = packMemApi(mem);
  const read = (typeName: string, addr: number, index?: number): EntryView =>
    makeEntry(mem, pack, compat, memApi, typeName, addr, index);
  const ctx: EvalCtx = {
    mem: memApi, pack, nodeId, endian: pack.endian, pointerSize: pack.pointerSize,
    consts: pack.constants,
    read: (type: TypeDef, addr: number) => read(type.name, addr),
  };
  return { read, ctx };
}

/**
 * 把非品牌的"形似元素"对象降级为纯 JSON：断开 Memory 引用与原型，
 * 下游即使误接也拿不到可继续解码的地址。
 */
function toPlainJson(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array || isInstanceView(v)) return v;
  if (Array.isArray(v)) return v.map((x) => toPlainJson(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = toPlainJson(x, depth + 1);
  return out;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return safeNumber(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  // an element wired into a number input means "that element's address"
  if (isInstanceView(v)) return v.location ? safeNumber(v.location.value) : v.addr;
  return undefined;
}

function constantValue(text: string): number | bigint | undefined {
  const integer = exactInteger(text);
  return integer === undefined ? toNumber(text) : safeNumber(integer) ?? integer;
}

function packAddressOf(value: unknown, buffer?: BufferValue): number | undefined {
  if (isInstanceView(value) && value.location) return packAddressOf(value.location, buffer);
  if (isMappedAddress(value)) {
    return buffer && sameMapping(value, buffer) ? safeNumber(value.value) : undefined;
  }
  const addr = addressInteger(isInstanceView(value) ? value.addr : value);
  return addr === undefined ? undefined : safeNumber(addr);
}

/**
 * 求值计数器（仅用于性能验收：拖动期必须为 0）。
 * 挂在 `window.__bp` 上，不改变求值语义与返回值；验收脚本直接读它。
 */
function countEvalRun(): void {
  if (typeof window === 'undefined') return;
  const s = (window.__bp ??= { evalRuns: 0 });
  s.evalRuns += 1;
}

/** 稳定的问题原因码（UI 与测试都用它做锚点） */
export type ProblemCode =
  | 'CYCLE'
  | 'NO_SOURCE'
  | 'BAD_INPUT'
  | 'INDEX_OUT_OF_RANGE'
  | 'UNKNOWN_NODE'
  | 'NODE_MISSING'
  | 'PACK_DISABLED'
  | 'EVAL_FAILED'
  | 'OUT_OF_BOUNDS'
  | 'SOURCE_CONFLICT'
  | 'SOURCE_CYCLE'
  | 'INVALID_VALUE'
  | 'TRUNCATED'
  | 'PORT_MISSING'
  | ReadIssue['code'];

export function evaluateGraph(
  nodes: BPNode[], edges: BPEdge[], packs: Map<string, BlueprintPack>,
  opts?: { disabledPacks?: Set<string>; layouts?: readonly BinaryLayout[] },
): BPResult {
  countEvalRun();
  const started = performance.now();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Map<string, BPEdge>>();
  for (const e of edges) {
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) continue;
    let m = incoming.get(e.to.node);
    if (!m) incoming.set(e.to.node, (m = new Map()));
    m.set(e.to.port, e);
  }
  const outputs = new Map<string, Record<string, unknown>>();
  const views = new Map<string, NodeView>();
  const ports = new Map<string, { inputs: PortSpec[]; outputs: PortSpec[] }>();
  const sources = new Map<string, SourceInfo>();
  const inputValues = new Map<string, Record<string, InputValue>>();
  const origins = new Map<string, Record<string, ByteOrigin>>();
  const problemOrigins = new Map<string, ByteOrigin>();
  const problems: Problem[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const structures = buildStructureRegistry(opts?.layouts ?? [], packs);
  const activePacks = structures.packs;
  const declaredPorts = (node: BPNode, view?: NodeView) => portsFor(node, packs, view, opts?.layouts, structures);

  /**
   * 问题条目：`message` 只写「对象：事实」，可执行建议放 `detail`，原因码放
   * `code` 字段（不再拼进字符串）。UI 与测试都用 `code` 过滤。
   */
  const add = (
    node: BPNode,
    severity: Problem['severity'],
    message: string,
    code: ProblemCode,
    detail?: string,
    addr?: bigint,
    origin?: ByteOrigin,
  ) => {
    problems.push({ severity, code, nodeKey: node.id, message, ...(detail ? { detail } : {}),
      ...(addr === undefined ? {} : { addr }), ...(origin?.fieldId ? { fieldId: origin.fieldId } : {}) });
    if (origin) problemOrigins.set(node.id, origin);
  };
  const publishOrigin = (nodeId: string, port: string, origin: ByteOrigin) => {
    let byPort = origins.get(nodeId);
    if (!byPort) origins.set(nodeId, (byPort = Object.create(null) as Record<string, ByteOrigin>));
    byPort[port] = origin;
  };
  const inputOrigin = (nodeId: string, port: string) => {
    const input = incoming.get(nodeId)?.get(port);
    return input && (origins.get(input.from.node)?.[input.from.port] ?? problemOrigins.get(input.from.node));
  };

  /* ---------------------------------------------------------- source trace */
  const assets = createAssetTable();
  const fileBuffers = new Map<string, BufferValue>();
  const fileErrors = new Map<string, string>();
  const bufferOfFile = (n: BPNode): BufferValue | undefined => {
    if (!n.source || (!n.source.data && !sessionBytesOf(n.source))) return undefined;
    const hit = fileBuffers.get(n.id);
    if (hit) return hit;
    // 同内容只保留一份字节：第二次解码的数组被资产表里的第一份替换掉
    if (fileErrors.has(n.id)) return undefined;
    const base = addressInteger(n.source.base);
    let bytes: Uint8Array;
    try { bytes = decodeBuffer(n.source); }
    catch { fileErrors.set(n.id, '文件内联字节无效'); return undefined; }
    if (base === undefined || base + BigInt(bytes.length) > MAX_ADDRESS + 1n) {
      fileErrors.set(n.id, '转储映射超出 64 位地址范围');
      return undefined;
    }
    const asset = assets.ensure(bytes);
    const value: BufferValue = { assetId: asset.id, name: n.source.name, base: safeNumber(base) ?? base, bytes: asset.bytes };
    fileBuffers.set(n.id, value);
    return value;
  };
  const isFile = (n: BPNode) => n.packId === '' && n.nodeId === 'file';
  /**
   * A pure constant (Number) has no file identity at all, so it must never
   * pass a file downstream. Parsing nodes do: even an isolated one is bound to
   * the graph's default file, and its children inherit exactly that file.
   */
  const carriesContext = (n: BPNode): boolean =>
    isFile(n) || declaredPorts(n).inputs.some((p) => p.context);
  const mappings = new Map<string, BPNode>();
  for (const n of nodes) {
    const buffer = isFile(n) ? bufferOfFile(n) : undefined;
    if (buffer) {
      const key = `${buffer.assetId}@${buffer.base}`;
      if (!mappings.has(key)) mappings.set(key, n);
    }
  }
  const availableFiles = [...mappings.values()];
  const defaultFile = availableFiles.length === 1 ? availableFiles[0] : undefined;
  const defaultBuffer = defaultFile ? bufferOfFile(defaultFile) : undefined;

  const chainOf = (self: BPNode, from: SourceInfo): string[] =>
    [self.id, ...from.chain.filter((id) => id !== self.id)];

  /**
   * 数据源线是否是"值依赖"：上游端口本身产出字符串/字节。
   * 这类线要把那个值当作基址 0 的内存镜像，而它必须求值上游端口——
   * 但那是**值**依赖，环检测交给求值状态机，不再与来源遍历共用访问集。
   * 判定只看端口声明类型，不执行任何节点。
   */
  const handsBytes = (src: BPNode, port: string): boolean => {
    const spec = declaredPorts(src).outputs.find((p) => p.name === port);
    if (spec) return spec.type === 'string' || spec.type === 'bytes' || spec.type === 'span';
    // Stable field IDs let us classify local record outputs even before a collection item is selected.
    if (!src.packId && (src.nodeId === 'item' || src.nodeId === 'element')) {
      const field = /^field:([^:]+):([^:]+)$/.exec(port);
      const structure = field ? structures.get(field[1]) : undefined;
      const f = field && structure?.layout?.fields.find((x) => x.id === field[2]);
      return !!f && ['string', 'bytes'].includes(layoutFieldType(f));
    }
    return false;
  };

  const infoCache = new Map<string, SourceInfo>();
  const cacheKey = (id: string, root: boolean) => `${root ? 'r' : 'c'}:${id}`;

  // `root` is true only for the node whose source we are resolving. A node
  // visited while walking upstream must NOT inject the graph's default file:
  // a Number constant, for example, carries no file context at all. Otherwise
  // one stray constant edge would make a two-file graph look like a conflict.
  const trace = (node: BPNode, visiting: Set<string>, root: boolean): SourceInfo => {
    const key = cacheKey(node.id, root);
    const hit = infoCache.get(key);
    if (hit) return hit;
    if (visiting.has(node.id)) {
      // 继承链自环：不复用 CYCLE（那是值依赖的环），也不缓存
      return { mode: 'none', chain: [node.id], sourceCycle: true };
    }
    visiting.add(node.id);
    const result = resolveSource(node, visiting, root);
    visiting.delete(node.id);
    if (!result.sourceCycle) infoCache.set(key, result);
    return result;
  };

  const resolveSource = (node: BPNode, visiting: Set<string>, root: boolean): SourceInfo => {
    const inc = incoming.get(node.id);

    // 1. an explicit source wire beats everything else: it is the connection
    //    the user just drew, and must win over a `sourceId` that came along
    //    with a copied node or was pinned earlier. If that wire hands over no
    //    file (a constant, a Note, an empty File), the wire still wins: the
    //    node reports it instead of silently decoding a different file.
    const wire = inc?.get(SOURCE_PORT);
    if (wire) {
      const src = byId.get(wire.from.node);
      if (src && handsBytes(src, wire.from.port)) {
        // 值依赖：字节在求值该节点时才算（见 resolvePendingValue）
        return {
          mode: 'explicit',
          chain: [node.id, src.id],
          via: { node: wire.from.node, port: wire.from.port },
          pendingValue: true,
          valueSource: { node: wire.from.node, port: wire.from.port },
        };
      }
      const r = src ? trace(src, visiting, false) : undefined;
      return {
        buffer: r?.buffer,
        fileId: r?.fileId,
        mode: 'explicit',
        chain: chainOf(node, r ?? { mode: 'none', chain: src ? [src.id] : [] }),
        via: { node: wire.from.node, port: wire.from.port },
        wireMissing: !r?.buffer && !r?.pendingValue,
        pendingValue: r?.pendingValue,
        valueSource: r?.valueSource,
        conflict: r?.conflict,
        candidates: r?.candidates,
        sourceCycle: r?.sourceCycle,
      };
    }

    // 2. pinned in the inspector — an explicit choice for this node only
    const pinnedId = node.params?.sourceId;
    if (pinnedId) {
      const f = byId.get(pinnedId);
      const b = f && isFile(f) ? bufferOfFile(f) : undefined;
      if (b) return { buffer: b, fileId: f!.id, mode: 'override', chain: [node.id, f!.id] };
      // Picking a file is an explicit choice too: keep it authoritative even
      // when that File has no bytes yet, so the node never reads elsewhere.
      return { mode: 'override', chain: f ? [node.id, f.id] : [node.id], pinMissing: true };
    }
    // 3. this node is the origin of the bytes
    if (isFile(node)) {
      const b = bufferOfFile(node);
      return { buffer: b, fileId: b ? node.id : undefined, mode: b ? 'file' : 'none', chain: [node.id] };
    }

    // 4. inherit through every other incoming edge, one hop at a time
    const found: { info: SourceInfo; edge: BPEdge }[] = [];
    const onlyPort = !node.packId ? getBuiltin(node.nodeId)?.inheritSourceFrom : undefined;
    for (const e of inc?.values() ?? []) {
      if (e.to.port === SOURCE_PORT || (onlyPort && e.to.port !== onlyPort)) continue;
      const src = byId.get(e.from.node);
      if (!src) continue;
      const r = trace(src, visiting, false);
      if (r.buffer || r.pendingValue || r.wireMissing || r.pinMissing || r.conflict) found.push({ info: r, edge: e });
    }
    if (found.length) {
      const first = found[0].info;
      const names = found.map(({ info, edge }) => info.buffer?.name ?? nodeLabelOf(byId.get(edge.from.node), activePacks));
      const identity = (r: SourceInfo): string => r.valueSource
        ? JSON.stringify(r.valueSource)
        : r.buffer ? `${r.buffer.assetId}@${r.buffer.mappingBase ?? r.buffer.base}:${r.buffer.base}+${r.buffer.bytes.length}`
          : `missing:${r.chain[r.chain.length - 1]}`;
      const conflict = found.some((f) => f.info.conflict || identity(f.info) !== identity(first));
      return {
        buffer: conflict ? undefined : first.buffer,
        fileId: conflict ? undefined : first.fileId,
        mode: 'upstream',
        chain: chainOf(node, first),
        via: { node: found[0].edge.from.node, port: found[0].edge.from.port },
        conflict,
        pendingValue: !conflict && first.pendingValue,
        valueSource: !conflict ? first.valueSource : undefined,
        wireMissing: first.wireMissing,
        pinMissing: first.pinMissing,
        candidates: conflict ? [...new Set(names)] : undefined,
        sourceCycle: found.some((f) => f.info.sourceCycle),
      };
    }

    // 5. Fall back only to a unique mapping; constants stay context-free.
    if (!root && !carriesContext(node)) return { mode: 'none', chain: [node.id] };
    // 没有任何输入端口且不是 File 的节点（「标注 / Note」这类纯文档）：
    // 永远不归属文件，即使它自己就是当前解析目标。
    if (!isFile(node) && declaredPorts(node).inputs.length === 0) {
      return { mode: 'none', chain: [node.id] };
    }
    return {
      buffer: defaultBuffer,
      fileId: defaultFile?.id,
      mode: defaultBuffer ? 'default' : 'none',
      chain: defaultFile ? [node.id, defaultFile.id] : [node.id],
      ...(availableFiles.length > 1 ? { conflict: true, candidates: availableFiles.map((f) => f.source!.name) } : {}),
    };
  };

  /**
   * 求值前把全图来源算完：这一步只读图结构、节点参数与资产表，不执行任何
   * 节点，因此 `sources` 在某个节点求值失败时也是完整的。
   */
  const resolveAllSources = () => {
    for (const n of nodes) trace(n, new Set(), true);
  };

  const sourceOf = (node: BPNode): SourceInfo => trace(node, new Set(), true);

  /** 值依赖的数据源线：在求值该节点时才算上游端口，环由状态机判定 */
  const resolvePendingValue = (info: SourceInfo): SourceInfo => {
    if (!info.pendingValue || !info.valueSource) return info;
    const { node: sourceId, port } = info.valueSource;
    const src = byId.get(sourceId);
    if (!src) return { ...info, pendingValue: false, wireMissing: true };
    const handed = evalNode(src)[port];
    const buffer = valueAsBuffer(handed);
    if (buffer) {
      if (!isByteSpan(handed)) buffer.bytes = assets.ensure(buffer.bytes).bytes;
      return { ...info, buffer, pendingValue: false };
    }
    // 明确选中的范围或字节失效，不得扩大到上游的整份转储。
    return { ...info, pendingValue: false, wireMissing: true };
  };

  /** 同一节点的有效来源只算一次：evalBody 与发布 `sources` 都读它 */
  const resolvedSources = new Map<string, SourceInfo>();
  const effectiveSourceOf = (node: BPNode): SourceInfo => {
    const hit = resolvedSources.get(node.id);
    if (hit) return hit;
    const info = resolvePendingValue(sourceOf(node));
    const withAsset = info.buffer?.assetId ? { ...info, assetId: info.buffer.assetId } : info;
    resolvedSources.set(node.id, withAsset);
    return withAsset;
  };

  /* ------------------------------------------------------------- node eval */
  const evalNode = (node: BPNode): Record<string, unknown> => {
    const st = state.get(node.id);
    if (st === 1) {
      add(node, 'error', '节点：图里有环，已跳过', 'CYCLE');
      return {};
    }
    if (st === 2) return outputs.get(node.id) ?? {};
    state.set(node.id, 1);

    const before = problems.length;
    const out = evalBody(node);

    // dynamic ports depend on decoded data, so publish them after evaluation
    const view = views.get(node.id);
    const extra = dynamicOf(view);
    for (const [name, value] of Object.entries(extra.values)) {
      if (!(name in out)) out[name] = value;
    }
    ports.set(node.id, declaredPorts(node, view));
    const info = effectiveSourceOf(node);
    sources.set(node.id, info);
    const instance = view?.kind === 'struct' || view?.kind === 'element' ? view.inst : undefined;
    if (instance?.location && info.buffer && sameMapping(instance.location, info.buffer)) {
      const buffer = info.buffer;
      const address = instance.location.value;
      for (const f of instance.fields) {
        publishOrigin(node.id, f.name, { buffer, address: address + BigInt(f.offset), length: f.size, fieldId: f.name });
      }
    }
    for (const [port, value] of Object.entries(out)) {
      if (isByteSpan(value)) publishOrigin(node.id, port, {
        buffer: value.buffer, address: BigInt(value.buffer.base), length: value.buffer.bytes.length,
      });
    }
    if (info.sourceCycle) {
      add(node, 'warn', '数据源：继承链形成环', 'SOURCE_CYCLE',
        '断开其中一条连线，或在检查器里指定数据源');
    }
    if (info.conflict && !isFile(node) && carriesContext(node)) {
      add(node, 'warn', '数据源：上游连到了不同的输入文件', 'SOURCE_CONFLICT',
        `候选 ${(info.candidates ?? []).join('、')}；请明确选择数据源`);
    }
    // An explicit source that hands over no file is reported once: a buffer
    // consumer already fails inside the body with the same explanation, and a
    // node that ignores the buffer still deserves to know its wire is empty.
    const selfReported = problems.slice(before).some((p) => p.nodeKey === node.id);
    if (info.wireMissing && !selfReported) {
      add(node, 'warn', '数据源：连线的来源没有文件内容', 'NO_SOURCE',
        '给来源节点载入 .bin/.hex，或断开这条数据源连线');
    }
    if (info.pinMissing && !selfReported) {
      add(node, 'warn', '数据源：指定的文件还没有载入内容', 'NO_SOURCE',
        '给该 File 节点载入 .bin/.hex，或把「指定数据源」改回自动');
    }
    state.set(node.id, 2);
    return out;
  };

  const portLabelOf = (src: BPNode | undefined, port: string): string => {
    if (!src) return port;
    const spec = ports.get(src.id)?.outputs.find((p) => p.name === port)
      ?? declaredPorts(src).outputs.find((p) => p.name === port);
    return spec?.label ?? port;
  };

  const evalBody = (node: BPNode): Record<string, unknown> => {
    const portInfo = declaredPorts(node);
    const builtin = !node.packId ? getBuiltin(node.nodeId) : undefined;
    const resolved: Record<string, InputValue> = {};
    inputValues.set(node.id, resolved);

    const out: Record<string, unknown> = {};
    outputs.set(node.id, out);

    const inputOf = (name: string): unknown => {
      const spec = portInfo.inputs.find((p) => p.name === name);
      const inline = node.params[name] ?? (builtin?.precise ? builtin.defaults?.[name] : '') ?? '';
      const e = incoming.get(node.id)?.get(name);
      if (e) {
        const src = byId.get(e.from.node);
        let value: unknown;
        if (spec?.context) {
          value = sourceInfo.buffer;
        } else if (src) {
          const srcOut = evalNode(src);
          value = srcOut[e.from.port];
          const from = ports.get(src.id)?.outputs.find((p) => p.name === e.from.port);
          if (spec && (builtin?.precise || spec.type === 'pack-address') && (!from || !canConnect(from.type, spec.type))) value = undefined;
          if (spec?.type === 'address' && (from?.type === 'pack-address' || isInstanceView(value))) {
            const location = isInstanceView(value) ? value.location : undefined;
            const at = addressInteger(isInstanceView(value) ? value.addr : value);
            const buffer = resolvedSources.get(src.id)?.buffer;
            value = location ?? (buffer && at !== undefined ? mappedAddress(buffer, at) : undefined);
          }
        }
        resolved[name] = {
          value,
          display: formatInputValue(value, name, inline, spec?.type),
          wired: true,
          from: {
            node: e.from.node,
            port: e.from.port,
            label: `${nodeLabelOf(src, activePacks)} · ${portLabelOf(src, e.from.port)}`,
          },
          inline,
          invalid: value === undefined,
        };
        return value;
      }
      const value = spec?.context ? sourceInfo.buffer : spec?.type === 'numeric' ? (exactInteger(inline) ?? (
        /^[+-]?(?:\d*\.\d+|\d+\.)(?:e[+-]?\d+)?$/i.test(inline.trim()) ? toNumber(inline) : undefined
      )) : spec?.type === 'pack-address' ? packAddressOf(inline)
        : isExactPort(spec?.type) ? exactInteger(inline)
          : spec?.type === 'number' ? toNumber(inline) : (inline === '' ? undefined : inline);
      resolved[name] = {
        value,
        display: value === undefined ? '∅' : formatInputValue(value, name, inline, spec?.type),
        wired: false,
        inline,
        invalid: value === undefined && spec?.context !== true,
      };
      return value;
    };
    const requireNumber = (name: string, fallback?: number): number | undefined => {
      const v = inputOf(name);
      if (v == null) return fallback;
      const n = name === 'address' ? packAddressOf(v, sourceInfo.buffer) : toNumber(v);
      if (n == null) {
        add(node, 'error', `输入 ${name}：不是数字`, 'BAD_INPUT', `收到 ${String(v)}`);
        return undefined;
      }
      return n;
    };

    const setView = (v: NodeView) => views.set(node.id, v);
    const sourceInfo = effectiveSourceOf(node);
    // Passed to built-ins so a missing buffer explains *why*: "wire has no
    // file" is actionable, "needs a buffer" sounds like nothing is wired.
    const sourceNote = sourceInfo.wireMissing
      ? '数据源：连线的来源没有文件内容——载入来源文件，或断开这条数据源连线'
      : sourceInfo.pinMissing
        ? '数据源：指定的文件还没有载入内容——给它载入 .bin/.hex，或把「指定数据源」改回自动'
        : undefined;

    try {
      // A context input displays the resolved source, without evaluating a source-only edge.
      for (const p of portInfo.inputs) inputOf(p.name);

      /* built-ins */
      if (node.packId === '') {
        if (node.nodeId === 'file') {
          const src = node.source;
          const buffer = bufferOfFile(node);
          if (!buffer) {
            const error = fileErrors.get(node.id) ?? '未载入文件';
            add(node, 'error', `文件：${error}`, src?.data ? 'BAD_INPUT' : 'NO_SOURCE');
            setView({ kind: 'file', name: src?.name ?? node.params.name ?? '未载入', size: 0, base: 0, error });
            out.size = 0;
          } else {
            out[SOURCE_PORT] = buffer;
            out.base = mappedAddress(buffer, BigInt(buffer.base));
            out.size = buffer.bytes.length;
            setView({ kind: 'file', name: buffer.name, size: buffer.bytes.length, base: buffer.base });
          }
          return out;
        }
        if (node.nodeId === 'number') {
          const n = constantValue(node.params.value ?? '0');
          if (n == null) {
            add(node, 'error', '数值：需要一个数字', 'BAD_INPUT');
            setView({ kind: 'number', value: 0, error: '需要一个数字' });
            out.value = undefined;
          } else {
            out.value = n;
            setView({ kind: 'number', value: n });
          }
          return out;
        }
        if (node.nodeId === 'element') {
          const bound = (node.params.typeId ?? '') !== '';
          const direct = inputOf('instance');
          let item: InstanceView | undefined;
          let index = 0;
          if (isInstanceView(direct)) {
            item = direct;
            index = direct.index ?? 0;
          } else {
            const list = inputOf('list');
            if (Array.isArray(list)) {
              index = requireNumber('index', 0) ?? 0;
              const entry = list[index];
              item = isInstanceView(entry) ? entry : undefined;
              if (!item) {
                add(node, 'error', `元素：下标 ${index} 超出范围`, 'INDEX_OUT_OF_RANGE', `列表共 ${list.length} 项`);
                setView({ kind: 'element', error: `下标 ${index} 越界` });
              }
            } else {
              // 地址模式：没有接元素/列表时，按跟随地址推断出的类型在该地址解码。
              // 没有绑定类型的空节点是合法状态——不铺字段、也不报错。
              const addr = packAddressOf(inputOf('address'), sourceInfo.buffer);
              if (addr == null) {
                if (bound) {
                  add(node, 'error', '元素：已绑定类型但缺少地址', 'BAD_INPUT', '接一个地址端口，或删除这个节点');
                  setView({ kind: 'element', error: '需要地址' });
                } else {
                  setView({ kind: 'element' });
                }
              } else {
                let pack = activePacks.get(node.params.packId ?? '');
                let type = pack?.types[node.params.typeId ?? ''];
                if (!type) {
                  for (const p of activePacks.values()) {
                    const t = p.types[node.params.typeId ?? ''];
                    if (t) { pack = p; type = t; break; }
                  }
                }
                if (!pack || !type) {
                  add(node, 'error', '元素：没有可用的类型', 'BAD_INPUT',
                    '类型由「在此地址解析」推断写入；空节点请接元素 / 列表端口');
                  setView({ kind: 'element', error: '没有可用的类型' });
                } else if (!sourceInfo.buffer) {
                  add(node, 'error', sourceInfo.wireMissing
                    ? '数据源：连线来源没有文件内容'
                    : sourceInfo.pinMissing
                      ? '数据源：指定的文件还没有载入内容'
                      : '数据源：需要缓冲区', 'NO_SOURCE',
                  sourceNote ?? '把 File 节点连到「数据源」，或放到某条继承链下游');
                  setView({ kind: 'element', error: '需要输入文件' });
                } else {
                  const mem = packMemory(sourceInfo.buffer);
                  if (!mem) throw new Error('该 pack 只支持安全整数地址');
                  const compat = compatPack(pack);
                  const entry = makeEntry(mem, pack, compat, packMemApi(mem), type.name, addr);
                  item = makeView(entry, compat, mem);
                }
              }
            }
          }
          if (item) {
            setView({ kind: 'element', inst: item });
            for (const f of item.fields) out[f.name] = f.value;
            out.index = index;
          }
          return out;
        }
        const def = builtin;
        if (def?.run) {
          const values: Record<string, unknown> = {};
          let invalid = false;
          for (const p of portInfo.inputs) {
            let v = resolved[p.name]?.value;
            // A context input with no wire still sees the inherited file.
            if (v == null && p.name === SOURCE_PORT && p.type === 'buffer') {
              v = sourceInfo.buffer;
              const rec = resolved[p.name];
              if (rec) {
                rec.value = v;
                rec.display = formatInputValue(v, p.name, rec.inline, p.type);
                rec.invalid = v == null;
              }
            }
            if (def.precise) {
              if (p.context) {
                if (sourceInfo.conflict) throw new ReadIssue('SOURCE_CONFLICT', '来源不唯一，请指定数据源');
              } else if (!def.acceptMissing && v == null && (resolved[p.name]?.wired || resolved[p.name]?.inline.trim())) {
                throw new ReadIssue('BAD_INPUT', `${p.label}：输入未能求值或类型不匹配`);
              }
              values[p.name] = v;
            } else if (v == null) {
              add(node, 'error', `输入 ${p.name}：缺少值`, 'BAD_INPUT');
              invalid = true;
            } else if (p.type === 'number' && toNumber(v) == null) {
              add(node, 'error', `输入 ${p.name}：不能无损地作为数值使用`, 'BAD_INPUT');
              invalid = true;
            } else {
              values[p.name] = p.type === 'number' ? toNumber(v) : v;
            }
          }
          if (invalid) {
            setView({ kind: 'calc', outputs: out, error: '输入缺失或无法无损转换' });
            return out;
          }
          const bctx = makeBuiltinCtx(sourceInfo.buffer, node.params, sourceNote, structures,
            (issue, warn, origin) => add(node, warn ? 'warn' : 'error', issue.message, issue.code, undefined, issue.address,
              origin ?? (issue.address !== undefined && sourceInfo.buffer
                ? { buffer: sourceInfo.buffer, address: issue.address, length: issue.length ?? 1 } : undefined)),
            (port) => inputOrigin(node.id, port), (port, origin) => publishOrigin(node.id, port, origin));
          const produced = def.run(values, bctx) ?? {};
          const view = def.view?.(produced);
          for (const p of declaredPorts(node, view).outputs) out[p.name] = produced[p.name];
          let detail: string | undefined;
          try { detail = def.detail?.(values, produced, bctx); } catch { detail = undefined; }
          setView(view ?? { kind: 'calc', outputs: out, detail });
          return out;
        }
        add(node, 'error', `节点：未知内置类型 ${node.nodeId}`, 'UNKNOWN_NODE');
        return out;
      }

      const pack = activePacks.get(node.packId);
      const def: NodeDef | undefined = pack?.nodes[node.nodeId];
      if (!pack || !def) {
        if (opts?.disabledPacks?.has(node.packId)) {
          add(node, 'error', '节点：所属 pack 已禁用', 'PACK_DISABLED', `${node.packId}/${node.nodeId}`);
          setView({ kind: 'struct', error: 'pack 已禁用' });
        } else {
          add(node, 'error', '节点：找不到节点定义', 'NODE_MISSING', `${node.packId}/${node.nodeId}`);
        }
        return out;
      }
      const compat = compatPack(pack);
      const buffer = sourceInfo.buffer;
      const mem = buffer ? packMemory(buffer) : new Memory(new Uint8Array(0), 0);
      if (!mem) throw new Error('该 pack 只支持安全整数地址');
      const memApi = packMemApi(mem);
      const ctxBase = {
        mem: memApi, pack, nodeId: node.id, endian: pack.endian, pointerSize: pack.pointerSize,
        consts: pack.constants,
        read: (type: { name: string }, addr: number) => makeEntry(mem, pack, compat, memApi, type.name, addr),
      } as EvalCtx;

      if (def.kind === 'struct') {
        const address = requireNumber('address');
        if (!buffer) {
          add(node, 'error', sourceInfo.wireMissing
            ? '数据源：连线来源没有文件内容'
            : sourceInfo.pinMissing
              ? '数据源：指定的文件还没有载入内容'
              : '数据源：需要缓冲区', 'NO_SOURCE',
          sourceNote ?? '把 File 节点连到「数据源」，或放到某条继承链下游');
          setView({ kind: 'struct', error: '需要输入文件' });
          return out;
        }
        if (address == null) {
          setView({ kind: 'struct', error: '需要地址' });
          return out;
        }
        const entry = makeEntry(mem, pack, compat, memApi, def.type.name, address);
        const view = makeView(entry, compat, mem);
        setView({ kind: 'struct', inst: view });
        for (const f of entry.type.fields) {
          // Nested records/arrays are real instances with their own location and
          // memory, not plain JSON. The element parser accepts an instance port,
          // so publishing the decoded object alone would leave it undecodable.
          const nestedType = f.ofType;
          if (f.kind === 'record' && nestedType) {
            try {
              const nested = makeEntry(mem, pack, compat, memApi, nestedType.name, address + (f.offset ?? 0));
              out[f.name] = makeView(nested, compat, mem);
              continue;
            } catch { /* fall back to the decoded plain value */ }
          }
          if (f.kind === 'array' && nestedType && f.count != null) {
            try {
              const stride = nestedType.size;
              const items: InstanceView[] = [];
              for (let i = 0; i < Math.min(f.count, MAX_DYNAMIC_PORTS); i += 1) {
                const nested = makeEntry(mem, pack, compat, memApi, nestedType.name,
                  address + (f.offset ?? 0) + i * stride, i);
                items.push(makeView(nested, compat, mem));
              }
              out[f.name] = items;
              continue;
            } catch { /* fall back to the decoded array */ }
          }
          out[f.name] = entry.value[f.name];
        }
        return out;
      }

      if (def.kind === 'list' || def.kind === 'array') {
        if (!buffer) {
          add(node, 'error', sourceInfo.wireMissing
            ? '数据源：连线来源没有文件内容'
            : sourceInfo.pinMissing
              ? '数据源：指定的文件还没有载入内容'
              : '数据源：需要缓冲区', 'NO_SOURCE',
          sourceNote ?? '把 File 节点连到「数据源」，或放到某条继承链下游');
          setView({ kind: def.kind, items: [], count: 0, error: '需要输入文件' });
          return out;
        }
        const address = def.kind === 'array' && def.offset
          ? (() => {
            const offset = inputOf('offset');
            if (offset == null) return undefined;
            try {
              const at = addOffset(BigInt(buffer.base), integerInput(offset, '文件偏移', 0n));
              const n = safeNumber(at);
              if (n === undefined) throw new ReadIssue('BAD_INPUT', '文件偏移超出安全整数地址范围');
              return n;
            } catch (e) {
              add(node, 'error', e instanceof Error ? e.message : String(e), 'BAD_INPUT');
              return undefined;
            }
          })()
          : requireNumber('address');
        if (address == null) {
          setView({ kind: def.kind, items: [], count: 0, error: '需要地址' });
          return out;
        }
        const items: InstanceView[] = [];
        let cycle = false;
        let error: string | undefined;
        let trunc: Truncation | undefined;

        if (def.kind === 'array') {
          const count = def.count ?? requireNumber('count');
          if (count == null || count < 0) {
            setView({ kind: 'array', items, count: 0, error: '需要数量' });
            return out;
          }
          const stride = def.stride ?? def.type.size;
          const limit = Math.min(Math.floor(count), 4096);
          for (let i = 0; i < limit; i++) {
            try {
              items.push(makeView(makeEntry(mem, pack, compat, memApi, def.type.name, address + i * stride, i), compat, mem));
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
              break;
            }
          }
          // 只有"没被错误打断、且请求数量超过上限"才算因上限停止
          if (!error && count > limit) {
            trunc = { limit, at: limit, unit: 'index', canContinue: true };
            add(node, 'warn', `数组：达到上限 ${limit} 项`, 'TRUNCATED', `从第 ${limit} 项继续`);
          }
          setView({ kind: 'array', items, count: items.length, truncated: !!trunc, trunc, error });
        } else {
          const seen = new Set<number>();
          let addr = address;
          const max = Math.min(def.max ?? 4096, 4096);
          const nulls = new Set(def.nulls ?? []);
          // 用下标判定是否走完：循环正常结束说明"还有下一项但被上限拦住"，
          // 任何 break（本轮结束/回环/出错）都意味着不是因上限停止。
          let i = 0;
          for (; i < max; i++) {
            if (seen.has(addr)) { cycle = true; break; }
            seen.add(addr);
            let entry: EntryView;
            try {
              entry = makeEntry(mem, pack, compat, memApi, def.type.name, addr, i);
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
              break;
            }
            items.push(makeView(entry, compat, mem));
            let next: unknown;
            try {
              next = def.next(entry, ctxBase);
            } catch (e) {
              error = `next() 失败：${e instanceof Error ? e.message : String(e)}`;
              break;
            }
            if (next == null) break;
            const n = toNumber(next);
            if (n == null) { error = `next 返回了非数字：${String(next)}`; break; }
            if (nulls.has(n)) break;
            addr = n;
          }
          if (i === max) {
            trunc = { limit: max, at: addr, unit: 'address', canContinue: true };
            add(node, 'warn', `列表：达到上限 ${max} 条`, 'TRUNCATED', `从 0x${addr.toString(16)} 继续`);
          }
          setView({ kind: 'list', items, count: items.length, truncated: !!trunc, trunc, cycle, error });
        }

        out.list = items;
        out.count = items.length;
        return out;
      }

      if (def.kind === 'calc') {
        const inputs: Record<string, unknown> = {};
        for (const [name, t] of Object.entries(def.inputs)) {
          let v = inputOf(name);
          // a declared buffer input with no wire still sees the inherited file
          if (v == null && name === SOURCE_PORT && t === 'buffer') {
            v = sourceInfo.buffer;
            const rec = resolved[name];
            if (rec) {
              rec.value = v;
              rec.display = formatInputValue(v, name, rec.inline, t);
              rec.invalid = v == null;
            }
          }
          if (v == null) {
            add(node, 'error', `计算：缺少输入 ${name}`, 'BAD_INPUT');
          } else if (t === 'number' && toNumber(v) == null) {
            add(node, 'error', `输入 ${name}：不是数字`, 'BAD_INPUT');
          } else {
            inputs[name] = t === 'number' ? toNumber(v) : v;
          }
        }
        const result = def.run(inputs, ctxBase) ?? {};
        // 计算节点返回的对象不可信：只有解析节点用 makeView 登记过的实例
        // 才是元素；形似元素的对象降级为 JSON，并留下一条可定位的告警。
        let reported = false;
        for (const name of Object.keys(def.outputs)) {
          const v = result[name];
          if (looksLikeInstance(v)) {
            if (!reported) {
              reported = true;
              add(node, 'warn', `计算：输出 ${name} 只是形似元素的对象`, 'INVALID_VALUE',
                '元素必须由解析节点产出；该值已按 JSON 处理，下游不会按 addr 解码');
            }
            out[name] = toPlainJson(v);
          } else {
            out[name] = v;
          }
        }
        setView({ kind: 'calc', outputs: out });
        return out;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof ReadIssue ? e.code : /越界|超出|不在缓冲|out of range/i.test(msg) ? 'OUT_OF_BOUNDS' : 'EVAL_FAILED';
      const at = e instanceof ReadIssue ? e.address : undefined;
      const origin = at !== undefined && sourceInfo.buffer
        ? { buffer: sourceInfo.buffer, address: at, length: e instanceof ReadIssue ? e.length ?? 1 : 1 }
        : inputOrigin(node.id, 'span');
      add(node, 'error', '节点：求值失败', code, msg, at ?? origin?.address, origin);
      const builtin = node.packId === '';
      if (builtin && node.nodeId === 'number') setView({ kind: 'number', value: 0, error: msg });
      else if (builtin && node.nodeId === 'element') setView({ kind: 'element', error: msg });
      else if (builtin) setView({ kind: 'calc', outputs: out, error: msg });
      else setView({ kind: 'struct', error: msg });
    }

    return out;
  };

  // 来源与值求值分离：先只读图结构算完全图来源，再开始求值
  const sourceStart = performance.now();
  resolveAllSources();
  const msSource = performance.now() - sourceStart;
  for (const n of nodes) evalNode(n);

  // A port can disappear when an Element starts following a different element
  // type (or a pack is removed). Surface the now-dead wire instead of letting
  // it vanish silently on the canvas.
  const deadWires = new Set<string>();
  for (const e of edges) {
    const dst = byId.get(e.to.node);
    if (!dst) continue;
    const hasOut = ports.get(e.from.node)?.outputs.some((p) => p.name === e.from.port) ?? false;
    const hasIn = ports.get(e.to.node)?.inputs.some((p) => p.name === e.to.port) ?? false;
    if (hasOut && hasIn) continue;
    if (!hasOut && !hasIn) continue; // the node itself is gone; nothing to explain
    const key = `${e.to.node}:${e.to.port}:${e.from.node}:${e.from.port}`;
    if (deadWires.has(key)) continue;
    deadWires.add(key);
    add(
      dst, 'warn',
      hasIn
        ? `连线：输出端口 ${e.from.port} 不存在`
        : `连线：输入端口 ${e.to.port} 不存在`,
      'PORT_MISSING',
      hasIn
        ? `来源节点 ${e.from.node} 的类型或元素类型已改变`
        : `目标节点 ${e.to.node} 的类型已改变`,
    );
  }

  return { outputs, views, ports, sources, inputs: inputValues, assets, problems, origins, problemOrigins, ms: performance.now() - started, msSource };
}

/** Rough node height for layout; the canvas can use this for auto placement. */
export function nodeRowHeight(): number {
  return 22;
}

export { builtinLabel, fieldPortType, fieldSize };
