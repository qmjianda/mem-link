import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import demoPackSource from '../../samples/demo.pack.ts?raw';
import type { Pack, RootDef } from '../core/pack';
import type { Problem } from '../core/types';
import { packGraphSchema, buildPackGraph } from '../core/packgraph';
import { writePackValue, type WriteResult } from '../core/packedit';
import { loadPack, type LoadResult } from '../core/tspack';
import { Memory, downloadBlob, parseHexText } from '../core/mem';
import { demoBinary } from '../core/project';
import { runProgram } from '../core/program';
import type { GraphNode, GraphResult, Schema } from '../core/types';
import GraphCanvas, { type Selection } from '../ui/GraphCanvas';
import { IconAlert, IconDownload, IconFile, IconFolder, IconRefresh, IconUndo, IconUpload, IconZap, Logo } from '../ui/icons';
import { bytes } from '../ui/format';
import PackLeft from './PackLeft';
import PackInspector from './PackInspector';
import { applyOverrides, type FieldOverride } from './overrides';
import { clearSession, loadSession, pruneSession, saveSession, sessionKeyFor } from './session';

const EMPTY_GRAPH: GraphResult = {
  nodes: [], edges: [], problems: [], truncated: false, stats: { nodes: 0, edges: 0, ms: 0 },
};
const EMPTY_SCHEMA: Schema = {
  records: {}, typedefs: {}, ptrSize: 4, endian: 'little', issues: [], source: '',
};

