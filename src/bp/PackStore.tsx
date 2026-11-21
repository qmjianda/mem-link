/**
 * Pack 商店浮层：归档目录、搜索、分类、安装/更新。
 *
 * 商店索引只包含数据；pack 源码在用户点击「安装」后才下载并编译。
 * 这是整个应用里除了打开商店之外唯一的联网动作。
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { LoadedPack } from './docstate';
import { useModalFocus } from './ModalFocus';
import { IconAlert, IconExternal, IconRefresh, IconStore, IconX } from '../ui/icons';
import type { StoreIndex, StorePackEntry } from './store';
import {
  categoryLabel,
  fetchStoreIndex,
  fetchStorePack,
  fetchStoreReference,
  installedPackOf,
  installState,
  readStoreCache,
  sourceLabel,
  writeStoreCache,
} from './store';

interface Props {
  storeUrl: string;
  packs: LoadedPack[];
  onStoreUrl: (url: string) => void;
  onInstall: (args: {
    entry: StorePackEntry;
    source: string;
    storeUrl: string;
  }) => Promise<{ ok: boolean; error?: string; updated?: boolean }>;
  /** 打开 pack 的参考蓝图（调用方负责进入临时示例模式）；false = 未打开 */
  onOpenReference: (entry: StorePackEntry, text: string) => Promise<boolean> | boolean;
  onClose: () => void;
}

type Status = 'loading' | 'ready' | 'error';

interface EntryError {
  id: string;
  message: string;
}

