/**
 * 「跟随地址」浮层：双击输出端口 / 右键端口 / 检查器字段行触发。
 * 选一个解析节点后，父级会原子地创建节点并把它连到来源端口。
 *
 * 只有当类型能可靠推断时（来源本身是元素、或该地址已有同类型实例），
 * 列表顶部才会出现「元素解析」；类型不可推断时不给这一项——用首个类型
 * 硬解会得到看似成功、实际字段全错的意外结果。
 *
 * 地址同时存在于多份转储时，必须先选择来源，不替用户猜第一份。
 * 偏移链属于高级用法，默认折叠；每级在 `base+offset` 处读出下一个指针，
 * 提交时整条解引用链一起落到画布上。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { formatKeys } from './keys';
import { parseOffsetChain } from './builtins';
import { elementFollowItem, type FollowItem, type FollowTypeHint } from './follow';
import { addressHex, type AddressInt } from './precision';
import type { BufferValue } from './types';
import { useModalFocus } from './ModalFocus';

export type { FollowItem } from './follow';

export interface FollowRequest {
  address: AddressInt;
  buffer?: BufferValue;
  description: string;
  /** 有来源端口时会自动连一条 address 线；纯地址跳转时为空 */
  source?: { nodeId: string; port: string };
  /** 结构树没有可接的地址端口时，显式连回原数据源。 */
  bufferSource?: { nodeId: string; port: string };
  /** 来源能推断出的类型（元素端口 / 同地址已知类型） */
  hint?: FollowTypeHint | null;
  /** 同一地址有多份可用转储时，由用户明确选择；不默认第一份 */
  candidates?: BufferValue[];
}

export interface FollowStep {
  offset: bigint;
  /** 在 base+offset 处读取 */
  readAt: AddressInt;
  /** 读出的指针值 */
  target: AddressInt;
}

export interface FollowPreview {
  steps: FollowStep[];
  /** 偏移链走完后的最终地址 */
  final: AddressInt;
  /** 中途越界等原因，命中时不允许提交 */
  error?: string;
}

interface Props {
  request: FollowRequest;
  /** pack 节点 + 内置解析节点（元素解析在类型可推断时由本组件置顶） */
  items: FollowItem[];
  /** 上次用过的候选 key（默认高亮） */
  lastKey?: string | null;
  onPreview?: (offsets: bigint[], width: 4 | 8, buffer?: BufferValue) => FollowPreview | null;
  onPick: (item: FollowItem, offsets: bigint[], width: 4 | 8, buffer?: BufferValue) => void;
  onClose: () => void;
}

