import { useEffect, useRef, useState } from 'react';
import type { ParseIssue, Pool, Project, RootSpec, Schema } from '../core/types';
import { parseHexText, type Memory } from '../core/mem';
import { IconChevron, IconFile, IconPlus, IconX } from './icons';
import HexView from './HexView';
import { addr as fmtAddr, bytes as fmtBytes } from './format';

interface Props {
  project: Project;
  schema: Schema;
  issues: ParseIssue[];
  mem: Memory;
  onProject: (p: Project) => void;
  onBytes: (bytes: Uint8Array, base: number, name: string) => void;
  onRebase: (base: number) => void;
  onFile: (file: File) => void;
  onDemo: () => void;
  onExportBin: () => void;
}

type Tab = 'struct' | 'data';

export default function LeftPanel({
  project, schema, issues, mem, onProject, onBytes, onRebase, onFile, onDemo, onExportBin,
}: Props) {
  const [tab, setTab] = useState<Tab>('struct');
  return (
    <aside className="panel left">
      <div className="panel-tabs">
        <button className={tab === 'struct' ? 'on' : ''} onClick={() => setTab('struct')}>结构</button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>数据</button>
      </div>
      <div className="panel-scroll">
        {tab === 'struct'
          ? <StructureTab project={project} schema={schema} issues={issues} onProject={onProject} />
          : <DataTab project={project} mem={mem} onBytes={onBytes} onRebase={onRebase} onFile={onFile} onDemo={onDemo} onExportBin={onExportBin} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ shell */

function Section({
  title, hint, count, action, children, defaultOpen = true,
}: {
  title: string; hint?: string; count?: number; action?: React.ReactNode;
  children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`sec${open ? ' open' : ''}`}>
      <header className="sec-head" onClick={() => setOpen((o) => !o)}>
        <IconChevron size={12} className="sec-chev" />
        <span className="sec-title">{title}</span>
        {count != null && <span className="sec-count">{count}</span>}
        <span className="sec-fill" />
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </header>
      {hint && open && <p className="sec-hint">{hint}</p>}
      {open && <div className="sec-body">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------- structure */

function StructureTab({
  project, schema, issues, onProject,
}: { project: Project; schema: Schema; issues: ParseIssue[]; onProject: (p: Project) => void }) {
  const errs = issues.filter((i) => i.severity === 'error');
  const recNames = Object.keys(schema.records);

  const set = (patch: Partial<Project>) => onProject({ ...project, ...patch });

  return (
    <>
      <Section
        title="C 类型定义"
        count={recNames.length}
        hint="直接粘贴 C 声明。支持 typedef、位域、数组、嵌套、#pragma pack。"
      >
        <SourceEditor
          value={project.source}
          onCommit={(source) => set({ source })}
        />
        <div className="parse-line">
          {errs.length === 0 ? (
            <span className="ok-dot">解析通过</span>
          ) : (
            <span className="bad-dot">{errs.length} 个错误</span>
          )}
          <span className="dim">{recNames.length} 个类型 · {Object.values(schema.records).reduce((a, r) => a + r.size, 0)} B 声明总量</span>
        </div>
        <div className="parse-opts">
          <label>
            指针
            <select className="in" value={project.ptrSize} onChange={(e) => set({ ptrSize: Number(e.target.value) === 8 ? 8 : 4 })}>
              <option value={4}>32 位</option>
              <option value={8}>64 位</option>
            </select>
          </label>
          <label>
            字节序
            <select className="in" value={project.endian} onChange={(e) => set({ endian: e.target.value === 'big' ? 'big' : 'little' })}>
              <option value="little">小端 LE</option>
              <option value="big">大端 BE</option>
            </select>
          </label>
        </div>
        {issues.length > 0 && (
          <ul className="issue-list">
            {issues.slice(0, 4).map((i, k) => (
              <li key={k} className={i.severity}>
                <span>{i.line != null ? `L${i.line}` : '—'}</span>{i.message}
              </li>
            ))}
            {issues.length > 4 && <li className="dim">还有 {issues.length - 4} 条…</li>}
          </ul>
        )}
      </Section>

      <Section
        title="内存池"
        count={project.pools.length}
        hint="池把「下标」换算成地址：addr = base + idx × stride。"
        action={
          <button className="icon-btn" title="添加内存池" onClick={() => set({ pools: [...project.pools, newPool(recNames)] })}>
            <IconPlus size={13} />
          </button>
        }
      >
        {project.pools.length === 0 && <p className="empty-note">还没有内存池。用指针的链表不需要它。</p>}
        {project.pools.map((pool, i) => (
          <div className="pool-card" key={i}>
            <div className="pool-top">
              <input
                className="in name" value={pool.name} spellCheck={false}
                onChange={(e) => set({ pools: replace(project.pools, i, { ...pool, name: e.target.value }) })}
                placeholder="池名"
              />
              <select
                className="in type" value={pool.type}
                onChange={(e) => set({ pools: replace(project.pools, i, { ...pool, type: e.target.value }) })}
              >
                {recNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button className="icon-btn danger" title="删除" onClick={() => set({ pools: project.pools.filter((_, k) => k !== i) })}>
                <IconX size={12} />
              </button>
            </div>
            <div className="pool-grid">
              <Field label="base">
                <input
                  className="in mono" value={pool.base} spellCheck={false}
                  onChange={(e) => set({ pools: replace(project.pools, i, { ...pool, base: e.target.value }) })}
                />
              </Field>
              <Field label="stride">
                <input
                  className="in mono" type="number" min={1} value={pool.stride}
                  onChange={(e) => set({ pools: replace(project.pools, i, { ...pool, stride: Math.max(1, Number(e.target.value) || 1) }) })}
                />
              </Field>
              <Field label="count">
                <input
                  className="in mono" type="number" min={1} value={pool.count}
                  onChange={(e) => set({ pools: replace(project.pools, i, { ...pool, count: Math.max(1, Number(e.target.value) || 1) }) })}
                />
              </Field>
            </div>
            <div className="pool-preview">
              {project.pools[i].base} + idx × {pool.stride}
              <span className="dim"> · {pool.count} 项</span>
            </div>
          </div>
        ))}
      </Section>

      <Section
        title="根节点"
        count={project.roots.length}
        hint="从这些地址开始遍历。地址可以写表达式，如 0x100 + u16(2) * 24。"
        action={
          <button className="icon-btn" title="添加根" onClick={() => set({ roots: [...project.roots, newRoot(project.roots, recNames)] })}>
            <IconPlus size={13} />
          </button>
        }
      >
        {project.roots.map((root, i) => (
          <div className="root-card" key={root.id}>
            <div className="root-top">
              <input
                className="in name" value={root.label} spellCheck={false}
                onChange={(e) => set({ roots: replace(project.roots, i, { ...root, label: e.target.value }) })}
                placeholder="标签"
              />
              <select
                className="in type" value={root.type}
                onChange={(e) => set({ roots: replace(project.roots, i, { ...root, type: e.target.value }) })}
              >
                {recNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button className="icon-btn danger" title="删除" onClick={() => set({ roots: project.roots.filter((_, k) => k !== i) })}>
                <IconX size={12} />
              </button>
            </div>
            <div className="root-grid">
              <Field label="addr">
                <input
                  className="in mono" value={root.addr} spellCheck={false}
                  onChange={(e) => set({ roots: replace(project.roots, i, { ...root, addr: e.target.value }) })}
                />
              </Field>
              <Field label="count">
                <input
                  className="in mono" type="number" min={1} value={root.count ?? 1}
                  onChange={(e) => set({ roots: replace(project.roots, i, { ...root, count: Math.max(1, Number(e.target.value) || 1) }) })}
                />
              </Field>
            </div>
          </div>
        ))}
      </Section>

      <Section
        title="链接规则"
        count={Object.keys(project.links).length}
        hint="哪些字段指向下一个节点，以及下标如何换算成地址。"
        action={
          <button className="icon-btn" title="添加链接" onClick={() => addLink(project, schema, set)}>
            <IconPlus size={13} />
          </button>
        }
      >
        {Object.keys(project.links).length === 0 && (
          <p className="empty-note">还没有链接规则。添加一条让图沿着字段展开。</p>
        )}
        {Object.entries(project.links).map(([key, spec]) => {
          const [recName, fieldName] = key.split('.');
          const rec = schema.records[recName];
          const fields = rec ? rec.fields.filter((f) => !f.derived) : [];
          return (
            <div className="link-card" key={key}>
              <div className="link-top">
                <span className="link-key">{key}</span>
                <button className="icon-btn danger" title="删除" onClick={() => {
                  const next = { ...project.links };
                  delete next[key];
                  onProject({ ...project, links: next });
                }}>
                  <IconX size={12} />
                </button>
              </div>
              <div className="link-grid">
                <Field label="目标">
                  <select
                    className="in" value={spec.target}
                    onChange={(e) => onProject({ ...project, links: { ...project.links, [key]: { ...spec, target: e.target.value } } })}
                  >
                    <option value="@abs">绝对地址</option>
                    {project.pools.map((p) => <option key={p.name} value={p.name}>池 · {p.name}</option>)}
                  </select>
                </Field>
                <Field label="目标类型">
                  <select
                    className="in" value={spec.type ?? ''}
                    onChange={(e) => onProject({ ...project, links: { ...project.links, [key]: { ...spec, type: e.target.value || undefined } } })}
                  >
                    <option value="">自动</option>
                    {recNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="表达式" hint="v = 字段原值">
                <input
                  className="in mono" value={spec.expr} spellCheck={false}
                  onChange={(e) => onProject({ ...project, links: { ...project.links, [key]: { ...spec, expr: e.target.value } } })}
                />
              </Field>
              <div className="link-fields">
                {fields.length > 0 && (
                  <select
                    className="in" value={fieldName}
                    onChange={(e) => {
                      const nk = `${recName}.${e.target.value}`;
                      if (nk === key) return;
                      const next = { ...project.links };
                      next[nk] = spec;
                      delete next[key];
                      onProject({ ...project, links: next });
                    }}
                  >
                    {fields.map((f) => <option key={f.id} value={f.name}>{f.name || '(anon)'}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </Section>

      <p className="panel-foot">全部解析在浏览器本地完成，数据不会离开这台机器。</p>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fld">
      <span className="fld-label">{label}{hint && <em>{hint}</em>}</span>
      {children}
    </label>
  );
}

function SourceEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<number | null>(null);
  const lastValue = useRef(value);

  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setText(value);
    }
  }, [value]);

  const commit = (v: string) => {
    lastValue.current = v;
    onCommit(v);
  };

  const change = (v: string) => {
    setText(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(v), 320);
  };

  return (
    <div className="src-editor">
      <textarea
        value={text}
        spellCheck={false}
        wrap="off"
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          if (timer.current) window.clearTimeout(timer.current);
          if (text !== lastValue.current) commit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (timer.current) window.clearTimeout(timer.current);
            commit(text);
          }
        }}
      />
      <div className="src-hint">⌘/Ctrl + ↵ 立即应用</div>
    </div>
  );
}

/* ------------------------------------------------------------------ data */

function DataTab({
  project, mem, onBytes, onRebase, onFile, onDemo, onExportBin,
}: {
  project: Project; mem: Memory;
  onBytes: (b: Uint8Array, base: number, name: string) => void;
  onRebase: (base: number) => void;
  onFile: (f: File) => void;
  onDemo: () => void; onExportBin: () => void;
}) {
  const [baseText, setBaseText] = useState(`0x${mem.base.toString(16)}`);
  const [hexText, setHexText] = useState('');
  const [hexErr, setHexErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setBaseText(`0x${mem.base.toString(16)}`), [mem.base]);

  const applyBase = () => {
    const t = baseText.trim();
    const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, 10);
    if (Number.isFinite(v) && v >= 0) onRebase(v);
    else setBaseText(`0x${mem.base.toString(16)}`);
  };

  const applyHex = () => {
    const r = parseHexText(hexText);
    if (r.error) { setHexErr(r.error); return; }
    setHexErr(null);
    onBytes(r.bytes, mem.base, '粘贴的数据');
  };

  return (
    <>
      <Section title="缓冲区" count={mem.size} hint="拖入 .bin / .hex 文件，或直接粘贴十六进制字节。">
        <div className="dropzone" onClick={() => fileRef.current?.click()}>
          <IconFile size={18} />
          <div>
            <strong>选择二进制文件</strong>
            <span>.bin · .hex · .json（项目）</span>
          </div>
          <input
            ref={fileRef} type="file" hidden accept=".bin,.hex,.json,.txt,application/octet-stream"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
          />
        </div>
        <div className="kv-row">
          <span>基址</span>
          <input
            className="in mono small" value={baseText}
            onChange={(e) => setBaseText(e.target.value)}
            onBlur={applyBase}
            onKeyDown={(e) => e.key === 'Enter' && applyBase()}
          />
          <span className="dim mono">{fmtAddr(mem.base)} – {fmtAddr(mem.end)} · {fmtBytes(mem.size)}</span>
        </div>
        <div className="row-actions">
          <button className="btn tiny" onClick={onDemo}>载入示例</button>
          <button className="btn tiny" onClick={onExportBin}>导出 .bin</button>
        </div>
      </Section>

      <Section title="粘贴 HEX" defaultOpen={false} hint="支持纯 hex、0x 列表、带 ASCII 列的 hexdump。">
        <textarea
          className="hex-input" placeholder={'41 42 43 0d 0a\n0x41, 0x42, 0x43'}
          value={hexText} spellCheck={false}
          onChange={(e) => setHexText(e.target.value)}
        />
        <div className="row-actions">
          <button className="btn tiny primary" onClick={applyHex}>解析并载入</button>
          <span className="dim">按当前基址 {fmtAddr(mem.base)} 放置</span>
        </div>
        {hexErr && <p className="inline-err">{hexErr}</p>}
      </Section>

      <Section title="缓冲区预览" count={Math.min(4096, mem.size)} defaultOpen>
        <HexView mem={mem} addr={mem.base} len={Math.min(mem.size, 4096)} maxRows={32} compact />
        {mem.size > 4096 && <p className="empty-note">仅显示前 4096 字节（共 {fmtBytes(mem.size)}）</p>}
      </Section>

      <p className="panel-foot">数据结构版本 {project.version} · {project.ptrSize * 8} 位指针 · {project.endian === 'little' ? '小端' : '大端'}</p>
    </>
  );
}

/* ----------------------------------------------------------------- utils */

function replace<T>(arr: T[], i: number, v: T): T[] {
  const next = arr.slice();
  next[i] = v;
  return next;
}

function newPool(recs: string[]): Pool {
  return { name: `Pool${Math.floor(Math.random() * 90 + 10)}`, base: '0x0', stride: 16, count: 8, type: recs[0] ?? '' };
}

function newRoot(roots: RootSpec[], recs: string[]): RootSpec {
  return { id: `r${roots.length + 1}_${Math.floor(Math.random() * 999)}`, label: `根 ${roots.length + 1}`, type: recs[0] ?? '', addr: '0x0', count: 1 };
}

function addLink(project: Project, schema: Schema, set: (p: Partial<Project>) => void): void {
  for (const rec of Object.values(schema.records)) {
    for (const f of rec.fields) {
      if (f.derived) continue;
      const key = `${rec.name}.${f.name}`;
      if (project.links[key]) continue;
      set({
        links: {
          ...project.links,
          [key]: { target: project.pools[0]?.name ?? '@abs', expr: 'v', type: project.pools[0]?.type },
        },
      });
      return;
    }
  }
}
