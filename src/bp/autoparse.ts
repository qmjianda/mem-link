/**
 * Recognise a loaded buffer and propose a ready-to-wire parse chain.
 *
 * Detection is deliberately data-only: it never executes a pack or changes the
 * document. The UI turns the plan into nodes and edges in one commit.
 */

import type { BufferValue, BlueprintPack } from './types';
import { packStructureId } from './structure';

export interface AutoParseTable {
  kind: 'program' | 'section';
  label: string;
  offsetPort: 'phoff' | 'shoff';
  countPort: 'phnum' | 'shnum';
  /** Pack-provided array node, when available. */
  nodeId?: string;
  /** Fallback for older packs: built-in arrayread + pack structure type. */
  structureId?: string;
}

export interface AutoParsePlan {
  format: 'elf';
  label: string;
  packId: string;
  headerNodeId: 'header64' | 'header32';
  headerLabel: string;
  tables: AutoParseTable[];
  warning?: string;
}

export type AutoParseFailure = {
  ok: false;
  reason: string;
  /** The format was recognised but its pack is not installed/enabled. */
  needsPack?: boolean;
};
export type AutoParseDetection = { ok: true; plan: AutoParsePlan } | AutoParseFailure;

function findElfPack(packs: ReadonlyMap<string, BlueprintPack>): [string, BlueprintPack] | undefined {
  return [...packs].find(([, pack]) => {
    const nodes = pack.nodes;
    return !!(nodes.header64 || nodes.header32);
  });
}

export function detectAutoParse(buffer: BufferValue | undefined, packs: ReadonlyMap<string, BlueprintPack>): AutoParseDetection {
  const bytes = buffer?.bytes;
  if (!bytes || bytes.length < 6) return { ok: false, reason: '文件还没有载入足够字节' };
  const isElf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  if (!isElf) return { ok: false, reason: '未识别到可自动解析的格式（目前支持 ELF）' };

  const found = findElfPack(packs);
  if (!found) return { ok: false, reason: '检测到 ELF，但还没有安装/启用 ELF pack', needsPack: true };
  const [packId, pack] = found;

  const cls = bytes[4];
  const headerNodeId = cls === 2 ? 'header64' : cls === 1 ? 'header32' : undefined;
  if (!headerNodeId || !pack.nodes[headerNodeId]) {
    return { ok: false, reason: `无法识别 ELF 位宽（EI_CLASS=${cls}）` };
  }
  const suffix = headerNodeId === 'header64' ? '64' : '32';
  const data = bytes[5];
  const endian = data === 2 ? 'big' : 'little';
  const warnings: string[] = [];
  if (data !== 1 && data !== 2) warnings.push(`EI_DATA=${data} 不是标准值，按小端处理`);
  else if (data === 2) warnings.push('这是大端 ELF；ELF pack 默认按小端，字段值可能需要调整');

  const table = (kind: 'program' | 'section'): AutoParseTable | undefined => {
    const nodeId = `${kind === 'program' ? 'programHeaders' : 'sectionHeaders'}${suffix}`;
    const typeName = `${kind === 'program' ? 'ProgramHeader' : 'SectionHeader'}${suffix}`;
    const packNode = pack.nodes[nodeId] ? nodeId : undefined;
    const structureId = pack.types[typeName] ? packStructureId(packId, typeName) : undefined;
    if (!packNode && !structureId) return undefined;
    return {
      kind,
      label: packNode
        ? (pack.nodes[packNode].label ?? `ELF${suffix} ${kind === 'program' ? '程序头表' : '节头表'}`)
        : `ELF${suffix} ${kind === 'program' ? '程序头表' : '节头表'}`,
      offsetPort: kind === 'program' ? 'phoff' : 'shoff',
      countPort: kind === 'program' ? 'phnum' : 'shnum',
      ...(packNode ? { nodeId: packNode } : {}),
      ...(structureId ? { structureId } : {}),
    };
  };
  const tables = [table('program'), table('section')].filter((x): x is AutoParseTable => !!x);
  if (!tables.length) warnings.push('这个 ELF pack 没有程序头/节头类型，只创建文件头节点');

  return {
    ok: true,
    plan: {
      format: 'elf',
      label: `ELF${suffix}`,
      packId,
      headerNodeId,
      headerLabel: pack.nodes[headerNodeId].label ?? `ELF${suffix} 文件头`,
      tables,
      ...(warnings.length ? { warning: warnings.join('；') } : {}),
    },
  };
}