function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function PackApp() {
  const [packSource, setPackSource] = useState(demoPackSource);
  const [packName, setPackName] = useState('demo.pack.ts');
  const [load, setLoad] = useState<LoadResult>(() => loadPack(demoPackSource));
  const [mem, setMem] = useState(() => new Memory(demoBinary(), 0));
  const [memName, setMemName] = useState('demo.bin');
  const [overrides, setOverrides] = useState<Record<string, FieldOverride>>({});
  const [extraRoots, setExtraRoots] = useState<RootDef[]>([]);
  const [programRoots, setProgramRoots] = useState<RootDef[]>([]);
  const [programLogs, setProgramLogs] = useState<string[]>([]);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [rightTab, setRightTab] = useState<'inspect' | 'problems'>('inspect');
  const [toast, setToast] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<'open' | 'export' | null>(null);
  const undoRef = useRef<Memory[]>([]);
  const [undoN, setUndoN] = useState(0);

  const packInput = useRef<HTMLInputElement>(null);
  const binInput = useRef<HTMLInputElement>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const toastTimer = useRef<number | undefined>(undefined);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  const pack = load.pack;
  const sessKey = useMemo(() => sessionKeyFor(packName, packSource), [packName, packSource]);
  const loadedKeyRef = useRef('');

  // Hydrate local edits for this pack revision (or clear them for a new one).
  useEffect(() => {
    const saved = loadSession(sessKey);
    const next = saved ? pruneSession(pack, saved) : undefined;
    setOverrides(next?.overrides ?? {});
    setExtraRoots(next?.roots ?? []);
    loadedKeyRef.current = sessKey;
  }, [sessKey, pack]);

  // Persist after hydration; the ref guard prevents writing the previous
  // pack's edits into a newly loaded pack before the effect above runs.
  useEffect(() => {
    if (loadedKeyRef.current !== sessKey) return;
    saveSession(sessKey, { overrides, roots: extraRoots });
  }, [sessKey, overrides, extraRoots]);

  const activePack = useMemo(() => {
    if (!pack) return undefined;
    const base = applyOverridesSafe(pack, overrides, load.compile);
    const seen = new Set<string>();
    const roots = [...base.roots, ...extraRoots, ...programRoots].filter((r) => {
      const key = `${r.type}:${r.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (roots.length === base.roots.length) return base;
    return { ...base, roots };
  }, [pack, overrides, extraRoots, programRoots, load.compile]);

  const addRoot = useCallback((type: string, address: number) => {
    const inPack = !!pack?.roots.some((r) => r.type === type && r.address === address);
    if (!inPack) {
      setExtraRoots((rs) => (
        rs.some((r) => r.type === type && r.address === address)
          ? rs
          : [...rs, { type, address, label: '临时根' }]
      ));
    }
    setSelection({ kind: 'node', key: `${address}:${type}` });
    setRightTab('inspect');
    say(`${inPack ? '已定位到' : '已添加'} ${type} @ 0x${address.toString(16)}`);
  }, [pack, say]);

  const removeRoot = useCallback((index: number) => {
    setExtraRoots((rs) => rs.filter((_, i) => i !== index));
    setSelection(null);
  }, []);

  const clearLocal = useCallback(() => {
    clearSession(sessKey);
    setOverrides({});
    setExtraRoots([]);
    setSelection(null);
    say('已清除本地修改');
  }, [sessKey, say]);

  const onWriteField = useCallback(
    (node: GraphNode, typeName: string, fieldName: string, text: string): WriteResult => {
      if (!activePack) return { ok: false, error: '尚未加载 pack' };
      const t = activePack.types.find((x) => x.name === typeName);
      const f = t?.fields.find((x) => x.name === fieldName);
      if (!t || !f) return { ok: false, error: '字段不存在' };
      const before = mem.clone();
      const r = writePackValue(mem, activePack, t, f, node.addr, text);
      if (r.ok) {
        undoRef.current = [...undoRef.current.slice(-59), before];
        setUndoN(undoRef.current.length);
        setMem(mem.clone());
        setVersion((v) => v + 1);
        say(`${typeName}.${fieldName} 已写入`);
      }
      return r;
    },
    [activePack, mem, say],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setUndoN(undoRef.current.length);
    setMem(prev);
    setVersion((v) => v + 1);
    say('已撤销上一次字段修改');
  }, [say]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  const graph = useMemo(() => {
    if (!activePack) return EMPTY_GRAPH;
    const t0 = performance.now();
    const g = buildPackGraph(activePack, mem, { pinned: positionsRef.current });
    return { ...g, stats: { ...g.stats, ms: Math.round((performance.now() - t0) * 10) / 10 } };
  }, [activePack, mem, version]);

  const schema = useMemo(
    () => (activePack ? packGraphSchema(activePack) : EMPTY_SCHEMA),
    [activePack],
  );

  const problems: Problem[] = useMemo(() => {
    const list = [...load.issues, ...graph.problems];
    if (load.error) list.unshift({ severity: 'error', message: 'pack 加载失败', detail: load.error });
    return list;
  }, [load.issues, load.error, graph.problems]);
  const errorCount = problems.filter((p) => p.severity === 'error').length;

  const resetPositions = () => setPositions(new Map());

  const loadPackFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const r = loadPack(text);
      setPackSource(text);
      setPackName(file.name);
      setLoad(r);
      setProgramRoots([]);
      setProgramLogs([]);
      setSelection(null);
      resetPositions();
      setRightTab(r.error ? 'problems' : 'inspect');
      if (r.error) say(`加载失败：${r.error}`);
      else say(`已加载 ${file.name}`);
    } catch (e) {
      say(`读取失败：${fmtErr(e)}`);
    }
  }, [say]);

  const loadBinFile = useCallback(async (file: File) => {
    try {
      const lower = file.name.toLowerCase();
      let next: Memory;
      if (lower.endsWith('.hex') || lower.endsWith('.txt')) {
        const r = parseHexText(await file.text());
        if (r.error) { say(r.error); return; }
        next = new Memory(r.bytes, 0);
      } else {
        next = new Memory(new Uint8Array(await file.arrayBuffer()), 0);
      }
      setMem(next);
      setMemName(file.name);
      setProgramRoots([]);
      setProgramLogs([]);
      setSelection(null);
      setVersion((v) => v + 1);
      say(`已载入 ${file.name} · ${bytes(next.size)}`);
    } catch (e) {
      say(`读取失败：${fmtErr(e)}`);
    }
  }, [say]);

  const loadExample = useCallback(() => {
    setPackSource(demoPackSource);
    setPackName('demo.pack.ts');
    setLoad(loadPack(demoPackSource));
    setMem(new Memory(demoBinary(), 0));
    setMemName('demo.bin');
    setProgramRoots([]);
    setProgramLogs([]);
    setSelection(null);
    resetPositions();
    setVersion((v) => v + 1);
    say('已载入示例');
  }, [say]);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer?.types.includes('Files')) setDragging(true); };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setDragging(false); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (f.name.endsWith('.ts')) void loadPackFile(f);
      else void loadBinFile(f);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadPackFile, loadBinFile]);

  const onPosition = useCallback((key: string, x: number, y: number) => {
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(key, { x, y });
      return next;
    });
  }, []);

  const onTogglePin = useCallback((nodeKey: string, x: number, y: number) => {
    setPositions((prev) => {
      const next = new Map(prev);
      if (next.has(nodeKey)) next.delete(nodeKey);
      else next.set(nodeKey, { x, y });
      return next;
    });
    setVersion((v) => v + 1);
  }, []);

  const onApply = useCallback((id: string, o: FieldOverride | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (o === null) delete next[id];
      else next[id] = o;
      return next;
    });
    say(o === null ? '已恢复 pack 定义' : '转换已应用');
  }, [say]);

  const exportBin = () => {
    const name = memName.replace(/\.(hex|txt)$/i, '') || 'memory.bin';
    downloadBlob(mem.buf, name.endsWith('.bin') ? name : `${name}.bin`);
    setMenu(null);
  };

  const exportPack = () => {
    downloadBlob(new TextEncoder().encode(packSource), packName, 'text/plain');
    setMenu(null);
  };

  const run = () => {
    if (!activePack) return;
    const r = runProgram(activePack, mem);
    setProgramRoots(r.roots);
    setProgramLogs(r.logs);
    if (r.error) {
      setRightTab('problems');
      say(`程序失败：${r.error}`);
    } else {
      say(`程序完成 · ${r.roots.length} 个根 · ${r.ms}ms`);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">mem-link</div>
            <div className="brand-sub">TS pack · 结构体图</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="btn" onClick={loadExample}><IconZap size={13} />示例</button>

          <div className="menu-wrap">
            <button className="btn" onClick={() => setMenu(menu === 'open' ? null : 'open')}>
              <IconFolder size={13} />打开
            </button>
            {menu === 'open' && (
              <div className="menu">
                <button onClick={() => { setMenu(null); packInput.current?.click(); }}>
                  <IconFile size={13} />打开 .pack.ts
                </button>
                <button onClick={() => { setMenu(null); binInput.current?.click(); }}>
                  <IconUpload size={13} />打开 .bin / .hex
                </button>
              </div>
            )}
          </div>

          <div className="menu-wrap">
            <button className="btn" onClick={() => setMenu(menu === 'export' ? null : 'export')}>
              <IconDownload size={13} />导出
            </button>
            {menu === 'export' && (
              <div className="menu">
                <button onClick={exportBin}><IconDownload size={13} />导出缓冲区 .bin</button>
                <button onClick={exportPack}><IconFile size={13} />导出 pack .ts</button>
              </div>
            )}
          </div>

          {pack?.program && (
            <button className="btn" onClick={run} title="运行 pack 里的 program">
              <IconRefresh size={13} />运行程序
            </button>
          )}
        </div>

        <div className="top-right">
          <div className="mem-chip" title={packName}>
            <IconFile size={12} />{packName}
          </div>
          <div className="mem-chip" title={memName}>
            <span className="mono">{memName}</span><span className="dim">{bytes(mem.size)}</span>
          </div>
          <button className="icon-btn" onClick={undo} disabled={undoN === 0} title="撤销字段修改 (Ctrl+Z)">
            <IconUndo size={13} />
          </button>
          <button
            className={`err-btn${errorCount ? ' bad' : ''}`}
            onClick={() => setRightTab('problems')}
            title="问题"
          >
            <IconAlert size={13} />{errorCount || problems.length}
          </button>
        </div>
      </header>

      <div className="workspace">
        <PackLeft
          pack={pack}
          packName={packName}
          loadError={load.error}
          issues={load.issues}
          mem={mem}
          memName={memName}
          extraRoots={extraRoots}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          localEdits={Object.keys(overrides).length + extraRoots.length}
          onClearLocal={clearLocal}
          onOpenPack={(f) => void loadPackFile(f)}
          onOpenBin={(f) => void loadBinFile(f)}
          onBase={(n) => { setMem(new Memory(mem.buf, n)); setProgramRoots([]); setVersion((v) => v + 1); }}
          onSelectNode={(key) => { setSelection({ kind: 'node', key }); setRightTab('inspect'); }}
        />

        <main className="canvas-wrap">
          <GraphCanvas
            schema={schema}
            graph={graph}
            positions={positions}
            onPosition={onPosition}
            selection={selection}
            onSelect={(s) => { setSelection(s); if (s) setRightTab('inspect'); }}
            emptyState={(
              <div className="empty-card">
                <IconBracketsish />
                <h2>载入一个 .pack.ts</h2>
                <p>脚本里定义结构体、字段偏移、转换函数和根节点。拖进来即可看到内存里的结构。</p>
                <div className="empty-actions">
                  <button className="btn primary" onClick={loadExample}>载入示例</button>
                  <button className="btn" onClick={() => packInput.current?.click()}>打开文件</button>
                </div>
                <ul>
                  <li><code>struct('Entry', 24, ...)</code> 声明类型与字段</li>
                  <li><code>{`next: u16(0, { follow: 'self', transform })`}</code> 自动连边</li>
                  <li><code>roots: [ ... ]</code> 指定遍历起点</li>
                </ul>
              </div>
            )}
          />
        </main>

        <aside className="panel right">
          <div className="panel-tabs">
            <button className={rightTab === 'inspect' ? 'on' : ''} onClick={() => setRightTab('inspect')}>检查器</button>
            <button className={rightTab === 'problems' ? 'on' : ''} onClick={() => setRightTab('problems')}>
              问题{problems.length > 0 && <em>{problems.length}</em>}
            </button>
          </div>
          <div className="panel-scroll">
            {rightTab === 'inspect' ? (
              <PackInspector
                pack={activePack ?? EMPTY_PACK}
                graph={graph}
                mem={mem}
                selection={selection}
                overrides={overrides}
                compile={load.compile}
                onWriteField={onWriteField}
                onSelect={(s) => { setSelection(s); setRightTab('inspect'); }}
                onApply={onApply}
                onTogglePin={(n) => { const p = positions.get(n.key) ?? { x: n.x, y: n.y }; onTogglePin(n.key, p.x, p.y); }}
              />
            ) : (
              <ProblemsView
                problems={problems}
                onPick={(key) => { setSelection({ kind: 'node', key }); setRightTab('inspect'); }}
                logs={programLogs}
              />
            )}
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span className="mono">{graph.stats.nodes} 节点</span>
        <span className="mono">{graph.stats.edges} 边</span>
        <span className={errorCount ? 'bad' : ''}>{errorCount} 错误</span>
        <span className="mono">{graph.stats.ms} ms</span>
        <span className="status-fill" />
        <span className="mono">{pack?.name ?? '—'} · {pack?.endian === 'big' ? 'BE' : 'LE'} · {pack?.pointerSize ? pack.pointerSize * 8 : '—'} bit</span>
        <span className="dim">本地运行 · 无网络请求</span>
      </footer>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <IconUpload size={26} />
            <strong>松开以载入</strong>
            <span>.pack.ts 或 .bin / .hex</span>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <input
        ref={packInput}
        type="file"
        accept=".ts,.txt,.js"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadPackFile(f);
          e.currentTarget.value = '';
        }}
      />
      <input
        ref={binInput}
        type="file"
        accept=".bin,.hex,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadBinFile(f);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}

function ProblemsView({
  problems, onPick, logs,
}: {
  problems: Problem[];
  onPick: (key: string) => void;
  logs: string[];
}) {
  return (
    <div className="insp">
      <div className="overview-hero">
        <h2>问题</h2>
        <p>校验与转换错误。点击带节点的条目可跳转。</p>
      </div>
      <div className="insp-body">
        {!problems.length && <div className="tip">没有发现错误。</div>}
        {problems.map((p, i) => (
          <button
            key={i}
            className={`issue ${p.severity}`}
            onClick={() => p.nodeKey && onPick(p.nodeKey)}
            disabled={!p.nodeKey}
          >
            <span className="issue-lv">{p.severity === 'error' ? 'E' : 'W'}</span>
            <div><strong>{p.message}</strong>{p.detail && <em>{p.detail}</em>}</div>
          </button>
        ))}
        {logs.length > 0 && (
          <>
            <div className="mini-title" style={{ marginTop: 14 }}>程序日志</div>
            <pre className="logs">{logs.join('\n')}</pre>
          </>
        )}
      </div>
    </div>
  );
}

/* Small helpers. */
const EMPTY_PACK: Pack = {
  name: '—', endian: 'little', pointerSize: 4, constants: {}, types: [], roots: [],
};
function applyOverridesSafe(
  pack: Pack,
  o: Record<string, FieldOverride>,
  compile?: (src: string) => unknown,
): Pack {
  return Object.keys(o).length ? applyOverrides(pack, o, compile) : pack;
}

function IconBracketsish() {
  return <span className="empty-logo"><IconZap size={18} /></span>;
}
