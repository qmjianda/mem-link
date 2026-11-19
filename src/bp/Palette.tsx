import { useMemo, useState } from 'react';
import type { NodeDef } from './types';
import { BUILTIN_DEFS, BUILTIN_GROUPS } from './builtins';
import type { LoadedPack } from './docstate';
import { isPackEnabled } from './docstate';
import type { PackImpact } from './packops';
import { IconChevron } from '../ui/icons';

/** 文档层定义，这里只做转出，避免组件之间互相依赖 */
export type { LoadedPack };

interface Props {
  packs: LoadedPack[];
  onAdd: (packId: string, nodeId: string) => void;
  /** begin a pointer drag from the palette; the parent owns the drag state */
  onDragStart: (packId: string, nodeId: string, label: string, sx: number, sy: number) => void;
  /** true when the click that follows a drag must not create another node */
  shouldIgnoreAdd: () => boolean;
  onLoadPack: (f: File) => void;
  /** 影响面统计（节点数 / 相关连线数），删除与禁用确认文案要用 */
  impactOf: (packId: string) => PackImpact;
  onTogglePack: (packId: string, enabled: boolean) => void;
  onRenamePack: (packId: string, name: string) => void;
  onDeletePack: (packId: string) => void;
  onCleanupPack: (packId: string) => void;
  /** 分组折叠表：key 为 `builtin` 或 pack id，true 表示折叠 */
  collapsedGroups: Record<string, boolean>;
  onToggleGroup: (key: string) => void;
  /** 折叠整个节点库为 36px 竖排条 */
  onCollapse: () => void;
}

export interface PalItem { packId: string; nodeId: string; label: string; kind: string; hint?: string }

interface Group {
  key: string;
  title: string;
  sub?: string;
  enabled: boolean;
  builtin?: boolean;
  items: PalItem[];
}

export function kindName(def: NodeDef): string {
  return def.kind === 'calc' ? '计算' : '解析';
}

/** 内置节点 + 每个 pack 的节点清单（节点库与快速添加共用同一份） */
export function nodeItemsOf(packs: LoadedPack[]): PalItem[] {
  const out: PalItem[] = BUILTIN_DEFS.map((d) => ({
    packId: '', nodeId: d.id, label: d.label, kind: d.group, hint: d.hint,
  }));
  for (const p of packs) {
    if (!isPackEnabled(p)) continue;   // 禁用的 pack 不出现在快速添加里
    for (const [key, def] of Object.entries(p.pack.nodes)) {
      out.push({ packId: p.id, nodeId: key, label: def.label ?? key, kind: kindName(def) });
    }
  }
  return out;
}

