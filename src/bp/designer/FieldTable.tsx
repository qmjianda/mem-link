import { useEffect, useMemo, useRef, useState } from 'react';
import { useDesigner } from './context';
import type { PositionedField } from '../layouts';

const KIND_LABEL: Record<string, string> = {
  u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
  u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64',
  string: 'string', bytes: 'bytes', bits: 'bits', record: 'record', array: 'array',
};

function hex(n: number): string {
  return '0x' + Math.max(0, n).toString(16).padStart(2, '0');
}

function colorClass(field: PositionedField): string {
  if (field.kind === 'bits') return 'bits';
  if (field.kind === 'string' || field.kind === 'bytes') return 'text';
  if (field.kind === 'record' || field.kind === 'array') return 'struct';
  return '';
}

export default function FieldTable() {
  const { state, actions } = useDesigner();
  const { current, build, selection, tableOpen } = state;
  const [focusIndex, setFocusIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const tableRef = useRef<HTMLTableElement>(null);
  const fields = useMemo(() => build?.fields ?? [], [build]);

  const group = selection.kind === 'bitsGroup'
    ? build?.bitGroups.find(g => g.key === selection.key)
    : undefined;
  const selected = new Set(
    selection.kind === 'fields' ? selection.ids
      : group ? group.members.map(m => m.id)
        : [],
  );
  const primary = selection.kind === 'fields' ? selection.primary
    : group?.members[0]?.id ?? '';

  useEffect(() => {
    if (!fields.length) { setFocusIndex(0); return; }
    const idx = fields.findIndex(f => selected.has(f.id));
    if (idx >= 0 && idx !== focusIndex) setFocusIndex(idx);
  }, [fields, selection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current || !build || !tableOpen) return null;

  const selectAt = (index: number, extend: boolean) => {
    const f = fields[index];
    if (!f) return;
    setFocusIndex(index);
    if (extend && primary) {
      const a = fields.findIndex(x => x.id === primary);
      const b = fields.findIndex(x => x.id === f.id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        actions.selectFields(fields.slice(from, to + 1).map(x => x.id), primary);
        return;
      }
    }
    actions.selectFields([f.id], f.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (editing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End'
      || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const page = 10;
      let next = focusIndex;
      if (e.key === 'ArrowDown') next += 1;
      else if (e.key === 'ArrowUp') next -= 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = fields.length - 1;
      else if (e.key === 'PageDown') next += page;
      else if (e.key === 'PageUp') next -= page;
      next = Math.max(0, Math.min(fields.length - 1, next));
      selectAt(next, e.shiftKey);
      window.setTimeout(() => {
        tableRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${next}"]`)?.focus();
      }, 0);
      return;
    }
    if (e.key === 'F2' || (e.key === 'Enter' && e.shiftKey === false && (e.ctrlKey || e.metaKey))) {
      const id = fields[focusIndex]?.id;
      if (!id) return;
      e.preventDefault();
      startEdit(id);
      return;
    }
    if (e.key === 'Enter') {
      const f = fields[focusIndex];
      if (!f) return;
      e.preventDefault();
      actions.selectFields([f.id], f.id);
      actions.setView(f.kind === 'bits' ? 'bit' : 'byte');
      return;
    }
  };

  const startEdit = (id: string) => {
    const f = fields.find(x => x.id === id);
    if (!f) return;
    actions.selectFields([id], id);
    setEditing(id);
    setEditText(f.name);
  };

  const commitEdit = () => {
    if (!editing) return;
    const value = editText.trim();
    if (!value) { setEditing(null); return; }
    const ok = actions.patchField(editing, { name: value });
    setEditing(null);
    if (!ok) actions.notify('字段改名未提交；名称可能重复或为空。', 'error');
  };

  return (
    <div className="bp-dz-table-wrap">
      <div className="bp-dz-table-head">
        <b>字段表</b>
        <span>{fields.length} 项</span>
        <span className="grow" />
        <span className="bp-dz-muted">↑↓ 移动 · F2 改名 · Enter 定位</span>
      </div>
      <div className="bp-dz-table-scroll">
        <table className="bp-dz-table" ref={tableRef} onKeyDown={onKeyDown}>
          <thead>
            <tr>
              <th>#</th><th>字段</th><th>类型</th><th>偏移</th><th>大小 / 位宽</th><th>位置</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, index) => {
              const isBits = f.kind === 'bits';
              const error = build.problems.find(p => p.severity === 'error' && p.fieldId === f.id);
              return (
                <tr
                  key={f.id}
                  data-row-index={index}
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-selected={selected.has(f.id)}
                  className={`${selected.has(f.id) ? 'on' : ''} ${colorClass(f)}`}
                  onFocus={() => setFocusIndex(index)}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    if (e.ctrlKey || e.metaKey) { actions.toggleField(f.id); setFocusIndex(index); return; }
                    selectAt(index, e.shiftKey);
                  }}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest('td.name')) startEdit(f.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); startEdit(f.id); }
                  }}
                >
                  <td className="num">{index + 1}</td>
                  <td className="name">
                    <span className={`bp-dz-dot ${colorClass(f)}`} />
                    {editing === f.id ? (
                      <input
                        className="bp-dz-inline-input mono"
                        autoFocus
                        value={editText}
                        aria-label={`重命名字段 ${f.name}`}
                        onChange={(e) => setEditText(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          e.stopPropagation();
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : f.name}
                  </td>
                  <td className="num">{KIND_LABEL[f.kind] ?? f.kind}</td>
                  <td className="num">{hex(f.offset)}{isBits ? ` +${f.bits?.offset ?? 0}` : ''}</td>
                  <td className="num">{isBits ? `bit ${f.bits?.offset ?? 0}–${(f.bits?.offset ?? 0) + (f.bits?.width ?? 1) - 1}` : `${f.size} B`}</td>
                  <td className="state">{f.auto ? '自动' : '锚定'}</td>
                  <td className="state">
                    {error ? <span className="bp-dz-row-error" title={error.message}>错误</span>
                      : build.problems.some(p => p.severity === 'warning' && p.fieldId === f.id)
                        ? <span className="bp-dz-row-warn">注意</span> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
