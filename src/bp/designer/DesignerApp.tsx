import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { analyzeLayouts, type BinaryLayout, type LayoutProblem } from '../layouts';
import { FOCUSABLE } from '../ModalFocus';
import { readPrefs, writePrefs } from '../layout';
import { layoutToPackSource, parseDeclarations } from '../declaration';
import {
  DesignerContext, useDesigner, type DesignerContextValue, type DesignerDialog, type DesignerConfirm,
  type DesignerSelection, type DesignerState,
} from './context';
import ByteCanvas from './ByteCanvas';
import BitLanes from './BitLanes';
import DesignerInspector from './DesignerInspector';
import FieldTable from './FieldTable';
import {
  addBit as addBitOp, anchorFields as anchorFieldsOp, copyFields as copyFieldsOp,
  createField as createFieldOp, createLayout as createLayoutOp, deleteFields as deleteFieldsOp,
  deleteLayout as deleteLayoutOp, duplicateFields as duplicateFieldsOp, duplicateLayout as duplicateLayoutOp,
  moveBit as moveBitOp, moveFields as moveFieldsOp, pasteFields as pasteFieldsOp,
  patchFields as patchFieldsOp, reorderFields as reorderFieldsOp, resizeBit as resizeBitOp,
  resizeField as resizeFieldOp, restoreAuto as restoreAutoOp, setBitGroupUnit as setBitGroupUnitOp,
  setBitRange as setBitRangeOp, setFieldProp as setFieldPropOp, setLayoutProp as setLayoutPropOp,
  type DesignerModel, type FieldClip, type FieldInput, type FieldPatch, type LayoutPatch, type OpResult,
} from './operations';
import { clampZoom, ROW_BYTES_OPTIONS, type BitOrder, type RowBytes } from './geometry';
import { createTemplate, DESIGNER_TEMPLATES } from './templates';
import type { LayoutUsageIndex } from './usage';
import './designer.css';

export interface DesignerApplyResult {
  ok: boolean;
  problems?: LayoutProblem[];
  message?: string;
}

