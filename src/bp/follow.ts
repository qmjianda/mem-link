/**
 * 「跟随地址」的纯函数：从任意端口值里取地址，并把不能跟随的原因
 * 写成用户能直接照做的提示；候选节点与类型推断也在这里，便于单元测试。
 */

import { BUILTIN_DEFS } from './builtins';
import type { BlueprintPack, BPNode, BufferValue, NodeView, PortType } from './types';
import { isInstanceView } from './types';
import { addressHex, addressInteger, isMappedAddress, type AddressInt } from './precision';

function isBufferValue(v: unknown): v is BufferValue {
  return !!v && typeof v === 'object'
    && typeof (v as BufferValue).base === 'number'
    && (v as BufferValue).bytes instanceof Uint8Array;
}

/**
 * 端口值 → 可跟随地址。
 * 元素/实例端口携带的是 InstanceView，取它自己的 addr；
 * 其余（列表、缓冲区、字符串、布尔）没有单一地址，返回 null。
 */
export function followAddress(value: unknown): AddressInt | null {
  if (isMappedAddress(value)) return value.value;
  if (typeof value === 'bigint') return addressInteger(value) ?? null;
  const n = typeof value === 'number'
    ? value
    : isInstanceView(value)
      ? value.location?.value ?? value.addr
      : Number.NaN;
  return typeof n === 'bigint' || Number.isSafeInteger(n) ? n : null;
}

/** 为什么这个端口不能跟随（null 表示可以跟随）。 */
export function followHint(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'bigint' || isInstanceView(value)) return '地址计算结果无效';
  if (Array.isArray(value)) return '列表端口有多个元素地址——展开后双击单个元素';
  if (isBufferValue(value)) return '缓冲区端口不是单个地址——请双击 base 端口';
  if (typeof value === 'string') return '字符串不是地址';
  if (typeof value === 'boolean') return '布尔值不是地址';
  return '端口没有输出地址';
}

export function followTypeIssue(type?: PortType): string | undefined {
  if (type === 'offset') return '字节偏移不是地址，请先换算地址';
  if (type === 'index') return '元素下标不是地址，请先换算地址';
}

/** 地址不在任何缓冲区时的说明，包含当前可用范围。 */
export function bufferIssue(addr: AddressInt, buffers: BufferValue[]): string {
  if (addr < 0) return `地址为负：${addr}`;
  if (addressInteger(addr) === undefined) return '地址计算结果无效';
  if (!buffers.length) {
    return '还没有可用的文件缓冲区——先添加 File 节点并载入 .bin/.hex';
  }
  if (buffers.length === 1) {
    const b = buffers[0];
    const last = BigInt(b.base) + BigInt(b.bytes.length) - 1n;
    return `${addressHex(addr)} 不在 ${b.name} 的 ${addressHex(b.base)}–${addressHex(last)} 内`;
  }
  return `${addressHex(addr)} 不在任何缓冲区（${buffers.length} 个文件）内`;
}

/* ------------------------------------------------- 跟随候选（解析节点清单） */

export interface FollowItem {
  key: string;
  packId: string;
  nodeId: string;
  label: string;
  detail: string;
  /** 绑定当前地址的输入端口，可能不是 `address`。 */
  inputPort: string;
  addressType: PortType;
  /** 列表分组标题（结构体 / 链表 / 数组 / 解析 / 地址 / 校验 / 数据源 / 推荐） */
  group: string;
  /** 「元素解析」条目要按哪个 pack 的类型解码（只由推断写入） */
  typePackId?: string;
  typeName?: string;
  recommended?: boolean;
}

export interface FollowTypeHint {
  packId: string;
  typeName: string;
  reason: string;
}

/** 候选分组顺序：结构体在最前，便于扫类型；推荐项单独置顶。 */
const GROUP_RANK: Record<string, number> = {
  结构体: 0, 链表: 1, 数组: 2, 读取: 3, 集合: 4, 数据源: 5, 定位: 6, 校验: 7,
};

const PACK_GROUP: Record<string, string> = {
  struct: '结构体', list: '链表', array: '数组',
};

