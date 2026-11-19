import { addOffset, integerInput, ReadIssue } from './binary-read';
import { compileLayout, fieldPort, MAX_FIELD_BYTES, readLayout, readScalarItem, type BinaryLayout } from './layouts';
import { addressHex, MAX_ADDRESS, offsetIn } from './precision';
import type { Endian } from '../core/types';
import type { BufferValue, InstanceView, Truncation } from './types';

const ITEM_LIMIT = 4096;
const BYTE_BUDGET = MAX_FIELD_BYTES;

export interface WalkResult {
  items: InstanceView[];
  stop: 'complete' | 'limit' | 'cycle' | 'unreadable';
  notice?: ReadIssue;
  trunc?: Truncation;
}

function itemBudget(size: number, configured = ITEM_LIMIT): number {
  return Math.min(configured, ITEM_LIMIT, Math.floor(BYTE_BUDGET / Math.max(1, size)));
}

function invalid(items: InstanceView[], err: unknown): WalkResult {
  if (!(err instanceof ReadIssue)) throw err;
  return { items, stop: 'unreadable', notice: err };
}

export function expandArray(
  src: BufferValue, start: bigint, count: bigint, stride: bigint | undefined, kind: string, endian: Endian, layout?: BinaryLayout,
): WalkResult {
  const compiled = layout && compileLayout(layout);
  const width = compiled?.size ?? Number(kind.slice(1)) / 8;
  if (!Number.isSafeInteger(width) || width < 1) throw new ReadIssue('BAD_INPUT', '元素需要固定宽度');
  const step = stride ?? BigInt(width);
  const items: InstanceView[] = [];
  const limit = itemBudget(compiled ? Math.max(width, compiled.fields.reduce((n, f) => n + f.width, 0)) : width);
  let i = 0;
  try {
    for (; i < limit && BigInt(i) < count; i++) {
      const at = addOffset(start, BigInt(i) * step);
      items.push(compiled ? readLayout(src, at, compiled, i) : readScalarItem(src, at, kind, endian, i));
    }
    if (BigInt(i) === count) return { items, stop: 'complete' };
    const at = addOffset(start, BigInt(i) * step);
    if (offsetIn(src, at, width) === undefined) throw new ReadIssue('OUT_OF_BOUNDS', `第 ${i} 项 ${addressHex(at)} 不可读`, at);
    return {
      items, stop: 'limit', trunc: { at: i, unit: 'index', limit, canContinue: true },
      notice: new ReadIssue('TRUNCATED', `达到读取预算，从第 ${i} 项截断`, at),
    };
  } catch (err) {
    return invalid(items, err);
  }
}

export function walkList(
  src: BufferValue, layout: BinaryLayout | undefined, config: {
    start: bigint; nextField: string; stopValue: bigint; max: number;
    pool?: { base: bigint; stride: bigint };
  },
): WalkResult {
  const compiled = compileLayout(layout);
  const def = compiled.fields.find(({ f }) => f.id === config.nextField);
  if (!def || !/^(?:[ui]\d+|bits)$/.test(def.f.kind)) {
    throw new ReadIssue('INVALID_LAYOUT', 'next 必须绑定布局中的整数字段');
  }
  if (def.f.role && def.f.role !== (config.pool ? 'index' : 'address')) {
    throw new ReadIssue('INVALID_LAYOUT', 'next 字段语义与推进方式不一致');
  }
  const items: InstanceView[] = [];
  const visited = new Set<bigint>();
  const limit = itemBudget(Math.max(compiled.size, compiled.fields.reduce((n, f) => n + f.width, 0)), config.max);
  let at = config.start;
  try {
    for (;;) {
      if (visited.has(at)) return { items, stop: 'cycle', notice: new ReadIssue('RECORD_CYCLE', `链表成环：${addressHex(at)}`, at) };
      if (offsetIn(src, at, compiled.size) === undefined) throw new ReadIssue('OUT_OF_BOUNDS', `记录 ${addressHex(at)} 的字节不可用`, at);
      if (items.length === limit) {
        return {
          items, stop: 'limit', trunc: { at, unit: 'address', limit, canContinue: true },
          notice: new ReadIssue('TRUNCATED', `达到读取上限，从 ${addressHex(at)} 截断`, at),
        };
      }
      visited.add(at);
      const item = readLayout(src, at, compiled, items.length);
      items.push(item);
      const field = item.fields.find(f => f.name === fieldPort(compiled.layout.id, config.nextField))!;
      const next = integerInput(field.raw, 'next');
      if (next === config.stopValue) return { items, stop: 'complete' };
      try {
        at = config.pool
          ? addOffset(config.pool.base, integerInput(next, 'next 池下标', 0n) * config.pool.stride)
          : integerInput(next, 'next 地址', 0n, MAX_ADDRESS);
      } catch (err) {
        if (!(err instanceof ReadIssue)) throw err;
        return invalid(items, new ReadIssue(err.code, `字段「${field.label}」：${err.message}`, at + BigInt(field.offset)));
      }
    }
  } catch (err) {
    return invalid(items, err);
  }
}
