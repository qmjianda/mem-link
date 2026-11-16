/**
 * 右键菜单模型（纯函数，便于单测）。
 *
 * 只产出「有哪些项 / 是否禁用 / 禁用原因」，具体动作由调用方按 id 分派，
 * 因此这里零依赖、零副作用。
 */

export type MenuTarget =
  | { kind: 'canvas'; world: { x: number; y: number } }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'in-port'; nodeId: string; port: string }
  | { kind: 'out-port'; nodeId: string; port: string };

export interface MenuItem {
  id: string;
  label: string;
  /** 展示用的键位（`Mod+V`），由 UI 层格式化 */
  keys?: string;
  disabled?: boolean;
  /** 禁用原因：用 title 提示，不隐藏菜单项 */
  reason?: string;
  danger?: boolean;
  /** 由调用方按 id 分派时可不填 */
  run?: () => void;
}

/** 生成菜单所需的上下文快照 */
export interface MenuCtx {
  /** 内存剪贴板是否为空 */
  clipboardEmpty: boolean;
  /** 当前选择对象数 */
  selectionCount: number;
  /** 图里对象总数（全选是否可用） */
  objectCount: number;
  /** 节点关联的连线数（决定「断开全部连线」） */
  nodeEdgeCount: number;
  /** 输入端口是否已连线 */
  portWired: boolean;
  minimapOpen: boolean;
  /** 以下为可选快照：旧调用方缺省时按「可用」处理 */
  canUndo?: boolean;
  canRedo?: boolean;
  problemCount?: number;
  /** 输出端口 / 节点的下游连线数 */
  downstreamCount?: number;
  /** 输入端口当前值的短文本 */
  portValue?: string;
  /** 输出端口是否存在下游连线 */
  outPortWired?: boolean;
  /** 端口当前值是否是一个落在缓冲区内的地址（决定「跟随地址」是否可用） */
  portFollowable?: boolean;
  /** 不能跟随时展示给用户的原因；缺省按「不是有效地址」处理 */
  portFollowReason?: string;
  /** 跟随地址浮层标题里要显示的地址 */
  portAddress?: number;
}

export const MENU_WIDTH = 232;
export const MENU_MARGIN = 8;

const disabled = (item: MenuItem, reason: string): MenuItem => ({ ...item, disabled: true, reason });

