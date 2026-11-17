import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { BlueprintPack, BPEdge, BPNode, BPResult, PortSpec, PortType, SourceInfo } from './types';
import { builtinLabel, canConnect, displayTitle, NODE_HEADER, NODE_WIDTH } from './types';
import { builtinSubtitle } from './builtins';
import { portsFor } from './eval';
import {
  clampNoteH, clampNoteW, isNoteNode, noteSize, noteTextHeight, NOTE_DEFAULT_H,
} from './notesize';
import {
  addNodes, clearSelection, isEdgeSelected, isNodeSelected, selectOnlyEdge, selectOnlyNode, setEntry,
  toggleEdge, toggleNode, type SelectionState,
} from './selection';
import {
  CULL_THRESHOLD, boundsOf, fitView, lodFor, openView, visibleEdgeIds, visibleNodeIds, worldViewRect,
  zoomAtCenter, type Lod, type Rect, type Viewport,
} from './viewport';
import Minimap from './Minimap';
import type { MenuTarget } from './menus';

/** A palette item currently being dragged onto the canvas (screen coords). */
export interface DragPreview {
  packId: string;
  nodeId: string;
  label: string;
  clientX: number;
  clientY: number;
}

/** Screen↔world helpers exposed to the parent for drag-to-add placement. */
export interface CanvasApi {
  clientToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  contains: (clientX: number, clientY: number) => boolean;
  /** 视口中心的世界坐标（快速添加落点） */
  centerWorld: () => { x: number; y: number };
  /** 取消正在拖拽的连线；返回是否真的取消了（Esc 的第一级） */
  cancelPending: () => boolean;
  fitAll: () => void;
  fitSelection: () => void;
  /** 打开文档时的可读视角（不压到看不清） */
  openReadable: () => void;
  /** 把某节点居中（保持当前缩放，不低于 0.5） */
  centerOn: (id: string) => void;
  zoomTo: (k: number) => void;
  zoomBy: (factor: number) => void;
  /** 从某个输出端口起线（右键菜单用） */
  startWire: (nodeId: string, port: string) => boolean;
  /** 导航历史：读取 / 恢复视口 */
  getView: () => Viewport;
  setView: (v: Viewport) => void;
  /** 当前每个节点的绘制尺寸（自动布局需要真实高度） */
  sizes: () => Map<string, { w: number; h: number }>;
}

interface Props {
  nodes: BPNode[];
  edges: BPEdge[];
  result: BPResult;
  packs: Map<string, BlueprintPack>;
  packNames: Map<string, string>;
  selection: SelectionState;
  onSelect: (s: SelectionState) => void;
  /**
   * 拖动结束时的提交点：把每个被拖节点的最终坐标一次性交给父级 → 1 条历史。
   * 拖动过程中画布**不**改文档（因此不会触发求值），只直写 DOM transform。
   */
  onMoveCommit?: (moves: { id: string; x: number; y: number }[]) => void;
  onParam: (id: string, key: string, value: string) => void;
  onConnect: (from: string, fromPort: string, to: string, toPort: string) => void;
  onDisconnect: (nodeId: string, port: string) => void;
  /** palette drag-to-add preview; null when no drag is in progress */
  dragAdd: DragPreview | null;
  /** true while the drag pointer is inside this canvas */
  dropInside: boolean;
  /** 被禁用的 pack id：节点仍在画布上，只标记错误态 */
  disabledPacks?: Set<string>;
  /** 小地图展开态（持久化在父级） */
  minimapOpen?: boolean;
  onToggleMinimap?: () => void;
  /** 右键：把命中目标与屏幕坐标交给父级（菜单由父级渲染） */
  onContextMenu?: (target: MenuTarget, clientX: number, clientY: number) => void;
  /** 双击画布空白（父级打开快速添加） */
  onQuickAdd?: () => void;
  /** 需要脉冲高亮的节点（问题定位后 1.2s） */
  pulseNodeId?: string | null;
  /** 点击节点上的问题角标 */
  onProblemClick?: (nodeId: string) => void;
  /** 双击输出端口：以该端口的值作为地址做「跟随解析」 */
  onFollowPort?: (nodeId: string, port: string) => void;
  /** 双击输入端口：跟随上游端口的值（未连线时给出提示） */
  onFollowInPort?: (nodeId: string, port: string) => void;
  /**
   * 该节点是否真的携带文件（File 本身、已解析出缓冲区的节点）。
   * 「数据源」端口据此决定能否接线：文本常量、Note 这类没有文件的输出
   * 接上去只会让下游悄悄读别的文件，所以在拖线阶段就拒绝并说明原因。
   */
  carriesFile?: (nodeId: string, port: string) => boolean;
  /** 正在就地重命名的节点（双击标题 / F2 触发） */
  renameId?: string | null;
  onRenameStart?: (nodeId: string) => void;
  onRenameDone?: () => void;
  /** 标注节点拖动手柄提交新尺寸 */
  onNoteResize?: (nodeId: string, w: number, h: number) => void;
  /** receives the canvas helpers used to commit a palette drop */
  apiRef?: MutableRefObject<CanvasApi | null>;
}

/** 一次拖动会话：点击得到的 id 集合与各自起点 */
interface DragSession {
  ids: string[];
  primaryId: string;
  sx: number;
  sy: number;
  origins: Map<string, { x: number; y: number }>;
}

/** 框选矩形（世界坐标，允许反方向拉） */
interface Marquee { x0: number; y0: number; x1: number; y1: number }

/**
 * 拖动期需要同步直写的一条连线：path 的 d，以及两端代表端点的圆点。
 * 圆点和 path 同属一个 <g>，漏掉任何一个都会在拖动时留下「端点不跟随」。
 */
interface DragCap {
  el: SVGCircleElement;
  end: 'a' | 'b';
  cx: string;
  cy: string;
}

interface DragEdge {
  el: SVGPathElement;
  d: string;
  caps: DragCap[];
  from: string;
  to: string;
  fromPort: string;
  toPort: string;
}

const HEADER = NODE_HEADER;
const INPUT_H = 25;
const OUT_H = 23;
const ITEM_H = 21;
const NODE_W = NODE_WIDTH;
/** element ports shown before the "expand" button */
const VISIBLE_ELEMENTS = 8;
const EXPAND_H = 20;

interface PortPos {
  name: string;
  type: PortType;
  y: number;
  label: string;
  dynamic?: boolean;
  hint?: string;
  index?: number;
  context?: boolean;
}

interface Meta {
  w: number;
  h: number;
  inputs: PortPos[];
  /** all visible output ports, static first, then visible element ports */
  outputs: PortPos[];
  staticCount: number;
  elements: PortPos[];
  elementCount: number;
  dynTop: number;
  expandTop: number;
  expandable: boolean;
  footerTop: number;
  footer: string;
  footerError: boolean;
}

interface Pending {
  node: string;
  port: string;
  type: PortType;
  side: 'in' | 'out';
  /** 拖的是数据源输入端口：松手时要额外检查来源是否携带文件 */
  context?: boolean;
}

function nodeLabel(node: BPNode, packs: Map<string, BlueprintPack>): string {
  const pack = packs.get(node.packId);
  const def = node.packId === '' ? undefined : pack?.nodes[node.nodeId];
  const fallback = node.packId === ''
    ? builtinLabel(node.nodeId)
    : def ? (def.label ?? node.nodeId) : `${node.packId}/${node.nodeId}`;
  return displayTitle(node, fallback);
}

function elementIndex(port: string): number | undefined {
  const m = /^elem:(\d+)$/.exec(port);
  return m ? Number(m[1]) : undefined;
}