export default function PackStore({ storeUrl, packs, onStoreUrl, onInstall, onOpenReference, onClose }: Props) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const [urlDraft, setUrlDraft] = useState(storeUrl);
  const [currentUrl, setCurrentUrl] = useState(storeUrl);
  const [index, setIndex] = useState<StoreIndex | null>(() => readStoreCache(storeUrl)?.index ?? null);
  const [status, setStatus] = useState<Status>(index ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [refBusy, setRefBusy] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<EntryError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(() => readStoreCache(storeUrl)?.at ?? null);
  const abortRef = useRef<AbortController | null>(null);

  const load = async (input: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus(index ? 'ready' : 'loading');
    setError(null);
    setNotice(null);
    try {
      const r = await fetchStoreIndex(input, fetch, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setIndex(r.index);
      setCurrentUrl(r.url);
      setUrlDraft(r.url);
      setWarnings(r.warnings);
      setCachedAt(Date.now());
      setStatus('ready');
      onStoreUrl(r.url);
      writeStoreCache({ url: r.url, at: Date.now(), index: r.index });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus(index ? 'ready' : 'error');
    }
  };

  useEffect(() => {
    void load(storeUrl);
    const ctrl = abortRef.current;
    return () => ctrl?.abort();
    // 只在打开商店时自动加载一次；地址编辑由「加载」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const p of index?.packs ?? []) seen.add(p.category);
    return ['all', ...[...seen].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), 'zh-CN'))];
  }, [index]);

  const visible = useMemo(() => {
    if (!index) return [];
    const needle = query.trim().toLowerCase();
    return index.packs.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (!needle) return true;
      return `${p.name} ${p.id} ${p.summary} ${p.description ?? ''} ${(p.tags ?? []).join(' ')} ${p.author ?? ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [index, query, category]);

  const installed = (entry: StorePackEntry): LoadedPack | undefined => {
    const found = installedPackOf(packs, currentUrl, entry.id);
    return found as LoadedPack | undefined;
  };

  const stateOf = (entry: StorePackEntry) => installState(installed(entry)?.store?.version, entry.version);

  const runInstall = async (entry: StorePackEntry) => {
    if (busy) return;
    setBusy(entry.id);
    setEntryError(null);
    setNotice(null);
    try {
      const { source } = await fetchStorePack(currentUrl, entry.path);
      const r = await onInstall({ entry, source, storeUrl: currentUrl });
      if (!r.ok) throw new Error(r.error ?? '安装失败');
      setNotice(`${entry.name} v${entry.version} ${r.updated ? '已更新' : '已安装'}`);
    } catch (e) {
      setEntryError({ id: entry.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const runReference = async (entry: StorePackEntry) => {
    if (!entry.reference || refBusy) return;
    setRefBusy(entry.id);
    setEntryError(null);
    setNotice(null);
    try {
      const r = await fetchStoreReference(currentUrl, entry.reference);
      if ((await onOpenReference(entry, r.text)) === false) throw new Error('参考蓝图无法打开');
      onClose();
    } catch (e) {
      setEntryError({ id: entry.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefBusy(null);
    }
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const next = urlDraft.trim();
    if (!next) return;
    setIndex(null);
    void load(next);
  };

  return (
    <div className="bp-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="bp-store"
        role="dialog"
        aria-modal="true"
        aria-label="Pack 商店"
        ref={dialogRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="bp-store-head">
          <div className="bp-store-title">
            <IconStore size={16} />
            <b>Pack 商店</b>
            <em className="mono">{index ? `${index.packs.length} pack` : '加载中'}</em>
            {cachedAt ? <span className="bp-store-cache mono">缓存 {new Date(cachedAt).toLocaleDateString()}</span> : null}
          </div>
          <button type="button" className="bp-icon-btn" aria-label="关闭商店" title="关闭（Esc）" onClick={onClose}>
            <IconX size={14} />
          </button>
        </header>

        <form className="bp-store-url" onSubmit={submitUrl}>
          <input
            className="in mono"
            value={urlDraft}
            aria-label="商店地址"
            spellCheck={false}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://github.com/owner/repo 或 index.json"
          />
          <button type="submit" className="bp-mini primary" disabled={status === 'loading'}>
            {status === 'loading' ? '加载中…' : '加载'}
          </button>
          <button
            type="button"
            className="bp-mini"
            title="重新加载当前地址"
            disabled={status === 'loading'}
            onClick={() => { setIndex(null); void load(currentUrl); }}
          >
            <IconRefresh size={10} /> 刷新
          </button>
          {index?.homepage ? (
            <a className="bp-store-link" href={index.homepage} target="_blank" rel="noreferrer" title="打开商店仓库">
              <IconExternal size={11} /> 仓库
            </a>
          ) : null}
        </form>

        <div className="bp-store-filters">
          <input
            className="in"
            data-bp-store-search
            autoFocus
            placeholder="搜索格式、标签、作者…"
            aria-label="搜索 pack"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="bp-store-cats" role="tablist" aria-label="分类">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={category === c}
                className={`bp-store-cat${category === c ? ' on' : ''}`}
                onClick={() => setCategory(c)}
              >
                {categoryLabel(c)}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="bp-store-alert bad" role="alert">
            <IconAlert size={13} />
            <div>
              <b>商店加载失败</b>
              <span>{error}</span>
              <em>需要网络访问；GitHub Raw 通常允许跨域。安装过的 pack 仍可离线使用。</em>
            </div>
          </div>
        )}
        {!error && warnings.length > 0 && (
          <div className="bp-store-alert warn" role="status">
            <IconAlert size={13} />
            <div>
              <b>{warnings.length} 条索引警告</b>
              <span>{warnings.slice(0, 3).join('；')}</span>
            </div>
          </div>
        )}

        <div className="bp-store-body">
          {status === 'loading' && !index && (
            <div className="bp-store-empty">正在读取商店索引…</div>
          )}
          {status === 'error' && !index && (
            <div className="bp-store-empty">没有可显示的 pack。检查地址或网络后重试。</div>
          )}
          {index && !visible.length && (
            <div className="bp-store-empty">没有匹配的 pack。</div>
          )}
          {visible.map((entry) => {
            const st = stateOf(entry);
            const inst = installed(entry);
            const err = entryError?.id === entry.id ? entryError.message : null;
            return (
              <article className={`bp-store-card${entry.coverage === 'partial' ? ' partial' : ''}`} key={entry.id}>
                <div className="bp-store-card-head">
                  <div className="bp-store-card-title">
                    <b title={entry.description ?? entry.summary}>{entry.name}</b>
                    <span className="mono">v{entry.version}</span>
                    {entry.coverage === 'partial' && <em className="bp-store-badge partial" title="固定前缀布局 + calc/list/array/变体辅助节点；未覆盖项见 pack 末尾注释">{entry.helpers ? `部分布局 · ${entry.helpers} 辅助` : '部分布局'}</em>}
                    <em className="bp-store-badge src" data-provider={entry.source?.provider ?? 'manual'} title={entry.source?.url ?? '手工维护 pack'}>{sourceLabel(entry)}</em>
                  </div>
                  <span className={`bp-store-state ${st}`}>
                    {st === 'installed' ? `已安装 v${inst?.store?.version}` : st === 'update' ? `可更新 → v${entry.version}` : st === 'ahead' ? `本地 v${inst?.store?.version}` : '未安装'}
                  </span>
                </div>
                <p className="bp-store-summary">{entry.summary}</p>
                {entry.tags?.length ? (
                  <div className="bp-store-tags">
                    {entry.tags.slice(0, 6).map((t) => <span key={t}>{t}</span>)}
                  </div>
                ) : null}
                <div className="bp-store-meta mono">
                  <span>{entry.category}</span>
                  {entry.size ? <span>{Math.max(1, Math.round(entry.size / 1024))} KB</span> : null}
                  {entry.sha256 ? <span title={entry.sha256}>sha256 {entry.sha256.slice(0, 8)}…</span> : <span className="warn">无哈希</span>}
                  {entry.license ? <span>{entry.license}</span> : null}
                  {entry.author ? <span>{entry.author}</span> : null}
                </div>
                {err && <div className="bp-store-entry-error" role="alert">{err}</div>}
                <div className="bp-store-actions">
                  {entry.reference ? (
                    <button
                      type="button"
                      className="bp-mini"
                      disabled={!!busy || !!refBusy}
                      title="打开已经接好线的示例图（临时副本，不影响当前蓝图）"
                      onClick={() => void runReference(entry)}
                    >
                      {refBusy === entry.id ? '读取中…' : '参考蓝图'}
                    </button>
                  ) : null}
                  {entry.homepage ? (
                    <a className="bp-mini" href={entry.homepage} target="_blank" rel="noreferrer" title="打开格式说明">
                      <IconExternal size={10} /> 说明
                    </a>
                  ) : null}
                  <span className="grow" />
                  {st === 'installed' || st === 'ahead' ? (
                    <>
                      <button
                        type="button"
                        className="bp-mini"
                        disabled={!!busy}
                        title="重新下载并替换源码"
                        onClick={() => void runInstall(entry)}
                      >
                        {busy === entry.id ? '安装中…' : '重装'}
                      </button>
                      <span className="bp-store-installed">已安装</span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="bp-mini primary"
                      disabled={!!busy}
                      onClick={() => void runInstall(entry)}
                      title={st === 'update' ? `更新到 v${entry.version}` : '安装到当前蓝图'}
                    >
                      {busy === entry.id ? '安装中…' : st === 'update' ? `更新到 v${entry.version}` : '安装'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <footer className="bp-store-foot">
          <span>pack 是代码；安装时会编译执行，请只安装信任来源。</span>
          <span className="grow" />
          {notice && <b className="bp-store-notice">{notice}</b>}
          <span>安装后随蓝图/缓存保存，离线可用</span>
        </footer>
      </div>
    </div>
  );
}
