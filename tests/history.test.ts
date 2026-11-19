import { describe, expect, it } from 'vitest';
import type { DocState } from '../src/bp/docstate';
import { docJson, maxIdSeq, sameDoc } from '../src/bp/docstate';
import {
  HISTORY_LIMIT, canRedo, canUndo, currentDoc, initHistory, isDirty, markSaved, push, redo,
  redoLabel, resetHistory, undo, undoLabel, type HistoryState,
} from '../src/bp/history';
import type { BPNode } from '../src/bp/types';

function node(id: string, x = 0): BPNode {
  return { id, packId: '', nodeId: 'number', x, y: 0, params: { value: '0' } };
}

function baseDoc(count = 2): DocState {
  return {
    packs: [],
    nodes: Array.from({ length: count }, (_, i) => node(`n${i + 1}`, i)),
    edges: [],
  };
}

/** 模拟一次文档编辑：把第一个节点移到 x=step（每次都产出新数组，结构共享） */
function moveToStep(h: HistoryState, step: number, opts: { now?: number; mergeKey?: string } = {}): HistoryState {
  const prev = currentDoc(h);
  const next: DocState = {
    ...prev,
    nodes: prev.nodes.map((n, i) => (i === 0 ? { ...n, x: step } : n)),
  };
  return push(h, next, `移动 ${step}`, { now: opts.now ?? 1000 + step, mergeKey: opts.mergeKey });
}

describe('history: 深度相等与步进', () => {
  it('20 步编辑后逐步撤销回到起点，20 步重做回到终态', () => {
    const start = baseDoc();
    let h = initHistory(start);
    const snapshots: string[] = [docJson(start)];

    for (let i = 1; i <= 20; i += 1) {
      h = moveToStep(h, i, { now: 1000 + i * 1000 });
      snapshots.push(docJson(currentDoc(h)));
    }
    expect(h.entries.length).toBe(20);
    expect(docJson(currentDoc(h))).toBe(snapshots[20]);

    // 逐步撤销：每一步都与该步快照深度相等
    for (let i = 19; i >= 0; i -= 1) {
      h = undo(h);
      expect(docJson(currentDoc(h))).toBe(snapshots[i]);
    }
    expect(canUndo(h)).toBe(false);
    expect(docJson(currentDoc(h))).toBe(snapshots[0]);

    // 逐步重做：回到终态
    for (let i = 1; i <= 20; i += 1) {
      h = redo(h);
      expect(docJson(currentDoc(h))).toBe(snapshots[i]);
    }
    expect(canRedo(h)).toBe(false);
  });

  it('撤销后新提交会清空 redo', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000 });
    h = moveToStep(h, 2, { now: 2000 });
    h = moveToStep(h, 3, { now: 3000 });
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = moveToStep(h, 9, { now: 4000 });
    expect(canRedo(h)).toBe(false);
    expect(h.entries.length).toBe(3);
    expect(currentDoc(h).nodes[0].x).toBe(9);
  });

  it('操作名可用于按钮提示', () => {
    let h = initHistory(baseDoc());
    expect(undoLabel(h)).toBeNull();
    h = moveToStep(h, 5, { now: 1000 });
    expect(undoLabel(h)).toBe('移动 5');
    expect(redoLabel(h)).toBeNull();
    h = undo(h);
    expect(redoLabel(h)).toBe('移动 5');
  });

  it('内容没有实质变化时不入栈', () => {
    const start = baseDoc();
    const h = initHistory(start);
    expect(push(h, start, '空操作')).toBe(h);
    // 三数组引用全等即视为无变化
    expect(sameDoc(start, { ...start })).toBe(true);
  });

  it('resetHistory 清空 undo 与 redo', () => {
    const fresh = resetHistory(baseDoc(3));
    expect(canUndo(fresh)).toBe(false);
    expect(canRedo(fresh)).toBe(false);
    expect(fresh.entries.length).toBe(0);
    expect(fresh.cursor).toBe(-1);
    expect(fresh.base.nodes.length).toBe(3);
  });
});

