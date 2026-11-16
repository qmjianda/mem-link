/**
 * 「跟随地址」浮层：双击输出端口 / 右键端口 / 检查器字段行触发。
 * 选一个解析节点后，父级会原子地创建节点并把它连到来源端口。
 *
 * 只有当类型能可靠推断时（来源本身是元素、或该地址已有同类型实例），
 * 列表顶部才会出现「元素解析」；类型不可推断时不给这一项——用首个类型
 * 硬解会得到看似成功、实际字段全错的意外结果。
 *
 * 填写偏移链可做多级指针：每级在 `base+offset` 处读出下一个指针，
 * 提交时整条解引用链一起落到画布上。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { formatKeys } from './keys';
import { parseOffsetChain } from './builtins';
import { elementFollowItem, type FollowItem, type FollowTypeHint } from './follow';

export type { FollowItem } from './follow';

export interface FollowRequest {
  address: number;
  description: string;
  /** 有来源端口时会自动连一条 address 线；纯地址跳转时为空 */
  source?: { nodeId: string; port: string };
  /** 来源能推断出的类型（元素端口 / 同地址已知类型） */
  hint?: FollowTypeHint | null;
}

export interface FollowStep {
  offset: number;
  /** 在 base+offset 处读取 */
  readAt: number;
  /** 读出的指针值 */
  target: number;
}

export interface FollowPreview {
  steps: FollowStep[];
  /** 偏移链走完后的最终地址 */
  final: number;
  /** 中途越界等原因，命中时不允许提交 */
  error?: string;
}

interface Props {
  request: FollowRequest;
  /** pack 节点 + 内置解析节点（元素解析在类型可推断时由本组件置顶） */
  items: FollowItem[];
  /** 上次用过的候选 key（默认高亮） */
  lastKey?: string | null;
  onPreview?: (offsets: number[], width: 4 | 8) => FollowPreview | null;
  onPick: (item: FollowItem, offsets: number[], width: 4 | 8) => void;
  onClose: () => void;
}

