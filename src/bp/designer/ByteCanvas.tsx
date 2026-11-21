import { useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutBitGroup, LayoutProblem, PositionedField } from '../layouts';
import { useDesigner } from './context';
import {
  canvasGeometry, clampZoom, fitZoom, offsetAtPoint, segmentRect, segments,
  type Rect,
} from './geometry';
import type { FieldInput } from './operations';

interface Entity {
  type: 'field' | 'bits';
  key: string;
  id?: string;
  group?: LayoutBitGroup;
  field?: PositionedField;
  offset: number;
  size: number;
  name: string;
  kind: string;
  auto: boolean;
}

interface MoveDrag {
  kind: 'move';
  ids: string[];
  anchorId: string;
  /** A field in an existing multi-selection; a click without movement still
   * applies Ctrl/Shift selection semantics on release. */
  clickField?: string;
  members: Array<{ id: string; offset: number; size: number }>;
  entityOffset: number;
  size: number;
  grab: number;
  startX: number;
  startY: number;
  moved: boolean;
}
interface ResizeDrag {
  kind: 'resize';
  id: string;
  entityOffset: number;
  startSize: number;
  startX: number;
  startY: number;
  moved: boolean;
}
interface ReorderDrag {
  kind: 'reorder';
  id: string;
  startX: number;
  startY: number;
  moved: boolean;
  targetIndex: number;
  targetRect?: Rect;
}
interface PanDrag {
  kind: 'pan';
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}
type Drag = MoveDrag | ResizeDrag | ReorderDrag | PanDrag;

interface Preview {
  kind: 'move' | 'resize' | 'reorder';
  rects: Rect[];
  label: string;
  targetIndex?: number;
}

function byteLabel(offset: number): string {
  return '0x' + offset.toString(16).padStart(2, '0');
}

function targetName(of: string | undefined, layouts: readonly { id: string; name: string }[]): string {
  if (!of) return '未选择';
  if (!of.startsWith('layout/')) return of;
  const id = of.slice('layout/'.length);
  return layouts.find(l => l.id === id)?.name ?? id;
}

function entityProblem(problems: LayoutProblem[], entity: Entity): LayoutProblem | undefined {
  if (entity.type === 'bits') {
    const ids = new Set(entity.group?.members.map(m => m.id) ?? []);
    return problems.find(p => p.severity === 'error' && p.fieldId && ids.has(p.fieldId));
  }
  return problems.find(p => p.severity === 'error' && p.fieldId === entity.id);
}

