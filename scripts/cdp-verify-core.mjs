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

  // 节点卡默认只展示前 4 个元素端口；展开后检查完整 8 项。
  await evaluate(`document.querySelector('[data-node-id="${arrayId}"] .bp-expand')?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await sleep(200);
  const arrayRows = await evaluate(`document.querySelector('[data-node-id="${arrayId}"]')?.querySelectorAll('.bp-element-row').length ?? 0`);
  check('0x100 解析出 8 个 Entry', arrayRows === 8, `${arrayRows} 行`);

  await click(`[data-node-id="${arrayId}"] .bp-element-row`);
  await sleep(320);
  const fields = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.bp-ft .ft-row')].map((tr) => ({
      name: tr.querySelector('.ft-name')?.textContent,
      val: tr.querySelector('.ft-val')?.textContent,
    }));
    return rows;
  })()`);
  const nameRow = fields.find((f) => f.name === 'name');
  check('检查器列出 Entry 字段', fields.length >= 6, fields.map((f) => f.name).join(','));
  check('Entry#0 的 name = free-0', String(nameRow?.val).replace(/^"|"$/g, '') === 'free-0', JSON.stringify(nameRow));

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
  check('链表从 0x130 走完 4 项（2→5→1→7）', listInfo?.rows === 4, JSON.stringify(listInfo?.rows));
  check('链表求值无节点错误', listInfo?.badge === false, String(listInfo?.badge));

  /* --------------------------------------- 5. 从 next 字段跟随到下一元素地址 */
  await click(`[data-node-id="${listId}"] .bp-element-row`);
  await sleep(320);
  const nextRow = await evaluate(`(() => {
    const tr = [...document.querySelectorAll('.bp-ft .ft-row')].find(r => r.querySelector('.ft-name')?.textContent === 'next');
    if (!tr) return null;
    const b = tr.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  check('链表首元素可展开 next 字段', !!nextRow, JSON.stringify(nextRow));
  // 先点一下行把高亮钉住：工具条在悬停时插入，鼠标移开行就会消失。
  await mouse('mousePressed', nextRow.x, nextRow.y);
  await mouse('mouseReleased', nextRow.x, nextRow.y);
  await sleep(220);
  const followBtn = await rect('.bp-ft-btn.go');
  check('next 字段出现「在此解析」按钮', !!followBtn);
  const btnTitle = await evaluate(`document.querySelector('.bp-ft-btn.go')?.getAttribute('title') ?? ''`);
  check('按钮按转换后的地址 0x178 跟随', /0x178/.test(btnTitle), String(btnTitle));
  await mouse('mousePressed', followBtn.x, followBtn.y);
  await mouse('mouseReleased', followBtn.x, followBtn.y);
  await sleep(400);
  const overlay = await evaluate(`(() => {
    const el = document.querySelector('.bp-follow');
    return el ? { head: el.querySelector('.bp-follow-head b')?.textContent,
      smart: el.querySelector('.bp-follow-smart')?.textContent } : null;
  })()`);
  check('跟随浮层指向 0x178', overlay?.head === '0x178', JSON.stringify(overlay));
  const beforeNodes = await evaluate(`document.querySelectorAll('.bp-node').length`);
  await chord('Enter', 'Enter', 13);
  await sleep(450);
  const created = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.bp-node')];
    const el = nodes.at(-1);
    return {
      count: nodes.length,
      id: el?.dataset.nodeId,
      kind: el?.dataset.nodeKind,
      title: el?.querySelector('.bp-node-title')?.textContent,
      text: el?.textContent ?? '',
    };
  })()`);
  check('Enter 在 0x178 新建元素解析节点',
    created?.count === beforeNodes + 1 && created.kind === 'element', JSON.stringify(created));
  check('新节点标题为「元素 · Entry」', created?.title === '元素 · Entry', String(created?.title));
  await click(`[data-node-id="${created?.id}"] .bp-node-head`);
  await sleep(320);
  const addrText = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bp-inspector .bp-kv')]
      .find((r) => r.querySelector('span')?.textContent === '地址');
    return row?.querySelector('b')?.textContent ?? '';
  })()`);
  check('新节点地址为 0x178', addrText === '0x178', String(addrText));

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
