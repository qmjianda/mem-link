import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import nvmeDemo from '../../samples/nvme-sq.blueprint.json';
import { downloadBlob, parseHexText } from '../core/mem';
import type { Problem } from '../core/types';
import Palette from './Palette';
import Canvas, { type CanvasApi, type DragPreview } from './Canvas';
import Inspector from './Inspector';
import { evaluateGraph, SOURCE_PORT, valueAsBuffer } from './eval';
import { loadBlueprintPack } from './load';
import { BLUEPRINT_FORMAT, canConnect, displayTitle, dropPosition, isInstanceView, NODE_WIDTH, type BPEdge, type BPNode, type BlueprintPack, type BPResult, type BufferValue, type PortType } from './types';
import { uniqueBuffers } from './assets';
import { builtinDefaults, getBuiltin, inheritOptions } from './builtins';
import {
  backLabel, canBack, canForward, emptyNav, forwardLabel, goBack, goForward, pushNav,
  type NavSnapshot, type NavState,
} from './navhistory';
import { adjacency, autoLayout } from './autolayout';
import { boundsOf } from './viewport';
import { bufferIssue, buildFollowItems, elementFollowItem, followAddress, followHint, followTypeIssue, inferFollowType, knownTypesAt } from './follow';
import {
  bytesToBase64, hasStoredBytes, makeDoc, parseDoc, rebaseStored, sessionBytesOf, withSessionBytes,
} from './doc';
import type { DocState, LoadedPack } from './docstate';
import { isPackEnabled, maxIdSeq } from './docstate';
import {
  addNodes, clearSelection, deleteSelection, emptySelection, isEmptySelection, primarySelection,
  retainSelection, selectAll, selectOnlyEdge, selectOnlyNode, setEntry, summaryOf,
  type BPSelection, type SelectionState,
} from './selection';
import {
  duplicateSelection, extractFragment, pasteFragment, pasteOffset, type Fragment,
} from './clipboard';
import {
  addPack, cleanupPackNodes, disabledPackIds, enabledPackMap, packImpact, removePackAtomic,
  renamePack, setPackEnabled, updatePackSource,
} from './packops';
import {
  fetchStoreReference, installedPackOf, readStorePrefs, verifyPackSource, writeStorePrefs, type StorePackEntry,
} from './store';
import PackStore from './PackStore';
import NodeHelp from './NodeHelp';
import { initialParseParams } from './add-defaults';
import { addressHex, addressInteger, isMappedAddress, offsetIn, packMemory, safeNumber, sameMapping } from './precision';
import { addOffset, pointerRead } from './binary-read';
import { validLayoutDocument, type BinaryLayout } from './layouts';
import { reviewLayouts } from './designer/operations';
import { buildStructureRegistry } from './structure';
import { buildLayoutUsage, layoutsEqual } from './designer/usage';
import { parseDesignerHash, designerHash } from './designer/route';
import DesignerApp, { type DesignerApplyResult } from './designer/DesignerApp';
import {
  canRedo, canUndo, currentDoc, initHistory, isDirty, markSaved, push, redo, redoLabel, undo, undoLabel,
  type HistoryState,
} from './history';
import {
  loadStored, saveDoc, storageAvailable, MAX_WRITE_BYTES, type DroppedBuffer, type PersistCode,
} from './persist';
import {
  autoCollapse, clampWidth, COLLAPSED_W, readPrefs, resetSide, writePrefs,
  type GroupState, type LayoutState,
} from './layout';
import {
  allowInInput, contextOf, isEditable, resolveCommand, type Command,
} from './keys';
import KeyHelp from './KeyHelp';
import ContextMenu from './ContextMenu';
import ConfirmDialog, { type ConfirmRequest } from './ConfirmDialog';
import QuickAdd from './QuickAdd';
import FollowPicker, {
  type FollowItem, type FollowPreview, type FollowRequest, type FollowStep,
} from './FollowPicker';
import GraphSearch, { type SearchHit } from './GraphSearch';
import { buildMenu, type MenuCtx, type MenuItem, type MenuTarget } from './menus';
import { IconAlert, IconDownload, IconFolder, IconRefresh, IconStore, IconUndo, IconUpload, Logo } from '../ui/icons';
import StructTree, { type TreeSession } from './StructTree';
import LocalTree from './LocalTree';
import type { TreeFocus, TreeRootSpec } from './tree';

/** 分隔条命中的栅格轨道宽度（视觉带 5px 居中，命中区 9px） */
const SPLIT_W = '9px';
/** 图文档自动持久化防抖 */
const PERSIST_DEBOUNCE_MS = 800;

/**
 * 内置示例图与「打开图」共用同一份 JSON。修改示例只需重新生成
 * samples/nvme-sq.blueprint.json（node scripts/gen-nvme.mjs）。
 */
function initialDoc(): DocState {
  const d = parseDoc(JSON.stringify(nvmeDemo)).doc;
  if (!d) return { packs: [], nodes: [], edges: [] };
  const packs: LoadedPack[] = [];
  for (const p of d.packs) {
    const r = loadBlueprintPack(p.source);
    if (r.pack) packs.push({ id: p.id, name: p.name, source: p.source, pack: r.pack, enabled: true, ...(p.store ? { store: p.store } : {}) });
  }
  return { packs, nodes: d.nodes, edges: d.edges, layouts: d.layouts };
}

function emptyDoc(): DocState {
  return { packs: [], nodes: [], edges: [] };
}

function cloneLayouts(layouts: readonly BinaryLayout[] | undefined): BinaryLayout[] {
  return (layouts ?? []).map(l => ({
    ...l,
    fields: l.fields.map(f => ({ ...f, ...(f.values ? { values: { ...f.values } } : {}) })),
  }));
}

function readFile(f: File): Promise<Uint8Array> {
  return f.arrayBuffer().then((b) => new Uint8Array(b));
}

/**
 * 超过这个原始大小的文件不生成 base64：编码后必然超过 localStorage 的
 * 2 MB 写入预算，最后也会被裁掉。字节留在会话内存里，求值、检查器、
 * 结构树照常工作；导出时按需临时编码，页面重载后仍需重新选择文件。
 */
const SESSION_ONLY_BYTES = Math.floor((MAX_WRITE_BYTES * 3) / 4);

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 折叠态左右栏：36px 竖排条，含展开按钮与竖排标题。 */
function Rail({
  side, title, hint, onExpand,
}: { side: 'left' | 'right'; title: string; hint: string; onExpand: () => void }) {
  return (
    <div className={`bp-rail bp-rail-${side}`}>
      <button className="bp-rail-btn" title={hint} aria-label={hint} onClick={onExpand}>
        {side === 'left' ? '»' : '«'}
      </button>
      <span className="bp-rail-label">{title}</span>
    </div>
  );
}

