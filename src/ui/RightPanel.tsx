import { useEffect, useMemo, useRef, useState } from 'react';
import type { Field, GraphEdge, GraphNode, GraphResult, Problem, Project, Schema } from '../core/types';
import type { Memory } from '../core/mem';
import { valueForms, parseValueText } from '../core/edit';
import { addr as fmtAddr, bytes as fmtBytes, fieldTypeLabel, typeLabel } from './format';
import HexView from './HexView';
import { IconAlert, IconArrowRight, IconChevron, IconCopy } from './icons';

type Tab = 'inspect' | 'convert' | 'problems';

interface Props {
  schema: Schema;
  project: Project;
  graph: GraphResult;
  mem: Memory;
  selection: { kind: 'node' | 'edge'; key?: string; id?: string } | null;
  onSelect: (s: { kind: 'node'; key: string } | { kind: 'edge'; id: string } | null) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  onEditField: (node: GraphNode, field: Field, text: string) => string | null;
  onTogglePin: (node: GraphNode) => void;
  pinned: boolean;
  onGotoProblem: (p: Problem) => void;
}

export default function RightPanel(props: Props) {
  const { graph, tab, onTab, selection } = props;
  const errorCount = graph.problems.filter((p) => p.severity === 'error').length;

  return (
    <aside className="panel right">
      <div className="panel-tabs">
        <button className={tab === 'inspect' ? 'on' : ''} onClick={() => onTab('inspect')}>检查器</button>
        <button className={tab === 'convert' ? 'on' : ''} onClick={() => onTab('convert')}>转换</button>
        <button className={tab === 'problems' ? 'on' : ''} onClick={() => onTab('problems')}>
          问题{graph.problems.length > 0 && <span className={`badge ${errorCount ? 'err' : 'warn'}`}>{graph.problems.length}</span>}
        </button>
      </div>
      <div className="panel-scroll">
        {tab === 'inspect' && <Inspector {...props} />}
        {tab === 'convert' && <Converter />}
        {tab === 'problems' && <Problems {...props} />}
      </div>
      <div className="status-foot">
        <span>{graph.stats.nodes} 节点</span>
        <span>{graph.stats.edges} 边</span>
        <span className={errorCount ? 'err-text' : ''}>{errorCount} 错误</span>
        <span className="dim">{graph.stats.ms} ms</span>
        {selection?.kind === 'node' && selection.key && <span className="dim mono">{selection.key.split(':')[0]}</span>}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------- inspector */

function Inspector({ schema, project, graph, mem, selection, onSelect, onEditField, onTogglePin, pinned }: Props) {
  const node = selection?.kind === 'node' ? graph.nodes.find((n) => n.key === selection.key) : undefined;
  const edge = selection?.kind === 'edge' ? graph.edges.find((e) => e.id === selection.id) : undefined;

  if (node) return <NodeInspector node={node} schema={schema} project={project} graph={graph} mem={mem} onSelect={onSelect} onEditField={onEditField} onTogglePin={onTogglePin} pinned={pinned} />;
  if (edge) {
    const from = graph.nodes.find((n) => n.key === edge.from);
    return (
      <div className="insp">
        <div className="insp-head">
          <span className="kind-chip link">链接</span>
          <span className="mono dim">{edge.id}</span>
        </div>
        <div className="insp-body">
          <div className="edge-flow">
            <div>
              <span className="dim">from</span>
              <strong>{from?.type}</strong>
              <span className="mono">{from ? fmtAddr(from.addr) : edge.from}</span>
            </div>
            <IconArrowRight size={16} />
            <div>
              <span className="dim">to</span>
              <strong>{edge.to.split(':').pop()}</strong>
              <span className="mono">{edge.to.split(':')[0] === 'ghost' ? '未映射' : fmtAddr(Number(edge.to.split(':')[0]))}</span>
            </div>
          </div>
          <dl className="kv">
            <dt>字段</dt><dd className="mono">{edge.label}</dd>
            <dt>原值</dt><dd className="mono">{edge.value ?? '∅'}{edge.kind === 'null' ? '（空指针）' : ''}</dd>
            <dt>类型</dt><dd><span className={`kind-chip ${edge.kind}`}>{edge.kind}</span></dd>
          </dl>
          <p className="tip">点击节点可在检查器中修改字段值，修改会写回缓冲区并重新生成图。</p>
        </div>
      </div>
    );
  }
  return <Overview graph={graph} mem={mem} project={project} schema={schema} onSelect={onSelect} />;
}

function NodeInspector({
  node, schema, project, graph, mem, onSelect, onEditField, onTogglePin, pinned,
}: {
  node: GraphNode; schema: Schema; project: Project; graph: GraphResult; mem: Memory;
  onSelect: Props['onSelect'];
  onEditField: (n: GraphNode, f: Field, t: string) => string | null;
  onTogglePin: (n: GraphNode) => void; pinned: boolean;
}) {
  const [hoverField, setHoverField] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rec = schema.records[node.type];
  const fields = rec?.fields ?? [];
  const outEdges = graph.edges.filter((e) => e.from === node.key);
  const problems = graph.problems.filter((p) => p.nodeKey === node.key);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setNotice(null); setHoverField(null); }, [node.key]);

  const highlight = hoverField
    ? (() => { const f = fields.find((x) => x.id === hoverField); return f ? [{ start: node.addr + f.offset, end: node.addr + f.offset + Math.max(1, f.size) }] : []; })()
    : [];

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(`0x${node.addr.toString(16)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };

  return (
    <div className="insp">
      <div className="node-title">
        <div>
          <h2>{node.type}</h2>
          <div className="node-sub mono">
            {fmtAddr(node.addr)}
            <span className="dim"> · {node.size} B · 层 {node.depth}</span>
          </div>
        </div>
        <div className="node-actions">
          <button className="icon-btn" title="复制地址" onClick={copyAddr}>{copied ? '✓' : <IconCopy size={13} />}</button>
          <button className={`chip-btn${pinned ? ' on' : ''}`} onClick={() => onTogglePin(node)}>
            {pinned ? '已钉住' : '钉住'}
          </button>
        </div>
      </div>

      {node.ghost && (
        <div className="banner err">
          <IconAlert size={14} />
          <div>
            <strong>幽灵节点</strong>
            <p>{node.ghostReason}</p>
          </div>
        </div>
      )}

      {problems.length > 0 && (
        <div className="banner warn">
          <IconAlert size={14} />
          <div>
            {problems.map((p, i) => <p key={i}>{p.message}</p>)}
          </div>
        </div>
      )}

      {!node.ghost && (
        <>
          <div className="section-label">字段 <span className="dim">{fields.length}</span></div>
          <div className="field-table">
            <div className="ft-head">
              <span>字段</span><span>类型</span><span className="r">偏移</span><span className="r">值</span>
            </div>
            {fields.map((f) => {
              const isLink = node.links.some((l) => l.fieldId === f.id);
              return (
                <div
                  key={f.id}
                  className={`ft-row${hoverField === f.id ? ' hot' : ''}${isLink ? ' linky' : ''}`}
                  onMouseEnter={() => setHoverField(f.id)}
                  onMouseLeave={() => setHoverField(null)}
                >
                  <span className="ft-name" title={f.name}>
                    {isLink && <i className="dot" />}
                    {f.derived && <i className="fx">ƒ</i>}
                    {f.name || <em className="dim">pad</em>}
                  </span>
                  <span className="ft-type mono">{fieldTypeLabel(f)}</span>
                  <span className="ft-off mono dim">+{f.offset}</span>
                  <span className="ft-val">
                    <EditableValue
                      node={node} field={f}
                      raw={node.values[f.id]}
                      onCommit={(text) => {
                        const err = onEditField(node, f, text);
                        setNotice(err);
                        return !err;
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
          {notice && <p className="inline-err">{notice}</p>}
        </>
      )}

      <div className="section-label">字节 <span className="dim">高亮 = 悬停字段</span></div>
      <HexView
        mem={mem} addr={node.addr} len={node.ghost ? 16 : Math.max(1, node.size)} maxRows={8}
        highlight={highlight} compact
      />

      {outEdges.length > 0 && (
        <>
          <div className="section-label">出边 <span className="dim">{outEdges.length}</span></div>
          <div className="edge-list">
            {outEdges.map((e) => (
              <button key={e.id} className="edge-row" onClick={() => onSelect({ kind: 'edge', id: e.id })}>
                <span className={`kind-chip ${e.kind}`}>{e.kind === 'link' ? '→' : e.kind === 'cycle' ? '↺' : e.kind === 'null' ? '∅' : '!'}</span>
                <span className="mono">{e.label}</span>
                <span className="dim mono">{e.value ?? ''}</span>
                <span className="grow" />
                <span className="mono dim">{e.to.startsWith('ghost') ? '越界' : fmtAddr(Number(e.to.split(':')[0]))}</span>
                <IconChevron size={12} />
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-label">上下文</div>
      <dl className="kv">
        <dt>缓冲区</dt><dd className="mono">{fmtAddr(mem.base)} – {fmtAddr(mem.end)}</dd>
        <dt>指针宽度</dt><dd className="mono">{project.ptrSize * 8} bit</dd>
        <dt>字节序</dt><dd>{project.endian === 'little' ? '小端 (LE)' : '大端 (BE)'}</dd>
      </dl>
    </div>
  );
}

function EditableValue({
  node, field, raw, onCommit,
}: {
  node: GraphNode; field: Field; raw: unknown;
  onCommit: (text: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setEditing(false); }, [node.key, raw]);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    const display = node.display[field.id] ?? '—';
    const numeric = typeof raw === 'number';
    return (
      <button
        className={`val-btn mono${numeric ? '' : ' ro'}`}
        title={numeric ? '点击编辑' : '只读'}
        onClick={() => {
          if (!numeric) return;
          setText(String(raw));
          setBad(false);
          setEditing(true);
        }}
      >
        {display}
        {field.link && <i className="lnk">↗</i>}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      className={`val-input mono${bad ? ' bad' : ''}`}
      value={text}
      spellCheck={false}
      onChange={(e) => { setText(e.target.value); setBad(false); }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => { if (onCommit(text)) setEditing(false); else setBad(true); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (onCommit(text)) setEditing(false); else setBad(true);
        }
        if (e.key === 'Escape') { setEditing(false); setText(''); setBad(false); }
      }}
    />
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ graph, mem, project, schema, onSelect }: {
  graph: GraphResult; mem: Memory; project: Project; schema: Schema;
  onSelect: (s: { kind: 'node'; key: string } | null) => void;
}) {
  const errorCount = graph.problems.filter((p) => p.severity === 'error').length;
  return (
    <div className="insp">
      <div className="overview-hero">
        <h2>内存图</h2>
        <p>从根节点出发，沿着链接规则遍历。点击任意节点查看并编辑它的字段。</p>
      </div>
      <div className="stat-grid">
        <div className="stat"><b>{graph.stats.nodes}</b><span>节点</span></div>
        <div className="stat"><b>{graph.stats.edges}</b><span>边</span></div>
        <div className={`stat${errorCount ? ' bad' : ''}`}><b>{errorCount}</b><span>错误</span></div>
        <div className="stat"><b>{fmtBytes(mem.size)}</b><span>缓冲区</span></div>
      </div>

      <div className="section-label">根</div>
      <div className="root-list">
        {project.roots.length === 0 && <p className="empty-note">还没有根节点。</p>}
        {project.roots.map((r) => {
          const node = graph.nodes.find((n) => n.rootId === r.id);
          return (
            <button key={r.id} className="root-row" disabled={!node} onClick={() => node && onSelect({ kind: 'node', key: node.key })}>
              <span className="mono">{r.type}</span>
              <span className="dim">{r.label}</span>
              <span className="grow" />
              <span className="mono dim">{node ? fmtAddr(node.addr) : '未生成'}</span>
            </button>
          );
        })}
      </div>

      <div className="section-label">类型</div>
      <div className="type-chips">
        {Object.values(schema.records).map((r) => (
          <span key={r.name} className="type-chip" title={`${r.fields.length} 字段 · ${r.size} 字节`}>
            <b>{r.name}</b><span>{r.size}B</span>
          </span>
        ))}
      </div>

      <p className="tip">
        拖动节点可以固定位置，滚轮缩放画布。左侧「链接规则」决定了图如何展开。
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- problems */

function Problems({ graph, onGotoProblem }: Props) {
  const problems = graph.problems;
  if (!problems.length) {
    return (
      <div className="insp">
        <div className="empty-ok">
          <div className="ok-ring">✓</div>
          <h3>没有发现问题</h3>
          <p>所有链接都落在缓冲区范围内，类型解析也没有报错。</p>
        </div>
      </div>
    );
  }
  const errs = problems.filter((p) => p.severity === 'error');
  const warns = problems.filter((p) => p.severity !== 'error');
  return (
    <div className="insp">
      <p className="tip">点击可直接跳到出问题的节点。</p>
      {[...errs, ...warns].map((p, i) => (
        <button key={i} className={`problem ${p.severity}`} onClick={() => onGotoProblem(p)}>
          <span className="sev">{p.severity === 'error' ? 'E' : 'W'}</span>
          <span>
            <strong>{p.message}</strong>
            {p.detail && <em>{p.detail}</em>}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- converter */

type Parsed =
  | { kind: 'num'; value: number; width: number; label: string }
  | { kind: 'str'; text: string }
  | { kind: 'error'; message: string };

export function parseInput(text: string): Parsed {
  const s = text.trim();
  if (!s) return { kind: 'error', message: '输入一个数值或字符串' };
  if (/^'.*'$/s.test(s)) {
    const body = s.slice(1, -1).replace(/\\(.)/g, '$1');
    if (body.length !== 1) return { kind: 'error', message: '字符字面量只能包含一个字符' };
    return { kind: 'num', value: body.charCodeAt(0), width: 1, label: '字符字面量' };
  }
  if (/^".*"$/s.test(s)) return { kind: 'str', text: s.slice(1, -1).replace(/\\(.)/g, '$1') };
  let base = 10;
  let label = '十进制';
  let body = s;
  let neg = false;
  if (body.startsWith('-')) { neg = true; body = body.slice(1); }
  if (/^0x/i.test(body)) { base = 16; label = '十六进制'; body = body.slice(2); }
  else if (/^0b/i.test(body)) { base = 2; label = '二进制'; body = body.slice(2); }
  else if (/^0o/i.test(body)) { base = 8; label = '八进制'; body = body.slice(2); }
  if (!/^[0-9a-fA-F_]+$/.test(body) || !body.length) return { kind: 'str', text: s };
  const value = parseInt(body.replace(/_/g, ''), base);
  if (!Number.isFinite(value)) return { kind: 'error', message: '无法解析为数字' };
  const unsigned = Math.abs(value);
  const width = unsigned < 0x100 ? 1 : unsigned < 0x10000 ? 2 : unsigned < 0x100000000 ? 4 : 8;
  return { kind: 'num', value: neg ? -value : value, width, label };
}

function fmtFloat(n: number, bits: 32 | 64): string {
  const dv = new DataView(new ArrayBuffer(8));
  if (bits === 32) { dv.setUint32(0, n >>> 0, true); const v = dv.getFloat32(0, true); return Number.isFinite(v) ? trimFloat(v) : String(v); }
  dv.setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(n))), true);
  const v = dv.getFloat64(0, true);
  return Number.isFinite(v) ? trimFloat(v) : String(v);
}

function trimFloat(v: number): string {
  if (v === 0) return '0';
  const s = Math.abs(v) >= 1e-4 && Math.abs(v) < 1e7 ? v.toFixed(6) : v.toExponential(6);
  return s.replace(/\.?0+(e|$)/, '$1');
}

function Converter() {
  const [text, setText] = useState('0x1F2A');
  const parsed = useMemo(() => parseInput(text), [text]);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (v: string, key: string) => {
    try { await navigator.clipboard.writeText(v); setCopied(key); setTimeout(() => setCopied(null), 1000); } catch { /* noop */ }
  };

  const row = (label: string, value: string, key: string) => (
    <button className="conv-row" key={key} onClick={() => copy(value, key)} title="点击复制">
      <span className="conv-label">{label}</span>
      <span className="conv-value mono">{copied === key ? '已复制' : value}</span>
    </button>
  );

  return (
    <div className="insp">
      <div className="section-label">输入</div>
      <input
        className="conv-input mono"
        autoFocus
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder="0x1F2A / 1234 / 0b1010 / 'A' / 文本"
      />
      <p className="tip">{parsed.kind === 'num' ? `识别为${parsed.label}` : parsed.kind === 'str' ? '按字符串处理' : parsed.message}</p>

      {parsed.kind === 'num' && (() => {
        const f = valueForms(parsed.value, parsed.width);
        const u32 = parsed.value >>> 0;
        return (
          <>
            <div className="section-label">数值</div>
            <div className="conv-box">
              {row('十进制', f.dec, 'dec')}
              {row('十六进制', f.hex, 'hex')}
              {row('二进制', f.bin, 'bin')}
              {row('字符', f.ascii || '—', 'ascii')}
            </div>
            <div className="section-label">字节序列 <span className="dim">{parsed.width} B</span></div>
            <div className="conv-box">
              {row('小端 LE', f.bytesLE, 'le')}
              {row('大端 BE', f.bytesBE, 'be')}
            </div>
            <div className="section-label">按类型解释（0x{Math.abs(parsed.value).toString(16).toUpperCase()}）</div>
            <div className="conv-grid">
              {row('uint8', String(parsed.value & 0xff), 'u8')}
              {row('int8', String((parsed.value << 24) >> 24), 'i8')}
              {row('uint16', String(parsed.value & 0xffff), 'u16')}
              {row('int16', String((parsed.value << 16) >> 16), 'i16')}
              {row('uint32', String(u32), 'u32')}
              {row('int32', String(parsed.value | 0), 'i32')}
              {row('uint64', (BigInt.asUintN(64, BigInt(Math.trunc(parsed.value)))).toString(), 'u64')}
              {row('int64', (BigInt.asIntN(64, BigInt(Math.trunc(parsed.value)))).toString(), 'i64')}
              {row('float32', fmtFloat(parsed.value, 32), 'f32')}
              {row('float64', fmtFloat(parsed.value, 64), 'f64')}
            </div>
            <div className="section-label">其他</div>
            <div className="conv-box">
              {row('八进制', `0o${(parsed.value >>> 0).toString(8)}`, 'oct')}
              {row('UTF-8 字节', String(new TextEncoder().encode(String.fromCodePoint(parsed.value >>> 0)).length), 'ulen')}
            </div>
          </>
        );
      })()}

      {parsed.kind === 'str' && (() => {
        const codes = Array.from(parsed.text).map((c) => c.codePointAt(0) ?? 0);
        const bytes = new TextEncoder().encode(parsed.text);
        const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        const codesStr = codes.map((c) => `0x${c.toString(16).toUpperCase()}`).join(' ');
        return (
          <>
            <div className="section-label">字符串</div>
            <div className="conv-box">
              {row('长度', `${Array.from(parsed.text).length} 字符 · ${bytes.length} 字节`, 'len')}
              {row('UTF-8 HEX', hex || '—', 'hexs')}
              {row('码点', codesStr || '—', 'cp')}
              {row('C 转义', JSON.stringify(parsed.text), 'esc')}
            </div>
          </>
        );
      })()}

      <p className="tip">所有转换在本地完成。悬停右侧「检查器」中的字段可以查看它的字节高亮。</p>
    </div>
  );
}