describe('history: 合并', () => {
  it('同一 mergeKey 连续 10 次提交只产生 1 条历史', () => {
    let h = initHistory(baseDoc());
    for (let i = 1; i <= 10; i += 1) {
      h = moveToStep(h, i, { now: 1000 + i * 10, mergeKey: 'param:n1:value' });
    }
    expect(h.entries.length).toBe(1);
    expect(currentDoc(h).nodes[0].x).toBe(10);
    // 撤销一次即回到拖动/输入开始之前
    h = undo(h);
    expect(currentDoc(h).nodes[0].x).toBe(0);
  });

  it('超出合并窗口后另起一条', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000, mergeKey: 'k' });
    h = moveToStep(h, 2, { now: 1200, mergeKey: 'k' });
    expect(h.entries.length).toBe(1);
    h = moveToStep(h, 3, { now: 2000, mergeKey: 'k' });
    expect(h.entries.length).toBe(2);
  });

  it('不同 mergeKey 不合并', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000, mergeKey: 'a' });
    h = moveToStep(h, 2, { now: 1010, mergeKey: 'b' });
    expect(h.entries.length).toBe(2);
  });
});

describe('history: 保存点', () => {
  it('保存后 isDirty=false，编辑后 true，撤销回保存点又为 false', () => {
    let h = initHistory(baseDoc());
    expect(isDirty(h)).toBe(false);
    h = moveToStep(h, 1, { now: 1000 });
    expect(isDirty(h)).toBe(true);
    h = markSaved(h);
    expect(isDirty(h)).toBe(false);
    h = moveToStep(h, 2, { now: 2000 });
    expect(isDirty(h)).toBe(true);
    h = undo(h);
    expect(isDirty(h)).toBe(false);
    h = redo(h);
    expect(isDirty(h)).toBe(true);
  });

  it('撤销后另起分支：同一游标数字不等于已保存', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000 });
    h = markSaved(h);
    h = undo(h);
    h = moveToStep(h, 9, { now: 2000 });
    expect(h.cursor).toBe(0);
    expect(isDirty(h)).toBe(true);
    // 旧保存点已被新分支覆盖：继续撤销也不会再变回「已保存」
    h = undo(h);
    expect(isDirty(h)).toBe(true);
  });

  it('markSaved 绑定传入的快照，而不是当时的游标', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000 });
    const saved = currentDoc(h);
    h = moveToStep(h, 2, { now: 2000 });
    h = markSaved(h, saved);
    expect(isDirty(h)).toBe(true);
    h = undo(h);
    expect(isDirty(h)).toBe(false);
  });
});

describe('history: 栈深', () => {
  it('push 150 次后只保留最近 100 条，最旧的被淘汰', () => {
    let h = initHistory(baseDoc());
    for (let i = 1; i <= 150; i += 1) h = moveToStep(h, i, { now: 1000 + i * 1000 });
    expect(h.entries.length).toBe(HISTORY_LIMIT);
    expect(h.cursor).toBe(HISTORY_LIMIT - 1);
    expect(canUndo(h)).toBe(true);

    // 还能撤销 100 步，落点是第 50 次提交之后的文档（更早的已被丢弃）
    for (let i = 0; i < HISTORY_LIMIT; i += 1) h = undo(h);
    expect(canUndo(h)).toBe(false);
    expect(currentDoc(h).nodes[0].x).toBe(50);
  });

  it('保存点被挤出栈后退化为「始终有未保存改动」', () => {
    let h = initHistory(baseDoc());
    h = moveToStep(h, 1, { now: 1000 });
    h = markSaved(h);
    expect(isDirty(h)).toBe(false);
    for (let i = 2; i <= 160; i += 1) h = moveToStep(h, i, { now: 1000 + i * 1000 });
    expect(h.savedDoc).toBeNull();
    expect(isDirty(h)).toBe(true);
  });
});

describe('docstate', () => {
  it('maxIdSeq 从文档里出现过的最大编号起步（id 永不复用）', () => {
    const doc: DocState = {
      packs: [{ id: 'p7', name: 'x', source: '', pack: {} as never }],
      nodes: [node('n145'), node('n3')],
      edges: [{ id: 'e205', from: { node: 'n145', port: 'a' }, to: { node: 'n3', port: 'b' } }],
    };
    expect(maxIdSeq(doc)).toBe(205);
    // 编号都低于起点时仍从 100 起，保证新 id 不与既有编号冲突
    const small: DocState = {
      packs: [],
      nodes: [node('n12'), node('n3')],
      edges: [{ id: 'e41', from: { node: 'n12', port: 'a' }, to: { node: 'n3', port: 'b' } }],
    };
    expect(maxIdSeq(small)).toBe(100);
    expect(maxIdSeq({ packs: [], nodes: [], edges: [] })).toBe(100);
  });
});