export interface DesignerAppProps {
  layouts: BinaryLayout[];
  stack: string[];
  usage: LayoutUsageIndex;
  sessionDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onNavigate: (stack: string[]) => void;
  onClose: () => void;
  onApply: (next: BinaryLayout[], label: string, mergeKey?: string) => DesignerApplyResult;
  onRestoreSession: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

const KIND_LABEL: Record<string, string> = {
  u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
  u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64',
  string: 'string', bytes: 'bytes', bits: 'bits', record: 'record', array: 'array',
};
const SCALAR_PALETTE: FieldInput[] = [
  { kind: 'u8' }, { kind: 'u16' }, { kind: 'u32' }, { kind: 'u64' },
  { kind: 'i16' }, { kind: 'f32' }, { kind: 'string' }, { kind: 'bytes' }, { kind: 'bits', unit: 1, width: 1 },
];
const NOOP_MESSAGE = /未变化|已经锚定|没有可恢复|没有可复制|位置未变化/;

function hex(n: number): string {
  return '0x' + Math.max(0, n).toString(16).padStart(2, '0');
}

function selectionLabel(selection: DesignerSelection, current: BinaryLayout | undefined): string {
  if (selection.kind === 'fields') {
    if (selection.ids.length > 1) return `已选 ${selection.ids.length} 个字段`;
    const f = current?.fields.find(x => x.id === selection.primary);
    return f ? f.name : '未选择';
  }
  if (selection.kind === 'bitsGroup') {
    const [offset, unit] = selection.key.split(':');
    const at = Number(offset);
    return Number.isSafeInteger(at) ? `位域组 @ ${hex(at)} · ${unit} B` : `位域组 ${selection.key}`;
  }
  if (selection.kind === 'layout') return current?.name ?? '布局';
  return '未选择';
}

export default function DesignerApp({
  layouts, stack, usage, sessionDirty, canUndo, canRedo,
  onNavigate, onClose, onApply, onRestoreSession, onUndo, onRedo,
}: DesignerAppProps) {
  const prefs = useMemo(() => readPrefs().designer ?? { rowBytes: 4 as RowBytes, bitOrder: 'lsb' as BitOrder, tableOpen: true }, []);
  const [view, setView] = useState<'byte' | 'bit'>('byte');
  const [rowBytes, setRowBytes] = useState<RowBytes>(prefs.rowBytes);
  const [bitOrder, setBitOrder] = useState<BitOrder>(prefs.bitOrder);
  const [tableOpen, setTableOpen] = useState(prefs.tableOpen);
  const [zoom, setZoomState] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selection, setSelection] = useState<DesignerSelection>({ kind: 'layout' });
  const [problemsPane, setProblemsPane] = useState<'inspect' | 'problems'>('inspect');
  const [armed, setArmedState] = useState<FieldInput | null>(null);
  const [clip, setClip] = useState<FieldClip | null>(null);
  const [dialog, setDialog] = useState<DesignerDialog | null>(null);
  const [confirm, setConfirm] = useState<DesignerConfirm | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; fieldId?: string; bitsKey?: string; offset?: number } | null>(null);
  const [insert, setInsert] = useState<{ x: number; y: number; offset?: number } | null>(null);
  const [toast, setToastState] = useState<{ message: string; tone: 'ok' | 'error' } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [layoutFilter, setLayoutFilter] = useState('');
  const toastTimer = useRef(0);
  const gestureCancelRef = useRef<(() => boolean) | null>(null);
  const insertTrigger = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    const visible = (el: HTMLElement) => el.getClientRects().length > 0 && !el.hasAttribute('disabled');
    const raf = window.requestAnimationFrame(() => document.getElementById('bp-dz-title')?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root) return;
      const layer = root.querySelector<HTMLElement>('.bp-dz-modal')
        ?? root.querySelector<HTMLElement>('.bp-dz-insert')
        ?? root.querySelector<HTMLElement>('.bp-dz-menu');
      const scope = layer ?? root;
      const items = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !scope.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (active === last || !scope.contains(active))) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const analysis = useMemo(() => analyzeLayouts(layouts), [layouts]);
  const currentId = stack[stack.length - 1] ?? '';
  const current = layouts.find(l => l.id === currentId);
  const build = current ? analysis.builds.get(current.id) : undefined;
  const problems = build?.problems ?? [];

  const notify = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    setToastState({ message, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    gestureCancelRef.current?.();
    setSelection({ kind: 'layout' });
    setArmedState(null);
    setMenu(null);
    setInsert(null);
  }, [currentId]);

  useEffect(() => {
    if (selection.kind === 'fields' && current && !selection.ids.every(id => current.fields.some(f => f.id === id))) {
      setSelection({ kind: 'layout' });
    }
    if (selection.kind === 'bitsGroup' && build && !build.bitGroups.some(g => g.key === selection.key)) {
      setSelection({ kind: 'layout' });
    }
  }, [layouts, current, build, selection]);

  useEffect(() => {
    const p = readPrefs();
    writePrefs({ ...p, designer: { rowBytes, bitOrder, tableOpen } });
  }, [rowBytes, bitOrder, tableOpen]);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const hadInert = root.hasAttribute('inert');
    const oldHidden = root.getAttribute('aria-hidden');
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      if (!hadInert) root.removeAttribute('inert');
      if (oldHidden === null) root.removeAttribute('aria-hidden'); else root.setAttribute('aria-hidden', oldHidden);
    };
  }, []);

  const setZoom = (value: number) => setZoomState(clampZoom(value));
  const zoomBy = (delta: number) => setZoomState(z => clampZoom(z + delta));

  const applyResult = useCallback((result: OpResult, label: string): boolean => {
    if (!result.ok) {
      if (result.message && !NOOP_MESSAGE.test(result.message)) notify(result.message, 'error');
      return false;
    }
    if (!result.layouts) return false;
    const applied = onApply(result.layouts, label);
    if (!applied.ok) {
      notify(applied.message ?? '修改未提交', 'error');
      setProblemsPane('problems');
      return false;
    }
    if (result.selectedIds?.length) {
      setSelection({ kind: 'fields', primary: result.selectedIds[0], ids: result.selectedIds });
    }
    return true;
  }, [notify, onApply]);

  const model = useMemo<DesignerModel>(() => ({ layouts, currentId }), [layouts, currentId]);

  const focusFieldName = () => {
    window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLInputElement>('.bp-dz-right input[aria-label="字段名称"], .bp-dz-right input[aria-label="布局名称"]')?.focus();
    });
  };

  const deleteFields = useCallback((ids: readonly string[]) => {
    if (!current || !ids.length) return;
    const edgeRefs = ids.flatMap(id => usage.fieldRefs.get(`${current.id}:${id}`) ?? []).filter(r => r.kind === 'edge');
    const layoutRefs = usage.byLayout.get(current.id) ?? [];
    const parentRefs = layoutRefs.filter(r => r.kind === 'layout');
    const nodeRefs = layoutRefs.filter(r => r.kind === 'node');
    const packRef = layoutRefs.some(r => r.kind === 'pack');
    const run = () => {
      const result = deleteFieldsOp(model, ids);
      if (applyResult(result, ids.length > 1 ? '批量删除字段' : '删除字段')) {
        setSelection({ kind: 'layout' });
        notify(ids.length > 1 ? `已删除 ${ids.length} 个字段` : '已删除字段');
      }
    };
    if (!edgeRefs.length && !parentRefs.length && !nodeRefs.length && !packRef) { run(); return; }
    const lines = [
      ...edgeRefs.slice(0, 3).map(r => `· 连线：${r.label}`),
      ...parentRefs.slice(0, 3).map(r => `· 父布局：${r.label}`),
      ...nodeRefs.slice(0, 3).map(r => `· 节点：${r.label}`),
    ].join('\n');
    setConfirm({
      title: '删除字段会影响引用',
      message: [
        edgeRefs.length ? `${edgeRefs.length} 条连线使用这些字段。` : '',
        parentRefs.length ? `${parentRefs.length} 个父布局引用此布局。` : '',
        nodeRefs.length ? `${nodeRefs.length} 个节点按此布局生成端口。` : '',
        lines,
        edgeRefs.length + parentRefs.length + nodeRefs.length > 9 ? '· …还有更多引用' : '',
        packRef ? '该布局还被 pack 通过 layoutType 引用；pack 节点端口可能失效。' : '',
        '',
        '删除后缺失连线会保留为可定位问题，不会被静默改接。',
      ].filter(Boolean).join('\n'),
      confirmLabel: '仍然删除',
      tone: 'danger',
      onConfirm: run,
    });
  }, [applyResult, current, model, notify, usage]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deleteSelection = () => {
    if (selection.kind === 'fields') deleteFields(selection.ids);
    else if (selection.kind === 'bitsGroup') {
      const group = build?.bitGroups.find(g => g.key === selection.key);
      if (group) deleteFields(group.members.map(m => m.id));
    }
  };

  const openInsert = useCallback((x: number, y: number, offset?: number, trigger?: HTMLElement | null) => {
    const active = document.activeElement;
    insertTrigger.current = trigger
      ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    setInsert({ x, y, offset });
  }, []);

  const closeInsert = useCallback(() => {
    setInsert(null);
    window.requestAnimationFrame(() => {
      const trigger = insertTrigger.current;
      if (trigger?.isConnected) { trigger.focus(); return; }
      rootRef.current?.querySelector<HTMLButtonElement>('[data-insert-trigger]')?.focus();
    });
  }, []);

  const handleEscape = useCallback(() => {
    if (gestureCancelRef.current?.()) return;
    if (dialog) { setDialog(null); return; }
    if (confirm) { setConfirm(null); return; }
    if (menu) { setMenu(null); return; }
    if (insert) { closeInsert(); return; }
    if (armed) { setArmedState(null); return; }
    if (stack.length > 1) { onNavigate(stack.slice(0, -1)); return; }
    onClose();
  }, [dialog, confirm, menu, insert, closeInsert, armed, stack, onNavigate, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      handleEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [handleEscape]);

  const actions = useMemo(() => ({
    selectFields(ids: readonly string[], primary?: string) {
      const next = Array.from(new Set(ids));
      if (!next.length) { setSelection({ kind: 'layout' }); return; }
      setSelection({ kind: 'fields', primary: primary && next.includes(primary) ? primary : next[0], ids: next });
    },
    toggleField(id: string) {
      setSelection(prev => {
        if (prev.kind !== 'fields') return { kind: 'fields', primary: id, ids: [id] };
        const has = prev.ids.includes(id);
        const ids = has ? prev.ids.filter(x => x !== id) : [...prev.ids, id];
        if (!ids.length) return { kind: 'layout' };
        return { kind: 'fields', primary: has && prev.primary === id ? ids[0] : prev.primary, ids };
      });
    },
    selectGroup(key: string, member?: string) { setSelection({ kind: 'bitsGroup', key, member }); },
    selectLayout() { setSelection({ kind: 'layout' }); },
    clearSelection() { setSelection({ kind: 'none' }); },
    openLayout(id: string) { setSelection({ kind: 'layout' }); setArmedState(null); onNavigate([id]); },
    enterLayout(id: string) { setSelection({ kind: 'layout' }); setArmedState(null); onNavigate([...stack, id]); },
    back() { if (stack.length > 1) { setSelection({ kind: 'layout' }); onNavigate(stack.slice(0, -1)); } },
    close() { onClose(); },
    setView(next: 'byte' | 'bit') { if (next === 'bit') setArmedState(null); setView(next); },
    setRowBytes(next: RowBytes) { setRowBytes(next); },
    setBitOrder(next: BitOrder) { setBitOrder(next); },
    setZoom(next: number) { setZoom(next); },
    zoomBy(delta: number) { zoomBy(delta); },
    fit() { setFitSignal(n => n + 1); },
    setPan(next: { x: number; y: number }) { setPan(next); },
    toggleTable() { setTableOpen(v => !v); },
    setProblemsPane(next: 'inspect' | 'problems') { setProblemsPane(next); },
    setArmed(spec: FieldInput | null) {
      if (spec) setView('byte');
      setArmedState(spec);
    },
    createField(spec: FieldInput, offset: number) {
      const ok = applyResult(createFieldOp(model, spec, offset), '插入字段');
      if (ok) {
        setArmedState(null);
        if (spec.kind !== 'bits') setView('byte');
        notify(`已插入 ${KIND_LABEL[spec.kind] ?? spec.kind} @ ${hex(offset)}`, 'ok');
      }
      return ok;
    },
    moveFields(ids: readonly string[], target: number, anchorId?: string) { return applyResult(moveFieldsOp(model, ids, target, anchorId), '移动字段'); },
    moveBit(id: string, bit: number) { return applyResult(moveBitOp(model, id, bit), '移动位域'); },
    resizeBit(id: string, width: number) { return applyResult(resizeBitOp(model, id, width), '调整位宽'); },
    setBitRange(id: string, bit: number, width: number) { return applyResult(setBitRangeOp(model, id, bit, width), '调整位域'); },
    resizeField(id: string, size: number) { return applyResult(resizeFieldOp(model, id, size), '调整字段长度'); },
    reorderFields(ids: readonly string[], index: number) { return applyResult(reorderFieldsOp(model, ids, index), '调整字段顺序'); },
    anchorFields(ids: readonly string[]) { return applyResult(anchorFieldsOp(model, ids), '锚定字段'); },
    restoreAuto(ids: readonly string[]) { return applyResult(restoreAutoOp(model, ids), '恢复自动排布'); },
    deleteFields,
    duplicateFields(ids: readonly string[]) { return applyResult(duplicateFieldsOp(model, ids), '重复字段'); },
    copyFields(ids: readonly string[]) {
      const next = copyFieldsOp(model, ids);
      if (!next) { notify('没有可复制的字段', 'error'); return; }
      setClip(next);
      notify(`已复制 ${next.items.length} 个字段`, 'ok');
    },
    pasteFields(target?: number) {
      const result = applyResult(pasteFieldsOp(model, clip, target), '粘贴字段');
      if (result) notify('已粘贴字段', 'ok');
      return result;
    },
    patchField(id: string, patch: FieldPatch) { return applyResult(setFieldPropOp(model, id, patch), '修改字段'); },
    patchFields(ids: readonly string[], patch: FieldPatch) { return applyResult(patchFieldsOp(model, ids, patch), '批量修改字段'); },
    patchLayout(patch: LayoutPatch) { return applyResult(setLayoutPropOp(model, currentId, patch), '修改布局'); },
    setBitUnit(key: string, unit: number) {
      const result = setBitGroupUnitOp(model, key, unit);
      const ok = applyResult(result, '切换存储单元');
      if (ok) {
        const offset = key.split(':')[0];
        setSelection({ kind: 'bitsGroup', key: `${offset}:${unit}` });
        notify(`存储单元已切换为 ${unit} B`, 'ok');
      }
      return ok;
    },
    addBit(key: string) {
      const ok = applyResult(addBitOp(model, key), '添加位域');
      if (ok) setSelection({ kind: 'bitsGroup', key });
      return ok;
    },
    undo() { onUndo(); },
    redo() { onRedo(); },
    restoreSession() {
      setConfirm({
        title: '撤销本次打开后的全部修改',
        message: '布局会回到打开设计器时的状态；这次撤销本身也可以再撤销。',
        confirmLabel: '恢复',
        tone: 'danger',
        onConfirm: () => { onRestoreSession();  notify('已恢复设计器打开时的布局', 'ok'); },
      });
    },
    notify,
    applyImported(next: BinaryLayout[]) {
      const applied = onApply(next, '导入布局');
      if (!applied.ok) {
        notify(applied.message ?? '导入布局失败', 'error');
        return false;
      }
      return true;
    },
    openDialog(next: DesignerDialog) { setDialog(next); },
    confirm(request: DesignerConfirm) { setConfirm(request); },
    openContextMenu(request: { x: number; y: number; fieldId?: string; bitsKey?: string; offset?: number }) {
      setMenu({ ...request, x: Math.max(8, Math.min(request.x, window.innerWidth - 190)), y: Math.max(8, Math.min(request.y, window.innerHeight - 280)) });
    },
    registerGestureCancel(fn: (() => boolean) | null) { gestureCancelRef.current = fn; },
    hasClipboard: !!clip,
    clipboardCount: clip?.items.length ?? 0,
    createLayout() {
      const result = createLayoutOp(model);
      if (!result.layouts || !result.layout) { notify(result.message ?? '新建布局失败', 'error'); return; }
      const applied = onApply(result.layouts, '新建布局');
      if (!applied.ok) { notify(applied.message ?? '新建布局失败', 'error'); return; }
      onNavigate([result.layout.id]);
      notify('已新建布局', 'ok');
    },
    duplicateLayout() {
      const result = duplicateLayoutOp(model, currentId);
      if (!result.layouts || !result.layout) { notify(result.message ?? '复制布局失败', 'error'); return; }
      const applied = onApply(result.layouts, '复制布局');
      if (!applied.ok) { notify(applied.message ?? '复制布局失败', 'error'); return; }
      onNavigate([result.layout.id]);
      notify('已复制布局', 'ok');
    },
    deleteLayout() {
      const refs = usage.byLayout.get(currentId) ?? [];
      if (refs.length) {
        const kindLabel: Record<string, string> = { layout: '父布局', node: '节点', edge: '连线', pack: 'pack' };
        const lines = refs.slice(0, 6).map(ref => `· ${kindLabel[ref.kind] ?? ref.kind}：${ref.label}${ref.detail ? `（${ref.detail}）` : ''}`);
        setConfirm({
          title: '布局仍被引用',
          message: [
            `「${current?.name ?? currentId}」仍被 ${refs.length} 处引用：`,
            ...lines,
            refs.length > 6 ? `· …另外 ${refs.length - 6} 处` : '',
            '',
            '请先移除这些引用，再删除布局。',
          ].filter(Boolean).join('\n'),
          confirmLabel: '知道了',
          onConfirm: () => {},
        });
        return;
      }
      setConfirm({
        title: '删除布局',
        message: `删除「${current?.name ?? currentId}」？引用它的节点和连线不会被自动改写；此操作可以撤销。`,
        confirmLabel: '删除布局',
        tone: 'danger',
        onConfirm: () => {
          const result = deleteLayoutOp(model, currentId, usage);
          if (!result.layouts) return;
          const applied = onApply(result.layouts, '删除布局');
          if (!applied.ok) { notify(applied.message ?? '删除布局失败', 'error'); return; }
          onNavigate(stack.slice(0, -1));
          notify('已删除布局', 'ok');
        },
      });
    },
  }), [model, stack, currentId, current, clip, usage, onNavigate, onClose, onApply, onUndo, onRedo, onRestoreSession, notify, applyResult, deleteFields]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nudge = (e: KeyboardEvent) => {
    if (!current || !build) return;
    const delta = e.shiftKey ? 4 : 1;
    if (selection.kind === 'bitsGroup') {
      const group = build.bitGroups.find(g => g.key === selection.key);
      if (!group) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        actions.moveFields(group.members.map(m => m.id), group.offset + (e.key === 'ArrowLeft' ? -delta : delta));
      }
      return;
    }
    if (selection.kind !== 'fields' || selection.ids.length !== 1) return;
    const id = selection.ids[0];
    const raw = current.fields.find(f => f.id === id);
    const positioned = build.fields.find(f => f.id === id);
    if (!raw || !positioned) return;
    if (raw.kind === 'bits') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const bit = Number(raw.bit ?? 0);
        const width = Number(raw.width ?? 1);
        if (e.altKey) actions.setBitRange(id, bit, width + (e.key === 'ArrowRight' ? delta : -delta));
        else actions.moveBit(id, bit + (e.key === 'ArrowLeft' ? -delta : delta));
      }
      return;
    }
    if (e.altKey) {
      if (raw.kind !== 'string' && raw.kind !== 'bytes') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      actions.resizeField(id, Number(raw.size ?? 1) + (e.key === 'ArrowRight' ? delta : -delta));
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const offset = e.key === 'ArrowLeft' ? -delta
      : e.key === 'ArrowRight' ? delta
        : e.key === 'ArrowUp' ? -rowBytes : rowBytes;
    actions.moveFields([id], positioned.offset + offset);
  };

  // Keyboard layer. Escape is handled by its own capture listener so DraftInput
  // can own Escape while editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') return;
      if (dialog || confirm || insert || menu) return;
      const target = e.target as HTMLElement | null;
      const editable = !!target?.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      if (editable) return;
      const inTable = !!target?.closest('.bp-dz-table');
      if (!mod && target?.closest('button, a, [role="tab"]')) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo(); else onUndo();
            return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        if (!current) return;
        e.preventDefault();
        actions.selectFields(current.fields.map(f => f.id), current.fields[0]?.id);
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        if (selection.kind === 'fields') { e.preventDefault(); actions.copyFields(selection.ids); }
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        actions.pasteFields();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        if (selection.kind === 'fields') { e.preventDefault(); actions.duplicateFields(selection.ids); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === 'F2') {
        if (inTable) return;
        if (selection.kind === 'fields' || selection.kind === 'bitsGroup') {
          e.preventDefault();
          focusFieldName();
        }
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(0.1); return; }
      if (e.key === '-') { e.preventDefault(); zoomBy(-0.1); return; }
      if (e.key === '0' && !mod) { e.preventDefault(); actions.fit(); return; }
      if (e.key.startsWith('Arrow')) { if (!inTable) nudge(e); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dialog, confirm, insert, menu, current, selection, build, rowBytes, onUndo, onRedo, actions, deleteSelection, nudge]);


  const state: DesignerState = {
    layouts, current, build, analysis, usage, view, rowBytes, bitOrder, zoom, pan,
    selection, problemsPane, tableOpen, sessionDirty, canUndo, canRedo, armed, problems, fitSignal,
  };
  const contextValue: DesignerContextValue = { state, actions };

  const filteredLayouts = layoutFilter.trim()
    ? layouts.filter(l => `${l.name} ${l.id}`.toLowerCase().includes(layoutFilter.trim().toLowerCase()))
    : layouts;
  const currentRefs = current ? usage.byLayout.get(current.id) ?? [] : [];
  const usedBytes = build ? build.size - build.free.reduce((n, s) => n + (s.end - s.start), 0) : 0;
  const byteOverlapCount = build?.byteOverlaps.length ?? 0;
  const bitOverlapCount = build?.bitOverlaps.length ?? 0;
  const overlapCount = byteOverlapCount + bitOverlapCount;
  const firstFree = build?.free[0]?.start ?? build?.size ?? 0;
  const selectedLabel = selectionLabel(selection, current);
  const selectedOffset = selection.kind === 'fields' && selection.ids.length === 1
    ? build?.fields.find(f => f.id === selection.primary)?.offset
    : undefined;

  const insertField = (spec: FieldInput, offset?: number) => {
    const ok = actions.createField(spec, offset ?? insert?.offset ?? firstFree);
    if (ok) closeInsert();
  };

  const content = (
    <DesignerContext.Provider value={contextValue}>
      <div className="bp-dz" ref={rootRef} role="dialog" aria-modal="true" aria-labelledby="bp-dz-title">
        <header className="bp-dz-topbar">
          <div className="bp-dz-brand">
            <span className="bp-dz-logo">◇</span>
            <b id="bp-dz-title" tabIndex={-1}>结构设计器</b>
            <span className="bp-dz-pill">设计</span>
          </div>
          <div className="bp-dz-crumbs">
            <button type="button" onClick={onClose} title="返回蓝图">蓝图</button>
            {stack.length > 1 && <button type="button" className="bp-dz-back" onClick={() => actions.back()} title="返回上级布局">←</button>}
            {stack.map((id, i) => {
              const l = layouts.find(x => x.id === id);
              return (
                <span key={`${id}:${i}`} className="bp-dz-crumb">
                  <span>/</span>
                  <button type="button" className={i === stack.length - 1 ? 'cur' : ''} onClick={() => { actions.selectLayout(); onNavigate(stack.slice(0, i + 1)); }}>{l?.name ?? '缺失布局'}</button>
                </span>
              );
            })}
          </div>
          <div className="bp-dz-seg" role="group" aria-label="视图">
            <button type="button" className={view === 'byte' ? 'on' : ''} onClick={() => actions.setView('byte')}>字节</button>
            <button type="button" className={view === 'bit' ? 'on' : ''} onClick={() => actions.setView('bit')}>位</button>
          </div>
          {view === 'byte' ? (
            <label className="bp-dz-inline">每行
              <select className="select" value={rowBytes} onChange={(e) => actions.setRowBytes(Number(e.target.value) as RowBytes)}>
                {ROW_BYTES_OPTIONS.map(n => <option key={n} value={n}>{n} B</option>)}
              </select>
            </label>
          ) : (
            <label className="bp-dz-inline">位序
              <select className="select" value={bitOrder} onChange={(e) => actions.setBitOrder(e.target.value === 'msb' ? 'msb' : 'lsb')}>
                <option value="lsb">LSB 在左</option><option value="msb">MSB 在左</option>
              </select>
            </label>
          )}
          <div className="bp-dz-spacer" />
          <button className="bp-dz-icon" type="button" onClick={() => actions.zoomBy(-0.1)} title="缩小">−</button>
          <span className="bp-dz-zoom mono">{Math.round(zoom * 100)}%</span>
          <button className="bp-dz-icon" type="button" onClick={() => actions.zoomBy(0.1)} title="放大">＋</button>
          <button className="bp-dz-mini" type="button" onClick={() => actions.fit()} title="适应宽度">适应</button>
          <span className="bp-dz-sep" />
          <button className="bp-dz-mini" type="button" onClick={actions.undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">撤销</button>
          <button className="bp-dz-mini" type="button" onClick={actions.redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">重做</button>
          <button className="bp-dz-mini" type="button" disabled={!sessionDirty} onClick={actions.restoreSession} title="撤销本次打开后的全部修改">撤销本次修改</button>
          <span className="bp-dz-sep" />
          <button className="bp-dz-mini" type="button" onClick={() => actions.openDialog({ kind: 'import' })}>导入</button>
          <button className="bp-dz-mini" type="button" onClick={() => actions.openDialog({ kind: 'export' })}>导出</button>
          <button className="bp-dz-mini" type="button" onClick={() => actions.openDialog({ kind: 'templates' })}>模板</button>
          <button className="bp-dz-done" type="button" onClick={onClose}>完成</button>
        </header>

        <div className="bp-dz-workspace">
          <aside className="bp-dz-left" aria-label="布局与类型">
            <div className="bp-dz-panel-head"><span>结构</span><span>{layouts.length}</span><span className="grow" /><button className="bp-dz-mini" type="button" onClick={actions.createLayout}>+ 新建</button></div>
            {(layouts.length > 8 || layoutFilter.trim() !== '') && (
              <label className="bp-dz-filter">
                <input className="in" value={layoutFilter} onChange={(e) => setLayoutFilter(e.target.value)} placeholder="过滤布局" aria-label="过滤布局" />
              </label>
            )}
            <div className="bp-dz-layout-list">
              {filteredLayouts.map(l => {
                const b = analysis.builds.get(l.id);
                const refs = usage.byLayout.get(l.id)?.length ?? 0;
                return (
                  <button key={l.id} type="button" className={`bp-dz-layout-card${l.id === currentId ? ' on' : ''}`} onClick={() => actions.openLayout(l.id)}>
                    <span className="bp-dz-dot" />
                    <span className="bp-dz-layout-name">{l.name || '未命名布局'}</span>
                    <span className="bp-dz-layout-meta">{b?.size ?? 0} B · {l.fields.length} 字段{refs ? ` · 引用 ${refs}` : ''}</span>
                  </button>
                );
              })}
              {!filteredLayouts.length && <div className="bp-dz-muted bp-dz-pad">没有匹配的布局。</div>}
            </div>

            <div className="bp-dz-panel-head"><span>类型</span><span>拖到画布</span></div>
            <div className="bp-dz-palette">
              {SCALAR_PALETTE.map(spec => (
                <button
                  key={spec.kind}
                  type="button"
                  className={`bp-dz-palette-card ${spec.kind}`}
                  draggable
                  onDragStart={(e) => { actions.setView('byte'); e.dataTransfer.setData('application/x-memlink-field', JSON.stringify(spec)); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => actions.setArmed(spec)}
                >
                  <span className="bp-dz-palette-swatch" />
                  <span>{KIND_LABEL[spec.kind] ?? spec.kind}</span>
                  <em>{spec.kind === 'bits' ? '1 bit' : spec.kind === 'string' || spec.kind === 'bytes' ? '4 B' : spec.kind === 'u64' || spec.kind === 'i64' || spec.kind === 'f64' ? '8 B' : spec.kind === 'u32' || spec.kind === 'i32' || spec.kind === 'f32' ? '4 B' : spec.kind === 'u8' || spec.kind === 'i8' ? '1 B' : '2 B'}</em>
                </button>
              ))}
            </div>

            <div className="bp-dz-panel-head"><span>嵌套布局</span><span>拖入</span></div>
            <div className="bp-dz-layout-palette">
              {layouts.filter(l => l.id !== currentId).map(l => (
                <div key={l.id} className="bp-dz-layout-palette-row">
                  <button
                    type="button" draggable
                    onDragStart={(e) => { actions.setView('byte'); e.dataTransfer.setData('application/x-memlink-field', JSON.stringify({ kind: 'record', of: `layout/${l.id}` })); }}
                    onClick={() => actions.setArmed({ kind: 'record', of: `layout/${l.id}` })}
                  >{l.name}</button>
                  <button type="button" className="bp-dz-mini" onClick={() => actions.setArmed({ kind: 'array', of: `layout/${l.id}`, count: 2 })}>数组</button>
                </div>
              ))}
              {layouts.length <= 1 && <div className="bp-dz-muted bp-dz-pad">新建另一个布局后可嵌套。</div>}
            </div>

            {armed && (
              <div className="bp-dz-armed">
                已选择 <b>{armed.kind === 'record' || armed.kind === 'array' ? (armsLayoutName(armed, layouts) ?? armed.kind) : (KIND_LABEL[armed.kind] ?? armed.kind)}</b>：点击画布空白处放置
                <button type="button" onClick={() => actions.setArmed(null)}>取消</button>
              </div>
            )}
            <div className="bp-dz-side-hint">
              <b>虚线</b>字段按声明顺序自动排布；拖动主体会锚定到具体偏移。<br />
              <b>实线</b>字段已固定；拖动重排手柄只改自动顺序。
            </div>
          </aside>

          <main className="bp-dz-center">
            <div className="bp-dz-canvas-bar">
              <div className="bp-dz-canvas-title">
                {current ? <><b>{current.name}</b><span>{build?.size ?? 0} B</span><span>{current.fields.length} 字段</span>{current.union && <span>联合</span>}<span className={overlapCount ? 'bad' : 'ok'}>{overlapCount ? `重叠 ${overlapCount}` : '无重叠'}</span></> : <b>选择或新建布局</b>}
              </div>
              <div className="bp-dz-legend"><span><i className="auto" />自动</span><span><i className="anchor" />锚定</span></div>
              <span className="grow" />
              <button className="bp-dz-mini" type="button" data-insert-trigger onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openInsert(r.left, r.bottom + 6, firstFree, e.currentTarget);
              }} disabled={!current}>插入字段</button>
              <button className="bp-dz-mini" type="button" onClick={() => actions.setProblemsPane('problems')}>问题 {problems.length}</button>
              <button className="bp-dz-mini" type="button" onClick={actions.toggleTable}>{tableOpen ? '收起字段表' : '展开字段表'}</button>
            </div>

            {!current ? (
              <div className="bp-dz-center-empty">
                {stack.length > 0 ? (
                  <><b>布局不存在</b><span>当前路径指向的布局已被删除或不在文档里。</span>
                    <div>
                      <button className="btn" onClick={() => onNavigate(stack.slice(0, -1))}>返回上级</button>
                      <button className="btn" onClick={() => onNavigate([])}>选择布局</button>
                      <button className="btn primary" onClick={onClose}>返回蓝图</button>
                    </div>
                  </>
                ) : layouts.length ? (
                  <><b>选择一个布局开始</b><span>左侧布局列表显示长度和引用数；也可以新建布局。</span>
                    <div><button className="btn primary" onClick={actions.createLayout}>新建布局</button><button className="btn" onClick={() => actions.openDialog({ kind: 'import' })}>粘贴声明</button></div>
                  </>
                ) : (
                  <><b>还没有结构布局</b><span>新建布局，或从「导入」粘贴 C / TypeScript 声明。</span>
                    <div><button className="btn primary" onClick={actions.createLayout}>新建布局</button><button className="btn" onClick={() => actions.openDialog({ kind: 'import' })}>粘贴声明</button></div>
                  </>
                )}
              </div>
            ) : view === 'byte' ? <ByteCanvas /> : <BitLanes />}
            <FieldTable />
          </main>

          <DesignerInspector />
        </div>

        <footer className="bp-dz-status">
          <span>总长 <b>{build?.size ?? 0} B</b></span>
          <span>已用 <b>{usedBytes} B</b></span>
          <span>空闲 <b>{build ? build.size - usedBytes : 0} B</b></span>
          <span className={overlapCount ? 'bad' : 'ok'}>{overlapCount ? `字节重叠 ${byteOverlapCount} · 位域重叠 ${bitOverlapCount}` : '无重叠'}</span>
          <span>{current?.fields.length ?? 0} 字段</span>
          <span className="grow" />
          <span>{selectedLabel}{selectedOffset !== undefined ? ` @ ${hex(selectedOffset)}` : ''}</span>
          <span>{problems.length ? `问题 ${problems.length}` : '无问题'}</span>
          <span>{Math.round(zoom * 100)}%</span>
          <span className="bp-dz-muted">本地设计 · {currentRefs.length} 引用</span>
        </footer>

        {toast && <div className={`bp-dz-toast ${toast.tone}`} role="status">{toast.message}</div>}
        {menu && (
          <ContextMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onInsert={() => { openInsert(menu.x, menu.y, menu.offset); setMenu(null); }}
          />
        )}
        {insert && (
          <InsertPopover
            insert={insert}
            onClose={closeInsert}
            onPick={insertField}
          />
        )}
        {dialog && <DesignerDialogModal dialog={dialog} onClose={() => setDialog(null)} />}
        {confirm && (
          <ConfirmModal
            request={confirm}
            onClose={() => setConfirm(null)}
          />
        )}
      </div>
    </DesignerContext.Provider>
  );

  return createPortal(content, document.body);
}

