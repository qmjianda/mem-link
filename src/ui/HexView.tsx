import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Memory } from '../core/mem';

export interface HexHighlight {
  start: number;
  end: number;
  tone?: 'field' | 'hot' | 'warn';
}

interface Props {
  mem: Memory;
  addr: number;
  len: number;
  highlight?: HexHighlight[];
  maxRows?: number;
  onPickByte?: (addr: number) => void;
  onHoverAddr?: (addr: number | null) => void;
  compact?: boolean;
  cols?: 8 | 16;
  /** 在缓冲区中点选 / 跳转到的字节：强调显示，便于确认位置 */
  focusAddr?: number | null;
  /** 首次渲染后滚动到该地址（跳转、字段锁定、从结构体跳入） */
  revealAddr?: number | null;
  /** 地址没变但需要再次滚动时递增（重复「跳转」） */
  revealTick?: number;
  /** 虚拟滚动：len 覆盖整个窗口，只渲染可见行；高度由 CSS / height 决定 */
  virtual?: boolean;
  height?: number | string;
  /** 首次挂载时的顶部字节偏移（展开缓冲区时保持阅读位置） */
  initialTop?: number;
  /** 滚动后视口顶部的字节地址（虚拟模式） */
  onViewAddr?: (addr: number) => void;
  /** For file-relative views, render exact absolute addresses without changing byte indexes. */
  displayBase?: bigint;
}

const TONE_BG: Record<string, string> = {
  field: 'rgba(78,216,192,0.22)',
  hot: 'rgba(240,180,95,0.30)',
  warn: 'rgba(242,112,122,0.28)',
};

/** 与 styles.css 的 --hex-row-h / --hex-head-h 保持一致 */
const ROW_H = 18;
const COMPACT_ROW_H = 17;
const HEAD_H = 22;
const OVERSCAN = 6;

