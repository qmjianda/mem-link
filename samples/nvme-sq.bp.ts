/// <reference path="../types/memlink-bp.d.ts" />

// NVMe Submission Queue：SQE → PRP1 / PRP2 → PRP 列表 → 数据页
// 地址均为绝对物理地址；文件基址 0x1000，页大小 512 B。

const SQE_SIZE = 64;
const SQ_DEPTH = 4;
const PRP_DEPTH = 5;
const LBA_SIZE = 512;
const DATA_MAGIC = 0x454d564e; // "NVME"

// NVMe 1.4 提交队列项，64 B。CDW0 低 8 位为 OPC，高 16 位为 CID；
// CDW12 低 16 位为 NLB（0-based 块数）。
const Sqe = struct('Sqe', 64, [
  u32('cdw0', 0, { label: 'CDW0', format: 'hex' }),
  bits('opc', 0, 1, 0, 8, { label: 'OPC 操作码', format: 'hex' }),
  bits('fuse', 0, 2, 8, 2, { label: 'FUSE' }),
  bits('psdt', 0, 2, 14, 2, { label: 'PSDT' }),
  bits('cid', 0, 4, 16, 16, { label: 'CID 命令标识' }),
  u32('nsid', 4, { label: 'NSID 命名空间' }),
  u32('reserved0', 8, { label: '保留 [8]' }),
  u32('reserved1', 12, { label: '保留 [12]' }),
  u64('mptr', 16, { label: 'MPTR 元数据指针', format: 'hex' }),
  ptr('prp1', 24, { label: 'PRP1 首数据页', format: 'hex' }),
  ptr('prp2', 32, { label: 'PRP2 / 列表指针', format: 'hex' }),
  u32('cdw10', 40, { label: 'SLBA 低 32 位', format: 'hex' }),
  u32('cdw11', 44, { label: 'SLBA 高 32 位', format: 'hex' }),
  u32('cdw12', 48, { label: 'CDW12', format: 'hex' }),
  bits('nlb', 48, 2, 0, 16, { label: 'NLB 块数 − 1' }),
  u32('cdw13', 52, { label: 'CDW13', format: 'hex' }),
  u32('cdw14', 56, { label: 'CDW14', format: 'hex' }),
  u32('cdw15', 60, { label: 'CDW15', format: 'hex' }),
]);

// PRP 表项：低 12 位是页内偏移，其余为页基址。
const PrpEntry = struct('PrpEntry', 8, [
  u64('addr', 0, { label: '数据页地址', format: 'hex' }),
  bits('pageOffset', 0, 2, 0, 12, { label: '页内偏移' }),
]);

// 每个数据页带一个便于阅读的头，随后是 LBA 载荷。
const DataBlock = struct('DataBlock', LBA_SIZE, [
  u32('magic', 0, { label: 'Magic', format: 'hex' }),
  u32('lba', 4, { label: 'LBA' }),
  u32('seq', 8, { label: '序号' }),
  u32('crc32', 12, { label: '载荷校验', format: 'hex' }),
  str('payload', 16, LBA_SIZE - 16, { label: '数据' }),
]);

export default definePack({
  name: 'nvme-sq',
  endian: 'little',
  pointerSize: 8,
  constants: { SQE_SIZE, SQ_DEPTH, PRP_DEPTH, LBA_SIZE, DATA_MAGIC },
  types: { Sqe, PrpEntry, DataBlock },
  nodes: {
    sq: arrayNode(Sqe, { label: '提交队列 SQ', count: SQ_DEPTH, stride: SQE_SIZE }),
    sqe: structNode(Sqe, { label: 'SQE 命令' }),
    prpList: arrayNode(PrpEntry, { label: 'PRP 列表', count: PRP_DEPTH, stride: 8 }),
    prpEntry: structNode(PrpEntry, { label: 'PRP 表项' }),
    data: structNode(DataBlock, { label: '数据页' }),
    opcode: calcNode({
      label: 'NVMe 操作码',
      inputs: { value: 'number' },
      outputs: { name: 'string', known: 'boolean' },
      run: ({ value }) => {
        const names: Record<number, string> = { 0: 'Flush', 1: 'Write', 2: 'Read', 4: 'Write Uncorrectable', 6: 'Identify',
          8: 'Abort', 9: 'Set Features', 10: 'Get Features' };
        const name = names[Number(value)];
        return { name: name ?? `未知操作码 (${value})`, known: name !== undefined };
      },
    }),
    prp: calcNode({
      label: 'PRP / 分散页',
      description: '展开本示例中的单页 PRP 列表（不含连锁列表）',
      inputs: { prp1: 'number', prp2: 'number', count: 'number' },
      outputs: { pages: 'number', p0: 'number', p1: 'number', p2: 'number', p3: 'number', list: 'string' },
      run: ({ prp1, prp2, count }, ctx) => {
        const n = Number(count);
        if (!Number.isSafeInteger(n) || n < 0 || n > PRP_DEPTH + 1) {
          throw new Error(`本示例只支持 0–${PRP_DEPTH + 1} 个 PRP 数据页`);
        }
        const pages: number[] = [];
        if (n >= 1) pages.push(Number(prp1));
        if (n === 2) pages.push(Number(prp2));
        for (let i = 0; n > 2 && i < n - 1; i++) {
          pages.push(Number(ctx.read(PrpEntry, Number(prp2) + i * PrpEntry.size).value.addr));
        }
        return {
          pages: pages.length,
          p0: pages[0], p1: pages[1], p2: pages[2], p3: pages[3],
          list: pages.map((addr) => `0x${addr.toString(16)}`).join('  '),
        };
      },
    }),
    transfer: calcNode({
      label: '传输长度 / 页数',
      inputs: { nlb: 'number', lbaSize: 'number' },
      outputs: { bytes: 'number', pages: 'number' },
      run: ({ nlb, lbaSize }) => {
        const size = Number(lbaSize) || LBA_SIZE;
        const bytes = (Number(nlb) + 1) * size;
        return { bytes, pages: Math.ceil(bytes / LBA_SIZE) };
      },
    }),
  },
});