export default function FollowPicker({
  request, items, lastKey, onPreview, onPick, onClose,
}: Props) {
  const [q, setQ] = useState('');
  const [chain, setChain] = useState('');
  const [width, setWidth] = useState<4 | 8>(8);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 浮层是在鼠标位置打开的：不做这层保护时，列表恰好铺在指针下方，
   * 第一条 pointerenter 就会把高亮从「推荐 / 上次使用」挪走，Enter 会加错节点。
   * 只有指针真的移动过，悬停才算用户的选择。
   */
  const pointerMoved = useRef(false);
  useEffect(() => {
    const onMove = () => { pointerMoved.current = true; };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const smart = useMemo(() => elementFollowItem(request.hint), [request.hint]);

  const filtered = useMemo(() => {
    const all = smart ? [smart, ...items] : items;
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((i) => (
      `${i.label} ${i.nodeId} ${i.detail} ${i.typeName ?? ''}`.toLowerCase().includes(needle)
    ));
  }, [items, q, smart]);

  const parsed = useMemo(() => parseOffsetChain(chain), [chain]);
  const preview = useMemo(() => {
    if (parsed.error || !parsed.offsets.length || !onPreview) return null;
    return onPreview(parsed.offsets, width);
  }, [parsed, width, onPreview]);
  const blocked = !!parsed.error || !!preview?.error;

  const defaultKey = request.hint ? 'element' : (lastKey ?? '');
  /** 高亮下标始终落在可见候选范围内 */
  const cursor = filtered.length ? Math.min(active, filtered.length - 1) : 0;
  const pick = (item: FollowItem | undefined) => {
    if (!item || blocked) return;
    onPick(item, parsed.offsets, width);
  };

  useEffect(() => { inputRef.current?.focus(); }, []);
  /** 搜索词变化时回到默认项：可推断时的元素解析，否则上次用过的候选 */
  useEffect(() => {
    const i = filtered.findIndex((x) => x.key === defaultKey);
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onClose(); return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (!filtered.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive((active + dir + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        pick(filtered[cursor]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filtered, active, cursor, onPick, onClose, blocked, parsed, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const hex = `0x${request.address.toString(16)}`;
  const hx = (v: number) => `0x${(v >>> 0).toString(16)}`;

  return (
    <div className="bp-overlay" role="dialog" aria-modal="true" aria-label="在此地址解析" onPointerDown={onClose}>
      <div className="bp-quick bp-follow" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bp-follow-head">
          <span>在此地址解析</span>
          <b className="mono">{hex}</b>
          <button className="bp-icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>×</button>
        </div>
        <div className="bp-follow-source mono" title={request.description}>{request.description}</div>

        <label className="bp-follow-chain">
          <span className="bp-follow-chain-label">偏移链</span>
          <input
            className="in mono"
            aria-label="多级指针偏移链"
            placeholder="+0x10, +0x24, -0x8（可留空）"
            spellCheck={false}
            value={chain}
            onChange={(e) => setChain(e.target.value)}
          />
          <select
            className="in"
            aria-label="指针宽度"
            title="指针宽度"
            value={width}
            onChange={(e) => setWidth(e.target.value === '4' ? 4 : 8)}
          >
            <option value="8">8 字节</option>
            <option value="4">4 字节</option>
          </select>
        </label>

        {chain.trim() !== '' && (
          <div className="bp-chain-preview mono" aria-live="polite">
            {parsed.error && <div className="bp-chain-err">{parsed.error}</div>}
            {!parsed.error && preview?.error && <div className="bp-chain-err">{preview.error}</div>}
            {!parsed.error && preview && (
              <>
                {preview.steps.map((s, i) => (
                  <div key={i} className="bp-chain-step">
                    <span className="bp-chain-off">{s.offset >= 0 ? `+${s.offset}` : String(s.offset)}</span>
                    <span>{hx(s.readAt)}</span>
                    <span className="bp-chain-arrow">→</span>
                    <span className="bp-chain-target">{hx(s.target)}</span>
                  </div>
                ))}
                <div className="bp-chain-step final">
                  <span className="bp-chain-off">最终</span>
                  <span className="bp-chain-target">{hx(preview.final)}</span>
                </div>
              </>
            )}
          </div>
        )}

        <input
          ref={inputRef}
          className="bp-quick-input"
          placeholder="搜索解析节点 / 类型"
          aria-label="搜索解析节点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="bp-quick-list" role="listbox" aria-label="解析节点列表">
          {filtered.map((item, i) => {
            const head = i === 0 || filtered[i - 1].group !== item.group;
            const header = head && item.group !== '推荐'
              ? <div className="bp-quick-group" key={`g:${item.group}`}>{item.group}</div>
              : null;
            if (item.nodeId === 'element') {
              return (
                <Fragment key="smart">
                  {header}
                  <div
                    role="option"
                    aria-selected={i === cursor}
                    title={item.detail}
                    className={`bp-quick-item bp-follow-smart${i === cursor ? ' on' : ''}`}
                    onPointerEnter={() => { if (pointerMoved.current) setActive(i); }}
                    onClick={() => pick(item)}
                  >
                    <span className="bp-pal-dot" data-kind="解析" />
                    <span className="bp-quick-label">{item.label}</span>
                    <em>{item.detail}</em>
                  </div>
                </Fragment>
              );
            }
            return (
              <Fragment key={item.key}>
                {header}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  title={item.detail}
                  className={`bp-quick-item${i === cursor ? ' on' : ''}`}
                  onPointerEnter={() => { if (pointerMoved.current) setActive(i); }}
                  onClick={() => pick(item)}
                >
                  <span className="bp-pal-dot" data-kind="解析" />
                  <span className="bp-quick-label">{item.label}</span>
                  <em>{item.detail}</em>
                </button>
              </Fragment>
            );
          })}
          {!filtered.length && <div className="bp-empty">无匹配节点</div>}
        </div>
        <div className="bp-quick-foot mono">↑↓ 选择 · Enter 解析 · Esc 关闭 · 偏移链逐级解引用</div>
        <div className="bp-quick-foot mono">{formatKeys(['Alt+ArrowLeft'])} 返回上一视图 · 元素解析只在类型可推断时出现</div>
      </div>
    </div>
  );
}
