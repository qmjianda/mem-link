/**
 * 快速添加浮层：双击画布空白或 `Mod+K` 打开，输入即过滤节点库，
 * `Enter` 在视口中心添加并选中，`Esc` 关闭。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { nodeItemsOf, type PalItem } from './Palette';
import type { LoadedPack } from './docstate';

interface Props {
  packs: LoadedPack[];
  onPick: (packId: string, nodeId: string) => void;
  onClose: () => void;
}

export default function QuickAdd({ packs, onPick, onClose }: Props) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => nodeItemsOf(packs), [packs]);
  const packNames = useMemo(() => new Map(packs.map((p) => [p.id, p.name])), [packs]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    const packOf = (i: PalItem) => (i.packId ? (packNames.get(i.packId) ?? '') : '');
    return all.filter((i) => `${i.label} ${i.nodeId} ${i.kind} ${i.hint ?? ''} ${packOf(i)}`.toLowerCase().includes(needle));
  }, [all, q, packNames]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);

  const pick = (item: PalItem | undefined) => {
    if (!item) return;
    onPick(item.packId, item.nodeId);
    onClose();
  };

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
        if (!items.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + dir + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pick(items[active]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active]);

  return (
    <div className="bp-overlay" role="dialog" aria-modal="true" aria-label="快速添加节点" onPointerDown={onClose}>
      <div className="bp-quick" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="bp-quick-input"
          placeholder="搜索节点 / 类型 / pack"
          aria-label="搜索节点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="bp-quick-list" role="listbox" aria-label="节点列表">
          {items.map((item, i) => (
            <button
              key={`${item.packId}/${item.nodeId}`}
              type="button"
              role="option"
              aria-selected={i === active}
              title={item.hint ?? item.label}
              className={`bp-quick-item${i === active ? ' on' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(item)}
            >
              <span className="bp-pal-dot" data-kind={item.kind} />
              <span className="bp-quick-label">{item.label}</span>
              <em>{item.kind}</em>
              {item.packId && <i>{packNames.get(item.packId) ?? item.packId}</i>}
            </button>
          ))}
          {!items.length && <div className="bp-empty">无匹配节点</div>}
        </div>
        <div className="bp-quick-foot mono">↑↓ 选择 · Enter 添加 · Esc 关闭</div>
      </div>
    </div>
  );
}
