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
  BufferValue, InputValue, InstanceView, NodeDef, NodeView, PortSpec, PortType,
  SourceInfo, StoredMemory, Truncation,
} from './types';
import { fieldPortType, fieldPorts, builtinLabel, displayTitle, isInstanceView, brandInstance, looksLikeInstance } from './types';
import { createAssetTable, assetIdOf } from './assets';
import { getBuiltin, makeBuiltinCtx } from './builtins';
import { base64ToBytes } from './doc';

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
  if (typeof v === 'number') return String(v);
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
  if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v);
    return { assetId: assetIdOf(bytes), name: `字符串 ${v.length} 字符`, base: 0, bytes };
  }
  if (v instanceof Uint8Array) {
    return { assetId: assetIdOf(v), name: `字节 ${v.length} B`, base: 0, bytes: v };
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
  if (typeof v === 'number' && Number.isFinite(v)) {
    const hexish = type === 'number' && (portName === 'address' || /^\s*(0x|-?0X)/i.test(inline));
    if (hexish && Number.isInteger(v) && v >= 0) return `0x${v.toString(16)}`;
    return String(Number(v.toPrecision(8)));
  }
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 23)}…` : v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) return `⟨${v.length} B⟩`;
  if (isBufferValue(v)) return v.name;
  if (isInstanceView(v)) return `#${v.index ?? '?'} · 0x${v.addr.toString(16)}`;
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
        hint: `0x${item.addr.toString(16)} · ${elementText(item)}`,
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
): { inputs: PortSpec[]; outputs: PortSpec[] } {
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
          ...(bound ? [{ name: 'address', type: 'number' as PortType, label: '地址' }] : []),
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
          const decl = findTypeByName(inst.typeName, node.params.packId, packs);
          const byName = new Map<string, FieldDef>();
          for (const f of decl?.fields ?? []) byName.set(f.name, f);
          return {
            inputs,
            outputs: [
              ...inst.fields.map((f) => {
                const fd = byName.get(f.name);
                return {
                  name: f.name,
                  type: fd ? fieldPortType(fd) : portTypeOf(f.value),
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
    if (def) return { inputs: def.inputs, outputs: def.outputs };
    return { inputs: [], outputs: [] };
  }

  const pack = packs.get(node.packId);
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
    { name: 'address', type: 'number', label: '地址' },
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

const decodedBuffers = new WeakMap<StoredMemory, Uint8Array>();

function decodeBuffer(src: StoredMemory): Uint8Array {
  const hit = decodedBuffers.get(src);
  if (hit) return hit;
  const bytes = base64ToBytes(src.data);
  decodedBuffers.set(src, bytes);
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
        addr: addr + f.offset,
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
      offset: f.offset,
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
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  // an element wired into a number input means "that element's address"
  if (isInstanceView(v)) return v.addr;
  return undefined;
}

/**
 * 求值计数器（仅用于性能验收：拖动期必须为 0）。
 * 挂在 `window.__bp` 上，不改变求值语义与返回值。
 */
export function evalRunCount(): number {
  if (typeof window === 'undefined') return 0;
  return window.__bp?.evalRuns ?? 0;
}

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
  | 'INVALID_VALUE'
  | 'TRUNCATED'
  | 'PORT_MISSING';

export function evaluateGraph(
  nodes: BPNode[], edges: BPEdge[], packs: Map<string, BlueprintPack>,
  opts?: { disabledPacks?: Set<string> },
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
  const problems: Problem[] = [];
  const state = new Map<string, 0 | 1 | 2>();

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
  ) => {
    problems.push({ severity, code, nodeKey: node.id, message, ...(detail ? { detail } : {}) });
  };

  /* ---------------------------------------------------------- source trace */
  const assets = createAssetTable();
  const fileBuffers = new Map<string, BufferValue>();
  const bufferOfFile = (n: BPNode): BufferValue | undefined => {
    if (!n.source) return undefined;
    const hit = fileBuffers.get(n.id);
    if (hit) return hit;
    // 同内容只保留一份字节：第二次解码的数组被资产表里的第一份替换掉
    const asset = assets.ensure(decodeBuffer(n.source));
    const value: BufferValue = { assetId: asset.id, name: n.source.name, base: n.source.base, bytes: asset.bytes };
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
    isFile(n) || portsFor(n, packs).inputs.some((p) => p.context);
  const defaultFile = nodes.find((n) => isFile(n) && n.source);
  const defaultBuffer = defaultFile ? bufferOfFile(defaultFile) : undefined;

  const chainOf = (self: BPNode, from: SourceInfo): string[] =>
    [self.id, ...from.chain.filter((id) => id !== self.id)];

  // `root` is true only for the node whose source we are resolving. A node
  // visited while walking upstream must NOT inject the graph's default file:
  // a Number constant, for example, carries no file context at all. Otherwise
  // one stray constant edge would make a two-file graph look like a conflict.
  const trace = (node: BPNode, stack: Set<string>, root: boolean): SourceInfo => {
    if (stack.has(node.id)) return { mode: 'none', chain: [node.id] };
    stack.add(node.id);
    const result = resolveSource(node, stack, root);
    stack.delete(node.id);
    return result;
  };

  const resolveSource = (node: BPNode, stack: Set<string>, root: boolean): SourceInfo => {
    const inc = incoming.get(node.id);

    // 1. an explicit source wire beats everything else: it is the connection
    //    the user just drew, and must win over a `sourceId` that came along
    //    with a copied node or was pinned earlier. If that wire hands over no
    //    file (a constant, a Note, an empty File), the wire still wins: the
    //    node reports it instead of silently decoding a different file.
    const wire = inc?.get(SOURCE_PORT);
    if (wire) {
      const src = byId.get(wire.from.node);
      // 端口的值本身就是字符串/字节时，直接把它当作缓冲区（基址 0），
      // 优先于「沿用上游节点的文件」——用户接上这段内容就是要读它。
      const handed = src ? evalNode(src)[wire.from.port] : undefined;
      const handedBuffer = valueAsBuffer(handed);
      if (handedBuffer) {
        return {
          buffer: handedBuffer,
          mode: 'explicit',
          chain: chainOf(node, { mode: 'none', chain: [src!.id] }),
          via: { node: wire.from.node, port: wire.from.port },
        };
      }
      const r = src ? trace(src, stack, false) : undefined;
      return {
        buffer: r?.buffer,
        fileId: r?.fileId,
        mode: 'explicit',
        chain: chainOf(node, r ?? { mode: 'none', chain: src ? [src.id] : [] }),
        via: { node: wire.from.node, port: wire.from.port },
        wireMissing: !r?.buffer,
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
    for (const e of inc?.values() ?? []) {
      if (e.to.port === SOURCE_PORT) continue;
      const src = byId.get(e.from.node);
      if (!src) continue;
      const r = trace(src, stack, false);
      if (r.buffer) found.push({ info: r, edge: e });
    }
    if (found.length) {
      const first = found[0].info;
      const names = found.map((f) => f.info.buffer?.name ?? '?');
      const conflict = found.some((f) => f.info.fileId !== first.fileId);
      return {
        buffer: first.buffer,
        fileId: first.fileId,
        mode: 'upstream',
        chain: chainOf(node, first),
        via: { node: found[0].edge.from.node, port: found[0].edge.from.port },
        conflict,
        candidates: conflict ? [...new Set(names)] : undefined,
      };
    }

    // 5. A node with no upstream file context falls back to the graph's first
    //    loaded File. An intermediate hop only gets that fallback when it is
    //    itself a parsing node; constants stay context-free.
    if (!root && !carriesContext(node)) return { mode: 'none', chain: [node.id] };
    // 没有任何输入端口且不是 File 的节点（「标注 / Note」这类纯文档）：
    // 永远不归属文件，即使它自己就是当前解析目标。
    if (!isFile(node) && portsFor(node, packs).inputs.length === 0) {
      return { mode: 'none', chain: [node.id] };
    }
    return {
      buffer: defaultBuffer,
      fileId: defaultFile?.id,
      mode: defaultBuffer ? 'default' : 'none',
      chain: defaultFile ? [node.id, defaultFile.id] : [node.id],
    };
  };

  const sourceCache = new Map<string, SourceInfo>();
  const sourceOf = (node: BPNode): SourceInfo => {
    let s = sourceCache.get(node.id);
    if (!s) {
      s = trace(node, new Set(), true);
      sourceCache.set(node.id, s);
    }
    return s;
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
    ports.set(node.id, portsFor(node, packs, view));
    const info = sourceOf(node);
    sources.set(node.id, info.buffer?.assetId ? { ...info, assetId: info.buffer.assetId } : info);
    if (info.conflict && !isFile(node)) {
      add(node, 'warn', '数据源：上游连到了不同的输入文件', 'SOURCE_CONFLICT',
        `候选 ${(info.candidates ?? []).join('、')}；当前使用 ${info.buffer?.name ?? '?'}`);
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
      ?? portsFor(src, packs).outputs.find((p) => p.name === port);
    return spec?.label ?? port;
  };

  const evalBody = (node: BPNode): Record<string, unknown> => {
    const portInfo = portsFor(node, packs);
    const resolved: Record<string, InputValue> = {};
    inputValues.set(node.id, resolved);

    const out: Record<string, unknown> = {};
    outputs.set(node.id, out);

    const inputOf = (name: string): unknown => {
      const spec = portInfo.inputs.find((p) => p.name === name);
      const inline = node.params[name] ?? '';
      const e = incoming.get(node.id)?.get(name);
      if (e) {
        const src = byId.get(e.from.node);
        let value: unknown;
        if (src) {
          const srcOut = evalNode(src);
          value = srcOut[e.from.port];
        }
        resolved[name] = {
          value,
          display: formatInputValue(value, name, inline, spec?.type),
          wired: true,
          from: {
            node: e.from.node,
            port: e.from.port,
            label: `${nodeLabelOf(src, packs)} · ${portLabelOf(src, e.from.port)}`,
          },
          inline,
          invalid: value === undefined,
        };
        return value;
      }
      const value = spec?.type === 'number' ? toNumber(inline === '' ? undefined : inline) : (inline === '' ? undefined : inline);
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
      const n = toNumber(v);
      if (n == null) {
        add(node, 'error', `输入 ${name}：不是数字`, 'BAD_INPUT', `收到 ${String(v)}`);
        return undefined;
      }
      return n;
    };

    const setView = (v: NodeView) => views.set(node.id, v);
    const sourceInfo = sourceOf(node);
    // Passed to built-ins so a missing buffer explains *why*: "wire has no
    // file" is actionable, "needs a buffer" sounds like nothing is wired.
    const sourceNote = sourceInfo.wireMissing
      ? '数据源：连线的来源没有文件内容——载入来源文件，或断开这条数据源连线'
      : sourceInfo.pinMissing
        ? '数据源：指定的文件还没有载入内容——给它载入 .bin/.hex，或把「指定数据源」改回自动'
        : undefined;

    try {
      // Resolve every declared input up front. The UI then always has the real
      // value for each port, including context ports the node body never reads.
      for (const p of portInfo.inputs) inputOf(p.name);

      /* built-ins */
      if (node.packId === '') {
        if (node.nodeId === 'file') {
          const src = node.source;
          if (!src) {
            add(node, 'error', '文件：还没有载入 .bin', 'NO_SOURCE');
            setView({ kind: 'file', name: node.params.name || '未载入', size: 0, base: 0, error: '未载入文件' });
            out[SOURCE_PORT] = undefined;
            out.base = 0;
            out.size = 0;
          } else {
            // 与 bufferOfFile 共用同一份资产：File 节点的 buffer 输出
            // 和"数据源继承"必须指向同一个 assetId，否则跟随列表会出现两条
            const bytes = decodeBuffer(src);
            const asset = assets.ensure(bytes);
            const value: BufferValue = { assetId: asset.id, name: src.name, base: src.base, bytes: asset.bytes };
            out[SOURCE_PORT] = value;
            out.base = src.base;
            out.size = bytes.length;
            setView({ kind: 'file', name: src.name, size: bytes.length, base: src.base });
          }
          return out;
        }
        if (node.nodeId === 'number') {
          const n = toNumber(node.params.value ?? '0');
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
              item = list[index] as InstanceView | undefined;
              if (!item) {
                add(node, 'error', `元素：下标 ${index} 超出范围`, 'INDEX_OUT_OF_RANGE', `列表共 ${list.length} 项`);
                setView({ kind: 'element', error: `下标 ${index} 越界` });
              }
            } else {
              // 地址模式：没有接元素/列表时，按跟随地址推断出的类型在该地址解码。
              // 没有绑定类型的空节点是合法状态——不铺字段、也不报错。
              const addr = toNumber(inputOf('address'));
              if (addr == null) {
                if (bound) {
                  add(node, 'error', '元素：已绑定类型但缺少地址', 'BAD_INPUT', '接一个地址端口，或删除这个节点');
                  setView({ kind: 'element', error: '需要地址' });
                } else {
                  setView({ kind: 'element' });
                }
              } else {
                let pack = packs.get(node.params.packId ?? '');
                let type = pack?.types[node.params.typeId ?? ''];
                if (!type) {
                  for (const p of packs.values()) {
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
                  const mem = new Memory(sourceInfo.buffer.bytes, sourceInfo.buffer.base);
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
        const def = getBuiltin(node.nodeId);
        if (def?.run) {
          const values: Record<string, unknown> = {};
          for (const p of portInfo.inputs) {
            let v = inputOf(p.name);
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
            if (v == null) {
              add(node, 'error', `输入 ${p.name}：缺少值`, 'BAD_INPUT');
            } else if (p.type === 'number' && toNumber(v) == null) {
              add(node, 'error', `输入 ${p.name}：不是数字`, 'BAD_INPUT');
            } else {
              values[p.name] = p.type === 'number' ? toNumber(v) : v;
            }
          }
          const bctx = makeBuiltinCtx(sourceInfo.buffer, node.params, sourceNote);
          const produced = def.run(values, bctx) ?? {};
          for (const p of portInfo.outputs) out[p.name] = produced[p.name];
          let detail: string | undefined;
          try { detail = def.detail?.(values, out, bctx); } catch { detail = undefined; }
          setView({ kind: 'calc', outputs: out, detail });
          return out;
        }
        add(node, 'error', `节点：未知内置类型 ${node.nodeId}`, 'UNKNOWN_NODE');
        return out;
      }

      const pack = packs.get(node.packId);
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
      const mem = buffer ? new Memory(buffer.bytes, buffer.base) : new Memory(new Uint8Array(0), 0);
      const memApi = packMemApi(mem);
      const ctxBase = {
        mem, pack, nodeId: node.id, endian: pack.endian, pointerSize: pack.pointerSize,
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
        for (const f of entry.type.fields) out[f.name] = entry.value[f.name];
        return out;
      }

      if (def.kind === 'list' || def.kind === 'array') {
        const address = requireNumber('address');
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
      add(node, 'error', '节点：求值失败', /越界|超出|不在缓冲|out of range/i.test(msg) ? 'OUT_OF_BOUNDS' : 'EVAL_FAILED', msg);
      const builtin = node.packId === '';
      if (builtin && node.nodeId === 'number') setView({ kind: 'number', value: 0, error: msg });
      else if (builtin && node.nodeId === 'element') setView({ kind: 'element', error: msg });
      else if (builtin) setView({ kind: 'calc', outputs: out, error: msg });
      else setView({ kind: 'struct', error: msg });
    }

    return out;
  };

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

  return { outputs, views, ports, sources, inputs: inputValues, assets, problems, ms: performance.now() - started };
}

/** Rough node height for layout; the canvas can use this for auto placement. */
export function nodeRowHeight(): number {
  return 22;
}

export { builtinLabel, fieldPortType, fieldSize };
