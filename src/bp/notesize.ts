/**
 * 标注（Note）节点的可调尺寸：纯函数，画布、自动布局与小地图共用。
 * 尺寸写在 `params.__w` / `params.__h`，随图持久化，无需改文档 schema。
 */

import { NODE_HEADER, NODE_WIDTH, type BPNode } from './types';

export const NOTE_MIN_W = 200;
export const NOTE_MAX_W = 720;
export const NOTE_MIN_H = 110;
export const NOTE_MAX_H = 900;
/** 默认正文高度（标题栏之下） */
export const NOTE_TEXT_H = 108;
/** 正文与卡片底边的间距 */
export const NOTE_PAD_B = 10;
export const NOTE_DEFAULT_H = NODE_HEADER + NOTE_TEXT_H + NOTE_PAD_B;

export function isNoteNode(node: Pick<BPNode, 'packId' | 'nodeId'>): boolean {
  return node.packId === '' && node.nodeId === 'note';
}

export function clampNoteW(v: number): number {
  if (!Number.isFinite(v)) return NODE_WIDTH;
  return Math.round(Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, v)));
}

export function clampNoteH(v: number): number {
  if (!Number.isFinite(v)) return NOTE_DEFAULT_H;
  return Math.round(Math.min(NOTE_MAX_H, Math.max(NOTE_MIN_H, v)));
}

/** 标注节点的实际尺寸；其它节点恒为默认宽度。 */
export function noteSize(node: BPNode): { w: number; h: number } {
  if (!isNoteNode(node)) return { w: NODE_WIDTH, h: 0 };
  return {
    w: clampNoteW(Number(node.params.__w ?? NODE_WIDTH)),
    h: clampNoteH(Number(node.params.__h ?? NOTE_DEFAULT_H)),
  };
}

/** 正文框高度：卡片高度减去标题栏与底部留白。 */
export function noteTextHeight(h: number): number {
  return Math.max(40, clampNoteH(h) - NODE_HEADER - NOTE_PAD_B);
}
