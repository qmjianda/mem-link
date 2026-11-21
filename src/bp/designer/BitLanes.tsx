import { useEffect, useMemo, useRef, useState } from 'react';
import { useDesigner } from './context';
import { bitAtPoint, bitGeometry, bitRect, bitTicks } from './geometry';
import type { LayoutBitGroup } from '../layouts';

interface BitDrag {
  kind: 'move' | 'resize-left' | 'resize-right';
  id: string;
  group: LayoutBitGroup;
  startBit: number;
  startWidth: number;
  grab: number;
  lane: HTMLElement;
  moved: boolean;
}

interface Preview {
  group: LayoutBitGroup;
  bit: number;
  width: number;
  conflicts: string[];
}

function laneWidth(group: LayoutBitGroup): number {
  return Math.max(460, Math.min(1200, group.unit * 8 * 20));
}

function byteLabel(offset: number): string {
  return '0x' + offset.toString(16).padStart(2, '0');
}

export default function BitLanes() {
  const { state, actions } = useDesigner();
  const { build, selection, bitOrder } = state;
  const dragRef = useRef<BitDrag | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cancel = () => {
      if (!dragRef.current) return false;
      dragRef.current = null;
      setPreview(null);
      return true;
    };
    actions.registerGestureCancel(cancel);
    return () => actions.registerGestureCancel(null);
  }, [actions]);

  const groups = build?.bitGroups ?? [];
  const otherFields = useMemo(
    () => (build?.fields ?? []).filter(f => f.kind !== 'bits'),
    [build],
  );

  const previewConflicts = (group: LayoutBitGroup, id: string, bit: number, width: number): string[] =>
    group.members
      .filter(m => m.id !== id)
      .filter(m => {
        const other = m.bits?.offset ?? 0;
        const otherWidth = m.bits?.width ?? 1;
        return bit < other + otherWidth && other < bit + width;
      })
      .map(m => m.name);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = selection.kind === 'bitsGroup'
      ? root.querySelector<HTMLElement>(`[data-bit-track="${selection.key}"]`)?.closest('.bp-dz-bit-group')
      : selection.kind === 'fields'
        ? root.querySelector<HTMLElement>(`[data-bit-id="${selection.primary}"]`)
        : null;
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection, build]);

  const start = (e: React.PointerEvent<HTMLDivElement>, group: LayoutBitGroup) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const bar = target.closest('[data-bit-id]') as HTMLElement | null;
    if (!bar) { actions.selectGroup(group.key); return; }
    const id = bar.dataset.bitId!;
    const member = group.members.find(m => m.id === id);
    const track = bar.closest('[data-bit-track]') as HTMLElement | null;
    if (!member || !track) return;
    e.preventDefault();
    actions.selectFields([id], id);
    const geo = bitGeometry(group.unit, track.getBoundingClientRect().width, bitOrder);
    const at = bitAtPoint(e.clientX - track.getBoundingClientRect().left, geo);
    const edge = target.closest('[data-bedge]')?.getAttribute('data-bedge');
    const bit = member.bits?.offset ?? 0;
    const width = member.bits?.width ?? 1;
    // In MSB-first lanes the visual left edge is the high bit (end), so the
    // resize modes must swap relative to the LSB-first layout.
    const kind = edge === 'left'
      ? (bitOrder === 'msb' ? 'resize-right' : 'resize-left')
      : edge === 'right'
        ? (bitOrder === 'msb' ? 'resize-left' : 'resize-right')
        : 'move';
    dragRef.current = {
      kind,
      id, group, startBit: bit, startWidth: width,
      grab: Math.max(0, Math.min(width - 1, at - bit)),
      lane: track, moved: false,
    };
    track.setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = d.lane.getBoundingClientRect();
    const geo = bitGeometry(d.group.unit, rect.width, bitOrder);
    const at = bitAtPoint(e.clientX - rect.left, geo);
    if (d.kind === 'move') {
      const bit = Math.max(0, Math.min(d.group.unit * 8 - d.startWidth, at - d.grab));
      d.moved = Math.abs(e.clientX - rect.left) > 2 ? bit !== d.startBit : d.moved;
      setPreview({ group: d.group, bit, width: d.startWidth, conflicts: previewConflicts(d.group, d.id, bit, d.startWidth) });
    } else if (d.kind === 'resize-left') {
      const end = d.startBit + d.startWidth;
      const bit = Math.max(0, Math.min(end - 1, at));
      d.moved = bit !== d.startBit ? true : d.moved;
      setPreview({ group: d.group, bit, width: end - bit, conflicts: previewConflicts(d.group, d.id, bit, end - bit) });
    } else {
      const width = Math.max(1, Math.min(d.group.unit * 8 - d.startBit, at + 1 - d.startBit));
      d.moved = width !== d.startWidth ? true : d.moved;
      setPreview({ group: d.group, bit: d.startBit, width, conflicts: previewConflicts(d.group, d.id, d.startBit, width) });
    }
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPreview(null);
    if (!d) return;
    d.lane.releasePointerCapture?.(e.pointerId);
    if (!d.moved) return;
    const rect = d.lane.getBoundingClientRect();
    const geo = bitGeometry(d.group.unit, rect.width, bitOrder);
    const at = bitAtPoint(e.clientX - rect.left, geo);
    if (d.kind === 'move') {
      const bit = Math.max(0, Math.min(d.group.unit * 8 - d.startWidth, at - d.grab));
      actions.moveBit(d.id, bit);
    } else if (d.kind === 'resize-left') {
      const end = d.startBit + d.startWidth;
      const bit = Math.max(0, Math.min(end - 1, at));
      actions.setBitRange(d.id, bit, end - bit);
    } else {
      const width = Math.max(1, Math.min(d.group.unit * 8 - d.startBit, at + 1 - d.startBit));
      actions.setBitRange(d.id, d.startBit, width);
    }
  };

  if (!build) return null;

  if (!groups.length) {
    const firstFree = build.free[0]?.start ?? build.size;
    return (
      <div className="bp-dz-bit-empty" ref={rootRef}>
        <b>当前布局没有位域</b>
        <span>位域需要一个存储单元（1/2/4/8 字节）和至少一个具名位段。</span>
        <div>
          <button className="btn ghost" onClick={() => actions.setView('byte')}>切回字节视图</button>
          <button className="btn primary" onClick={() => actions.createField({ kind: 'bits', unit: 2, width: 1 }, firstFree)}>创建 2 字节位域</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bp-dz-bit-stage" ref={rootRef}>
      {groups.map(group => {
        const bits = group.unit * 8;
        const width = laneWidth(group);
        const geo = bitGeometry(group.unit, width, bitOrder);
        const step = bits <= 16 ? 4 : bits <= 32 ? 8 : 16;
        const ticks = bitTicks(bits, step);
        const groupSelected = selection.kind === 'bitsGroup' && selection.key === group.key;
        return (
          <section key={group.key} className={`bp-dz-bit-group${groupSelected ? ' on' : ''}`}>
            <header className="bp-dz-bit-head">
              <span className="bp-dz-badge bits">位域组</span>
              <b className="mono">{byteLabel(group.offset)}</b>
              <span className="bp-dz-muted">{group.unit} B · {bits} bit · 已用 {group.used} · 空闲 {group.free}</span>
              <span className="grow" />
              <label className="bp-dz-inline">
                存储
                <select
                  className="select"
                  value={group.unit}
                  aria-label={`位域组 ${byteLabel(group.offset)} 的存储宽度`}
                  onChange={(e) => actions.setBitUnit(group.key, Number(e.target.value))}
                >
                  {[1, 2, 4, 8].map(n => <option key={n} value={n}>{n} B</option>)}
                </select>
              </label>
              <button className="mini-btn" onClick={() => actions.addBit(group.key)}>+ 位域</button>
            </header>
            <div className="bp-dz-bit-lane" style={{ width }}>
              <div className="bp-dz-bit-ruler" style={{ width }}>
                {ticks.map(t => (
                  <span key={t.pos} style={{ left: (bitOrder === 'lsb' ? t.pos : bits - 1 - t.pos) * geo.bitW }}>
                    {bitOrder === 'lsb' ? t.label : bits - 1 - t.pos}
                  </span>
                ))}
              </div>
              <div
                className="bp-dz-bit-track"
                data-bit-track={group.key}
                style={{ width, ['--bp-bit-w' as string]: `${geo.bitW}px` }}
                onPointerDown={(e) => start(e, group)}
                onPointerMove={move}
                onPointerUp={finish}
                onPointerCancel={() => { dragRef.current = null; setPreview(null); }}
              >
                {group.members.map(member => {
                  const bit = member.bits?.offset ?? 0;
                  const w = member.bits?.width ?? 1;
                  const rect = bitRect(bit, w, geo);
                  const selected = selection.kind === 'fields' && selection.ids.includes(member.id);
                  const overlap = group.overlapIds.has(member.id);
                  const bad = (build.problems ?? []).some(p => p.severity === 'error' && p.fieldId === member.id);
                  return (
                    <div
                      key={member.id}
                      className={`bp-dz-bit-bar${selected ? ' on' : ''}${overlap || bad ? ' bad' : ''}`}
                      data-bit-id={member.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${member.name}，位偏移 ${bit}，位宽 ${w}`}
                      aria-pressed={selected}
                      title={`${member.name} · bit ${bit}–${bit + w - 1}`}
                      style={{ left: rect.left + 1, width: Math.max(8, rect.width - 2) }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        actions.openContextMenu({ x: e.clientX, y: e.clientY, fieldId: member.id, bitsKey: group.key, offset: group.offset });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        actions.selectFields([member.id], member.id);
                      }}
                    >
                      <span className="bp-dz-bit-name">{member.name}</span>
                      {rect.width > 92 && <span className="bp-dz-bit-range">bit {bit}–{bit + w - 1}</span>}
                      <span className="bp-dz-bit-handle left" data-bedge="left" title="拖动左边缘改宽度" />
                      <span className="bp-dz-bit-handle right" data-bedge="right" title="拖动右边缘改宽度" />
                    </div>
                  );
                })}
                {preview && preview.group.key === group.key && (() => {
                  const rect = bitRect(preview.bit, preview.width, geo);
                  return (
                    <div
                      className={`bp-dz-bit-preview${preview.conflicts.length ? ' conflict' : ''}`}
                      style={{ left: rect.left + 1, width: Math.max(8, rect.width - 2) }}
                      aria-hidden="true"
                    >
                      {preview.conflicts.length ? `冲突：${preview.conflicts.join('、')}` : `${preview.width} bit`}
                    </div>
                  );
                })()}
              </div>
            </div>
          </section>
        );
      })}
      {otherFields.length > 0 && (
        <section className="bp-dz-byte-fields">
          <h4>字节字段</h4>
          <div>
            {otherFields.map(f => (
              <button key={f.id} className="bp-dz-byte-chip" onClick={() => { actions.setView('byte'); actions.selectFields([f.id], f.id); }}>
                {f.name} <em>{byteLabel(f.offset)} · {f.size} B</em>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
