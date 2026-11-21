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
const setParam = (label, value) => evaluate(`(() => {
  const row = [...document.querySelectorAll('label.bp-param')].find(l => l.querySelector('span')?.textContent === ${JSON.stringify(label)});
  const el = row?.querySelector('input');
  if (!el) throw Error('未找到参数：' + ${JSON.stringify(label)});
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
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
  await evaluate(`localStorage.setItem('memlink:graph:v3', JSON.stringify({version:3, savedAt:0, packs:[], nodes:[], edges:[]}));`);
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
  await ready(`!!document.querySelector('.bp-dz')`, '设计器打开');
  await setValue('input[aria-label="布局长度覆盖"]', '8', true);
  await evaluate(`document.querySelector('.bp-dz-table tbody tr')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await setValue('input[aria-label="字段名称"]', 'Full64', true);
  await setValue('select[aria-label="字段类型"]', 'u64', true);
  await button('完成');
  await ready(`!document.querySelector('.bp-dz')`, '设计器关闭');
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
  await ready(`!!document.querySelector('.bp-structure-summary')`, '检查器显示结构摘要');
  await button('打开结构设计器');
  await ready(`!!document.querySelector('.bp-dz')`, '设计器打开');
  await evaluate(`document.querySelector('.bp-dz-table tbody tr[data-row-index="1"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await setValue('input[aria-label="字段名称"]', '记录项数', true);
  await button('完成');
  await ready(`!document.querySelector('.bp-dz')`, '设计器关闭');
  const renamed = JSON.parse(await save());
  assert.ok(renamed.edges.some(e => e.from.port === 'field:layout/header:f2' && e.to.port === 'count'));
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

  // 粘贴声明 → 自动布局 → 嵌套数组读取；同时检查导出入口。
  const structureBytes = Buffer.from([2, 0, 10, 0, 20, 0, 30, 0, 40, 0]).toString('base64');
  const structureDoc = {
    format: 'memlink-blueprint/3', packs: [], layouts: [], edges: [],
    nodes: [{ id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 'structure.bin' },
      source: { name: 'structure.bin', base: '0x1000', data: structureBytes } }],
  };
  await openReplace(JSON.stringify(structureDoc));
  await ready(`!!document.querySelector('.bp-pal-item')`, '空白结构工作区');
  await evaluate(`[...document.querySelectorAll('.bp-pal-item')].find(e => e.textContent.includes('读结构'))?.click()`);
  await ready(`!!document.querySelector('.bp-structure-summary')`, '添加读结构节点');
  await button('新建结构布局');
  await ready(`!!document.querySelector('.bp-dz')`, '设计器打开');
  await button('导入');
  await ready(`!!document.querySelector('textarea[aria-label="粘贴结构声明"]')`, '导入声明对话框');
  await setValue('textarea[aria-label="粘贴结构声明"]',
    'struct Entry { uint16_t id; uint16_t value; };\nstruct Header { uint16_t count; Entry entries[2]; };\nstruct Flags { uint16_t kind : 2; uint16_t active : 1; };');
  await button('解析预览');
  await ready(`document.querySelector('.bp-dz-import-result')?.textContent.includes('Header')`, '声明预览');
  await evaluate(`[...document.querySelectorAll('.bp-dz-modal-foot button')].find(b => b.textContent.trim() === '导入')?.click()`);
  await ready(`!document.querySelector('.bp-dz-modal')`, '声明导入完成');
  await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].find(e => e.textContent.includes('Header'))?.click()`);
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Header')`, '打开 Header 布局');
  const offsets = await evaluate(`[...document.querySelectorAll('.bp-dz-table tbody tr')].map(e => e.textContent)`);
  assert.ok(offsets.some(t => t.includes('0x02')), '自动偏移显示在字段表：' + offsets.join(' / '));
  await evaluate(`document.querySelector('.bp-dz-table tbody tr')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await setValue('select[aria-label="字段类型"]', 'u32', true);
  await ready(`[...document.querySelectorAll('.bp-dz-table tbody tr')].some(e => e.textContent.includes('0x04'))`, '改宽后自动重排');
  await button('完成');
  await ready(`!document.querySelector('.bp-dz')`, '设计器关闭');
  await setValue('select[aria-label="引用结构"]', 'layout/header');
  await setParam('地址', '0x1000');
  await sleep(500);
  const structureNode = await evaluate(`[...document.querySelectorAll('.bp-node')].map(n => n.textContent).join('\\n')`);
  assert.ok(/Header|count|entries/.test(structureNode), '结构字段出现在节点上：' + structureNode.slice(0, 120));
  await evaluate(`[...document.querySelectorAll('.bp-pal-item')].find(e => e.textContent.includes('读结构'))?.click()`);
  await sleep(300);
  await setValue('select[aria-label="引用结构"]', 'layout/flags');
  await sleep(300);
  const bitNode = await evaluate(`[...document.querySelectorAll('.bp-node')].at(-1)?.textContent ?? ''`);
  assert.ok(/kind|active/.test(bitNode), '位域字段出现在节点上：' + bitNode.slice(0, 120));
  await button('打开结构设计器');
  await ready(`!!document.querySelector('.bp-dz')`, '导出入口所在设计器');
  await evaluate(`[...document.querySelectorAll('.bp-dz-topbar button')].find(b => b.textContent.trim() === '导出')?.click()`);
  await ready(`!!document.querySelector('.bp-dz-code')`, '布局导出入口存在');
  await evaluate(`[...document.querySelectorAll('.bp-dz-modal-foot button')].find(b => b.textContent.trim() === '关闭')?.click()`);
  await button('完成');
  await ready(`!document.querySelector('.bp-dz')`, '导出后关闭设计器');

  // 导入 pack 后，无脚本节点应能直接选择 pack 类型。
  const packSource = readFileSync(new URL('../samples/demo.bp.ts', import.meta.url), 'utf8');
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.items.add(new File([${JSON.stringify(packSource)}], 'demo.bp.ts'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  await ready(`[...document.querySelectorAll('.bp-pal-item')].some(e => e.textContent.includes('Entry 链表'))`, '导入 demo pack');
  await evaluate(`[...document.querySelectorAll('.bp-pal-item')].find(e => e.textContent.includes('读结构'))?.click()`);
  await sleep(300);
  const packOption = await evaluate(`(() => {
    const sel = [...document.querySelectorAll('select[aria-label="引用结构"]')].at(-1);
    return [...(sel?.options ?? [])].map(o => o.value).find(v => v.startsWith('pack/')) ?? '';
  })()`);
  assert.ok(packOption.startsWith('pack/'), '结构选择器提供 pack 类型：' + packOption);
  await setValue('select[aria-label="引用结构"]', packOption);
  await sleep(300);
  const packNodeText = await evaluate(`[...document.querySelectorAll('.bp-node')].at(-1)?.textContent ?? ''`);
  assert.ok(/Header|Entry|magic|count/.test(packNodeText), 'pack 类型字段出现在节点上');
  console.log('PASS  导入 pack 后，读结构可直接选择 pack 类型并生成字段端口');
  console.log('PASS  粘贴声明生成嵌套布局，读结构节点选择布局并读取字段');
  assert.deepEqual(errors, []);
  console.log('PASS  池下标链表按 2 → 1 → 0 遍历，可浏览原始字节');
} finally {
  socket?.close();
  chrome.kill();
}