/** 按目标类型生成菜单项（顺序即展示顺序） */
export function buildMenu(target: MenuTarget, ctx: MenuCtx): MenuItem[] {
  switch (target.kind) {
    case 'canvas': {
      const paste: MenuItem = { id: 'paste', label: '粘贴', keys: 'Mod+V' };
      const undo: MenuItem = { id: 'undo', label: '撤销', keys: 'Mod+Z' };
      const redo: MenuItem = { id: 'redo', label: '重做', keys: 'Mod+Shift+Z' };
      const selectAll: MenuItem = { id: 'select-all', label: '全选', keys: 'Mod+A' };
      const clear: MenuItem = { id: 'clear-canvas', label: '清空画布', danger: true };
      return [
        ctx.clipboardEmpty ? disabled(paste, '剪贴板为空') : paste,
        ctx.canUndo === false ? disabled(undo, '无可撤销的操作') : undo,
        ctx.canRedo === false ? disabled(redo, '无可重做的操作') : redo,
        ctx.objectCount === 0 ? disabled(selectAll, '画布为空') : selectAll,
        { id: 'quick-add', label: '快速添加节点…', keys: 'Mod+K' },
        { id: 'fit', label: '适配全图', keys: 'Mod+0' },
        { id: 'zoom-100', label: '缩放 100%', keys: 'Mod+1' },
        { id: 'auto-layout', label: '自动布局', keys: 'Mod+L' },
        { id: 'minimap', label: ctx.minimapOpen ? '隐藏小地图' : '显示小地图' },
        {
          id: 'problems',
          label: ctx.problemCount ? `查看问题 · ${ctx.problemCount}` : '查看问题',
        },
        { id: 'export', label: '导出蓝图', keys: 'Mod+Shift+E' },
        ctx.objectCount === 0 ? disabled(clear, '画布为空') : clear,
      ];
    }
    case 'node': {
      const unlink: MenuItem = { id: 'disconnect-all', label: '断开全部连线' };
      const downstream: MenuItem = { id: 'goto-downstream', label: '定位下游节点' };
      return [
        { id: 'copy', label: '复制', keys: 'Mod+C' },
        { id: 'cut', label: '剪切', keys: 'Mod+X' },
        { id: 'duplicate', label: '创建副本', keys: 'Mod+D' },
        { id: 'rename', label: '重命名', keys: 'F2' },
        ctx.nodeEdgeCount === 0 ? disabled(unlink, '该节点没有连线') : unlink,
        { id: 'fit-selection', label: '适配选中', keys: 'F' },
        { id: 'inspect-node', label: '在检查器中查看' },
        ctx.downstreamCount === 0 ? disabled(downstream, '没有下游节点') : downstream,
        { id: 'delete', label: '删除', keys: 'Delete', danger: true },
      ];
    }
    case 'edge':
      return [
        { id: 'inspect-edge', label: '在检查器中查看' },
        { id: 'goto-source-node', label: '定位来源节点' },
        { id: 'goto-target-node', label: '定位目标节点' },
        { id: 'delete', label: '删除连线', keys: 'Delete', danger: true },
      ];
    case 'in-port': {
      const unwire: MenuItem = { id: 'disconnect-port', label: '断开连线' };
      const from: MenuItem = { id: 'goto-source', label: '定位来源节点' };
      const value: MenuItem = { id: 'view-value', label: '查看当前值' };
      const follow: MenuItem = {
        id: 'follow-address',
        label: ctx.portAddress != null
          ? `跟随地址 0x${ctx.portAddress.toString(16)}…`
          : '跟随地址…',
        keys: '双击',
      };
      return [
        ctx.portFollowable === false
          ? disabled(follow, ctx.portFollowReason ?? '该端口不是有效地址')
          : follow,
        ctx.portWired ? unwire : disabled(unwire, '该端口未连线'),
        ctx.portWired ? from : disabled(from, '该端口未连线'),
        { id: 'copy-port-name', label: '复制端口名' },
        ctx.portValue == null ? disabled(value, '该端口没有值') : value,
      ];
    }
    case 'out-port': {
      const downstream: MenuItem = { id: 'goto-downstream', label: '定位下游节点' };
      const follow: MenuItem = {
        id: 'follow-address',
        label: ctx.portAddress != null
          ? `跟随地址 0x${ctx.portAddress.toString(16)}…`
          : '跟随地址…',
        keys: '双击',
      };
      return [
        ctx.portFollowable === false
          ? disabled(follow, ctx.portFollowReason ?? '该端口不是有效地址')
          : follow,
        { id: 'start-wire', label: '从此端口开始连线' },
        { id: 'copy-port-name', label: '复制端口名' },
        ctx.outPortWired === false ? disabled(downstream, '没有下游节点') : downstream,
      ];
    }
    default:
      return [];
  }
}

/**
 * 菜单位置：默认贴右下展开，超出视口则在对应方向翻转，并保留 `margin` 边距。
 * 返回值已夹在 `[margin, view - size - margin]` 之间。
 */
export function placeMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  viewW: number,
  viewH: number,
  margin = MENU_MARGIN,
): { left: number; top: number; flippedX: boolean; flippedY: boolean } {
  const flippedX = x + w + margin > viewW;
  const flippedY = y + h + margin > viewH;
  const left = flippedX ? x - w : x;
  const top = flippedY ? y - h : y;
  return {
    left: Math.max(margin, Math.min(left, Math.max(margin, viewW - w - margin))),
    top: Math.max(margin, Math.min(top, Math.max(margin, viewH - h - margin))),
    flippedX,
    flippedY,
  };
}

/** 与菜单目标绑定的可用动作 id 集合（供分派时校验） */
export function menuActionIds(target: MenuTarget, ctx: MenuCtx): string[] {
  return buildMenu(target, ctx).filter((i) => !i.disabled).map((i) => i.id);
}