function metaFor(
  node: BPNode,
  result: BPResult,
  expanded: boolean,
  connected: Set<string> | undefined,
  portsOverride?: { inputs: PortSpec[]; outputs: PortSpec[] },
): Meta {
  const all = portsOverride ?? result.ports.get(node.id) ?? { inputs: [], outputs: [] };
  /**
   * 元素节点同时支持「接元素 / 接列表 + 下标」和「跟随地址 + 推断类型」两种
   * 用法，但画布上没必要把另一种用法的空行也摆出来：按当前接线只显示相关行。
   * 已经接线的端口一律保留，避免连线在画布上凭空消失。
   */
  const element = node.packId === '' && node.nodeId === 'element';
  const wired = (name: string) => connected?.has(name) ?? false;
  const instWired = wired('instance') || wired('list');
  const bound = (node.params.typeId ?? '') !== '';
  const elementInputs = !element ? all.inputs
    : instWired
      ? (wired('address') ? all.inputs : all.inputs.filter((p) => p.name !== 'address'))
      : (bound && !wired('instance') && !wired('list') && !wired('index')
        ? all.inputs.filter((p) => p.name !== 'instance' && p.name !== 'list' && p.name !== 'index')
        : all.inputs);
  const inputs: PortPos[] = elementInputs.map((p, i) => ({
    name: p.name, type: p.type, label: p.label ?? p.name,
    y: HEADER + i * INPUT_H + INPUT_H / 2, context: p.context,
  }));
  const statics = all.outputs.filter((p) => !p.dynamic);
  const dyn = all.outputs.filter((p) => p.dynamic);
  const outTop = HEADER + elementInputs.length * INPUT_H;
  const outputRows: PortPos[] = statics.map((p, i) => ({
    name: p.name, type: p.type, label: p.label ?? p.name, y: outTop + i * OUT_H + OUT_H / 2,
  }));

  const dynTop = outTop + statics.length * OUT_H + 4;
  // A wired element port always stays visible, even when the list is collapsed.
  const visibleDyn = expanded
    ? dyn
    : dyn.filter((p, i) => i < VISIBLE_ELEMENTS || connected?.has(p.name));
  const elements: PortPos[] = visibleDyn.map((p, i) => ({
    name: p.name,
    type: p.type,
    label: p.label ?? p.name,
    hint: p.hint,
    dynamic: true,
    index: elementIndex(p.name),
    y: dynTop + i * ITEM_H + ITEM_H / 2,
  }));
  outputRows.push(...elements);

  const expandable = dyn.length > VISIBLE_ELEMENTS;
  const expandTop = dynTop + elements.length * ITEM_H;
  const footerTop = expandTop + (expandable ? EXPAND_H : 0);

  const view = result.views.get(node.id);
  let footer = '';
  let footerError = false;
  if (view?.kind === 'list' || view?.kind === 'array') {
    const hidden = view.count - dyn.length;
    if (hidden > 0) footer += `还有 ${hidden} 项`;
    if (view.kind === 'list' && view.cycle) footer += `${footer ? ' · ' : ''}回环`;
    if (view.trunc) {
      const where = view.trunc.unit === 'address' ? `0x${view.trunc.at.toString(16)}` : `第 ${view.trunc.at} 项`;
      footer += `${footer ? ' · ' : ''}截断@${where}`;
    }
    if (view.error) { footer += `${footer ? ' · ' : ''}${view.error}`; footerError = true; }
  } else if (view && 'error' in view && view.error) {
    footer = view.error;
    footerError = true;
  }
  const footerH = footer ? 22 : 0;
  // 标注卡片：宽高可在画布上拖动调整，默认高度与旧版固定便签一致。
  const note = isNoteNode(node);
  const nsize = note ? noteSize(node) : null;

  return {
    w: nsize ? nsize.w : NODE_W,
    h: nsize
      ? Math.max(HEADER + 20, nsize.h)
      : Math.max(HEADER + 20, footerTop + footerH + 8),
    inputs,
    outputs: outputRows,
    staticCount: statics.length,
    elements,
    elementCount: dyn.length,
    dynTop,
    expandTop,
    expandable,
    footerTop,
    footer,
    footerError,
  };
}

function valueText(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'string') return v.length > 18 ? `${v.slice(0, 17)}…` : v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Uint8Array) return `⟨${v.length} B⟩`;
  return '{…}';
}

/** 「数据源」端口未接线时的文字：说清这个节点到底在用哪个文件、是怎么来的，
 *  而不是一律叫「继承」——默认文件和检查器指定常常被误读成继承。 */
function contextSourceLabel(src?: SourceInfo): string {
  if (!src?.buffer) return '未指定';
  const prefix = src.mode === 'override' ? '指定'
    : src.mode === 'upstream' ? '继承'
      : src.mode === 'default' ? '默认'
        : src.mode === 'file' ? '自身' : '数据';
  return `${prefix} · ${src.buffer.name}`;
}

function contextSourceTitle(src?: SourceInfo): string {
  switch (src?.mode) {
    case 'override': return '在检查器里指定的文件；换成自动或画一条数据源连线即可改回';
    case 'upstream': return '沿上游连线继承的文件；想固定用某个文件可在检查器指定';
    case 'default': return '没有任何上游来源时使用的默认文件';
    default: return '接文件则直连，不接则沿上游继承';
  }
}

function typeColor(t: PortType): string {
  switch (t) {
    case 'number': return 'var(--accent)';
    case 'string': return 'var(--violet)';
    case 'bytes': return 'var(--amber)';
    case 'boolean': return '#7dd3fc';
    case 'list': return '#f0b45f';
    case 'instance': return '#c4b5fd';
    case 'buffer': return '#94a3b8';
    default: return '#94a3b8';
  }
}

/**
 * 节点标题就地重命名：Enter / 失焦提交一次，Esc 取消。
 * 保留 `F2` 与右键菜单两条入口，双击标题是最直观的那条。
 */
