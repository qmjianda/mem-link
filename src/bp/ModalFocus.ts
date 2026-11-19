/**
 * 模态浮层共用的焦点约定：
 * - 打开时焦点进入浮层（组件自己的初始 focus 优先）
 * - Tab / Shift+Tab 不离开浮层
 * - 关闭时把焦点还给触发控件
 *
 * Escape 由调用方决定是否处理；这里只在没有其他处理器拦截时兜底。
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export { FOCUSABLE };

export function useModalFocus<T extends HTMLElement>(onEscape?: () => void) {
  const ref = useRef<T>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const visible = (el: HTMLElement) => el.offsetParent !== null || el === document.activeElement;

    if (root && !root.contains(document.activeElement)) {
      const first = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
      (first ?? root).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && escapeRef.current) {
        e.preventDefault();
        e.stopPropagation();
        escapeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return ref;
}
