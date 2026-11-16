/**
 * 小地图：全部节点的包围盒缩略 + 当前视口矩形；点击/拖动定位视口。
 *
 * 用独立 `<canvas>` 绘制（200 节点也只有一次 fillRect 循环），并在 rAF 里
 * 合并重绘；数据用**全量** nodes/metas，不受主画布裁剪影响。
 */

import { useEffect, useMemo, useRef } from 'react';
import type { BPNode } from './types';
import { boundsOf, type Viewport } from './viewport';

const MAP_W = 180;
const MAP_H = 120;
/** 画布内边距 */
const PAD = 6;

interface Props {
  nodes: BPNode[];
  metas: Map<string, { w: number; h: number }>;
  view: Viewport;
  /** 主画布尺寸，用来画视口矩形 */
  size: { w: number; h: number };
  /** 把视口中心移到这个世界坐标 */
  onNavigate: (center: { x: number; y: number }) => void;
  collapsed: boolean;
  onToggle: () => void;
}

interface Scale {
  k: number;
  ox: number;
  oy: number;
}

/** 世界 → 小地图坐标的映射（含视口矩形，保证它始终在画面内） */
function planScale(
  bounds: { x: number; y: number; w: number; h: number },
  view: Viewport,
  size: { w: number; h: number },
): Scale {
  const viewX = -view.x / Math.max(0.0001, view.k);
  const viewY = -view.y / Math.max(0.0001, view.k);
  const viewW = size.w / Math.max(0.0001, view.k);
  const viewH = size.h / Math.max(0.0001, view.k);
  const x0 = Math.min(bounds.x, viewX);
  const y0 = Math.min(bounds.y, viewY);
  const x1 = Math.max(bounds.x + bounds.w, viewX + viewW);
  const y1 = Math.max(bounds.y + bounds.h, viewY + viewH);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const k = Math.min((MAP_W - PAD * 2) / w, (MAP_H - PAD * 2) / h);
  return {
    k,
    ox: PAD + ((MAP_W - PAD * 2) - w * k) / 2 - x0 * k,
    oy: PAD + ((MAP_H - PAD * 2) - h * k) / 2 - y0 * k,
  };
}

export default function Minimap({
  nodes, metas, view, size, onNavigate, collapsed, onToggle,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<Scale>({ k: 1, ox: 0, oy: 0 });

  const bounds = useMemo(
    () => boundsOf(nodes.map((n) => n.id), nodes, metas) ?? { x: 0, y: 0, w: 800, h: 600 },
    [nodes, metas],
  );

  // rAF 合并重绘：一次状态变化最多画一帧
  useEffect(() => {
    if (collapsed) return;
    const id = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(MAP_W * dpr)) {
        canvas.width = Math.round(MAP_W * dpr);
        canvas.height = Math.round(MAP_H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MAP_W, MAP_H);

      const s = planScale(bounds, view, size.w && size.h ? size : { w: 900, h: 600 });
      scaleRef.current = s;

      // 节点缩略块
      ctx.fillStyle = 'rgba(120, 160, 200, 0.55)';
      for (const n of nodes) {
        const m = metas.get(n.id);
        if (!m) continue;
        const w = Math.max(1.5, m.w * s.k);
        const h = Math.max(1.2, m.h * s.k);
        ctx.fillRect(s.ox + n.x * s.k, s.oy + n.y * s.k, w, h);
      }

      // 当前视口矩形
      const vk = Math.max(0.0001, view.k);
      ctx.strokeStyle = 'rgba(78, 216, 192, 0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        s.ox + (-view.x / vk) * s.k,
        s.oy + (-view.y / vk) * s.k,
        (size.w / vk) * s.k,
        (size.h / vk) * s.k,
      );
    });
    return () => cancelAnimationFrame(id);
  }, [collapsed, bounds, nodes, metas, view, size]);

  // 拖动期在 window 上监听（指针离开小地图也要继续跟随）
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachRef.current?.(), []);

  const navigateTo = (clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    const s = scaleRef.current;
    const wx = (clientX - r.left - s.ox) / s.k;
    const wy = (clientY - r.top - s.oy) / s.k;
    onNavigate({ x: wx, y: wy });
  };

  const beginDrag = (clientX: number, clientY: number) => {
    navigateTo(clientX, clientY);
    detachRef.current?.();
    const move = (ev: PointerEvent) => navigateTo(ev.clientX, ev.clientY);
    const up = () => detachRef.current?.();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    detachRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      detachRef.current = null;
    };
  };

  if (collapsed) {
    return (
      <div className="bp-minimap collapsed">
        <button className="bp-minimap-toggle" aria-label="展开小地图" title="展开小地图" onClick={onToggle}>▣</button>
      </div>
    );
  }

  return (
    <div className="bp-minimap" ref={hostRef}>
      <button className="bp-minimap-toggle" aria-label="折叠小地图" title="折叠小地图" onClick={onToggle}>▣</button>
      <canvas
        ref={canvasRef}
        className="bp-minimap-canvas"
        style={{ width: MAP_W, height: MAP_H }}
        role="img"
        aria-label="小地图：全部节点缩略与当前视口"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          beginDrag(e.clientX, e.clientY);
        }}
      />
    </div>
  );
}
