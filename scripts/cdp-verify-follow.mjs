/**
 * 新功能验收脚本：真实 Chrome 驱动「跟随地址 → 元素解析 / 重命名 / 标注缩放」。
 * 用法：node scripts/cdp-verify-follow.mjs（需先 build）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const profile = mkdtempSync(join(tmpdir(), 'memlink-cdp-'));

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

async function dbl(x, y) {
  await mouse('mousePressed', x, y, { clickCount: 1 });
  await mouse('mouseReleased', x, y, { clickCount: 1 });
  await mouse('mousePressed', x, y, { clickCount: 2 });
  await mouse('mouseReleased', x, y, { clickCount: 2 });
}

async function rect(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
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

  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.bp-app .bp-node')`)) break;
    await sleep(150);
  }
  await sleep(300);

  /* 0. 选中 SQE 节点并适配选中，避免端口落在右栏下面 */
  const head = await rect('[data-node-id="n_sqe"] .bp-node-head');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseReleased', head.x, head.y);
  await chord('f', 'KeyF', 70);
  await sleep(400);

  /* 1. 双击 prp1 端口打开「在此地址解析」 */
  const port = await rect('[data-node-id="n_sqe"] [data-port="prp1"][data-side="out"]');
  check('找到 SQE 的 prp1 端口', !!port, JSON.stringify(port));
  await dbl(port.x, port.y);
  await sleep(250);
  const overlay = await evaluate(`(() => {
    const el = document.querySelector('.bp-follow');
    if (!el) return null;
    return {
      head: el.querySelector('.bp-follow-head b')?.textContent,
      smart: el.querySelector('.bp-follow-smart')?.textContent,
      select: !!el.querySelector('.bp-follow-type'),
      labels: [...el.querySelectorAll('.bp-quick-item .bp-quick-label')].map(e => e.textContent),
      groups: [...el.querySelectorAll('.bp-quick-group')].map(e => e.textContent),
    };
  })()`);
  check('跟随浮层已打开且地址正确', overlay?.head === '0x1200', JSON.stringify(overlay?.head));
  check('类型可推断时置顶元素解析，且不提供手动类型下拉',
    !!overlay?.smart?.includes('元素解析') && overlay.smart.includes('DataBlock')
    && overlay.select === false, JSON.stringify(overlay?.smart));
  const need = ['数值读取', '字符串读取', '数组读取', '指针步进', 'PRP / 分散页', '校验和', '缓冲区切片'];
  check('解析节点清单不再缺项', need.every((t) => overlay.labels.includes(t)),
    `缺 ${need.filter((t) => !overlay.labels.includes(t)).join('、') || '无'}`);
  check('候选按类型分组', ['结构体', '数组', '解析', '数据源', '地址', '校验']
    .every((g) => overlay.groups.includes(g)), overlay.groups.join(' / '));

  /* 2. 默认 Enter = 元素解析（类型自适应），应新建元素节点并连好地址 */
  const before = await evaluate(`document.querySelectorAll('.bp-node').length`);
  await chord('Enter', 'Enter', 13);
  await sleep(350);
  const created = await evaluate(`(() => {
    const el = document.querySelector('.bp-node.on');
    if (!el) return null;
    return {
      count: document.querySelectorAll('.bp-node').length,
      title: el.querySelector('.bp-node-title')?.textContent,
      rows: [...el.querySelectorAll('.bp-in-row .bp-row-label')].map(e => e.textContent),
      outs: [...el.querySelectorAll('.bp-out-row .bp-row-label')].map(e => e.textContent),
      kind: el.dataset.nodeKind,
      addr: el.querySelector('.bp-wired-val')?.textContent,
    };
  })()`);
  check('Enter 直接创建元素解析节点', created?.count === before + 1 && created.kind === 'element',
    JSON.stringify(created));
  check('标题显示实际解码类型', created?.title === '元素 · DataBlock', String(created?.title));
  check('按地址解析时只显示相关输入行', JSON.stringify(created?.rows) === JSON.stringify(['数据源', '地址']),
    JSON.stringify(created?.rows));
  check('字段端口随类型生成', created?.outs?.length >= 3, JSON.stringify(created?.outs));
  check('地址已自动连线', String(created?.addr ?? '').includes('0x1200'), String(created?.addr));

  /* 3. 双击标题就地重命名 */
  const title = await rect('.bp-node.on .bp-node-title');
  await dbl(title.x, title.y);
  await sleep(150);
  const editing = await evaluate(`(() => {
    const el = document.querySelector('.bp-node-rename');
    return el ? { value: el.value === '' , focused: document.activeElement === el } : null;
  })()`);
  check('双击标题进入就地重命名', !!editing && editing.focused, JSON.stringify(editing));
  await send('Input.insertText', { text: 'PRP 页 · 0x1200' });
  await chord('Enter', 'Enter', 13);
  await sleep(250);
  const renamed = await evaluate(`document.querySelector('.bp-node.on .bp-node-title')?.textContent`);
  check('Enter 提交重命名', renamed === 'PRP 页 · 0x1200', String(renamed));

  /* 3b. 从节点库拖入的空元素节点：没有连接时不应显示任何结构体字段 */
  await chord('k', 'KeyK', 75, 2);
  await sleep(160);
  await send('Input.insertText', { text: '元素' });
  await sleep(120);
  await chord('Enter', 'Enter', 13);
  await sleep(350);
  const emptyEl = await evaluate(`(() => {
    const el = document.querySelector('.bp-node.on');
    if (!el) return null;
    return {
      title: el.querySelector('.bp-node-title')?.textContent,
      ins: [...el.querySelectorAll('.bp-in-row .bp-row-label')].map(e => e.textContent),
      outs: el.querySelectorAll('.bp-out-row').length,
      badge: !!el.querySelector('.bp-node-badge'),
    };
  })()`);
  check('空元素节点不显示结构体字段', emptyEl?.title === '元素解析' && emptyEl.outs === 0
    && emptyEl.badge === false
    && JSON.stringify(emptyEl.ins) === JSON.stringify(['数据源', '元素', '列表', '下标']),
  JSON.stringify(emptyEl));
  await chord('Delete', 'Delete', 46);
  await sleep(200);

  /* 3c. 类型不可推断的地址：不出现「元素解析」，也不允许硬猜 */
  await chord('k', 'KeyK', 75, 2);
  await sleep(160);
  await send('Input.insertText', { text: '数值' });
  await sleep(120);
  await chord('Enter', 'Enter', 13);
  await sleep(300);
  await evaluate(`(() => { const el = document.querySelector('.bp-inspector .bp-param input.in'); el.focus(); el.select(); })()`);
  await send('Input.insertText', { text: '0x1300' });
  await sleep(250);
  const numPort = await rect('.bp-node.on [data-port="value"][data-side="out"]');
  await dbl(numPort.x, numPort.y);
  await sleep(250);
  const noHint = await evaluate(`(() => {
    const el = document.querySelector('.bp-follow');
    if (!el) return null;
    return {
      head: el.querySelector('.bp-follow-head b')?.textContent,
      smart: !!el.querySelector('.bp-follow-smart'),
      count: el.querySelectorAll('.bp-quick-item').length,
    };
  })()`);
  check('类型不可推断时不出现元素解析', noHint?.head === '0x1300'
    && noHint.smart === false && noHint.count > 5, JSON.stringify(noHint));
  await chord('Escape', 'Escape', 27);
  await sleep(150);
  await chord('Delete', 'Delete', 46);
  await sleep(200);

  /* 4. 添加标注并拖拽调整大小 */
  await chord('k', 'KeyK', 75, 2);
  await sleep(160);
  await send('Input.insertText', { text: '标注' });
  await sleep(120);
  await chord('Enter', 'Enter', 13);
  await sleep(300);
  const noteBefore = await rect('.bp-node[data-node-kind="note"]');
  check('标注节点已添加', !!noteBefore, JSON.stringify(noteBefore));
  const handle = await rect('.bp-node[data-node-kind="note"] .bp-note-resize');
  check('标注右下角出现缩放手柄', !!handle, JSON.stringify(handle));
  await mouse('mousePressed', handle.x, handle.y);
  await mouse('mouseMoved', handle.x + 120, handle.y + 70);
  await sleep(120);
  const during = await rect('.bp-node[data-node-kind="note"]');
  await mouse('mouseReleased', handle.x + 120, handle.y + 70);
  await sleep(250);
  const noteAfter = await rect('.bp-node[data-node-kind="note"]');
  check('拖动改宽高（实时预览 + 松手提交）',
    during.w > noteBefore.w + 20 && during.h > noteBefore.h + 20
    && noteAfter.w > noteBefore.w + 20 && noteAfter.h > noteBefore.h + 20,
    `${Math.round(noteBefore.w)}×${Math.round(noteBefore.h)} → ${Math.round(noteAfter.w)}×${Math.round(noteAfter.h)}`);

  const handle2 = await rect('.bp-node[data-node-kind="note"] .bp-note-resize');
  await dbl(handle2.x, handle2.y);
  await sleep(300);
  const noteReset = await rect('.bp-node[data-node-kind="note"]');
  check('双击手柄复位默认尺寸', Math.abs(noteReset.w - noteBefore.w) < 1.5
    && Math.abs(noteReset.h - noteBefore.h) < 1.5,
  `${Math.round(noteReset.w)}×${Math.round(noteReset.h)}`);

  /* 5. 无控制台报错 */
  const bad = events.filter((e) => e.method === 'Log.entryAdded'
    && ['error'].includes(e.params?.entry?.level));
  check('无控制台错误', bad.length === 0, JSON.stringify(bad.map((b) => b.params.entry.text)).slice(0, 300));

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
