import { compileLayout, LAYOUT_FIELD_TYPES, MAX_LAYOUT_FIELDS, type BinaryLayout, type LayoutField } from './layouts';
import type { BPNode } from './types';

interface Props {
  node: BPNode;
  layouts: readonly BinaryLayout[];
  onCreate: () => void;
  onSelect: (id: string) => void;
  onEdit: (layout: BinaryLayout, field?: string) => void;
  onParam: (key: string, value: string) => void;
}

export default function LayoutEditor({ node, layouts, onCreate, onSelect, onEdit, onParam }: Props) {
  const selected = layouts.find(l => l.id === node.params.layoutId);
  const edit = (change: Partial<BinaryLayout>, key?: string) => {
    if (selected) onEdit({ ...selected, ...change }, key);
  };
  const patchField = (id: string, changes: Partial<LayoutField>) => {
    if (!selected) return;
    edit({ fields: selected.fields.map(f => f.id === id ? { ...f, ...changes } : f) }, `${id}:${Object.keys(changes)[0]}`);
  };
  const append = () => {
    if (!selected || selected.fields.length >= MAX_LAYOUT_FIELDS) return;
    let next = selected.nextField;
    while (selected.fields.some(f => f.id === `f${next}`)) next++;
    edit({ fields: [...selected.fields, { id: `f${next}`, name: `field${next}`, offset: '0', kind: 'u8' }], nextField: next + 1 });
  };
  let invalid: string | undefined;
  if (selected) {
    try { compileLayout(selected); } catch (err) { invalid = err instanceof Error ? err.message : String(err); }
  }
  const choose = node.params.layoutId ?? '';

  return (
    <section className="bp-layout-editor">
      <div className="bp-sub">结构布局</div>
      <label className="bp-param">
        <span>引用布局</span>
        <select className="in" aria-label="引用布局" value={choose} onChange={e => onSelect(e.target.value)}>
          <option value="">选择布局</option>
          {choose && !selected && <option value={choose}>布局已缺失</option>}
          {layouts.map(l => <option key={l.id} value={l.id}>{l.name || '未命名布局'}</option>)}
        </select>
      </label>
      <button type="button" className="bp-mini" onClick={onCreate}>新建结构布局</button>
      {selected && (
        <>
          <label className="bp-param">
            <span>布局名称</span>
            <input className="in" value={selected.name} onChange={e => edit({ name: e.target.value }, 'name')} />
          </label>
          <label className="bp-param">
            <span>结构长度 (B)</span>
            <input className="in mono" value={selected.size} onChange={e => edit({ size: e.target.value }, 'size')} />
          </label>
          <label className="bp-param">
            <span>默认字节序</span>
            <select className="in" value={selected.endian} onChange={e => edit({ endian: e.target.value === 'big' ? 'big' : 'little' })}>
              <option value="little">小端</option><option value="big">大端</option>
            </select>
          </label>
          {node.nodeId === 'listread' && (
            <label className="bp-param">
              <span>next 字段</span>
              <select className="in" value={node.params.nextField ?? ''} onChange={e => onParam('nextField', e.target.value)}>
                <option value="">选择整数字段</option>
                {selected.fields.filter(f => /^(?:[ui]\d+|bits)$/.test(f.kind))
                  .map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          )}
          <details open className="bp-layout-fields">
            <summary>字段表 · {selected.fields.length} 项（修改会应用到所有引用）</summary>
            {selected.fields.map((f, idx) => (
              <fieldset className="bp-layout-field" key={f.id}>
                <legend>字段 {idx + 1}</legend>
                <label className="bp-param"><span>字段名</span><input className="in" aria-label={`字段名 ${idx + 1}`}
                  value={f.name} onChange={e => patchField(f.id, { name: e.target.value })} /></label>
                <label className="bp-param"><span>字节偏移</span><input className="in mono" aria-label={`字段偏移 ${idx + 1}`}
                  value={f.offset} onChange={e => patchField(f.id, { offset: e.target.value })} /></label>
                <label className="bp-param"><span>类型</span><select className="in" aria-label={`字段类型 ${idx + 1}`}
                  value={f.kind} onChange={e => patchField(f.id, { kind: e.target.value as LayoutField['kind'], role: undefined })}>
                  {LAYOUT_FIELD_TYPES.map(k => <option key={k} value={k}>{({ string: 'UTF-8 字符串', bytes: '字节', bits: '位段' } as Record<string, string>)[k] ?? k}</option>)}
                </select></label>
                {['string', 'bytes', 'bits'].includes(f.kind) && <label className="bp-param">
                  <span>长度 (B)</span><input className="in mono" value={f.size ?? '1'} onChange={e => patchField(f.id, { size: e.target.value })} />
                </label>}
                {f.kind === 'bits' && <>
                  <label className="bp-param"><span>位偏移（LSB 起）</span><input className="in mono" value={f.bitOffset ?? '0'}
                    onChange={e => patchField(f.id, { bitOffset: e.target.value })} /></label>
                  <label className="bp-param"><span>位宽</span><input className="in mono" value={f.bitWidth ?? '1'}
                    onChange={e => patchField(f.id, { bitWidth: e.target.value })} /></label>
                </>}
                {f.kind !== 'string' && f.kind !== 'bytes' && <>
                  <label className="bp-param"><span>字节序</span><select className="in" value={f.endian ?? ''}
                    onChange={e => patchField(f.id, { endian: (e.target.value || undefined) as LayoutField['endian'] })}>
                    <option value="">跟随布局</option><option value="little">小端</option><option value="big">大端</option>
                  </select></label>
                  {!f.kind.startsWith('f') && <label className="bp-param"><span>数值语义</span><select className="in" value={f.role ?? ''}
                    onChange={e => patchField(f.id, { role: (e.target.value || undefined) as LayoutField['role'] })}>
                    <option value="">普通整数</option><option value="address">绝对地址</option>
                    <option value="offset">字节偏移</option><option value="index">池下标</option>
                  </select></label>}
                </>}
                <button type="button" className="bp-mini danger" aria-label={`删除字段 ${idx + 1}`}
                  onClick={() => edit({ fields: selected.fields.filter(x => x.id !== f.id) })}>删除字段</button>
              </fieldset>
            ))}
            <button type="button" className="bp-mini" disabled={selected.fields.length >= MAX_LAYOUT_FIELDS} onClick={append}>添加字段</button>
          </details>
          {invalid && <div className="bp-banner">{invalid}</div>}
        </>
      )}
    </section>
  );
}
