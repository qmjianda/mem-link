import { describe, expect, it } from 'vitest';
import {
  ALLOW_IN_INPUT, allowInInput, comboOf, contextOf, formatKeys, isEditable, matchKey, parseCombo,
  resolveCommand, type Command,
} from '../src/bp/keys';

const ev = (o: Partial<KeyboardEvent> & { key: string }) => ({
  key: o.key,
  code: o.code ?? '',
  ctrlKey: o.ctrlKey ?? false,
  metaKey: o.metaKey ?? false,
  shiftKey: o.shiftKey ?? false,
  altKey: o.altKey ?? false,
});

describe('parseCombo', () => {
  it('解析 Mod / Shift / 普通键', () => {
    expect(parseCombo('Mod+Z')).toEqual({ mod: true, shift: false, alt: false, key: 'z' });
    expect(parseCombo('Mod+Shift+Z')).toEqual({ mod: true, shift: true, alt: false, key: 'z' });
    expect(parseCombo('Delete')).toEqual({ mod: false, shift: false, alt: false, key: 'delete' });
    expect(parseCombo('Esc')).toEqual({ mod: false, shift: false, alt: false, key: 'escape' });
    expect(parseCombo('Mod+\\')).toEqual({ mod: true, shift: false, alt: false, key: '\\' });
  });

  it('Cmd / Ctrl 都归一为 Mod', () => {
    expect(parseCombo('Cmd+K').mod).toBe(true);
    expect(parseCombo('Ctrl+K').mod).toBe(true);
    expect(parseCombo('Command+K').mod).toBe(true);
  });
});

describe('comboOf', () => {
  it('归一化事件组合', () => {
    expect(comboOf(ev({ key: 'z', ctrlKey: true }))).toBe('mod+z');
    expect(comboOf(ev({ key: 'Z', metaKey: true, shiftKey: true }))).toBe('mod+shift+z');
    expect(comboOf(ev({ key: 'Escape' }))).toBe('escape');
    expect(comboOf(ev({ key: '?', shiftKey: true }))).toBe('shift+?');
  });

  it('反斜杠按物理键位归一（Shift 后字符变 |）', () => {
    expect(comboOf(ev({ key: '\\', code: 'Backslash', ctrlKey: true }))).toBe('mod+\\');
    expect(comboOf(ev({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }))).toBe('mod+shift+\\');
  });
});

describe('matchKey', () => {
  it('Mod 映射到 Ctrl 与 Cmd', () => {
    expect(matchKey(ev({ key: 'z', ctrlKey: true }), ['Mod+Z'])).toBe(true);
    expect(matchKey(ev({ key: 'z', metaKey: true }), ['Mod+Z'])).toBe(true);
    expect(matchKey(ev({ key: 'z' }), ['Mod+Z'])).toBe(false);
  });

  it('多余的修饰键不命中', () => {
    expect(matchKey(ev({ key: 'z', ctrlKey: true, altKey: true }), ['Mod+Z'])).toBe(false);
    expect(matchKey(ev({ key: 'z', ctrlKey: true, shiftKey: true }), ['Mod+Z'])).toBe(false);
  });

  it('Shift 组合必须带 Shift', () => {
    expect(matchKey(ev({ key: 'Z', ctrlKey: true, shiftKey: true }), ['Mod+Shift+Z'])).toBe(true);
    expect(matchKey(ev({ key: 'z', ctrlKey: true }), ['Mod+Shift+Z'])).toBe(false);
  });

  it('多键位任一命中', () => {
    const keys = ['Mod+Shift+Z', 'Mod+Y'];
    expect(matchKey(ev({ key: 'y', ctrlKey: true }), keys)).toBe(true);
    expect(matchKey(ev({ key: 'Z', ctrlKey: true, shiftKey: true }), keys)).toBe(true);
    expect(matchKey(ev({ key: 'x', ctrlKey: true }), keys)).toBe(false);
  });

  it('标点键忽略 Shift（`?` 本身需要 Shift）', () => {
    expect(matchKey(ev({ key: '?', shiftKey: true }), ['?'])).toBe(true);
    expect(matchKey(ev({ key: '?' }), ['?'])).toBe(true);
  });

  it('反斜杠区分 Shift', () => {
    expect(matchKey(ev({ key: '\\', code: 'Backslash', ctrlKey: true }), ['Mod+\\'])).toBe(true);
    expect(matchKey(ev({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }), ['Mod+\\'])).toBe(false);
    expect(matchKey(ev({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }), ['Mod+Shift+\\'])).toBe(true);
  });

  it('Delete 与 Backspace 是不同键位', () => {
    expect(matchKey(ev({ key: 'Delete' }), ['Delete'])).toBe(true);
    expect(matchKey(ev({ key: 'Backspace' }), ['Delete'])).toBe(false);
    expect(matchKey(ev({ key: 'Backspace' }), ['Delete', 'Backspace'])).toBe(true);
  });
});

