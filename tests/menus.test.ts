import { describe, expect, it } from 'vitest';
import {
  MENU_MARGIN, MENU_WIDTH, buildMenu, menuActionIds, placeMenu, type MenuCtx, type MenuItem,
} from '../src/bp/menus';

const baseCtx: MenuCtx = {
  clipboardEmpty: false,
  selectionCount: 1,
  objectCount: 10,
  nodeEdgeCount: 2,
  portWired: true,
  minimapOpen: true,
};

const ids = (items: MenuItem[]) => items.map((i) => i.id);
const find = (items: MenuItem[], id: string) => items.find((i) => i.id === id)!;

describe('画布空白菜单', () => {
  const target = { kind: 'canvas' as const, world: { x: 10, y: 20 } };

  it('顺序固定，含撤销/重做/自动布局/问题/导出/清空', () => {
    expect(ids(buildMenu(target, baseCtx))).toEqual([
      'paste', 'undo', 'redo', 'select-all', 'quick-add', 'fit', 'zoom-100',
      'auto-layout', 'minimap', 'problems', 'export', 'clear-canvas',
    ]);
  });

  it('剪贴板为空时「粘贴」禁用并给出原因', () => {
    const items = buildMenu(target, { ...baseCtx, clipboardEmpty: true });
    const paste = find(items, 'paste');
    expect(paste.disabled).toBe(true);
    expect(paste.reason).toBe('剪贴板为空');
    // 禁用项仍然出现在菜单里（不隐藏）
    expect(items.length).toBe(12);
    expect(menuActionIds(target, { ...baseCtx, clipboardEmpty: true })).not.toContain('paste');
  });

  it('图为空时「全选」禁用', () => {
    const items = buildMenu(target, { ...baseCtx, objectCount: 0 });
    expect(find(items, 'select-all').disabled).toBe(true);
    expect(find(items, 'select-all').reason).toBe('画布为空');
  });

  it('小地图项随开关切换文案', () => {
    expect(find(buildMenu(target, baseCtx), 'minimap').label).toBe('隐藏小地图');
    expect(find(buildMenu(target, { ...baseCtx, minimapOpen: false }), 'minimap').label).toBe('显示小地图');
  });

  it('键位标注齐全', () => {
    const items = buildMenu(target, baseCtx);
    expect(find(items, 'paste').keys).toBe('Mod+V');
    expect(find(items, 'select-all').keys).toBe('Mod+A');
    expect(find(items, 'quick-add').keys).toBe('Mod+K');
    expect(find(items, 'fit').keys).toBe('Mod+0');
    expect(find(items, 'zoom-100').keys).toBe('Mod+1');
  });
});

describe('节点菜单', () => {
  const target = { kind: 'node' as const, id: 'n1' };

  it('九项，含重命名与定位下游节点', () => {
    expect(ids(buildMenu(target, baseCtx))).toEqual([
      'copy', 'cut', 'duplicate', 'rename', 'disconnect-all', 'fit-selection',
      'inspect-node', 'goto-downstream', 'delete',
    ]);
  });

  it('没有下游连线时定位项禁用并说明', () => {
    const items = buildMenu(target, { ...baseCtx, downstreamCount: 0 });
    expect(find(items, 'goto-downstream').disabled).toBe(true);
    expect(find(items, 'goto-downstream').reason).toBe('没有下游节点');
  });

  it('删除是 danger 项', () => {
    expect(find(buildMenu(target, baseCtx), 'delete').danger).toBe(true);
  });

  it('没有连线时「断开全部连线」禁用并说明', () => {
    const items = buildMenu(target, { ...baseCtx, nodeEdgeCount: 0 });
    const unlink = find(items, 'disconnect-all');
    expect(unlink.disabled).toBe(true);
    expect(unlink.reason).toBe('该节点没有连线');
  });
});

describe('连线菜单', () => {
  it('查看 / 定位两端 / 删除（danger）', () => {
    const items = buildMenu({ kind: 'edge', id: 'e1' }, baseCtx);
    expect(ids(items)).toEqual(['inspect-edge', 'goto-source-node', 'goto-target-node', 'delete']);
    expect(find(items, 'delete').danger).toBe(true);
  });
});

