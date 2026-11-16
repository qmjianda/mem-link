/**
 * 资产身份：同一份字节在文档、求值、跟随地址与诊断中只有一个 id。
 * 用同步 FNV-1a 64 而不是 `crypto.subtle.digest`：求值入口
 * `evaluateGraph` 是同步的（被 `useMemo` 直接调用），把整条链路改成
 * async 的代价远大于收益。这个 id 只用于"同一张图内是否同一份字节"，
 * 不承担安全语义；需要跨机器核对来源时用 SHA-256（见 pack 导入）。
 *
 * 64 位用两个 32 位半字实现，避免 BigInt 在 1 MiB 输入上慢两个数量级。
 */

import type { BufferValue, SourceInfo } from './types';

const OFFSET_BASIS_HI = 0xcbf29ce4;
const OFFSET_BASIS_LO = 0x84222325;
const PRIME_LO = 0x1b3; // 435
const PRIME_HI = 0x100; // 256，合起来是 0x100000001b3

const TWO32 = 4294967296;
/** 2^-32 是 2 的幂，乘法不引入舍入；比除法快，且 t 远小于 2^53 */
const INV32 = 1 / TWO32;

/** 64 位 FNV-1a，返回 16 位十六进制串。 */
export function fnv1a64(bytes: Uint8Array): string {
  let hi = OFFSET_BASIS_HI;
  let lo = OFFSET_BASIS_LO;
  for (let i = 0; i < bytes.length; i++) {
    const lo0 = (lo ^ bytes[i]) >>> 0;
    const t = lo0 * PRIME_LO;
    const carry = (t * INV32) | 0;
    // hi 先算：它还要用到未进位的 lo0
    hi = (hi * PRIME_LO + lo0 * PRIME_HI + carry) >>> 0;
    lo = t >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

export const ASSET_PREFIX = 'a1:';

/** 资产 id：内容哈希。名称、基址、长度都不参与。 */
export function assetIdOf(bytes: Uint8Array): string {
  return ASSET_PREFIX + fnv1a64(bytes);
}

export interface Asset {
  id: string;
  /** 全图共享的同一份字节；相同内容不会解码出第二个 Uint8Array */
  bytes: Uint8Array;
  size: number;
}

export interface AssetTable {
  /** 登记一份字节；内容相同则返回已有条目 */
  ensure(bytes: Uint8Array): Asset;
  get(id: string): Asset | undefined;
  readonly size: number;
  ids(): string[];
}

export function createAssetTable(): AssetTable {
  const map = new Map<string, Asset>();
  return {
    ensure(bytes: Uint8Array): Asset {
      const id = assetIdOf(bytes);
      const hit = map.get(id);
      if (hit) return hit;
      const asset: Asset = { id, bytes, size: bytes.length };
      map.set(id, asset);
      return asset;
    },
    get: (id: string) => map.get(id),
    get size() {
      return map.size;
    },
    ids: () => [...map.keys()],
  };
}

/**
 * 跟随地址列表的候选：按 `assetId@base` 去重。
 *
 * 只按 assetId 会把"同内容不同基址"合并掉，丢掉一个合法基址；
 * 只按 name/base/length 会让同名同长不同内容互相顶替。
 */
export function uniqueBuffers(infos: Iterable<SourceInfo>): BufferValue[] {
  const seen = new Set<string>();
  const out: BufferValue[] = [];
  for (const info of infos) {
    const b = info.buffer;
    if (!b) continue;
    const key = `${b.assetId}@${b.base}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}
