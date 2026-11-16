import { useEffect, useState } from 'react';
import type { Pack, RootDef } from '../core/pack';
import type { Problem } from '../core/types';
import type { Memory } from '../core/mem';
import HexView from '../ui/HexView';
import { IconChevron, IconFile, IconFolder, IconUpload } from '../ui/icons';
import { bytes, hex32 } from '../ui/format';

interface Props {
  pack?: Pack;
  packName: string;
  loadError?: string;
  issues: Problem[];
  mem: Memory;
  memName: string;
  extraRoots: RootDef[];
  onAddRoot: (type: string, address: number) => void;
  onRemoveRoot: (index: number) => void;
  localEdits: number;
  onClearLocal: () => void;
  onOpenPack: (f: File) => void;
  onOpenBin: (f: File) => void;
  onBase: (n: number) => void;
  onSelectNode: (key: string) => void;
}

function Section({
  title, count, hint, children, defaultOpen = true,
}: {
  title: string;
  count?: number;
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="sec">
      <header className="sec-head" onClick={() => setOpen((o) => !o)}>
        <IconChevron size={12} className="sec-chev" />
        <span className="sec-title">{title}</span>
        {count != null && <span className="sec-count">{count}</span>}
        <span className="sec-fill" />
      </header>
      {hint && open && <p className="sec-hint">{hint}</p>}
      {open && <div className="sec-body">{children}</div>}
    </section>
  );
}