function armsLayoutName(spec: FieldInput, layouts: BinaryLayout[]): string | undefined {
  if (!spec.of?.startsWith('layout/')) return undefined;
  const id = spec.of.slice('layout/'.length);
  return layouts.find(l => l.id === id)?.name;
}

function ContextMenu({ menu, onClose, onInsert }: {
  menu: { x: number; y: number; fieldId?: string; bitsKey?: string; offset?: number };
  onClose: () => void;
  onInsert: () => void;
}) {
  const { state, actions } = useDesigner();
  const field = menu.fieldId ? state.current?.fields.find(f => f.id === menu.fieldId) : undefined;
  const positioned = menu.fieldId ? state.build?.fields.find(f => f.id === menu.fieldId) : undefined;
  const group = menu.bitsKey ? state.build?.bitGroups.find(g => g.key === menu.bitsKey) : undefined;
  const auto = field ? field.at === undefined || field.at === '' : false;
  const index = field ? state.current?.fields.findIndex(f => f.id === field.id) ?? -1 : -1;
  const fieldCount = state.current?.fields.length ?? 0;
  const item = (label: string, run: () => void, danger = false) => (
    <button key={label} type="button" className={danger ? 'danger' : ''} onClick={() => { run(); onClose(); }}>{label}</button>
  );
  return (
    <>
      <div className="bp-dz-menu-scrim" onPointerDown={onClose} />
      <div className="bp-dz-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
        {field && positioned && (
          <>
            {item('选中字段', () => actions.selectFields([field.id], field.id))}
            {item('改名', () => { actions.selectFields([field.id], field.id); window.setTimeout(() => (document.querySelector('.bp-dz-right input[aria-label="字段名称"]') as HTMLInputElement | null)?.focus(), 0); })}
            {item('复制', () => actions.copyFields([field.id]))}
            {item('重复', () => actions.duplicateFields([field.id]))}
            {auto ? item('锚定到当前偏移', () => actions.anchorFields([field.id])) : item('恢复自动', () => actions.restoreAuto([field.id]))}
            {auto && index > 0 && item('上移自动顺序', () => actions.reorderFields([field.id], index - 1))}
            {auto && index >= 0 && index < fieldCount - 1 && item('下移自动顺序', () => actions.reorderFields([field.id], index + 1))}
            {(field.kind === 'record' || field.kind === 'array') && field.of?.startsWith('layout/') && item('进入子布局', () => actions.enterLayout(field.of!.slice('layout/'.length)))}
            {item('删除字段', () => actions.deleteFields([field.id]), true)}
          </>
        )}
        {group && (
          <>
            {item('选中位域组', () => actions.selectGroup(group.key))}
            {item('添加位域', () => actions.addBit(group.key))}
            {item('删除整组', () => actions.deleteFields(group.members.map(m => m.id)), true)}
          </>
        )}
        {!field && !group && (
          <>
            {item('在这里插入字段', onInsert)}
            {actions.hasClipboard && item('粘贴字段', () => actions.pasteFields(menu.offset))}
          </>
        )}
      </div>
    </>
  );
}

