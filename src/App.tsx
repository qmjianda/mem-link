import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCSource } from './core/cparse';
import { buildGraph } from './core/graph';
import { Memory, downloadBlob, parseHexText } from './core/mem';
import { defaultProject, demoBinary, parseProject, serializeProject } from './core/project';
import type { GraphResult, Problem, Project } from './core/types';
import { writeFieldValue } from './core/edit';
import GraphCanvas, { type Selection } from './ui/GraphCanvas';
import LeftPanel from './ui/LeftPanel';
import RightPanel from './ui/RightPanel';
import { Logo, IconAlert, IconDownload, IconFile, IconFolder, IconRefresh, IconUndo, IconZap } from './ui/icons';
import { bytes as fmtBytes } from './ui/format';

type RightTab = 'inspect' | 'convert' | 'problems';

export default function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const [mem, setMem] = useState<Memory>(() => new Memory(demoBinary(), 0));
  const [memName, setMemName] = useState('demo.bin');
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [rightTab, setRightTab] = useState<RightTab>('inspect');
  const [live, setLive] = useState(true);
  const [hexValues, setHexValues] = useState(false);
  const [frozen, setFrozen] = useState<GraphResult | null>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const undoRef = useRef<Memory[]>([]);
  const [undoN, setUndoN] = useState(0);

  const schema = useMemo(
    () => parseCSource(project.source, { ptrSize: project.ptrSize, endian: project.endian }),
    [project.source, project.ptrSize, project.endian],
  );

  const computed = useMemo(() => {
    const g = buildGraph(schema, project, mem, { pinned: positionsRef.current });
    const issues: Problem[] = schema.issues.map((i) => ({
      severity: i.severity,
      message: i.message,
      detail: i.line != null ? `C 源码第 ${i.line} 行` : undefined,
    }));
    return { ...g, problems: [...issues, ...g.problems] };
  }, [schema, project, mem, version]);

  const graph = live ? computed : frozen ?? computed;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  useEffect(() => {
    if (selection?.kind === 'node' && !graph.nodes.some((n) => n.key === selection.key)) setSelection(null);
    if (selection?.kind === 'edge' && !graph.edges.some((e) => e.id === selection.id)) setSelection(null);
  }, [graph, selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSelection(null); setMenu(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ------------------------------------------------------------ mutations */

  const onPosition = useCallback((key: string, x: number, y: number) => {
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(key, { x, y });
      return next;
    });
  }, []);

  const togglePin = useCallback((nodeKey: string, x: number, y: number) => {
    setPositions((prev) => {
      const next = new Map(prev);
      if (next.has(nodeKey)) next.delete(nodeKey);
      else next.set(nodeKey, { x, y });
      return next;
    });
  }, []);

  const onEditField = useCallback((nodeKey: string, fieldId: string, text: string): string | null => {
    const node = graph.nodes.find((n) => n.key === nodeKey);
    const rec = node ? schema.records[node.type] : undefined;
    const field = rec?.fields.find((f) => f.id === fieldId);
    if (!node || !rec || !field) return '找不到字段';
    const before = mem.clone();
    const r = writeFieldValue(mem, schema, rec, field, node.addr, text);
    if (!r.ok) return r.error ?? '写入失败';
    undoRef.current = [...undoRef.current.slice(-59), before];
    setUndoN(undoRef.current.length);
    setMem(mem.clone());
    setVersion((v) => v + 1);
    return null;
  }, [graph.nodes, schema, mem]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setUndoN(undoRef.current.length);
    setMem(prev);
    setVersion((v) => v + 1);
    setToast('已撤销上一次字段修改');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  /* ------------------------------------------------------------- loading */

  const loadBytes = useCallback((bytes: Uint8Array, base: number, name: string) => {
    setMem(new Memory(bytes, base));
    setMemName(name);
    setPositions(new Map());
    setSelection(null);
    setVersion((v) => v + 1);
  }, []);

  const loadDemo = useCallback(() => {
    setProject(defaultProject());
    setMem(new Memory(demoBinary(), 0));
    setMemName('demo.bin');
    setPositions(new Map());
    setSelection(null);
    setVersion((v) => v + 1);
    flash('已载入示例：索引链表 + 一条越界坏链');
  }, [flash]);

  const openFile = useCallback(async (file: File) => {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.json') || file.type === 'application/json') {
        const text = await file.text();
        const r = parseProject(text);
        if (!r.project) { flash(r.error ?? '项目解析失败'); return; }
        setProject(r.project);
        setPositions(new Map());
        setSelection(null);
        undoRef.current = [];
        setUndoN(0);
        if (r.memory) {
          setMem(new Memory(r.memory.bytes, r.memory.base));
          setMemName(r.memory.name);
          flash(`已载入项目 ${file.name} · 含缓冲区 ${fmtBytes(r.memory.bytes.length)}`);
        } else {
          flash(`已载入项目 ${file.name}`);
        }
        return;
      }
      if (name.endsWith('.hex') || name.endsWith('.txt')) {
        const text = await file.text();
        const r = parseHexText(text);
        if (r.error) { flash(r.error); return; }
        loadBytes(r.bytes, mem.base, file.name);
        flash(`已解析 ${r.bytes.length} 字节`);
        return;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      loadBytes(buf, mem.base, file.name);
      flash(`已载入 ${file.name} · ${fmtBytes(buf.length)}`);
    } catch (e) {
      flash(`读取失败：${(e as Error).message}`);
    }
  }, [flash, loadBytes, mem.base]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void openFile(f);
  }, [openFile]);

  const exportBin = useCallback(() => {
    downloadBlob(mem.buf, memName.endsWith('.bin') ? memName : 'memory.bin');
    flash('已导出当前缓冲区');
  }, [mem, memName, flash]);

  const saveProject = useCallback(() => {
    const data = new TextEncoder().encode(serializeProject(project, { name: memName, base: mem.base, bytes: mem.buf }));
    downloadBlob(data, 'mem-link-project.json', 'application/json');
    flash('项目已保存');
    setMenu(false);
  }, [project, memName, mem.base, mem.buf, flash]);

  /* --------------------------------------------------------------- render */

  const errorCount = graph.problems.filter((p) => p.severity === 'error').length;

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <Logo size={28} />
          <div>
            <div className="brand-name">mem-link</div>
            <div className="brand-sub">结构体 · 索引链表 · 二进制</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="btn" onClick={loadDemo} title="载入示例">
            <IconZap size={14} /> 示例
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <IconFolder size={14} /> 打开
          </button>
          <div className="menu-wrap">
            <button className={`btn${menu ? ' on' : ''}`} onClick={() => setMenu((m) => !m)}>
              <IconDownload size={14} /> 导出
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu">
                  <button onClick={exportBin}>导出缓冲区 .bin</button>
                  <button onClick={saveProject}>保存项目 .json</button>
                  <button onClick={() => { setMenu(false); projectRef.current?.click(); }}>导入项目 .json</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="top-right">
          <div className="mem-chip" title={`${memName} · ${fmtBytes(mem.size)}`}>
            <IconFile size={13} />
            <span className="mono">{memName}</span>
            <span className="dim">{fmtBytes(mem.size)}</span>
          </div>
          <button className="btn" onClick={undo} disabled={undoN === 0} title="撤销上一次字段修改（Ctrl/Cmd+Z）">
            <IconUndo size={14} /> 撤销
          </button>
          <button
            className={`btn ${hexValues ? 'on' : ''}`}
            onClick={() => setHexValues((v) => !v)}
            title="节点里的数值按十六进制显示"
          >
            <span className="mono" style={{ fontSize: 10.5 }}>{hexValues ? 'HEX' : 'DEC'}</span>
          </button>
          <button
            className={`live ${live ? 'on' : ''}`}
            onClick={() => { setLive((v) => !v); setFrozen(live ? computed : null); }}
            title="实时重算 / 手动重算"
          >
            <i /> live
          </button>
          {!live && (
            <button className="btn" onClick={() => setFrozen(computed)}>
              <IconRefresh size={14} /> 重算
            </button>
          )}
          {errorCount > 0 && (
            <button className="btn danger" onClick={() => setRightTab('problems')}>
              <IconAlert size={14} /> {errorCount}
            </button>
          )}
        </div>
      </header>

      <main className="workspace">
        <LeftPanel
          project={project}
          schema={schema}
          issues={schema.issues}
          mem={mem}
          onProject={setProject}
          onBytes={(b, base, name) => loadBytes(b, base, name)}
          onRebase={(base) => { setMem(new Memory(mem.buf, base)); setVersion((v) => v + 1); }}
          onFile={openFile}
          onDemo={loadDemo}
          onExportBin={exportBin}
        />

        <section className="canvas-wrap">
          <GraphCanvas
            schema={schema}
            graph={graph}
            positions={positions}
            onPosition={onPosition}
            selection={selection}
            onSelect={setSelection}
            hexValues={hexValues}
            emptyState={
              <div className="empty-card">
                <Logo size={44} />
                <h2>把内存变成一张图</h2>
                <p>粘贴 C 结构体 → 载入 .bin → 告诉工具「下标」如何变成地址。</p>
                <div className="empty-actions">
                  <button className="btn primary" onClick={loadDemo}>载入示例</button>
                  <button className="btn" onClick={() => fileRef.current?.click()}>打开二进制文件</button>
                </div>
                <ul>
                  <li>支持 <code>typedef struct</code>、位域、数组、嵌套、<code>#pragma pack</code></li>
                  <li>链接规则可以写 <code>v</code>、<code>v - 1</code>、<code>(v - base) / 16</code></li>
                  <li>越界下标会变成红色幽灵节点，而不是静默失败</li>
                </ul>
              </div>
            }
          />
        </section>

        <RightPanel
          schema={schema}
          project={project}
          graph={graph}
          mem={mem}
          selection={selection}
          onSelect={(s) => {
            setSelection(s as Selection);
            if (s) setRightTab('inspect');
          }}
          tab={rightTab}
          onTab={setRightTab}
          onEditField={(node, field, text) => onEditField(node.key, field.id, text)}
          onTogglePin={(node) => togglePin(node.key, node.x, node.y)}
          pinned={selection?.kind === 'node' ? positions.has(selection.key) : false}
          onGotoProblem={(p) => {
            if (p.nodeKey) {
              setSelection({ kind: 'node', key: p.nodeKey });
              setRightTab('inspect');
            }
          }}
        />
      </main>

      <footer className="statusbar">
        <span className="mono">{memName}</span>
        <span className="dim">0x{mem.base.toString(16)} – 0x{mem.end.toString(16)}</span>
        <span className="sep" />
        <span>{graph.stats.nodes} 节点</span>
        <span>{graph.stats.edges} 边</span>
        <span className={errorCount ? 'err-text' : 'dim'}>{errorCount} 错误</span>
        <span className="grow" />
        <span className="dim">{graph.stats.ms} ms</span>
        <span className="sep" />
        <span className="dim">本地运行 · 无网络请求</span>
      </footer>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <IconFolder size={28} />
            <strong>松开以载入</strong>
            <span>.bin · .hex · .json</span>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <input
        ref={fileRef} type="file" hidden
        accept=".bin,.hex,.json,.txt,application/octet-stream"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ''; }}
      />
      <input
        ref={projectRef} type="file" hidden accept=".json,application/json"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ''; }}
      />
    </div>
  );
}
