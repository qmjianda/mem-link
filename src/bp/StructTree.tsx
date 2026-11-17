/**
 * 结构树全屏视图：像调试器一样逐层看一个 struct / list / array。
 *
 * 数据由 `StructTree` 模型按需解码；这里只负责虚拟滚动、键盘导航、
 * 搜索过滤与下标跳转。行高固定，几千行也只渲染视口内的十几行。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toHex } from '../core/mem';
import type { TreeRootSpec, TreeRow } from './tree';
import { StructTree as TreeModel } from './tree';

const ROW_H = 22;
const OVERSCAN = 8;

/** 把搜索命中的片段标出来；只标第一处，够用且不会把行撑开。 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

interface Props {
  root: TreeRootSpec;
  title: string;
  subtitle?: string;
  onClose: () => void;
  onFollow: (addr: number, description: string) => void;
}

export default function StructTree({ root, title, subtitle, onClose, onFollow }: Props) {
  const model = useMemo(() => new TreeModel(root), [root]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([model.rootPath]));
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [jump, setJump] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const jumpRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => {
      // version 只在「加载更多」后递增：模型内部缓存已失效，这里借它触发重算
      void version;
      return model.rows(expanded, query);
    },
    [model, expanded, query, version],
  );

  /* ---------------------------------------------------------- 尺寸与滚动 */

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { hostRef.current?.focus(); }, []);

  // 换搜索词后结果整体变化，回到顶部并重置游标
  useEffect(() => {
    setCursor(0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  const scrollToIndex = (index: number) => {
    const el = bodyRef.current;
    if (!el) return;
    setCursor(index);
    const top = index * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2) + ROW_H / 2);
    }
  };

  useEffect(() => {
    if (!pendingPath) return;
    const index = rows.findIndex((r) => r.path === pendingPath);
    if (index >= 0) scrollToIndex(index);
    setPendingPath(null);
  }, [pendingPath, rows]);

  /* --------------------------------------------------------------- 操作 */

  const toggle = (row: TreeRow) => {
    if (row.more) {
      if (row.moreOf) {
        model.loadMore(row.moreOf);
        setVersion((v) => v + 1);
      }
      return;
    }
    if (!row.expandable) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    scrollToIndex(Math.min(rows.length - 1, Math.max(0, cursor + delta)));
  };

  const jumpToIndex = () => {
    const raw = jump.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { setNotice('下标必须是非负整数'); return; }
    const r = model.locateIndex(n);
    if (r.error || !r.path) { setNotice(r.error ?? '定位失败'); return; }
    setNotice('');
    setExpanded((prev) => new Set(prev).add(model.rootPath));
    setVersion((v) => v + 1);
    setPendingPath(r.path);
  };

  const copyPath = () => {
    const row = rows[cursor];
    if (!row) return;
    void navigator.clipboard?.writeText(row.path).then(
      () => setNotice('已复制路径'),
      () => setNotice('复制失败'),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const inField = !!(e.target as HTMLElement).closest('input, textarea, select');
    if (inField) return;
    const row = rows[cursor];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row?.expandable && !expanded.has(row.path)) toggle(row);
        else if (row) move(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row?.expandable && expanded.has(row.path)) toggle(row);
        else setCursor(Math.max(0, cursor - 1));
        break;
      case 'Enter':
      case ' ':
        if (row) { e.preventDefault(); toggle(row); }
        break;
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
      case 'g':
        if (model.root.kind !== 'struct') { e.preventDefault(); jumpRef.current?.focus(); }
        break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copyPath(); }
    }
  };

  /* --------------------------------------------------------------- 渲染 */

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);
  const openCount = expanded.size;
  const q = query.trim().toLowerCase();

  return (
    <div
      className="bp-tree-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} 结构视图`}
      tabIndex={-1}
      ref={hostRef}
      onKeyDown={onKeyDown}
    >
      <div className="bp-tree">
        <header className="bp-tree-head">
          <div className="bp-tree-title">
            <b>{title}</b>
            <span className="bp-tree-meta mono">
              {subtitle ? `${subtitle} · ` : ''}{root.type.name} @{toHex(root.addr)} · {model.summary()}
            </span>
          </div>
          <div className="bp-tree-tools">
            <label className="bp-tree-search">
              <input
                ref={searchRef}
                className="in mono"
                placeholder="搜索字段 / 值（/）"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
                    if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); }
                  }}
              />
              {query.trim() && <em>{rows.length} 行</em>}
            </label>
            {model.root.kind !== 'struct' && (
              <label className="bp-tree-jump">
                <input
                  ref={jumpRef}
                  className="in mono"
                  placeholder="跳下标（g）"
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToIndex(); } }}
                />
              </label>
            )}
            <button
              className="bp-mini"
              title="折叠全部"
              onClick={() => setExpanded(new Set())}
              disabled={openCount === 0}
            >折叠</button>
            <button className="bp-icon-btn" aria-label="关闭结构视图" title="关闭（Esc）" onClick={onClose}>×</button>
          </div>
        </header>

        <div className="bp-tree-cols">
          <span>名称</span>
          <span>值</span>
          <span>类型</span>
          <span className="bp-tree-off">偏移 / 地址</span>
          <span />
        </div>

        <div
          className="bp-tree-body"
          ref={bodyRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {rows.length === 0 && <div className="bp-empty">没有匹配的行</div>}
          <div className="bp-tree-spacer" style={{ height: rows.length * ROW_H }}>
            {visible.map((row, i) => {
              const index = start + i;
              const open = expanded.has(row.path);
              return (
                <div
                  key={row.path}
                  className={`bp-tree-row ${row.tone}${index === cursor ? ' on' : ''}`}
                  style={{ top: index * ROW_H }}
                  onMouseDown={(e) => { e.preventDefault(); setCursor(index); hostRef.current?.focus(); }}
                  onDoubleClick={() => toggle(row)}
                  title={row.path}
                >
                  <span className="bp-tree-name" style={{ paddingLeft: 6 + row.depth * 14 }}>
                    {row.expandable || row.more
                      ? (
                        <span
                          className="bp-tree-chev"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); toggle(row); }}
                        >{row.more ? '＋' : open ? '▾' : '▸'}</span>
                      )
                      : <span className="bp-tree-chev ghost" />}
                    <span className="mono"><Highlight text={row.label} q={q} /></span>
                  </span>
                  <span className="bp-tree-val mono" title={row.rawText ? `原始：${row.rawText}` : undefined}>
                    <Highlight text={row.valueText} q={q} />
                    {row.rawText && row.rawText !== row.valueText && <em> ← {row.rawText}</em>}
                  </span>
                  <span className="bp-tree-type mono"><Highlight text={row.typeText} q={q} /></span>
                  <span className="bp-tree-off mono">
                    {row.tone === 'field'
                      ? (row.offset >= 0 ? `+0x${row.offset.toString(16)}` : toHex(row.addr))
                      : row.tone === 'element' && row.addr ? toHex(row.addr) : ''}
                  </span>
                  <span className="bp-tree-act">
                    {row.ref && (
                      <button
                        className="bp-tree-go"
                        title={`在图上解析 ${row.ref.hint}`}
                        aria-label="在图上解析"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onFollow(row.ref!.addr, row.ref!.hint); }}
                      >↗</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <footer className="bp-tree-foot mono">
          <span>↑↓ 移动 · Enter 展开 · ←→ 收起/展开{model.root.kind !== 'struct' ? ' · g 跳下标' : ''} · / 搜索 · Ctrl+C 复制路径 · Esc 退出</span>
          <span className="bp-tree-notice">{notice}</span>
        </footer>
      </div>
    </div>
  );
}