function NodeTitleInput({
  initial, placeholder, onCommit, onCancel,
}: { initial: string; placeholder: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value.trim());
  };
  return (
    <input
      className="bp-node-rename mono"
      autoFocus
      aria-label="节点名称"
      value={value}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
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

export default function Canvas({
  nodes, edges, result, packs, packNames, selection, onSelect, onMoveCommit,
  onParam, onConnect, onDisconnect, dragAdd, dropInside, disabledPacks,
  minimapOpen, onToggleMinimap, onContextMenu, onQuickAdd, pulseNodeId, onProblemClick, onFollowPort,
  onFollowInPort, carriesFile, renameId, onRenameStart, onRenameDone, onNoteResize, apiRef,
}: Props) {
  const [view, setView] = useState({ x: 40, y: 30, k: 0.92 });
  const [pending, setPending] = useState<Pending | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [pan, setPan] = useState<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  /** 标注节点拖动改尺寸时的实时尺寸（不写文档，松手一次提交） */
  const [noteDrag, setNoteDrag] = useState<{ id: string; w: number; h: number } | null>(null);
  const [marqueeHits, setMarqueeHits] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hostRef = useRef<HTMLDivElement>(null);
  const didFit = useRef(false);
  /** 画布容器尺寸（裁剪与缩放锚点都要用） */
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** 拖动是否真的移动过（区分「单击」与「拖拽」） */
  const dragMoved = useRef(false);
  /** 框选命中集合（pointerup 时一次性提交选择） */
  const marqueeHitsRef = useRef<Set<string>>(new Set());
  /** 连线失败气泡（落点提示，3 秒自动消失） */
  const [wireError, setWireError] = useState<{ text: string; x: number; y: number; tone: 'error' | 'info' } | null>(null);
  const wireErrorTimer = useRef(0);

  // ---- 拖动期零求值：DOM 直写 ----------------------------------------------
  /** 本次拖动涉及的节点 DOM */
  const dragEls = useRef<Map<string, HTMLElement>>(new Map());
  /** 本次拖动涉及的连线（path 的 d 与两端圆点一起重算） */
  const dragPaths = useRef<DragEdge[]>([]);
  /** 当前指针位移（世界单位），rAF 里读取 */
  const dragDelta = useRef({ dx: 0, dy: 0 });
  /** rAF 句柄：合并同一帧内的多次 pointermove */
  const dragFrame = useRef(0);
  const applyDragRef = useRef<() => void>(() => {});
  /** 当前 LOD 档位（拖动直写要跟随直线/曲线） */
  const lodRef = useRef<Lod>('full');

  const connected = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (id: string, port: string) => {
      let s = m.get(id);
      if (!s) m.set(id, (s = new Set()));
      s.add(port);
    };
    for (const e of edges) {
      add(e.from.node, e.from.port);
      add(e.to.node, e.to.port);
    }
    return m;
  }, [edges]);

  const nodeLabels = useMemo(
    () => new Map(nodes.map((n) => [n.id, nodeLabel(n, packs)])),
    [nodes, packs],
  );

  const metas = useMemo(() => {
    const m = new Map<string, Meta>();
    for (const n of nodes) {
      // 被禁用 pack 的节点求值不到端口，但节点与连线要留在画布上：
      // 直接从 pack 定义取端口（portsFor 只用定义，不依赖求值结果）。
      let ports = (n.packId && disabledPacks?.has(n.packId)) ? portsFor(n, packs) : undefined;
      if (ports) {
        // 动态端口（元素 / 嵌套成员）依赖求值结果，禁用时无法重建。
        // 从现存连线把端点补回来，避免连线画不出来。
        const inNames = new Set(ports.inputs.map((p) => p.name));
        const outNames = new Set(ports.outputs.map((p) => p.name));
        const inputs = [...ports.inputs];
        const outputs = [...ports.outputs];
        for (const e of edges) {
          if (e.to.node === n.id && !inNames.has(e.to.port)) {
            inNames.add(e.to.port);
            inputs.push({ name: e.to.port, type: 'number', label: e.to.port });
          }
          if (e.from.node === n.id && !outNames.has(e.from.port)) {
            outNames.add(e.from.port);
            outputs.push({
              name: e.from.port,
              type: 'instance',
              label: `元素 ${e.from.port.split(':')[1] ?? e.from.port}`,
              dynamic: true,
            });
          }
        }
        ports = { inputs, outputs };
      }
      m.set(n.id, metaFor(n, result, expanded.has(n.id), connected.get(n.id), ports));
    }
    return m;
  }, [nodes, edges, result, expanded, connected, disabledPacks, packs]);

  const toggleExpand = (id: string) => {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 容器尺寸：裁剪矩形与「100%」都以画布实际像素为准
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5
        ? s
        : { w: r.width, h: r.height }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 视口裁剪：节点数与矩形相交即可见；节点数少于阈值时全量渲染（避免小图抖动）。
   * 选中节点强制可见——否则平移后会「选中态消失」。
   */
  const visible = useMemo(() => {
    const forced = selection.nodes;
    if (!size.w || !size.h || nodes.length <= CULL_THRESHOLD) {
      const all = new Set(nodes.map((n) => n.id));
      for (const id of forced) all.add(id);
      return all;
    }
    const rect = worldViewRect(view, size);
    const set = visibleNodeIds({ nodes }, metas, rect);
    for (const id of forced) set.add(id);
    return set;
  }, [nodes, metas, view, size, selection.nodes]);

  /** 连线裁剪：两端节点可见才画；选中连线与 pending 线豁免 */
  const visibleEdges = useMemo(
    () => visibleEdgeIds(edges, visible, selection.edges),
    [edges, visible, selection.edges],
  );

  /** 低倍率降级档位（只影响绘制） */
  const lod = lodFor(view.k);

  /** 节点 → 问题数（角标） */
  const problemCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of result.problems) {
      if (!p.nodeKey) continue;
      m.set(p.nodeKey, (m.get(p.nodeKey) ?? 0) + 1);
    }
    return m;
  }, [result.problems]);
  lodRef.current = lod;

  /** 画布尺寸（尺寸还没测到时退回 DOM 实测值） */
  const canvasSize = () => (size.w && size.h
    ? size
    : { w: hostRef.current?.clientWidth ?? 900, h: hostRef.current?.clientHeight ?? 600 });

  /** 把某个世界矩形适配进画布；传 null 忽略 */
  const fitRect = (rect: Rect | null) => {
    if (!rect) return;
    setView(fitView(rect, canvasSize()));
  };

  const allIds = () => nodes.map((n) => n.id);

  const fitAll = () => fitRect(boundsOf(allIds(), nodes, metas));

  /** 首屏/换图：优先可读，不把整图压成缩略图 */
  const openReadable = () => {
    const rect = boundsOf(allIds(), nodes, metas);
    if (rect) setView(openView(rect, canvasSize()));
  };

  /** F：有选中适配选中，无选中适配全图 */
  const fitSelection = () => {
    const sel = selection.nodes;
    fitRect(sel.size ? boundsOf(sel, nodes, metas) : boundsOf(allIds(), nodes, metas));
  };

  // 供 CanvasApi 使用的稳定引用（API 对象只在挂载时创建一次）
  const canvasSizeRef = useRef(size);
  canvasSizeRef.current = size;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const metasRef = useRef(metas);
  metasRef.current = metas;
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitAllRef = useRef(fitAll);
  fitAllRef.current = fitAll;
  const fitSelectionRef = useRef(fitSelection);
  fitSelectionRef.current = fitSelection;
  const openReadableRef = useRef(openReadable);
  openReadableRef.current = openReadable;

  useEffect(() => {
    if (didFit.current || !nodes.length) return;
    didFit.current = true;
    openReadableRef.current();

  }, [nodes.length]);

  /**
   * Always read the live viewport from a ref. `apiRef.current` is created once
   * on mount, so a closure over the first render's `view` would keep returning
   * stale coordinates after the initial fit / any pan or zoom.
   */
  const toWorld = (clientX: number, clientY: number) => {
    const r = hostRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  };

  // The parent owns the pointer drag, but only the canvas knows its current
  // pan/zoom. Expose the conversion so a drop can be committed from a window
  // level pointerup (which also works with touch implicit pointer capture).
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      clientToWorld: (cx, cy) => toWorld(cx, cy),
      contains: (cx, cy) => {
        const r = hostRef.current?.getBoundingClientRect();
        return !!r && cx >= r.left && cx <= r.right
          && cy >= r.top && cy <= r.bottom;
      },
      centerWorld: () => {
        // toWorld expects *client* coords; the canvas has a left/top offset
        // from the palette and toolbar, so add the rect origin first.
        const r = hostRef.current?.getBoundingClientRect();
        const s = canvasSizeRef.current;
        const w = r?.width || s.w;
        const h = r?.height || s.h;
        return toWorld((r?.left ?? 0) + w / 2, (r?.top ?? 0) + h / 2);
      },
      cancelPending: () => {
        if (!pendingRef.current) return false;
        setPending(null);
        return true;
      },
      fitAll: () => fitAllRef.current(),
      fitSelection: () => fitSelectionRef.current(),
      openReadable: () => openReadableRef.current(),
      centerOn: (id: string) => {
        const n = nodesRef.current.find((x) => x.id === id);
        const m = metasRef.current.get(id);
        if (!n || !m) return;
        const s = canvasSizeRef.current;
        const k = Math.max(0.5, viewRef.current.k);
        setView({
          k,
          x: s.w / 2 - (n.x + m.w / 2) * k,
          y: s.h / 2 - (n.y + m.h / 2) * k,
        });
      },
      zoomTo: (k: number) => setView((v) => zoomAtCenter(v, canvasSizeRef.current, k)),
      zoomBy: (factor: number) => setView((v) => zoomAtCenter(v, canvasSizeRef.current, v.k * factor)),
      startWire: (nodeId: string, port: string) => {
        const node = nodesRef.current.find((n) => n.id === nodeId);
        const m = metasRef.current.get(nodeId);
        const p = m?.outputs.find((x) => x.name === port);
        if (!node || !m || !p) return false;
        setPending({ node: nodeId, port, type: p.type, side: 'out' });
        setMouse({ x: node.x + m.w, y: node.y + p.y });
        return true;
      },
      getView: () => ({ ...viewRef.current }),
      setView: (v: Viewport) => {
        if (![v.x, v.y, v.k].every(Number.isFinite) || v.k <= 0) return;
        setView({ x: v.x, y: v.y, k: Math.min(2.4, Math.max(0.12, v.k)) });
      },
      sizes: () => {
        const out = new Map<string, { w: number; h: number }>();
        for (const [id, m] of metasRef.current) out.set(id, { w: m.w, h: m.h });
        return out;
      },
    };
    return () => { apiRef.current = null; };
    // 只依赖 apiRef：其余数据通过 ref 读取，避免每次渲染重建 API 对象

  }, [apiRef]);

  // Starting a palette drag cancels a half-drawn wire, so only one preview
  // (the drop slot) is visible at a time.
  const dragActive = !!dragAdd;
  useEffect(() => {
    if (dragActive) setPending(null);
  }, [dragActive]);

  /**
   * React attaches wheel listeners as passive, so preventDefault() there logs
   * "Unable to preventDefault inside passive event listener". Bind a native
   * non-passive listener instead and read the live viewport from setView.
   */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // 同一帧内的多次 wheel（触控板会连发）合并为一次 setView，避免每个事件
    // 都让整棵节点树重渲染。
    let frame = 0;
    let factor = 1;
    let mx = 0;
    let my = 0;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      factor *= e.deltaY < 0 ? 1.1 : 0.9;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const f = factor;
        factor = 1;
        setView((v) => {
          const k = Math.min(2.4, Math.max(0.12, v.k * f));
          const wx = (mx - v.x) / v.k;
          const wy = (my - v.y) / v.k;
          return { k, x: mx - wx * k, y: my - wy * k };
        });
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) {
      if (!dragMoved.current) {
        if (Math.abs(e.clientX - drag.sx) < 2 && Math.abs(e.clientY - drag.sy) < 2) return;
        dragMoved.current = true;
      }
      // 不碰文档：只记录位移并在下一帧直写 DOM（求值次数保持 0）
      dragDelta.current = {
        dx: (e.clientX - drag.sx) / view.k,
        dy: (e.clientY - drag.sy) / view.k,
      };
      if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => applyDragRef.current());
      return;
    }
    if (marquee) {
      const w = toWorld(e.clientX, e.clientY);
      const rect: Marquee = { ...marquee, x1: w.x, y1: w.y };
      setMarquee(rect);
      // 命中判定：节点 bbox 与矩形相交（不碰 doc、不触发求值）
      const x0 = Math.min(rect.x0, rect.x1);
      const x1 = Math.max(rect.x0, rect.x1);
      const y0 = Math.min(rect.y0, rect.y1);
      const y1 = Math.max(rect.y0, rect.y1);
      const hits = new Set<string>();
      for (const n of nodes) {
        const m = metas.get(n.id);
        if (!m) continue;
        if (n.x <= x1 && n.x + m.w >= x0 && n.y <= y1 && n.y + m.h >= y0) hits.add(n.id);
      }
      marqueeHitsRef.current = hits;
      setMarqueeHits(hits);
      return;
    }
    if (pan) {
      setView((v) => ({ ...v, x: pan.vx + (e.clientX - pan.sx), y: pan.vy + (e.clientY - pan.sy) }));
      return;
    }
    if (pending) setMouse(toWorld(e.clientX, e.clientY));
  };

  const endPointer = () => {
    if (dragFrame.current) {
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = 0;
    }
    // 拖动提交：整次拖动只产生 1 条历史；inline transform 由 layout effect 在
    // 新坐标绘制后清除，避免「先复位再提交」的一帧回弹。
    if (drag) {
      if (dragMoved.current) {
        const { dx, dy } = dragDelta.current;
        const moves = drag.ids.map((id) => {
          const o = drag.origins.get(id) ?? { x: 0, y: 0 };
          return { id, x: Math.round(o.x + dx), y: Math.round(o.y + dy) };
        });
        onMoveCommit?.(moves);
      } else {
        clearDragDom(true);
        // 多选状态下按住某个已选节点但没有移动 = 单击 → 收敛为该节点
        if (drag.ids.length > 1) onSelect(selectOnlyNode(drag.primaryId));
      }
    }
    dragMoved.current = false;
    dragDelta.current = { dx: 0, dy: 0 };
    setDrag(null);
    setPan(null);
    if (marquee) {
      const hits = [...marqueeHitsRef.current];
      setMarquee(null);
      setMarqueeHits(new Set());
      marqueeHitsRef.current = new Set();
      // 框选追加到现有选择（Shift 语义），pointerup 时才提交
      if (hits.length) onSelect(addNodes(selection, hits));
    }
  };

  const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
    if (x2 < x1) {
      return `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 18} ${y2}, ${x2} ${y2}`;
    }
    const dx = Math.max(40, Math.min(140, (x2 - x1) * 0.5));
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  /** 在指定世界坐标弹一条连线失败提示 */
  const showWireError = (text: string, world: { x: number; y: number }, tone: 'error' | 'info' = 'error') => {
    const r = hostRef.current?.getBoundingClientRect();
    const x = r ? world.x * view.k + view.x : 0;
    const y = r ? world.y * view.k + view.y : 0;
    setWireError({ text, tone, x: Math.max(8, Math.min(x, (r?.width ?? 600) - 8)), y: Math.max(8, Math.min(y, (r?.height ?? 400) - 8)) });
    if (wireErrorTimer.current) window.clearTimeout(wireErrorTimer.current);
    wireErrorTimer.current = window.setTimeout(() => setWireError(null), 3000);
  };

  useEffect(() => () => {
    if (wireErrorTimer.current) window.clearTimeout(wireErrorTimer.current);
  }, []);

  const findPort = (nodeId: string, port: string, side: 'in' | 'out') => {
    const m = metas.get(nodeId);
    const n = nodes.find((x) => x.id === nodeId);
    if (!m || !n) return null;
    const list = side === 'in' ? m.inputs : m.outputs;
    const p = list.find((x) => x.name === port);
    if (!p) return null;
    return { x: side === 'in' ? n.x : n.x + m.w, y: n.y + p.y, p };
  };

  /**
   * 清掉拖动期直接写进 DOM 的 transform。提交后 React 已按新坐标重绘，只需
   * 丢掉引用；取消拖动（文档未变）时必须把 path 与端点圆点恢复成原始属性，
   * 否则 React 不会重写未变化的 prop，临时值会残留。
   */
  const clearDragDom = (restore = false) => {
    for (const el of dragEls.current.values()) el.style.transform = '';
    dragEls.current.clear();
    if (restore) {
      for (const item of dragPaths.current) {
        item.el.setAttribute('d', item.d);
        for (const c of item.caps) {
          c.el.setAttribute('cx', c.cx);
          c.el.setAttribute('cy', c.cy);
        }
      }
    }
    dragPaths.current = [];
  };

  /** 拖动开始时一次性收集相关 DOM（拖动期视口不变，集合稳定） */
  const collectDragDom = (ids: string[]) => {
    const host = hostRef.current;
    dragEls.current = new Map();
    dragPaths.current = [];
    if (!host) return;
    for (const id of ids) {
      const el = host.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
      if (el) dragEls.current.set(id, el);
    }
    for (const p of host.querySelectorAll<SVGPathElement>('[data-edge-id]')) {
      const eid = p.dataset.edgeId ?? '';
      const edge = edges.find((x) => x.id === eid);
      if (!edge) continue;
      if (!dragEls.current.has(edge.from.node) && !dragEls.current.has(edge.to.node)) continue;
      // The two endpoint dots live in the same <g> as the wire. Collect them
      // together or they stay pinned to the old position while the wire moves.
      const caps: DragCap[] = [];
      for (const c of p.parentElement?.querySelectorAll<SVGCircleElement>('[data-edge-cap]') ?? []) {
        caps.push({
          el: c,
          end: c.dataset.edgeCap === 'b' ? 'b' : 'a',
          cx: c.getAttribute('cx') ?? '0',
          cy: c.getAttribute('cy') ?? '0',
        });
      }
      dragPaths.current.push({
        el: p,
        d: p.getAttribute('d') ?? '',
        caps,
        from: edge.from.node,
        to: edge.to.node,
        fromPort: edge.from.port,
        toPort: edge.to.port,
      });
    }
  };

  /**
   * 一帧一次的直写：被拖节点用 transform 位移（节点自身仍有 left/top，
   * transform 叠加），相邻连线重算 d，两端圆点同步重算 cx/cy。
   * 全程不读不写文档。
   */
  const applyDrag = () => {
    dragFrame.current = 0;
    const { dx, dy } = dragDelta.current;
    for (const el of dragEls.current.values()) {
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }
    for (const item of dragPaths.current) {
      const a = findPort(item.from, item.fromPort, 'out');
      const b = findPort(item.to, item.toPort, 'in');
      if (!a || !b) continue;
      const ax = a.x + (dragEls.current.has(item.from) ? dx : 0);
      const ay = a.y + (dragEls.current.has(item.from) ? dy : 0);
      const bx = b.x + (dragEls.current.has(item.to) ? dx : 0);
      const by = b.y + (dragEls.current.has(item.to) ? dy : 0);
      item.el.setAttribute('d', lodRef.current === 'minimal'
        ? `M ${ax} ${ay} L ${bx} ${by}`
        : edgePath(ax, ay, bx, by));
      for (const c of item.caps) {
        c.el.setAttribute('cx', String(c.end === 'a' ? ax : bx));
        c.el.setAttribute('cy', String(c.end === 'a' ? ay : by));
      }
    }
  };
  applyDragRef.current = applyDrag;

  // 文档更新（提交后）再清 inline transform：与 React 的新 left/top 同一帧生效
  useLayoutEffect(() => {
    if (dragEls.current.size || dragPaths.current.length) clearDragDom();

  }, [nodes]);

  useEffect(() => () => {
    if (dragFrame.current) cancelAnimationFrame(dragFrame.current);
  }, []);

  /**
   * 从端口起线。必须在设置 pending 的同一个事件里同步把预览终点初始化到
   * 正确的世界坐标，否则 pending 虚线的第一帧会沿用 mouse 的旧值（初值为
   * 世界原点），出现一条指向 (0, 0) 的瞬闪长线。
   */
  const startConnect = (
    node: BPNode,
    p: PortPos,
    side: 'in' | 'out',
    clientX: number,
    clientY: number,
  ) => {
    const r = hostRef.current?.getBoundingClientRect();
    const pointerValid = !!r && Number.isFinite(clientX) && Number.isFinite(clientY);
    let start: { x: number; y: number };
    if (pointerValid) {
      // 与 onPointerMove 使用完全相同的换算，保证首帧与随后移动之间不跳变。
      start = toWorld(clientX, clientY);
    } else {
      // 指针坐标不可用时退化为起线端口自身的世界坐标：线长为零，不会指向原点。
      const portWorld = findPort(node.id, p.name, side);
      start = portWorld
        ? { x: portWorld.x, y: portWorld.y }
        : { x: node.x, y: node.y };
    }
    // 两个 setState 位于同一次事件，React 批更新后 pending 虚线首帧即取到正确终点。
    setMouse(start);
    setPending({ node: node.id, port: p.name, type: p.type, side, context: p.context });
  };

  const finishConnect = (node: BPNode, p: PortPos, side: 'in' | 'out') => {
    if (!pending) return;
    const hit = findPort(node.id, p.name, side) ?? { x: node.x, y: node.y };
    if (pending.side === side) return;
    // ① 自连
    if (pending.node === node.id) {
      showWireError(`${pending.port} → ${p.name}：不能连接同一个节点`, hit);
      setPending(null);
      return;
    }
    // ② 来源端口已不存在（pack 被禁用 / 元素端口随类型消失）
    if (!findPort(pending.node, pending.port, pending.side)) {
      showWireError(`${pending.port}：来源端口已不存在`, hit);
      setPending(null);
      return;
    }
    const from = pending.side === 'out'
      ? { node: pending.node, port: pending.port, type: pending.type }
      : { node: node.id, port: p.name, type: p.type, context: p.context };
    const to = pending.side === 'out'
      ? { node: node.id, port: p.name, type: p.type, context: p.context }
      : { node: pending.node, port: pending.port, type: pending.type, context: pending.context };
    // ②-b 端点所属 pack 已禁用：拒绝连接，避免产生无法求值的悬空线
    const packOff = (id: string) => {
      const target = nodes.find((x) => x.id === id);
      return !!target?.packId && !!disabledPacks?.has(target.packId);
    };
    if (packOff(from.node) || packOff(to.node)) {
      showWireError('目标节点：所属 pack 已禁用', hit);
      setPending(null);
      return;
    }
    // ③ 类型不匹配
    if (!canConnect(from.type, to.type)) {
      showWireError(`${from.port} → ${to.port}：类型不匹配 ${from.type} → ${to.type}`, hit);
      setPending(null);
      return;
    }
    // ③-b 数据源只接受真正有内容的来源：文件、字符串/字节输出；数字常量、
    //     Note 接上去没有任何内容可传，过去会静默回退到别的文件。
    if (to.context && carriesFile && !carriesFile(from.node, from.port)) {
      const src = nodes.find((x) => x.id === from.node);
      const name = src ? nodeLabel(src, packs) : '该节点';
      showWireError(`「${name}」不携带文件或字符串，不能作为数据源——请从 File、字符串或解析节点连过来`, hit);
      setPending(null);
      return;
    }
    // ④ 重复连线（同源同目标）
    const dup = edges.some((e) => e.from.node === from.node && e.from.port === from.port
      && e.to.node === to.node && e.to.port === to.port);
    if (dup) {
      showWireError(`${from.port} → ${to.port}：连线已存在`, hit);
      setPending(null);
      return;
    }
    // 输入端口被占用属于「替换」：成功并给出一次信息气泡说明旧线被替换
    const occupied = edges.find((e) => e.to.node === to.node && e.to.port === to.port
      && (e.from.node !== from.node || e.from.port !== from.port));
    onConnect(from.node, from.port, to.node, to.port);
    if (occupied) {
      showWireError(`连接：${from.port} → ${to.port}（替换原连线）`, hit, 'info');
    }
    setPending(null);
  };

  const portDown = (
    node: BPNode,
    p: PortPos,
    side: 'in' | 'out',
    clientX: number,
    clientY: number,
  ) => {
    if (pending?.node === node.id && pending.port === p.name && pending.side === side) {
      setPending(null); // clicking the same port again cancels the wire
      return;
    }
    if (pending && pending.side !== side) finishConnect(node, p, side);
    else startConnect(node, p, side, clientX, clientY);
  };

  /**
   * 双击输出端口 = 以该端口的当前值作为地址做「跟随解析」。
   * 先清掉 pointerdown 可能留下的半截连线，避免浮层打开时还挂着预览线。
   */
  const followPort = (node: BPNode, port: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPending(null);
    onFollowPort?.(node.id, port);
  };

  /** 双击输入端口同理：跟随上游端口的值，而不是把半截连线留在画布上 */
  const followInPort = (node: BPNode, port: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPending(null);
    onFollowInPort?.(node.id, port);
  };

  /** while a wire is being dragged, mark the ports that can accept it */
  const portHint = (p: PortPos, side: 'in' | 'out', nodeId: string) => {
    if (!pending || pending.side === side) return '';
    const ok = pending.side === 'out'
      ? canConnect(pending.type, p.type) && (!p.context || !carriesFile || carriesFile(pending.node, pending.port))
      : canConnect(p.type, pending.type)
        && (!pending.context || !carriesFile || carriesFile(nodeId, p.name));
    return ok ? ' ok' : ' no';
  };

  /** Shift / Ctrl / Cmd = 追加或切换 */
  const additive = (e: React.PointerEvent) => e.shiftKey || e.ctrlKey || e.metaKey;

  /**
   * 标注右下角手柄：拖动期只改本地预览尺寸（不求值、不写历史），
   * 松手时一次性提交到文档，撤销一步回到原尺寸。
   */
  const startNoteResize = (e: React.PointerEvent, node: BPNode) => {
    e.stopPropagation();
    e.preventDefault();
    const base = noteSize(node);
    const sx = e.clientX;
    const sy = e.clientY;
    const k = viewRef.current.k || 1;
    let last = base;
    setNoteDrag({ id: node.id, ...base });
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    const move = (ev: PointerEvent) => {
      last = {
        w: clampNoteW(base.w + (ev.clientX - sx) / k),
        h: clampNoteH(base.h + (ev.clientY - sy) / k),
      };
      setNoteDrag({ id: node.id, ...last });
    };
    const up = () => {
      detach();
      setNoteDrag(null);
      if (last.w !== base.w || last.h !== base.h) onNoteResize?.(node.id, last.w, last.h);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const nodeBodyDown = (node: BPNode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(additive(e) ? toggleNode(selection, node.id) : selectOnlyNode(node.id));
  };

  /**
   * 标题栏按下 = 开始拖动。已选中的节点保持集合（整组一起动），
   * 未选中的先单选再拖；修饰键只做切换，不进入拖动。
   */
  const nodeHeadDown = (node: BPNode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (additive(e)) {
      onSelect(toggleNode(selection, node.id));
      return;
    }
    const inSel = isNodeSelected(selection, node.id);
    if (!inSel) onSelect(selectOnlyNode(node.id));
    const ids = inSel ? [...selection.nodes] : [node.id];
    const origins = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const n = nodes.find((x) => x.id === id);
      if (n) origins.set(id, { x: n.x, y: n.y });
    }
    dragMoved.current = false;
    dragDelta.current = { dx: 0, dy: 0 };
    collectDragDom(ids);
    setDrag({ ids, primaryId: node.id, sx: e.clientX, sy: e.clientY, origins });
  };

  /** 右键：端口 > 连线 > 节点 > 画布空白 */
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    const portEl = el.closest('.bp-port') as HTMLElement | null;
    const nodeEl = el.closest('[data-node-id]') as HTMLElement | null;
    const edgeEl = el.closest('[data-edge-id]') as HTMLElement | null;
    if (portEl && nodeEl) {
      const nodeId = nodeEl.dataset.nodeId ?? '';
      const port = portEl.dataset.port ?? '';
      if (!port) return;
      onContextMenu({ kind: portEl.dataset.side === 'in' ? 'in-port' : 'out-port', nodeId, port }, e.clientX, e.clientY);
      return;
    }
    if (edgeEl) {
      onContextMenu({ kind: 'edge', id: edgeEl.dataset.edgeId ?? '' }, e.clientX, e.clientY);
      return;
    }
    if (nodeEl) {
      onContextMenu({ kind: 'node', id: nodeEl.dataset.nodeId ?? '' }, e.clientX, e.clientY);
      return;
    }
    onContextMenu({ kind: 'canvas', world: toWorld(e.clientX, e.clientY) }, e.clientX, e.clientY);
  };

  const edgeDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(additive(e) ? toggleEdge(selection, id) : selectOnlyEdge(id));
  };

  // Where a palette drag would land, in world coords. Shown only while the
  // pointer is over the canvas; the parent decides whether to commit the drop.
  const dropWorld = dragAdd && dropInside ? toWorld(dragAdd.clientX, dragAdd.clientY) : null;

  return (
    <div
      className={`bp-canvas${dropInside ? ' drop-active' : ''}`}
      ref={hostRef}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => {
        const empty = e.target === e.currentTarget
          || (e.target as HTMLElement).classList.contains('bp-world');
        if (empty) onQuickAdd?.();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerDown={(e) => {
        const empty = e.target === e.currentTarget
          || (e.target as HTMLElement).classList.contains('bp-world');
        if (!empty) return;
        setPending(null);
        // Shift + 空白拖动 = 框选（追加）；无修饰键 = 平移并清空选择
        if (e.shiftKey) {
          const w = toWorld(e.clientX, e.clientY);
          marqueeHitsRef.current = new Set();
          setMarqueeHits(new Set());
          setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
          return;
        }
        setPan({ sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
        onSelect(clearSelection());
      }}
      onPointerLeave={endPointer}
    >
      <div
        className="bp-world"
        data-lod={lod}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          // 端口命中区按 1/k 放大，低倍率下仍是 ~16 屏幕像素
          ['--bp-k' as string]: String(view.k),
        } as unknown as React.CSSProperties}
      >
        {marquee && (
          <div
            className="bp-marquee"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
        {dropWorld && dragAdd && (
          <div
            className="bp-drop-slot"
            style={{ left: dropWorld.x - NODE_W / 2, top: dropWorld.y - HEADER / 2, width: NODE_W }}
          >
            <span>{dragAdd.label}</span>
            <em>松开以放置 · Esc 取消</em>
          </div>
        )}
        <svg className="bp-edges" width={4000} height={3000} aria-hidden>
          <defs>
            <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ed8c0" />
            </marker>
          </defs>
          {edges.map((e) => {
            if (!visibleEdges.has(e.id)) return null;
            const a = findPort(e.from.node, e.from.port, 'out');
            const b = findPort(e.to.node, e.to.port, 'in');
            if (!a || !b) return null;
            const hot = isEdgeSelected(selection, e.id);
            const isPrimary = selection.primary?.kind === 'edge' && selection.primary.id === e.id;
            return (
              <g key={e.id}>
                <path
                  d={lod === 'minimal' ? `M ${a.x} ${a.y} L ${b.x} ${b.y}` : edgePath(a.x, a.y, b.x, b.y)}
                  data-edge-id={e.id}
                  className={`bp-edge ${hot ? 'hot' : ''}${isPrimary ? ' primary' : ''} ${e.to.port === 'buffer' ? 'ctx' : ''}`}
                  style={{ stroke: typeColor(a.p.type) }}
                  markerEnd={lod === 'minimal' ? undefined : 'url(#bp-arrow)'}
                  onPointerDown={edgeDown(e.id)}
                />
                <circle data-edge-cap="a" cx={a.x} cy={a.y} r={2.6} fill={typeColor(a.p.type)} />
                <circle data-edge-cap="b" cx={b.x} cy={b.y} r={2.6} fill={typeColor(b.p.type)} />
              </g>
            );
          })}
          {pending && (() => {
            const a = findPort(pending.node, pending.port, pending.side === 'out' ? 'out' : 'in');
            if (!a) return null;
            return (
              <path
                d={pending.side === 'out'
                  ? edgePath(a.x, a.y, mouse.x, mouse.y)
                  : edgePath(mouse.x, mouse.y, a.x, a.y)}
                className="bp-edge pending"
              />
            );
          })()}
        </svg>

        {nodes.map((node) => {
          if (!visible.has(node.id)) return null;
          const m = metas.get(node.id)!;
          const viewNode = result.views.get(node.id);
          const selected = isNodeSelected(selection, node.id);
          const isPrimary = selection.primary?.kind === 'node' && selection.primary.id === node.id;
          // An Element node names the type it actually decoded, not the
          // inspector template it would use while unconnected.
          const autoLabel = node.nodeId === 'element' && viewNode?.kind === 'element' && viewNode.inst
            ? `元素 · ${viewNode.inst.typeName}`
            : nodeLabel(node, packs);
          const label = displayTitle(node, autoLabel);
          const note = isNoteNode(node);
          const liveNote = noteDrag?.id === node.id ? noteDrag : null;
          const nsize = note ? (liveNote ?? noteSize(node)) : null;
          const src = result.sources.get(node.id);
          const srcMode = src?.mode === 'explicit' ? '直连'
            : src?.mode === 'upstream' ? '继承'
              : src?.mode === 'override' ? '手动'
                : src?.mode === 'default' ? '默认' : '';
          const packName = viewNode?.kind === 'file' ? viewNode.name
            : node.packId
              ? `${packNames.get(node.packId) ?? node.packId}${src?.buffer ? ` · ${src.buffer.name}${srcMode ? ` (${srcMode})` : ''}` : ''}`
              : builtinSubtitle(node);
          /** 数据源端点只在「没有继承、或已有一条显式连线」时出现 */
          const sourceInherited = (port: string) =>
            src?.mode === 'upstream' && !(connected.get(node.id)?.has(port) ?? false);
          const chainText = src?.chain?.length
            ? `数据源继承链：${src.chain.map((id) => nodeLabels.get(id) ?? id).join(' → ')}`
            : undefined;
          const paramEntries = m.inputs;
          const isExpanded = expanded.has(node.id);
          const hasElements = m.elementCount > 0;
          // 所属 pack 被禁用：节点保留在原位，只标注错误态（不删除数据）
          const packOff = !!node.packId && !!disabledPacks?.has(node.packId);
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              data-node-kind={node.packId === '' ? node.nodeId : ''}
              data-note-tone={node.packId === '' && node.nodeId === 'note' ? (node.params.tone ?? 'note') : undefined}
              className={`bp-node ${selected ? 'on' : ''}${isPrimary ? ' primary' : ''} ${hasElements ? 'is-list' : ''}${packOff ? ' disabled' : ''}${marqueeHits.has(node.id) ? ' marquee-hit' : ''}${pulseNodeId === node.id ? ' pulse' : ''}`}
              style={{ left: node.x, top: node.y, width: nsize?.w ?? m.w, height: nsize?.h ?? m.h }}
              onPointerDown={nodeBodyDown(node)}
            >
              <div className="bp-node-head" onPointerDown={nodeHeadDown(node)}>
                <span className="bp-node-dot" />
                {renameId === node.id ? (
                  <NodeTitleInput
                    key={node.id}
                    initial={node.params.__title ?? ''}
                    placeholder={label}
                    onCommit={(v) => { onParam(node.id, '__title', v); onRenameDone?.(); }}
                    onCancel={() => onRenameDone?.()}
                  />
                ) : (
                  <span
                    className="bp-node-title"
                    title="双击重命名（F2）"
                    onDoubleClick={(e) => { e.stopPropagation(); onRenameStart?.(node.id); }}
                  >{label}</span>
                )}
                {packOff && <span className="bp-node-off">已禁用</span>}
                {(problemCount.get(node.id) ?? 0) > 0 && (
                  <button
                    className="bp-node-badge"
                    title={`${problemCount.get(node.id)} 个问题 · 点击定位`}
                    aria-label={`${problemCount.get(node.id)} 个问题`}
                    onPointerDown={(e) => { e.stopPropagation(); }}
                    onClick={(e) => { e.stopPropagation(); onProblemClick?.(node.id); }}
                  >{problemCount.get(node.id)}</button>
                )}
                <span className="bp-node-pack mono" title={chainText ?? src?.buffer?.name}>{packName}</span>
              </div>

              {lod !== 'full' && (
                <div className="bp-lod-ports">
                  {m.inputs.filter((p) => !(p.context && sourceInherited(p.name))).map((p) => (
                    <span
                      key={`i:${p.name}`}
                      className={`bp-port in ${p.context ? 'ctx' : ''}${portHint(p, 'in', node.id)}`}
                      data-port={p.name}
                      data-side="in"
                      style={{ top: p.y, background: typeColor(p.type) }}
                      title={`输入 ${p.label}（${p.type}）`}
                      onPointerDown={(e) => { e.stopPropagation(); portDown(node, p, 'in', e.clientX, e.clientY); }}
                    />
                  ))}
                  {m.outputs.map((p) => (
                    <span
                      key={`o:${p.name}`}
                      className={`bp-port out${p.dynamic ? ' sm' : ''}${portHint(p, 'out', node.id)}`}
                      data-port={p.name}
                      data-side="out"
                      style={{ top: p.y, background: typeColor(p.type) }}
                      title={`输出 ${p.label}（${p.type}）· 双击跟随地址`}
                      onPointerDown={(e) => { e.stopPropagation(); portDown(node, p, 'out', e.clientX, e.clientY); }}
                      onDoubleClick={followPort(node, p.name)}
                    />
                  ))}
                </div>
              )}

              {lod === 'full' && note && (
                /* 标注便签：直接在画布上编辑，pointer 事件不冒泡以免触发节点拖动 */
                <textarea
                  className="bp-note-text mono"
                  style={{ top: HEADER + 2, height: noteTextHeight(nsize!.h) }}
                  value={node.params.text ?? ''}
                  placeholder="分析结论 / 待办 / 地址含义…"
                  spellCheck={false}
                  aria-label="标注内容"
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onChange={(e) => onParam(node.id, 'text', e.target.value)}
                />
              )}

              {lod === 'full' && note && (
                <span
                  className="bp-note-resize"
                  role="separator"
                  aria-label="调整标注大小"
                  title="拖动调整大小 · 双击复位"
                  onPointerDown={(e) => startNoteResize(e, node)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onNoteResize?.(node.id, NODE_WIDTH, NOTE_DEFAULT_H);
                  }}
                />
              )}

              {lod === 'full' && paramEntries.map((p, i) => {
                const iv = result.inputs.get(node.id)?.[p.name];
                const wired = connected.get(node.id)?.has(p.name) ?? false;
                // 已从上游继承数据源时不再提供数据源端点：此时再接一条
                // 文件线会和继承链打架。断开上游连线后端点自动回来。
                const ctxLocked = p.context && sourceInherited(p.name);
                return (
                  <div
                    key={p.name}
                    className={`bp-row bp-in-row ${wired ? 'is-wired' : ''} ${p.context ? 'is-ctx' : ''}`}
                    style={{ top: HEADER + i * INPUT_H }}
                    title={ctxLocked ? '数据源已从上游继承；断开上游连线后才能在这里接线，也可在检查器里直接指定文件' : undefined}
                  >
                    {!ctxLocked && (
                      <span
                        className={`bp-port in ${p.context ? 'ctx' : ''}${portHint(p, 'in', node.id)}`}
                        data-port={p.name}
                        data-side="in"
                        style={{ background: typeColor(p.type) }}
                        title={p.context ? '数据源：只有携带文件的来源能接；留空沿上游继承 · 双击跟随' : `输入 ${p.label}（${p.type}）· 双击跟随`}
                        onPointerDown={(e) => { e.stopPropagation(); portDown(node, p, 'in', e.clientX, e.clientY); }}
                        onDoubleClick={followInPort(node, p.name)}
                      />
                    )}
                    <span className="bp-row-label">{p.label}</span>
                    {wired ? (
                      <>
                        <span
                          className={`bp-wired-val mono ${iv?.invalid || (p.context && !src?.buffer) ? 'empty' : ''}`}
                          title={iv?.from ? `来自 ${iv.from.label} · 点 × 断开` : '来自上游 · 点 × 断开'}
                        >
                          {/* 数据源行显示文件名，而不是上游那个端口的值 */}
                          {p.context ? (src?.buffer?.name ?? '无文件') : (iv?.display ?? '…')}
                        </span>
                        <button
                          className="bp-unlink"
                          title="断开这条输入，恢复手动输入"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); onDisconnect(node.id, p.name); }}
                        >×</button>
                      </>
                    ) : p.context ? (
                      <span className="bp-row-type" title={contextSourceTitle(src)}>
                        {contextSourceLabel(src)}
                      </span>
                    ) : p.type === 'number' ? (
                      <input
                        className="bp-in mono"
                        value={node.params[p.name] ?? ''}
                        placeholder="0x0"
                        spellCheck={false}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => onParam(node.id, p.name, e.target.value)}
                      />
                    ) : (
                      <span className="bp-row-type">{p.type === 'instance' ? '接元素端口' : p.type}</span>
                    )}
                  </div>
                );
              })}

              {lod === 'full' && m.outputs.slice(0, m.staticCount).map((p, i) => {
                const field = viewNode?.kind === 'struct' || viewNode?.kind === 'element'
                  ? viewNode.inst?.fields.find((f) => f.name === p.name)
                  : undefined;
                const val = field ? (node.portMode === 'raw' ? field.rawDisplay : field.display) : undefined;
                return (
                  <div key={p.name} className="bp-row bp-out-row" style={{ top: HEADER + paramEntries.length * INPUT_H + i * OUT_H }}>
                    <span className="bp-row-label">{p.label}</span>
                    {val != null && <span className="bp-row-val mono" title={val}>{val}</span>}
                    {val == null && viewNode?.kind === 'calc' && viewNode.outputs[p.name] != null && (
                      <span className="bp-row-val mono" title={String(viewNode.outputs[p.name])}>
                        {valueText(viewNode.outputs[p.name])}
                      </span>
                    )}
                    {p.name === 'count' && viewNode?.kind === 'list' && <span className="bp-row-val mono">{viewNode.count}</span>}
                    {p.name === 'value' && viewNode?.kind === 'number' && <span className="bp-row-val mono">{valueText(viewNode.value)}</span>}
                    {p.name === 'buffer' && viewNode?.kind === 'file' && <span className="bp-row-val mono">{viewNode.size} B</span>}
                    {p.name === 'base' && viewNode?.kind === 'file' && <span className="bp-row-val mono">0x{viewNode.base.toString(16)}</span>}
                    {p.name === 'size' && viewNode?.kind === 'file' && <span className="bp-row-val mono">{viewNode.size} B</span>}
                    <span
                      className={`bp-port out${portHint(p, 'out', node.id)}`}
                      data-port={p.name}
                      data-side="out"
                      title={`输出 ${p.label}（${p.type}）· 双击跟随地址`}
                      style={{ background: typeColor(p.type) }}
                      onPointerDown={(e) => { e.stopPropagation(); portDown(node, p, 'out', e.clientX, e.clientY); }}
                      onDoubleClick={followPort(node, p.name)}
                    />
                  </div>
                );
              })}

              {lod === 'full' && m.elements.map((p, i) => {
                const active = selection.entry?.nodeId === node.id && selection.entry.index === p.index;
                return (
                  <div
                    key={p.name}
                    className={`bp-row bp-out-row bp-element-row ${active ? 'on' : ''}`}
                    style={{ top: m.dynTop + i * ITEM_H }}
                    title={p.hint}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (p.index != null) onSelect(setEntry(selection, node.id, p.index));
                    }}
                  >
                    <span className="bp-element-i mono">{p.label}</span>
                    <span className="bp-element-hint mono">{p.hint}</span>
                    <span
                      className={`bp-port out sm${portHint(p, 'out', node.id)}`}
                      data-port={p.name}
                      data-side="out"
                      title={`输出 ${p.label} · 双击跟随地址`}
                      style={{ background: typeColor(p.type) }}
                      onPointerDown={(e) => { e.stopPropagation(); portDown(node, p, 'out', e.clientX, e.clientY); }}
                      onDoubleClick={followPort(node, p.name)}
                    />
                  </div>
                );
              })}

              {lod === 'full' && m.expandable && (
                <button
                  className="bp-expand"
                  style={{ top: m.expandTop }}
                  onPointerDown={(e) => { e.stopPropagation(); toggleExpand(node.id); }}
                >
                  {isExpanded ? '收起元素' : `展开全部 ${m.elementCount} 个元素端口`}
                </button>
              )}

              {lod === 'full' && m.footer && (
                <div className={m.footerError ? 'bp-node-err' : 'bp-node-foot'} style={{ top: m.footerTop }}>
                  {m.footer}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bp-hud mono">
        <button className="bp-hud-btn" aria-label="缩小" onClick={() => setView((v) => ({ ...v, k: Math.max(0.12, v.k * 0.9) }))}>−</button>
        <button
          className="bp-hud-btn bp-hud-pct"
          aria-label="当前缩放，点击回到 100%"
          title="点击回到 100%（Ctrl+1）"
          onClick={() => setView((v) => zoomAtCenter(v, canvasSize(), 1))}
        >
          {Math.round(view.k * 100)}%
        </button>
        <button className="bp-hud-btn" aria-label="放大" onClick={() => setView((v) => ({ ...v, k: Math.min(2.4, v.k * 1.1) }))}>+</button>
        {lod !== 'full' && (
          <span className="bp-hud-lod" title="缩略视图：放大到 50% 以上显示字段与端口">缩略</span>
        )}
        <button className="bp-hud-btn" aria-label="适配全图" onClick={fitAll}>适配</button>
      </div>
      {onToggleMinimap && (
        <Minimap
          nodes={nodes}
          metas={metas}
          view={view}
          size={size}
          collapsed={!minimapOpen}
          onToggle={onToggleMinimap}
          onNavigate={(c) => setView((v) => ({
            ...v,
            x: canvasSize().w / 2 - c.x * v.k,
            y: canvasSize().h / 2 - c.y * v.k,
          }))}
        />
      )}
      {wireError && (
        <div
          className={`bp-wire-error${wireError.tone === 'info' ? ' info' : ''}`}
          role="status"
          style={{ left: wireError.x, top: wireError.y }}
        >{wireError.text}</div>
      )}
      {!nodes.length && (
        <div className="bp-canvas-empty">
          <b>从左侧节点库添加节点开始</b>
          <span>双击输出端口可跟随地址 · Ctrl+F 查找 · Ctrl+L 自动布局 · ? 查看快捷键</span>
        </div>
      )}
    </div>
  );
}