export default function PackLeft({
  pack, packName, loadError, issues, mem, memName, extraRoots,
  onAddRoot, onRemoveRoot, localEdits, onClearLocal, onOpenPack, onOpenBin, onBase, onSelectNode,
}: Props) {
  const [tab, setTab] = useState<'struct' | 'data'>('struct');
  const [openType, setOpenType] = useState<string | null>(null);
  const [baseText, setBaseText] = useState(`0x${mem.base.toString(16)}`);
  const [newType, setNewType] = useState('');
  const [newAddr, setNewAddr] = useState('0x0');
  const [addErr, setAddErr] = useState('');

  useEffect(() => { setBaseText(`0x${mem.base.toString(16)}`); }, [mem.base]);

  useEffect(() => {
    if (!pack) return;
    if (!pack.types.some((t) => t.name === newType)) setNewType(pack.types[0]?.name ?? '');
  }, [pack, newType]);

  const addRoot = () => {
    const text = newAddr.trim();
    const n = Number(text);
    if (!pack || !newType) { setAddErr('pack 里没有可用的类型'); return; }
    if (!text || !Number.isFinite(n) || n < 0) { setAddErr('地址必须是非负数字，可写 0x130'); return; }
    setAddErr('');
    onAddRoot(newType, n);
  };

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;

  return (
    <aside className="panel left">
      <div className="panel-tabs">
        <button className={tab === 'struct' ? 'on' : ''} onClick={() => setTab('struct')}>结构</button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>数据</button>
      </div>

      <div className="panel-scroll">
        {tab === 'struct' ? (
          <>
            <Section title="pack 文件" hint="一个 .ts 文件描述类型、转换、常量和根节点。">
              <div className="pack-card">
                <span className="pack-ic"><IconFile size={15} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong className="pack-name">{pack?.name ?? packName}</strong>
                  <span className="pack-file mono">{packName}</span>
                </div>
                {pack && (
                  <div className="pack-flags">
                    <span>{pack.endian === 'little' ? 'LE' : 'BE'}</span>
                    <span>{pack.pointerSize * 8}bit</span>
                  </div>
                )}
              </div>
              {localEdits > 0 && (
                <div className="local-row">
                  <span>本地修改 {localEdits} 项 · 已自动保存</span>
                  <button className="link-btn" onClick={onClearLocal}>清除</button>
                </div>
              )}
              <label className="btn block" style={{ marginTop: 8 }}>
                <IconFolder size={13} /> 打开 .pack.ts
                <input
                  type="file"
                  accept=".ts,.txt,.js"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpenPack(f); e.currentTarget.value = ''; }}
                />
              </label>
              <p className="tip">也可以直接把 .pack.ts 拖进窗口；改完重新拖入即可。</p>
            </Section>

            {(loadError || issues.length > 0) && (
              <Section title="检查" count={issues.length} defaultOpen>
                {loadError && <div className="banner err"><div><strong>加载失败</strong><p>{loadError}</p></div></div>}
                {issues.map((p, i) => (
                  <div key={i} className={`issue ${p.severity}`}>
                    <span className="issue-lv">{p.severity === 'error' ? 'E' : 'W'}</span>
                    <div><strong>{p.message}</strong>{p.detail && <em>{p.detail}</em>}</div>
                  </div>
                ))}
                <p className="tip">{errorCount} 个错误 · {warnCount} 个警告</p>
              </Section>
            )}

            <Section title="类型" count={pack?.types.length ?? 0} hint="字段偏移是字节偏移；点击类型展开字段。">
              {pack?.types.map((t) => (
                <div className={`type-row${openType === t.name ? ' open' : ''}`} key={t.name}>
                  <button className="type-head" onClick={() => setOpenType(openType === t.name ? null : t.name)}>
                    <IconChevron size={11} className="sec-chev" />
                    <span className="type-name">{t.name}</span>
                    {t.union && <span className="badge">union</span>}
                    <span className="type-size mono">{t.size} B</span>
                  </button>
                  {openType === t.name && (
                    <div className="type-fields">
                      {t.fields.map((f) => (
                        <div className="type-field" key={f.name}>
                          <span className="mono tf-off">+{f.offset}</span>
                          <span className="tf-name">{f.name}</span>
                          <span className="mono tf-kind">{f.kind}{f.count ? `[${f.count}]` : ''}</span>
                          {f.follow && <span className="tf-follow">↗ {f.follow}</span>}
                          {f.transform && <span className="tf-fx">fx</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!pack && <p className="tip">尚未加载 pack。</p>}
            </Section>

            <Section
              title="根节点"
              count={(pack?.roots.length ?? 0) + extraRoots.length}
              hint="图从这些地址开始遍历；字段转换返回地址就会继续展开。也可以临时加一个地址。"
            >
              {pack?.roots.map((r, i) => (
                <button
                  key={`${r.type}-${r.address}-${i}`}
                  className="root-card"
                  onClick={() => onSelectNode(`${r.address}:${r.type}`)}
                >
                  <div className="root-top">
                    <span className="root-label">{r.label || r.type}</span>
                    <span className="mono root-type">{r.type}</span>
                  </div>
                  <div className="root-addr mono">{hex32(r.address)}</div>
                </button>
              ))}
              {extraRoots.map((r, i) => (
                <div
                  key={`extra-${r.type}-${r.address}-${i}`}
                  className="root-card temp"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectNode(`${r.address}:${r.type}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSelectNode(`${r.address}:${r.type}`); }}
                >
                  <div className="root-top">
                    <span className="root-label">{r.label || r.type}</span>
                    <span className="mono root-type">{r.type}</span>
                  </div>
                  <div className="root-addr mono">{hex32(r.address)}</div>
                  <button
                    className="root-x"
                    title="移除临时根"
                    onClick={(e) => { e.stopPropagation(); onRemoveRoot(i); }}
                  >×</button>
                </div>
              ))}
              {pack && (
                <div className="root-add">
                  <select className="in" value={newType} onChange={(e) => setNewType(e.target.value)}>
                    {pack.types.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                  </select>
                  <input
                    className="in mono"
                    value={newAddr}
                    spellCheck={false}
                    onChange={(e) => setNewAddr(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addRoot(); }}
                    placeholder="0x130"
                  />
                  <button className="btn" onClick={addRoot}>添加</button>
                </div>
              )}
              {addErr && <p className="tip err">{addErr}</p>}
              {!pack && <p className="tip">尚未加载 pack。</p>}
            </Section>

            <Section title="常量" count={pack ? Object.keys(pack.constants).length : 0} hint="转换函数里通过 ctx.consts.NAME 访问。" defaultOpen={false}>
              <div className="const-grid">
                {pack && Object.entries(pack.constants).map(([k, v]) => (
                  <div key={k} className="const-row">
                    <span className="mono">{k}</span>
                    <span className="mono">{Number.isFinite(v) ? `0x${(v >>> 0).toString(16).toUpperCase()}` : String(v)}</span>
                  </div>
                ))}
              </div>
              {pack && !Object.keys(pack.constants).length && <p className="tip">没有常量。</p>}
            </Section>
          </>
        ) : (
          <>
            <Section title="缓冲区" hint="拖入 .bin / .hex；基址是文件第一个字节对应到内存的地址。">
              <label className="dropzone small">
                <input
                  type="file"
                  accept=".bin,.hex,.txt"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpenBin(f); e.currentTarget.value = ''; }}
                />
                <IconUpload size={16} />
                <span><strong>{memName}</strong><em>{bytes(mem.size)}</em></span>
              </label>
              <div className="fld" style={{ marginTop: 8 }}>
                <span className="fld-label">基址</span>
                <input
                  className="in mono"
                  value={baseText}
                  onChange={(e) => setBaseText(e.target.value)}
                  onBlur={() => {
                    const n = Number(baseText);
                    if (Number.isFinite(n) && n >= 0) onBase(n);
                    else setBaseText(`0x${mem.base.toString(16)}`);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </div>
              <div className="mem-row mono">
                <span>{hex32(mem.base)} – {hex32(mem.end)}</span>
                <span>{bytes(mem.size)}</span>
              </div>
            </Section>

            <Section title="十六进制" hint="选中节点后，检查器会高亮对应字段。">
              <HexView mem={mem} addr={mem.base} len={Math.min(mem.size, 512)} compact cols={8} maxRows={20} />
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
