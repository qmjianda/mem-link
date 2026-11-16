/**
 * 图内搜索定位（Mod+F）：按节点标题、类型、端口名，或直接输入地址查找
 * 覆盖该地址的实例。回车选中并居中，是大型逆向图里最高频的导航动作。
 */
import { useEffect, useRef, useState } from 'react';

export interface SearchHit {
  nodeId: string;
  title: string;
  detail: string;
  /** 0x… 地址模式下的命中地址 */
  address?: number;
}

interface Props {
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}

export default function GraphSearch({ query, onQuery, hits, onPick, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(0);
  const [active, setActiveState] = useState(0);

  const setActive = (n: number | ((prev: number) => number)) => {
    const next = typeof n === 'function' ? n(activeRef.current) : n;
    activeRef.current = next;
    setActiveState(next);
  };

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => { setActive(0); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onClose(); return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (!hits.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + dir + hits.length) % hits.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const hit = hits[activeRef.current];
        if (hit) onPick(hit);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hits, onPick, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bp-overlay" role="dialog" aria-modal="true" aria-label="在图中查找" onPointerDown={onClose}>
      <div className="bp-quick bp-search-graph" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="bp-quick-input"
          placeholder="节点 / 类型 / 端口 / 0x1200"
          aria-label="在图中查找"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <div className="bp-quick-list" role="listbox" aria-label="查找结果">
          {hits.map((hit, i) => (
            <button
              key={`${hit.nodeId}/${hit.address ?? hit.detail}/${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`bp-quick-item${i === active ? ' on' : ''}`}
              title={hit.detail}
              onPointerEnter={() => setActive(i)}
              onClick={() => onPick(hit)}
            >
              <span className="bp-pal-dot" data-kind={hit.address != null ? '地址' : '解析'} />
              <span className="bp-quick-label">{hit.title}</span>
              <em>{hit.detail}</em>
            </button>
          ))}
          {!hits.length && <div className="bp-empty">无匹配对象</div>}
        </div>
        <div className="bp-quick-foot mono">↑↓ 选择 · Enter 定位 · Esc 关闭 · 直接输入 0x 地址可查覆盖它的实例</div>
      </div>
    </div>
  );
}
