/**
 * 三栏布局状态与 UI 偏好持久化（只被 `src/bp/*` 引用）。UI 偏好写入独立键
 * `memlink:ui:v1`，与图文档分离：面板宽度/折叠/分组折叠不触发图写入。
 */
export const KEY_UI = 'memlink:ui:v1';
export const UI_VERSION = 1;
/** 折叠后固定留出的竖排条宽度 */
export const COLLAPSED_W = 36;
export interface LayoutState { leftWidth: number; rightWidth: number; leftCollapsed: boolean; rightCollapsed: boolean }
export interface DesignerPrefs { rowBytes: 4 | 8 | 16 | 32; bitOrder: 'lsb' | 'msb'; tableOpen: boolean }
export interface UiPrefs { layout: LayoutState; groups: GroupState; minimap: boolean; designer?: DesignerPrefs }
/** 分组折叠表：key 为 `builtin` 或 pack id，true 表示折叠 */
export type GroupState = Record<string, boolean>;
/** 宽度上下限：左 240–480，右 320–640 */
export const LAYOUT_LIMITS: { left: [number, number]; right: [number, number] } = { left: [240, 480], right: [320, 640] };
export const LAYOUT_DEFAULT: LayoutState = { leftWidth: 330, rightWidth: 404, leftCollapsed: false, rightCollapsed: false };
/** 双击分隔条 / `Home` 键的复位宽度 */
export function resetSide(side: 'left' | 'right'): number {
  return side === 'left' ? LAYOUT_DEFAULT.leftWidth : LAYOUT_DEFAULT.rightWidth;
}
/** 把宽度夹到该侧允许区间；非有限值回落到该侧默认值 */
export function clampWidth(side: 'left' | 'right', px: number): number {
  const [min, max] = LAYOUT_LIMITS[side];
  if (!Number.isFinite(px)) return resetSide(side);
  return Math.min(max, Math.max(min, Math.round(px)));
}
/**
 * 窄屏让位：<900 双侧折叠（画布优先）；<1180 右栏折叠且左栏 300。
 * 宽屏返回空对象——不自动展开，尊重用户手动展开的选择。
 */
export function autoCollapse(viewportWidth: number): Partial<LayoutState> {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return {};
  if (viewportWidth < 900) return { leftCollapsed: true, rightCollapsed: true };
  if (viewportWidth < 1180) return { leftWidth: 300, rightCollapsed: true };
  return {};
}
export function defaultPrefs(): UiPrefs {
  return { layout: { ...LAYOUT_DEFAULT }, groups: {}, minimap: true, designer: { rowBytes: 4, bitOrder: 'lsb', tableOpen: true } };
}
function num(v: unknown, d: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function bool(v: unknown, d: boolean): boolean { return typeof v === 'boolean' ? v : d; }
/** 读取 UI 偏好。隐私模式 / 坏 JSON / 版本不匹配 / 配额异常一律静默回落默认值。 */
export function readPrefs(): UiPrefs {
  const base = defaultPrefs();
  try {
    const raw = window.localStorage.getItem(KEY_UI);
    if (!raw) return base;
    const env = JSON.parse(raw) as { version?: number; data?: Partial<UiPrefs> } | null;
    if (!env || env.version !== UI_VERSION || !env.data) return base;
    const l = (env.data.layout ?? {}) as Partial<LayoutState>;
    const groups: GroupState = {};
    if (env.data.groups && typeof env.data.groups === 'object') {
      for (const [k, v] of Object.entries(env.data.groups)) if (typeof v === 'boolean') groups[k] = v;
    }
    return {
      layout: {
        leftWidth: clampWidth('left', num(l.leftWidth, LAYOUT_DEFAULT.leftWidth)),
        rightWidth: clampWidth('right', num(l.rightWidth, LAYOUT_DEFAULT.rightWidth)),
        leftCollapsed: bool(l.leftCollapsed, LAYOUT_DEFAULT.leftCollapsed),
        rightCollapsed: bool(l.rightCollapsed, LAYOUT_DEFAULT.rightCollapsed),
      },
      groups,
      minimap: bool((env.data as { minimap?: unknown }).minimap, true),
      designer: (() => {
        const d = (env.data as { designer?: Partial<DesignerPrefs> }).designer;
        const rowBytes = d?.rowBytes;
        return {
          rowBytes: rowBytes === 4 || rowBytes === 8 || rowBytes === 16 || rowBytes === 32 ? rowBytes : 4,
          bitOrder: d?.bitOrder === 'msb' ? 'msb' : 'lsb',
          tableOpen: typeof d?.tableOpen === 'boolean' ? d.tableOpen : true,
        };
      })(),
    };
  } catch {
    return base;
  }
}
/** 写入 UI 偏好：存储不可用时只保留内存态，不抛错。 */
export function writePrefs(prefs: UiPrefs): void {
  try {
    const current = readPrefs();
    const env = {
      version: UI_VERSION, savedAt: Date.now(),
      data: { ...prefs, designer: prefs.designer ?? current.designer },
    };
    window.localStorage.setItem(KEY_UI, JSON.stringify(env));
  } catch {
    /* 隐私模式 / 配额满：静默降级，布局仍在本会话内存中生效 */
  }
}