describe('端口菜单', () => {
  it('输入端口未连线时断开/定位禁用，跟随地址与复制端口名仍可用', () => {
    const items = buildMenu(
      { kind: 'in-port', nodeId: 'n1', port: 'buffer' },
      { ...baseCtx, portWired: false, portFollowable: true, portAddress: 0x1200 },
    );
    expect(ids(items)).toEqual(['follow-address', 'disconnect-port', 'goto-source', 'copy-port-name', 'view-value']);
    expect(items[0].label).toContain('0x1200');
    expect(items[1].disabled).toBe(true);
    expect(items[1].reason).toBe('该端口未连线');
    expect(items[2].disabled).toBe(true);
    expect(items[3].disabled).toBeFalsy();
    expect(items[4].disabled).toBe(true);
  });

  it('跟随地址在端口值不是有效地址时禁用并说明', () => {
    const items = buildMenu(
      { kind: 'out-port', nodeId: 'n1', port: 'name' },
      { ...baseCtx, portFollowable: false },
    );
    expect(find(items, 'follow-address').disabled).toBe(true);
    expect(find(items, 'follow-address').reason).toBe('该端口不是有效地址');
  });

  it('跟随地址禁用时优先显示更具体的原因（列表/越界）', () => {
    const items = buildMenu(
      { kind: 'out-port', nodeId: 'n1', port: 'list' },
      { ...baseCtx, portFollowable: false, portFollowReason: '列表端口有多个元素地址' },
    );
    expect(find(items, 'follow-address').reason).toBe('列表端口有多个元素地址');
  });

  it('输入端口已连线且有值时全部可用', () => {
    const items = buildMenu(
      { kind: 'in-port', nodeId: 'n1', port: 'buffer' },
      { ...baseCtx, portValue: 'demo.bin' },
    );
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it('输出端口含跟随地址、起线、复制端口名与定位下游', () => {
    const items = buildMenu({ kind: 'out-port', nodeId: 'n1', port: 'head' }, baseCtx);
    expect(ids(items)).toEqual(['follow-address', 'start-wire', 'copy-port-name', 'goto-downstream']);
    expect(items[1].disabled).toBeFalsy();
    expect(buildMenu({ kind: 'out-port', nodeId: 'n1', port: 'head' }, { ...baseCtx, outPortWired: false })[3].disabled).toBe(true);
  });
});

describe('placeMenu 边缘翻转', () => {
  it('中间位置不翻转', () => {
    expect(placeMenu(100, 100, MENU_WIDTH, 200, 1200, 800)).toEqual({
      left: 100, top: 100, flippedX: false, flippedY: false,
    });
  });

  it('右侧空间不足时水平翻转', () => {
    const p = placeMenu(1150, 100, MENU_WIDTH, 200, 1200, 800);
    expect(p.flippedX).toBe(true);
    expect(p.left).toBe(1150 - MENU_WIDTH);
  });

  it('底部空间不足时垂直翻转', () => {
    const p = placeMenu(100, 700, MENU_WIDTH, 200, 1200, 800);
    expect(p.flippedY).toBe(true);
    expect(p.top).toBe(700 - 200);
  });

  it('右下角同时翻转且不越界', () => {
    const p = placeMenu(1190, 790, MENU_WIDTH, 220, 1200, 800);
    expect(p.flippedX).toBe(true);
    expect(p.flippedY).toBe(true);
    expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(p.top).toBeGreaterThanOrEqual(MENU_MARGIN);
  });

  it('极端小视口也夹在 margin 内', () => {
    const p = placeMenu(10, 10, MENU_WIDTH, 300, 260, 200);
    // 水平方向还有空间（10+232+8 <= 260），不翻转；垂直方向翻转后被夹到上边距
    expect(p.flippedX).toBe(false);
    expect(p.left).toBe(10);
    expect(p.flippedY).toBe(true);
    expect(p.top).toBe(MENU_MARGIN);
  });
});
