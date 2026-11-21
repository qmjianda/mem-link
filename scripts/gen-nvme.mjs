/**
 * Generates the NVMe Submission Queue demo assets from one deterministic
 * description. Run with `node scripts/gen-nvme.mjs`.
 *
 *   samples/nvme-sq.bin               raw image, base address 0x1000
 *   samples/nvme-sq.blueprint.json    blueprint document (pack + graph + buffer)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 0x1000;
const PAGE = 0x200;
const SQE_SIZE = 64;
const FILE_NAME = 'nvme-sq.bin';
const buf = new Uint8Array(0x1000);

function putU32(off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}
function putU64(off, v) {
  putU32(off, v >>> 0);
  putU32(off + 4, Math.floor(v / 0x100000000));
}
function putStr(off, text) {
  for (let i = 0; i < text.length; i++) buf[off + i] = text.charCodeAt(i) & 0xff;
}
function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/* -------------------------------------------------- submission queue entries */
function writeSqe(rel, o) {
  putU32(rel + 0, (o.opc & 0xff) | ((o.cid & 0xffff) << 16));
  putU32(rel + 4, o.nsid >>> 0);
  putU32(rel + 8, 0);
  putU32(rel + 12, 0);
  putU64(rel + 16, o.mptr ?? 0);
  putU64(rel + 24, o.prp1 ?? 0);
  putU64(rel + 32, o.prp2 ?? 0);
  putU32(rel + 40, o.cdw10 ?? 0);
  putU32(rel + 44, o.cdw11 ?? 0);
  putU32(rel + 48, o.cdw12 ?? 0);
  putU32(rel + 52, o.cdw13 ?? 0);
  putU32(rel + 56, o.cdw14 ?? 0);
  putU32(rel + 60, o.cdw15 ?? 0);
}

const PRP1 = BASE + 0x200;   // 0x1200 first data page
const PRP2 = BASE + 0x100;   // 0x1100 PRP list page
const dataPages = Array.from({ length: 6 }, (_, i) => BASE + 0x200 + i * PAGE);

writeSqe(0x000, {
  opc: 0x02, cid: 1, nsid: 1,             // Read, CID 1, NSID 1
  prp1: PRP1, prp2: PRP2,
  cdw10: 0x00000000, cdw11: 0,            // SLBA 0
  cdw12: 0x00000005,                      // NLB = 5 → 6 blocks → 6 pages
});
writeSqe(0x040, {
  opc: 0x01, cid: 2, nsid: 1,             // Write
  prp1: PRP1, cdw10: 0x20, cdw12: 0,      // SLBA 32, 1 block
});
writeSqe(0x080, {
  opc: 0x06, cid: 3, nsid: 0,             // Identify
  prp1: BASE + 0xe00, cdw10: 0x00000001,  // CNS = 1
});
writeSqe(0x0c0, {
  opc: 0x00, cid: 4, nsid: 0xffffffff,    // Flush
});

/* ------------------------------------------------------------- PRP list page */
dataPages.slice(1).forEach((addr, i) => putU64(0x100 + i * 8, addr));

/* ---------------------------------------------------------------- data pages */
dataPages.forEach((addr, i) => {
  const rel = addr - BASE;
  const payload = `NVMe READ DATA | LBA ${i} | block ${i + 1}/6 | PRP 0x${addr.toString(16)}`;
  putU32(rel + 0, 0x454d564e);             // "NVME"
  putU32(rel + 4, i);
  putU32(rel + 8, 0x1000 + i);
  putStr(rel + 16, payload);
  const bytes = buf.subarray(rel + 16, rel + PAGE);
  putU32(rel + 12, crc32(bytes));
});

// Identify controller data
putStr(0xe00, 'NVMe Identify Controller | VID 0x8086 | SN MLNK-0001 | MN mem-link NVMe demo');

const base64 = Buffer.from(buf).toString('base64');
writeFileSync(resolve(root, 'samples/nvme-sq.bin'), buf);

/* ------------------------------------------------------------- blueprint doc */
const packSource = readFileSync(resolve(root, 'samples/nvme-sq.bp.ts'), 'utf8');
const node = (id, packId, nodeId, x, y, params, source) => {
  const n = { id, packId, nodeId, x, y, params };
  if (source) n.source = source;
  return n;
};
const edge = (id, from, fromPort, to, toPort) => ({
  id, from: { node: from, port: fromPort }, to: { node: to, port: toPort },
});

const doc = {
  format: 'memlink-blueprint/3',
  packs: [{ id: 'p1', name: 'nvme-sq', source: packSource }],
  nodes: [
    node('n_file', '', 'file', 0, 40, { name: FILE_NAME },
      { name: FILE_NAME, base: BASE, data: base64 }),
    node('n_sq', 'p1', 'sq', 330, 0, { address: '0x1000' }),
    node('n_sqe', '', 'element', 660, 0, { index: '0', packId: 'p1', typeId: 'Sqe' }),
    node('n_opc', 'p1', 'opcode', 1000, 0, { value: '0' }),
    node('n_transfer', 'p1', 'transfer', 1000, 190, { nlb: '0', lbaSize: '512' }),
    node('n_prp', 'p1', 'prp', 1000, 380, { prp1: '0x0', prp2: '0x0', count: '1' }),
    node('n_prpList', 'p1', 'prpList', 660, 660, { address: '0x0' }),
    node('n_prp0', '', 'element', 1000, 660, { index: '0', packId: 'p1', typeId: 'PrpEntry' }),
    node('n_data1', 'p1', 'data', 1340, 0, { address: '0x0' }),
    node('n_data2', 'p1', 'data', 1340, 340, { address: '0x0' }),
    node('n_dump', '', 'slice', 1340, 660, { address: '0x0', length: '64' }),
    node('n_sum', '', 'checksum', 1680, 0, { algorithm: 'crc32' }),
  ],
  edges: [
    edge('e1', 'n_file', 'buffer', 'n_sq', 'buffer'),
    edge('e2', 'n_sq', 'elem:0', 'n_sqe', 'instance'),
    edge('e3', 'n_sqe', 'opc', 'n_opc', 'value'),
    edge('e4', 'n_sqe', 'nlb', 'n_transfer', 'nlb'),
    edge('e5', 'n_transfer', 'pages', 'n_prp', 'count'),
    edge('e6', 'n_sqe', 'prp1', 'n_prp', 'prp1'),
    edge('e7', 'n_sqe', 'prp2', 'n_prp', 'prp2'),
    edge('e8', 'n_sqe', 'prp2', 'n_prpList', 'address'),
    edge('e9', 'n_prpList', 'elem:0', 'n_prp0', 'instance'),
    edge('e10', 'n_sqe', 'prp1', 'n_data1', 'address'),
    edge('e11', 'n_prp0', 'addr', 'n_data2', 'address'),
    edge('e12', 'n_sqe', 'prp1', 'n_dump', 'address'),
    edge('e13', 'n_dump', 'span', 'n_sum', 'span'),
  ],
};
writeFileSync(resolve(root, 'samples/nvme-sq.blueprint.json'), `${JSON.stringify(doc, null, 2)}\n`);

console.log(`nvme-sq.bin            ${buf.length} B, base 0x${BASE.toString(16)}`);
console.log(`nvme-sq.blueprint.json ${doc.nodes.length} nodes / ${doc.edges.length} edges`);
