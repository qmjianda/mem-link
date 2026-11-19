import { Memory } from '../core/mem';
import type { BufferValue } from './types';

export type AddressInt = number | bigint;
export const MAX_ADDRESS = (1n << 64n) - 1n;
export const MIN_INTEGER = -(1n << 63n);

/** Never recover an integer from a JS number that is already rounded. */
export function exactInteger(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > 80 || !/^[+-]?(?:\d+|0x[\da-f]+|0b[01]+)$/i.test(text)) return undefined;
  const n = BigInt(text.replace(/^[+-]/, ''));
  return text.startsWith('-') ? -n : n;
}

export function addressInteger(value: unknown): bigint | undefined {
  const n = exactInteger(value);
  return n !== undefined && n >= 0n && n <= MAX_ADDRESS ? n : undefined;
}

export function safeNumber(value: AddressInt): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function addressHex(value: AddressInt): string {
  return value < 0 ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`;
}

export interface MappedAddress {
  readonly value: bigint;
  readonly assetId: string;
  readonly mappingBase: bigint;
}

const mapped = new WeakSet<object>();

export function mappedAddress(buffer: BufferValue, value: bigint): MappedAddress {
  const address = Object.freeze({ value, assetId: buffer.assetId, mappingBase: BigInt(buffer.mappingBase ?? buffer.base) });
  mapped.add(address);
  return address;
}

export function isMappedAddress(value: unknown): value is MappedAddress {
  return typeof value === 'object' && value !== null && mapped.has(value);
}

export function sameMapping(address: MappedAddress, buffer: BufferValue): boolean {
  return address.assetId === buffer.assetId && address.mappingBase === BigInt(buffer.mappingBase ?? buffer.base);
}

/** Translate through the bounded view first; only the file-local byte index becomes a number. */
export function offsetIn(buffer: BufferValue, address: AddressInt, length = 1): number | undefined {
  const at = addressInteger(address);
  if (at === undefined || !Number.isSafeInteger(length) || length < 0) return undefined;
  const offset = at - BigInt(buffer.base);
  if (offset < 0n || offset + BigInt(length) > BigInt(buffer.bytes.length)) return undefined;
  return Number(offset);
}

/** The scripted pack API still uses safe number addresses. */
export function packMemory(buffer: BufferValue): Memory | undefined {
  const base = safeNumber(buffer.base);
  return base !== undefined && Number.isSafeInteger(base + buffer.bytes.length)
    ? new Memory(buffer.bytes, base)
    : undefined;
}

export function isExactPort(type?: string): boolean {
  return type === 'address' || type === 'integer' || type === 'offset' || type === 'index';
}