export default function Palette({
  packs, onAdd, onDragStart, shouldIgnoreAdd,
  onLoadPack,
  impactOf, onTogglePack, onRenamePack, onDeletePack, onCleanupPack,
  collapsedGroups, onToggleGroup, onCollapse,
}: Props) {
  const [q, setQ] = useState('');
  const searching = q.trim().length > 0;
  /** 正在行内重命名的 pack id */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 删除 / 清理的就地二次确认 */
  const [pending, setPending] = useState<{ kind: 'delete' | 'cleanup'; packId: string } | null>(null);
  /** 行内重命名校验提示 */
  const [renameError, setRenameError] = useState<string | null>(null);

  const groups = useMemo<Group[]>(() => {
    const builtins = nodeItemsOf([]);
    const out: Group[] = BUILTIN_GROUPS.map((name) => ({
      key: `builtin:${name}`,
      title: name,
      enabled: true,
      builtin: true,
      items: builtins.filter((i) => i.kind === name),
    }));
    for (const p of packs) {
      const items = Object.entries(p.pack.nodes).map(([key, def]) => ({
        packId: p.id,
        nodeId: key,
        label: def.label ?? key,
        kind: kindName(def),
      }));
      out.push({
        key: p.id,
        title: p.name,
        sub: `${Object.keys(p.pack.types).length} 类型 · ${items.length} 节点`,
        enabled: isPackEnabled(p),
        items,
      });
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    return out
      .map((g) => ({ ...g, items: g.items.filter((i) => `${i.label} ${i.nodeId} ${i.kind} ${i.hint ?? ''}`.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length);
  }, [packs, q]);

  const startRename = (g: Group) => {
    setRenameError(null);
    setEditing(g.key);
    setDraft(g.title);
  };

  const commitRename = (key: string) => {
    const name = draft.trim();
    if (!name) { setRenameError('名称不能为空'); return; }
    setRenameError(null);
    setEditing(null);
    onRenamePack(key, name);
  };

  return (
    <aside className="panel left bp-palette">
      <div className="bp-pal-head">
        <span>节点库</span>
        <em className="mono">{packs.length} pack</em>
        <button className="bp-fold" title="折叠节点库（Ctrl+\）" aria-label="折叠节点库" onClick={onCollapse}>«</button>
      </div>
      <div className="bp-search">
        <input
          className="in"
          data-bp-search
          placeholder="搜索节点 / 类型"
          aria-label="搜索节点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="bp-pal-body">
        <div className="bp-pack-import">
          <label className="bp-mini" title="pack 为可执行代码，仅导入可信来源">
            导入 .bp.ts
            <input
              type="file"
              accept=".ts,.txt"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onLoadPack(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
        </div>
        {groups.map((g) => {
          // 搜索命中时强制展开，但不改写用户已保存的折叠状态。
          const open = searching || !collapsedGroups[g.key];
          const impact = g.builtin ? { nodes: 0, edges: 0 } : impactOf(g.key);
          const confirming = pending?.packId === g.key;
          return (
            <div
              key={g.key}
              className={`bp-group${open ? ' open' : ''}${g.enabled ? '' : ' disabled'}`}
            >
              <div className="bp-group-head">
                {editing === g.key ? (
                  <input
                    className="bp-name-input mono"
                    autoFocus
                    value={draft}
                    aria-label={`重命名 pack ${g.title}`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(g.key); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditing(null); setRenameError(null); }
                    }}
                    onBlur={() => commitRename(g.key)}
                  />
                ) : null}
                {editing === g.key && renameError && <span className="bp-name-error">{renameError}</span>}
                {editing !== g.key && (
                  <button
                    className="bp-group-btn"
                    disabled={searching}
                    aria-expanded={open}
                    title={searching ? '搜索中' : `${open ? '折叠' : '展开'} ${g.title}`}
                    onClick={(e) => { if (e.detail > 1) return; onToggleGroup(g.key); }}
                    onDoubleClick={() => { if (!g.builtin && !searching) startRename(g); }}
                  >
                    <IconChevron size={10} className="bp-group-chev" />
                    <span className="bp-group-title">{g.title}</span>
                    {g.sub && <em>{g.sub}</em>}
                  </button>
                )}
              </div>

              {!g.builtin && (
                confirming ? (
                  <div className="bp-confirm">
                    <span>
                      {pending.kind === 'delete'
                        ? `删除 pack「${g.title}」？将同时删除 ${impact.nodes} 个节点、${impact.edges} 条连线。`
                        : `清理 ${impact.nodes} 个节点？pack 保留在文档里。`}
                    </span>
                    <div className="bp-confirm-row">
                      <button
                        className="bp-mini danger"
                        onClick={() => {
                          setPending(null);
                          if (pending.kind === 'delete') onDeletePack(g.key);
                          else onCleanupPack(g.key);
                        }}
                      >{pending.kind === 'delete' ? '确认删除' : '确认清理'}</button>
                      <button className="bp-mini" onClick={() => setPending(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="bp-pack-tools">
                    <label className="bp-switch" title={g.enabled ? '禁用 pack' : '启用 pack'}>
                      <input
                        type="checkbox"
                        checked={g.enabled}
                        aria-label={`启用 pack ${g.title}`}
                        onChange={(e) => onTogglePack(g.key, e.target.checked)}
                      />
                      <span className="bp-switch-track" />
                    </label>
                    <span className={`bp-pack-state${g.enabled ? '' : ' off'}`}>
                      {g.enabled ? '启用' : `已禁用 · ${impact.nodes} 节点`}
                    </span>
                    <span className="grow" />
                    {!g.enabled && impact.nodes > 0 && (
                      <button
                        className="bp-mini"
                        onClick={() => setPending({ kind: 'cleanup', packId: g.key })}
                      >清理 {impact.nodes} 个节点</button>
                    )}
                    <button
                      className="bp-mini danger"
                      title={`删除 pack ${g.title}`}
                      onClick={() => setPending({ kind: 'delete', packId: g.key })}
                    >删除</button>
                  </div>
                )
              )}

              {open && (
                <div className="bp-group-items">
                  {g.items.map((i) => (
                    <button
                      key={`${i.packId}/${i.nodeId}`}
                      className="bp-pal-item"
                      draggable={false}
                      disabled={!g.enabled}
                      title={g.enabled ? `${i.hint ?? i.label} · 拖到画布放置 · 单击添加到视图中心` : 'pack 已禁用'}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        onDragStart(i.packId, i.nodeId, i.label, e.clientX, e.clientY);
                      }}
                      onClick={() => { if (!shouldIgnoreAdd()) onAdd(i.packId, i.nodeId); }}
                    >
                      <span className="bp-pal-dot" data-kind={i.kind} />
                      <span className="bp-pal-label">{i.label}</span>
                      <span className="bp-pal-kind">{i.kind}</span>
                    </button>
                  ))}
                  {!g.items.length && <div className="bp-empty">无匹配节点</div>}
                </div>
              )}
            </div>
          );
        })}
        {searching && !groups.length && (
          <div className="bp-empty bp-empty-search">无匹配节点</div>
        )}
        {!packs.length && !searching && (
          <div className="bp-empty bp-empty-pack">可直接载入 dump 并使用内置节点。自定义解析节点通过 .bp.ts 导入。</div>
        )}
      </div>
    </aside>
  );
}
