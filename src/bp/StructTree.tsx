/**
 * 结构树全屏视图：像调试器一样逐层看一个 struct / list / array。
 *
 * 数据由 `StructTree` 模型按需解码；这里只负责虚拟滚动、键盘导航、
 * 搜索过滤与下标跳转。行高固定，几千行也只渲染视口内的十几行。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toHex } from '../core/mem';
import type { TreeFocus, TreeRootSpec, TreeRow } from './tree';
import { findRowPathByAddr, StructTree as TreeModel } from './tree';

const ROW_H = 22;
const OVERSCAN = 8;

/** 把搜索命中的片段标出来；只标第一处，够用且不会把行撑开。 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/** 同一节点再次打开时恢复的视图状态（只在本次会话内保留）。 */
export interface TreeSession {
  expanded: string[];
  query: string;
  cursor: number;
  scrollTop: number;
}

interface Props {
  root: TreeRootSpec;
  title: string;
  subtitle?: string;
  initial?: TreeSession;
  /** 从节点卡截断提示进来时，自动跳到那一项 */
  focus?: TreeFocus;
  /** 跟随浮层打开期间暂时让位，但不卸载：展开/搜索/滚动全部保留 */
  hidden?: boolean;
  onSession?: (session: TreeSession) => void;
  onClose: () => void;
  /** 在图上解析（跟随并返回树） */
  onFollow: (addr: number, description: string, port?: string) => void;
  /** 直接按当前类型在图上生成解析节点；返回是否成功 */
  onResolve?: (addr: number, typeName: string, port?: string) => boolean;
}

export default function StructTree({
  root, title, subtitle, initial, focus, hidden, onSession, onClose, onFollow, onResolve,
}: Props) {
  const model = useMemo(() => new TreeModel(root), [root]);
  const initialRef = useRef(initial);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initial?.expanded?.length ? initial.expanded : [model.rootPath]),
  );
  const [query, setQuery] = useState(initial?.query ?? '');
  const [version, setVersion] = useState(0);
  const [cursor, setCursor] = useState(initial?.cursor ?? 0);
  const [scrollTop, setScrollTop] = useState(initial?.scrollTop ?? 0);
  const [viewportH, setViewportH] = useState(600);
  const [jump, setJump] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const didFocus = useRef(false);

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
    if (initialRef.current?.scrollTop) {
      el.scrollTop = initialRef.current.scrollTop;
      setScrollTop(el.scrollTop);
    }
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { hostRef.current?.focus(); }, []);

  // 跟随浮层期间让位：不卸载组件，滚动/展开/搜索状态原样保留；焦点交给浮层。
  useEffect(() => {
    if (hidden) hostRef.current?.blur();
    else if (didFocus.current || !focus) hostRef.current?.focus();
  }, [hidden, focus]);

  // 从节点卡的截断提示进来：把 index / addr 翻译成目标行，展开根容器后滚过去。
  useEffect(() => {
    if (didFocus.current || !focus) return;
    didFocus.current = true;
    // 明确的定位意图优先于上次残留的搜索词，否则目标行可能被过滤掉
    setQuery('');
    const index = focus.index ?? (focus.addr != null ? model.indexOfAddress(focus.addr) : undefined);
    if (index == null) {
      setNotice('截断处不在当前数据范围内，已停在根节点');
      return;
    }
    const r = model.locateIndex(index, model.rootPath);
    if (r.error || !r.path) { setNotice(r.error ?? '定位失败'); return; }
    setNotice(focus.label ?? `已跳到第 ${index} 项`);
    setExpanded((prev) => new Set(prev).add(model.rootPath));
    setVersion((v) => v + 1);
    setPendingPath(r.path);
  }, [focus, model]);

  // 换搜索词后结果整体变化，回到顶部并重置游标；首次挂载要保留恢复的滚动位置
  const lastQuery = useRef(query);
  useEffect(() => {
    if (query === lastQuery.current) return;
    lastQuery.current = query;
    setCursor(0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  // 退出时把展开路径、搜索词、游标与滚动位置交回父级缓存
  const latest = useRef({ expanded, query, cursor, scrollTop });
  latest.current = { expanded, query, cursor, scrollTop };
  const sessionSink = useRef(onSession);
  sessionSink.current = onSession;
  useEffect(() => () => {
    sessionSink.current?.({
      expanded: [...latest.current.expanded],
      query: latest.current.query,
      cursor: latest.current.cursor,
      scrollTop: latest.current.scrollTop,
    });
  }, []);

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

  const locateAddr = (addr: number) => {
    const path = findRowPathByAddr(rows, addr);
    if (!path) { setNotice(`0x${addr.toString(16)} 还没在当前树里展开`); return; }
    const index = rows.findIndex((r) => r.path === path);
    if (index >= 0) scrollToIndex(index);
    setNotice(`已定位 ${path}`);
  };

  const jumpTarget = () => {
    const row = rows[cursor];
    return row?.container ? row.path : model.defaultIndexPath();
  };

  const jumpToIndex = () => {
    const raw = jump.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { setNotice('下标必须是非负整数'); return; }
    const target = jumpTarget();
    const r = model.locateIndex(n, target);
    if (r.error || !r.path) { setNotice(r.error ?? '定位失败'); return; }
    setNotice(`已跳到 ${target}[${n}]`);
    setExpanded((prev) => new Set(prev).add(target));
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
    if (hidden) return;
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
        if (canJump) { e.preventDefault(); jumpRef.current?.focus(); }
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
  const canJump = model.hasContainer();
  const jumpPath = jumpTarget();
  const jumpLabel = rows.find((r) => r.path === jumpPath)?.label ?? root.type.name;

  return (
    <div
      className={`bp-tree-overlay${hidden ? ' hidden' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={hidden || undefined}
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
            {canJump && (
              <label className="bp-tree-jump">
                <input
                  ref={jumpRef}
                  className="in mono"
                  placeholder={`跳 ${jumpLabel} 下标（g）`}
                  title={`目标容器：${jumpPath}`}
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
                    {onResolve && (row.tone === 'element' || row.tone === 'instance') && root.pack.types[row.typeText] && (
                      <button
                        className="bp-tree-go"
                        title={`按 ${row.typeText} 在图上生成解析节点（结构树保持打开）`}
                        aria-label="生成解析节点"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          const ok = onResolve(row.addr, row.typeText, row.graphPort);
                          setNotice(ok
                            ? `已在图上生成 ${row.typeText} @${toHex(row.addr)} 的解析节点，Esc 返回节点图`
                            : '无法生成解析节点：地址、类型或数据源已不可用');
                        }}
                      >⊕</button>
                    )}
                    {row.ref && (
                      <>
                        <button
                          className="bp-tree-go"
                          title={`在树内定位 0x${row.ref.addr.toString(16)}`}
                          aria-label="在树内定位"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); locateAddr(row.ref!.addr); }}
                        >⌖</button>
                        <button
                          className="bp-tree-go"
                          title={`在图上解析 ${row.ref.hint}（选完回到结构树）`}
                          aria-label="在图上解析"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); onFollow(row.ref!.addr, row.ref!.hint, row.graphPort); }}
                        >↗</button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <footer className="bp-tree-foot mono">
          <span>↑↓ 移动 · Enter 展开 · ←→ 收起/展开{canJump ? ' · g 跳下标' : ''} · / 搜索 · Ctrl+C 复制路径 · ⌖ 树内定位 / ↗ 图上解析 / ⊕ 生成节点 · Esc 退出</span>
          <span className="bp-tree-notice">{notice}</span>
        </footer>
      </div>
    </div>
  );
}
