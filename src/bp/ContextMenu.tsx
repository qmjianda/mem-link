/**
 * 右键菜单渲染：键盘可达（↑↓ / Enter / Esc）、点击外部关闭、边缘自动翻转。
 * 菜单项来自 `buildMenu()`，动作通过 `onRun(id)` 交给调用方分派。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatKeys } from './keys';
import { MENU_WIDTH, placeMenu, type MenuItem } from './menus';

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onRun: (item: MenuItem) => void;
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onRun, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 先渲染到点击点，量出高度后再翻转/夹紧
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const p = placeMenu(x, y, MENU_WIDTH, h, window.innerWidth, window.innerHeight);
    setPos({ left: p.left, top: p.top });
  }, [x, y, items]);

  /** 当前高亮项（跳过禁用项） */
  const firstEnabled = items.findIndex((i) => !i.disabled);
  const [active, setActive] = useState(firstEnabled);
  useEffect(() => { setActive(items.findIndex((i) => !i.disabled)); }, [items]);

  // 焦点进入菜单，保证键盘事件有落点
  useEffect(() => { ref.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let i = active;
        for (let n = 0; n < items.length; n += 1) {
          i = (i + dir + items.length) % items.length;
          if (!items[i].disabled) break;
        }
        setActive(i);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        const item = items[active];
        if (item && !item.disabled) onRun(item);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items]);

  if (!items.length) return null;

  return (
    <div
      ref={ref}
      className="bp-menu"
      role="menu"
      aria-label="上下文菜单"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`bp-menu-item${item.danger ? ' danger' : ''}${i === active ? ' on' : ''}`}
          aria-disabled={item.disabled ? 'true' : 'false'}
          title={item.disabled ? item.reason : undefined}
          onPointerEnter={() => { if (!item.disabled) setActive(i); }}
          onClick={() => { if (!item.disabled) onRun(item); }}
        >
          <span>{item.label}</span>
          {item.keys && <em className="mono">{formatKeys([item.keys])}</em>}
          {item.disabled && item.reason && <i className="bp-menu-reason">{item.reason}</i>}
        </button>
      ))}
    </div>
  );
}
