/**
 * 结构树截断回归：用 5000 项数组验证图上的 4096 截断入口，
 * 点击「⤢ 全部」后会把树直接定位到第 4096 项，而不是停在第一页。
 * 用法：node scripts/cdp-verify-tree-truncation.mjs（需先 build）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './cdp-chrome.mjs';

const CHROME = chromePath();
const PORT = 9352;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const profile = mkdtempSync(join(tmpdir(), 'memlink-tree-truncation-'));

function makeFixture() {
  const sourceDoc = JSON.parse(readFileSync(resolve(root, 'samples/demo.blueprint.json'), 'utf8'));
  const source = sourceDoc.packs[0].source.replace('count: 8, stride: 24', 'count: 5000, stride: 24');
  if (source === sourceDoc.packs[0].source) throw new Error('demo pack 的数组声明格式已变化');

  // 5000 * 24 B 的 Entry，再留出地址 0x100 前的空间；全零内容足够验证分页与定位。
  const bytes = Buffer.alloc(0x20000);
  return {
    version: 1,
    savedAt: Date.now(),
    packs: [{ ...sourceDoc.packs[0], source, enabled: true }],
    nodes: [
      {
        id: 'n_file', packId: '', nodeId: 'file', x: -320, y: 0,
        params: { name: 'large.bin' },
        source: { name: 'large.bin', base: 0, data: bytes.toString('base64') },
      },
      { id: 'n_array', packId: 'p1', nodeId: 'entryArray', x: 180, y: 0, params: { address: '0x100' } },
    ],
    edges: [{ id: 'e1', from: { node: 'n_file', port: 'buffer' }, to: { node: 'n_array', port: 'buffer' } }],
  };
}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--no-first-run', '--disable-gpu',
  '--no-default-browser-check', '--window-size=1600,1000', '--force-device-scale-factor=1', url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* Chrome 还在启动 */ }
    await sleep(200);
  }
  throw new Error('Chrome debugging endpoint did not come up');
}

let ws;
let seq = 0;
const waiting = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !waiting.has(m.id)) return;
    const { res, rej } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  };
  await send('Runtime.enable');
  await send('Page.enable');

  const fixture = makeFixture();
  await evaluate(`localStorage.setItem('memlink:graph:v1', ${JSON.stringify(JSON.stringify(fixture))})`);
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelectorAll('.bp-node').length === 2`)) break;
    await sleep(150);
  }
  await sleep(500);

  const arrayTitle = await evaluate(`([...document.querySelectorAll('.bp-node-title')].find((el) => el.textContent?.includes('Entry 数组'))?.textContent ?? '')`);
  check('加载 5000 项数组 fixture', arrayTitle.includes('Entry 数组'), arrayTitle || '未找到数组节点');

  const footer = await evaluate(`!!document.querySelector('.bp-node-foot-link')`);
  check('图上显示结构树入口', footer);
  await evaluate(`document.querySelector('.bp-node-foot-link')?.click()`);
  await sleep(900);

  check('footer 打开结构树', await evaluate(`!!document.querySelector('.bp-tree-overlay:not(.hidden)')`));
  const focused = await evaluate(`document.querySelector('.bp-tree-row.on .bp-tree-name')?.textContent.trim() ?? ''`);
  const scrollTop = await evaluate(`document.querySelector('.bp-tree-body')?.scrollTop ?? 0`);
  check('进入结构树后定位到第 4096 项', focused.includes('[4096]'), focused);
  check('定位目标不在第一页', scrollTop > 1000, String(scrollTop));
  check('截断定位提示保留', (await evaluate(`document.querySelector('.bp-tree-notice')?.textContent ?? ''`)).includes('第 4096 项'));
  await evaluate(`document.querySelector('.bp-tree-row.on [aria-label="生成解析节点"]')?.click()`);
  await sleep(950);
  check('截断后的元素没有画布地址端口，生成节点连到原文件',
    await evaluate(`(() => {
      const doc = JSON.parse(localStorage.getItem('memlink:graph:v1'));
      const edge = doc?.edges.at(-1);
      const node = doc?.nodes.at(-1);
      return node?.nodeId === 'element' && node.params.address === '0x18100'
        && edge?.from.node === 'n_file' && edge.from.port === 'buffer'
        && edge.to.node === node.id && edge.to.port === 'buffer'
        && !!document.querySelector('.bp-tree-notice')?.textContent.includes('已在图上生成');
    })()`));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { ws?.close(); chrome.kill(); });
