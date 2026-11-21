import { LAYOUT_FIELD_TYPES, type LayoutField, type LayoutKind, type LayoutProblem } from '../layouts';
import { useDesigner } from './context';
import DraftInput from './DraftInput';
import type { FieldPatch } from './operations';

const KIND_LABEL: Record<string, string> = {
  u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
  u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64',
  string: '字符串', bytes: '字节', bits: '位域', record: '嵌套布局', array: '数组',
};
const SCALAR_KINDS: LayoutKind[] = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'];

function hex(n: number): string {
  return '0x' + Math.max(0, n).toString(16).padStart(2, '0');
}

function cyclePath(
  layouts: readonly { id: string; name: string; fields: LayoutField[] }[],
  fromId: string,
  targetId: string,
): string[] | null {
  const byId = new Map(layouts.map(l => [l.id, l]));
  const visit = (id: string, seen: Set<string>, path: string[]): string[] | null => {
    if (id === fromId) return [...path, id];
    if (seen.has(id)) return null;
    seen.add(id);
    const layout = byId.get(id);
    if (!layout) return null;
    for (const f of layout.fields) {
      if (!f.of?.startsWith('layout/')) continue;
      const found = visit(f.of.slice('layout/'.length), seen, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  const found = visit(targetId, new Set(), []);
  return found ? [...found, targetId].map(id => byId.get(id)?.name ?? id) : null;
}

function common<T>(values: T[]): T | undefined {
  if (!values.length) return undefined;
  const first = values[0];
  return values.every(v => v === first) ? first : undefined;
}

export default function DesignerInspector() {
  const { state, actions } = useDesigner();
  const { current, build, selection, problems } = state;
  if (!current || !build) return null;
  const errorCount = problems.filter(p => p.severity === 'error').length;

  return (
    <aside className="bp-dz-right" aria-label="结构属性">
      <div className="bp-dz-tabs" role="tablist" aria-label="属性与问题">
        <button
          type="button" role="tab" aria-selected={state.problemsPane === 'inspect'}
          className={state.problemsPane === 'inspect' ? 'on' : ''}
          onClick={() => actions.setProblemsPane('inspect')}
        >属性</button>
        <button
          type="button" role="tab" aria-selected={state.problemsPane === 'problems'}
          className={state.problemsPane === 'problems' ? 'on' : ''}
          onClick={() => actions.setProblemsPane('problems')}
        >问题 <span className={errorCount ? 'bad' : ''}>{problems.length}</span></button>
      </div>
      <div className="bp-dz-inspector">
        {state.problemsPane === 'problems'
          ? <ProblemsPane problems={problems} />
          : (
            <>
              {errorCount > 0 && <div className="bp-dz-banner" role="status">{errorCount} 个错误；字段和状态栏会标出位置。</div>}
              {selection.kind === 'fields' && selection.ids.length > 1
                ? <MultiFieldsPanel />
                : selection.kind === 'fields'
                  ? <FieldPanel id={selection.primary} />
                  : selection.kind === 'bitsGroup'
                    ? <GroupPanel groupKey={selection.key} />
                    : <LayoutPanel />}
            </>
          )}
      </div>
      <div className="bp-dz-inspector-foot">
        <span className="mono">{current.id}</span>
        <span>{build.size} B · {current.fields.length} 字段</span>
      </div>
    </aside>
  );
}

function LayoutPanel() {
  const { state, actions } = useDesigner();
  const { current, build, usage } = state;
  if (!current || !build) return null;
  const refs = usage.byLayout.get(current.id) ?? [];
  const refsByKind = refs.reduce<Record<string, number>>((acc, ref) => {
    acc[ref.kind] = (acc[ref.kind] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <>
      <div className="bp-dz-insp-head">
        <span className="bp-dz-badge struct">布局</span>
        <b>{current.name || '未命名布局'}</b>
        <span className="mono muted">{build.size} B</span>
      </div>
      <section className="bp-dz-section">
        <h3>布局属性</h3>
        <label className="bp-dz-prop"><span>名称</span>
          <DraftInput value={current.name} ariaLabel="布局名称" onCommit={(v) => {
            const r = actions.patchLayout({ name: v });
            if (!r) return { ok: false, message: '布局名称无效' };
            return true;
          }} />
        </label>
        <label className="bp-dz-prop"><span>字节序</span>
          <select className="select" aria-label="布局字节序" value={current.endian} onChange={(e) => actions.patchLayout({ endian: e.target.value === 'big' ? 'big' : 'little' })}>
            <option value="little">小端</option><option value="big">大端</option>
          </select>
        </label>
        <label className="bp-dz-check"><input type="checkbox" checked={current.union === true} onChange={(e) => actions.patchLayout({ union: e.target.checked })} /> 联合视图（允许字段共享偏移）</label>
        <label className="bp-dz-prop"><span>长度覆盖</span>
          <DraftInput value={current.size ?? ''} ariaLabel="布局长度覆盖" placeholder={`自动 ${build.cursor} B`} inputMode="numeric" onCommit={(v) => {
            const r = actions.patchLayout({ size: v.trim() === '' ? null : v });
            if (!r) return { ok: false, message: '长度必须不小于字段结束位置' };
            return true;
          }} />
        </label>
        <div className="bp-dz-prop"><span>推导长度</span><div className="bp-dz-value mono">{build.cursor} B</div></div>
        <div className="bp-dz-prop"><span>字段 / 引用</span><div className="bp-dz-value mono">{current.fields.length} / {refs.length}</div></div>
        {current.size !== undefined && current.size !== '' && (
          <div className="bp-dz-warning">显式长度覆盖：后续修改不会自动缩短布局。</div>
        )}
      </section>
      <section className="bp-dz-section">
        <h3>被引用</h3>
        {refs.length ? (
          <div className="bp-dz-refs">
            {refs.map((ref, i) => (
              <button key={`${ref.kind}:${ref.id}:${i}`} type="button" onClick={() => {
                if (ref.kind === 'layout') actions.openLayout(ref.id);
                else if (ref.fieldId) actions.selectFields([ref.fieldId], ref.fieldId);
              }}>
                <span className="bp-dz-ref-kind">{({ layout: '父布局', node: '节点', edge: '连线', pack: 'pack' } as Record<string, string>)[ref.kind]}</span>
                <span className="grow">{ref.label}</span>
                {ref.detail && <em>{ref.detail}</em>}
              </button>
            ))}
          </div>
        ) : <div className="bp-dz-muted">还没有父布局、节点、连线或 pack 引用。</div>}
        {refsByKind.pack ? <div className="bp-dz-note">被 pack 通过 layoutType 引用；字段端口变化会影响 pack 节点。</div> : null}
      </section>
      <div className="bp-dz-actions">
        <button className="mini-btn" onClick={() => actions.duplicateLayout()}>复制布局</button>
        <button className="mini-btn danger" onClick={() => actions.deleteLayout()}>删除布局</button>
      </div>
    </>
  );
}

function GroupPanel({ groupKey }: { groupKey: string }) {
  const { state, actions } = useDesigner();
  const group = state.build?.bitGroups.find(g => g.key === groupKey);
  if (!group) return <div className="bp-dz-muted">位域组已不存在。</div>;
  const bits = group.unit * 8;
  return (
    <>
      <div className="bp-dz-insp-head">
        <span className="bp-dz-badge bits">位域组</span>
        <b className="mono">{hex(group.offset)}</b>
        <span className="mono muted">{group.unit} B · {bits} bit</span>
      </div>
      <section className="bp-dz-section">
        <h3>组属性</h3>
        <label className="bp-dz-prop"><span>存储单元</span>
          <select className="select" aria-label="位域组存储宽度" value={group.unit} onChange={(e) => actions.setBitUnit(group.key, Number(e.target.value))}>
            {[1, 2, 4, 8].map(n => <option key={n} value={n}>{n} B（{n * 8} bit）</option>)}
          </select>
        </label>
        <div className="bp-dz-prop"><span>已用 / 空闲</span><div className="bp-dz-value mono">{group.used} / {bits} · 空闲 {group.free}</div></div>
        {group.overlapPairs > 0 && <div className="bp-dz-error">位域区间重叠 {group.overlapPairs} 对</div>}
      </section>
      <section className="bp-dz-section">
        <h3>成员</h3>
        <div className="bp-dz-bit-members">
          {group.members.map(member => (
            <div key={member.id} className="bp-dz-bit-member">
              <button type="button" className="bp-dz-bit-member-name" onClick={() => actions.selectFields([member.id], member.id)}>{member.name}</button>
              <label>bit
                <DraftInput value={String(member.bits?.offset ?? 0)} ariaLabel={`${member.name} 位偏移`} inputMode="numeric"
                  onCommit={(v) => actions.patchField(member.id, { bit: v }) ? true : { ok: false, message: '位偏移无效或产生重叠' }} />
              </label>
              <label>宽
                <DraftInput value={String(member.bits?.width ?? 1)} ariaLabel={`${member.name} 位宽`} inputMode="numeric"
                  onCommit={(v) => actions.patchField(member.id, { width: v }) ? true : { ok: false, message: '位宽无效或超出存储单元' }} />
              </label>
              <button type="button" className="bp-dz-mini-x" aria-label={`删除 ${member.name}`} onClick={() => actions.deleteFields([member.id])}>×</button>
            </div>
          ))}
        </div>
        <div className="bp-dz-actions">
          <button className="mini-btn" onClick={() => actions.addBit(group.key)}>+ 添加位域</button>
          <button className="mini-btn danger" onClick={() => actions.deleteFields(group.members.map(m => m.id))}>删除整组</button>
        </div>
      </section>
    </>
  );
}

function FieldPanel({ id }: { id: string }) {
  const { state, actions } = useDesigner();
  const { current, build, usage } = state;
  const field = current?.fields.find(f => f.id === id);
  const positioned = build?.fields.find(f => f.id === id);
  if (!current || !field || !positioned) return <div className="bp-dz-muted">字段已不存在。</div>;
  const bitsGroup = field.kind === 'bits'
    ? build?.bitGroups.find(g => g.members.some(m => m.id === id))
    : undefined;
  const edgeRefs = usage.fieldRefs.get(`${current.id}:${id}`) ?? [];
  const edgeCount = usage.fieldEdgeCounts.get(`${current.id}:${id}`) ?? 0;
  const layoutRefs = usage.byLayout.get(current.id)?.length ?? 0;
  const auto = field.at === undefined || field.at === '';
  const otherLayouts = state.layouts.filter(l => l.id !== current.id);
  const targetValue = field.of ?? '';
  const targetLayoutValue = field.of?.startsWith('layout/') ? field.of : '';
  const cyclePaths = new Map(otherLayouts
    .map(l => [l.id, cyclePath(state.layouts, current.id, l.id)] as const)
    .filter((entry): entry is readonly [string, string[]] => !!entry[1]));

  const patch = (p: FieldPatch) => {
    const ok = actions.patchField(id, p);
    return ok ? true : { ok: false, message: '修改未提交；请检查字段值或冲突。' };
  };

  const changeKind = (kind: LayoutKind) => {
    if (kind === field.kind) return;
    if (kind === 'record' || kind === 'array') {
      if (!targetLayoutValue) {
        const target = otherLayouts.find(l => !cyclePaths.has(l.id));
        if (!target) { actions.notify('没有可用的嵌套目标（会形成循环或缺少布局）。', 'error'); return; }
        actions.patchField(id, { kind, of: `layout/${target.id}`, ...(kind === 'array' ? { count: '2' } : {}) });
      } else {
        actions.patchField(id, { kind, ...(kind === 'array' ? { count: field.count ?? '2' } : {}) });
      }
      return;
    }
    actions.patchField(id, { kind });
  };

  return (
    <>
      <div className="bp-dz-insp-head">
        <span className={`bp-dz-badge ${field.kind === 'bits' ? 'bits' : field.kind === 'string' || field.kind === 'bytes' ? 'text' : field.kind === 'record' || field.kind === 'array' ? 'struct' : ''}`}>
          {KIND_LABEL[field.kind] ?? field.kind}
        </span>
        <b>{field.name || '未命名字段'}</b>
        <span className="mono muted">{hex(positioned.offset)}</span>
      </div>
      <section className="bp-dz-section">
        <h3>字段属性</h3>
        <label className="bp-dz-prop"><span>名称</span>
          <DraftInput value={field.name} ariaLabel="字段名称" onCommit={(v) => patch({ name: v })} />
        </label>
        <label className="bp-dz-prop"><span>类型</span>
          <select className="select" aria-label="字段类型" value={field.kind} onChange={(e) => changeKind(e.target.value as LayoutKind)}>
            {LAYOUT_FIELD_TYPES.map(k => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
        </label>

        {field.kind === 'bits' && bitsGroup && (
          <>
            <div className="bp-dz-prop"><span>所属位域组</span>
              <div className="bp-dz-value"><button className="mini-btn" type="button" onClick={() => actions.selectGroup(bitsGroup.key)}>{hex(bitsGroup.offset)} · {bitsGroup.unit} B</button></div>
            </div>
            <label className="bp-dz-prop"><span>位偏移</span>
              <DraftInput value={String(field.bit ?? 0)} ariaLabel="位偏移" inputMode="numeric" onCommit={(v) => patch({ bit: v })} />
            </label>
            <label className="bp-dz-prop"><span>位宽</span>
              <DraftInput value={String(field.width ?? 1)} ariaLabel="位宽" inputMode="numeric" onCommit={(v) => patch({ width: v })} />
            </label>
          </>
        )}

        {(field.kind === 'string' || field.kind === 'bytes') && (
          <label className="bp-dz-prop"><span>长度</span>
            <DraftInput value={String(field.size ?? 1)} ariaLabel="字段长度" inputMode="numeric" onCommit={(v) => patch({ size: v })} />
          </label>
        )}

        {(field.kind === 'record' || field.kind === 'array') && (
          <>
            <label className="bp-dz-prop"><span>目标布局</span>
              <select className="select" aria-label="目标布局" value={targetValue} onChange={(e) => actions.patchField(id, { of: e.target.value })}>
                <option value="">选择布局</option>
                {field.kind === 'array' && (
                  <optgroup label="标量">
                    {SCALAR_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                  </optgroup>
                )}
                {otherLayouts.map(l => (
                  <option key={l.id} value={`layout/${l.id}`} disabled={cyclePaths.has(l.id)}
                    title={cyclePaths.get(l.id)?.join(' → ')}>
                    {l.name}{cyclePaths.has(l.id) ? '（会成环）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {cyclePaths.size > 0 && (
              <div className="bp-dz-note">已阻止成环：{[...cyclePaths.values()][0].join(' → ')}</div>
            )}
            <div className="bp-dz-note">嵌套只引用布局，不嵌入 pack 类型。</div>
            {field.kind === 'array' && (
              <label className="bp-dz-prop"><span>数量</span>
                <DraftInput value={String(field.count ?? 1)} ariaLabel="数组数量" inputMode="numeric" onCommit={(v) => patch({ count: v })} />
              </label>
            )}
          </>
        )}

        {field.kind !== 'bits' && field.kind !== 'string' && field.kind !== 'bytes' && field.kind !== 'record' && field.kind !== 'array' && (
          <>
            <label className="bp-dz-prop"><span>字节序</span>
              <select className="select" aria-label="字段字节序" value={field.endian ?? ''} onChange={(e) => actions.patchField(id, { endian: e.target.value ? e.target.value as 'little' | 'big' : null })}>
                <option value="">跟随布局</option><option value="little">小端</option><option value="big">大端</option>
              </select>
            </label>
            <label className="bp-dz-prop"><span>数值语义</span>
              <select className="select" aria-label="字段数值语义" value={field.role ?? ''} onChange={(e) => actions.patchField(id, { role: e.target.value ? e.target.value as LayoutField['role'] : null })}>
                <option value="">普通整数</option><option value="address">绝对地址</option><option value="offset">字节偏移</option><option value="index">池下标</option>
              </select>
            </label>
          </>
        )}

        <label className="bp-dz-prop"><span>偏移</span>
          <div className="bp-dz-value">
            {auto ? <span className="mono">自动 → {hex(positioned.offset)}</span> : (
              <DraftInput value={String(field.at ?? '')} ariaLabel="字段偏移" inputMode="numeric" onCommit={(v) => patch({ at: v })} />
            )}
            {auto && <button type="button" className="mini-btn" onClick={() => actions.anchorFields([id])}>锚定</button>}
            {!auto && <button type="button" className="mini-btn" onClick={() => actions.restoreAuto([id])}>恢复自动</button>}
          </div>
        </label>
        <label className="bp-dz-check"><input type="checkbox" checked={auto} onChange={(e) => {
          if (e.target.checked) actions.patchField(id, { at: null });
          else actions.patchField(id, { at: String(positioned.offset) });
        }} /> 自动排布（不写 at）</label>
      </section>

      <section className="bp-dz-section">
        <h3>显示与语义</h3>
        <label className="bp-dz-prop"><span>显示映射</span>
          <DraftInput value={field.values ? JSON.stringify(field.values) : ''} ariaLabel="显示映射 JSON" placeholder='{"0":"Idle"}'
            onCommit={(v) => {
              if (!v.trim()) return patch({ values: null });
              try {
                const parsed = JSON.parse(v) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                  || !Object.values(parsed).every(x => typeof x === 'string')) {
                  return { ok: false, message: '显示映射必须是数值到字符串的对象' };
                }
                return patch({ values: parsed as Record<string, string> });
              } catch {
                return { ok: false, message: '显示映射不是有效 JSON' };
              }
            }} />
        </label>
        <div className="bp-dz-note">显示映射只影响显示，不改变端口值和下游计算。</div>
      </section>

      <div className="bp-dz-actions">
        {(field.kind === 'record' || field.kind === 'array') && targetValue && (
          <button className="mini-btn" onClick={() => actions.enterLayout(targetValue.slice('layout/'.length))}>进入子布局</button>
        )}
        <button className="mini-btn" onClick={() => actions.copyFields([id])}>复制</button>
        <button className="mini-btn" onClick={() => actions.duplicateFields([id])}>重复</button>
        <button className="mini-btn danger" onClick={() => actions.deleteFields([id])}>删除字段</button>
      </div>
      <div className="bp-dz-insp-foot-note">
        {layoutRefs > 0 && <div className="bp-dz-warning">当前布局被 {layoutRefs} 处引用；字段端口或长度变化会影响这些入口。</div>}
        字段 ID <code>{field.id}</code> 稳定；改名或移动不会断开节点端口。
        {edgeCount > 0 && <span className="bp-dz-warning"> 当前有 {edgeCount} 条连线使用该字段。</span>}
        {edgeRefs.length > 0 && <div className="bp-dz-muted">{edgeRefs.slice(0, 3).map(r => r.label).join(' · ')}{edgeRefs.length > 3 ? ' …' : ''}</div>}
      </div>
    </>
  );
}

function MultiFieldsPanel() {
  const { state, actions } = useDesigner();
  const { current, build, selection } = state;
  if (!current || !build || selection.kind !== 'fields') return null;
  const fields = selection.ids.map(id => current.fields.find(f => f.id === id)).filter((f): f is LayoutField => !!f);
  const commonKind = common(fields.map(f => f.kind));
  const commonEndian = common(fields.map(f => f.endian ?? ''));
  const commonRole = common(fields.map(f => f.role ?? ''));
  const edgeCount = selection.ids.reduce((n, id) => n + (state.usage.fieldEdgeCounts.get(`${current.id}:${id}`) ?? 0), 0);
  return (
    <>
      <div className="bp-dz-insp-head">
        <span className="bp-dz-badge struct">多选</span>
        <b>{fields.length} 个字段</b>
        <span className="mono muted">批量操作</span>
      </div>
      <section className="bp-dz-section">
        <h3>共同属性</h3>
        <div className="bp-dz-prop"><span>类型</span><div className="bp-dz-value">{commonKind ? (KIND_LABEL[commonKind] ?? commonKind) : '混合'}</div></div>
        <label className="bp-dz-prop"><span>字节序</span>
          <select className="select" value={commonEndian ?? '__mixed'} onChange={(e) => {
            const value = e.target.value;
            if (value === '__mixed') return;
            actions.patchFields(selection.ids, { endian: value === '__follow' ? null : value as 'little' | 'big' });
          }}>
            {!commonEndian && <option value="__mixed" disabled>混合</option>}
            <option value="__follow">跟随布局</option><option value="little">小端</option><option value="big">大端</option>
          </select>
        </label>
        <label className="bp-dz-prop"><span>数值语义</span>
          <select className="select" value={commonRole ?? '__mixed'} onChange={(e) => {
            const value = e.target.value;
            if (value === '__mixed') return;
            actions.patchFields(selection.ids, { role: value === '__none' ? null : value as LayoutField['role'] });
          }}>
            {!commonRole && <option value="__mixed" disabled>混合</option>}
            <option value="__none">普通整数</option><option value="address">绝对地址</option><option value="offset">字节偏移</option><option value="index">池下标</option>
          </select>
        </label>
        <div className="bp-dz-prop"><span>连线</span><div className="bp-dz-value mono">{edgeCount} 条</div></div>
      </section>
      <section className="bp-dz-section">
        <h3>选中字段</h3>
        <div className="bp-dz-refs">
          {fields.map(f => (
            <button key={f.id} type="button" onClick={() => actions.selectFields([f.id], f.id)}>
              <span className="grow">{f.name}</span><em>{KIND_LABEL[f.kind] ?? f.kind}</em>
            </button>
          ))}
        </div>
      </section>
      <div className="bp-dz-actions">
        <button className="mini-btn" onClick={() => actions.anchorFields(selection.ids)}>批量锚定</button>
        <button className="mini-btn" onClick={() => actions.restoreAuto(selection.ids)}>批量恢复自动</button>
        <button className="mini-btn" onClick={() => actions.copyFields(selection.ids)}>复制</button>
        <button className="mini-btn" onClick={() => actions.duplicateFields(selection.ids)}>重复</button>
        <button className="mini-btn danger" onClick={() => actions.deleteFields(selection.ids)}>删除</button>
      </div>
      <div className="bp-dz-note">多选拖动不支持；请只拖动一个字段，或使用批量操作。属性修改会一次应用到一个撤销步骤。</div>
    </>
  );
}

function ProblemsPane({ problems }: { problems: LayoutProblem[] }) {
  const { actions } = useDesigner();
  if (!problems.length) return <div className="bp-dz-empty-pane"><b>没有发现问题</b><span>当前布局通过几何、引用和位域校验。</span></div>;
  return (
    <div className="bp-dz-problems" role="list">
      <div className="bp-dz-problems-head">
        <b>{problems.filter(p => p.severity === 'error').length} 错误</b>
        <span>{problems.filter(p => p.severity === 'warning').length} 警告</span>
      </div>
      {problems.map((p, i) => (
        <button key={`${p.code}:${p.layoutId}:${p.fieldId ?? ''}:${i}`} type="button" role="listitem"
          className={`bp-dz-problem ${p.severity}`}
          onClick={() => {
            if (p.fieldId) {
              actions.selectFields([p.fieldId], p.fieldId);
              if (p.code.includes('BIT')) actions.setView('bit');
              else actions.setView('byte');
            } else {
              actions.selectLayout();
            }
          }}>
          <span className="bp-dz-problem-code">{p.code}</span>
          <span className="grow">{p.message}</span>
          {p.fieldName && <em>{p.fieldName}</em>}
        </button>
      ))}
    </div>
  );
}
