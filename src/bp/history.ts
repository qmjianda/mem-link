/**
 * 撤销/重做栈（纯函数，无 React、无 IO）。
 *
 * 位置语义：`cursor === -1` 时文档为 `base`，否则为 `entries[cursor].doc`。
 * `entries[i]` 存的是「第 i 次提交之后的整份文档」，撤销只需移动游标，不做反算。
 */

import type { DocState } from './docstate';
import { sameDoc } from './docstate';

/** 栈深上限（含一步撤销 + 一步重做的总步数） */
export const HISTORY_LIMIT = 100;
/** 同 `mergeKey` 的连续提交在该窗口内合并为 1 条 */
export const MERGE_WINDOW_MS = 500;

export interface HistoryEntry {
  doc: DocState;
  label: string;
  at: number;
}

export interface HistoryState {
  /** cursor === -1 时的文档 */
  base: DocState;
  entries: HistoryEntry[];
  /** -1 .. entries.length - 1 */
  cursor: number;
  /**
   * 实际写入缓存的那份文档快照；null 表示保存点已被挤出栈或从未保存。
   * 只比较快照身份：撤销后改写 redo 分支会复用同一个游标数字，
   * 但文档已经不是保存时的那一份。
   */
  savedDoc: DocState | null;
  lastMerge: { key: string; at: number; cursor: number } | null;
}

export interface PushOptions {
  /** 合并键，如 `param:n12:address`；同名且在窗口内只保留 1 条历史 */
  mergeKey?: string;
  now?: number;
  windowMs?: number;
}

export function initHistory(doc: DocState, saved = true): HistoryState {
  return { base: doc, entries: [], cursor: -1, savedDoc: saved ? doc : null, lastMerge: null };
}

/** 打开图 / 恢复示例：清空 undo 与 redo */
export function resetHistory(doc: DocState, saved = false): HistoryState {
  return initHistory(doc, saved);
}

export function currentDoc(h: HistoryState): DocState {
  return h.cursor < 0 ? h.base : h.entries[h.cursor].doc;
}

export function canUndo(h: HistoryState): boolean {
  return h.cursor >= 0;
}

export function canRedo(h: HistoryState): boolean {
  return h.cursor < h.entries.length - 1;
}

/** 下一次撤销会撤掉的那条操作名 */
export function undoLabel(h: HistoryState): string | null {
  return h.cursor >= 0 ? h.entries[h.cursor].label : null;
}

/** 下一次重做会重做的那条操作名 */
export function redoLabel(h: HistoryState): string | null {
  return h.cursor < h.entries.length - 1 ? h.entries[h.cursor + 1].label : null;
}

/** 保存点是否仍在当前撤销栈里（base 或任一条 entry 的文档快照） */
function reachable(h: Pick<HistoryState, 'base' | 'entries'>, doc: DocState): boolean {
  return doc === h.base || h.entries.some((e) => e.doc === doc);
}

/** 提交一份新文档：同一 `mergeKey` 在窗口内覆盖上一条，不新增历史 */
export function push(h: HistoryState, doc: DocState, label: string, opts: PushOptions = {}): HistoryState {
  if (sameDoc(currentDoc(h), doc)) return h;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? MERGE_WINDOW_MS;
  const key = opts.mergeKey;

  // 合并：覆盖上一条的 after，保留它的 before（合并前的文档）
  if (key && h.lastMerge && h.lastMerge.key === key
    && h.lastMerge.cursor === h.cursor && h.cursor >= 0
    && now - h.lastMerge.at <= windowMs) {
    const entries = h.entries.slice();
    entries[h.cursor] = { doc, label, at: now };
    const next = { ...h, entries, lastMerge: { key, at: now, cursor: h.cursor } };
    // 被覆盖的那条如果正是保存点，保存点已经不存在于新历史里
    return { ...next, savedDoc: h.savedDoc && reachable(next, h.savedDoc) ? h.savedDoc : null };
  }

  const entries = h.entries.slice(0, h.cursor + 1);
  entries.push({ doc, label, at: now });
  let cursor = entries.length - 1;
  let savedDoc = h.savedDoc;
  let base = h.base;

  // 超深：丢最旧的一条，并把 base 前移到被丢那条的 after
  if (entries.length > HISTORY_LIMIT) {
    const drop = entries.length - HISTORY_LIMIT;
    base = entries[drop - 1].doc;
    entries.splice(0, drop);
    cursor -= drop;
  }

  const next = { base, entries, cursor, savedDoc, lastMerge: key ? { key, at: now, cursor } : null };
  if (savedDoc && !reachable(next, savedDoc)) savedDoc = null;
  return { ...next, savedDoc };
}

export function undo(h: HistoryState): HistoryState {
  if (!canUndo(h)) return h;
  return { ...h, cursor: h.cursor - 1, lastMerge: null };
}

export function redo(h: HistoryState): HistoryState {
  if (!canRedo(h)) return h;
  return { ...h, cursor: h.cursor + 1, lastMerge: null };
}

/** 记录「这份文档快照已写入缓存」 */
export function markSaved(h: HistoryState, doc: DocState = currentDoc(h)): HistoryState {
  return h.savedDoc === doc ? h : { ...h, savedDoc: doc };
}

export function isDirty(h: HistoryState): boolean {
  return h.savedDoc === null || h.savedDoc !== currentDoc(h);
}