function parseOffsetInput(text: string): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const value = /^0x/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function InsertPopover({ insert, onClose, onPick }: {
  insert: { x: number; y: number; offset?: number };
  onClose: () => void;
  onPick: (spec: FieldInput, offset?: number) => void;
}) {
  const { state } = useDesigner();
  const [offsetText, setOffsetText] = useState(insert.offset !== undefined ? String(insert.offset) : '');
  const parsed = offsetText.trim() ? parseOffsetInput(offsetText) : insert.offset;
  const invalid = offsetText.trim() !== '' && parsed === null;
  const pick = (spec: FieldInput) => {
    if (invalid || parsed === null) return;
    onPick(spec, parsed);
  };
  return (
    <>
      <div className="bp-dz-menu-scrim" onPointerDown={onClose} />
      <div className="bp-dz-insert" style={{ left: insert.x, top: insert.y }} role="dialog" aria-label="插入字段">
        <div className="bp-dz-insert-head"><b>插入字段</b><span className="mono">{parsed !== undefined && parsed !== null ? hex(parsed) : '自动'}</span></div>
        <label className="bp-dz-insert-offset">
          <span>偏移</span>
          <input
            className={`in mono${invalid ? ' bad' : ''}`}
            aria-label="插入偏移"
            aria-invalid={invalid}
            value={offsetText}
            autoFocus
            inputMode="numeric"
            placeholder="自动"
            onChange={(e) => setOffsetText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const first = document.querySelector<HTMLButtonElement>('.bp-dz-insert-grid button:not(:disabled)');
                first?.focus();
              }
            }}
          />
          <em className={invalid ? 'bad' : ''}>{invalid ? '需要非负整数或 0x 偏移' : ''}</em>
        </label>
        <div className="bp-dz-insert-grid">
          {SCALAR_PALETTE.map(spec => (
            <button key={spec.kind} type="button" disabled={invalid} onClick={() => pick(spec)}>
              {KIND_LABEL[spec.kind] ?? spec.kind}<em>{spec.kind === 'bits' ? '1 bit' : ''}</em>
            </button>
          ))}
        </div>
        <div className="bp-dz-insert-head"><b>嵌套布局</b></div>
        <div className="bp-dz-insert-layouts">
          {state.layouts.filter(l => l.id !== state.current?.id).map(l => (
            <span key={l.id}>
              <button type="button" disabled={invalid} onClick={() => pick({ kind: 'record', of: `layout/${l.id}` })}>{l.name}</button>
              <button type="button" className="array" disabled={invalid} onClick={() => pick({ kind: 'array', of: `layout/${l.id}`, count: 2 })}>数组</button>
            </span>
          ))}
          {state.layouts.length <= 1 && <em className="bp-dz-muted">先新建另一个布局。</em>}
        </div>
      </div>
    </>
  );
}