export function buildFollowItems(opts: {
  packs: Map<string, BlueprintPack>;
  packNames: Map<string, string>;
  isEnabled?: (packId: string) => boolean;
}): FollowItem[] {
  const enabled = opts.isEnabled ?? (() => true);
  const out: FollowItem[] = [];
  for (const [packId, pack] of opts.packs) {
    if (!enabled(packId)) continue;
    const packName = opts.packNames.get(packId) ?? pack.name ?? packId;
    for (const [nodeId, def] of Object.entries(pack.nodes)) {
      if (def.kind === 'calc') continue;
      out.push({
        key: `${packId}/${nodeId}`,
        packId,
        nodeId,
        label: def.label ?? nodeId,
        detail: `${packName} · ${def.type.name} ${def.type.size} B`,
        inputPort: 'address',
        addressType: 'pack-address',
        group: PACK_GROUP[def.kind] ?? '结构体',
        typeName: def.type.name,
      });
    }
  }
  // 同一分组内保持 pack 声明顺序；跨 pack 的分组聚到一起，列表更好扫。
  out.sort((a, b) => (GROUP_RANK[a.group] ?? 99) - (GROUP_RANK[b.group] ?? 99));

  for (const def of BUILTIN_DEFS) {
    if (!def.followPort) continue;
    out.push({
      key: `/${def.id}`,
      packId: '',
      nodeId: def.id,
      label: def.label,
      detail: `内置 · ${def.hint}`,
      inputPort: def.followPort,
      addressType: def.inputs.find((p) => p.name === def.followPort)?.type ?? 'address',
      group: def.group,
    });
  }
  // 内置节点与 pack 节点按同一套分组顺序排列（稳定排序保留各自声明顺序）。
  out.sort((a, b) => (GROUP_RANK[a.group] ?? 99) - (GROUP_RANK[b.group] ?? 99));
  return out;
}

/**
 * 「元素解析」条目：只在类型能推断出来时提供（来源本身是元素，或该地址
 * 已有同类型实例）。没有可靠类型就不给这一项——用首个类型硬解会产生
 * 看似成功、实际字段全错的意外结果。
 */
export function elementFollowItem(hint?: FollowTypeHint | null): FollowItem | null {
  if (!hint) return null;
  return {
    key: 'element',
    packId: '',
    nodeId: 'element',
    label: '元素解析',
    detail: `自适应 · ${hint.typeName} · ${hint.reason}`,
    inputPort: 'address',
    addressType: 'pack-address',
    group: '推荐',
    typePackId: hint.packId,
    typeName: hint.typeName,
    recommended: true,
  };
}

/** 同一地址上出现两种类型时，不再替用户猜——元素解析不提供。 */
export interface KnownType {
  packId: string;
  typeName: string;
  ambiguous?: boolean;
}

/** 地址 → 该地址上已经解析过的实例类型（用于「同地址已知类型」推荐）。 */
export function knownTypesAt(
  nodes: BPNode[],
  views: Map<string, NodeView>,
  includes: (nodeId: string) => boolean = () => true,
): Map<number, KnownType> {
  const out = new Map<number, KnownType>();
  const put = (addr: number, packId: string, typeName: string) => {
    const cur = out.get(addr);
    if (!cur) out.set(addr, { packId, typeName });
    else if (cur.typeName !== typeName || cur.packId !== packId) cur.ambiguous = true;
  };
  for (const n of nodes) {
    if (!includes(n.id)) continue;
    const v = views.get(n.id);
    if (!v) continue;
    const packId = n.packId || n.params.packId || '';
    if ((v.kind === 'struct' || v.kind === 'element') && v.inst && !v.inst.location) {
      put(v.inst.addr, packId, v.inst.typeName);
    } else if (v.kind === 'list' || v.kind === 'array') {
      for (const it of v.items) if (!it.location) put(it.addr, packId, it.typeName);
    }
  }
  return out;
}

/**
 * 推断「这个地址最可能是什么类型」：
 * 1. 端口值本身是一个已解码元素 → 直接沿用它的类型（最可靠）；
 * 2. 地址上已经有节点解析出同类型实例 → 用那份类型。
 * 普通数字字段不做来源节点类型推断：`Header.head` 指向的通常是另一种结构。
 */
export function inferFollowType(opts: {
  value: unknown;
  address: number;
  packs: Map<string, BlueprintPack>;
  sourcePackId?: string;
  knownAt?: Map<number, KnownType>;
}): FollowTypeHint | null {
  const pick = (typeName: string, preferPackId?: string) => {
    if (preferPackId && opts.packs.get(preferPackId)?.types[typeName]) {
      return { packId: preferPackId, typeName };
    }
    for (const [id, pack] of opts.packs) {
      if (pack.types[typeName]) return { packId: id, typeName };
    }
    return null;
  };

  if (isInstanceView(opts.value) && !opts.value.location) {
    const hit = pick(opts.value.typeName, opts.sourcePackId);
    if (hit) return { ...hit, reason: `沿用来源元素类型 ${opts.value.typeName}` };
  }

  const known = opts.knownAt?.get(opts.address);
  if (known && !known.ambiguous) {
    const hit = pick(known.typeName, known.packId);
    if (hit) return { ...hit, reason: `该地址已按 ${hit.typeName} 解析过` };
  }
  return null;
}
