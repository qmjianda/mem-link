/**
 * 画布导航历史：逆向分析会不断沿地址跳转，需要能回到上一个视口与选中态。
 * 纯函数，便于单测；由 BlueprintApp 在每次显式导航动作前压栈。
 */
import type { Viewport } from './viewport';
import type { SelectionState } from './selection';

export const NAV_LIMIT = 40;

export interface NavSnapshot {
  view: Viewport;
  selection: SelectionState;
  /** 描述这个位置，用于顶栏按钮的 tooltip */
  label: string;
}

export interface NavState {
  back: NavSnapshot[];
  forward: NavSnapshot[];
}

export function emptyNav(): NavState {
  return { back: [], forward: [] };
}

function cloneSelection(s: SelectionState): SelectionState {
  return {
    nodes: new Set(s.nodes),
    edges: new Set(s.edges),
    entry: s.entry ? { ...s.entry } : undefined,
    primary: s.primary ? { ...s.primary } : null,
  };
}

function snap(s: NavSnapshot): NavSnapshot {
  return { view: { ...s.view }, selection: cloneSelection(s.selection), label: s.label };
}

function capped(list: NavSnapshot[]): NavSnapshot[] {
  return list.length > NAV_LIMIT ? list.slice(list.length - NAV_LIMIT) : list;
}

/** 即将离开 `current` 去往别处：把它压入 back，并清空 forward 分支。 */
export function pushNav(state: NavState, current: NavSnapshot): NavState {
  const last = state.back[state.back.length - 1];
  // 同一视口 + 同一选择不重复入栈（例如连续点击两次「适配全图」）。
  if (last && last.view.x === current.view.x && last.view.y === current.view.y
    && last.view.k === current.view.k && last.label === current.label) {
    return { back: state.back, forward: [] };
  }
  return { back: capped([...state.back, snap(current)]), forward: [] };
}

export interface NavStep {
  state: NavState;
  target: NavSnapshot;
}

export function goBack(state: NavState, current: NavSnapshot): NavStep | null {
  if (!state.back.length) return null;
  const target = state.back[state.back.length - 1];
  return {
    state: {
      back: state.back.slice(0, -1),
      forward: capped([...state.forward, snap(current)]),
    },
    target: snap(target),
  };
}

export function goForward(state: NavState, current: NavSnapshot): NavStep | null {
  if (!state.forward.length) return null;
  const target = state.forward[state.forward.length - 1];
  return {
    state: {
      back: capped([...state.back, snap(current)]),
      forward: state.forward.slice(0, -1),
    },
    target: snap(target),
  };
}

export function canBack(state: NavState): boolean { return state.back.length > 0; }
export function canForward(state: NavState): boolean { return state.forward.length > 0; }

export function backLabel(state: NavState): string {
  return state.back.length ? state.back[state.back.length - 1].label : '';
}
export function forwardLabel(state: NavState): string {
  return state.forward.length ? state.forward[state.forward.length - 1].label : '';
}