export default function ByteCanvas() {
  const { state, actions } = useDesigner();
  const { current, build, selection, rowBytes, zoom, armed, problems } = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const spaceRef = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [panning, setPanning] = useState(false);
  const [palettePreview, setPalettePreview] = useState<{ spec: FieldInput; offset: number; size: number } | null>(null);
  const suppressClickRef = useRef(false);

  const fullGeo = useMemo(() => canvasGeometry(build?.size ?? 0, rowBytes), [build?.size, rowBytes]);
  // Keep very long layouts responsive: the document can be up to 1 MB, but we
  // only paint a bounded window of rows. The field table and inspector still
  // address every byte, and the banner explains the cut.
  const rows = Math.max(1, Math.min(fullGeo.rows, 4096, Math.floor(32768 / rowBytes)));
  const geo = useMemo(() => ({
    ...fullGeo,
    rows,
    height: fullGeo.pad * 2 + fullGeo.rulerH + rows * fullGeo.rowH,
  }), [fullGeo, rows]);
  const truncated = fullGeo.rows > rows;
  const displayedBytes = Math.min(build?.size ?? 0, rows * rowBytes);
  const layout = current!;

  const entities = useMemo<Entity[]>(() => {
    if (!build) return [];
    const out: Entity[] = [];
    for (const f of build.fields) {
      if (f.kind === 'bits') continue;
      out.push({
        type: 'field', key: `field:${f.id}`, id: f.id, field: f,
        offset: f.offset, size: f.size, name: f.name, kind: f.kind, auto: f.auto,
      });
    }
    for (const g of build.bitGroups) {
      out.push({
        type: 'bits', key: `bits:${g.key}`, group: g,
        offset: g.offset, size: g.unit,
        name: g.members.map(m => m.name).join(' / '), kind: 'bits',
        auto: g.members.every(m => m.auto),
      });
    }
    return out.sort((a, b) => a.offset - b.offset || (a.type === 'bits' ? 1 : -1));
  }, [build]);

  const selectedIds = useMemo(() => selection.kind === 'fields'
    ? new Set(selection.ids)
    : selection.kind === 'bitsGroup'
      ? new Set(selection.member ? [selection.member] : [])
      : new Set<string>(), [selection]);

  const selectedGroupKey = selection.kind === 'bitsGroup' ? selection.key : null;

  useEffect(() => {
    if (state.fitSignal <= 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const next = fitZoom(geo.width, geo.height, el.clientWidth - 28, el.clientHeight - 28);
    actions.setZoom(next);
    el.scrollTo({ left: 0, top: 0 });
  }, [state.fitSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cancel = () => {
      const d = dragRef.current;
      if (!d) return false;
      if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'reorder') {
        setPreview(null);
        dragRef.current = null;
        setPanning(false);
        return true;
      }
      return false;
    };
    actions.registerGestureCancel(cancel);
    return () => actions.registerGestureCancel(null);
  }, [actions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const next = clampZoom(zoom + (e.deltaY > 0 ? -0.1 : 0.1));
      if (next !== zoom) actions.setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, actions]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
      spaceRef.current = true;
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  useEffect(() => {
    // Keep the selected field/group visible across view and layout changes.
    const el = scrollRef.current;
    if (!el) return;
    const entity = entities.find(e =>
      selection.kind === 'fields' ? (e.type === 'field' && selectedIds.has(e.id!))
        : selection.kind === 'bitsGroup' ? (e.type === 'bits' && e.group?.key === selection.key)
          : false);
    if (!entity) return;
    const rect = segmentRect(segments(entity.offset, entity.size, rowBytes)[0], geo);
    const top = rect.top * zoom;
    const left = rect.left * zoom;
    if (top < el.scrollTop || top + rect.height * zoom > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
    if (left < el.scrollLeft || left + rect.width * zoom > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - el.clientWidth / 3);
    }
  }, [selection, selectedIds, entities, geo, rowBytes, zoom]);

  const logicalPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  };

  const offsetAtClient = (clientX: number, clientY: number): number | null => {
    const p = logicalPoint(clientX, clientY);
    return p ? offsetAtPoint(p.x, p.y, geo) : null;
  };

  const entityAtTarget = (target: EventTarget | null): Entity | undefined => {
    const el = target instanceof Element ? target : null;
    if (!el) return undefined;
    const group = el.closest('[data-group-key]')?.getAttribute('data-group-key');
    if (group) return entities.find(e => e.type === 'bits' && e.group?.key === group);
    const id = el.closest('[data-field-id]')?.getAttribute('data-field-id');
    return id ? entities.find(e => e.type === 'field' && e.id === id) : undefined;
  };

  const chooseField = (id: string, e: React.PointerEvent | React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      actions.toggleField(id);
      return;
    }
    if (e.shiftKey && selection.kind === 'fields') {
      const order = layout.fields.map(f => f.id);
      const a = order.indexOf(selection.primary);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        actions.selectFields(order.slice(from, to + 1), selection.primary);
        return;
      }
    }
    actions.selectFields([id], id);
  };

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault();
      canvasRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = {
        kind: 'pan', startX: e.clientX, startY: e.clientY,
        scrollLeft: scrollRef.current?.scrollLeft ?? 0,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
      };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const entity = entityAtTarget(target);
    if (!entity) return;
    e.preventDefault();
    const at = offsetAtClient(e.clientX, e.clientY);
    const grab = at == null ? 0 : Math.max(0, Math.min(entity.size - 1, at - entity.offset));
    if (target.closest('[data-resize]') && entity.type === 'field' && entity.field) {
      actions.selectFields([entity.id!], entity.id);
      canvasRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'resize', id: entity.id!, entityOffset: entity.offset,
        startSize: entity.size, startX: e.clientX, startY: e.clientY, moved: false,
      };
      return;
    }
    if (target.closest('[data-reorder]') && entity.type === 'field' && entity.auto) {
      actions.selectFields([entity.id!], entity.id);
      canvasRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'reorder', id: entity.id!, startX: e.clientX, startY: e.clientY,
        moved: false, targetIndex: layout.fields.findIndex(f => f.id === entity.id),
      };
      return;
    }
    const selectedMulti = selection.kind === 'fields' && selection.ids.length > 1 && selection.ids.includes(entity.id!);
    const ids = entity.type === 'bits'
      ? entity.group!.members.map(m => m.id)
      : selectedMulti ? selection.ids : [entity.id!];
    const members = ids
      .map(id => build?.fields.find(f => f.id === id))
      .filter((f): f is NonNullable<typeof f> => !!f)
      .map(f => ({ id: f.id, offset: f.offset, size: f.size }));
    if (entity.type === 'bits') actions.selectGroup(entity.group!.key);
    else if (!selectedMulti) chooseField(entity.id!, e);
    canvasRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: 'move', ids, anchorId: entity.type === 'bits' ? entity.group!.members[0].id : entity.id!,
      ...(selectedMulti && entity.type === 'field' ? { clickField: entity.id } : {}),
      members: members.length ? members : [{ id: entity.type === 'bits' ? entity.group!.members[0].id : entity.id!, offset: entity.offset, size: entity.size }],
      entityOffset: entity.offset, size: entity.size,
      grab, startX: e.clientX, startY: e.clientY, moved: false,
    };
  };

  const updatePreview = (d: Drag, e: React.PointerEvent<HTMLDivElement>) => {
    if (d.kind === 'pan') {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = d.scrollLeft - (e.clientX - d.startX);
      el.scrollTop = d.scrollTop - (e.clientY - d.startY);
      return;
    }
    const at = offsetAtClient(e.clientX, e.clientY);
    if (at == null) return;
    if (d.kind === 'move') {
      const target = Math.max(0, at - d.grab);
      d.moved = target !== d.entityOffset || Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3;
      if (!d.moved) { setPreview(null); return; }
      const delta = target - d.entityOffset;
      const rects = d.members.flatMap(m => segments(m.offset + delta, m.size, rowBytes).map(seg => segmentRect(seg, geo)));
      setPreview({
        kind: 'move', rects,
        label: d.ids.length > 1 ? `移动 ${d.ids.length} 个字段 → ${byteLabel(target)}` : `锚定到 ${byteLabel(target)}`,
      });
    } else if (d.kind === 'resize') {
      const size = Math.max(1, Math.min(1 << 20, at + 1 - d.entityOffset));
      d.moved = Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3;
      if (!d.moved) { setPreview(null); return; }
      const rects = segments(d.entityOffset, size, rowBytes).map(seg => segmentRect(seg, geo));
      setPreview({ kind: 'resize', rects, label: `${size} B` });
    } else {
      const hovered = entityAtTarget(document.elementFromPoint(e.clientX, e.clientY));
      const target = hovered?.type === 'field' ? hovered.id! : null;
      const hoveredRect = hovered ? segmentRect(segments(hovered.offset, hovered.size, rowBytes)[0], geo) : undefined;
      const logical = logicalPoint(e.clientX, e.clientY);
      const after = !!hoveredRect && !!logical && logical.x > hoveredRect.left + hoveredRect.width / 2;
      const index = target ? layout.fields.findIndex(f => f.id === target) : layout.fields.length;
      const order = layout.fields.map(f => f.id);
      const from = order.indexOf(d.id);
      let insert = index < 0 ? order.length : index + (after ? 1 : 0);
      if (from >= 0 && from < insert) insert -= 1;
      d.targetIndex = Math.max(0, Math.min(layout.fields.length - 1, insert));
      d.moved = Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3;
      if (!d.moved) { setPreview(null); return; }
      const targetField = layout.fields[d.targetIndex];
      const targetEntity = targetField ? entities.find(x => x.type === 'field' && x.id === targetField.id) : undefined;
      const targetRect = targetEntity ? segmentRect(segments(targetEntity.offset, targetEntity.size, rowBytes)[0], geo) : undefined;
      setPreview({
        kind: 'reorder', rects: targetRect ? [targetRect] : [], label: '调整顺序',
        targetIndex: d.targetIndex,
      });
    }
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPreview(null);
    setPanning(false);
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    if (!d || d.kind === 'pan') return;
    if (!d.moved) {
      if (d.kind === 'move' && d.clickField) chooseField(d.clickField, e);
      return;
    }
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    if (d.kind === 'move') {
      const at = offsetAtClient(e.clientX, e.clientY);
      if (at == null) return;
      const target = Math.max(0, at - d.grab);
      actions.moveFields(d.ids, target, d.anchorId);
    } else if (d.kind === 'resize') {
      const at = offsetAtClient(e.clientX, e.clientY);
      if (at == null) return;
      actions.resizeField(d.id, Math.max(1, at + 1 - d.entityOffset));
    } else {
      actions.reorderFields([d.id], d.targetIndex);
    }
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (dragRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-field-id], [data-group-key]')) return;
    const cell = target.closest('[data-cell]') as HTMLElement | null;
    if (!cell) { actions.clearSelection(); return; }
    const offset = Number(cell.dataset.cell);
    if (armed) {
      actions.createField(armed, offset);
    } else {
      actions.clearSelection();
    }
  };

  const onCanvasDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const entity = entityAtTarget(e.target);
    if (entity?.type === 'field' && entity.field) {
      const f = entity.field;
      if ((f.kind === 'record' || f.kind === 'array') && f.of?.startsWith('layout/')) {
        actions.enterLayout(f.of.slice('layout/'.length));
      }
    }
  };

  const onCanvasContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const entity = entityAtTarget(target);
    if (entity?.type === 'bits') {
      actions.openContextMenu({ x: e.clientX, y: e.clientY, bitsKey: entity.group!.key, offset: entity.offset });
      return;
    }
    if (entity?.type === 'field') {
      actions.openContextMenu({ x: e.clientX, y: e.clientY, fieldId: entity.id, offset: entity.offset });
      return;
    }
    const cell = target.closest('[data-cell]') as HTMLElement | null;
    actions.openContextMenu({ x: e.clientX, y: e.clientY, offset: cell ? Number(cell.dataset.cell) : undefined });
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('application/x-memlink-field')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const at = offsetAtClient(e.clientX, e.clientY);
    if (at == null) return;
    try {
      const spec = JSON.parse(e.dataTransfer.getData('application/x-memlink-field')) as FieldInput;
      const size = spec.kind === 'bits' ? (spec.unit ?? 1) : spec.kind === 'string' || spec.kind === 'bytes' ? (spec.size ?? 4) : spec.kind === 'record' || spec.kind === 'array' ? 1 : Number(spec.kind.slice(1)) / 8 || 1;
      setPalettePreview({ spec, offset: at, size });
    } catch { /* ignore */ }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const raw = e.dataTransfer.getData('application/x-memlink-field');
    if (!raw) return;
    e.preventDefault();
    const at = offsetAtClient(e.clientX, e.clientY);
    setPalettePreview(null);
    if (at == null) return;
    try {
      const spec = JSON.parse(raw) as FieldInput;
      actions.createField(spec, at);
    } catch { /* ignore */ }
  };

  const fieldNodes = useMemo(() => entities.map((entity) => {
    const selected = entity.type === 'bits'
      ? selectedGroupKey === entity.group!.key
        || (selection.kind === 'fields' && entity.group!.members.some(m => selection.ids.includes(m.id)))
      : selectedIds.has(entity.id!);
    const bad = entityProblem(problems, entity);
    const overlap = build?.byteOverlaps.some(([a, b]) =>
      (a.start === entity.offset && a.end === entity.offset + entity.size)
      || (b.start === entity.offset && b.end === entity.offset + entity.size)) ?? false;
    const cls = [
      'bp-dz-field', `is-${entity.kind}`,
      selected ? 'on' : '',
      entity.auto ? 'auto' : '',
      bad ? 'bad' : '',
      overlap && !layout.union ? 'overlap' : '',
    ].filter(Boolean).join(' ');
    const aria = entity.type === 'bits'
      ? `位域组 ${entity.group!.members.length} 项，偏移 ${byteLabel(entity.offset)}，${entity.size} 字节`
      : `${entity.name}，${entity.kind}，偏移 ${byteLabel(entity.offset)}，${entity.size} 字节，${entity.auto ? '自动排布' : '锚定'}`;
    return segments(entity.offset, entity.size, rowBytes)
      .filter(seg => seg.row < geo.rows)
      .map((seg) => {
      const rect = segmentRect(seg, geo);
      const inner = seg.first ? (
        <>
          <div className="bp-dz-field-name">{entity.type === 'bits' ? `位域 · ${entity.group!.members.length} 项` : entity.name}</div>
          <div className="bp-dz-field-meta">
            {entity.type === 'bits' ? 'bits' : entity.kind} · {byteLabel(entity.offset)} · {entity.size} B
            {entity.type === 'field' && entity.field?.kind === 'array' && (
              <> · {(entity.field.count ?? '?')} × {targetName(entity.field.of, state.layouts)}</>
            )}
            {entity.type === 'field' && entity.field?.kind === 'record' && (
              <> · {targetName(entity.field.of, state.layouts)}</>
            )}
            {entity.auto && <span className="bp-dz-auto">自动</span>}
            {bad && <span className="bp-dz-bad-dot" title={bad.message}>!</span>}
          </div>
          {entity.type === 'bits' && (
            <div className="bp-dz-mini-bits">
              {entity.group!.members.map(m => (
                <i key={m.id} style={{
                  left: `${((m.bits?.offset ?? 0) / (entity.size * 8)) * 100}%`,
                  width: `${Math.max(1, ((m.bits?.width ?? 1) / (entity.size * 8)) * 100)}%`,
                }} title={`${m.name} bit ${m.bits?.offset ?? 0}–${(m.bits?.offset ?? 0) + (m.bits?.width ?? 1) - 1}`} />
              ))}
            </div>
          )}
          {entity.auto && seg.first && <span className="bp-dz-grip" data-reorder="1" title="拖动调整自动顺序">⠿</span>}
          {entity.type === 'field' && (entity.kind === 'string' || entity.kind === 'bytes') && (
            <span className="bp-dz-resize" data-resize="1" title="拖动改长度" />
          )}
        </>
      ) : null;
      return (
        <div
          key={`${entity.key}:${seg.offset}`}
          className={`${cls}${seg.first ? '' : ' cont'}`}
          {...(seg.first ? { role: 'button', tabIndex: 0, 'aria-label': aria, 'aria-pressed': selected } : { 'aria-hidden': true })}
          {...{ [entity.type === 'bits' ? 'data-group-key' : 'data-field-id']: entity.type === 'bits' ? entity.group!.key : entity.id }}
          data-entity={entity.key}
          title={bad?.message ?? `${entity.name} · ${entity.size} B`}
          style={{ left: rect.left + 2, top: rect.top + 5, width: Math.max(8, rect.width - 4), height: rect.height - 10 }}
        >
          {inner}
          {!seg.first && <span className="bp-dz-cont-mark" aria-hidden="true">↳</span>}
        </div>
      );
    });
  }), [entities, selectedGroupKey, selectedIds, selection, problems, build, layout.union, rowBytes, geo, state.layouts]);

  const previewNodes = preview
    ? preview.rects.map((r, i) => (
      <div key={`preview:${i}`} className={`bp-dz-preview ${preview.kind}`} style={{
        left: r.left + 2, top: r.top + 4, width: Math.max(8, r.width - 4), height: r.height - 8,
      }} aria-hidden="true">
        {i === 0 && <span className="bp-dz-preview-label">{preview.label}</span>}
      </div>
    ))
    : [];

  const paletteNodes = palettePreview
    ? segments(palettePreview.offset, palettePreview.size, rowBytes).map((seg, i) => {
      const r = segmentRect(seg, geo);
      return <div key={`palette:${i}`} className="bp-dz-preview palette" style={{ left: r.left + 2, top: r.top + 4, width: Math.max(8, r.width - 4), height: r.height - 8 }} aria-hidden="true" />;
    })
    : [];

  return (
    <div
      ref={scrollRef}
      className={`bp-dz-canvas-scroll${panning ? ' panning' : ''}${armed ? ' armed' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setPalettePreview(null)}
      onDrop={onDrop}
    >
      {truncated && (
        <div className="bp-dz-canvas-limit" role="status">
          布局共 {build?.size ?? 0} B；画布仅渲染前 {displayedBytes} B，其余字节请用字段表或检查器定位。
        </div>
      )}
      <div className="bp-dz-stage" style={{ width: geo.width * zoom, height: geo.height * zoom }}>
        <div
          ref={canvasRef}
          className={`bp-dz-canvas${layout.union ? ' union' : ''}`}
          style={{ width: geo.width, height: geo.height, transform: `scale(${zoom})` }}
          onPointerDown={startDrag}
          onPointerMove={(e) => { const d = dragRef.current; if (d) updatePreview(d, e); }}
          onPointerUp={finishDrag}
          onPointerCancel={(e) => { dragRef.current = null; setPreview(null); setPanning(false); canvasRef.current?.releasePointerCapture?.(e.pointerId); }}
          onClick={onCanvasClick}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={onCanvasContextMenu}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const entity = entityAtTarget(e.target);
            if (!entity) return;
            e.preventDefault();
            if (entity.type === 'bits') { actions.selectGroup(entity.group!.key); return; }
            actions.selectFields([entity.id!], entity.id);
            if (entity.field && (entity.field.kind === 'record' || entity.field.kind === 'array') && entity.field.of?.startsWith('layout/')) {
              actions.enterLayout(entity.field.of.slice('layout/'.length));
            }
          }}
        >
          {Array.from({ length: rowBytes }, (_, c) => (
            <div key={`ruler:${c}`} className="bp-dz-ruler" style={{ left: geo.pad + geo.gutter + c * geo.cellW, width: geo.cellW }}>
              +{c}
            </div>
          ))}
          {Array.from({ length: rows }, (_, r) => {
            const top = geo.pad + geo.rulerH + r * geo.rowH;
            return (
              <div key={`row:${r}`}>
                <div className="bp-dz-rowlabel" style={{ top, height: geo.rowH }}>{byteLabel(r * rowBytes)}</div>
                {Array.from({ length: rowBytes }, (_, c) => {
                  const off = r * rowBytes + c;
                  return (
                    <div
                      key={`cell:${off}`}
                      className={`bp-dz-cell${off >= (build?.size ?? 0) ? ' out' : ''}`}
                      data-cell={off}
                      style={{
                        left: geo.pad + geo.gutter + c * geo.cellW,
                        top, width: geo.cellW, height: geo.rowH,
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
          {fieldNodes}
          {previewNodes}
          {paletteNodes}
          {!build?.fields.length && (
            <div className="bp-dz-empty" role="status">
              <b>布局还没有字段</b>
              <span>从左侧拖入类型，或点击工具栏「插入字段」开始。</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
