import type { BinaryLayout } from './layouts';
import type { StructureEntry } from './structure';
import type { BPNode } from './types';
import type { LayoutUsageIndex } from './designer/usage';

interface Props {
  node: BPNode;
  layouts: readonly BinaryLayout[];
  structures?: readonly StructureEntry[];
  usage?: LayoutUsageIndex;
  onCreate: () => void;
  onSelect: (structureId: string) => void;
  onOpen: (structureId: string) => void;
  onParam: (key: string, value: string) => void;
}

/** Compact structure picker + summary. Geometry editing lives in DesignerApp. */
export default function StructureSummary({
  node, layouts, structures, usage, onCreate, onSelect, onOpen, onParam,
}: Props) {
  const choose = node.params.structureId ?? '';
  const entry = structures?.find(s => s.id === choose);
  const packOptions = (structures ?? []).filter(s => s.source === 'pack');
  const refs = usage?.byLayout.get(choose)?.length ?? 0;
  const fields = entry?.type.fields ?? [];

  return (
    <section className="bp-layout-editor bp-structure-summary">
      <div className="bp-sub">结构布局</div>
      <label className="bp-param">
        <span>引用结构</span>
        <select className="in" aria-label="引用结构" value={choose} onChange={(e) => onSelect(e.target.value)}>
          <option value="">选择结构</option>
          {choose && !entry && <option value={choose}>结构已缺失</option>}
          {layouts.length > 0 && (
            <optgroup label="本图布局">
              {layouts.map(l => <option key={l.id} value={`layout/${l.id}`}>{l.name || '未命名布局'}</option>)}
            </optgroup>
          )}
          {packOptions.length > 0 && (
            <optgroup label="pack 类型">
              {packOptions.map(s => <option key={s.id} value={s.id}>{s.name} · {s.size} B</option>)}
            </optgroup>
          )}
        </select>
      </label>

      <div className="bp-structure-actions">
        <button type="button" className="bp-mini" onClick={onCreate}>新建结构布局</button>
        {entry?.source === 'layout' && (
          <button type="button" className="bp-mini primary" onClick={() => onOpen(entry.id)}>打开结构设计器</button>
        )}
      </div>

      {entry ? (
        <div className="bp-structure-card">
          <div className="bp-structure-card-head">
            <span className={`bp-structure-source ${entry.source}`}>{entry.source === 'layout' ? '布局' : 'pack · 只读'}</span>
            <b>{entry.name}</b>
            <span className="mono">{entry.size} B</span>
          </div>
          <div className="bp-structure-meta">
            <span>{fields.length} 字段</span>
            {entry.source === 'layout' && <span>被引用 {refs} 处</span>}
            {entry.error && <span className="bad">{entry.error}</span>}
          </div>
          {entry.source === 'pack' && (
            <div className="bp-structure-hint">pack 类型在 `.bp.ts` 中编辑；此处在设计器中只读。</div>
          )}
        </div>
      ) : (
        <div className="bp-structure-hint">{choose ? '结构已缺失，请重新选择或新建布局。' : '选择布局或 pack 类型；布局可在独立设计器中编辑几何。'}</div>
      )}

      {node.nodeId === 'listread' && entry && (
        <label className="bp-param">
          <span>next 字段</span>
          <select className="in" value={node.params.nextField ?? ''} onChange={(e) => onParam('nextField', e.target.value)}>
            <option value="">选择整数字段</option>
            {fields.filter(f => /^(?:[ui]\d+|bits)$/.test(f.kind)).map(f => (
              <option key={f.name} value={f.name}>{f.label ?? f.name}</option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
