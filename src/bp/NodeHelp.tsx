/**
 * 节点帮助：pack 节点的“这一节点是什么、端口怎么接、类型里有哪些字段”。
 *
 * 入口有三处：节点库条目的 `?`、快速添加的 `?`、检查器标题旁的「帮助」。
 * 参考蓝图按钮由调用方提供；本地导入的 pack 没有商店来源时隐藏。
 */

import { useMemo, useState } from 'react';
import { fieldSize, type FieldDef } from '../core/pack';
import { useModalFocus } from './ModalFocus';
import { portsFor } from './eval';
import type { BPNode, NodeDef, PortSpec } from './types';
import { isPackEnabled, type LoadedPack } from './docstate';
import { IconExternal, IconX } from '../ui/icons';

interface Props {
  pack: LoadedPack;
  nodeId: string;
  onClose: () => void;
  onOpenReference?: () => Promise<void> | void;
}

const KIND_LABEL: Record<NodeDef['kind'], string> = {
  struct: '解析结构',
  list: '遍历链表',
  array: '展开数组',
  calc: '计算',
};

function fieldTypeName(f: FieldDef): string {
  if (f.kind === 'record') return f.of ?? f.ofType?.name ?? 'record';
  if (f.kind === 'array') {
    const of = f.of ?? f.ofType?.name ?? '?';
    return `${of}[${f.count ?? '?'}]`;
  }
  if (f.kind === 'bits') {
    const unit = f.bits?.unit ?? 1;
    return `bits(${(f.bits?.width ?? 0)}/${unit * 8})`;
  }
  if (f.kind === 'string' || f.kind === 'bytes') return `${f.kind}[${f.count ?? 0}]`;
  return f.kind;
}

function usageText(def: NodeDef): string[] {
  if (def.kind === 'calc') {
    return [
      '把需要的值接到输入端口；没有连线的输入会读取检查器里的内联值。',
      '输出端口可以直接接下游的地址、数量或断言输入。',
    ];
  }
  if (def.kind === 'struct') {
    return [
      '数据源接 File 节点，或放在一条已经连到 File 的解析链下游。',
      'address 填这个结构在文件里的起始偏移；输出端口就是结构字段。',
      '字段可直接接到其它节点的地址 / 数量输入，或接到断言做校验。',
    ];
  }
  if (def.kind === 'array') {
    return [
      '数据源接 File 节点；address 填第一项偏移。',
      'count 没有默认值时必须接一个数量输入；固定数量已在节点里写好。',
      '输出 list、count 和 elem:N；elem:N 可继续接元素解析或字段跟随。',
    ];
  }
  return [
    '数据源接 File 节点；address 填第一项偏移。',
    '下一项地址由 pack 的 next 规则计算；遇到结束值、越界或环会停止。',
    '输出 list、count 和 elem:N；elem:N 可继续接元素解析或字段跟随。',
  ];
}

