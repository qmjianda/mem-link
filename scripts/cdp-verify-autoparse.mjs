/** Browser acceptance for the one-click ELF parse chain. Run after build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePath } from './cdp-chrome.mjs';

const pageUrl = new URL('../dist/index.html', import.meta.url).href;
const profile = mkdtempSync(join(process.env.OPENCODE_TMPDIR || tmpdir(), 'memlink-autoparse-'));
const chrome = spawn(chromePath(), [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--no-first-run', '--disable-gpu', '--window-size=1600,1000', pageUrl,
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let seq = 0;
const pending = new Map();
const errors = [];

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const deadline = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 12000);
  pending.set(id, { resolve, reject, deadline });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
async function until(check, label) {
  for (let i = 0; i < 70; i++) {
    try { const found = await check(); if (found) return found; } catch (err) { if (i === 69) throw err; }
    await sleep(100);
  }
  throw new Error(`等待失败：${label}`);
}
const ready = (js, label) => until(() => evaluate(js), label);
const button = name => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)});
  if (!el) throw Error('未找到按钮：' + ${JSON.stringify(name)});
  el.click();
})()`);

function sampleElf() {
  const bytes = Buffer.alloc(512);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  bytes.writeBigUInt64LE(64n, 32);   // e_phoff
  bytes.writeBigUInt64LE(320n, 40);  // e_shoff
  bytes.writeUInt16LE(64, 52);       // e_ehsize
  bytes.writeUInt16LE(56, 54);       // e_phentsize
  bytes.writeUInt16LE(2, 56);        // e_phnum
  bytes.writeUInt16LE(64, 58);       // e_shentsize
  bytes.writeUInt16LE(2, 60);        // e_shnum
  bytes.writeUInt32LE(1, 64);        // first program header type = PT_LOAD
  return bytes.toString('base64');
}

try {
  const page = await until(async () => {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find(t => t.type === 'page' && t.url.includes('index.html'));
  }, 'Chrome');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ev => {
    const message = JSON.parse(ev.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.deadline);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await ready(`!!document.querySelector('.bp-app')`, '初始加载');

  const pack = readFileSync(new URL('../store/packs/elf/pack.bp.ts', import.meta.url), 'utf8');
  const graph = {
    version: 3, savedAt: 0,
    packs: [{ id: 'p1', name: 'ELF', source: pack, enabled: true }],
    nodes: [{
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 'mini.elf' },
      source: { name: 'mini.elf', base: '0x0', data: sampleElf() },
    }],
    edges: [], layouts: [],
  };
  await evaluate(`localStorage.setItem('memlink:graph:v3', ${JSON.stringify(JSON.stringify(graph))}); location.reload();`);
  await ready(`!!document.querySelector('[data-node-id="f"]')`, '载入 ELF 示例');
  await evaluate(`document.querySelector('[data-node-id="f"]')?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await ready(`!!document.querySelector('.bp-autoparse-btn')`, '文件检查器显示一键解析');
  await evaluate(`document.querySelector('.bp-autoparse-btn')?.click()`);
  await ready(`document.querySelectorAll('.bp-node').length === 4`, '创建 4 个节点');
  await ready(`document.querySelectorAll('[data-node-id] [data-port]').length > 0 && document.querySelectorAll('.bp-edge').length === 7`, '创建 7 条连线');
  const titles = await evaluate(`[...document.querySelectorAll('.bp-node-title')].map(e => e.textContent)`);
  assert.ok(titles.includes('ELF64 文件头（64 B）'), titles.join(' / '));
  assert.ok(titles.includes('ELF64 程序头表'), titles.join(' / '));
  assert.ok(titles.includes('ELF64 节头表'), titles.join(' / '));
  assert.equal(await evaluate(`document.querySelector('.bp-node.on')?.querySelector('.bp-node-title')?.textContent`), 'ELF64 文件头（64 B）');
  console.log('PASS  一键解析创建文件头、程序头表、节头表与 7 条连线');

  const program = await evaluate(`document.querySelector('[data-node-id="n103"]')?.innerText ?? ''`);
  assert.ok(/文件偏移\s*64/.test(program) && /数量\s*2/.test(program), program.slice(0, 160));
  console.log('PASS  程序头表自动接到 phoff/phnum 并读出 2 项');

  assert.equal(await evaluate(`document.querySelectorAll('.bp-expand').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[data-node-id="n103"] .bp-element-row').length`), 0);
  assert.ok((await evaluate(`document.querySelector('[data-node-id="n103"] .bp-node-foot')?.textContent ?? ''`)).includes('共 2 项'));
  assert.ok(!(await evaluate(`document.querySelector('[data-node-id="n101"]')?.innerText ?? ''`)).includes('ident.magic'));
  await evaluate(`document.querySelector('[data-node-id="n101"] .bp-node-open')?.click()`);
  await ready(`!!document.querySelector('.bp-tree')`, '打开结构树');
  assert.ok((await evaluate(`document.querySelector('.bp-tree')?.innerText ?? ''`)).includes('ident'));
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bp-tree-row')]
      .find((r) => r.querySelector('.bp-tree-name')?.textContent.includes('ident'));
    row?.querySelector('.bp-tree-chev')?.click();
  })()`);
  await ready(`document.querySelector('.bp-tree')?.innerText.includes('魔数')`, '结构树展开 ident');
  console.log('PASS  节点卡只保留字段名，集合/嵌套内容在结构树中查看');

  assert.deepEqual(errors, []);
  console.log('\nOK  autoparse verification passed');
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill();
}
