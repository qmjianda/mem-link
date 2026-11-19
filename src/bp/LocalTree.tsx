import { useRef, useState } from 'react';
import { FieldTable, type FieldTools } from './Inspector';
import { addressHex } from './precision';
import type { InstanceView } from './types';
import { useModalFocus } from './ModalFocus';

const PAGE = 64;

/** Browse already decoded records without reading them again or changing the graph. */
export default function LocalTree({ title, items, stop, onClose, tools }: {
  title: string;
  items: InstanceView[];
  stop?: string;
  onClose: () => void;
  tools?: FieldTools;
}) {
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState('');
  const [invalid, setInvalid] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const selected = Math.min(index, Math.max(0, items.length - 1));
  const start = Math.floor(selected / PAGE) * PAGE;
  const item = items[selected];
  const move = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= items.length) { setInvalid(true); return; }
    setIndex(i);
    setInvalid(false);
    scroll.current?.scrollTo(0, 0);
  };
  return (
    <div className="bp-tree-overlay" onPointerDown={onClose}>
      <div className="bp-tree" role="dialog" aria-modal="true" aria-label="结构视图" ref={dialogRef} onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <div className="bp-tree-head">
          <div className="bp-tree-title"><b>{title}</b><span className="bp-tree-meta">
            {items.length} 项{stop ? ` · ${stop}` : ''}
          </span></div>
          <div className="bp-tree-tools">
            {items.length > 1 && (
              <form className="bp-tree-jump" onSubmit={e => { e.preventDefault(); move(jump.trim() ? Number(jump) : NaN); }}>
                <input className="in mono" aria-label="跳到项下标" aria-invalid={invalid}
                  value={jump} onChange={e => { setJump(e.target.value); setInvalid(false); }} placeholder="# 下标" />
                <button type="submit" className="bp-mini">跳转</button>
              </form>
            )}
            <button type="button" className="bp-mini" onClick={onClose} autoFocus aria-label="关闭结构视图">关闭</button>
          </div>
        </div>
        <div className="bp-local-tree">
          {items.length > 1 && (
            <div className="bp-local-tree-list" ref={scroll}>
              <div className="bp-local-tree-pages">
                <button type="button" className="bp-mini" disabled={start === 0} onClick={() => move(start - PAGE)}>上一页</button>
                <button type="button" className="bp-mini" disabled={start + PAGE >= items.length} onClick={() => move(start + PAGE)}>下一页</button>
              </div>
              {items.slice(start, start + PAGE).map((entry, at) => (
                <button type="button" className={`bp-mini${start + at === selected ? ' primary' : ''}`} key={start + at}
                  onClick={() => move(start + at)} aria-pressed={start + at === selected}>
                  #{start + at} · {addressHex(entry.location?.value ?? entry.addr)}
                </button>
              ))}
            </div>
          )}
          <div className="bp-local-tree-fields">
            {item ? <FieldTable key={selected} inst={item} tools={tools} /> : <div className="bp-empty">没有已读取的项</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