describe('isEditable / allowInInput', () => {
  const fake = (tagName: string, contentEditable = false) => ({ tagName, isContentEditable: contentEditable });

  it('识别输入类元素', () => {
    expect(isEditable(fake('INPUT'))).toBe(true);
    expect(isEditable(fake('TEXTAREA'))).toBe(true);
    expect(isEditable(fake('SELECT'))).toBe(true);
    expect(isEditable(fake('DIV', true))).toBe(true);
    expect(isEditable(fake('DIV'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it('输入框内只放行 Mod+S 与 Escape', () => {
    expect(allowInInput(ev({ key: 's', ctrlKey: true }))).toBe(true);
    expect(allowInInput(ev({ key: 'Escape' }))).toBe(true);
    expect(allowInInput(ev({ key: 'z', ctrlKey: true }))).toBe(false);
    expect(allowInInput(ev({ key: 'Delete' }))).toBe(false);
    expect(ALLOW_IN_INPUT).toEqual(['mod+s', 'mod+shift+e', 'mod+f', 'escape']);
  });
});

describe('contextOf', () => {
  const el = (hits: string[]) => ({
    tagName: 'DIV',
    isContentEditable: false,
    closest: (sel: string) => (hits.includes(sel) ? { tagName: 'DIV' } : null),
  });

  it('输入框优先，其次画布/检查器', () => {
    expect(contextOf({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe('input');
    expect(contextOf(el(['.bp-canvas']) as unknown as EventTarget)).toBe('canvas');
    expect(contextOf(el(['.bp-inspector']) as unknown as EventTarget)).toBe('inspector');
    expect(contextOf(el([]) as unknown as EventTarget)).toBe('global');
  });
});

describe('resolveCommand', () => {
  const mk = (id: string, keys: string[], when: Command['when'], priority = 0): Command => ({
    id, keys, when, label: id, run: () => {}, priority,
  });

  it('按上下文过滤', () => {
    const cmds = [mk('canvas-only', ['F'], 'canvas'), mk('inspector-only', ['F'], 'inspector')];
    expect(resolveCommand(ev({ key: 'f' }), 'canvas', cmds)?.id).toBe('canvas-only');
    expect(resolveCommand(ev({ key: 'f' }), 'inspector', cmds)?.id).toBe('inspector-only');
    expect(resolveCommand(ev({ key: 'f' }), 'input', cmds)).toBeNull();
  });

  it('canvas 命令优先于同键位的 global 命令', () => {
    const cmds = [mk('g', ['F'], 'global'), mk('c', ['F'], 'canvas')];
    expect(resolveCommand(ev({ key: 'f' }), 'canvas', cmds)?.id).toBe('c');
    expect(resolveCommand(ev({ key: 'f' }), 'global', cmds)?.id).toBe('g');
  });

  it('priority 大的优先，未命中返回 null', () => {
    const cmds = [mk('low', ['Mod+K'], 'global', 0), mk('high', ['Mod+K'], 'global', 5)];
    expect(resolveCommand(ev({ key: 'k', ctrlKey: true }), 'global', cmds)?.id).toBe('high');
    expect(resolveCommand(ev({ key: 'q', ctrlKey: true }), 'global', cmds)).toBeNull();
  });
});

describe('formatKeys', () => {
  it('Windows / Linux 用 Ctrl', () => {
    expect(formatKeys(['Mod+Z'], false)).toBe('Ctrl+Z');
    expect(formatKeys(['Mod+Shift+Z'], false)).toBe('Ctrl+Shift+Z');
    expect(formatKeys(['Delete'], false)).toBe('Del');
    expect(formatKeys(['?'], false)).toBe('?');
  });

  it('Mac 用 ⌘ / ⇧', () => {
    expect(formatKeys(['Mod+Z'], true)).toBe('⌘Z');
    expect(formatKeys(['Mod+Shift+Z'], true)).toBe('⌘⇧Z');
    expect(formatKeys(['Mod+\\'], true)).toBe('⌘\\');
  });

  it('多键位用 / 分隔', () => {
    expect(formatKeys(['Mod+Shift+Z', 'Mod+Y'], false)).toBe('Ctrl+Shift+Z / Ctrl+Y');
  });
});
