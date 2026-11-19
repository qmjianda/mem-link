/**
 * 新增解析节点的上下文默认值回归：唯一文件基址为 0x1000 时，
 * 从节点库添加 pack 链表节点，地址输入应直接使用 0x1000。
 * 用法：node scripts/cdp-verify-add-defaults.mjs（需先 build）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './cdp-chrome.mjs';

const CHROME = chromePath();
const PORT = 9353;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const profile = mkdtempSync(join(tmpdir(), 'memlink-add-defaults-'));

function fixture() {
  const sample = JSON.parse(readFileSync(resolve(root, 'samples/demo.blueprint.json'), 'utf8'));
  const bytes = Buffer.alloc(0x400);
  return {
    version: 2,
    savedAt: Date.now(),
    packs: sample.packs.map((p) => ({ ...p, enabled: true })),
    nodes: [{
      id: 'n_file', packId: '', nodeId: 'file', x: -280, y: 0,
      params: { name: 'base-1000.bin' },
      source: { name: 'base-1000.bin', base: 0x1000, data: bytes.toString('base64') },
    }],
    edges: [],
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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left',
  buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});

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

  const doc = fixture();
  await evaluate(`localStorage.setItem('memlink:graph:v2', ${JSON.stringify(JSON.stringify(doc))})`);
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelectorAll('.bp-node').length === 1`)) break;
    await sleep(150);
  }
  await sleep(500);

  const item = await evaluate(`(() => {
    let el = [...document.querySelectorAll('.bp-pal-item')].find((b) => b.textContent?.includes('Entry 链表'));
    if (!el) {
      const group = [...document.querySelectorAll('.bp-group-btn')].find((b) => b.textContent?.includes('demo-index-list'));
      group?.click();
      el = [...document.querySelectorAll('.bp-pal-item')].find((b) => b.textContent?.includes('Entry 链表'));
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('节点库显示 Entry 链表', !!item, JSON.stringify(item));
  if (item) {
    await mouse('mousePressed', item.x, item.y);
    await mouse('mouseReleased', item.x, item.y);
    await sleep(500);
  }

  const address = await evaluate(`([...document.querySelectorAll('.bp-inspector label.bp-param')]
    .find((l) => l.querySelector('span')?.textContent === '地址')?.querySelector('input')?.value ?? '')`);
  check('新增链表节点继承唯一文件基址', address === '0x1000', address || '未找到地址输入');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { ws?.close(); chrome.kill(); });
