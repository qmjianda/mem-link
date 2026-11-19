import { useState } from 'react';
import { scalarRead } from './binary-read';
import { SCALARS } from './layouts';
import { interpretValue, type ValueFormat } from './interpret';
import { addressHex } from './precision';

export default function InterpretValue({ value }: { value: number | bigint }) {
  const [format, setFormat] = useState<ValueFormat>('decimal');
  const [mapping, setMapping] = useState('');
  const [unit, setUnit] = useState('s');
  let text: string;
  try { text = interpretValue(value, format, mapping, unit); }
  catch (err) { text = err instanceof Error ? err.message : String(err); }
  return (
    <details className="bp-interpret">
      <summary>解读数值（不修改图）</summary>
      <label className="bp-param">
        <span>显示方式</span>
        <select className="in" value={format} onChange={e => setFormat(e.target.value as ValueFormat)}>
          <option value="decimal">十进制</option><option value="hex">十六进制</option>
          <option value="binary">二进制</option><option value="time">UTC 时间</option>
          <option value="enum">枚举</option><option value="flags">标志位</option>
        </select>
      </label>
      {format === 'time' && <label className="bp-param"><span>时间单位</span>
        <select className="in" value={unit} onChange={e => setUnit(e.target.value)}>
          <option value="s">秒</option><option value="ms">毫秒</option><option value="us">微秒</option>
        </select>
      </label>}
      {(format === 'enum' || format === 'flags') && (
        <label className="bp-param"><span>{format === 'enum' ? '值=名称' : '掩码=名称'}</span>
          <input className="in mono" value={mapping} onChange={e => setMapping(e.target.value)} placeholder="1=Ready, 2=Busy" />
        </label>
      )}
      <div className="bp-kv"><span>预览</span><b className="mono">{text}</b></div>
    </details>
  );
}

export function ByteProbe({
  bytes, offset, baseAddress, sourceNodeId, onAddRead,
}: {
  bytes: Uint8Array;
  offset: number;
  baseAddress?: bigint;
  sourceNodeId?: string;
  onAddRead?: (nodeId: string, cfg: { address: bigint; kind: string; endian: 'little' | 'big' }) => void;
}) {
  const [kind, setKind] = useState('u8');
  const [endian, setEndian] = useState<'little' | 'big'>('little');
  let value: number | bigint | undefined;
  try { value = scalarRead({ bytes, base: 0, name: '预览', assetId: '' }, BigInt(offset), kind, endian).value; }
  catch { /* selection close to end of a dump */ }
  const absolute = (baseAddress ?? 0n) + BigInt(offset);
  const canAdd = value !== undefined && !!sourceNodeId && !!onAddRead;
  return (
    <details className="bp-interpret" open>
      <summary>从选中字节试读（不修改图）</summary>
      <label className="bp-param"><span>试读类型</span>
        <select className="in" value={kind} onChange={e => setKind(e.target.value)}>
          {SCALARS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <label className="bp-param"><span>试读字节序</span>
        <select className="in" value={endian} onChange={e => setEndian(e.target.value === 'big' ? 'big' : 'little')}>
          <option value="little">小端</option><option value="big">大端</option>
        </select>
      </label>
      <div className="bp-kv"><span>地址</span><b className="mono">{addressHex(absolute)}</b></div>
      <div className="bp-kv"><span>试读值</span><b className="mono">{value === undefined ? '字节不足' : String(value)}</b></div>
      {value !== undefined && <InterpretValue value={value} />}
      <div className="bp-field-tools">
        <button
          type="button"
          className="bp-ft-btn go"
          disabled={!canAdd}
          title={canAdd ? '用相同的来源、地址、类型与字节序创建读数值节点' : '当前选择无法读取'}
          onClick={() => {
            if (!canAdd || !sourceNodeId || !onAddRead) return;
            onAddRead(sourceNodeId, { address: absolute, kind, endian });
          }}
        >
          添加读数值节点
        </button>
      </div>
    </details>
  );
}
