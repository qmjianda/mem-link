import { useMemo, useRef, useState } from 'react';
import { Memory } from '../core/mem';
import type { Problem } from '../core/types';
import type { BlueprintPack, BPEdge, BPNode, BPResult } from './types';
import { builtinLabel, displayTitle, type InstanceView } from './types';
import { getBuiltin } from './builtins';
import { portsFor } from './eval';
import { base64ToBytes } from './doc';
import type { BPSelection } from './selection';
import HexView from '../ui/HexView';
import { IconAlert, IconFile, IconX } from '../ui/icons';

interface Props {
  packs: Map<string, BlueprintPack>;
  packNames: Map<string, string>;
  nodes: BPNode[];
  edges: BPEdge[];
  result: BPResult;
  selection: BPSelection;
  onSelect: (s: BPSelection) => void;
  onParam: (id: string, key: string, value: string) => void;
  onMode: (id: string, mode: 'value' | 'raw') => void;
  onDisconnect: (nodeId: string, port: string) => void;
  onDeleteEdge: (id: string) => void;
  onFile: (id: string, f: File) => void;
  onHex: (id: string, text: string) => void;
  onBase: (id: string, n: number) => void;
  /** 折叠整个检查器为 36px 竖排条 */
  onCollapse: () => void;
  /** 当前选择的规模：多选时顶部显示「已选 N 个对象」 */
  multi: { nodes: number; edges: number };
  /** F2 触发的节点重命名目标 */
  renameId?: string | null;
  onRenameDone?: () => void;
  /** 右栏页签由父级控制：顶栏错误 chip 与这里共用同一个「问题」视图 */
  tab: 'inspect' | 'problems';
  onTab: (tab: 'inspect' | 'problems') => void;
  /** 点击问题行：选中并居中节点，停留在问题列表继续排查 */
  onFocusProblem?: (nodeId: string) => void;
  /** 字段级逆向工具：复制提示与「在此地址解析」 */
  onCopy?: (text: string, label: string) => void;
  onFollow?: (addr: number, description: string) => void;
}

/** 只在 Enter / 失焦时提交一次，避免逐字符写入历史 */
function RenameInput({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <input
      className="bp-rename-input mono"
      autoFocus
      aria-label="节点名称"
      value={value}
      placeholder="节点名称"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel(); }
      }}
      onBlur={commit}
    />
  );
}

function nodeName(
  node: BPNode,
  packs: Map<string, BlueprintPack>,
  actualType?: string,
): string {
  let fallback: string;
  if (node.nodeId === 'element' && !node.packId) {
    const pack = packs.get(node.params.packId ?? '');
    const t = pack?.types[node.params.typeId ?? ''];
    const typeName = actualType ?? t?.name;
    fallback = typeName ? `元素 · ${typeName}` : builtinLabel(node.nodeId);
  } else if (node.packId === '') {
    fallback = builtinLabel(node.nodeId);
  } else {
    fallback = packs.get(node.packId)?.nodes[node.nodeId]?.label ?? node.nodeId;
  }
  return displayTitle(node, fallback);
}

/** 元素节点实际解码出的类型（未连接 / 未解码时为空）。 */
function elementTypeOf(result: BPResult, id: string): string | undefined {
  const v = result.views.get(id);
  return v?.kind === 'element' ? v.inst?.typeName : undefined;
}

/** 字段行的逆向工具：复制值 / 地址 / 十六进制，以及按字段值跳转解析。 */
export interface FieldTools {
  onCopy: (text: string, label: string) => void;
  onFollow: (addr: number, description: string) => void;
}

