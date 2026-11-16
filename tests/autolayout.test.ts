import { describe, expect, it } from 'vitest';
import { adjacency, autoLayout, type AutoLayoutNode } from '../src/bp/autolayout';

const H = 120;

function build(ids: string[], links: [string, string][]): AutoLayoutNode[] {
  const { preds, succs } = adjacency(ids, links.map(([f, t]) => ({ from: { node: f }, to: { node: t } })));
  return ids.map((id) => ({ id, h: H, preds: preds.get(id)!, succs: succs.get(id)! }));
}

describe('自动布局', () => {
  it('直线链按数据流方向从左到右排开', () => {
    const { positions } = autoLayout(build(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]));
    const a = positions.get('a')!; const b = positions.get('b')!; const c = positions.get('c')!;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    expect(b.x - a.x).toBeGreaterThan(280);
  });

  it('分叉汇聚：同层节点垂直排开，下游层不重叠', () => {
    const { positions } = autoLayout(build(
      ['a', 'b', 'c', 'd'],
      [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
    ));
    const b = positions.get('b')!; const c = positions.get('c')!;
    expect(positions.get('b')!.x).toBe(positions.get('c')!.x);
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(H + 40);
    expect(positions.get('d')!.x).toBeGreaterThan(b.x);
  });

  it('菱形布局中交叉最少（b 与 c 的下游不交叉）', () => {
    // a → b → d / a → c → e，且 b → e：b、c 同层，e 在 d 的下一层
    const { positions } = autoLayout(build(
      ['a', 'b', 'c', 'd', 'e'],
      [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'e'], ['b', 'e']],
    ));
    const b = positions.get('b')!; const c = positions.get('c')!;
    expect(b.x).toBe(c.x);
    // b 有两条出边，应该在 c 之上（barycenter 会把连接更多的节点放上面）
    expect(b.y).toBeLessThan(c.y);
  });

  it('孤立节点不参与重排', () => {
    const nodes = build(['a', 'b', 'n'], [['a', 'b']]);
    // n 没有任何连线
    const { positions, arranged } = autoLayout(nodes);
    expect(positions.has('n')).toBe(false);
    expect(arranged).toBe(2);
  });

  it('环不会死循环，剩余节点仍有位置', () => {
    const { positions, arranged } = autoLayout(build(['a', 'b'], [['a', 'b'], ['b', 'a']]));
    expect(arranged).toBe(2);
    expect(positions.size).toBe(2);
  });

  it('origin 决定布局起点', () => {
    const { positions } = autoLayout(build(['a', 'b'], [['a', 'b']]), { origin: { x: 500, y: 300 } });
    expect(positions.get('a')).toEqual({ x: 500, y: 300 });
  });

  it('层内高度不一的节点按实际高度累计排布，不重叠', () => {
    const nodes = build(['a', 'b1', 'b2'], [['a', 'b1'], ['a', 'b2']]);
    nodes[1].h = 100; nodes[2].h = 260;
    const { positions } = autoLayout(nodes);
    const b1 = positions.get('b1')!; const b2 = positions.get('b2')!;
    expect(b2.y - b1.y).toBeGreaterThanOrEqual(100 + 40);
  });

  it('adjacency 忽略自环与悬空边', () => {
    const { preds, succs } = adjacency(['a'], [
      { from: { node: 'a' }, to: { node: 'a' } },
      { from: { node: 'a' }, to: { node: 'ghost' } },
    ]);
    expect(preds.get('a')).toEqual([]);
    expect(succs.get('a')).toEqual([]);
  });
});