function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}

function DesignerDialogModal({ dialog, onClose }: { dialog: DesignerDialog; onClose: () => void }) {
  const { state, actions } = useDesigner();
  const modalRef = useDialogFocus<HTMLDivElement>();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ layouts: BinaryLayout[]; problems: Array<{ line: number; column: number; message: string }> } | null>(null);
  const current = state.current;
  const source = useMemo(() => current ? layoutToPackSource(current, state.layouts) : '', [current, state.layouts]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      actions.notify('已复制 pack 源码', 'ok');
    } catch {
      actions.notify('剪贴板不可用，请从控制台复制', 'error');
      console.log(source);
    }
  };
  if (dialog.kind === 'export') {
    return (
      <div className="bp-dz-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="bp-dz-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="导出为 pack 类型">
          <div className="bp-dz-modal-head"><b>导出为 pack 类型</b><span className="pill">只读预览</span><button type="button" className="bp-dz-icon" onClick={onClose} aria-label="关闭">×</button></div>
          <div className="bp-dz-modal-body"><pre className="bp-dz-code">{source || '// 当前没有可导出的布局'}</pre></div>
          <div className="bp-dz-modal-foot"><span className="bp-dz-muted">不会修改当前布局或文档。</span><button className="btn" type="button" onClick={copy}>复制源码</button><button className="btn primary" type="button" onClick={onClose}>关闭</button></div>
        </div>
      </div>
    );
  }
  if (dialog.kind === 'templates') {
    return (
      <div className="bp-dz-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="bp-dz-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="布局模板">
          <div className="bp-dz-modal-head"><b>布局模板</b><button type="button" className="bp-dz-icon" onClick={onClose} aria-label="关闭">×</button></div>
          <div className="bp-dz-modal-body bp-dz-template-grid">
            {DESIGNER_TEMPLATES.map(t => (
              <button key={t.id} type="button" className="bp-dz-template" onClick={() => {
                const added = createTemplate(t.id, state.layouts);
                if (actions.applyImported([...state.layouts, ...added])) {
                  actions.notify(`已插入模板：${t.label}`, 'ok');
                  actions.openLayout(added[0].id);
                  onClose();
                }
              }}>{t.label}<span>{t.detail}</span></button>
            ))}
          </div>
          <div className="bp-dz-modal-foot"><span className="bp-dz-muted">模板只生成文档布局，不执行代码。</span><button className="btn primary" type="button" onClick={onClose}>关闭</button></div>
        </div>
      </div>
    );
  }
  const preview = () => {
    const result = parseDeclarations(text, state.layouts, current?.endian ?? 'little');
    setParsed(result);
  };
  const commit = () => {
    if (!parsed || parsed.problems.length || !parsed.layouts.length) return;
    const next = [...state.layouts, ...parsed.layouts];
    if (actions.applyImported(next)) {
      actions.notify(`已导入 ${parsed.layouts.length} 个布局`, 'ok');
      actions.openLayout(parsed.layouts[0].id);
      onClose();
    }
  };
  return (
    <div className="bp-dz-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bp-dz-modal wide" ref={modalRef} role="dialog" aria-modal="true" aria-label="粘贴声明生成布局">
        <div className="bp-dz-modal-head"><b>粘贴声明生成布局</b><span className="pill">不执行代码</span><button type="button" className="bp-dz-icon" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="bp-dz-modal-body">
          <textarea className="in mono bp-dz-import-text" rows={7} value={text}
            onChange={(e) => { setText(e.target.value); setParsed(null); }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
              e.preventDefault(); e.stopPropagation(); onClose();
            }}
            aria-label="粘贴结构声明" placeholder={'struct Header {\n  uint16_t count;\n  Entry entries[4];\n};'} />
          {parsed && (
            <div className={`bp-dz-import-result${parsed.problems.length ? ' bad' : ''}`}>
              {parsed.problems.length
                ? parsed.problems.map((p, i) => <div key={i}>第 {p.line} 行：{p.message}</div>)
                : <div>解析出 {parsed.layouts.length} 个布局：{parsed.layouts.map(l => l.name).join('、')}</div>}
            </div>
          )}
        </div>
        <div className="bp-dz-modal-foot">
          <span className="bp-dz-muted">只支持文档化子集；宏、条件编译和未知类型会报错。</span>
          <button className="btn" type="button" onClick={preview}>解析预览</button>
          <button className="btn primary" type="button" disabled={!parsed || !!parsed.problems.length || !parsed.layouts.length} onClick={commit}>导入</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ request, onClose }: { request: DesignerConfirm; onClose: () => void }) {
  const modalRef = useDialogFocus<HTMLDivElement>();
  return (
    <div className="bp-dz-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bp-dz-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="bp-dz-modal-head"><b>{request.title}</b><button type="button" className="bp-dz-icon" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="bp-dz-modal-body"><p className="bp-dz-confirm-text">{request.message}</p></div>
        <div className="bp-dz-modal-foot">
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className={`btn ${request.tone === 'danger' ? 'danger' : 'primary'}`} type="button" onClick={() => { request.onConfirm(); onClose(); }}>{request.confirmLabel ?? '确认'}</button>
        </div>
      </div>
    </div>
  );
}
