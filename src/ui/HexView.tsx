import { useMemo } from 'react';
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
}

const TONE_BG: Record<string, string> = {
  field: 'rgba(78,216,192,0.22)',
  hot: 'rgba(240,180,95,0.30)',
  warn: 'rgba(242,112,122,0.28)',
};

export default function HexView({
  mem, addr, len, highlight = [], maxRows = 64, onPickByte, onHoverAddr, compact, cols, focusAddr,
}: Props) {
  const width = cols ?? (compact ? 8 : 16);
  const rows = useMemo(() => {
    const start = Math.max(addr, mem.base);
    const stop = Math.min(addr + len, mem.end);
    if (stop <= start) return [];
    const aligned = start - ((start - mem.base) % width);
    const out: { addr: number; bytes: number[]; ascii: string }[] = [];
    for (let a = aligned; a < stop && out.length < maxRows; a += width) {
      const n = Math.min(width, mem.end - a);
      const bs: number[] = [];
      let asc = '';
      for (let i = 0; i < n; i++) {
        const b = mem.buf[a - mem.base + i];
        bs.push(b);
        asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      }
      out.push({ addr: a, bytes: bs, ascii: asc });
    }
    return out;
  }, [mem, addr, len, maxRows]);

  if (!rows.length) return <div className="hex-empty">没有可显示的字节</div>;

  const inHl = (a: number) => highlight.find((h) => a >= h.start && a < h.end);
  const isFocus = (a: number) => focusAddr != null && a === focusAddr;

  return (
    <div className={`hexview${compact ? ' compact' : ''}`} onMouseLeave={() => onHoverAddr?.(null)}>
      <div className="hex-head">
        <span>addr</span>
        <span>
          {Array.from({ length: width }, (_, i) => i.toString(16).padStart(2, '0')).join(' ')}
        </span>
        <span>ascii</span>
      </div>
      <div className="hex-body">
        {rows.map((r) => (
          <div className={`hex-row${focusAddr != null && focusAddr >= r.addr && focusAddr < r.addr + width ? ' focus' : ''}`} key={r.addr}>
            <span className="hex-addr">{r.addr.toString(16).toUpperCase().padStart(8, '0')}</span>
            <span className="hex-bytes">
              {r.bytes.map((b, i) => {
                const a = r.addr + i;
                const h = inHl(a);
                const focused = isFocus(a);
                return (
                  <span
                    key={i}
                    className={`hb${h ? ' hl' : ''}${focused ? ' sel' : ''}${i === width / 2 - 1 ? ' gap' : ''}`}
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
              {r.ascii.split('').map((c, i) => {
                const h = inHl(r.addr + i);
                return (
                  <span key={i} className={h ? 'hl' : ''} style={h ? { background: TONE_BG[h.tone ?? 'field'], color: '#EAF6F3' } : undefined}>
                    {c}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
