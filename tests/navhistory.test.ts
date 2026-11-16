import { describe, expect, it } from 'vitest';
import {
  NAV_LIMIT, backLabel, canBack, canForward, emptyNav, forwardLabel, goBack, goForward,
  pushNav, type NavSnapshot,
} from '../src/bp/navhistory';
import { emptySelection, selectOnlyNode } from '../src/bp/selection';

const at = (x: number, label: string): NavSnapshot => ({
  view: { x, y: 10, k: 0.8 },
  selection: x === 0 ? emptySelection() : selectOnlyNode(`n${x}`),
  label,
});

describe('导航历史', () => {
  it('初始为空，压栈后可返回', () => {
    expect(canBack(emptyNav())).toBe(false);
    expect(canForward(emptyNav())).toBe(false);
    const s = pushNav(emptyNav(), at(0, '起点'));
    expect(canBack(s)).toBe(true);
    expect(backLabel(s)).toBe('起点');
  });

  it('往返恢复视口与选中态', () => {
    const s1 = pushNav(emptyNav(), at(0, '起点'));
    const back = goBack(s1, at(1, '跳转后'));
    expect(back).not.toBeNull();
    expect(back!.target.view.x).toBe(0);
    expect(back!.target.label).toBe('起点');
    expect(canForward(back!.state)).toBe(true);
    const fwd = goForward(back!.state, back!.target);
    expect(fwd!.target.view.x).toBe(1);
    expect(fwd!.target.label).toBe('跳转后');
  });

  it('新导航清空 forward 分支', () => {
    const s1 = pushNav(emptyNav(), at(0, '起点'));
    const back = goBack(s1, at(1, '跳转后'))!;
    const s2 = pushNav(back.state, at(2, '新方向'));
    expect(canForward(s2)).toBe(false);
    expect(backLabel(s2)).toBe('新方向');
  });

  it('同一视口 + 同一标签不重复入栈', () => {
    const s1 = pushNav(emptyNav(), at(5, '重复'));
    const s2 = pushNav(s1, at(5, '重复'));
    expect(s2.back).toHaveLength(1);
  });

  it('快照与调用方的 selection 隔离', () => {
    const snap = at(3, '快照');
    const s = pushNav(emptyNav(), snap);
    snap.selection.nodes.add('later');
    expect(s.back[0].selection.nodes.has('later')).toBe(false);
  });

  it('栈深有上限', () => {
    let s = emptyNav();
    for (let i = 0; i < NAV_LIMIT + 12; i += 1) s = pushNav(s, at(i, `位置 ${i}`));
    expect(s.back).toHaveLength(NAV_LIMIT);
    expect(backLabel(s)).toBe(`位置 ${NAV_LIMIT + 11}`);
  });

  it('空栈返回 null', () => {
    expect(goBack(emptyNav(), at(1, 'x'))).toBeNull();
    expect(goForward(emptyNav(), at(1, 'x'))).toBeNull();
  });

  it('前进标签取自最近一次返回', () => {
    const s1 = pushNav(emptyNav(), at(0, '起点'));
    const back = goBack(s1, at(1, '跳转后'))!;
    expect(forwardLabel(back.state)).toBe('跳转后');
  });
});