export default function NodeHelp({ pack, nodeId, onClose, onOpenReference }: Props) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const def = pack.pack.nodes[nodeId];
  const [refBusy, setRefBusy] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);

  const ports = useMemo(() => {
    const node: BPNode = { id: '__help', packId: pack.id, nodeId, x: 0, y: 0, params: {} };
    try {
      return portsFor(node, new Map([[pack.id, pack.pack]]));
    } catch {
      return { inputs: [] as PortSpec[], outputs: [] as PortSpec[] };
    }
  }, [pack, nodeId]);

  if (!def) {
    return (
      <div className="bp-overlay" role="presentation" onPointerDown={onClose}>
        <div className="bp-help bp-node-help" role="dialog" aria-modal="true" ref={dialogRef} onPointerDown={(e) => e.stopPropagation()}>
          <div className="bp-help-head"><b>节点不存在</b><button className="bp-icon-btn" onClick={onClose} aria-label="关闭"><IconX size={14} /></button></div>
        </div>
      </div>
    );
  }

  const type = def.kind === 'calc' ? undefined : def.type;
  const fields = type?.fields ?? [];
  const shown = fields.slice(0, 120);
  const method = usageText(def);
  const enabled = isPackEnabled(pack);

  const openReference = async () => {
    if (!onOpenReference || refBusy) return;
    setRefBusy(true);
    setRefError(null);
    try {
      await onOpenReference();
    } catch (e) {
      setRefError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefBusy(false);
    }
  };

  return (
    <div className="bp-overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="bp-help bp-node-help"
        role="dialog"
        aria-modal="true"
        aria-label={`节点帮助：${def.label ?? nodeId}`}
        ref={dialogRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="bp-help-head">
          <div>
            <b>{def.label ?? nodeId}</b>
            <span className="bp-help-kind">{KIND_LABEL[def.kind]}</span>
            <em className="mono">{pack.name}</em>
            {!enabled && <span className="bp-help-off">pack 已禁用</span>}
          </div>
          <button className="bp-icon-btn" onClick={onClose} aria-label="关闭帮助" title="关闭（Esc）"><IconX size={14} /></button>
        </header>

        <div className="bp-help-body">
          <p className="bp-help-desc">{def.description || '这个节点没有说明。'}</p>

          <div className="bp-help-grid">
            <section className="bp-help-section">
              <h4>端口</h4>
              <div className="bp-help-ports">
                {ports.inputs.map((p) => (
                  <div className="bp-help-port" key={`in:${p.name}`}>
                    <span className="bp-help-dir in">入</span>
                    <b className="mono">{p.label ?? p.name}</b>
                    <em className="mono">{p.type}</em>
                    {p.context && <i>数据源</i>}
                    {p.hint && <small>{p.hint}</small>}
                  </div>
                ))}
                {ports.outputs.map((p) => (
                  <div className="bp-help-port" key={`out:${p.name}`}>
                    <span className="bp-help-dir out">出</span>
                    <b className="mono">{p.label ?? p.name}</b>
                    <em className="mono">{p.type}</em>
                    {p.hint && <small>{p.hint}</small>}
                  </div>
                ))}
                {!ports.inputs.length && !ports.outputs.length && <div className="bp-empty">没有端口</div>}
              </div>
              {(def.kind === 'list' || def.kind === 'array') && (
                <div className="bp-help-note">求值后还会动态出现 <code>elem:0</code>…<code>elem:N</code> 输出端口。</div>
              )}
            </section>

            <section className="bp-help-section">
              <h4>类型字段</h4>
              {type ? (
                <>
                  <div className="bp-help-type">
                    <b className="mono">{type.name}</b>
                    <span className="mono">{type.size} B</span>
                    {def.kind === 'array' && <span>默认 {def.count ?? '由 count 输入决定'} 项</span>}
                    {def.kind === 'list' && <span>最多 {def.max ?? 4096} 项</span>}
                  </div>
                  <div className="bp-help-fields mono">
                    {shown.map((f, i) => (
                      <div className="bp-help-field" key={`${f.name}:${i}`}>
                        <span className="off">+{f.offset ?? 0}</span>
                        <b>{f.label ?? f.name}</b>
                        <em>{fieldTypeName(f)}</em>
                        <span className="sz">{fieldSize(f, { pointerSize: pack.pack.pointerSize, types: Object.values(pack.pack.types) })} B</span>
                      </div>
                    ))}
                    {!shown.length && <div className="bp-empty">类型没有字段</div>}
                    {fields.length > shown.length && (
                      <div className="bp-help-more">还有 {fields.length - shown.length} 个字段未列出</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="bp-help-note">计算节点没有固定类型；看左侧的输入 / 输出端口。</div>
              )}
            </section>
          </div>

          <section className="bp-help-section">
            <h4>怎么用</h4>
            <ol className="bp-help-steps">
              {method.map((s) => <li key={s}>{s}</li>)}
            </ol>
          </section>

          {refError && <div className="bp-help-error" role="alert">{refError}</div>}
        </div>

        <footer className="bp-help-foot">
          <span className="bp-help-id mono">{pack.id}/{nodeId}</span>
          <span className="grow" />
          {onOpenReference && (
            <button type="button" className="btn" disabled={refBusy} onClick={() => { void openReference(); }}>
              <IconExternal size={12} /> {refBusy ? '正在读取…' : '打开参考蓝图'}
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>知道了</button>
        </footer>
      </div>
    </div>
  );
}
