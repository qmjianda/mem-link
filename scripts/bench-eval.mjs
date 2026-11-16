#!/usr/bin/env node
/**
 * 求值基准：同一份示例 pack，按 50 / 200 / 800 节点三档生成图，
 * 每档跑 20 次，输出 p50 / p95。用于判断后续改动有没有变慢。
 *
 *   node scripts/bench-eval.mjs           # 打印表格
 *   node scripts/bench-eval.mjs --write   # 同时写入 docs/perf-baseline.md
 *
 * 用 esbuild 把 TS 源码打成临时 ESM 再导入，避免为基准引入运行时依赖。
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache', 'bench');
const bundlePath = join(cacheDir, 'eval-bundle.mjs');

const SIZES = [50, 200, 800];
// 20 次时 p95 就是"第二慢的一次"，抖动可达 ±1 ms；50 次让 p50/p95 稳定下来
const RUNS = 50;
const WARMUP = 5;

async function loadEvaluator() {
  mkdirSync(cacheDir, { recursive: true });
  await build({
    stdin: {
      contents: [
        "export { evaluateGraph } from './src/bp/eval.ts';",
        "export { loadBlueprintPack } from './src/bp/load.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'bench-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
}

/** 以 samples/demo.blueprint.json 为模板：每个链 = 头 + 链表 + 元素，共 3 个节点。 */
function buildGraph(sample, targetNodes) {
  const fileNode = sample.nodes.find((n) => n.nodeId === 'file');
  const template = {
    header: sample.nodes.find((n) => n.nodeId === 'header'),
    list: sample.nodes.find((n) => n.nodeId === 'entryList'),
  };
  const chains = Math.max(1, Math.round((targetNodes - 1) / 3));

  const nodes = [{ ...fileNode, id: 'n_file', x: 0, y: 0 }];
  const edges = [];
  for (let i = 0; i < chains; i++) {
    const h = { ...template.header, id: `h${i}`, x: 300, y: i * 120, params: { ...template.header.params } };
    const l = { ...template.list, id: `l${i}`, x: 600, y: i * 120, params: { ...template.list.params } };
    const e = { ...template.header, id: `e${i}`, x: 900, y: i * 120, params: { ...template.header.params, address: '' } };
    nodes.push(h, l, e);
    edges.push(
      { id: `eh${i}`, from: { node: h.id, port: 'head' }, to: { node: l.id, port: 'address' } },
      { id: `el${i}`, from: { node: l.id, port: 'elem:0' }, to: { node: e.id, port: 'address' } },
    );
    if (i === 0) edges.push({ id: 'e_file', from: { node: 'n_file', port: 'buffer' }, to: { node: h.id, port: 'buffer' } });
  }
  return { nodes, edges };
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const sample = JSON.parse(readFileSync(join(root, 'samples', 'demo.blueprint.json'), 'utf8'));
const { evaluateGraph, loadBlueprintPack } = await loadEvaluator();

const loaded = loadBlueprintPack(sample.packs[0].source);
if (!loaded.pack) {
  console.error('示例 pack 加载失败：' + loaded.error);
  process.exit(1);
}
const packs = new Map([[sample.packs[0].id, loaded.pack]]);

const rows = [];
for (const size of SIZES) {
  const { nodes, edges } = buildGraph(sample, size);
  const run = () => {
    const t = performance.now();
    const r = evaluateGraph(nodes, edges, packs, {});
    return { ms: performance.now() - t, problems: r.problems.length };
  };
  for (let i = 0; i < WARMUP; i++) run();
  const times = [];
  let problems = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = run();
    times.push(r.ms);
    problems = r.problems;
  }
  times.sort((a, b) => a - b);
  rows.push({
    size,
    nodes: nodes.length,
    edges: edges.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    min: times[0],
    max: times[times.length - 1],
    problems,
  });
}

const f = (n) => n.toFixed(2).padStart(8);
console.log(`\n求值基准 · ${platform()} ${release()} · node ${process.version} · ${cpus()[0]?.model ?? '?'}`);
console.log(`每档 ${RUNS} 次，预热 ${WARMUP} 次\n`);
console.log('  目标节点   实际节点   边      p50(ms)   p95(ms)   min(ms)   max(ms)   问题数');
for (const r of rows) {
  console.log(
    `${String(r.size).padStart(9)}${String(r.nodes).padStart(11)}${String(r.edges).padStart(7)}` +
    `${f(r.p50)}${f(r.p95)}${f(r.min)}${f(r.max)}${String(r.problems).padStart(9)}`,
  );
}

if (process.argv.includes('--write')) {
  const stamp = new Date().toISOString().slice(0, 10);
  const md = [
    '# 求值基准',
    '',
    `采集于 ${stamp}，命令 \`node scripts/bench-eval.mjs\`。`,
    '',
    `- 环境：${platform()} ${release()} / node ${process.version} / ${cpus()[0]?.model ?? '?'}`,
    `- 负载：\`samples/demo.blueprint.json\` 的 pack 与 File，按 3 节点一条链复制；每档 ${RUNS} 次、预热 ${WARMUP} 次。`,
    '- 口径：`evaluateGraph` 全量求值，含端口、视图、数据源与问题收集。',
    '',
    '| 目标节点 | 实际节点 | 边 | p50 (ms) | p95 (ms) | min | max | 问题数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.size} | ${r.nodes} | ${r.edges} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.min.toFixed(2)} | ${r.max.toFixed(2)} | ${r.problems} |`),
    '',
    '> 本文件由脚本生成。基准用于横向比较同一台机器上的改动前后，不用于跨机器比较绝对值。',
    '',
  ].join('\n');
  writeFileSync(join(root, 'docs', 'perf-baseline.md'), md, 'utf8');
  console.log('\n已写入 docs/perf-baseline.md');
}
