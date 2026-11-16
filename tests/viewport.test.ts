import { describe, expect, it } from 'vitest';
import type { DocState } from '../src/bp/docstate';
import type { BPEdge, BPNode } from '../src/bp/types';
import {
  CULL_THRESHOLD, READABLE_K, VIEW_PAD, boundsOf, fitView, intersects, lodFor, openView,
  screenToWorld, visibleEdgeIds, visibleNodeIds, worldToScreen, worldViewRect, zoomAtCenter,
} from '../src/bp/viewport';

function node(id: string, x: number, y: number): BPNode {
  return { id, packId: '', nodeId: 'number', x, y, params: {} };
}

const SIZES = new Map([
  ['a', { w: 100, h: 50 }],
  ['b', { w: 100, h: 50 }],
  ['c', { w: 100, h: 50 }],
]);

function doc(): DocState {
  return {
    packs: [],
    nodes: [node('a', 0, 0), node('b', 500, 0), node('c', 5000, 5000)],
    edges: [],
  };
}

describe('lodFor', () => {
  it('三档阈值与边界', () => {
    expect(lodFor(1)).toBe('full');
    expect(lodFor(0.5)).toBe('full');
    expect(lodFor(0.49)).toBe('compact');
    expect(lodFor(0.25)).toBe('compact');
    expect(lodFor(0.24)).toBe('minimal');
    expect(lodFor(0.05)).toBe('minimal');
  });

  it('非法缩放按 full 处理，不抛错', () => {
    expect(lodFor(Number.NaN)).toBe('full');
    expect(lodFor(0)).toBe('minimal');
  });
});

describe('worldViewRect', () => {
  it('k=1 时可见世界 = 屏幕 ×(1+pad)，每边留 pad/2 屏', () => {
    const r = worldViewRect({ x: 0, y: 0, k: 1 }, { w: 800, h: 600 });
    expect(r).toEqual({ x: -600, y: -450, w: 2000, h: 1500 });
  });

  it('pad=0 时正好是屏幕矩形换算回世界坐标', () => {
    const r = worldViewRect({ x: 100, y: 50, k: 2 }, { w: 800, h: 600 }, 0);
    expect(r).toEqual({ x: -50, y: -25, w: 400, h: 300 });
  });

  it('缩小画面时可见世界范围成比例放大', () => {
    const r = worldViewRect({ x: 0, y: 0, k: 0.5 }, { w: 800, h: 600 });
    expect(r.w).toBe(4000);
    expect(r.h).toBe(3000);
    expect(VIEW_PAD).toBe(1.5);
  });

  it('k 非法时按 1 计算，不产生 Infinity', () => {
    const r = worldViewRect({ x: 0, y: 0, k: 0 }, { w: 800, h: 600 });
    expect(Number.isFinite(r.w)).toBe(true);
    expect(r.w).toBe(2000);
  });
});

