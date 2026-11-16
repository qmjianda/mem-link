/**
 * 统一快捷键注册表（纯逻辑，无 React、无 DOM 副作用）。
 *
 * 组合键统一写成 `Mod+Z` / `Mod+Shift+Z` / `Delete` / `F` / `Mod+K` / `?`，
 * 其中 `Mod` = Windows/Linux 的 Ctrl 或 macOS 的 Cmd。归一化后两端比较，
 * 因此注册表与平台无关。
 */

export type KeyContext = 'global' | 'canvas' | 'inspector' | 'input';

export interface Command {
  id: string;
  /** 组合键（可多个，任一命中即触发） */
  keys: string[];
  /** 生效上下文；`input` 只给「输入框内也要生效」的命令用 */
  when: KeyContext;
  label: string;
  run: () => void;
  /** 同键位冲突时数字大者优先，默认 0 */
  priority?: number;
}

/** 输入框内放行的组合：保存、导出、图内查找、退出 */
export const ALLOW_IN_INPUT: readonly string[] = ['mod+s', 'mod+shift+e', 'mod+f', 'escape'];

const MODIFIER_ALIASES: Record<string, 'mod' | 'shift' | 'alt'> = {
  mod: 'mod', ctrl: 'mod', cmd: 'mod', meta: 'mod', command: 'mod', control: 'mod',
  shift: 'shift', alt: 'alt', option: 'alt',
};

/** 键名别名 → 归一化 token */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  backspace: 'backspace',
  space: ' ',
  '\\': '\\',
  backslash: '\\',
};

/** 标点类 token：Shift 会改变字符，判定时忽略 shift 标志 */
function isSymbolToken(token: string): boolean {
  return /^[^a-z0-9\\]$/.test(token) && token !== ' ';
}

function normalizeToken(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (lower.length === 1) return lower;
  return lower;
}

export interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** `Mod+Shift+Z` → `{mod:true, shift:true, alt:false, key:'z'}` */
export function parseCombo(spec: string): ParsedCombo {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  const out: ParsedCombo = { mod: false, shift: false, alt: false, key: '' };
  // 末尾的 '+' 表示按键本身是加号（`Mod++`）
  if (spec.trim().endsWith('++')) {
    parts.pop();
    parts.push('+');
  }
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) out[mod] = true;
    else out.key = normalizeToken(part);
  }
  return out;
}

/** 事件 → 归一化 token（反斜杠按物理键位判定，避免 Shift 后变成 `|`） */
function eventKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (e.code === 'Backslash' || e.key === '\\' || e.key === '|') return '\\';
  return normalizeToken(e.key);
}

/** 归一化后的组合键字符串，如 `mod+shift+z` */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(eventKey(e));
  return parts.join('+');
}

/** 是否命中组合键列表中的任意一个 */
export function matchKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  keys: string[],
): boolean {
  const key = eventKey(e);
  const mod = e.ctrlKey || e.metaKey;
  for (const spec of keys) {
    const p = parseCombo(spec);
    if (p.key !== key) continue;
    if (p.mod !== mod) continue;
    if (p.alt !== e.altKey) continue;
    // 标点类键由字符本身决定，忽略 Shift 标志（`?` 需要 Shift 才能敲出来）
    if (!isSymbolToken(p.key) && p.shift !== e.shiftKey) continue;
    return true;
  }
  return false;
}

/** 输入框 / 文本域 / select / contentEditable（入参放宽为 unknown 便于单测） */
export function isEditable(t: unknown): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 输入框内放行 Mod+S / Mod+Shift+E / Escape */
export function allowInInput(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  const combo = comboOf(e);
  return ALLOW_IN_INPUT.includes(combo);
}

/** 事件落在哪个上下文（输入框优先） */
export function contextOf(t: unknown): KeyContext {
  if (isEditable(t)) return 'input';
  const el = t as HTMLElement | null;
  if (el && typeof el.closest === 'function') {
    if (el.closest('.bp-canvas')) return 'canvas';
    if (el.closest('.bp-inspector')) return 'inspector';
  }
  return 'global';
}

/** 同键位多注册时取 priority 最大的那条 */
export function resolveCommand(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  ctx: KeyContext,
  cmds: Command[],
): Command | null {
  let best: Command | null = null;
  for (const c of cmds) {
    if (c.when !== ctx && c.when !== 'global') continue;
    if (!matchKey(e, c.keys)) continue;
    // canvas / inspector 的命令优先于同键位的 global 命令
    const score = (c.priority ?? 0) * 10 + (c.when === 'global' ? 0 : 1);
    const bestScore = best ? (best.priority ?? 0) * 10 + (best.when === 'global' ? 0 : 1) : -Infinity;
    if (score > bestScore) best = c;
  }
  return best;
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  arrowleft: '←',
  arrowright: '→',
  '\\': '\\',
  ' ': 'Space',
};

/** 界面展示：Mac 用 ⌘/⇧，其它平台用 Ctrl/Shift */
export function formatKeys(keys: string[], mac = MAC): string {
  return keys
    .map((spec) => {
      const p = parseCombo(spec);
      const out: string[] = [];
      if (p.mod) out.push(mac ? '⌘' : 'Ctrl');
      if (p.alt) out.push(mac ? '⌥' : 'Alt');
      if (p.shift) out.push(mac ? '⇧' : 'Shift');
      const label = KEY_LABELS[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key);
      out.push(label);
      return mac && p.mod ? out.join('') : out.join('+');
    })
    .join(' / ');
}

/** 快捷键帮助浮层的分组顺序 */
export const KEY_GROUPS: { title: string; ids: string[] }[] = [
  { title: '文件', ids: ['save', 'export', 'open'] },
  { title: '编辑', ids: ['undo', 'redo', 'copy', 'cut', 'paste', 'duplicate', 'rename', 'delete', 'select-all'] },
  { title: '视图与导航', ids: ['fit', 'fit-selection', 'zoom-100', 'zoom-in', 'zoom-out', 'focus-search', 'find', 'nav-back', 'nav-forward', 'auto-layout'] },
  { title: '布局与面板', ids: ['toggle-left', 'toggle-right'] },
  { title: '添加与帮助', ids: ['quick-add', 'help', 'escape'] },
];
