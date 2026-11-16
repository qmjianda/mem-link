import { useEffect, useMemo, useState } from 'react';
import type { FieldDef, Pack, TransformCtx } from '../core/pack';
import { fieldId } from '../core/pack';
import { formatPackValue } from '../core/packgraph';
import { packMemApi } from '../core/packgraph';
import type { GraphNode, GraphResult } from '../core/types';
import type { WriteResult } from '../core/packedit';
import type { Memory } from '../core/mem';
import type { Selection } from '../ui/GraphCanvas';
import HexView from '../ui/HexView';
import { IconAlert, IconArrowRight, IconPin, IconX, IconZap } from '../ui/icons';
import { addr as fmtAddr, hex32 } from '../ui/format';
import { compileOverride, compileTransform, TRANSFORM_TEMPLATES, type FieldOverride } from './overrides';

interface Props {
  pack: Pack;
  graph: GraphResult;
  mem: Memory;
  selection: Selection;
  overrides: Record<string, FieldOverride>;
  compile?: (src: string) => unknown;
  onWriteField: (n: GraphNode, type: string, field: string, text: string) => WriteResult;
  onSelect: (s: Selection) => void;
  onApply: (id: string, o: FieldOverride | null) => void;
  onTogglePin: (n: GraphNode) => void;
}

function kindLabel(f: FieldDef): string {
  if (f.kind === 'string') return `string[${f.count ?? 0}]`;
  if (f.kind === 'bytes') return `bytes[${f.count ?? 0}]`;
  if (f.kind === 'bits') return `bits:${f.bits?.width ?? 0}`;
  if (f.kind === 'record') return f.of ?? 'record';
  if (f.kind === 'array') return `${f.of ?? '?'}[${f.count ?? 0}]`;
  return f.kind;
}

function nodeTitle(n: GraphNode): string {
  return `${n.type} @ ${fmtAddr(n.addr)}`;
}