export default function BlueprintApp() {
  // 启动：能读缓存就恢复；没有可恢复草稿时打开空白工作区，而不是自动塞入示例。
  const boot = useMemo(() => {
    const storage = storageAvailable();
    const r = storage ? loadStored() : { code: 'MISSING' as const, problems: [] as Problem[] };
    // 版本不符 / 坏数据：丢弃缓存并提示一次（PRD P0-18）
    const notice = r.code === 'VERSION'
      ? '缓存版本不匹配，已丢弃'
      : r.code === 'BAD_JSON' || r.code === 'BAD_DATA'
        ? '缓存已损坏，已丢弃'
        : '';
    return {
      doc: r.doc ?? emptyDoc(),
      problems: r.problems,
      storage,
      notice,
      restored: !!r.doc,
    };
  }, []);

  /** 单一文档对象：packs / nodes / edges 的唯一来源 */
  const [doc, setDoc] = useState<DocState>(boot.doc);
  const [history, setHistory] = useState<HistoryState>(() => initHistory(boot.doc));
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  /** 快捷键帮助浮层 */
  const [helpOpen, setHelpOpen] = useState(false);
  /** 快速添加浮层 */
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  /** pack 商店浮层与上次使用的商店地址 */
  const [storeOpen, setStoreOpen] = useState(false);
  const [storeUrl, setStoreUrl] = useState(() => readStorePrefs().url);
  /** 节点帮助：pack 节点 + 可选参考蓝图 */
  const [nodeHelp, setNodeHelp] = useState<{ packId: string; nodeId: string } | null>(null);
  /** 右键菜单：目标 + 屏幕坐标 */
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number } | null>(null);
  /** 内存剪贴板里有多少节点（菜单禁用态要据此刷新） */
  const [clipCount, setClipCount] = useState(0);
  /** 右栏当前页签：问题 chip 与检查器共用同一个入口，避免两套列表 */
  const [rightTab, setRightTab] = useState<'inspect' | 'problems'>('inspect');
  /** 结构体 → 缓冲区的一次性定位目标；FileEditor 挂载时消费 */
  const [bufferFocus, setBufferFocus] = useState<{ nodeId: string; addr: bigint } | null>(null);
  const bufferFocusTimer = useRef(0);
  /** 拖入文件时的覆盖层 */
  const [dropping, setDropping] = useState(false);
  /** 全屏结构设计器：null = 关闭；[] = 布局选择器；其余为布局栈 */
  const [designerStack, setDesignerStack] = useState<string[] | null>(() => {
    return parseDesignerHash(window.location.hash)?.stack ?? null;
  });
  /** 本次打开设计器前的布局快照，用于「撤销本次修改」 */
  const [designerBase, setDesignerBase] = useState<BinaryLayout[] | null>(() => {
    return parseDesignerHash(window.location.hash) ? cloneLayouts(boot.doc.layouts) : null;
  });
  const designerReturnHash = useRef(window.location.hash.startsWith('#design') ? '' : window.location.hash);
  const designerTrigger = useRef<HTMLElement | null>(null);
  const designerStackRef = useRef<string[] | null>(designerStack);
  designerStackRef.current = designerStack;
  const designerOpen = designerStack !== null;
  const designerOpenRef = useRef(designerOpen);
  designerOpenRef.current = designerOpen;
  /** 全屏结构树：打开时把节点、根类型与内存快照一起固定下来 */
  const [tree, setTree] = useState<{
    nodeId: string; root: TreeRootSpec; title: string; subtitle?: string; focus?: TreeFocus;
    sourceAssetId?: string;
  } | null>(null);
  /** 跟随浮层由树里唤起时暂时隐藏树（不卸载，保留滚动与展开状态） */
  const [treeHidden, setTreeHidden] = useState(false);
  const [localTree, setLocalTree] = useState<string | null>(null);
  const followFromTree = useRef(false);
  /** 每个节点上一次的展开/搜索/滚动状态，只在本次会话内保留 */
  const treeSessions = useRef(new Map<string, TreeSession>());
  /** 问题定位后的节点脉冲高亮 */
  const [pulse, setPulse] = useState<string | null>(null);
  /** F2 重命名：检查器据此切入行内编辑 */
  const [renameId, setRenameId] = useState<string | null>(null);
  /** 重命名输入框落点：F2 / 菜单落在检查器，双击标题就地编辑 */
  const [renameAt, setRenameAt] = useState<'panel' | 'canvas'>('panel');
  /** 跟随地址浮层 */
  const [follow, setFollow] = useState<FollowRequest | null>(null);
  /** 上次使用的解析节点，双击端口时作为默认候选项排在首位 */
  const lastFollowKey = useRef<string | null>(null);
  /** 图内搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  /** 视口 / 选中态导航历史 */
  const [nav, setNav] = useState<NavState>(emptyNav);
  const navRef = useRef(nav);
  navRef.current = nav;
  /** 「打开图」的隐藏输入（Mod+O 触发） */
  const openInputRef = useRef<HTMLInputElement | null>(null);
  /** 内存剪贴板（系统剪贴板只是可选副作用） */
  const clip = useRef<Fragment | null>(null);
  /** 连续粘贴的序号：24 / 48 / 72… */
  const pasteCount = useRef(0);
  const [toast, setToast] = useState(boot.notice);  const [packIssues, setPackIssues] = useState<Problem[]>(boot.problems);
  const [persist, setPersist] = useState<{ code: PersistCode; at: number; dropped: DroppedBuffer[] } | null>(
    boot.storage ? null : { code: 'NO_STORAGE', at: 0, dropped: [] },
  );
  /** 最近一次导出：浏览器只确认「已发起下载」 */
  const [exportAt, setExportAt] = useState<number | null>(null);
  /** 示例是临时副本：进入时保存工作会话，返回时恢复 */
  const [sampleMode, setSampleMode] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const sampleModeRef = useRef(false);
  sampleModeRef.current = sampleMode;
  const workSession = useRef<{
    doc: DocState;
    history: HistoryState;
    selection: SelectionState;
    nav: NavState;
    persist: { code: PersistCode; at: number; dropped: DroppedBuffer[] } | null;
  } | null>(null);
  /** 换图/打开的会话号：异步读取回来时若已切换，不得提交到新图 */
  const sessionSeq = useRef(0);
  /** 节点库分组折叠（true = 折叠） */
  const [groups, setGroups] = useState<GroupState>(() => readPrefs().groups);
  /** 小地图是否展开（持久化到 memlink:ui:v1） */
  const [minimap, setMinimap] = useState<boolean>(() => readPrefs().minimap);
  const [layout, setLayout] = useState<LayoutState>(() => readPrefs().layout);
  /** 正在拖动的分隔条；null 表示未拖动 */
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  /** live preview of a palette item being dragged onto the canvas */
  const [dragAdd, setDragAdd] = useState<DragPreview | null>(null);

  /** id 生成器永不回退：撤销/重做原样恢复字面 id，新 id 从最大值继续 */
  const seq = useRef(maxIdSeq(boot.doc));
  const canvasApi = useRef<CanvasApi | null>(null);
  const dragRef = useRef<{
    packId: string; nodeId: string; label: string;
    sx: number; sy: number; moved: boolean; cancelled: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  // 同步镜像：事件回调与 800ms 防抖都读 ref，避免闭包拿到旧文档
  const docRef = useRef(doc);
  docRef.current = doc;
  const historyRef = useRef(history);
  historyRef.current = history;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const uiRef = useRef({ layout, groups, minimap });
  uiRef.current = { layout, groups, minimap };

  const packs = doc.packs;
  const nodes = doc.nodes;
  const edges = doc.edges;

  const packsMap = useMemo(() => enabledPackMap(packs), [packs]);
  const structures = useMemo(() => buildStructureRegistry(doc.layouts ?? [], packsMap), [doc.layouts, packsMap]);
  const layoutUsage = useMemo(() => buildLayoutUsage({
    layouts: doc.layouts, nodes, edges, packs: doc.packs,
  }, {
    nodeLabel: (n) => displayTitle(n,
      n.packId
        ? (packsMap.get(n.packId)?.nodes[n.nodeId]?.label ?? n.nodeId)
        : (getBuiltin(n.nodeId)?.label ?? n.nodeId)),
  }), [doc.layouts, nodes, edges, doc.packs, packsMap]);
  /** 已被禁用的 pack：画布据此显示「已禁用」错误态 */
  const disabledPacks = useMemo(() => disabledPackIds(packs), [packs]);
  /** 展示用的全量 map：标签与端口说明要能解析出被禁用 pack 的名字 */
  const allPacks = useMemo(() => new Map(packs.map((p) => [p.id, p.pack])), [packs]);
  const packNames = useMemo(() => new Map(packs.map((p) => [p.id, p.name])), [packs]);
  const result = useMemo(
    () => evaluateGraph(nodes, edges, packsMap, { disabledPacks, layouts: doc.layouts }),
    [nodes, edges, packsMap, disabledPacks, doc.layouts],
  );
  const fullResult: BPResult = useMemo(
    () => ({ ...result, problems: [...packIssues, ...result.problems] }),
    [result, packIssues],
  );

  /** 无明确上下文时只考虑根转储，不把同一映射的字节范围当成另一份文件。 */
  const buffers = useMemo(() => uniqueBuffers([...fullResult.sources.values()].filter(s => s.mode === 'file')), [fullResult]);

  /**
   * 画布用它判断一个来源能否接进「数据源」：真正携带文件的节点才可以。
   * - File 节点即使还没选文件也算：先连线、再载入是常见顺序。
   * - 字符串、字节数组本身可以直接当数据源（基址 0 的内存镜像）。
   * - 其它节点看求值结果里有没有缓冲区（解析节点会继承/默认到某个文件）。
   * 数字常量、Note 这类没有内容可传，接上去只会让下游悄悄读别的文件。
   */
  const carriesFile = (id: string, port?: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) return false;
    if (n.packId === '' && n.nodeId === 'file') return true;
    // 字符串 / 字节输出本身就是数据源内容（基址 0 的内存镜像）
    if (port && valueAsBuffer(fullResult.outputs.get(id)?.[port])) return true;
    return !!fullResult.sources.get(id)?.buffer;
  };

  // ---- 文档提交：唯一写入口 -----------------------------------------------
  /**
   * 提交一份新文档。`updater` 必须一次产出完整新文档（未改动的数组复用引用），
   * 这样一次操作 = 一条历史，撤销不会出现半截状态。
   */
  const commit = (updater: (prev: DocState) => DocState, label: string, mergeKey?: string) => {
    const before = docRef.current;
    const next = updater(before);
    if (next === before) return;
    docRef.current = next;
    setDoc(next);
    const nh = push(historyRef.current, next, label, { mergeKey, now: Date.now() });
    if (nh !== historyRef.current) {
      historyRef.current = nh;
      setHistory(nh);
    }
  };

  const applyHistory = (nh: HistoryState) => {
    if (nh === historyRef.current) return;
    historyRef.current = nh;
    const d = currentDoc(nh);
    docRef.current = d;
    setHistory(nh);
    setDoc(d);
    // 撤销可能删掉被选中的对象：把选择收敛到仍存在的对象上
    setSelection((s) => retainSelection(s, d));
  };

  const doUndo = () => applyHistory(undo(historyRef.current));
  const doRedo = () => applyHistory(redo(historyRef.current));

  /** 打开图 / 新建 / 恢复示例：换掉整份文档并清空 undo/redo */
  const resetDoc = (d: DocState, saved = false) => {
    sessionSeq.current += 1;
    seq.current = Math.max(seq.current, maxIdSeq(d));
    docRef.current = d;
    const nh = initHistory(d, saved);
    historyRef.current = nh;
    setDoc(d);
    setHistory(nh);
    setSelection(emptySelection());
    setNav(emptyNav);
    clip.current = null;
    pasteCount.current = 0;
    setClipCount(0);
  };

  // ---- 选择：单值兼容视图 / 批量删除 --------------------------------------
  /** Inspector 仍用单值视图，这里把它翻译回集合 */
  const selectLegacy = (s: BPSelection) => {
    if (!s) { setSelection(clearSelection()); return; }
    if (s.kind === 'node') { setSelection(selectOnlyNode(s.id)); return; }
    if (s.kind === 'edge') { setSelection(selectOnlyEdge(s.id)); return; }
    setSelection(setEntry(selectionRef.current, s.nodeId, s.index));
  };

  /** 删除一组对象：与被删节点相连的连线一并删掉，一次 commit 一条历史 */
  const deleteObjects = (target: SelectionState, label: string) => {
    const before = docRef.current;
    const after = deleteSelection(before, target);
    if (after === before) return;
    commit(() => after, label);
    setSelection((s) => retainSelection(s, after));
  };

  const deleteLabel = (nodes: number, edges: number): string => {
    if (nodes && edges) return `删除 ${nodes} 个节点、${edges} 条连线`;
    if (nodes) return `删除 ${nodes} 个节点`;
    return `删除 ${edges} 条连线`;
  };

  // ---- 持久化 --------------------------------------------------------------
  const trimNotified = useRef(false);
  const runSave = (d: DocState) => {
    // 示例是临时副本：不写工作草稿缓存，返回后原草稿仍在。
    if (sampleModeRef.current) return;
    const r = saveDoc(d);
    setPersist({ code: r.code, at: Date.now(), dropped: r.dropped });
    if (r.ok) {
      const nh = markSaved(historyRef.current, d);
      if (nh !== historyRef.current) {
        historyRef.current = nh;
        setHistory(nh);
      }
      if (r.code === 'TRIMMED' && !trimNotified.current) {
        trimNotified.current = true;
        setToast(`缓存已裁剪：${r.droppedBuffers} 个转储需重新载入`);
      }
    } else if (r.code === 'TOO_LARGE') {
      setToast(`未持久化：${(r.bytes / 1024 / 1024).toFixed(1)} MB 超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB 上限`);
    }
  };

  // 文档变化 → 800ms 防抖写盘（拖动期不逐帧写）
  useEffect(() => {
    const t = window.setTimeout(() => runSave(docRef.current), PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);

  }, [doc]);

  const dirty = isDirty(history);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // 有未保存改动时，关闭页面触发原生确认（示例临时副本不拦）
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || sampleModeRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const say = (msg: string) => setToast(msg);

  // ---- 三栏布局：宽度 / 折叠 / 持久化 -------------------------------------
  const setWidth = (side: 'left' | 'right', w: number) => {
    setLayout((l) => (side === 'left' ? { ...l, leftWidth: w } : { ...l, rightWidth: w }));
  };

  const toggleCollapsed = (side: 'left' | 'right') => {
    setLayout((l) => (side === 'left'
      ? { ...l, leftCollapsed: !l.leftCollapsed }
      : { ...l, rightCollapsed: !l.rightCollapsed }));
  };

  const toggleGroup = (key: string) => {
    setGroups((g) => ({ ...g, [key]: !g[key] }));
  };

  // 窄屏让位只在「变窄」方向生效：宽屏不自动展开，避免覆盖用户手动选择。
  useEffect(() => {
    const sync = () => {
      const patch = autoCollapse(window.innerWidth);
      if (!Object.keys(patch).length) return;
      setLayout((l) => {
        const next: LayoutState = { ...l, ...patch };
        const same = next.leftWidth === l.leftWidth
          && next.rightWidth === l.rightWidth
          && next.leftCollapsed === l.leftCollapsed
          && next.rightCollapsed === l.rightCollapsed;
        return same ? l : next;
      });
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // 布局/分组变化后 150ms 合并写入 memlink:ui:v1：拖动期不逐帧写盘。
  useEffect(() => {
    const t = window.setTimeout(() => writePrefs({ layout, groups, minimap }), 150);
    return () => window.clearTimeout(t);
  }, [layout, groups, minimap]);

  // 分隔条拖动：pointerdown 后挂 window 级监听，pointerup 时落盘。
  // 双击复位自己做判定——pointerdown 已 preventDefault，兼容鼠标事件（含
  // dblclick）在部分浏览器会被一并抑制。
  const resizeRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number; moved: boolean } | null>(null);
  const lastSplitClick = useRef<{ side: 'left' | 'right'; at: number } | null>(null);

  const beginResize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (side === 'left' ? layout.leftCollapsed : layout.rightCollapsed) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      side,
      startX: e.clientX,
      startW: side === 'left' ? layout.leftWidth : layout.rightWidth,
      moved: false,
    };
    setResizing(side);
  };

  useEffect(() => {
    if (!resizing) return;
    const onPointerMove = (e: PointerEvent) => {
      const d = resizeRef.current;
      if (!d) return;
      const delta = d.side === 'left' ? e.clientX - d.startX : d.startX - e.clientX;
      if (Math.abs(delta) > 2) d.moved = true;
      const w = clampWidth(d.side, d.startW + delta);
      setLayout((l) => {
        if (d.side === 'left') return l.leftWidth === w ? l : { ...l, leftWidth: w };
        return l.rightWidth === w ? l : { ...l, rightWidth: w };
      });
    };
    const finish = () => {
      const d = resizeRef.current;
      resizeRef.current = null;
      setResizing(null);
      if (d) {
        const now = Date.now();
        const prev = lastSplitClick.current;
        if (!d.moved && prev && prev.side === d.side && now - prev.at < 400) {
          setWidth(d.side, resetSide(d.side));
          lastSplitClick.current = null;
        } else {
          lastSplitClick.current = d.moved ? null : { side: d.side, at: now };
        }
      }
      writePrefs(uiRef.current);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };

  }, [resizing]);

  const onSplitKey = (side: 'left' | 'right') => (e: React.KeyboardEvent) => {
    const cur = side === 'left' ? layout.leftWidth : layout.rightWidth;
    if (e.key === 'Home') {
      e.preventDefault();
      setWidth(side, resetSide(side));
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // 右栏位于画布右侧：分隔条向右移 = 右栏变窄，与拖动方向保持一致。
    const step = (e.key === 'ArrowRight' ? 8 : -8) * (side === 'left' ? 1 : -1);
    setWidth(side, clampWidth(side, cur + step));
  };

  // ---- 文档编辑 ------------------------------------------------------------
  const onAdd = (packId: string, nodeId: string, drop?: { x: number; y: number }): string => {
    let x: number;
    let y: number;
    if (drop) {
      // 拖放添加：指针落在新节点标题栏上。
      const p = dropPosition(drop);
      x = p.x;
      y = p.y;
    } else {
      // 单击添加：放在当前视口中心附近，保证刚加的节点一定看得见
      const c = canvasApi.current?.centerWorld() ?? { x: 0, y: 0 };
      const cx = c.x - NODE_WIDTH / 2;
      const cy = c.y - 70;
      const collides = (px: number, py: number) =>
        nodes.some((n) => Math.abs(n.x - px) < 300 && Math.abs(n.y - py) < 190);
      const offsets = [
        [0, 0], [340, 0], [0, 210], [0, -210], [340, 210], [340, -210], [-340, 0],
        [-340, 210], [-340, -210], [680, 0], [-680, 0],
      ];
      // 侧栏会压住一部分画布：优先选完全落在可见区域内的位置，
      // 否则新节点会「添加成功但看不见」。
      const vis = canvasApi.current?.visibleWorld();
      const inside = (px: number, py: number) => !vis
        || (px >= vis.minX + 8 && py >= vis.minY + 8
          && px + NODE_WIDTH <= vis.maxX - 8 && py + 140 <= vis.maxY - 8);
      const placed = offsets.map(([dx, dy]) => ({ x: cx + dx, y: cy + dy }));
      const free = placed.find((p) => inside(p.x, p.y) && !collides(p.x, p.y))
        ?? placed.find((p) => inside(p.x, p.y));
      x = free?.x ?? (vis
        ? Math.min(Math.max(cx, vis.minX + 8), Math.max(vis.minX + 8, vis.maxX - 8 - NODE_WIDTH))
        : cx + 40 * (nodes.length % 8));
      y = free?.y ?? (vis
        ? Math.min(Math.max(cy, vis.minY + 8), Math.max(vis.minY + 8, vis.maxY - 8 - 140))
        : cy + 40 * (nodes.length % 8));
    }
    const params: Record<string, string> = packId
      ? {}
      : { ...builtinDefaults(nodeId), ...inheritOptions(nodeId, nodes) };
    // 元素节点从空开始：不在添加时预绑类型，端口等真正接上元素/列表（或
    // 跟随地址推断出类型）后才生成，避免空节点看起来像某个结构体。
    if (!packId && nodeId === 'element') params.index = '0';
    if (!packId && getBuiltin(nodeId)?.precise && 'address' in params) {
      Object.assign(params, initialParseParams(nodes, selectionRef.current, result));
    }
    if (packId) {
      const def = packsMap.get(packId)?.nodes[nodeId];
      if (def && (def.kind === 'struct' || def.kind === 'list' || def.kind === 'array')) {
        Object.assign(params, initialParseParams(nodes, selectionRef.current, result));
      }
      if (def?.kind === 'calc') {
        for (const [k, t] of Object.entries(def.inputs)) if (t === 'number') params[k] = '0';
      }
    }
    const id = `n${++seq.current}`;
    const next: BPNode = { id, packId, nodeId, x, y, params };
    commit((d) => ({ ...d, nodes: [...d.nodes, next] }), '添加节点');
    setSelection(selectOnlyNode(id));
    return id;
  };

  // ---- palette drag-to-add -------------------------------------------------
  // 监听器只绑定一次，因此把最新的 onAdd 放在 ref 里：落点必须按当前 packs
  // 初始化新节点，而不是首帧的闭包。
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    const cancelClick = () => {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.cancelled) return;
      // 几个像素的抖动仍算单击；只有指针真正移动后才开始视觉拖动。
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
      d.moved = true;
      setDragAdd({
        packId: d.packId, nodeId: d.nodeId, label: d.label,
        clientX: e.clientX, clientY: e.clientY,
      });
    };
    const cancel = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      cancelClick();
      setDragAdd(null);
    };
    // 在 window 层提交：触摸指针会被 palate 按钮隐式捕获，它的 pointerup
    // 到不了画布元素。此处仅取坐标，不依赖事件目标。
    const finish = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (d.moved) {
        // pointerup 之后紧跟的 click 不能创建第二个节点；即使没有 click 到达，
        // 标志位也会在下一个任务清除。
        cancelClick();
        const api = canvasApi.current;
        if (!d.cancelled && api?.contains(e.clientX, e.clientY)) {
          onAddRef.current(d.packId, d.nodeId, api.clientToWorld(e.clientX, e.clientY));
          setToast(`放置：${d.label}`);
        }
      }
      setDragAdd(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  const beginPaletteDrag = (packId: string, nodeId: string, label: string, sx: number, sy: number) => {
    dragRef.current = { packId, nodeId, label, sx, sy, moved: false, cancelled: false };
  };
  const shouldIgnoreAdd = () => suppressClick.current;

  /**
   * 拖动结束的唯一写入口：把整组最终坐标一次写入文档 → 1 条历史。
   * 拖动过程中画布直写 DOM，文档不变，求值次数保持 0。
   */
  const onMoveCommit = (moves: { id: string; x: number; y: number }[]) => {
    if (!moves.length) return;
    const wanted = new Map<string, { x: number; y: number }>();
    for (const m of moves) wanted.set(m.id, { x: Math.round(m.x), y: Math.round(m.y) });
    commit((d) => {
      let changed = false;
      const nodes = d.nodes.map((n) => {
        const w = wanted.get(n.id);
        if (!w || (n.x === w.x && n.y === w.y)) return n;
        changed = true;
        return { ...n, x: w.x, y: w.y };
      });
      return changed ? { ...d, nodes } : d;
    }, moves.length > 1 ? `移动 ${moves.length} 个节点` : '移动节点');
  };

  const onParam = (id: string, key: string, value: string) => {
    // 「指定数据源」是明确指定文件；旧的数据源连线会和它互相打架（下拉显示
    // 一个文件、连线指向另一个），所以指定时先断开那条线。
    const dropSourceWire = key === 'sourceId' && value !== ''
      && edges.some((e) => e.to.node === id && e.to.port === 'buffer');
    commit(
      (d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n)),
        edges: dropSourceWire
          ? d.edges.filter((e) => !(e.to.node === id && e.to.port === 'buffer'))
          : d.edges,
      }),
      dropSourceWire ? '指定数据源' : '修改参数',
      `param:${id}:${key}`,
    );
    if (dropSourceWire) say('已改为手动指定数据源');
  };

  const onMode = (id: string, mode: 'value' | 'raw') => {
    commit(
      (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, portMode: mode } : n)) }),
      '切换端口值',
      `mode:${id}`,
    );
  };

  /** 标注节点拖动手柄：宽高一次提交（1 条撤销记录） */
  const onNoteResize = (id: string, w: number, h: number) => {
    commit(
      (d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id
          ? { ...n, params: { ...n.params, __w: String(Math.round(w)), __h: String(Math.round(h)) } }
          : n)),
      }),
      '调整标注大小',
    );
  };

  const onConnect = (from: string, fromPort: string, to: string, toPort: string) => {
    const a = nodes.find((n) => n.id === from);
    const b = nodes.find((n) => n.id === to);
    if (!a || !b) return;
    // result.ports 含运行时生成的元素端口。
    const ap = result.ports.get(from)?.outputs.find((p) => p.name === fromPort);
    const bp = result.ports.get(to)?.inputs.find((p) => p.name === toPort);
    if (!ap || !bp) return;
    if (!canConnect(ap.type, bp.type)) { say(`类型不匹配：${ap.type} → ${bp.type}`); return; }
    if (edges.some((e) => e.from.node === from && e.from.port === fromPort && e.to.node === to && e.to.port === toPort)) return;
    // 画一条数据源连线就是「用这个文件」的最新指令，清掉之前的下拉指定。
    const clearsPin = toPort === 'buffer' && !!b.params.sourceId;
    const id = `e${++seq.current}`;
    commit(
      (d) => ({
        ...d,
        nodes: clearsPin
          ? d.nodes.map((n) => (n.id === to ? { ...n, params: { ...n.params, sourceId: '' } } : n))
          : d.nodes,
        edges: [
          ...d.edges.filter((e) => !(e.to.node === to && e.to.port === toPort)),
          { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } },
        ],
      }),
      '连接',
    );
    say(toPort === 'buffer'
      ? `数据源：${a.nodeId === 'file' ? (a.source?.name ?? '文件') : (a.params.name || '上游')}`
      : `连接：${fromPort} → ${toPort}`);
  };

  /* ------------------------------------------------------------- 逆向导航 */
  const nodeTitleOf = (n: BPNode): string => {
    const view = fullResult.views.get(n.id);
    const auto = n.packId === '' && n.nodeId === 'element'
      && view?.kind === 'element' && view.inst
      ? `元素 · ${view.inst.typeName}`
      : n.packId
        ? (allPacks.get(n.packId)?.nodes[n.nodeId]?.label ?? n.nodeId)
        : (getBuiltin(n.nodeId)?.label ?? n.nodeId);
    return displayTitle(n, auto);
  };

  const navSnapshot = (label: string): NavSnapshot => ({
    view: canvasApi.current?.getView() ?? { x: 40, y: 30, k: 0.92 },
    selection: selectionRef.current,
    label,
  });

  /** 每次显式导航动作前记录离开的位置；普通平移/缩放不入栈。 */
  const recordNav = (label: string) => setNav((s) => pushNav(s, navSnapshot(label)));

  const applyNavStep = (step: ReturnType<typeof goBack>) => {
    if (!step) return;
    navRef.current = step.state;
    setNav(step.state);
    canvasApi.current?.setView(step.target.view);
    setSelection(step.target.selection);
  };
  const doNavBack = () => applyNavStep(goBack(navRef.current, navSnapshot('当前视图')));
  const doNavForward = () => applyNavStep(goForward(navRef.current, navSnapshot('当前视图')));

  /** 当前可用的 pack（被禁用的 pack 不参与「在此地址解析」候选） */
  const packEnabled = (packId: string) =>
    !doc.packs.some((p) => p.id === packId && !isPackEnabled(p));

  /**
   * 候选节点清单：pack 里的结构体 / 链表 / 数组 + 注册表里全部按地址
   * 工作的内置解析节点。元素解析由浮层顶部带类型下拉的「元素解析」承担。
   */
  const followItems = useMemo<FollowItem[]>(
    () => buildFollowItems({ packs: structures.packs, packNames, isEnabled: packEnabled }),
    [structures, packNames, doc.packs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const knownInMapping = (buffer: BufferValue) => knownTypesAt(nodes, fullResult.views, nodeId => {
    const src = fullResult.sources.get(nodeId)?.buffer;
    return !!src && src.assetId === buffer.assetId
      && BigInt(src.mappingBase ?? src.base) === BigInt(buffer.mappingBase ?? buffer.base);
  });

  const resolveFollowTarget = (value: unknown, nodeId?: string, type?: PortType) => {
    const typeIssue = followTypeIssue(type);
    if (typeIssue) return { reason: typeIssue } as const;
    const address = followAddress(value);
    if (address === null) return { reason: followHint(value) } as const;
    const info = nodeId ? fullResult.sources.get(nodeId) : undefined;
    if (info?.conflict || info?.wireMissing || info?.pinMissing) {
      return { address, reason: '来源不明确或不可用，请先确认使用哪份转储' } as const;
    }
    const mapped = isMappedAddress(value) ? value : isInstanceView(value) ? value.location : undefined;
    const candidates = (info?.buffer ? [info.buffer] : buffers).filter(
      (b) => !mapped || sameMapping(mapped, b),
    );
    const available = candidates.filter((b) => offsetIn(b, address) !== undefined);
    if (available.length !== 1) {
      if (available.length > 1) {
        return { address, candidates: available, info } as const;
      }
      return { address, reason: bufferIssue(address, candidates) } as const;
    }
    return { address, buffer: available[0], info } as const;
  };
  const openFollow = (
    value: unknown,
    description: string,
    source?: { nodeId: string; port: string },
    contextNodeId = source?.nodeId,
    type?: PortType,
  ): boolean => {
    const target = resolveFollowTarget(value, contextNodeId, type);
    if (!target.buffer && !('candidates' in target && target.candidates)) {
      say(`无法跟随：${target.reason}`);
      return false;
    }
    const { address, info } = target;
    const buffer = 'buffer' in target ? target.buffer : undefined;
    const candidates = 'candidates' in target ? target.candidates : undefined;
    // 元素端口 / 同地址已解析过的类型 → 元素解析默认选中它，省掉手选工具
    const sourceNode = source ? docRef.current.nodes.find((x) => x.id === source.nodeId) : undefined;
    const safe = safeNumber(address);
    const hint = buffer && safe !== undefined ? inferFollowType({
      value, address: safe, packs: packsMap, sourcePackId: sourceNode?.packId || sourceNode?.params.packId, knownAt: knownInMapping(buffer),
    }) : null;
    const file = info?.fileId ?? (buffer ? [...fullResult.sources].find(([, s]) => s.mode === 'file' && s.buffer === buffer)?.[0] : undefined);
    const bufferSource = info?.valueSource
      ? { nodeId: info.valueSource.node, port: info.valueSource.port }
      : file ? { nodeId: file, port: SOURCE_PORT } : undefined;
    setFollow({ address, description, source, hint, buffer, bufferSource, candidates });
    return true;
  };

  const onFollowPort = (nodeId: string, port: string) => {
    const v = fullResult.outputs.get(nodeId)?.[port];
    const n = docRef.current.nodes.find((x) => x.id === nodeId);
    const type = fullResult.ports.get(nodeId)?.outputs.find(p => p.name === port)?.type;
    openFollow(v, `${n ? nodeTitleOf(n) : nodeId} · ${port}`, { nodeId, port }, nodeId, type);
  };

  const onFollowInPort = (nodeId: string, port: string) => {
    const v = fullResult.inputs.get(nodeId)?.[port]?.value;
    const n = docRef.current.nodes.find((x) => x.id === nodeId);
    const edge = docRef.current.edges.find((e) => e.to.node === nodeId && e.to.port === port);
    if (v === undefined || v === null) {
      say(edge
        ? '无法跟随：上游端口还没有输出值'
        : '无法跟随：这个输入没有连线——先接一个上游端口，或直接双击上游的输出端口');
      return;
    }
    openFollow(
      v,
      `${n ? nodeTitleOf(n) : nodeId} · ${port}（输入）`,
      edge ? { nodeId: edge.from.node, port: edge.from.port } : undefined,
      nodeId,
      fullResult.ports.get(nodeId)?.inputs.find(p => p.name === port)?.type,
    );
  };

  /**
   * 打开全屏结构树：把节点当前求值结果翻译成树根（类型 + 地址 + 内存）。
   * 内存优先用实例自带的 Memory，退回该节点的数据源缓冲区。
   */
  const openNodeTree = (nodeId: string, focus?: TreeFocus) => {
    const node = docRef.current.nodes.find((n) => n.id === nodeId);
    const view = fullResult.views.get(nodeId);
    if (!node || !view) return;
    if (((view.kind === 'struct' || view.kind === 'element') && view.inst?.location)
      || ((view.kind === 'list' || view.kind === 'array') && view.local)) {
      setLocalTree(nodeId);
      return;
    }
    const pack = node.packId ? structures.packs.get(node.packId) : undefined;
    const def = pack?.nodes[node.nodeId];
    const buffer = fullResult.sources.get(nodeId)?.buffer;
    const fallbackMem = buffer ? packMemory(buffer) : undefined;
    const numInput = (name: string): number | undefined => {
      const v = fullResult.inputs.get(nodeId)?.[name]?.value;
      const at = isMappedAddress(v) ? v.value : addressInteger(v);
      return at === undefined ? undefined : safeNumber(at);
    };
    const ownerOf = (typeName: string, prefer?: BlueprintPack): BlueprintPack | undefined => {
      if (prefer?.types[typeName]) return prefer;
      for (const p of structures.packs.values()) if (p.types[typeName]) return p;
      return undefined;
    };

    let root: TreeRootSpec | undefined;
    const label = displayTitle(node, nodeTitleOf(node));
    if ((view.kind === 'struct' || view.kind === 'element') && view.inst) {
      const owner = ownerOf(view.inst.typeName, pack);
      const mem = view.inst.mem ?? fallbackMem;
      if (owner && mem) {
        root = {
          kind: 'struct', pack: owner, type: owner.types[view.inst.typeName], mem,
          addr: view.inst.addr, label,
        };
      }
    } else if (view.kind === 'list' && pack && def?.kind === 'list') {
      const mem = view.items[0]?.mem ?? fallbackMem;
      const head = numInput('address') ?? view.items[0]?.addr;
      if (mem && head != null) {
        root = {
          kind: 'list', pack, type: def.type, mem, addr: head, label,
          next: def.next, nulls: def.nulls, max: def.max,
        };
      }
    } else if (view.kind === 'array' && pack && def?.kind === 'array') {
      const mem = view.items[0]?.mem ?? fallbackMem;
      const base = numInput('address') ?? view.items[0]?.addr;
      const count = def.count ?? numInput('count') ?? view.count;
      if (mem && base != null && count > 0) {
        root = {
          kind: 'array', pack, type: def.type, mem, addr: base, count, label,
          stride: def.stride ?? def.type.size,
        };
      }
    }

    if (!root) {
      say(view.kind === 'list' || view.kind === 'array'
        ? '这个节点还没有可展开的数据：先接上文件与地址'
        : '这个节点暂时没有可展开的结构');
      return;
    }
    setTree({
      nodeId, root, focus,
      title: displayTitle(node, nodeTitleOf(node)), subtitle: buffer?.name,
      sourceAssetId: buffer?.bytes === root.mem.buf ? buffer.assetId : undefined,
    });
  };

  /** 多级指针预览：结构树优先使用自己的缓冲区，不按地址猜文件。 */
  const previewChain = (
    request: FollowRequest, width: 4 | 8, offsets: bigint[], bufferOverride?: BufferValue,
  ): FollowPreview | null => {
    const base = request.address;
    const buf = bufferOverride ?? request.buffer;
    if (!buf) return { steps: [], final: base, error: '起始地址不在任何缓冲区内' };
    const steps: FollowStep[] = [];
    let cur = BigInt(base);
    for (let i = 0; i < offsets.length; i += 1) {
      try {
        const readAt = addOffset(cur, offsets[i]);
        const read = pointerRead(buf, readAt, width, 'little');
        steps.push({ offset: offsets[i], readAt, target: read.raw });
        if (read.state !== 'mapped') {
          return { steps, final: read.raw, error: `第 ${i + 1} 级${read.state === 'null' ? '为空指针' : '目标未映射'}：${addressHex(read.raw)}` };
        }
        cur = read.raw;
      } catch (err) {
        return { steps, final: cur, error: `第 ${i + 1} 级：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { steps, final: cur };
  };

  /** 树里唤起跟随浮层后，无论选完还是取消都回到结构树（状态一直没卸载）。 */
  const restoreTree = () => {
    if (!followFromTree.current) return;
    followFromTree.current = false;
    setTreeHidden(false);
  };

  /** 跟随落点：按请求创建解析节点并连线；返回是否真的落了节点。 */
  const addFollowNodes = (
    req: FollowRequest, item: FollowItem, offsets: bigint[] = [], width: 4 | 8 = 8, bufferOverride?: BufferValue,
  ): boolean => {
    const buffer = bufferOverride ?? req.buffer;
    const pv = offsets.length ? previewChain(req, width, offsets, buffer) : null;
    if (pv?.error) { say(pv.error); return false; }
    // 元素解析的类型只能来自推断；没有类型就不创建，避免硬解出错误内容。
    if (item.nodeId === 'element' && (!item.typePackId || !item.typeName)) {
      say('无法推断元素类型：请直接选择结构体 / 链表 / 数组节点');
      return false;
    }
    setFollow(null);
    lastFollowKey.current = item.key;
    const addrHex = `0x${req.address.toString(16)}`;
    recordNav(`跟随 ${addrHex}${offsets.length ? ` ×${offsets.length} 级` : ''}`);

    const src = req.source
      ? docRef.current.nodes.find((n) => n.id === req.source!.nodeId)
      : undefined;
    const center = canvasApi.current?.centerWorld() ?? { x: 0, y: 0 };
    const startX = src ? src.x + 360 : Math.round(center.x - NODE_WIDTH / 2);
    const startY = src ? src.y + 48 : Math.round(center.y - 16);
    const clashes = (px: number, py: number) => docRef.current.nodes.some(
      (n) => Math.abs(n.x - px) < 300 && Math.abs(n.y - py) < 170,
    );
    let y = startY;
    for (let i = 0; i < 12 && clashes(startX, y); i += 1) y += 190;

    // 非零偏移显式生成换算节点，每次解引用只由读指针负责。
    const nodes: BPNode[] = [];
    const edges: BPEdge[] = [];
    let cursorY = y;
    const sourcePort = req.source
      ? result.ports.get(req.source.nodeId)?.outputs.find((p) => p.name === req.source?.port) : undefined;
    const connected = !!(req.source && sourcePort && canConnect(sourcePort.type, offsets.length ? 'address' : item.addressType));
    const pinnedFile = bufferOverride && !connected && buffer
      ? [...fullResult.sources].find(([, s]) => s.mode === 'file' && s.buffer
        && s.buffer.assetId === buffer.assetId
        && BigInt(s.buffer.mappingBase ?? s.buffer.base) === BigInt(buffer.mappingBase ?? buffer.base))?.[0]
      : undefined;
    let prevOut: { node: string; port: string } | null = connected && req.source
      ? { node: req.source.nodeId, port: req.source.port } : null;
    let prevAddr = req.address;
    for (let i = 0; i < offsets.length; i += 1) {
      if (offsets[i] !== 0n) {
        const id = `n${++seq.current}`;
        nodes.push({
          id, packId: '', nodeId: 'address', x: startX, y: cursorY,
          params: { ...builtinDefaults('address'), base: addressHex(prevAddr), offset: String(offsets[i]) },
        });
        if (prevOut) edges.push({ id: `e${++seq.current}`, from: prevOut, to: { node: id, port: 'base' } });
        prevOut = { node: id, port: 'address' };
        cursorY += 190;
      }
      const id = `n${++seq.current}`;
      nodes.push({
        id, packId: '', nodeId: 'ptrwalk', x: startX, y: cursorY,
        params: {
          ...builtinDefaults('ptrwalk'),
          address: addressHex(pv?.steps[i]?.readAt ?? prevAddr),
          pointerSize: String(width),
          endian: 'little',
        },
      });
      if (prevOut) edges.push({ id: `e${++seq.current}`, from: prevOut, to: { node: id, port: 'address' } });
      prevOut = { node: id, port: 'target' };
      prevAddr = pv?.steps[i]?.target ?? prevAddr;
      cursorY += 190;
    }

    const finalId = `n${++seq.current}`;
    const finalHex = `0x${prevAddr.toString(16)}`;
    /**
     * pack 节点只带地址；内置节点带默认配置；
     * 元素解析写入推断出的 packId + typeId，在该地址解码，
     * 字段端口随实际类型生成（不依赖用户预先选了哪个结构体工具）。
     */
    const params: Record<string, string> = item.packId
      ? { [item.inputPort]: finalHex, ...(pinnedFile ? { sourceId: pinnedFile } : {}) }
      : item.nodeId === 'element'
        ? {
            ...builtinDefaults('element'),
            ...inheritOptions('element', nodes),
            [item.inputPort]: finalHex,
            packId: item.typePackId ?? '',
            typeId: item.typeName ?? '',
            index: '0',
            ...(pinnedFile ? { sourceId: pinnedFile } : {}),
          }
        : {
            ...builtinDefaults(item.nodeId),
            ...inheritOptions(item.nodeId, nodes),
            ...(item.structureId ? { structureId: item.structureId } : {}),
            [item.inputPort]: finalHex,
            ...(pinnedFile ? { sourceId: pinnedFile } : {}),
          };
    nodes.push({
      id: finalId, packId: item.packId, nodeId: item.nodeId, x: startX, y: cursorY,
      params,
    });
    const linkTarget = !!prevOut && (!offsets.length || canConnect('address', item.addressType));
    if (prevOut && linkTarget) edges.push({
      id: `e${++seq.current}`, from: prevOut,
      to: { node: finalId, port: item.inputPort },
    });
    if (req.bufferSource && (!connected || (offsets.length > 0 && !linkTarget))) {
      const { nodeId, port } = req.bufferSource;
      const targets = [...(!connected ? nodes.slice(0, 1) : []), ...(offsets.length && !linkTarget ? nodes.slice(-1) : [])];
      for (const target of targets) edges.push({
        id: `e${++seq.current}`, from: { node: nodeId, port }, to: { node: target.id, port: SOURCE_PORT },
      });
    }

    commit((d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }),
      offsets.length ? '多级指针跟随' : '跟随地址');
    setSelection(selectOnlyNode(finalId));
    window.setTimeout(() => canvasApi.current?.centerOn(finalId), 0);
    const what = item.nodeId === 'element' && item.typeName
      ? `元素解析 · ${item.typeName}`
      : item.label;
    say(offsets.length
      ? `在 ${addrHex} 经 ${offsets.length} 级指针解析 ${what} → ${finalHex}`
      : `在 ${addrHex} 按 ${what} 解析`);
    return true;
  };

  const doFollow = (
    item: FollowItem, offsets: bigint[] = [], width: 4 | 8 = 8, buffer?: BufferValue,
  ) => {
    const req = follow;
    if (!req) return;
    if (addFollowNodes(req, item, offsets, width, buffer)) restoreTree();
  };

  /** 树上的行不一定有画布端口（例如截断之后的元素）；仅连接真实、匹配的输出。 */
  const requestFromTree = (addr: number, description: string, port?: string): FollowRequest | undefined => {
    if (!tree?.root.mem.contains(addr, 1)) return undefined;
    const id = tree.nodeId;
    const outputs = result.outputs.get(id);
    const spec = result.ports.get(id)?.outputs.find((p) => p.name === port);
    const value = port ? outputs?.[port] : undefined;
    const found = followAddress(value);
    const source = spec && canConnect(spec.type, 'pack-address') && found !== null && BigInt(found) === BigInt(addr)
      ? { nodeId: id, port: spec.name } : undefined;
    const info = result.sources.get(id);
    const mem = tree.root.mem;
    // A value-source edge (e.g. File.buffer) is resolved lazily; the tree
    // already owns the exact bytes. Fall back to the tree memory instead of
    // rejecting a perfectly valid element row.
    const treeBuffer: BufferValue = {
      assetId: tree.sourceAssetId ?? `tree:${mem.base}`,
      name: '结构树',
      base: BigInt(mem.base),
      bytes: mem.buf,
    };
    const buffer = info?.buffer ?? treeBuffer;
    if (BigInt(buffer.base) !== BigInt(mem.base)
      || (buffer.bytes !== mem.buf && buffer.assetId !== tree.sourceAssetId)) return undefined;
    let bufferSource: FollowRequest['bufferSource'];
    if (!source && info?.fileId) {
      bufferSource = { nodeId: info.fileId, port: SOURCE_PORT };
    } else if (info?.valueSource) {
      bufferSource = { nodeId: info.valueSource.node, port: info.valueSource.port };
    }
    if (!source && !bufferSource) {
      for (const [nid, s] of result.sources) {
        if (s.mode !== 'file' || !s.buffer) continue;
        if (s.buffer.bytes === mem.buf || (!!tree.sourceAssetId && s.buffer.assetId === tree.sourceAssetId)) {
          bufferSource = { nodeId: nid, port: SOURCE_PORT };
          break;
        }
      }
    }
    if (!source && !bufferSource) return undefined;
    return { address: addr, description, source, bufferSource, buffer };
  };

  /** 结构树里点 ⊕：按该行实际类型直接落一个元素解析节点，树保持打开。 */
  const resolveFromTree = (addr: number, typeName: string, port?: string): boolean => {
    const req = requestFromTree(addr, `结构树 · ${typeName} @0x${addr.toString(16)}`, port);
    if (!req) return false;
    // The tree root uses the materialized pack from StructureRegistry, while
    // packsMap holds raw loaded packs; prefer the node's own packId and fall
    // back to identity across both maps.
    const treeNode = tree ? docRef.current.nodes.find(n => n.id === tree.nodeId) : undefined;
    const packId = treeNode?.packId
      || [...structures.packs].find(([, pack]) => pack === tree?.root.pack)?.[0]
      || [...packsMap].find(([, pack]) => pack === tree?.root.pack)?.[0];
    if (!packId) return false;
    const item = elementFollowItem({ packId, typeName, reason: '结构树当前类型' });
    if (!item) return false;
    return addFollowNodes(req, item);
  };

  /* ------------------------------------------------------- 图内搜索定位 */
  const searchHits = useMemo<SearchHit[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = docRef.current.nodes;
    const describe = (n: BPNode): SearchHit => ({
      nodeId: n.id,
      title: nodeTitleOf(n),
      detail: `${n.packId ? (packNames.get(n.packId) ?? n.packId) : '内置'} · ${n.nodeId} · ${n.x},${n.y}`,
    });
    if (!q) return list.map(describe);

    if (/^0x[0-9a-f]+$/i.test(q) || /^\d+$/.test(q)) {
      const addr = addressInteger(q);
      if (addr === undefined) return [];
      const out: SearchHit[] = [];
      for (const [nodeId, view] of fullResult.views) {
        const insts = view.kind === 'struct' || view.kind === 'element'
          ? (view.inst ? [view.inst] : [])
          : view.kind === 'list' || view.kind === 'array' ? view.items : [];
        const n = list.find((x) => x.id === nodeId);
        for (const inst of insts) {
          const start = inst.location?.value ?? BigInt(inst.addr);
          if (addr < start || addr >= start + BigInt(inst.size)) continue;
          out.push({
            nodeId,
            address: start,
            title: `${n ? nodeTitleOf(n) : nodeId} · ${inst.typeName}`,
            detail: `${addressHex(start)} +${addr - start} / ${inst.size} B`,
          });
        }
      }
      return out;
    }

    return list.filter((n) => {
      const ports = [
        ...(fullResult.ports.get(n.id)?.inputs ?? []),
        ...(fullResult.ports.get(n.id)?.outputs ?? []),
      ].map((p) => `${p.name} ${p.label ?? ''}`).join(' ');
      return `${nodeTitleOf(n)} ${n.id} ${n.nodeId} ${n.packId} ${packNames.get(n.packId) ?? ''} ${ports} ${n.params.text ?? ''}`
        .toLowerCase().includes(q);
    }).map(describe);
  }, [searchQuery, nodes, fullResult, packNames]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchPick = (hit: SearchHit) => {
    setSearchOpen(false);
    recordNav(`查找 ${hit.title}`);
    setSelection(selectOnlyNode(hit.nodeId));
    canvasApi.current?.centerOn(hit.nodeId);
  };

  /* --------------------------------------------------- 一键自动布局 */
  const doAutoLayout = () => {
    const sizes = canvasApi.current?.sizes();
    if (!sizes || !nodes.length) { say('画布上没有节点'); return; }
    const { preds, succs } = adjacency(nodes.map((n) => n.id), edges);
    const list = nodes.map((n) => ({
      id: n.id,
      h: sizes.get(n.id)?.h ?? 140,
      preds: preds.get(n.id)!,
      succs: succs.get(n.id)!,
    }));
    // 起点取当前视口左上角的世界坐标，让结果尽量落在视野内。
    const view = canvasApi.current?.getView() ?? { x: 0, y: 0, k: 1 };
    const origin = { x: Math.round(-view.x / view.k) + 40, y: Math.round(-view.y / view.k) + 40 };
    // 孤立节点（标注、备用常量）保持原位：把它们的包围盒交给布局去避开。
    const isolatedIds = nodes
      .filter((n) => !preds.get(n.id)!.length && !succs.get(n.id)!.length)
      .map((n) => n.id);
    const avoid: { x: number; y: number; w: number; h: number }[] = [];
    if (isolatedIds.length) {
      const bb = boundsOf(isolatedIds, nodes, sizes);
      if (bb) avoid.push({ x: bb.x - 24, y: bb.y - 24, w: bb.w + 48, h: bb.h + 48 });
    }
    const { positions } = autoLayout(list, { origin, avoid });
    if (!positions.size) { say('没有需要重排的连线（孤立节点保持原位）'); return; }
    recordNav('自动布局');
    commit(
      (d) => ({
        ...d,
        nodes: d.nodes.map((n) => {
          const p = positions.get(n.id);
          return p ? { ...n, x: p.x, y: p.y } : n;
        }),
      }),
      '自动布局',
    );
    window.setTimeout(() => canvasApi.current?.fitAll(), 0);
    say(`已按数据流重排 ${positions.size} 个节点（孤立节点保持原位）`);
  };

  const onDisconnect = (nodeId: string, port: string) => {
    commit((d) => ({
      ...d,
      edges: d.edges.filter((e) => !(e.to.node === nodeId && e.to.port === port)),
    }), '断开连线');
    say(port === 'buffer' ? '断开：数据源' : `断开：${port}`);
  };

  const onDeleteEdge = (id: string) => {
    deleteObjects({ ...emptySelection(), edges: new Set([id]) }, '删除连线');
  };

  // ---- 复制 / 剪切 / 粘贴 / 副本 ------------------------------------------
  const nextEntityId = () => `n${++seq.current}`;

  /** 复制：只进内存剪贴板；系统剪贴板写失败静默忽略 */
  const copySelection = (): Fragment | null => {
    const frag = extractFragment(docRef.current, selectionRef.current);
    if (!frag) return null;
    clip.current = frag;
    pasteCount.current = 0;
    setClipCount(frag.nodes.length);
    try {
      const p = navigator.clipboard?.writeText(JSON.stringify(frag));
      if (p && typeof p.catch === 'function') p.catch(() => { /* 权限被拒时忽略 */ });
    } catch { /* 无剪贴板 API 时忽略 */ }
    return frag;
  };

  const onCopy = () => {
    const frag = copySelection();
    if (!frag) { say('未选中对象'); return; }
    say(`复制 ${frag.nodes.length} 个节点`);
  };

  const onCut = () => {
    const frag = copySelection();
    if (!frag) { say('未选中对象'); return; }
    const before = docRef.current;
    const after = deleteSelection(before, selectionRef.current);
    const n = before.nodes.length - after.nodes.length;
    const e = before.edges.length - after.edges.length;
    if (after !== before) {
      commit(() => after, `剪切 ${n + e} 个对象`);
      setSelection((s) => retainSelection(s, after));
    }
    say(`剪切 ${n} 个节点`);
  };

  const pasteAt = (offset: number, label: string) => {
    const frag = clip.current;
    if (!frag) { say('剪贴板为空'); return; }
    const r = pasteFragment(docRef.current, frag, { offset, nextId: nextEntityId });
    commit(() => r.doc, label);
    setSelection(addNodes(emptySelection(), r.nodes.map((n) => n.id)));
    say(`粘贴 ${r.nodes.length} 个节点`);
  };

  const onPaste = () => {
    pasteCount.current += 1;
    pasteAt(pasteOffset(pasteCount.current), `粘贴 ${clip.current?.nodes.length ?? 0} 个节点`);
  };

  const onDuplicate = () => {
    const r = duplicateSelection(docRef.current, selectionRef.current, () => nextEntityId());
    if (!r) { say('未选中对象'); return; }
    commit(() => r.doc, `创建副本 ${r.nodes.length} 个节点`);
    setSelection(addNodes(emptySelection(), r.nodes.map((n) => n.id)));
    say(`副本 ${r.nodes.length} 个节点`);
  };

  /** 批量删除当前选择 */
  const onDeleteSelection = () => {
    const s = selectionRef.current;
    if (isEmptySelection(s)) return;
    const before = docRef.current;
    const after = deleteSelection(before, s);
    if (after === before) return;
    const n = before.nodes.length - after.nodes.length;
    const e = before.edges.length - after.edges.length;
    deleteObjects(s, deleteLabel(n, e));
  };

  const onLoadPack = async (f: File): Promise<boolean> => {
    const src = await f.text();
    const r = loadBlueprintPack(src);
    if (!r.pack) { say(`加载失败：${r.error ?? '未知错误'}`); setPackIssues(r.issues); return false; }
    const pack = r.pack;
    const id = `p${++seq.current}`;
    const added = addPack(docRef.current, { id, name: pack.name, source: src, pack, enabled: true });
    commit(() => added.doc, `导入 pack：${added.pack.name}`);
    setPackIssues((xs) => [...xs, ...r.issues]);
    say(`加载：${f.name}`);
    return true;
  };

  /** 商店安装：编译后按商店 id 复用已有 pack（更新）或追加新 pack。 */
  const onInstallStorePack = async ({
    entry, source, storeUrl: url,
  }: { entry: StorePackEntry; source: string; storeUrl: string }): Promise<{ ok: boolean; error?: string; updated?: boolean }> => {
    const check = await verifyPackSource(source, entry.sha256);
    if (!check.ok) return { ok: false, error: check.error ?? 'pack 哈希校验失败' };
    const r = loadBlueprintPack(source);
    if (!r.pack) return { ok: false, error: r.error ?? 'pack 编译失败' };
    const ref = {
      url,
      packId: entry.id,
      version: entry.version,
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.source?.provider ? { provider: entry.source.provider } : {}),
      ...(entry.coverage ? { coverage: entry.coverage } : {}),
      ...(entry.helpers ? { helpers: entry.helpers } : {}),
      ...(entry.reference ? { reference: entry.reference } : {}),
    };
    const existing = installedPackOf(docRef.current.packs, url, entry.id);
    if (existing) {
      const next = updatePackSource(docRef.current, existing.id, source, r.pack, ref);
      commit(() => next, `更新 pack：${entry.name} v${entry.version}`);
      setPackIssues((xs) => [...xs, ...r.issues]);
      say(`更新 pack：${entry.name} v${entry.version}`);
      return { ok: true, updated: true };
    }
    const id = `p${++seq.current}`;
    const added = addPack(docRef.current, {
      id, name: r.pack.name, source, pack: r.pack, enabled: true, store: ref,
    });
    commit(() => added.doc, `安装 pack：${entry.name} v${entry.version}`);
    setPackIssues((xs) => [...xs, ...r.issues]);
    say(`安装 pack：${entry.name} v${entry.version}`);
    return { ok: true, updated: false };
  };

  const onStoreUrl = (url: string) => {
    setStoreUrl(url);
    writeStorePrefs({ url });
  };

  /** 读取失败返回错误文本（由检查器显示在来源旁），成功返回 undefined */
  const onFileNode = async (id: string, f: File): Promise<string | undefined> => {
    try {
      let bytes: Uint8Array;
      if (/\.hex$|\.txt$/i.test(f.name)) {
        const parsed = parseHexText(await f.text());
        if (parsed.error) return parsed.error;
        bytes = parsed.bytes;
      } else {
        bytes = await readFile(f);
      }
      const data = bytes.length <= SESSION_ONLY_BYTES ? bytesToBase64(bytes) : '';
      commit((d) => ({
        ...d,
        nodes: d.nodes.map((n) => {
          if (n.id !== id) return n;
          const base = n.source?.base ?? '0x0';
          const source = withSessionBytes({ name: f.name, base, data }, bytes);
          return { ...n, params: { ...n.params, name: f.name }, source };
        }),
      }), '载入文件');
      say(`文件：${f.name} · ${bytes.length} B`);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const onFileHex = (id: string, text: string): string | undefined => {
    const parsed = parseHexText(text);
    if (parsed.error) return parsed.error;
    const data = parsed.bytes.length <= SESSION_ONLY_BYTES ? bytesToBase64(parsed.bytes) : '';
    commit((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== id) return n;
        const base = n.source?.base ?? '0x0';
        const source = withSessionBytes({ name: 'pasted.hex', base, data }, parsed.bytes);
        return { ...n, params: { ...n.params, name: 'pasted.hex' }, source };
      }),
    }), '载入 HEX');
    say(`HEX：${parsed.bytes.length} B`);
    return undefined;
  };

  // 基址改动就地显示在检查器字段里，不再走 toast。
  const onFileBase = (id: string, base: string) => {
    commit((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === id
        ? {
          ...n,
          source: n.source
            ? rebaseStored(n.source, base)
            : { name: '未载入', data: '', base },
        }
        : n)),
    }), '改基址', `base:${id}`);
  };

  /**
   * 字节预览 → 读数值节点：来源、地址、类型、字节序全部沿用刚才的试读，
   * 一次提交（一次撤销），并放到来源右侧的空位。
   */
  const onAddRead = (
    sourceId: string,
    cfg: { address: bigint; kind: string; endian: 'little' | 'big' },
  ) => {
    const src = docRef.current.nodes.find((n) => n.id === sourceId);
    const center = canvasApi.current?.centerWorld() ?? { x: 0, y: 0 };
    const vis = canvasApi.current?.visibleWorld();
    const maxX = vis ? vis.maxX - 8 - NODE_WIDTH : Number.POSITIVE_INFINITY;
    const maxY = vis ? vis.maxY - 8 - 140 : Number.POSITIVE_INFINITY;
    const minX = vis ? vis.minX + 8 : Number.NEGATIVE_INFINITY;
    const minY = vis ? vis.minY + 8 : Number.NEGATIVE_INFINITY;
    const x = Math.min(Math.max(src ? src.x + 360 : Math.round(center.x - NODE_WIDTH / 2), minX), Math.max(minX, maxX));
    const clashes = (px: number, py: number) => docRef.current.nodes.some(
      (n) => Math.abs(n.x - px) < 300 && Math.abs(n.y - py) < 190,
    );
    let y = Math.min(Math.max(src ? src.y : Math.round(center.y - 16), minY), Math.max(minY, maxY));
    for (let i = 0; i < 12 && y + 190 <= maxY && clashes(x, y); i += 1) y += 190;
    const id = `n${++seq.current}`;
    const next: BPNode = {
      id,
      packId: '',
      nodeId: 'readint',
      x,
      y,
      params: {
        ...builtinDefaults('readint'),
        ...inheritOptions('readint', docRef.current.nodes),
        address: addressHex(cfg.address),
        scalar: cfg.kind,
        endian: cfg.endian,
        sourceId,
      },
    };
    commit((d) => ({ ...d, nodes: [...d.nodes, next] }), '添加读数值节点');
    setSelection(selectOnlyNode(id));
    say(`读数值：${cfg.kind} @ ${addressHex(cfg.address)}`);
  };

  /**
   * 结构体 → 来源缓冲区：选中 File 节点，并让它的检查器视图滚到指定绝对地址。
   * 定位目标只消费一次，之后手动选中 File 节点不会再次跳转。
   */
  const openBuffer = (fileId: string, addr: bigint) => {
    setSelection(selectOnlyNode(fileId));
    setRightTab('inspect');
    setBufferFocus({ nodeId: fileId, addr });
    window.clearTimeout(bufferFocusTimer.current);
    bufferFocusTimer.current = window.setTimeout(() => setBufferFocus(null), 0);
  };

  const createLayout = (nodeId: string): string => {
    const id = `l${++seq.current}`;
    commit(d => {
      const next: BinaryLayout = {
        id, name: `布局 ${1 + (d.layouts?.length ?? 0)}`, endian: 'little',
        fields: [{ id: 'f1', name: 'field1', kind: 'u8' }],
      };
      return {
        ...d, layouts: [...(d.layouts ?? []), next],
        nodes: d.nodes.map(n => n.id === nodeId ? { ...n, params: { ...n.params, structureId: `layout/${id}`, nextField: '' } } : n),
      };
    }, '新建结构布局');
    return id;
  };

  const applyDesignerLayouts = (next: BinaryLayout[], label: string): DesignerApplyResult => {
    if (!validLayoutDocument(next)) {
      return { ok: false, message: '布局超出文档限制（数量、id、字段数或字段类型无效）' };
    }
    const review = reviewLayouts(docRef.current.layouts ?? [], next);
    if (!review.ok) {
      return { ok: false, problems: review.problems, message: review.message };
    }
    commit(d => ({ ...d, layouts: next }), label);
    return { ok: true, problems: review.problems };
  };

  const navigateDesigner = (next: string[]) => {
    if (!designerOpenRef.current) {
      setDesignerBase(cloneLayouts(docRef.current.layouts));
      designerReturnHash.current = window.location.hash.startsWith('#design') ? '' : window.location.hash;
    }
    window.history.pushState(null, '', designerHash(next));
    setDesignerStack(next);
  };

  const openDesigner = (structureId?: string) => {
    const layouts = docRef.current.layouts ?? [];
    const raw = structureId?.startsWith('layout/') ? structureId.slice('layout/'.length) : structureId;
    const stack = raw && layouts.some(l => l.id === raw) ? [raw] : [];
    if (designerOpenRef.current) { navigateDesigner(stack); return; }
    designerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    designerReturnHash.current = window.location.hash.startsWith('#design') ? '' : window.location.hash;
    setDesignerBase(cloneLayouts(layouts));
    window.history.pushState(null, '', designerHash(stack));
    setDesignerStack(stack);
  };

  const closeDesigner = () => {
    const target = designerReturnHash.current || `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', target);
    setDesignerStack(null);
    setDesignerBase(null);
    window.requestAnimationFrame(() => designerTrigger.current?.focus());
  };

  const restoreDesignerSession = () => {
    if (!designerBase) return;
    commit(d => ({ ...d, layouts: cloneLayouts(designerBase) }), '撤销本次设计器修改');
  };

  useEffect(() => {
    const sync = () => {
      const route = parseDesignerHash(window.location.hash);
      if (route) {
        if (!designerOpenRef.current) setDesignerBase(cloneLayouts(docRef.current.layouts));
        setDesignerStack(route.stack);
        return;
      }
      if (designerOpenRef.current) {
        setDesignerStack(null);
        setDesignerBase(null);
        window.requestAnimationFrame(() => designerTrigger.current?.focus());
      }
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  const selectLayout = (id: string, structureId: string) => {
    commit(d => ({ ...d, nodes: d.nodes.map(n => n.id === id
      ? { ...n, params: { ...n.params, structureId, nextField: '' } } : n) }), '选择结构');
  };

  // ---- pack 管理：全部经 commit，一次 Ctrl+Z 完整回滚 ----------------------
  /** 启用/禁用：只改 pack 元数据，节点与连线保留 */
  const onTogglePack = (id: string, enabled: boolean) => {
    const pack = docRef.current.packs.find((p) => p.id === id);
    if (!pack) return;
    const next = setPackEnabled(docRef.current, id, enabled);
    if (next === docRef.current) return;
    commit(() => next, `${enabled ? '启用' : '禁用'} pack：${pack.name}`);
    say(`${enabled ? '启用' : '禁用'}：${pack.name}`);
  };

  /** 行内重命名：去空格、空名拒绝、重名自动加后缀 */
  const onRenamePack = (id: string, raw: string) => {
    const r = renamePack(docRef.current, id, raw);
    if (r.code === 'EMPTY') { say('pack 名不能为空'); return; }
    if (r.code !== 'OK') return;
    commit(() => r.doc, `重命名 pack：${r.name ?? raw}`);
  };

  /** 删除：pack + 其节点 + 关联连线一次产出，不留孤儿连线 */
  const onDeletePack = (id: string) => {
    const pack = docRef.current.packs.find((p) => p.id === id);
    if (!pack) return;
    const next = removePackAtomic(docRef.current, id);
    if (next === docRef.current) return;
    commit(() => next, `删除 pack：${pack.name}`);
    setSelection((s) => retainSelection(s, next));
    say(`删除 pack：${pack.name}`);
  };

  /** 清理 N 个节点：只删节点与关联连线，pack 留在文档里（可再启用） */
  const onCleanupPack = (id: string) => {
    const pack = docRef.current.packs.find((p) => p.id === id);
    if (!pack) return;
    const next = cleanupPackNodes(docRef.current, id);
    if (next === docRef.current) return;
    const removed = docRef.current.nodes.length - next.nodes.length;
    commit(() => next, `清理 pack：${pack.name} 的 ${removed} 个节点`);
    setSelection((s) => retainSelection(s, next));
    say(`清理 ${removed} 个节点：${pack.name}`);
  };

  // ---- 工作区 / 文件 --------------------------------------------------------
  const askConfirm = (req: ConfirmRequest): Promise<boolean> => new Promise((resolve) => {
    // 同时出现第二个确认时，先让前一个以「取消」结束，避免两个异步动作争抢
    confirmResolve.current?.(false);
    confirmResolve.current = resolve;
    setConfirm(req);
  });
  const closeConfirm = (ok: boolean) => {
    setConfirm(null);
    const r = confirmResolve.current;
    confirmResolve.current = null;
    r?.(ok);
  };

  const hasWork = (d: DocState) => d.nodes.length > 0 || d.edges.length > 0 || d.packs.length > 0;
  /** 示例模式下要保护的是工作图，而不是临时副本 */
  const workDocNow = () => (sampleModeRef.current ? workSession.current?.doc ?? docRef.current : docRef.current);

  /** 导出当前图；浏览器只能确认「已发起下载」，不声称落盘成功 */
  const exportNow = () => {
    const d = docRef.current;
    const packEntries = d.packs.map((p) => ({
      id: p.id, name: p.name, source: p.source, enabled: isPackEnabled(p),
      ...(p.store ? { store: p.store } : {}),
    }));
    // 大文件平时只留会话字节；导出是显式操作，这里再补 base64 保持单文件可交付。
    const nodes = d.nodes.map((n) => {
      const bytes = n.source && !n.source.data ? sessionBytesOf(n.source) : undefined;
      return bytes ? { ...n, source: { ...n.source!, data: bytesToBase64(bytes) } } : n;
    });
    const out = makeDoc(packEntries, nodes, d.edges, d.layouts);
    downloadBlob(new TextEncoder().encode(JSON.stringify(out, null, 2)), 'blueprint.json', 'application/json');
    setExportAt(Date.now());
    say('已发起导出：blueprint.json');
  };

  const onSaveDoc = (warnMissing = true) => {
    const missing = docRef.current.nodes.filter((n) => n.source?.name && !hasStoredBytes(n.source));
    if (warnMissing && missing.length) {
      const names = [...new Set(missing.map((n) => n.source!.name))];
      void askConfirm({
        title: '部分转储需要重新载入',
        body: `${names.join('、')} 的字节不在缓存中。导出的图只保留文件名与基址，不含这些内容。`,
        confirmLabel: '仍要导出',
        secondaryLabel: '先重新载入',
        onSecondary: () => closeConfirm(false),
      }).then((ok) => { if (ok) exportNow(); });
      return;
    }
    exportNow();
  };

  /** 替换非空工作图前必须确认；即使已经自动缓存也一样 */
  const confirmReplace = (title: string): Promise<boolean> => {
    if (!hasWork(workDocNow())) return Promise.resolve(true);
    return askConfirm({
      title,
      body: '当前工作图会被替换。自动缓存不是备份，建议先导出；取消会保留当前图。',
      confirmLabel: '替换',
      secondaryLabel: '导出当前图',
      onSecondary: () => { exportNow(); closeConfirm(false); },
      tone: 'danger',
    });
  };

  /** 换图/重置后把视角调到可读档，避免一打开就是 38% 的缩略图 */
  const openReadableSoon = () => {
    window.setTimeout(() => canvasApi.current?.openReadable(), 0);
  };

  const enterSample = () => {
    if (sampleModeRef.current) {
      resetDoc(initialDoc(), false);
      setPackIssues([]);
      openReadableSoon();
      say('示例：已重置临时副本');
      return;
    }
    workSession.current = {
      doc: docRef.current,
      history: historyRef.current,
      selection: selectionRef.current,
      nav: navRef.current,
      persist,
    };
    sampleModeRef.current = true;
    setSampleMode(true);
    resetDoc(initialDoc(), false);
    setPackIssues([]);
    openReadableSoon();
    say('示例：临时副本，不影响我的蓝图');
  };

  const exitSample = () => {
    const s = workSession.current;
    workSession.current = null;
    sampleModeRef.current = false;
    setSampleMode(false);
    if (!s) return;
    sessionSeq.current += 1;
    docRef.current = s.doc;
    setDoc(s.doc);
    historyRef.current = s.history;
    setHistory(s.history);
    setSelection(s.selection);
    setNav(s.nav);
    setPersist(s.persist);
    say('已返回我的蓝图');
  };

  /** 把一份图作为临时示例打开；已经处于示例模式时只替换临时副本。 */
  const activateSampleDoc = (
    next: DocState,
    issues: Problem[],
    label: string,
    focusNodeId?: string,
  ) => {
    if (!sampleModeRef.current) {
      workSession.current = {
        doc: docRef.current,
        history: historyRef.current,
        selection: selectionRef.current,
        nav: navRef.current,
        persist,
      };
      sampleModeRef.current = true;
      setSampleMode(true);
    }
    resetDoc(next, false);
    setPackIssues(issues);
    setPersist(null);
    if (focusNodeId) {
      setSelection(selectOnlyNode(focusNodeId));
      setRightTab('inspect');
    }
    openReadableSoon();
    say(label);
  };

  /** 打开 pack 的参考蓝图：不经过「替换当前图」确认，始终进入临时副本。 */
  const openReferenceDoc = async (name: string, text: string): Promise<boolean> => {
    const sid = sessionSeq.current;
    const r = parseDoc(text);
    if (!r.doc) {
      say(`参考蓝图无效：${r.error ?? 'JSON 解析失败'}`);
      return false;
    }
    const loaded: LoadedPack[] = [];
    const issues: Problem[] = [];
    for (const p of r.doc.packs) {
      const l = loadBlueprintPack(p.source);
      if (!l.pack) {
        say(`参考蓝图的 pack ${p.name} 加载失败：${l.error}`);
        return false;
      }
      const enabled = (p as { enabled?: boolean }).enabled !== false;
      loaded.push({ id: p.id, name: p.name, source: p.source, pack: l.pack, enabled, ...(p.store ? { store: p.store } : {}) });
      issues.push(...l.issues);
    }
    if (sid !== sessionSeq.current) return false;
    const primary = r.doc.nodes.find((n) => n.packId !== '');
    activateSampleDoc(
      { packs: loaded, nodes: r.doc.nodes, edges: r.doc.edges, layouts: r.doc.layouts },
      issues,
      `参考蓝图：${name}`,
      primary?.id,
    );
    return true;
  };

  /** 已安装 pack 的参考蓝图：优先用商店登记路径，旧数据按 pack 路径推导。 */
  const openPackReference = async (pack: LoadedPack) => {
    const store = pack.store;
    if (!store) throw new Error('本地导入的 pack 没有商店参考蓝图；请从 Pack Store 打开。');
    const reference = store.reference ?? {
      path: (store.path ?? `packs/${store.packId}/pack.bp.ts`).replace(/pack\.bp\.ts$/i, 'reference.blueprint.json'),
    };
    const r = await fetchStoreReference(store.url, reference);
    if (!(await openReferenceDoc(pack.name, r.text))) throw new Error('参考蓝图内容无效');
    setNodeHelp(null);
  };

  const newBlueprint = async () => {
    if (!(await confirmReplace('新建空白蓝图？'))) return;
    if (sampleModeRef.current) exitSample();
    resetDoc(emptyDoc(), false);
    setPackIssues([]);
    setPersist(null);
    openReadableSoon();
    say('新建：空白蓝图');
  };

  /** 顶栏「导入转储」与全局拖放共用：新建 File 节点并写入内容 */
  const addFileNode = async (f: File, at?: { x: number; y: number }) => {
    const id = onAdd('', 'file', at);
    const error = await onFileNode(id, f);
    return { id, ok: !error, name: f.name, error };
  };

  const onOpenDoc = async (f: File): Promise<boolean> => {
    const sid = sessionSeq.current;
    let text: string;
    try {
      text = await f.text();
    } catch (e) {
      say(`打开失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (sid !== sessionSeq.current) return false;
    const r = parseDoc(text);
    if (!r.doc) { say(`打开失败：${r.error}`); return false; }

    if (!(await confirmReplace(`打开「${f.name}」？`))) return false;
    if (sid !== sessionSeq.current) return false;

    const loaded: LoadedPack[] = [];
    const issues: Problem[] = [];
    for (const p of r.doc.packs) {
      const l = loadBlueprintPack(p.source);
      if (!l.pack) { say(`pack ${p.name} 加载失败：${l.error}`); return false; }
      // enabled 是可选字段，缺省视为启用
      const enabled = (p as { enabled?: boolean }).enabled !== false;
      loaded.push({ id: p.id, name: p.name, source: p.source, pack: l.pack, enabled, ...(p.store ? { store: p.store } : {}) });
      issues.push(...l.issues);
    }
    if (sampleModeRef.current) exitSample();
    resetDoc({ packs: loaded, nodes: r.doc.nodes, edges: r.doc.edges, layouts: r.doc.layouts });
    setPackIssues(issues);
    setPersist(null);
    openReadableSoon();
    say(`打开：${f.name}`);
    return true;
  };

  const errors = fullResult.problems.filter((p) => p.severity === 'error').length;

  // ---- 全局拖放：.bin/.hex → File 节点，.json → 打开图，.bp.ts → 导入 pack ----
  // ---- 全局拖放：先分类整批文件，再逐项处理并汇总结果 ----
  const DUMP_EXT = new Set(['bin', 'hex', 'txt', 'dmp', 'raw', 'img']);
  const handleDropFiles = async (files: File[], at?: { x: number; y: number }) => {
    const ext = (f: File) => f.name.toLowerCase().split('.').pop() ?? '';
    const blueprints = files.filter((f) => ext(f) === 'json');
    const packs = files.filter((f) => f.name.toLowerCase().endsWith('.bp.ts') || ext(f) === 'ts');
    const dumps = files.filter((f) => DUMP_EXT.has(ext(f)));
    const skipped = files.filter((f) => !blueprints.includes(f) && !packs.includes(f) && !dumps.includes(f));

    if (blueprints.length > 1) {
      say('一次只能打开一张蓝图，请分开拖入；本批文件均未导入');
      return;
    }
    if (blueprints.length === 1) {
      const ok = await dropApi.current.onOpenDoc(blueprints[0]);
      if (!ok) { say('蓝图未打开，本批其它文件未导入'); return; }
    }

    let packOk = 0;
    for (const p of packs) {
      if (await dropApi.current.onLoadPack(p)) packOk += 1;
    }
    let dumpOk = 0;
    const failures: string[] = [];
    for (let i = 0; i < dumps.length; i += 1) {
      // 蓝图刚打开时视口已重置，落点交给自动找空位
      const r = await dropApi.current.addFileNode(dumps[i], !blueprints.length && i === 0 ? at : undefined);
      if (r.ok) dumpOk += 1;
      else failures.push(`${r.name}：${r.error ?? '读取失败'}`);
    }

    const parts: string[] = [];
    if (blueprints.length === 1) parts.push(`蓝图 ${blueprints[0].name}`);
    if (dumpOk) parts.push(`${dumpOk} 个转储`);
    if (packOk) parts.push(`${packOk} 个 pack`);
    if (skipped.length) parts.push(`跳过 ${skipped.length} 个不支持的文件`);
    if (failures.length) parts.push(`失败 ${failures.length} 个（${failures.join('；')}）`);
    say(parts.length ? `导入：${parts.join('，')}` : '没有可导入的文件');
  };

  const dropApi = useRef({ onOpenDoc, onLoadPack, addFileNode });
  dropApi.current = { onOpenDoc, onLoadPack, addFileNode };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types, 'Files');
    const onEnter = (e: DragEvent) => {
      if (designerOpenRef.current || !hasFiles(e)) return;
      depth += 1;
      setDropping(true);
    };
    const onOver = (e: DragEvent) => {
      if (designerOpenRef.current || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (designerOpenRef.current || !hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const onDrop = (e: DragEvent) => {
      if (designerOpenRef.current || !hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const api = canvasApi.current;
      const at = api?.contains(e.clientX, e.clientY)
        ? api.clientToWorld(e.clientX, e.clientY)
        : undefined;
      void handleDropFiles(files, at);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };

  }, []);

  const dragInside = !!dragAdd
    && (canvasApi.current?.contains(dragAdd.clientX, dragAdd.clientY) ?? false);

  // ---- 问题定位 ------------------------------------------------------------
  const pulseTimer = useRef(0);
  /** 选中节点 + 居中 + 角标脉冲 1.2s */
  const focusProblem = (nodeId: string) => {
    recordNav('问题定位');
    // 定位问题后直接把右栏切回检查器：用户要看到的是这个节点的字段与来源
    setRightTab('inspect');
    if (layout.rightCollapsed) toggleCollapsed('right');
    setSelection(selectOnlyNode(nodeId));
    canvasApi.current?.centerOn(nodeId);
    setPulse(nodeId);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulse(null), 1200);
  };

  /** 错误 chip：切到右栏「问题」页签（不另开浮层） */
  const openProblems = () => {
    if (!fullResult.problems.length) { say('没有发现问题'); return; }
    setRightTab('problems');
    if (layout.rightCollapsed) toggleCollapsed('right');
  };

  useEffect(() => () => {
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
  }, []);

  // ---- 右键菜单 ------------------------------------------------------------
  /** 右键：先让「菜单作用对象 = 选择对象」，再记录位置 */
  const onCanvasContextMenu = (target: MenuTarget, x: number, y: number) => {
    if (target.kind === 'node') {
      if (!selectionRef.current.nodes.has(target.id)) setSelection(selectOnlyNode(target.id));
    } else if (target.kind === 'edge') {
      if (!selectionRef.current.edges.has(target.id)) setSelection(selectOnlyEdge(target.id));
    } else if (target.kind === 'in-port' || target.kind === 'out-port') {
      if (!selectionRef.current.nodes.has(target.nodeId)) setSelection(selectOnlyNode(target.nodeId));
    }
    setMenu({ target, x, y });
  };

  const menuCtx: MenuCtx = (() => {
    const t = menu?.target;
    const nodeId = t && (t.kind === 'node' ? t.id : t.kind === 'in-port' || t.kind === 'out-port' ? t.nodeId : '');
    const isPort = t?.kind === 'in-port' || t?.kind === 'out-port';
    const portRaw = t?.kind === 'out-port'
      ? fullResult.outputs.get(t.nodeId)?.[t.port]
      : t?.kind === 'in-port'
        ? fullResult.inputs.get(t.nodeId)?.[t.port]?.value
        : undefined;
    const portSpec = isPort ? fullResult.ports.get(t.nodeId)?.[t.kind === 'out-port' ? 'outputs' : 'inputs']
      .find(p => p.name === t.port) : undefined;
    const target = isPort ? resolveFollowTarget(portRaw, t.nodeId, portSpec?.type) : undefined;
    const portAddr = target?.address;
    const portFollowReason = target?.reason;
    return {
      clipboardEmpty: clipCount === 0,
      selectionCount: selection.nodes.size + selection.edges.size,
      objectCount: nodes.length + edges.length,
      nodeEdgeCount: nodeId
        ? edges.filter((e) => e.from.node === nodeId || e.to.node === nodeId).length
        : 0,
      portWired: t?.kind === 'in-port'
        ? edges.some((e) => e.to.node === t.nodeId && e.to.port === t.port)
        : false,
      minimapOpen: minimap,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      problemCount: fullResult.problems.length,
      downstreamCount: t?.kind === 'out-port'
        ? edges.filter((e) => e.from.node === t.nodeId && e.from.port === t.port).length
        : t?.kind === 'node'
          ? edges.filter((e) => e.from.node === t.id).length
          : undefined,
      portValue: t?.kind === 'in-port'
        ? fullResult.inputs.get(t.nodeId)?.[t.port]?.display
        : undefined,
      outPortWired: t?.kind === 'out-port'
        ? edges.some((e) => e.from.node === t.nodeId && e.from.port === t.port)
        : undefined,
      portAddress: portAddr,
      portFollowable: !!isPort && !portFollowReason,
      portFollowReason,
    };
  })();

  const menuItems = menu ? buildMenu(menu.target, menuCtx) : [];

  /** 断开某节点的全部连线 */
  const disconnectAll = (nodeId: string) => {
    commit((d) => ({
      ...d,
      edges: d.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
    }), '断开全部连线');
  };

  const runMenuItem = (item: MenuItem) => {
    const t = menu?.target;
    setMenu(null);
    if (!t) return;
    switch (item.id) {
      case 'paste': onPaste(); break;
      case 'select-all': setSelection(selectAll(docRef.current)); break;
      case 'quick-add': onQuickAdd(); break;
      case 'fit': recordNav('适配全图'); canvasApi.current?.fitAll(); break;
      case 'auto-layout': doAutoLayout(); break;
      case 'zoom-100': canvasApi.current?.zoomTo(1); break;
      case 'minimap': setMinimap((v) => !v); break;
      case 'undo': doUndo(); break;
      case 'redo': doRedo(); break;
      case 'problems': openProblems(); break;
      case 'export': onSaveDoc(); break;
      case 'clear-canvas':
        if (window.confirm('清空画布？pack 配置保留，此操作可撤销。')) {
          commit((d) => ({ ...d, nodes: [], edges: [] }), '清空画布');
          setSelection(emptySelection);
        }
        break;
      case 'rename':
        if (t.kind === 'node' || t.kind === 'in-port' || t.kind === 'out-port') {
          const id = t.kind === 'node' ? t.id : t.nodeId;
          // 检查器折叠时没有输入框可落，直接在画布标题上改
          setRenameAt(layout.rightCollapsed ? 'canvas' : 'panel');
          setRenameId(id);
        }
        break;
      case 'copy': onCopy(); break;
      case 'cut': onCut(); break;
      case 'duplicate': onDuplicate(); break;
      case 'fit-selection': recordNav('适配选中'); canvasApi.current?.fitSelection(); break;
      case 'delete': onDeleteSelection(); break;
      case 'inspect-node':
        if (t.kind === 'node') setSelection(selectOnlyNode(t.id));
        break;
      case 'inspect-edge':
        if (t.kind === 'edge') setSelection(selectOnlyEdge(t.id));
        break;
      case 'disconnect-all':
        if (t.kind === 'node') disconnectAll(t.id);
        break;
      case 'disconnect-port':
        if (t.kind === 'in-port') onDisconnect(t.nodeId, t.port);
        break;
      case 'goto-source': {
        if (t.kind !== 'in-port') break;
        const e = edges.find((x) => x.to.node === t.nodeId && x.to.port === t.port);
        if (!e) break;
        recordNav('定位来源');
        setSelection(selectOnlyNode(e.from.node));
        canvasApi.current?.centerOn(e.from.node);
        break;
      }
      case 'follow-address':
        if (t.kind === 'out-port') onFollowPort(t.nodeId, t.port);
        else if (t.kind === 'in-port') onFollowInPort(t.nodeId, t.port);
        break;
      case 'start-wire':
        if (t.kind === 'out-port') canvasApi.current?.startWire(t.nodeId, t.port);
        break;
      case 'goto-source-node':
      case 'goto-target-node': {
        if (t.kind !== 'edge') break;
        const e = edges.find((x) => x.id === t.id);
        const id = item.id === 'goto-source-node' ? e?.from.node : e?.to.node;
        if (id) {
          recordNav(item.id === 'goto-source-node' ? '连线来源' : '连线目标');
          setSelection(selectOnlyNode(id));
          canvasApi.current?.centerOn(id);
        }
        break;
      }
      case 'goto-downstream': {
        const e = t.kind === 'node'
          ? edges.find((x) => x.from.node === t.id)
          : t.kind === 'out-port'
            ? edges.find((x) => x.from.node === t.nodeId && x.from.port === t.port)
            : undefined;
        if (e) {
          recordNav('下游节点');
          setSelection(selectOnlyNode(e.to.node));
          canvasApi.current?.centerOn(e.to.node);
        }
        break;
      }
      case 'copy-port-name': {
        if (t.kind !== 'in-port' && t.kind !== 'out-port') break;
        const cb = navigator.clipboard;
        if (cb) void cb.writeText(t.port).catch(() => {});
        say(`端口名：${t.port}`);
        break;
      }
      case 'view-value': {
        if (t.kind !== 'in-port') break;
        const iv = fullResult.inputs.get(t.nodeId)?.[t.port];
        say(`当前值：${iv?.display ?? '∅'}`);
        break;
      }
      default:
        break;
    }
  };

  // ---- 快捷键注册表 --------------------------------------------------------
  // 全库唯一的 window keydown：先按上下文过滤（输入框只放行 Mod+S / Esc），
  // 再交给注册表按 priority 分派。
  const api = () => canvasApi.current;

  const onQuickAdd = () => setQuickAddOpen(true);

  /** 快速添加：在视口中心落一个节点（走 onAdd → 1 条历史 + 选中） */
  const onQuickPick = (packId: string, nodeId: string) => {
    const c = canvasApi.current?.centerWorld();
    onAdd(packId, nodeId, c);
  };

  /** 任一浮层打开时，注册表让位（浮层自己处理按键） */
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = helpOpen || quickAddOpen || menu !== null
    || follow !== null || searchOpen || tree !== null || localTree !== null || confirm !== null
    || designerOpen;

  const commands: Command[] = [
    { id: 'save', keys: ['Mod+S'], when: 'global', label: '导出蓝图 JSON', run: () => onSaveDoc() },
    { id: 'export', keys: ['Mod+Shift+E'], when: 'global', label: '导出蓝图 JSON', run: () => onSaveDoc() },
    { id: 'open', keys: ['Mod+O'], when: 'global', label: '打开图', run: () => openInputRef.current?.click() },
    { id: 'undo', keys: ['Mod+Z'], when: 'global', label: '撤销', run: doUndo },
    { id: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], when: 'global', label: '重做', run: doRedo },
    { id: 'copy', keys: ['Mod+C'], when: 'global', label: '复制选择', run: onCopy },
    { id: 'cut', keys: ['Mod+X'], when: 'global', label: '剪切选择', run: onCut },
    { id: 'paste', keys: ['Mod+V'], when: 'global', label: '粘贴', run: onPaste },
    { id: 'duplicate', keys: ['Mod+D'], when: 'global', label: '创建副本', run: onDuplicate },
    {
      id: 'delete',
      keys: ['Delete', 'Backspace'],
      when: 'global',
      label: '删除选择',
      run: onDeleteSelection,
    },
    { id: 'select-all', keys: ['Mod+A'], when: 'global', label: '全选节点与连线', run: () => setSelection(selectAll(docRef.current)) },
    { id: 'fit', keys: ['Mod+0'], when: 'global', label: '适配全图', run: () => { recordNav('适配全图'); api()?.fitAll(); } },
    { id: 'fit-selection', keys: ['F'], when: 'global', label: '适配选中（无选中=全图）', run: () => { recordNav('适配选中'); api()?.fitSelection(); } },
    { id: 'zoom-100', keys: ['Mod+1'], when: 'global', label: '缩放到 100%', run: () => api()?.zoomTo(1) },
    { id: 'zoom-in', keys: ['Mod+='], when: 'global', label: '放大 10%', run: () => api()?.zoomBy(1.1) },
    { id: 'zoom-out', keys: ['Mod+-'], when: 'global', label: '缩小 10%', run: () => api()?.zoomBy(0.9) },
    { id: 'toggle-left', keys: ['Mod+\\'], when: 'global', label: '折叠 / 展开节点库', run: () => toggleCollapsed('left') },
    { id: 'toggle-right', keys: ['Mod+Shift+\\'], when: 'global', label: '折叠 / 展开检查器', run: () => toggleCollapsed('right') },
    { id: 'help', keys: ['?'], when: 'global', label: '快捷键帮助', run: () => setHelpOpen(true) },
    {
      id: 'focus-search', keys: ['/'], when: 'global', label: '聚焦节点库搜索',
      run: () => {
        if (uiRef.current.layout.leftCollapsed) toggleCollapsed('left');
        window.setTimeout(() => {
          const el = document.querySelector<HTMLInputElement>('[data-bp-search]');
          el?.focus();
          el?.select();
        }, 0);
      },
    },
    {
      id: 'rename', keys: ['F2'], when: 'global', label: '重命名节点',
      run: () => {
        const p = selectionRef.current.primary;
        if (p?.kind === 'node') {
          // 检查器折叠时 F2 落到画布上，避免「按了没反应」
          setRenameAt(uiRef.current.layout.rightCollapsed ? 'canvas' : 'panel');
          setRenameId(p.id);
        }
      },
    },
    {
      id: 'escape',
      keys: ['Escape'],
      when: 'global',
      label: '取消连线 / 清空选择',
      run: () => {
        // 降级顺序：取消节点库拖放 → 取消连线 → 清空选择
        if (dragRef.current) {
          // 只标记取消，保留到 pointerup，click 抑制依然生效
          dragRef.current.cancelled = true;
          setDragAdd(null);
          return;
        }
        if (api()?.cancelPending()) return;
        if (!isEmptySelection(selectionRef.current) || selectionRef.current.entry) {
          setSelection(clearSelection());
        }
      },
    },
  ];
  commands.push({ id: 'quick-add', keys: ['Mod+K'], when: 'global', label: '快速添加节点', run: onQuickAdd });
  commands.push({
    id: 'find', keys: ['Mod+F'], when: 'global', label: '在图中查找 / 跳转地址',
    run: () => { setSearchQuery(''); setSearchOpen(true); },
  });
  commands.push({
    id: 'nav-back', keys: ['Alt+ArrowLeft'], when: 'global', label: '返回上一视图', run: doNavBack,
  });
  commands.push({
    id: 'nav-forward', keys: ['Alt+ArrowRight'], when: 'global', label: '前进到下一视图', run: doNavForward,
  });
  commands.push({
    id: 'auto-layout', keys: ['Mod+L'], when: 'global', label: '自动布局', run: doAutoLayout,
  });

  const commandsRef = useRef<Command[]>(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt 组合用于「返回 / 前进」导航历史，不能在这里整体拦掉。
      if (designerOpenRef.current) return;
      if (e.defaultPrevented || e.repeat) return;
      // 中文输入法组合期间的按键属于候选词编辑，不触发应用命令
      if (e.isComposing || e.keyCode === 229) return;
      // 输入框内只放行 Mod+S / Mod+Shift+E / Escape
      if (isEditable(e.target) && !allowInInput(e)) return;
      // 浮层（菜单 / 快速添加 / 帮助）自己处理按键
      if (overlayOpenRef.current) return;
      const cmd = resolveCommand(e, contextOf(e.target), commandsRef.current);
      if (!cmd) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // 注册表内容通过 commandsRef 每次渲染刷新

  }, []);

  const selectionSummary = summaryOf(selection);
  const selectionText = selectionSummary.text;
  const designerDirty = designerBase ? !layoutsEqual(doc.layouts, designerBase) : false;

  // 保存态：示例临时副本 > 未持久化 > 未保存 > 已缓存（可能部分转储需重载）
  const dropped = persist?.dropped ?? [];
  const trimmed = persist?.code === 'TRIMMED';
  const degraded = persist?.code === 'NO_STORAGE' || persist?.code === 'TOO_LARGE';
  const saveText = sampleMode
    ? '示例 · 临时副本'
    : degraded
      ? '未持久化 · 仅内存'
      : dirty
        ? '未保存'
        : trimmed
          ? `已缓存 · ${dropped.length} 个转储需重载`
          : persist?.at
            ? `已缓存 · ${hhmm(persist.at)}`
            : '已缓存';
  const saveTone = degraded ? 'bad' : (dirty || sampleMode || trimmed) ? 'warn' : 'ok';
  const saveTitle = sampleMode
    ? '正在查看示例临时副本；返回我的蓝图后原工作图与撤销状态会恢复'
    : degraded
      ? (persist?.code === 'TOO_LARGE'
        ? `图超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB 写入上限，未写入缓存`
        : '浏览器存储不可用，本次修改仅保留在内存中')
      : dirty
        ? '有未缓存的改动（Ctrl+S 导出蓝图；自动缓存仍在后台运行）'
        : trimmed
          ? `草稿已缓存，但以下转储的字节未写入：${[...new Set(dropped.map((d) => d.name))].join('、')}。页面重载后需重新载入才能完整导出。`
          : '当前文档已写入浏览器草稿缓存';

  // 栅格轨道由 CSS 变量驱动，作用域限定在 .bp-app 内。
  const gridStyle = {
    '--bp-left-w': `${layout.leftCollapsed ? COLLAPSED_W : layout.leftWidth}px`,
    '--bp-right-w': `${layout.rightCollapsed ? COLLAPSED_W : layout.rightWidth}px`,
    '--bp-left-split': layout.leftCollapsed ? '0px' : SPLIT_W,
    '--bp-right-split': layout.rightCollapsed ? '0px' : SPLIT_W,
  } as unknown as CSSProperties;

  return (
    <div className={`app bp-app${resizing ? ' bp-resizing' : ''}`}>
      <header className="topbar bp-top">
        <div className="brand">
          <Logo />
          <div className="brand-text"><b>mem-link</b><span>blueprint</span></div>
        </div>
        <div className="top-actions">
          <button
            className="btn ghost bp-hist"
            onClick={doUndo}
            disabled={!canUndo(history)}
            title={canUndo(history) ? `撤销：${undoLabel(history) ?? ''}（Ctrl+Z）` : '无可撤销的操作'}
            aria-label="撤销"
          >
            <IconUndo size={13} />
          </button>
          <button
            className="btn ghost bp-hist"
            onClick={doRedo}
            disabled={!canRedo(history)}
            title={canRedo(history) ? `重做：${redoLabel(history) ?? ''}（Ctrl+Shift+Z）` : '无可重做的操作'}
            aria-label="重做"
          >
            <IconUndo size={13} className="bp-redo" />
          </button>
          <span className="bp-nav-sep" />
          <button
            className="btn ghost bp-hist bp-nav"
            onClick={doNavBack}
            disabled={!canBack(nav)}
            title={canBack(nav) ? `返回：${backLabel(nav)}（Alt+←）` : '没有可返回的视图'}
            aria-label="返回上一视图"
          >
            ‹
          </button>
          <button
            className="btn ghost bp-hist bp-nav"
            onClick={doNavForward}
            disabled={!canForward(nav)}
            title={canForward(nav) ? `前进：${forwardLabel(nav)}（Alt+→）` : '没有可前进的视图'}
            aria-label="前进到下一视图"
          >
            ›
          </button>
          <button
            className="btn ghost"
            title="在图中查找节点或跳转地址（Ctrl+F）"
            aria-label="在图中查找"
            onClick={() => { setSearchQuery(''); setSearchOpen(true); }}
          >
            查找
          </button>
          <button
            className="btn ghost"
            title="按数据流方向自动排开解析链（Ctrl+L），孤立节点保持原位"
            aria-label="自动布局"
            onClick={doAutoLayout}
          >
            布局
          </button>
          <span className="bp-nav-sep" />
          <button
            className="btn ghost"
            onClick={() => void newBlueprint()}
            title="新建空白蓝图（不会带入当前图的 pack、布局、节点或连线）"
          >
            新建
          </button>
          <label className="btn ghost file-label" title="把 .bin / .hex 等内存转储加入当前图；也可以直接把文件拖进窗口">
            <IconUpload size={13} /> 导入转储
            <input
              type="file"
              accept=".bin,.hex,.txt,.dmp,.raw,.img"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addFileNode(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <button
            className="btn ghost"
            onClick={() => setStoreOpen(true)}
            title="浏览 GitHub 上的 pack 商店（需要网络；安装后离线可用）"
          >
            <IconStore size={13} /> Pack 商店
          </button>
          <label className="btn ghost file-label" title="打开 .json 蓝图（Ctrl+O）；也可以把 .json 拖进窗口">
            <IconFolder size={13} /> 打开图
            <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onOpenDoc(f); e.currentTarget.value = ''; }} />
          </label>
          <button className="btn ghost" onClick={() => onSaveDoc()} title="导出蓝图 JSON（Ctrl+S）；浏览器只能确认已发起下载"><IconDownload size={13} /> 导出</button>
          <button
            className="btn ghost"
            onClick={sampleMode ? exitSample : enterSample}
            title={sampleMode ? '返回我的蓝图，恢复之前的编辑与撤销状态' : '在临时副本中查看默认 NVMe 示例，不影响我的蓝图'}
          >
            <IconRefresh size={13} /> {sampleMode ? '返回我的蓝图' : '示例'}
          </button>
        </div>
        <div className="top-right">
          {sampleMode && <span className="bp-sample-flag mono">示例 · 临时副本</span>}
          <span className={`bp-save mono ${saveTone}`} aria-live="polite" title={saveTitle}>
            <i className="bp-save-dot" />
            {saveText}
          </span>
          <span className="bp-chip mono">{nodes.filter((n) => n.nodeId === 'file').length} 文件</span>
          <span className="bp-chip mono">{nodes.length} 节点</span>
          <button
            type="button"
            className={`bp-chip mono bp-chip-btn ${errors ? 'bad' : ''}`}
            aria-expanded={rightTab === 'problems' && !layout.rightCollapsed}
            title={fullResult.problems.length
              ? `${fullResult.problems.length} 个问题（${errors} 个错误）· 点击在右栏查看`
              : '没有发现问题'}
            onClick={openProblems}
          ><IconAlert size={12} /> {fullResult.problems.length}</button>
        </div>
      </header>

      <div className="workspace bp-workspace" style={gridStyle}>
        {layout.leftCollapsed ? (
          <Rail
            side="left"
            title="节点库"
            hint="展开节点库（Ctrl+\）"
            onExpand={() => toggleCollapsed('left')}
          />
        ) : (
          <Palette
            packs={packs}
            onAdd={(p, n) => onAdd(p, n)}
            onDragStart={beginPaletteDrag}
            shouldIgnoreAdd={shouldIgnoreAdd}
            onLoadPack={onLoadPack}
            onOpenStore={() => setStoreOpen(true)}
            impactOf={(id) => packImpact(doc, id)}
            onTogglePack={onTogglePack}
            onRenamePack={onRenamePack}
            onDeletePack={onDeletePack}
            onCleanupPack={onCleanupPack}
            collapsedGroups={groups}
            onToggleGroup={toggleGroup}
            onCollapse={() => toggleCollapsed('left')}
            onHelp={(packId, nodeId) => setNodeHelp({ packId, nodeId })}
          />
        )}

        {!layout.leftCollapsed && (
          <div
            className={`bp-split bp-split-left${resizing === 'left' ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="节点库宽度"
            aria-valuemin={240}
            aria-valuemax={480}
            aria-valuenow={layout.leftWidth}
            tabIndex={0}
            title="拖动调整宽度 · 双击复位 330"
            onPointerDown={beginResize('left')}
            onDoubleClick={() => setWidth('left', resetSide('left'))}
            onKeyDown={onSplitKey('left')}
          />
        )}

        <main className="canvas-wrap bp-canvas-wrap">
          <Canvas
            nodes={nodes}
            edges={edges}
            result={fullResult}
            packs={allPacks}
            packNames={packNames}
            selection={selection}
            onSelect={setSelection}
            onMoveCommit={onMoveCommit}
            onOpenNode={openNodeTree}
            onParam={onParam}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            dragAdd={dragAdd}
            dropInside={dragInside}
            disabledPacks={disabledPacks}
            minimapOpen={minimap}
            onToggleMinimap={() => setMinimap((v) => !v)}
            onContextMenu={onCanvasContextMenu}
            onQuickAdd={onQuickAdd}
            pulseNodeId={pulse}
            onProblemClick={focusProblem}
            onFollowPort={onFollowPort}
            onFollowInPort={onFollowInPort}
            carriesFile={carriesFile}
            renameId={renameAt === 'canvas' ? renameId : null}
            onRenameStart={(id) => { setSelection(selectOnlyNode(id)); setRenameAt('canvas'); setRenameId(id); }}
            onRenameDone={() => setRenameId(null)}
            onNoteResize={onNoteResize}
            apiRef={canvasApi}
          />
        </main>

        {!layout.rightCollapsed && (
          <div
            className={`bp-split bp-split-right${resizing === 'right' ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="检查器宽度"
            aria-valuemin={320}
            aria-valuemax={640}
            aria-valuenow={layout.rightWidth}
            tabIndex={0}
            title="拖动调整宽度 · 双击复位 404"
            onPointerDown={beginResize('right')}
            onDoubleClick={() => setWidth('right', resetSide('right'))}
            onKeyDown={onSplitKey('right')}
          />
        )}

        {layout.rightCollapsed ? (
          <Rail
            side="right"
            title="检查器"
            hint="展开检查器（Ctrl+Shift+\）"
            onExpand={() => toggleCollapsed('right')}
          />
        ) : (
          <Inspector
            packs={allPacks}
            packNames={packNames}
            nodes={nodes}
            edges={edges}
            result={fullResult}
            selection={primarySelection(selection)}
            onSelect={selectLegacy}
            onParam={onParam}
            onMode={onMode}
            onDisconnect={onDisconnect}
            onDeleteEdge={onDeleteEdge}
            onFile={onFileNode}
            onHex={onFileHex}
            onBase={onFileBase}
            onAddRead={onAddRead}
            onOpenBuffer={openBuffer}
            bufferFocus={bufferFocus}
            layouts={doc.layouts}
            structures={structures}
            usage={layoutUsage}
            onCreateLayout={(nodeId) => { const id = createLayout(nodeId); openDesigner(`layout/${id}`); }}
            onSelectLayout={selectLayout}
            onOpenDesigner={(structureId) => openDesigner(structureId)}
            onCollapse={() => toggleCollapsed('right')}
            multi={{ nodes: selectionSummary.nodes, edges: selectionSummary.edges }}
            renameId={renameAt === 'panel' ? renameId : null}
            onRenameDone={() => setRenameId(null)}
            onCopy={(_text, label) => say(label)}
            onFollow={(addr, description, nodeId) => {
              const primary = selectionRef.current.primary;
              openFollow(addr, description, undefined, nodeId ?? (primary?.kind === 'node' ? primary.id : undefined));
            }}
            onOpenNode={openNodeTree}
            tab={rightTab}
            onTab={setRightTab}
            onFocusProblem={focusProblem}
            onHelp={(packId, nodeId) => setNodeHelp({ packId, nodeId })}
          />
        )}
      </div>

      <footer className="statusbar mono">
        <span>{packs.length} pack</span>
        <span>{packs.reduce((n, p) => n + Object.keys(p.pack.types).length, 0)} 类型</span>
        <span>{nodes.length} 节点 · {edges.length} 连线</span>
        <span>{result.ms.toFixed(1)} ms</span>
        <span>{selectionText}</span>
        {trimmed && dropped.length ? (
          <button
            type="button"
            className={`bp-save-text ${saveTone} bp-save-action`}
            title={`${saveTitle}\n点击选择第一个需要重新载入的来源`}
            onClick={() => {
              const target = dropped.find((d) => nodes.some((n) => n.id === d.nodeId));
              if (!target) return;
              setSelection(selectOnlyNode(target.nodeId));
              setRightTab('inspect');
              canvasApi.current?.centerOn(target.nodeId);
            }}
          >
            {saveText} · 选择并重新载入
          </button>
        ) : (
          <span className={`bp-save-text ${saveTone}`}>{saveText}</span>
        )}
        {exportAt && <span>已发起导出 · {hhmm(exportAt)}</span>}
        <span className="grow" />
        <span>本地求值</span>
      </footer>

      {dragAdd && (
        <div
          className={`bp-drag-ghost${dragInside ? '' : ' out'}`}
          style={{ left: dragAdd.clientX, top: dragAdd.clientY }}
        >
          <span className="bp-drag-dot" />
          <b>{dragAdd.label}</b>
          <em>{dragInside ? '松开以添加' : '画布外'}</em>
        </div>
      )}
      {helpOpen && <KeyHelp commands={commands} onClose={() => setHelpOpen(false)} />}
      {quickAddOpen && (
        <QuickAdd
          packs={packs}
          onPick={onQuickPick}
          onHelp={(packId, nodeId) => setNodeHelp({ packId, nodeId })}
          onClose={() => setQuickAddOpen(false)}
        />
      )}
      {storeOpen && (
        <PackStore
          storeUrl={storeUrl}
          packs={packs}
          onStoreUrl={onStoreUrl}
          onInstall={onInstallStorePack}
          onOpenReference={(entry, text) => openReferenceDoc(`${entry.name} v${entry.version}`, text)}
          onClose={() => setStoreOpen(false)}
        />
      )}
      {nodeHelp && (() => {
        const pack = packs.find((p) => p.id === nodeHelp.packId);
        if (!pack) return null;
        return (
          <NodeHelp
            pack={pack}
            nodeId={nodeHelp.nodeId}
            onClose={() => setNodeHelp(null)}
            onOpenReference={pack.store ? () => openPackReference(pack) : undefined}
          />
        );
      })()}
      {follow && (
        <FollowPicker
          request={follow}
          items={followItems}
          lastKey={lastFollowKey.current}
           onPreview={(offsets, w, buffer) => (follow ? previewChain(follow, w, offsets, buffer) : null)}
          onPick={doFollow}
          onClose={() => { setFollow(null); restoreTree(); }}
        />
      )}
      {searchOpen && (
        <GraphSearch
          query={searchQuery}
          onQuery={setSearchQuery}
          hits={searchHits}
          onPick={onSearchPick}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {tree && (
        <StructTree
          key={tree.nodeId}
          root={tree.root}
          title={tree.title}
          subtitle={tree.subtitle}
          initial={treeSessions.current.get(tree.nodeId)}
          focus={tree.focus}
          hidden={treeHidden}
          onSession={(session) => treeSessions.current.set(tree.nodeId, session)}
          onClose={() => { setTree(null); setTreeHidden(false); followFromTree.current = false; }}
          onFollow={(addr, hint, port) => {
            const req = requestFromTree(addr, `${hint} · 结构树（选完返回）`, port);
            if (!req) { say('无法跟随：结构树中的数据源已不可用'); return; }
            const source = req.source;
            const value = source ? result.outputs.get(source.nodeId)?.[source.port] : addr;
            setFollow({ ...req, hint: inferFollowType({
              value, address: addr, packs: packsMap, sourcePackId: nodes.find((n) => n.id === tree.nodeId)?.packId,
              knownAt: req.buffer && knownInMapping(req.buffer),
            }) });
            followFromTree.current = true;
            setTreeHidden(true);
          }}
          onResolve={resolveFromTree}
        />
      )}
      {designerStack !== null && (
        <DesignerApp
          layouts={doc.layouts ?? []}
          stack={designerStack}
          usage={layoutUsage}
          sessionDirty={designerDirty}
          canUndo={canUndo(history)}
          canRedo={canRedo(history)}
          onNavigate={navigateDesigner}
          onClose={closeDesigner}
          onApply={applyDesignerLayouts}
          onRestoreSession={restoreDesignerSession}
          onUndo={doUndo}
          onRedo={doRedo}
        />
      )}
      {localTree && (() => {
        const node = nodes.find(n => n.id === localTree);
        const view = result.views.get(localTree);
        if (!node || !view) return null;
        const collection = view.kind === 'list' || view.kind === 'array' ? view : undefined;
        const items = collection?.items ?? ((view.kind === 'struct' || view.kind === 'element') && view.inst ? [view.inst] : []);
        return <LocalTree key={localTree} title={nodeTitleOf(node)} items={items} stop={collection?.stop}
          onClose={() => setLocalTree(null)} tools={{ onCopy: (_text, label) => say(label), onFollow: (addr, description) => {
            if (openFollow(addr, description, undefined, node.id)) setLocalTree(null);
          } }} />;
      })()}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onRun={runMenuItem}
          onClose={() => setMenu(null)}
        />
      )}
      {/* Mod+O 的落点：与顶栏「打开图」共用 onOpenDoc */}
      <input
        ref={openInputRef}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onOpenDoc(f);
          e.currentTarget.value = '';
        }}
      />
      {confirm && (
        <ConfirmDialog
          request={confirm}
          onConfirm={() => closeConfirm(true)}
          onCancel={() => closeConfirm(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {dropping && (
        <div className="bp-drop" aria-hidden="true">
          <div className="bp-drop-card">
            <IconUpload size={22} />
            <b>松开以打开文件</b>
            <span>.bin / .hex → 载入为 File 节点</span>
            <span>.json → 打开图　·　.bp.ts → 导入 pack</span>
          </div>
        </div>
      )}
      <div className="bp-watermark mono">BLUEPRINT · {BLUEPRINT_FORMAT}</div>
    </div>
  );
}
