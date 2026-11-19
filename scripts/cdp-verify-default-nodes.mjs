/** Browser acceptance for the no-pack parsing workflow. Run after build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePath } from './cdp-chrome.mjs';

const pageUrl = new URL('../dist/index.html', import.meta.url).href;
const profile = mkdtempSync(join(process.env.OPENCODE_TMPDIR || tmpdir(), 'memlink-default-'));
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
  for (let i = 0; i < 60; i++) {
    try {
      const found = await check();
      if (found) return found;
    } catch (err) {
      if (i === 59) throw err;
    }
    await sleep(100);
  }
  throw new Error(`等待失败：${label}`);
}

const ready = (js, label) => until(() => evaluate(js), label);
const setValue = (selector, value, blur = false) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw Error('未找到输入：' + ${JSON.stringify(selector)});
  el.focus();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  if (${blur}) el.blur();
  return true;
})()`);
const action = (selector, event = 'click') => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw Error('未找到控件：' + ${JSON.stringify(selector)});
  const name = ${JSON.stringify(event)};
  const EventType = name.startsWith('pointer') ? PointerEvent : MouseEvent;
  el.dispatchEvent(new EventType(name, { bubbles: true }));
})()`);
const button = name => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)});
  if (!el) throw Error('未找到按钮：' + ${JSON.stringify(name)});
  el.click();
})()`);

const save = () => evaluate(`(async () => {
  let saved;
  const makeUrl = URL.createObjectURL;
  URL.createObjectURL = blob => { saved = blob; return makeUrl(blob); };
  try { document.querySelector('button[title^="导出蓝图 JSON"]').click(); }
  finally { URL.createObjectURL = makeUrl; }
  return await saved.text();
})()`);
const open = text => evaluate(`(() => {
  const file = new File([${JSON.stringify(text)}], 'verify.blueprint.json', {type:'application/json'});
  const drop = new DataTransfer();
  drop.items.add(file);
  const input = document.querySelector('input[accept=".json"]');
  input.files = drop.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
})()`);
/** 打开图时若当前已有工作图，会先问「替换」；等对话框出现并确认。 */
const openReplace = async text => {
  await open(text);
  for (let i = 0; i < 25; i += 1) {
    const state = await evaluate(`(() => {
      const d = document.querySelector('.bp-confirm');
      if (!d) return 'none';
      const b = [...d.querySelectorAll('button')].find(x => x.textContent.trim() === '替换');
      if (!b) return 'other';
      b.click();
      return 'clicked';
    })()`);
    if (state === 'clicked') {
      await until(() => evaluate(`!document.querySelector('.bp-confirm')`), '确认框关闭');
      return;
    }
    if (state === 'other') throw new Error('确认框缺少「替换」按钮');
    await sleep(80);
  }
};
const nodeText = id => `(document.querySelector('[data-node-id="${id}"]')?.textContent ?? '')`;

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
    if (message.method === 'Page.javascriptDialogOpening') {
      void send('Page.handleJavaScriptDialog', { accept: true }).catch(err => errors.push(err.message));
    }
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
  await evaluate(`localStorage.setItem('memlink:graph:v2', JSON.stringify({version:2, savedAt:0, packs:[], nodes:[], edges:[]}));`);
  await send('Page.reload');
  await ready(`!!document.querySelector('.bp-canvas-empty')`, '空白画布');
  assert.equal(await evaluate(`[...document.querySelectorAll('.bp-palette button')].some(b => b.textContent.includes('新建 pack'))`), false);
  // 空白画布渲染后，React 的全局 drop 监听可能还没挂上：重试到节点出现为止。
  for (let i = 0; i < 20; i += 1) {
    await evaluate(`(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0x11,0x32,0x54,0x76,0x98,0xba,0xdc,0xfe])], 'exact.bin'));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await sleep(120);
    if (await evaluate(`!!document.querySelector('.bp-node.on [data-port="base"]')`)) break;
  }
  await ready(`!!document.querySelector('.bp-node.on [data-port="base"]')`, '载入二进制');
  await setValue('input[aria-label="基址"]', '0xFFFF800000000001', true);
  await ready(`document.querySelector('.hex-addr')?.textContent === 'FFFF800000000001'`, '精确基址定位');
  await action('.bp-node.on [data-port="base"][data-side="out"]', 'dblclick');
  await ready(`document.querySelector('.bp-follow-head b')?.textContent === '0xffff800000000001'`, '跟随精确地址');
  await setValue('input[aria-label="搜索解析节点"]', '读结构');
  await action('.bp-follow button[role="option"]');
  await button('新建结构布局');
  await setValue('.bp-layout-editor label:nth-of-type(3) input', '8');
  await setValue('input[aria-label="字段名 1"]', 'Full64');
  await setValue('select[aria-label="字段类型 1"]', 'u64');
  await ready(`document.querySelector('.ft-val')?.textContent === '18364758544493064721'`, '读取精确字段');
  await action('.ft-row');
  await ready(`document.querySelector('.bp-field-addr-text')?.textContent.includes('0xffff800000000001') && !!document.querySelector('.hexview .hb.hl')`, '字段定位原始字节');
  const saved = await save();
  const savedDoc = JSON.parse(saved);
  assert.equal(savedDoc.nodes.find(n => n.nodeId === 'file').source.base, '0xffff800000000001');
  assert.equal(savedDoc.layouts[0].fields[0].name, 'Full64');
  assert.equal(savedDoc.edges.filter(e => e.to.port === 'address').length, 1);
  await openReplace(saved);
  await ready(`document.querySelector('.bp-node [data-port^="field:"]') && document.body.textContent.includes('18364758544493064721')`, '重开仍保留数值与布局');
  console.log('PASS  无 pack 载入 → 64 位地址跟随 → 配置布局 → 字段定位 → 保存重开');

  const table = JSON.parse(readFileSync(new URL('../samples/header-array.blueprint.json', import.meta.url), 'utf8'));
  await openReplace(JSON.stringify(table));
  await ready(`${nodeText('checksumOk')}.includes('通过') && ${nodeText('item')}.includes('20')`, '表头驱动数组并通过校验');
  await action('[data-node-id="header"]', 'pointerdown');
  await ready(`!!document.querySelector('input[aria-label="字段名 2"]')`, '选中共享布局');
  await setValue('input[aria-label="字段名 2"]', '记录项数');
  const renamed = JSON.parse(await save());
  assert.ok(renamed.edges.some(e => e.from.port === 'field:header:f2' && e.to.port === 'count'));
  assert.equal(renamed.layouts[0].fields[1].name, '记录项数');
  assert.ok(await evaluate(`${nodeText('item')}.includes('20')`));
  const body = Buffer.from(table.nodes[0].source.data, 'base64');
  body[body.length - 1] ^= 1;
  table.nodes[0].source.data = body.toString('base64');
  await openReplace(JSON.stringify(table));
  await ready(`${nodeText('checksumOk')}.includes('不通过')`, '内容不匹配');
  await action('.bp-inspector .panel-tabs button:nth-child(2)');
  await ready(`!!document.querySelector('.bp-problem')`, '打开问题列表');
  await evaluate(`Array.from(document.querySelectorAll('.bp-problem')).find(e => e.textContent.includes('不通过'))?.click()`);
  await ready(`document.querySelector('.bp-issue-origin')?.textContent.includes('0x1008') && !!document.querySelector('.bp-issue-origin .hb.hl')`,
    '断言不通过定位到源字节');
  table.nodes[0].source.data = body.subarray(0, body.length - 1).toString('base64');
  await openReplace(JSON.stringify(table));
  await ready(`${nodeText('checksumOk')}.includes('未能校验')`, '读取失败不等于不通过');
  console.log('PASS  表头控制数组、取第二项；校验通过、不通过、未能校验可区分');

  await openReplace(readFileSync(new URL('../samples/pool-list.blueprint.json', import.meta.url), 'utf8'));
  await ready(`${nodeText('last')}.includes('10')`, '池下标列表读取');
  await action('[data-node-id="list"] button[title^="打开结构视图"]');
  await ready(`document.querySelector('.bp-local-tree-list')?.textContent.includes('#2 · 0x2000')`, '链表结构视图');
  assert.deepEqual(errors, []);
  console.log('PASS  池下标链表按 2 → 1 → 0 遍历，可浏览原始字节');
} finally {
  socket?.close();
  chrome.kill();
}
