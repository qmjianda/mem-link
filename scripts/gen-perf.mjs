#!/usr/bin/env node
/**
 * 生成性能基准图 samples/perf.big.blueprint.json
 *
 * 结构：1 个 File 节点（256KB buffer，供默认数据源回退）+ 200 个 pack 节点
 * （20 列 × 10 行，header / meta / entryArray 轮转）+ 370 条连线。
 * 用法：node scripts/gen-perf.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const COLS = 20;
const ROWS = 10;
const STEP_X = 340;
const STEP_Y = 260;

const source = readFileSync(resolve(root, 'samples/demo.bp.ts'), 'utf8');

// 256KB 的缓冲区：足够所有节点在 0x0 附近解码，同时不把仓库撑大
const bufferBytes = 256 * 1024;
const data = Buffer.alloc(bufferBytes);
for (let i = 0; i < bufferBytes; i += 1) data[i] = i & 0xff;

const nodeKinds = [
  { nodeId: 'header', out: 'head' },
  { nodeId: 'meta', out: 'mode' },
  { nodeId: 'entryArray', out: 'count' },
];

const nodes = [{
  id: 'n_file',
  packId: '',
  nodeId: 'file',
  x: -360,
  y: 0,
  params: { name: 'perf.bin' },
  source: { name: 'perf.bin', base: 0, data: data.toString('base64') },
}];

const edges = [];
const idOf = (r, c) => `n${r}_${c}`;

for (let r = 0; r < ROWS; r += 1) {
  for (let c = 0; c < COLS; c += 1) {
    const kind = nodeKinds[(r * COLS + c) % nodeKinds.length];
    nodes.push({
      id: idOf(r, c),
      packId: 'p1',
      nodeId: kind.nodeId,
      x: c * STEP_X,
      y: r * STEP_Y,
      params: { address: '0x0' },
    });
  }
}

let edgeSeq = 0;
const pushEdge = (fromNode, fromPort, toNode, toPort) => {
  edgeSeq += 1;
  edges.push({
    id: `e${edgeSeq}`,
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  });
};

for (let r = 0; r < ROWS; r += 1) {
  for (let c = 0; c < COLS; c += 1) {
    const kind = nodeKinds[(r * COLS + c) % nodeKinds.length];
    if (c + 1 < COLS) pushEdge(idOf(r, c), kind.out, idOf(r, c + 1), 'address');
    if (r + 1 < ROWS) pushEdge(idOf(r, c), kind.out, idOf(r + 1, c), 'address');
  }
}

// 3 条数据源连线：让继承链与直连都存在
pushEdge('n_file', 'buffer', idOf(0, 0), 'buffer');
pushEdge('n_file', 'buffer', idOf(0, 1), 'buffer');
pushEdge('n_file', 'buffer', idOf(0, 2), 'buffer');

const doc = {
  format: 'memlink-blueprint/2',
  packs: [{ id: 'p1', name: 'demo-index-list', source, enabled: true }],
  nodes,
  edges,
};

const out = resolve(root, 'samples/perf.big.blueprint.json');
writeFileSync(out, `${JSON.stringify(doc)}\n`);
const bytes = readFileSync(out).length;
console.log(`wrote ${out}`);
console.log(`nodes=${nodes.length} edges=${edges.length} size=${(bytes / 1024).toFixed(0)}KB`);