describe('intersects', () => {
  it('相交、包含、分离', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(intersects(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(intersects(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
    expect(intersects(a, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('刚好相切算可见（避免临界闪烁）', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(intersects(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(true);
    expect(intersects(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(true);
  });
});

describe('visibleNodeIds', () => {
  it('只收与视口矩形相交的节点', () => {
    const d = doc();
    const r = { x: -100, y: -100, w: 800, h: 300 };
    const ids = visibleNodeIds(d, SIZES, r);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('部分重叠也算可见', () => {
    const d = doc();
    const r = { x: 90, y: 0, w: 20, h: 20 }; // 与 a 的右边缘相交
    expect([...visibleNodeIds(d, SIZES, r)]).toEqual(['a']);
  });

  it('缺失尺寸的节点被跳过（不抛错）', () => {
    const d = doc();
    const ids = visibleNodeIds(d, new Map([['a', { w: 10, h: 10 }]]), { x: 0, y: 0, w: 20, h: 20 });
    expect([...ids]).toEqual(['a']);
  });

  it('裁剪阈值常量存在（小图仍会全量渲染，由调用方判断）', () => {
    expect(CULL_THRESHOLD).toBeGreaterThan(0);
  });
});

describe('visibleEdgeIds', () => {
  const edges: BPEdge[] = [
    { id: 'e1', from: { node: 'a', port: 'p' }, to: { node: 'b', port: 'q' } },
    { id: 'e2', from: { node: 'a', port: 'p' }, to: { node: 'c', port: 'q' } },
  ];

  it('两端都可见才渲染', () => {
    const ids = visibleEdgeIds(edges, new Set(['a', 'b']), new Set());
    expect([...ids]).toEqual(['e1']);
  });

  it('只一端可见 → 不渲染', () => {
    const ids = visibleEdgeIds(edges, new Set(['a']), new Set());
    expect(ids.size).toBe(0);
  });

  it('选中连线豁免裁剪', () => {
    const ids = visibleEdgeIds(edges, new Set(['a']), new Set(['e2']));
    expect([...ids]).toEqual(['e2']);
  });
});

describe('boundsOf 与 fitView', () => {
  it('包围盒覆盖选中节点，空集返回 null', () => {
    const d = doc();
    expect(boundsOf([], d.nodes, SIZES)).toBeNull();
    const b = boundsOf(['a', 'b'], d.nodes, SIZES);
    expect(b).toEqual({ x: 0, y: 0, w: 600, h: 50 });
  });

  it('fitView 把目标矩形放进画布并留边', () => {
    const v = fitView({ x: 0, y: 0, w: 600, h: 50 }, { w: 800, h: 600 });
    expect(v.k).toBeGreaterThan(1);
    expect(v.k).toBeLessThanOrEqual(1.25);
    // 目标左上角落在 pad 处
    expect(Math.round(v.x)).toBe(46);
  });

  it('fitView 对超大矩形把 k 夹到下界', () => {
    const v = fitView({ x: 0, y: 0, w: 100000, h: 100000 }, { w: 800, h: 600 });
    expect(v.k).toBe(0.12);
  });

  it('openView 大图不压到看不清：保持可读缩放并从左上角铺开', () => {
    const size = { w: 845, h: 800 };
    const target = { x: 0, y: 0, w: 1980, h: 1160 };
    expect(fitView(target, size).k).toBeLessThan(0.5);
    const v = openView(target, size);
    expect(v.k).toBe(READABLE_K);
    expect(Math.round(v.x)).toBe(46);
    expect(Math.round(v.y)).toBe(46);
    // 内容起点在屏幕内，首屏能读懂
    expect(v.y + target.y * v.k).toBeGreaterThanOrEqual(0);
  });

  it('openView 小图仍用 fit 的结果（不强行放大）', () => {
    const size = { w: 845, h: 800 };
    const target = { x: 0, y: 0, w: 600, h: 200 };
    expect(openView(target, size)).toEqual(fitView(target, size));
  });

});

describe('坐标换算与中心缩放', () => {
  it('worldToScreen / screenToWorld 互逆', () => {
    const view = { x: 40, y: 30, k: 0.92 };
    const s = worldToScreen(view, 123, 456);
    const w = screenToWorld(view, s.x, s.y);
    expect(Math.round(w.x)).toBe(123);
    expect(Math.round(w.y)).toBe(456);
  });

  it('zoomAtCenter 保持画布中心的世界点不动', () => {
    const view = { x: 40, y: 30, k: 0.9 };
    const size = { w: 800, h: 600 };
    const before = screenToWorld(view, 400, 300);
    const next = zoomAtCenter(view, size, 1);
    const after = screenToWorld(next, 400, 300);
    expect(next.k).toBe(1);
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.y)).toBe(Math.round(before.y));
  });

  it('zoomAtCenter 夹紧缩放范围', () => {
    expect(zoomAtCenter({ x: 0, y: 0, k: 1 }, { w: 800, h: 600 }, 99).k).toBe(2.4);
    expect(zoomAtCenter({ x: 0, y: 0, k: 1 }, { w: 800, h: 600 }, 0.01).k).toBe(0.12);
  });
});
