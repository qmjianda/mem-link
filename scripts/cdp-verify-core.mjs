/**
 * 核心链路验收：真实 Chrome 走一遍 bin → 结构体 → 链表 → 跟随地址。
 * 用法：node scripts/cdp-verify-core.mjs（需先 build）
 *
 * 与 cdp-verify.mjs 的区别：那份跑的是预置 NVMe 图，这份从空画布开始，
 * 用仓库里的 samples/demo.bin 与 samples/demo.bp.ts 真实拖放。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './cdp-chrome.mjs';

const CHROME = chromePath();
const PORT = 9335;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const profile = mkdtempSync(join(tmpdir(), 'memlink-core-'));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--no-first-run', '--disable-gpu',
  '--no-default-browser-check', '--window-size=1600,1000', url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* Chrome is still starting */ }
    await sleep(200);
  }
  throw new Error('Chrome debugging endpoint did not come up');
}

let ws;
let seq = 0;
const waiting = new Map();
const events = [];

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: extra.button ?? 'left',
  buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1),
  clickCount: type === 'mouseWheel' ? 0 : 1, ...extra,
});

const key = (type, k, code, vk, modifiers = 0, text) => send('Input.dispatchKeyEvent', {
  type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  ...(text && type === 'keyDown' ? { text } : {}),
});

async function chord(k, code, vk, modifiers = 0, text) {
  await key('keyDown', k, code, vk, modifiers, text);
  await key('keyUp', k, code, vk, modifiers);
}

async function rect(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
}

async function click(selector) {
  const r = await rect(selector);
  if (!r) return false;
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  return true;
}

