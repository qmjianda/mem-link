/** Generate small, self-contained blueprints for the no-pack workflows. */
import { writeFileSync } from 'node:fs';

const node = (id, nodeId, x, y, params = {}) => ({ id, packId: '', nodeId, x, y, params });
const file = (name, base, bytes) => ({
  ...node('f', 'file', 0, 70, { name }), source: { name, base, data: Buffer.from(bytes).toString('base64') },
});
const edge = (id, node, port, to, input) => ({ id, from: { node, port }, to: { node: to, port: input } });
const field = (id, name, byteOffset, kind, role) => ({ id, name, offset: String(byteOffset), kind, ...(role ? { role } : {}) });
const layout = (id, name, bytes, fields) => ({ id, name, size: String(bytes), endian: 'little', fields, nextField: fields.length + 1 });
const save = (name, nodes, edges, layouts) => {
  const doc = { format: 'memlink-blueprint/2', packs: [], layouts, nodes, edges };
  writeFileSync(new URL(`../samples/${name}.blueprint.json`, import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
};

const records = [1, 0, 10, 0, 2, 0, 20, 0];
let crc = -1;
for (const byte of records) {
  crc ^= byte;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
}
const bytes = new Uint8Array([8, 0, 2, 0xa7, 0, 0, 0, 0, ...records]);
new DataView(bytes.buffer).setUint32(4, (~crc) >>> 0, true);

save('header-array', [
  file('header-array.bin', '0x1000', bytes),
  node('header', 'structread', 330, 0, { address: '0x1000', layoutId: 'header' }),
  node('offset', 'address', 670, 0),
  node('array', 'arrayread', 1020, 0, { elementType: 'record', layoutId: 'entry' }),
  node('item', 'item', 1370, 0, { index: '1' }),
  node('range', 'slice', 1020, 300, { length: '8' }),
  node('checksum', 'checksum', 1370, 300, { algorithm: 'crc32' }),
  node('checksumOk', 'assert', 1710, 300),
  node('magicOk', 'assert', 670, 260, { expected: '0xa7' }),
], [
  edge('e1', 'f', 'base', 'header', 'address'),
  edge('e2', 'header', 'field:header:f1', 'offset', 'offset'),
  edge('e3', 'offset', 'address', 'array', 'address'),
  edge('e4', 'header', 'field:header:f2', 'array', 'count'),
  edge('e5', 'array', 'list', 'item', 'list'),
  edge('e6', 'offset', 'address', 'range', 'address'),
  edge('e7', 'range', 'span', 'checksum', 'span'),
  edge('e8', 'checksum', 'value', 'checksumOk', 'actual'),
  edge('e9', 'header', 'field:header:f4', 'checksumOk', 'expected'),
  edge('e10', 'header', 'field:header:f3', 'magicOk', 'actual'),
], [
  layout('header', '表头', 8, [
    field('f1', 'tableOffset', 0, 'u16', 'offset'), field('f2', 'count', 2, 'u8'),
    field('f3', 'magic', 3, 'u8'), field('f4', 'crc32', 4, 'u32'),
  ]),
  layout('entry', '表项', 4, [field('f1', 'id', 0, 'u16'), field('f2', 'value', 2, 'u16')]),
]);

save('pool-list', [
  file('pool-list.bin', '0x2000', [0xff, 0xff, 10, 0, 0, 0, 20, 0, 1, 0, 30, 0]),
  node('head', 'address', 330, 70, { mode: 'index', index: '2', stride: '4' }),
  node('list', 'listread', 670, 70, { layoutId: 'entry', nextField: 'f1', mode: 'index', stopValue: '-1', limit: '8' }),
  node('last', 'item', 1010, 70, { index: '2' }),
], [
  edge('e1', 'f', 'base', 'head', 'base'),
  edge('e2', 'head', 'address', 'list', 'address'),
  edge('e3', 'list', 'list', 'last', 'list'),
], [
  layout('entry', '池记录', 4, [field('f1', 'next', 0, 'i16', 'index'), field('f2', 'value', 2, 'u16')]),
]);