function FieldTable({ inst, name, tools }: {
  inst: InstanceView; name?: string; tools?: FieldTools;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const mem = inst.mem;
  const hot = hover ?? pinned;

  const copy = (text: string, label: string) => {
    const cb = navigator.clipboard;
    if (cb) void cb.writeText(text).catch(() => {});
    tools?.onCopy(text, label);
  };
  const hexOf = (f: (typeof inst.fields)[number]): string => {
    if (!mem || !mem.contains(inst.addr + f.offset, f.size)) return '';
    return [...mem.bytesAt(inst.addr + f.offset, f.size)]
      .map((b) => b.toString(16).padStart(2, '0')).join(' ');
  };
  const followable = (f: (typeof inst.fields)[number]): number | undefined => {
    const raw = typeof f.raw === 'number' ? f.raw : f.value;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    const addr = Math.trunc(raw);
    return mem?.contains(addr, 1) ? addr : undefined;
  };

  return (
    <>
      <div className="bp-inst-head">
        <span className="mono">{name ?? inst.typeName}</span>
        <span className="mono">0x{inst.addr.toString(16)} · {inst.size} B</span>
      </div>
      <table className="field-table bp-ft">
        <thead>
          <tr className="ft-head"><th>字段</th><th>类型</th><th>偏移</th><th>原始</th><th>转换</th></tr>
        </thead>
        <tbody>
          {inst.fields.map((f) => (
            <tr
              key={f.name}
              className={`ft-row ${hot === f.name ? 'hot' : ''}${pinned === f.name ? ' pinned' : ''}`}
              title="点击锁定字节高亮"
              onMouseEnter={() => setHover(f.name)}
              onMouseLeave={() => setHover(null)}
              onClick={() => setPinned((p) => (p === f.name ? null : f.name))}
            >
              <td className="ft-name mono">{f.label ?? f.name}</td>
              <td className="ft-type mono">{f.type}</td>
              <td className="ft-off mono" title={`0x${(inst.addr + f.offset).toString(16)}`}>+{f.offset}</td>
              <td className="ft-raw mono">{f.rawDisplay}</td>
              <td className="ft-val mono">{f.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 地址条放在表格之后：悬停/点选时插入内容不推移表格，鼠标命中保持稳定 */}
      {!hot && (
        <div className="bp-field-addr bp-field-hint mono">悬停字段查看字节范围 · 点击锁定高亮</div>
      )}
      {hot && (() => {
        const f = inst.fields.find((x) => x.name === hot);
        if (!f) return null;
        const addr = inst.addr + f.offset;
        const follow = followable(f);
        return (
          <div className="bp-field-addr">
            <div className="bp-field-addr-text mono" title="字段在缓冲区中的绝对地址范围">
              {f.label ?? f.name} · 0x{addr.toString(16)}–0x{(addr + f.size).toString(16)} · {f.size} B
              {pinned === hot && <em> · 已锁定</em>}
            </div>
            <div className="bp-field-tools">
              <button className="bp-ft-btn" title="复制转换值" aria-label="复制转换值"
                onClick={() => copy(String(f.value), '已复制字段值')}>值</button>
              <button className="bp-ft-btn" title="复制绝对地址" aria-label="复制绝对地址"
                onClick={() => copy(`0x${addr.toString(16)}`, '已复制地址')}>地址</button>
              <button className="bp-ft-btn" title="复制原始字节（HEX）" aria-label="复制原始字节"
                onClick={() => copy(hexOf(f), '已复制十六进制')}>HEX</button>
              {follow !== undefined && (
                <button className="bp-ft-btn go" title={`在 0x${follow.toString(16)} 解析`} aria-label="在此地址解析"
                  onClick={() => tools?.onFollow(follow, `${inst.typeName}.${f.name}`)}>在此解析 →</button>
              )}
            </div>
          </div>
        );
      })()}
      {mem && inst.size > 0 && (
        <>
          <div className="bp-sub">字节</div>
          <HexView
            mem={mem}
            addr={inst.addr}
            len={inst.size}
            compact
            maxRows={8}
            highlight={hot ? (() => {
              const f = inst.fields.find((x) => x.name === hot);
              return f ? [{ start: inst.addr + f.offset, end: inst.addr + f.offset + f.size, tone: 'field' as const }] : [];
            })() : []}
            // hex → 字段：点一个字节就选中包含它的字段，与「字段 → 字节」形成双向联动
            onPickByte={(a) => {
              const rel = a - inst.addr;
              const f = inst.fields.find((x) => rel >= x.offset && rel < x.offset + x.size);
              if (f) { setPinned(f.name); setHover(f.name); }
            }}
          />
        </>
      )}
    </>
  );
}

function FileEditor({
  node, onFile, onHex, onBase, tools,
}: {
  node: BPNode;
  onFile: (id: string, f: File) => void;
  onHex: (id: string, text: string) => void;
  onBase: (id: string, n: number) => void;
  tools?: FieldTools;
}) {
  const [hex, setHex] = useState('');
  const mem = useMemo(
    () => (node.source ? new Memory(base64ToBytes(node.source.data), node.source.base) : undefined),
    [node.source],
  );
  const [base, setBase] = useState(`0x${(node.source?.base ?? 0).toString(16)}`);
  // 缓冲区视图：起始地址（由跳转框控制）与点选的字节（hex → 画布的入口）
  const [viewAddr, setViewAddr] = useState<number | null>(null);
  const [go, setGo] = useState('');
  const [goBad, setGoBad] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const start = viewAddr ?? mem?.base ?? 0;

  /** 支持 `0x1200`、十进制，以及相对文件基址的 `+0x100` / `-0x40`。 */
  const parseGo = (text: string): number | null => {
    const t = text.trim();
    if (!t || !mem) return null;
    const rel = /^([+-])(0[xX][0-9a-fA-F]+|\d+)$/.exec(t);
    if (rel) {
      const v = /^0[xX]/.test(rel[2]) ? Number.parseInt(rel[2].slice(2), 16) : Number(rel[2]);
      return rel[1] === '-' ? mem.base - v : mem.base + v;
    }
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) return Number.parseInt(t.slice(2), 16);
    if (/^\d+$/.test(t)) return Number(t);
    return null;
  };
  const applyGo = () => {
    const v = parseGo(go);
    if (v == null || !mem) { setGoBad(true); return; }
    setGoBad(false);
    setViewAddr(Math.max(mem.base, v));
    setPicked(null);
  };

  return (
    <>
      <div className="bp-kv"><span>文件</span><b className="mono">{node.source?.name ?? '未载入'}</b></div>
      <div className="bp-kv"><span>大小</span><b className="mono">{mem?.size ?? 0} B</b></div>
      {/* 超出 2MB 写入预算时缓存里只留文件名与基址，缓冲区需重新载入 */}
      {node.source?.name && !node.source.data && (
        <div className="bp-banner">需重新载入文件</div>
      )}

      <label className="bp-file-btn wide">
        <IconFile size={13} /> 选择 .bin / .hex
        <input type="file" accept=".bin,.hex,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(node.id, f); e.currentTarget.value = ''; }} />
      </label>

      <div className="bp-sub">或粘贴 HEX</div>
      <textarea
        className="bp-hex-input mono"
        value={hex}
        onChange={(e) => setHex(e.target.value)}
        placeholder="de ad be ef 01 02 …"
        spellCheck={false}
      />
      <button className="btn" disabled={!hex.trim()} onClick={() => onHex(node.id, hex)}>载入 HEX</button>

      <label className="bp-param">
        <span>基址</span>
        <input
          className="in mono"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          onBlur={() => {
            const n = Number(base);
            if (Number.isFinite(n) && n >= 0) onBase(node.id, n);
            else setBase(`0x${(node.source?.base ?? 0).toString(16)}`);
          }}
        />
      </label>

      {mem && mem.size > 0 && (
        <>
          <div className="bp-sub">缓冲区</div>
          <div className="bp-hex-go">
            <input
              className={`in mono${goBad ? ' bad' : ''}`}
              placeholder="跳转 0x1200 / +0x100"
              aria-label="跳转到缓冲区地址"
              aria-invalid={goBad}
              title={goBad ? '无法识别的地址：支持 0x1200、十进制，或相对基址的 +0x100' : undefined}
              spellCheck={false}
              value={go}
              onChange={(e) => { setGo(e.target.value); setGoBad(false); }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); applyGo(); } }}
            />
            <button type="button" className="bp-ft-btn" onClick={applyGo}>跳转</button>
          </div>
          <HexView
            mem={mem}
            addr={start}
            len={256}
            compact
            maxRows={14}
            focusAddr={picked}
            onPickByte={(a) => setPicked(a)}
          />
          {picked != null && (
            <div className="bp-field-addr">
              <div className="bp-field-addr-text mono" title="点选的字节地址">
                选中 0x{picked.toString(16)} · 点击其它字节可切换
              </div>
              <div className="bp-field-tools">
                <button type="button" className="bp-ft-btn" title="复制地址"
                  onClick={() => tools?.onCopy(`0x${picked.toString(16)}`, '已复制地址')}>地址</button>
                <button type="button" className="bp-ft-btn go" title="以该地址为起点跟随解析"
                  onClick={() => tools?.onFollow(picked, `${node.source?.name ?? '缓冲区'} 点选字节`)}>在此解析 →</button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function NodeBody({
  node, result, onSelect, onFile, onHex, onBase, tools, onParam,
}: {
  node: BPNode;
  result: BPResult;
  onSelect: (s: BPSelection) => void;
  onFile: (id: string, f: File) => void;
  onHex: (id: string, text: string) => void;
  onBase: (id: string, n: number) => void;
  tools?: FieldTools;
  onParam?: (id: string, key: string, value: string) => void;
}) {
  const view = result.views.get(node.id);
  if (!view) return <div className="bp-empty">没有求值结果</div>;
  if (view.kind === 'calc' && node.packId === '' && node.nodeId === 'note') {
    return (
      <>
        <div className="bp-kv"><span>标记</span><b className="mono">
          {{ note: '标注', info: '说明', warn: '疑点', key: '重点' }[node.params.tone] ?? '标注'}
        </b></div>
        <label className="bp-param bp-note-edit">
          <span>内容</span>
          <textarea
            className="bp-note-area mono"
            rows={7}
            placeholder="分析结论 / 待办 / 地址含义…"
            spellCheck={false}
            value={node.params.text ?? ''}
            onChange={(e) => onParam?.(node.id, 'text', e.target.value)}
          />
        </label>
      </>
    );
  }
  if (view.kind === 'file') {
    return <FileEditor node={node} onFile={onFile} onHex={onHex} onBase={onBase} tools={tools} />;
  }
  if (view.kind === 'number') {
    return <div className="bp-kv"><span>值</span><b className="mono">{view.value}</b></div>;
  }
  if (view.kind === 'calc') {
    return (
      <div className="bp-kv-list">
        {view.error && <div className="bp-banner">{view.error}</div>}
        {Object.entries(view.outputs).map(([k, v]) => (
          <div key={k} className="bp-kv"><span>{k}</span><b className="mono">{String(v ?? '∅')}</b></div>
        ))}
        {view.detail && <pre className="bp-detail mono">{view.detail}</pre>}
      </div>
    );
  }
  if (view.kind === 'struct' || view.kind === 'element') {
    if (view.error) return <div className="bp-banner">{view.error}</div>;
    if (!view.inst) return <div className="bp-empty">没有实例</div>;
    return <FieldTable inst={view.inst} tools={tools} />;
  }
  if (view.kind === 'list' || view.kind === 'array') {
    return (
      <>
        <div className="bp-kv"><span>元素</span><b className="mono">{view.count}</b></div>
        {view.kind === 'list' && view.cycle && <div className="bp-banner">检测到回环，已停止遍历</div>}
        {view.kind === 'list' && view.truncated && <div className="bp-banner">超过最大条数，已截断</div>}
        {view.error && <div className="bp-banner">{view.error}</div>}
        <div className="bp-items">
          {view.items.map((it, i) => (
            <button
              key={`${it.addr}-${i}`}
              className="bp-item-btn"
              onClick={() => onSelect({ kind: 'entry', nodeId: node.id, index: i })}
            >
              <span className="mono">#{i}</span>
              <span className="mono">0x{it.addr.toString(16)}</span>
              <span className="mono">{String(it.fields.find((f) => f.name === 'name')?.value ?? '')}</span>
            </button>
          ))}
          {!view.items.length && <div className="bp-empty">没有读到元素</div>}
        </div>
      </>
    );
  }
  return null;
}

export default function Inspector({
  packs, packNames, nodes, edges, result, selection, onSelect, onParam, onMode,
  onDisconnect, onDeleteEdge, onFile, onHex, onBase, onCollapse, multi,
  renameId, onRenameDone, onCopy, onFollow, tab, onTab, onFocusProblem,
}: Props) {
  const problemListRef = useRef<HTMLDivElement>(null);
  const tools: FieldTools | undefined = onCopy && onFollow ? { onCopy, onFollow } : undefined;
  const node = selection?.kind === 'node'
    ? nodes.find((n) => n.id === selection.id)
    : selection?.kind === 'entry'
      ? nodes.find((n) => n.id === selection.nodeId)
      : undefined;
  const edge = selection?.kind === 'edge' ? edges.find((e) => e.id === selection.id) : undefined;
  const entry = useMemo(() => {
    if (selection?.kind !== 'entry') return undefined;
    const n = nodes.find((x) => x.id === selection.nodeId);
    const v = n ? result.views.get(n.id) : undefined;
    if (v?.kind !== 'list' && v?.kind !== 'array') return undefined;
    return v.items[selection.index];
  }, [selection, nodes, result]);

  const problems = result.problems;
  const fileCount = nodes.filter((n) => n.nodeId === 'file').length;

  /** 问题列表：↑↓ 在条目间移动焦点，Enter 由按钮自身触发定位 */
  const onProblemKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(problemListRef.current?.querySelectorAll<HTMLButtonElement>('.bp-problem') ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    rows[(at + dir + rows.length) % rows.length].focus();
  };

  return (
    <aside className="panel right bp-inspector">
      <div className="panel-tabs">
        <button className={tab === 'inspect' ? 'on' : ''} onClick={() => onTab('inspect')}>检查器</button>
        <button className={tab === 'problems' ? 'on' : ''} onClick={() => onTab('problems')}>问题 {problems.length > 0 && <em>{problems.length}</em>}</button>
        <button className="bp-fold" title="折叠检查器（Ctrl+Shift+\）" aria-label="折叠检查器" onClick={onCollapse}>»</button>
      </div>

      {tab === 'problems' ? (
        <div className="bp-insp-body" ref={problemListRef} onKeyDown={onProblemKeys}>
          <div className="bp-insp-title">问题</div>
          {!problems.length && <div className="bp-empty">没有发现问题</div>}
          {problems.map((p, i) => (
            <button
              key={i}
              className="bp-problem"
              onClick={() => {
                if (!p.nodeKey) return;
                if (onFocusProblem) onFocusProblem(p.nodeKey);
                else onSelect({ kind: 'node', id: p.nodeKey });
              }}
            >
              <span className={`bp-sev ${p.severity}`}>{p.severity === 'error' ? 'E' : 'W'}</span>
              <span>{p.message}</span>
              {p.detail && <em>{p.detail}</em>}
            </button>
          ))}
        </div>
      ) : (
        <div className="bp-insp-body">
          {multi.nodes + multi.edges > 1 && (
            <div className="bp-multi mono">
              <span>已选 {multi.nodes + multi.edges} 个对象</span>
              <em>节点 {multi.nodes} · 连线 {multi.edges}</em>
            </div>
          )}
          {!node && !edge && !entry && (
            <>
              <div className="bp-hero">未选择对象</div>
              <div className="bp-tips">
                {!fileCount && <div><b>拖入文件</b> .bin / .hex 会直接生成 File 节点</div>}
                {!packs.size && <div><b>导入 .bp.ts</b> 定义可解析的结构</div>}
                <div><b>双击端口</b> 跟随地址继续解析</div>
                <div><b>选中节点</b> 查看字段、来源与端口</div>
              </div>
              <div className="bp-stats">
                <div><b>{nodes.length}</b><span>节点</span></div>
                <div><b>{edges.length}</b><span>连线</span></div>
                <div><b>{problems.length}</b><span>问题</span></div>
              </div>
              <div className="bp-sub">Pack</div>
              {[...packs.entries()].map(([id, p]) => (
                <div key={id} className="bp-kv"><span>{packNames.get(id) ?? id}</span><b className="mono">{Object.keys(p.types).length} 类型</b></div>
              ))}
              <div className="bp-sub">文件</div>
              <div className="bp-kv"><span>File 节点</span><b className="mono">{fileCount}</b></div>
            </>
          )}

          {edge && (() => {
            const iv = result.inputs.get(edge.to.node)?.[edge.to.port];
            const spec = result.ports.get(edge.from.node)?.outputs.find((p) => p.name === edge.from.port);
            const isCtx = edge.to.port === 'buffer';
            return (
              <>
                <div className="bp-insp-head"><span>连线</span><button className="icon-btn" title="删除连线" onClick={() => onDeleteEdge(edge.id)}><IconX size={13} /></button></div>
                <div className="bp-kv"><span>从</span><b className="mono">{iv?.from?.label ?? `${edge.from.node}.${edge.from.port}`}</b></div>
                <div className="bp-kv"><span>到</span><b className="mono">{edge.to.node} · {edge.to.port}</b></div>
                <div className="bp-kv"><span>类型</span><b className="mono">{spec?.type ?? '—'}{isCtx ? ' · 数据源' : ''}</b></div>
                <div className="bp-kv"><span>当前值</span><b className="mono">{iv?.display ?? '∅'}</b></div>
                <button className="bp-unwire-btn" onClick={() => onDisconnect(edge.to.node, edge.to.port)}>断开连线</button>
              </>
            );
          })()}

          {node && (
            <>
              <div className="bp-insp-head">
                {renameId === node.id ? (
                  <RenameInput
                    key={node.id}
                    initial={node.params.__title ?? ''}
                    onCommit={(v) => { onParam(node.id, '__title', v.trim()); onRenameDone?.(); }}
                    onCancel={() => onRenameDone?.()}
                  />
                ) : (
                  <span>{nodeName(node, packs, elementTypeOf(result, node.id))}</span>
                )}
                <span className="mono">{node.packId ? (packNames.get(node.packId) ?? node.packId) : '内置'}</span>
              </div>

              {/* 任何带「数据源」端口的节点都能查看/指定来源：过去只对 pack
                  节点开放，内置的字符串读取、数组读取等反而看不到自己在用哪个文件。 */}
              {result.ports.get(node.id)?.inputs.some((p) => p.context) && (() => {
                const files = nodes.filter((n) => n.packId === '' && n.nodeId === 'file');
                const info = result.sources.get(node.id);
                const hasWire = edges.some((e) => e.to.node === node.id && e.to.port === 'buffer');
                const inherited = info?.mode === 'upstream' && !hasWire;
                const modeText: Record<string, string> = {
                  override: '手动指定',
                  explicit: '数据源直连',
                  upstream: '沿连线继承',
                  default: '默认文件',
                  file: '文件本身',
                  none: '无',
                };
                const chain = (info?.chain ?? [])
                  .map((id) => nodes.find((n) => n.id === id))
                  .filter((n): n is BPNode => !!n)
                  .map((n) => nodeName(n, packs));
                const viaNode = info?.via ? nodes.find((n) => n.id === info.via!.node) : undefined;
                return (
                  <>
                    <div className="bp-sub">数据源</div>
                    <label className="bp-param bp-src-param">
                      <span>指定数据源</span>
                      <select
                        className="in"
                        value={node.params.sourceId ?? ''}
                        onChange={(e) => onParam(node.id, 'sourceId', e.target.value)}
                      >
                        <option value="">自动（连线优先）</option>
                        {files.map((f) => (
                          <option key={f.id} value={f.id}>{f.source?.name ?? f.params.name ?? f.id}</option>
                        ))}
                      </select>
                    </label>
                    <div className="bp-kv"><span>当前</span><b className="mono">{info?.buffer?.name ?? '未载入'}</b></div>
                    <div className="bp-kv"><span>来源</span><b className="mono">{modeText[info?.mode ?? 'none']}</b></div>
                    {chain.length > 1 && (
                      <div className="bp-chain mono" title="数据源继承链">{chain.join(' → ')}</div>
                    )}
                    {info?.via && (
                      <div className="bp-kv"><span>经由</span><b className="mono">{viaNode ? nodeName(viaNode, packs) : info.via.node}.{info.via.port}</b></div>
                    )}
                    {inherited && (
                      <div className="bp-src-hint">
                        已从上游继承：画布上的数据源端点暂时隐藏；要固定用某个文件，在上方选择即可，断开上游连线后端点会重新出现。
                      </div>
                    )}
                    {hasWire && (
                      <button className="bp-unwire-btn" onClick={() => onDisconnect(node.id, 'buffer')}>断开数据源连线</button>
                    )}
                    {info?.conflict && (
                      <div className="bp-banner">数据源冲突：{(info.candidates ?? []).join(' / ')}</div>
                    )}
                    {info?.wireMissing && (
                      <div className="bp-banner">
                        数据源连线指向的来源没有文件内容——本节点不会读取任何文件。
                        给来源载入 .bin/.hex，或断开这条数据源连线。
                      </div>
                    )}
                    {info?.pinMissing && (
                      <div className="bp-banner">
                        指定的文件还没有载入内容——本节点不会读取任何文件。
                        给它载入 .bin/.hex，或把「指定数据源」改回自动。
                      </div>
                    )}
                  </>
                );
              })()}

              {node.nodeId === 'element' && (() => {
                const view = result.views.get(node.id);
                const inst = view?.kind === 'element' ? view.inst : undefined;
                const fromWire = edges.some((e) => e.to.node === node.id
                  && (e.to.port === 'instance' || e.to.port === 'list'));
                if (fromWire) {
                  // 端口跟随已连线的元素：显示实际解码结果，不提供类型选择。
                  return (
                    <>
                      <div className="bp-sub">元素类型</div>
                      <div className="bp-kv"><span>来自连线</span><b className="mono">{inst?.typeName ?? '—'}</b></div>
                      {inst && <div className="bp-kv"><span>地址</span><b className="mono">0x{inst.addr.toString(16)}</b></div>}
                      <div className="bp-kv"><span>端口</span><b className="mono">随元素类型生成</b></div>
                    </>
                  );
                }
                const boundType = inst?.typeName ?? node.params.typeId ?? '';
                if (!boundType) {
                  return (
                    <>
                      <div className="bp-sub">元素类型</div>
                      <div className="bp-kv"><span>类型</span><b className="mono">未绑定 · 空节点</b></div>
                      <div className="bp-tips">
                        <div>接「元素」或「列表 + 下标」端口后，字段随实际类型自动生成。</div>
                        <div>双击端口用「元素解析」跟随地址时，类型由来源或同地址实例推断。</div>
                      </div>
                    </>
                  );
                }
                const addr = result.inputs.get(node.id)?.address?.display ?? node.params.address ?? '未连接';
                const packName = packNames.get(node.params.packId ?? '') ?? node.params.packId ?? '';
                return (
                  <>
                    <div className="bp-sub">元素类型</div>
                    <div className="bp-kv">
                      <span>跟随类型</span>
                      <b className="mono">{packName ? `${packName} · ` : ''}{boundType}</b>
                    </div>
                    <div className="bp-kv"><span>地址</span><b className="mono">{addr}</b></div>
                    <div className="bp-tips">
                      <div>类型由「在此地址解析」按来源元素 / 同地址已知实例推断，不手动指定，避免解出错误内容。</div>
                    </div>
                  </>
                );
              })()}

              {node.nodeId === 'number' && (
                <label className="bp-param">
                  <span>值</span>
                  <input
                    className="in mono"
                    value={node.params.value ?? ''}
                    onChange={(e) => onParam(node.id, 'value', e.target.value)}
                    placeholder="0x0"
                  />
                </label>
              )}

              {!node.packId && (() => {
                const def = getBuiltin(node.nodeId);
                if (!def?.options?.length) return null;
                return (
                  <>
                    <div className="bp-sub">配置</div>
                    {def.options.map((o) => (
                      <label key={o.key} className="bp-param">
                        <span>{o.label}</span>
                        {o.kind === 'select' ? (
                          <select
                            className="in"
                            value={node.params[o.key] ?? o.default}
                            onChange={(e) => onParam(node.id, o.key, e.target.value)}
                          >
                            {o.choices?.map((c) => (
                              <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="in mono"
                            value={node.params[o.key] ?? o.default}
                            spellCheck={false}
                            onChange={(e) => onParam(node.id, o.key, e.target.value)}
                          />
                        )}
                      </label>
                    ))}
                  </>
                );
              })()}

              {(() => {
                const items = portsFor(node, packs).inputs.filter((p) => !p.context);
                if (!items.length) return null;
                return (
                  <>
                    <div className="bp-sub">输入</div>
                    {items.map((p) => {
                      const iv = result.inputs.get(node.id)?.[p.name];
                      return (
                        <label key={p.name} className="bp-param">
                          <span>{p.label}</span>
                          {iv?.wired ? (
                            <span className="bp-insp-wired">
                              <span className="mono" title={iv.from ? `来自 ${iv.from.label}` : '来自上游'}>
                                {iv.display}
                              </span>
                              <button
                                className="bp-unlink"
                                title="断开连线"
                                onClick={(e) => { e.preventDefault(); onDisconnect(node.id, p.name); }}
                              >×</button>
                            </span>
                          ) : p.type === 'number' || p.type === 'string' ? (
                            <input
                              className="in mono"
                              value={node.params[p.name] ?? ''}
                              onChange={(e) => onParam(node.id, p.name, e.target.value)}
                              placeholder={p.type === 'number' ? '0x0' : '文本'}
                            />
                          ) : (
                            <span className="bp-port-type mono">{p.type} · 待连线</span>
                          )}
                        </label>
                      );
                    })}
                  </>
                );
              })()}

              {(node.packId && packs.get(node.packId)?.nodes[node.nodeId]?.kind !== 'calc' && node.nodeId !== 'number') && (
                <div className="bp-mode">
                  <span>字段端口</span>
                  <div className="seg">
                    <button className={node.portMode !== 'raw' ? 'on' : ''} onClick={() => onMode(node.id, 'value')}>转换值</button>
                    <button className={node.portMode === 'raw' ? 'on' : ''} onClick={() => onMode(node.id, 'raw')}>原始值</button>
                  </div>
                </div>
              )}

              <NodeBody node={node} result={result} onSelect={onSelect} onFile={onFile} onHex={onHex} onBase={onBase} tools={tools} onParam={onParam} />

              {entry && (
                <>
                  <div className="bp-sub">选中的元素</div>
                  <FieldTable inst={entry} name={`${entry.typeName} #${entry.index ?? 0}`} tools={tools} />
                </>
              )}
            </>
          )}

          {!node && entry && (
            <>
              <div className="bp-insp-head"><span>元素</span><span className="mono">{entry.typeName}</span></div>
              <FieldTable inst={entry} tools={tools} />
            </>
          )}

          {!node && !edge && !entry && result.problems.length > 0 && (
            <>
              <div className="bp-sub">最近的问题</div>
              {result.problems.slice(0, 5).map((p, i) => (
                <div key={i} className="bp-mini-issue"><IconAlert size={11} /> {p.message}</div>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