export default function HexView({
  mem, addr, len, highlight = [], maxRows = 64, onPickByte, onHoverAddr, compact, cols,
  focusAddr, revealAddr, revealTick = 0, virtual, height, initialTop, onViewAddr, displayBase,
}: Props) {
  const width = cols ?? (compact ? 8 : 16);
  const rowH = compact ? COMPACT_ROW_H : ROW_H;

  const start = Math.max(addr, mem.base);
  const stop = Math.min(addr + len, mem.end);
  const aligned = start - ((start - mem.base) % width);
  const availableRows = stop > aligned ? Math.ceil((stop - aligned) / width) : 0;
  const totalRows = virtual ? availableRows : Math.min(availableRows, maxRows);

  const scrollRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const latestTop = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(320);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !virtual) return;
    const measure = () => setViewportH(el.clientHeight || 320);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtual]);

  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // 换了缓冲区：行号与滚动位置都从顶部重新开始（首次挂载交给 initialTop）
  const didMem = useRef(false);
  useEffect(() => {
    if (!virtual) return;
    if (!didMem.current) { didMem.current = true; return; }
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    latestTop.current = 0;
    setScrollTop(0);
  }, [mem, virtual]);

  // 展开面板会重建这个组件：按调用方给的顶部偏移恢复阅读位置
  const didInitTop = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!virtual || didInitTop.current || initialTop == null || !el) return;
    didInitTop.current = true;
    if (initialTop <= 0) { el.scrollTop = 0; return; }
    const index = Math.max(0, Math.floor(initialTop / width));
    el.scrollTop = HEAD_H + index * rowH;
  }, [virtual, initialTop, width, rowH]);

  // 跳转 / 从结构体进入 / 重复跳转：把目标行滚到视口中间
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !virtual || revealAddr == null) return;
    if (revealAddr < aligned || revealAddr >= aligned + totalRows * width) return;
    const index = Math.floor((revealAddr - aligned) / width);
    const top = HEAD_H + index * rowH;
    const viewH = el.clientHeight || viewportH;
    if (top < el.scrollTop + HEAD_H || top + rowH > el.scrollTop + viewH) {
      el.scrollTop = Math.max(0, top - Math.max(HEAD_H, (viewH - HEAD_H) / 2));
    }
  }, [revealAddr, revealTick, virtual, aligned, width, totalRows, rowH, viewportH]);

  const makeRow = (index: number) => {
    const a = aligned + index * width;
    const n = Math.max(0, Math.min(width, mem.end - a, stop - a));
    const bs: number[] = [];
    let asc = '';
    for (let i = 0; i < n; i++) {
      const b = mem.buf[a - mem.base + i];
      bs.push(b);
      asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    }
    return { addr: a, bytes: bs, ascii: asc };
  };

  const previewRows = useMemo(
    () => (virtual ? [] : Array.from({ length: totalRows }, (_, i) => makeRow(i))),
    // makeRow 只依赖这些输入；virtual 分支不构建整表
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [virtual, totalRows, aligned, width, mem, stop],
  );

  const bodyH = totalRows * rowH;
  const first = virtual
    ? Math.max(0, Math.floor((scrollTop - HEAD_H) / rowH) - OVERSCAN)
    : 0;
  const last = virtual
    ? Math.min(totalRows, first + Math.ceil((viewportH - HEAD_H) / rowH) + OVERSCAN * 2)
    : totalRows;
  const windowRows = virtual ? Array.from({ length: Math.max(0, last - first) }, (_, i) => makeRow(first + i)) : previewRows;

  const topAddr = aligned + Math.max(0, Math.floor((scrollTop - HEAD_H) / rowH)) * width;
  useEffect(() => {
    if (virtual) onViewAddr?.(topAddr);
  }, [virtual, topAddr, onViewAddr]);

  if (!totalRows) return <div className="hex-empty">没有可显示的字节</div>;

  const inHl = (a: number) => highlight.find((h) => a >= h.start && a < h.end);
  const isFocus = (a: number) => focusAddr != null && a === focusAddr;
  const showGap = width === 16;

  const row = (r: { addr: number; bytes: number[]; ascii: string }, i: number) => (
    <div
      className={`hex-row${focusAddr != null && focusAddr >= r.addr && focusAddr < r.addr + width ? ' focus' : ''}`}
      key={r.addr}
      style={virtual ? { top: (first + i) * rowH, height: rowH, lineHeight: `${rowH}px` } : undefined}
    >
      <span className="hex-addr">{(displayBase === undefined ? r.addr : displayBase + BigInt(r.addr - mem.base)).toString(16).toUpperCase().padStart(8, '0')}</span>
      <span className="hex-bytes">
        {r.bytes.map((b, j) => {
          const a = r.addr + j;
          const h = inHl(a);
          const focused = isFocus(a);
          return (
            <span
              key={j}
              data-addr={a}
              className={`hb${h ? ' hl' : ''}${focused ? ' sel' : ''}${showGap && j === width / 2 - 1 ? ' gap' : ''}`}
              style={h ? { background: TONE_BG[h.tone ?? 'field'] } : undefined}
              onClick={() => onPickByte?.(a)}
              onMouseEnter={() => onHoverAddr?.(a)}
            >
              {b.toString(16).padStart(2, '0')}
            </span>
          );
        })}
      </span>
      <span className="hex-ascii">
        {r.ascii.split('').map((c, j) => {
          const h = inHl(r.addr + j);
          return (
            <span key={j} className={h ? 'hl' : ''} style={h ? { background: TONE_BG[h.tone ?? 'field'], color: '#EAF6F3' } : undefined}>
              {c}
            </span>
          );
        })}
      </span>
    </div>
  );

  return (
    <div
      className={`hexview${compact ? ' compact' : ''}${virtual ? ' virtual' : ''}`}
      ref={scrollRef}
      style={virtual && height !== undefined ? { height } : undefined}
      tabIndex={virtual ? 0 : undefined}
      role={virtual ? 'region' : undefined}
      aria-label={virtual ? '缓冲区' : undefined}
      onMouseLeave={() => onHoverAddr?.(null)}
      onScroll={virtual ? (e) => {
        latestTop.current = e.currentTarget.scrollTop;
        // 触控板会连发；每帧只提交一次可见窗口
        if (!frame.current) {
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            setScrollTop(latestTop.current);
          });
        }
      } : undefined}
      onKeyDown={virtual ? (e) => {
        const el = e.currentTarget;
        if (e.key === 'Home') { e.preventDefault(); el.scrollTop = 0; }
        if (e.key === 'End') { e.preventDefault(); el.scrollTop = el.scrollHeight; }
      } : undefined}
    >
      <div className="hex-head">
        <span>addr</span>
        <span>
          {Array.from({ length: width }, (_, i) => i.toString(16).padStart(2, '0')).join(' ')}
        </span>
        <span>ascii</span>
      </div>
      <div className="hex-body" style={virtual ? { position: 'relative', height: bodyH } : undefined}>
        {windowRows.map(row)}
      </div>
    </div>
  );
}
