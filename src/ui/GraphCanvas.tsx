import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode, GraphResult, Problem, RecordDecl, Schema } from '../core/types';
import { NODE_HEADER_H, NODE_ROW_H, NODE_W, NODE_MAX_ROWS } from '../core/types';

export type Selection = { kind: 'node'; key: string } | { kind: 'edge'; id: string } | null;

interface Props {
  schema: Schema;
  graph: GraphResult;
  positions: Map<string, { x: number; y: number }>;
  onPosition: (key: string, x: number, y: number) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  emptyState?: React.ReactNode;
  hexValues?: boolean;
}

interface View { x: number; y: number; k: number }

const MIN_K = 0.12;
const MAX_K = 2.4;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

const EDGE_COLOR: Record<GraphEdge['kind'], string> = {
  link: '#4ED8C0',
  cycle: '#F0B45F',
  null: '#5D6B80',
  broken: '#F2707A',
};

function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function wrapText(s: string, max: number, maxLines: number): string[] {
  const words = s.split(/(\s+)/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + w).length > max) {
      if (cur) lines.push(cur);
      cur = w.trimStart();
    } else cur += w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

interface XY { x: number; y: number }

function rowY(n: XY, index: number): number {
  return n.y + NODE_HEADER_H + index * NODE_ROW_H + NODE_ROW_H / 2;
}

