import { describe, expect, it } from 'vitest';
import {
  clampNoteH, clampNoteW, isNoteNode, noteSize, noteTextHeight,
  NOTE_DEFAULT_H, NOTE_MAX_H, NOTE_MAX_W, NOTE_MIN_H, NOTE_MIN_W, NOTE_TEXT_H,
} from '../src/bp/notesize';
import { NODE_WIDTH, type BPNode } from '../src/bp/types';

function note(params: Record<string, string> = {}): BPNode {
  return { id: 'n', packId: '', nodeId: 'note', x: 0, y: 0, params };
}

describe('标注节点尺寸', () => {
  it('默认尺寸与旧版固定便签一致', () => {
    expect(NOTE_DEFAULT_H).toBe(150);
    expect(noteSize(note())).toEqual({ w: NODE_WIDTH, h: NOTE_DEFAULT_H });
    expect(noteTextHeight(NOTE_DEFAULT_H)).toBe(NOTE_TEXT_H);
  });

  it('读写 params.__w / __h 并夹在可用范围内', () => {
    expect(noteSize(note({ __w: '420', __h: '260' }))).toEqual({ w: 420, h: 260 });
    expect(noteSize(note({ __w: '10', __h: '5000' }))).toEqual({ w: NOTE_MIN_W, h: NOTE_MAX_H });
    expect(noteSize(note({ __w: '9999', __h: '1' }))).toEqual({ w: NOTE_MAX_W, h: NOTE_MIN_H });
  });

  it('坏数据回落到默认值而不是 NaN', () => {
    expect(clampNoteW(Number.NaN)).toBe(NODE_WIDTH);
    expect(clampNoteH(Number.NaN)).toBe(NOTE_DEFAULT_H);
    expect(noteSize(note({ __w: 'abc', __h: '' })).w).toBe(NODE_WIDTH);
  });

  it('只对标注节点生效', () => {
    const node = note();
    expect(isNoteNode(node)).toBe(true);
    expect(isNoteNode({ packId: 'p', nodeId: 'note' })).toBe(false);
    expect(noteSize({ ...node, packId: 'p', nodeId: 'header' })).toEqual({ w: NODE_WIDTH, h: 0 });
  });

  it('正文高度随卡片高度增长，且不小于一行', () => {
    expect(noteTextHeight(NOTE_DEFAULT_H + 100)).toBe(NOTE_TEXT_H + 100);
    expect(noteTextHeight(1)).toBeGreaterThanOrEqual(40);
  });
});