export default function PackInspector({
  pack, graph, mem, selection, overrides, compile, onWriteField, onSelect, onApply, onTogglePin,
}: Props) {
  const node = selection?.kind === 'node'
    ? graph.nodes.find((n) => n.key === selection.key)
    : undefined;
  const type = node ? pack.types.find((t) => t.name === node.type) : undefined;

  if (!node || !type) {
    return <Overview pack={pack} graph={graph} mem={mem} onSelect={onSelect} />;
  }
  return (
    <NodeView
      pack={pack}
      graph={graph}
      mem={mem}
      node={node}
      type={type}
      overrides={overrides}
      compile={compile}
      onWriteField={onWriteField}
      onSelect={onSelect}
      onApply={onApply}
      onTogglePin={onTogglePin}
    />
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({
  pack, graph, mem, onSelect,
}: {
  pack: Pack; graph: GraphResult; mem: Memory; onSelect: (s: Selection) => void;
}) {
  return (
    <div className="insp">
      <div className="overview-hero">
        <h2>内存图</h2>
        <p>从根节点出发，沿字段转换后的地址递归展开。点击任意节点检查字段、编辑转换。</p>
      </div>
      <div className="stat-grid">
        <Stat k="节点" v={graph.nodes.length} />
        <Stat k="边" v={graph.edges.length} />
        <Stat k="类型" v={pack.types.length} />
        <Stat k="问题" v={graph.problems.length} tone={graph.problems.length ? 'bad' : ''} />
      </div>
      <div className="insp-body">
        <div className="mini-title">根节点</div>
        <div className="edge-list">
          {pack.roots.map((r, i) => {
            const key = `${r.address}:${r.type}`;
            const n = graph.nodes.find((x) => x.key === key);
            return (
              <button key={`${r.type}-${r.address}-${i}`} className="edge-row" onClick={() => n && onSelect({ kind: 'node', key: n.key })}>
                <span className="kind-chip link">根</span>
                <span style={{ color: 'var(--text)' }}>{r.label || r.type}</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>{fmtAddr(r.address)}</span>
              </button>
            );
          })}
        </div>
        <div className="mini-title" style={{ marginTop: 4 }}>类型</div>
        <div className="type-chips">
          {pack.types.map((t) => (
            <span key={t.name} className="type-chip" title={`${t.fields.length} 个字段`}>
              {t.name}<em>{t.size}B</em>
            </span>
          ))}
        </div>
        <div className="tip">
          缓冲区 {hex32(mem.base)}–{hex32(mem.end)} · {mem.size} B。拖入 .bin 或 .pack.ts 可替换。
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, tone = '' }: { k: string; v: number; tone?: string }) {
  return <div className={`stat ${tone}`}><span>{k}</span><b>{v}</b></div>;
}

/* -------------------------------------------------------------------- node */

function NodeView({
  pack, graph, mem, node, type, overrides, compile, onWriteField, onSelect, onApply, onTogglePin,
}: {
  pack: Pack;
  graph: GraphResult;
  mem: Memory;
  node: GraphNode;
  type: NonNullable<Pack['types'][number]>;
  overrides: Record<string, FieldOverride>;
  compile?: (src: string) => unknown;
  onWriteField: (n: GraphNode, type: string, field: string, text: string) => WriteResult;
  onSelect: (s: Selection) => void;
  onApply: (id: string, o: FieldOverride | null) => void;
  onTogglePin: (n: GraphNode) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [valueField, setValueField] = useState<string | null>(null);

  useEffect(() => { setEditing(null); setValueField(null); }, [node.key]);

  const field = useMemo(
    () => (editing ? type.fields.find((f) => f.name === editing) : undefined),
    [editing, type],
  );
  const vfield = useMemo(
    () => (valueField ? type.fields.find((f) => f.name === valueField) : undefined),
    [valueField, type],
  );

  const highlight = useMemo(() => {
    const f = hover ? type.fields.find((x) => x.name === hover) : undefined;
    if (!f) return [];
    return [{ start: node.addr + f.offset, end: node.addr + f.offset + Math.max(1, f.size ?? 1), tone: 'field' as const }];
  }, [hover, type, node.addr]);

  const out = graph.edges.filter((e) => e.from === node.key);

  return (
    <div className="insp">
      <div className="insp-head">
        <div style={{ minWidth: 0 }}>
          <div className="insp-kind">struct</div>
          <h2 style={{ margin: 0 }}>{node.type}</h2>
        </div>
        <span className="mono insp-addr">{fmtAddr(node.addr)}</span>
        <button className={`chip-btn${node.pinned ? ' on' : ''}`} onClick={() => onTogglePin(node)} title="钉住位置">
          <IconPin size={11} /> {node.pinned ? '已钉住' : '钉住'}
        </button>
      </div>

      <div className="insp-body">
        {node.ghost && (
          <div className="banner err">
            <IconAlert size={13} />
            <div><strong>幽灵节点</strong><p>{node.ghostReason}</p></div>
          </div>
        )}
        {node.transformErrors && Object.entries(node.transformErrors).map(([id, msg]) => (
          <div className="banner err" key={id}>
            <IconAlert size={13} />
            <div><strong>{id} 转换失败</strong><p>{msg}</p></div>
          </div>
        ))}

        <div className="meta-row">
          <span>{type.fields.length} 字段</span>
          <span>{node.size} B</span>
          <span>depth {node.depth}</span>
          {node.rootId && <span>root {node.rootId}</span>}
        </div>

        <div className="mini-title">字段</div>
        <div className="field-table ft5">
          <div className="ft-head">
            <span>字段</span><span>类型</span><span>偏移</span><span>原始</span><span>转换</span>
          </div>
          {type.fields.map((f) => {
            const id = fieldId(type.name, f.name);
            const raw = node.rawValues?.[id];
            const val = node.values[id];
            const ov = overrides[id];
            const hasFx = !!f.transform || !!f.follow || !!ov?.code.trim() || !!ov?.follow;
            const hot = hover === f.name || editing === f.name;
            const rawText = formatPackValue(f, raw);
            const valText = (f.follow || f.transform) && typeof val === 'number'
              ? fmtAddr(val)
              : formatPackValue(f, val);
            return (
              <div
                key={id}
                role="button"
                tabIndex={0}
                className={`ft-row${hot ? ' hot' : ''}${hasFx ? ' linky' : ''}`}
                onMouseEnter={() => setHover(f.name)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setEditing(editing === f.name ? null : f.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditing(editing === f.name ? null : f.name);
                  }
                }}
              >
                <span className="ft-name">
                  {f.follow && <i className="dot" />}
                  {f.name}
                  {hasFx && <em className="fx">fx</em>}
                </span>
                <span className="ft-type">{kindLabel(f)}</span>
                <span className="ft-off mono">+{f.offset}</span>
                <button
                  className="ft-raw mono raw-btn"
                  title="点击写入原始值"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(null);
                    setValueField(f.name);
                  }}
                >{rawText}</button>
                <span className="ft-val mono" title={hasFx ? valText : ''}>{hasFx ? valText : ''}</span>
              </div>
            );
          })}
        </div>

        {vfield && (
          <ValueEditor
            key={`${node.key}:${vfield.name}`}
            field={vfield}
            raw={node.rawValues?.[fieldId(type.name, vfield.name)]}
            onCommit={(text) => onWriteField(node, type.name, vfield.name, text)}
            onClose={() => setValueField(null)}
          />
        )}

        <div className="mini-title">字节</div>
        <div style={{ margin: '0 14px' }}>
          <HexView
            mem={mem}
            addr={node.addr}
            len={Math.max(1, node.size)}
            highlight={highlight}
            compact
            cols={8}
            onHoverAddr={() => undefined}
          />
        </div>

        {field && (
          <TransformEditor
            key={`${node.key}:${field.name}`}
            pack={pack}
            typeName={type.name}
            field={field}
            node={node}
            mem={mem}
            override={overrides[fieldId(type.name, field.name)]}
            compile={compile}
            onClose={() => setEditing(null)}
            onApply={onApply}
          />
        )}

        <div className="mini-title">出边</div>
        {!out.length && <div className="tip">没有 follow 字段，或值为 null。</div>}
        <div className="edge-list">
          {out.map((e) => {
            const f = type.fields.find((x) => fieldId(type.name, x.name) === e.fieldId);
            const target = graph.nodes.find((n) => n.key === e.to);
            return (
              <button
                key={e.id}
                className="edge-row"
                disabled={!target}
                onClick={() => target && onSelect({ kind: 'node', key: target.key })}
              >
                <span className={`kind-chip ${e.kind}`}>{e.kind}</span>
                <span>{f?.label || f?.name || e.fieldId}</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>
                  {e.kind === 'null' ? '∅ null' : e.value != null ? fmtAddr(e.value) : '—'}
                </span>
                <IconArrowRight size={11} />
              </button>
            );
          })}
        </div>

        <div className="mini-title">上下文</div>
        <dl className="kv">
          <dt>类型</dt><dd className="mono">{type.name} · {type.size} B</dd>
          <dt>地址</dt><dd className="mono">{fmtAddr(node.addr)}</dd>
          <dt>缓冲区</dt><dd className="mono">{fmtAddr(mem.base)} – {fmtAddr(mem.end)}</dd>
          <dt>字节序</dt><dd>{pack.endian === 'little' ? '小端 LE' : '大端 BE'} · {pack.pointerSize * 8} bit</dd>
        </dl>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- value editor */

function seedText(f: FieldDef, raw: unknown): string {
  if (f.kind === 'bytes' && raw instanceof Uint8Array) {
    return [...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }
  if (f.kind === 'string') return String(raw ?? '');
  if (typeof raw === 'number' && f.format === 'hex') {
    return '0x' + Math.trunc(raw).toString(16).toUpperCase();
  }
  return formatPackValue(f, raw);
}

function ValueEditor({
  field, raw, onCommit, onClose,
}: {
  field: FieldDef;
  raw: unknown;
  onCommit: (text: string) => WriteResult;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => seedText(field, raw));
  const [err, setErr] = useState<string | null>(null);
  const commit = () => {
    const r = onCommit(text);
    if (!r.ok) setErr(r.error ?? '写入失败');
    else onClose();
  };
  return (
    <div className="value-editor">
      <div className="ve-head">
        <strong>写入 {field.name}</strong>
        <span className="mono">{kindLabel(field)} @ +{field.offset}</span>
      </div>
      <input
        className="in mono"
        autoFocus
        value={text}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') onClose();
        }}
      />
      {err && <div className="ve-err">{err}</div>}
      <div className="ve-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={commit}>写入</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- transform editor */

function TransformEditor({
  pack, typeName, field, node, mem, override, compile, onClose, onApply,
}: {
  pack: Pack;
  typeName: string;
  field: FieldDef;
  node: GraphNode;
  mem: Memory;
  override?: FieldOverride;
  compile?: (src: string) => unknown;
  onClose: () => void;
  onApply: (id: string, o: FieldOverride | null) => void;
}) {
  const id = fieldId(typeName, field.name);
  const [code, setCode] = useState(override?.code ?? (field.transform ? field.transform.toString() : ''));
  const [follow, setFollow] = useState(override?.follow === null ? '' : (override?.follow ?? field.follow ?? ''));
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [hint, setHint] = useState('');

  const raw = node.rawValues?.[id];
  const rawSelf = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const f of pack.types.find((t) => t.name === typeName)?.fields ?? []) {
      o[f.name] = node.rawValues?.[fieldId(typeName, f.name)];
    }
    return o;
  }, [node, pack, typeName]);

  const runPreview = () => {
    const c = compile ? compileOverride(compile, code) : compileTransform(code);
    if (c.error) { setErr(c.error); setPreview(null); return; }
    if (!c.fn) { setErr(null); setPreview('（无转换）'); return; }
    try {
      const ctx: TransformCtx = {
        v: raw,
        addr: node.addr + field.offset,
        self: rawSelf,
        mem: packMemApi(mem),
        consts: pack.constants,
        type: typeName,
        field: field.name,
      };
      const v = c.fn(raw, ctx);
      setErr(null);
      setPreview(field.follow && typeof v === 'number' && follow
        ? `${formatPackValue(field, v)}  →  ${fmtAddr(v)}`
        : formatPackValue(field, v));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPreview(null);
    }
  };

  const apply = () => {
    if (!code.trim() && !follow) { onApply(id, null); onClose(); return; }
    const c = compile ? compileOverride(compile, code) : compileTransform(code);
    if (c.error) { setErr(c.error); return; }
    onApply(id, { code: code.trim(), follow: follow === '' ? null : follow });
    onClose();
  };

  return (
    <div className="xform">
      <div className="xform-head">
        <IconZap size={12} />
        <strong>{typeName}.{field.name}</strong>
        <span className="mono">raw {formatPackValue(field, raw)}</span>
        <button className="icon-btn" onClick={onClose} title="关闭"><IconX size={12} /></button>
      </div>

      <label className="fld">
        <span className="fld-label">模板 <em>选择后写入代码</em></span>
        <select
          className="in"
          defaultValue=""
          onChange={(e) => {
            const t = TRANSFORM_TEMPLATES.find((x) => x.id === e.target.value);
            if (!t) return;
            setCode(t.code);
            if (t.follow !== undefined) setFollow(t.follow ?? '');
            setHint(t.hint ?? '');
            setErr(null);
          }}
        >
          <option value="">自定义 / 当前</option>
          {TRANSFORM_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {hint && <p className="tip xform-hint">{hint}</p>}

      <label className="fld">
        <span className="fld-label">转换函数 <em>(v, ctx) =&gt; ...</em></span>
        <textarea
          className="in mono xform-code"
          value={code}
          spellCheck={false}
          rows={5}
          onChange={(e) => { setCode(e.target.value); setErr(null); }}
          placeholder="(v, ctx) => v < 0 ? null : ctx.consts.BASE + v * ctx.consts.STRIDE"
        />
      </label>
      <p className="tip xform-hint">不会 JS？选模板后只改数字/常量即可；复杂逻辑可让 AI 生成后粘贴。</p>

      <div className="xform-row">
        <label className="fld" style={{ flex: 1 }}>
          <span className="fld-label">follow 目标</span>
          <select className="in" value={follow} onChange={(e) => setFollow(e.target.value)}>
            <option value="">不展开（只显示）</option>
            <option value="self">self（同类型）</option>
            {pack.types.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        <button className="btn" onClick={runPreview}>预览</button>
      </div>

      {preview != null && <div className="xform-preview mono">→ {preview}</div>}
      {err && <div className="banner err" style={{ margin: '0' }}><IconAlert size={12} /><div><p>{err}</p></div></div>}

      <div className="xform-actions">
        <button className="btn primary" onClick={apply}>应用</button>
        <button className="btn" onClick={() => onApply(id, null)}>恢复 pack 定义</button>
        <span className="tip" style={{ margin: 0 }}>ctx: v / self / addr / mem / consts</span>
      </div>
    </div>
  );
}

export { nodeTitle };