export default function FollowPicker({
  request, items, lastKey, onPreview, onPick, onClose,
}: Props) {
  const [q, setQ] = useState('');
  const [chain, setChain] = useState('');
  const [width, setWidth] = useState<4 | 8>(8);
  const [active, setActive] = useState(0);
  const [chosenKey, setChosenKey] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const chainRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
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

  const candidateKey = (b: BufferValue) => `${b.assetId}:${String(b.mappingBase ?? b.base)}:${b.name}`;
  const candidates = request.candidates ?? [];
  const chosen = useMemo(
    () => candidates.find((b) => candidateKey(b) === chosenKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, chosenKey],
  );
  const activeBuffer = chosen ?? request.buffer;
  const needSource = candidates.length > 0 && !activeBuffer;

  const parsed = useMemo(() => parseOffsetChain(chain), [chain]);
  const preview = useMemo(() => {
    if (parsed.error || !parsed.offsets.length || !onPreview || !activeBuffer) return null;
    return onPreview(parsed.offsets, width, activeBuffer);
  }, [parsed, width, onPreview, activeBuffer]);
  const blocked = !!parsed.error || !!preview?.error || needSource;
  const safeLimit = BigInt(Number.MAX_SAFE_INTEGER);
  const fitsPack = BigInt(preview?.final ?? request.address) <= safeLimit && (!activeBuffer
    || BigInt(activeBuffer.base) + BigInt(activeBuffer.bytes.length) <= safeLimit);
  const filtered = useMemo(() => {
    const all = smart ? [smart, ...items] : items;
    const needle = q.trim().toLowerCase();
    return all.filter(i => (i.addressType !== 'pack-address' || fitsPack)
      && `${i.label} ${i.nodeId} ${i.detail} ${i.typeName ?? ''}`.toLowerCase().includes(needle));
  }, [items, q, smart, fitsPack]);

  const defaultKey = request.hint ? 'element' : (lastKey ?? '');
  /** 高亮下标始终落在可见候选范围内 */
  const cursor = filtered.length ? Math.min(active, filtered.length - 1) : 0;
  const pick = (item: FollowItem | undefined) => {
    if (!item || blocked) return;
    onPick(item, parsed.offsets, width, activeBuffer);
  };

  useEffect(() => { inputRef.current?.focus(); }, []);
  /** 搜索词变化时回到默认项：可推断时的元素解析，否则上次用过的候选 */
  useEffect(() => {
    const i = filtered.findIndex((x) => x.key === defaultKey);
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.bp-quick-item.on');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      // 只接管搜索框、候选列表和偏移链输入；下拉保持原生按键语义。
      const active = document.activeElement;
      const inList = !!active && !!listRef.current?.contains(active);
      const inSearch = active === inputRef.current;
      const inChain = active === chainRef.current;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onClose(); return;
      }
      if (!inList && !inSearch) {
        // 偏移链里按 Enter 等于「确认当前选择」，但不劫持方向键。
        if (inChain && e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          pick(filtered[cursor]);
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (!filtered.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive((cursor + dir + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        pick(filtered[cursor]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filtered, cursor, onPick, onClose, blocked, parsed, width, activeBuffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const hex = addressHex(request.address);
  const hx = addressHex;

  return (
    <div className="bp-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="bp-quick bp-follow"
        role="dialog"
        aria-modal="true"
        aria-label="在此地址解析"
        ref={dialogRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="bp-follow-head">
          <span>在此地址解析</span>
          <b className="mono">{hex}</b>
          <button className="bp-icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>×</button>
        </div>
        <div className="bp-follow-source mono" title={request.description}>{request.description}</div>

        {candidates.length > 0 && (
          <label className="bp-param bp-follow-source-pick">
            <span>数据源</span>
            <select
              className="in"
              aria-label="选择覆盖该地址的转储"
              value={chosenKey}
              onChange={(e) => setChosenKey(e.target.value)}
            >
              <option value="">{candidates.length} 份转储覆盖此地址，请选择…</option>
              {candidates.map((b) => (
                <option key={candidateKey(b)} value={candidateKey(b)}>
                  {b.name} · {addressHex(b.base)}–{addressHex(BigInt(b.base) + BigInt(b.bytes.length))}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && (
          <div className="bp-follow-source mono" title={chosen.name}>
            使用 {chosen.name} · 基址 {addressHex(chosen.base)}
          </div>
        )}

        <details className="bp-follow-advanced">
          <summary>高级：多级指针偏移链</summary>
          <label className="bp-follow-chain">
            <span className="bp-follow-chain-label">偏移链</span>
            <input
              ref={chainRef}
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
              {!parsed.error && !preview && needSource && (
                <div className="bp-chain-err">先选择要使用的转储</div>
              )}
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
        </details>

        <input
          ref={inputRef}
          className="bp-quick-input"
          placeholder="搜索解析节点 / 类型"
          aria-label="搜索解析节点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="bp-quick-list" role="listbox" aria-label="解析节点列表" ref={listRef}>
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
                  onFocus={() => setActive(i)}
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
          {!filtered.length && <div className="bp-empty">无匹配节点{!fitsPack ? '；当前地址只支持内置读取' : ''}</div>}
        </div>
        {needSource && <div className="bp-quick-foot mono">先选择数据源，再选择解析方式</div>}
        <div className="bp-quick-foot mono">↑↓ 选择 · Enter 解析 · Esc 关闭 · 偏移链逐级解引用</div>
        <div className="bp-quick-foot mono">{formatKeys(['Alt+ArrowLeft'])} 返回上一视图 · 元素解析只在类型可推断时出现</div>
      </div>
    </div>
  );
}
