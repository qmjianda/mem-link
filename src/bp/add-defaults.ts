import { isInstanceView, type BPNode, type BPResult } from './types';
import type { SelectionState } from './selection';

/** 从同一个 File 复用地址和数据源，避免把第二份 dump 的地址用到第一份上。 */
export function initialParseParams(
  nodes: BPNode[],
  selection: SelectionState,
  result: Pick<BPResult, 'sources' | 'inputs' | 'ports'>,
): Record<string, string> {
  const selected = selection.nodes.size === 1 && !selection.edges.size && selection.primary?.kind === 'node'
    ? selection.primary.id : undefined;
  const source = selected ? result.sources.get(selected) : undefined;
  const input = selected ? result.inputs.get(selected)?.address : undefined;
  const usesFile = selected ? result.ports.get(selected)?.inputs.some((port) => port.context) : false;
  const { buffer, fileId } = source ?? {};
  if (((usesFile && input) || source?.mode === 'file') && fileId && buffer?.bytes.length && !source?.conflict && !source?.sourceCycle) {
    const value = input?.value;
    const addr = isInstanceView(value) ? value.addr : value;
    const valid = typeof addr === 'number' && Number.isSafeInteger(addr)
      && addr >= buffer.base && addr - buffer.base < buffer.bytes.length;
    return { address: hex(valid ? addr : buffer.base), sourceId: fileId };
  }

  // 缓存裁剪后仅剩文件记录的节点仍可能被求值器选为默认来源，也计入歧义。
  const files = nodes.filter((n) => n.packId === '' && n.nodeId === 'file' && n.source);
  const only = files.length === 1 ? files[0].source : undefined;
  return { address: hex(only?.data ? only.base : 0) };
}

const hex = (value: number) => `0x${value.toString(16)}`;
