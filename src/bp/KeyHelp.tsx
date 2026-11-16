/**
 * 快捷键帮助浮层（`?` 打开）：按分组列出「键位 — 操作」。
 */

import { useEffect } from 'react';
import { KEY_GROUPS, formatKeys, type Command } from './keys';

interface Props {
  commands: Command[];
  onClose: () => void;
}

export default function KeyHelp({ commands, onClose }: Props) {
  // Esc 关闭（捕获阶段，优先于注册表）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const byId = new Map(commands.map((c) => [c.id, c]));
  const groups = KEY_GROUPS
    .map((g) => ({ title: g.title, items: g.ids.map((id) => byId.get(id)).filter((c): c is Command => !!c && c.keys.length > 0) }))
    .filter((g) => g.items.length);

  return (
    <div className="bp-overlay" role="dialog" aria-modal="true" aria-label="快捷键" onPointerDown={onClose}>
      <div className="bp-help" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bp-help-head">
          <span>快捷键</span>
          <button className="bp-icon-btn" aria-label="关闭快捷键帮助" title="关闭（Esc）" onClick={onClose}>×</button>
        </div>
        <div className="bp-help-body">
          {groups.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((c) => (
                <div className="bp-help-row" key={c.id}>
                  <span className="mono">{formatKeys(c.keys)}</span>
                  <em>{c.label}</em>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