async function main() {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) events.push(m);
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // 文件名含中文/空格都不涉及；这里只需要 File/DataTransfer，页面已具备。

  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.bp-app')`)) break;
    await sleep(150);
  }
  await sleep(300);

  /* ---------------------------------------------------------- 0. 清空画布 */
  await chord('a', 'KeyA', 65, 2); // Mod+A
  await sleep(150);
  await chord('Delete', 'Delete', 46);
  await sleep(300);
  const empty = await evaluate(`({ nodes: document.querySelectorAll('.bp-node').length,
    hint: document.querySelector('.bp-empty')?.textContent ?? '' })`);
  check('画布清空后无节点', empty.nodes === 0, JSON.stringify(empty.nodes));

  /* ------------------------------------------------- 1. 拖入 samples/demo.bin */
  const binB64 = readFileSync(join(root, 'samples/demo.bin')).toString('base64');
  const packB64 = readFileSync(join(root, 'samples/demo.bp.ts')).toString('base64');
  const dropFile = async (b64, name, x, y) => evaluate(`(() => {
    const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], ${JSON.stringify(name)}));
    window.dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt, bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},
    }));
    return true;
  })()`);

  await dropFile(binB64, 'demo.bin', 900, 420);
  await sleep(700);
  const fileNode = await evaluate(`(() => {
    const el = document.querySelector('.bp-node[data-node-kind="file"]');
    if (!el) return null;
    return { text: el.textContent, title: el.querySelector('.bp-node-title')?.textContent };
  })()`);
  check('拖入 demo.bin 生成 File 节点', !!fileNode && /demo\.bin/.test(fileNode.text),
    JSON.stringify(fileNode?.title));
  check('File 节点显示 512 B', !!fileNode && /512/.test(fileNode.text), String(fileNode?.text).slice(0, 80));

  /* ---------------------------------------------- 2. 拖入 samples/demo.bp.ts */
  await dropFile(packB64, 'demo.bp.ts', 900, 420);
  await sleep(900);
  const packUi = await evaluate(`({
    groups: [...document.querySelectorAll('.bp-group-title')].map(e => e.textContent),
    items: [...document.querySelectorAll('.bp-pal-item')].map(e => e.textContent),
  })`);
  check('拖入 demo.bp.ts 后节点库出现该 pack',
    packUi.groups.some((g) => g.includes('demo-index-list')), packUi.groups.join(' / '));
  check('pack 节点清单含 Entry 数组 / Entry 链表',
    packUi.items.some((t) => t.includes('Entry 数组')) && packUi.items.some((t) => t.includes('Entry 链表')),
    packUi.items.filter((t) => t.includes('Entry')).join(' | '));

  /* --------------------------------- 3. 在 0x100 解析 Entry（数组节点，8 项） */
  const addFromPalette = async (label) => {
    const r = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.bp-pal-item')].find(b => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!r) return '';
    await mouse('mousePressed', r.x, r.y);
    await mouse('mouseReleased', r.x, r.y);
    await sleep(420);
    return evaluate(`[...document.querySelectorAll('.bp-node')].at(-1)?.dataset.nodeId ?? ''`);
  };

  const connectSource = async (nodeId) => {
    const from = await evaluate(`(() => {
      const el = document.querySelector('.bp-node[data-node-kind="file"] [data-port="buffer"][data-side="out"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const to = await evaluate(`(() => {
      const el = document.querySelector('[data-node-id="${nodeId}"] [data-port="buffer"][data-side="in"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!from || !to) return false;
    await mouse('mousePressed', from.x, from.y);
    await mouse('mouseMoved', from.x + 20, from.y + 20);
    await sleep(80);
    await mouse('mouseMoved', to.x, to.y);
    await sleep(150);
    await mouse('mouseReleased', to.x, to.y);
    await sleep(320);
    return true;
  };

  const connectPorts = async (fromNode, fromPort, toNode, toPort) => {
    const from = await evaluate(`(() => {
      const el = document.querySelector('[data-node-id="${fromNode}"] [data-port="${fromPort}"][data-side="out"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const to = await evaluate(`(() => {
      const el = document.querySelector('[data-node-id="${toNode}"] [data-port="${toPort}"][data-side="in"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!from || !to) return false;
    await mouse('mousePressed', from.x, from.y);
    await mouse('mouseMoved', from.x + 20, from.y + 20);
    await sleep(80);
    await mouse('mouseMoved', to.x, to.y);
    await sleep(150);
    await mouse('mouseReleased', to.x, to.y);
    await sleep(450);
    return true;
  };

  const setParam = async (label, value) => evaluate(`(() => {
    const row = [...document.querySelectorAll('label.bp-param')]
      .find((l) => l.querySelector('span')?.textContent === ${JSON.stringify(label)});
    const el = row?.querySelector('input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  const arrayId = await addFromPalette('Entry 数组');
  check('从节点库添加 Entry 数组', !!arrayId, String(arrayId));
  const wired = await connectSource(arrayId);
  check('File 缓冲连线到数组节点', wired);
  const addrSet = await setParam('地址', '0x100');
  check('设置地址 0x100', addrSet);
  await sleep(500);

  const arrayInfo = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="${arrayId}"]');
    return { rows: el?.querySelectorAll('.bp-element-row').length ?? 0, text: el?.textContent ?? '' };
  })()`);
  check('数组节点不铺元素行，只显示集合数量',
    arrayInfo.rows === 0 && /共 8 项/.test(arrayInfo.text), `${arrayInfo.rows} 行`);

  await click(`[data-node-id="${arrayId}"] .bp-node-foot-link`);
  await sleep(400);
  const treeRows = await evaluate(`document.querySelectorAll('.bp-tree-row').length`);
  check('结构树打开并显示数组内容', treeRows >= 8, `${treeRows} 行`);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bp-tree-row')]
      .find((r) => r.querySelector('.bp-tree-name')?.textContent.includes('[0]'));
    row?.querySelector('.bp-tree-chev')?.click();
  })()`);
  await sleep(300);
  const treeText = await evaluate(`document.querySelector('.bp-tree')?.innerText ?? ''`);
  check('结构树展开 Entry#0 显示 free-0', treeText.includes('free-0'), treeText.slice(0, 140));
  await click('button[aria-label="关闭结构视图"]');
  await sleep(200);

  /* ------------------------------------ 4. 沿 next 走完整条链（4 项，0x130 起） */
  const listId = await addFromPalette('Entry 链表');
  check('从节点库添加 Entry 链表', !!listId, String(listId));
  await connectSource(listId);
  await setParam('地址', '0x130');
  await sleep(600);
  const listInfo = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="${listId}"]');
    if (!el) return null;
    return {
      rows: el.querySelectorAll('.bp-element-row').length,
      text: el.textContent,
      badge: !!el.querySelector('.bp-node-badge'),
    };
  })()`);
  check('链表节点不铺元素行，只显示集合数量',
    listInfo?.rows === 0 && /共 4 项/.test(listInfo?.text ?? ''), JSON.stringify(listInfo?.rows));
  check('链表求值无节点错误', listInfo?.badge === false, String(listInfo?.badge));

  /* ------------------------------------------------------- 6. 控制台无错误 */
  const bad = events.filter((e) => e.method === 'Log.entryAdded'
    && ['error'].includes(e.params?.entry?.level));
  const thrown = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('无控制台错误 / 未捕获异常', bad.length === 0 && thrown.length === 0,
    JSON.stringify([...bad, ...thrown].slice(0, 2)).slice(0, 300));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? 'FAILED' : 'OK'}  ${results.length - failed.length}/${results.length}`);
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  chrome.kill();
  process.exit(1);
});