function cubicAt(p0: XY, p1: XY, p2: XY, p3: XY, t: number): XY {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export default function GraphCanvas({
  schema, graph, positions, onPosition, selection, onSelect, emptyState, hexValues,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 0, k: 0.9 });
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const didFit = useRef(false);

  const pos = useMemo(() => {
    const m = new Map<string, XY>();
    for (const n of graph.nodes) m.set(n.key, positions.get(n.key) ?? { x: n.x, y: n.y });
    return m;
  }, [graph.nodes, positions]);

  const nodeByKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph.nodes]);

  const problemsByNode = useMemo(() => {
    const m = new Map<string, Problem[]>();
    for (const p of graph.problems) {
      if (!p.nodeKey) continue;
      const arr = m.get(p.nodeKey) ?? [];
      arr.push(p);
      m.set(p.nodeKey, arr);
    }
    return m;
  }, [graph.problems]);

  const selectedNode = selection?.kind === 'node' ? selection.key : null;
  const selectedEdge = selection?.kind === 'edge' ? selection.id : null;

  const related = useMemo(() => {
    if (!selectedNode) return null;
    const s = new Set<string>([selectedNode]);
    for (const e of graph.edges) {
      if (e.from === selectedNode) s.add(e.to);
      if (e.to === selectedNode) s.add(e.from);
    }
    return s;
  }, [selectedNode, graph.edges]);

  /* ------------------------------------------------------------- sizing */
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const bounds = useCallback(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      const p = pos.get(n.key) ?? { x: n.x, y: n.y };
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + n.height);
    }
    return { minX, minY, maxX, maxY };
  }, [graph.nodes, pos]);

  const fit = useCallback(() => {
    if (!graph.nodes.length) return;
    const { minX, minY, maxX, maxY } = bounds();
    const pad = 40;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = clamp(Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh, 1.1), MIN_K, MAX_K);
    setView({
      k,
      x: (size.w - bw * k) / 2 - minX * k,
      y: (size.h - bh * k) / 2 - minY * k,
    });
  }, [graph.nodes, bounds, size.w, size.h]);

  // First paint: fit small graphs; for deep chains start readable at the roots
  // instead of shrinking every card into an illegible thumbnail.
  useEffect(() => {
    if (didFit.current || !graph.nodes.length || size.w <= 100) return;
    didFit.current = true;
    const { minX, minY, maxX, maxY } = bounds();
    const pad = 40;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh, 1.1);
    if (k >= 0.78) { fit(); return; }
    setView({ k: 0.92, x: 28 - minX * 0.92, y: 30 - minY * 0.92 });
  }, [graph.nodes.length, size.w, bounds, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const px = cx ?? size.w / 2;
      const py = cy ?? size.h / 2;
      const s = k / v.k;
      return { k, x: px - (px - v.x) * s, y: py - (py - v.y) * s };
    });
  }, [size.w, size.h]);

  /* --------------------------------------------------------------- wheel */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /* --------------------------------------------------------------- drags */
  const drag = useRef<
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { type: 'node'; key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | null
  >(null);

  const toLocal = (e: React.PointerEvent | PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toLocal(e);
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { type: 'pan', sx: p.x, sy: p.y, ox: view.x, oy: view.y };
    onSelect(null);
  };

  const onNodePointerDown = (e: React.PointerEvent, n: GraphNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect({ kind: 'node', key: n.key });
    const p = toLocal(e);
    const cur = pos.get(n.key) ?? { x: n.x, y: n.y };
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { type: 'node', key: n.key, sx: p.x, sy: p.y, ox: cur.x, oy: cur.y, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toLocal(e);
    if (d.type === 'pan') {
      setView((v) => ({ ...v, x: d.ox + (p.x - d.sx), y: d.oy + (p.y - d.sy) }));
    } else {
      const dx = (p.x - d.sx) / view.k;
      const dy = (p.y - d.sy) / view.k;
      if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
      onPosition(d.key, d.ox + dx, d.oy + dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    if (d?.type === 'node' && !d.moved) onSelect({ kind: 'node', key: d.key });
  };

  /* -------------------------------------------------------------- render */
  const recOf = (n: GraphNode): RecordDecl | undefined => schema.records[n.type];
  const rowsOf = (rec: RecordDecl | undefined) => (rec ? rec.fields.slice(0, NODE_MAX_ROWS) : []);
  const fieldIndex = (rec: RecordDecl | undefined, fieldId: string) =>
    rec ? rec.fields.findIndex((f) => f.id === fieldId) : -1;

  const edgePaths = graph.edges.filter((e) => e.to).map((e) => {
    const s = nodeByKey.get(e.from);
    const t = nodeByKey.get(e.to);
    if (!s || !t) return null;
    const sp = pos.get(s.key)!;
    const tp = pos.get(t.key)!;
    const rec = recOf(s);
    const idx = fieldIndex(rec, e.fieldId);
    const sy = rowY(sp, Math.max(0, Math.min(idx, rowsOf(rec).length - 1)));
    const ty = tp.y + NODE_HEADER_H / 2;
    const self = s.key === t.key;
    const back = tp.x < sp.x - 10;

    let d = '';
    let lx = 0, ly = 0;
    if (self) {
      const sx = sp.x + NODE_W * 0.42;
      const ex = sp.x + NODE_W * 0.62;
      d = `M ${sx} ${sy} C ${sx} ${sy - 64}, ${ex} ${sy - 64}, ${ex} ${sp.y + 4}`;
      lx = (sx + ex) / 2; ly = sy - 44;
    } else if (back) {
      const sx = sp.x;
      const ex = tp.x + NODE_W;
      const dist = Math.max(70, Math.min(190, (sx - ex) * 0.25 + 70));
      d = `M ${sx} ${sy} C ${sx - dist} ${sy}, ${ex + dist} ${ty}, ${ex} ${ty}`;
      const p = cubicAt({ x: sx, y: sy }, { x: sx - dist, y: sy }, { x: ex + dist, y: ty }, { x: ex, y: ty }, 0.5);
      lx = p.x; ly = p.y;
    } else {
      const sx = sp.x + NODE_W;
      const ex = tp.x;
      const dist = Math.max(52, Math.min(180, Math.abs(ex - sx) * 0.5));
      d = `M ${sx} ${sy} C ${sx + dist} ${sy}, ${ex - dist} ${ty}, ${ex} ${ty}`;
      const p = cubicAt({ x: sx, y: sy }, { x: sx + dist, y: sy }, { x: ex - dist, y: ty }, { x: ex, y: ty }, 0.5);
      lx = p.x; ly = p.y;
    }
    const strong = selectedEdge === e.id
      || (selectedNode != null && (e.from === selectedNode || e.to === selectedNode));
    return { e, d, lx, ly, strong };
  }).filter(Boolean) as { e: GraphEdge; d: string; lx: number; ly: number; strong: boolean }[];

  const nullMarks = graph.edges.filter((e) => e.kind === 'null').map((e) => {
    const s = nodeByKey.get(e.from);
    if (!s) return null;
    const sp = pos.get(s.key)!;
    const rec = recOf(s);
    const idx = Math.max(0, fieldIndex(rec, e.fieldId));
    return { e, x: sp.x + NODE_W - 6, y: rowY(sp, idx) };
  }).filter(Boolean) as { e: GraphEdge; x: number; y: number }[];

  const isEmpty = graph.nodes.length === 0;

  return (
    <div className="canvas-host" ref={hostRef}>
      <svg
        ref={svgRef}
        className="canvas"
        width="100%"
        height="100%"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <radialGradient id="bgGlow" cx="32%" cy="8%" r="80%">
            <stop offset="0%" stopColor="#123029" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#0A0D12" stopOpacity="0" />
          </radialGradient>
          <pattern
            id="dotGrid"
            width={24 * view.k}
            height={24 * view.k}
            patternUnits="userSpaceOnUse"
            x={view.x % (24 * view.k)}
            y={view.y % (24 * view.k)}
          >
            <circle cx={1} cy={1} r={0.9} fill="#26313E" />
          </pattern>
          <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="#000" floodOpacity="0.45" />
          </filter>
          <filter id="selGlow" x="-40%" y="-40%" width="180%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#4ED8C0" floodOpacity="0.35" />
          </filter>
          {(['link', 'cycle', 'broken'] as const).map((k) => (
            <marker
              key={k} id={`arw-${k}`} viewBox="0 0 10 10" refX="8.5" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill={EDGE_COLOR[k]} />
            </marker>
          ))}
        </defs>

        <rect width="100%" height="100%" fill="#0A0D12" />
        <rect width="100%" height="100%" fill="url(#bgGlow)" />
        <rect width="100%" height="100%" fill="url(#dotGrid)" />

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* edges under nodes */}
          <g className="edges">
            {edgePaths.map(({ e, d, lx, ly, strong }) => {
              const dim = selectedNode != null && !strong;
              const color = EDGE_COLOR[e.kind];
              return (
                <g key={e.id} opacity={dim ? 0.16 : 1}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={strong ? 2 : 1.3}
                    strokeOpacity={strong ? 0.95 : 0.55}
                    strokeDasharray={e.kind === 'cycle' ? '5 4' : e.kind === 'broken' ? '3 3' : undefined}
                    markerEnd={`url(#arw-${e.kind === 'null' ? 'link' : e.kind})`}
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(ev) => { ev.stopPropagation(); onSelect({ kind: 'edge', id: e.id }); }}
                  />
                  <g transform={`translate(${lx},${ly})`} pointerEvents="none">
                    <rect
                      x={-1} y={-9}
                      width={`${Math.max(38, (e.label.length + 6) * 6.1)}`}
                      height={18} rx={9}
                      fill="#0B1219" stroke={color} strokeOpacity={strong ? 0.8 : 0.3}
                    />
                    <text x={8} y={3.5} fontSize={10} fontFamily="var(--mono)" fill={color} fillOpacity={strong ? 1 : 0.8}>
                      {e.label} {e.kind === 'null' ? '∅' : e.value != null ? e.value : ''}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>

          {/* nodes (selected last so it floats above overlaps) */}
          {[...graph.nodes].sort((a, b) => Number(a.key === selectedNode) - Number(b.key === selectedNode)).map((n) => {
            const p = pos.get(n.key)!;
            const rec = recOf(n);
            const rows = rowsOf(rec);
            const isSel = selectedNode === n.key;
            const isHover = hoverNode === n.key;
            const dim = related != null && !related.has(n.key);
            const probs = problemsByNode.get(n.key) ?? [];
            const height = n.ghost ? NODE_HEADER_H + 62 : NODE_HEADER_H + rows.length * NODE_ROW_H + 8;
            const extra = rec && rec.fields.length > NODE_MAX_ROWS ? rec.fields.length - NODE_MAX_ROWS : 0;

            return (
              <g
                key={n.key}
                data-node={n.key}
                transform={`translate(${p.x},${p.y})`}
                opacity={dim ? 0.4 : n.ghost ? 0.92 : 1}
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerEnter={() => setHoverNode(n.key)}
                onPointerLeave={() => setHoverNode(null)}
                filter={isSel ? 'url(#selGlow)' : 'url(#nodeShadow)'}
              >
                <rect
                  width={NODE_W} height={height} rx={9}
                  fill={n.ghost ? '#1A1114' : '#111823'}
                  stroke={isSel ? '#4ED8C0' : probs.some((x) => x.severity === 'error') ? '#6E2F35' : isHover ? '#3A4B60' : '#243040'}
                  strokeWidth={isSel ? 1.6 : 1}
                  strokeDasharray={n.ghost ? '6 4' : undefined}
                />
                {n.ghost && (
                  <rect width={NODE_W} height={height} rx={9} fill="#F2707A" fillOpacity={0.04} />
                )}

                {/* header */}
                <text x={12} y={22} fontSize={12.5} fontWeight={600} fill={n.ghost ? '#F2A0A7' : '#E4ECF7'} fontFamily="var(--sans)">
                  {ellipsis(n.type, 22)}
                </text>
                <text x={NODE_W - 12} y={22} fontSize={10.5} textAnchor="end" fill="#7D8EA4" fontFamily="var(--mono)">
                  0x{n.addr.toString(16).toUpperCase()}
                </text>
                <line x1={0} y1={NODE_HEADER_H} x2={NODE_W} y2={NODE_HEADER_H} stroke="#1E2939" />
                {(n.pinned || positions.has(n.key)) && (
                  <g transform={`translate(${NODE_W - 9},${NODE_HEADER_H - 1})`} opacity={0.7}>
                    <circle r={2.6} fill="#4ED8C0" />
                  </g>
                )}
                {probs.length > 0 && (
                  <g transform={`translate(${NODE_W - 22},${NODE_HEADER_H - 1})`}>
                    <circle r={3} fill="#F2707A" />
                  </g>
                )}

                {n.ghost ? (
                  <g>
                    <text x={12} y={NODE_HEADER_H + 20} fontSize={10.5} fill="#C98B92" fontFamily="var(--sans)">
                      未映射的内存
                    </text>
                    {wrapText(n.ghostReason ?? '无法读取该地址', 44, 2).map((line, i) => (
                      <text key={i} x={12} y={NODE_HEADER_H + 38 + i * 14} fontSize={9.5} fill="#8E6A70" fontFamily="var(--mono)">
                        {line}
                      </text>
                    ))}
                  </g>
                ) : (
                  rows.map((f, i) => {
                    const y = NODE_HEADER_H + i * NODE_ROW_H;
                    const rowId = `${n.key}:${f.id}`;
                    const isLink = n.links.some((l) => l.fieldId === f.id);
                    const hot = hoverRow === rowId;
                    const raw = n.values[f.id];
                    let value = n.display[f.id] ?? '—';
                    if (hexValues && typeof raw === 'number' && f.type.k !== 'float') {
                      value = raw < 0 ? `-0x${Math.abs(raw).toString(16).toUpperCase()}` : `0x${raw.toString(16).toUpperCase()}`;
                    }
                    return (
                      <g
                        key={f.id}
                        onPointerEnter={() => setHoverRow(rowId)}
                        onPointerLeave={() => setHoverRow(null)}
                      >
                        {hot && <rect x={1} y={y} width={NODE_W - 2} height={NODE_ROW_H} fill="#FFFFFF" fillOpacity={0.035} />}
                        <circle cx={11} cy={y + NODE_ROW_H / 2} r={2} fill={isLink ? '#4ED8C0' : '#2C3A4C'} />
                        <text x={20} y={y + 14.5} fontSize={10.5} fill={isLink ? '#9FE6D8' : '#93A3B8'} fontFamily="var(--sans)">
                          {ellipsis((f.derived ? 'ƒ ' : '') + (f.name || `<pad${i}>`), 17)}
                        </text>
                        <text
                          x={NODE_W - 12} y={y + 14.5} fontSize={11}
                          textAnchor="end" fill={isLink ? '#7FE3D2' : '#D5E0EE'}
                          fontFamily="var(--mono)"
                        >
                          {ellipsis(value, 20)}
                          <title>{`${f.name || 'pad'} = ${value}${typeof raw === 'number' ? ` (0x${Math.abs(raw).toString(16).toUpperCase()} · ${raw} · +${f.offset})` : ''}`}</title>
                        </text>
                      </g>
                    );
                  })
                )}

                {!n.ghost && extra > 0 && (
                  <text x={12} y={height - 6} fontSize={9.5} fill="#6C7C92" fontFamily="var(--sans)">
                    +{extra} 个字段
                  </text>
                )}
              </g>
            );
          })}

          {/* null markers */}
          {nullMarks.map(({ e, x, y }) => (
            <g key={e.id} transform={`translate(${x},${y})`} pointerEvents="none">
              <circle cx={-16} cy={0} r={8} fill="#0B1219" stroke={EDGE_COLOR.null} strokeOpacity={0.6} />
              <text x={-16} y={3.5} fontSize={9} textAnchor="middle" fill="#8B9AAE" fontFamily="var(--mono)">∅</text>
            </g>
          ))}
        </g>
      </svg>

      {isEmpty && <div className="canvas-empty">{emptyState}</div>}

      <div className="canvas-legend">
        <span><i style={{ background: EDGE_COLOR.link }} />link</span>
        <span><i style={{ background: EDGE_COLOR.cycle }} />cycle</span>
        <span><i style={{ background: EDGE_COLOR.broken }} />broken</span>
        <span className="dim">拖动画布平移 · 滚轮缩放 · 拖动节点钉住</span>
      </div>

      <div className="zoom-hud">
        <button onClick={() => zoomAt(1 / 1.2)} title="缩小">−</button>
        <span>{Math.round(view.k * 100)}%</span>
        <button onClick={() => zoomAt(1.2)} title="放大">+</button>
        <button className="wide" onClick={fit} title="适配视图">适配</button>
      </div>

      {graph.truncated && (
        <div className="canvas-warn">图已截断：节点数超过上限，仅展示前 {graph.nodes.length} 个</div>
      )}
    </div>
  );
}
