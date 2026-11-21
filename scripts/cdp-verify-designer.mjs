/** Browser acceptance for the full-screen structure designer. Run after build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePath } from './cdp-chrome.mjs';

const pageUrl = new URL('../dist/index.html', import.meta.url).href;
const profile = mkdtempSync(join(process.env.OPENCODE_TMPDIR || tmpdir(), 'memlink-designer-'));
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
const box = selector => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw Error('未找到元素：' + ${JSON.stringify(selector)});
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const mouse = (type, x, y, clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
const click = async selector => {
  const b = await box(selector);
  await mouse('mouseMoved', b.x, b.y);
  await mouse('mousePressed', b.x, b.y);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(250);
};
const doubleClick = async selector => {
  const b = await box(selector);
  await mouse('mouseMoved', b.x, b.y);
  await mouse('mousePressed', b.x, b.y, 1);
  await mouse('mouseReleased', b.x, b.y, 1);
  await mouse('mousePressed', b.x, b.y, 2);
  await mouse('mouseReleased', b.x, b.y, 2);
  await sleep(400);
};
const drag = async (from, to) => {
  const a = await box(from);
  const b = await box(to);
  await mouse('mouseMoved', a.x, a.y);
  await mouse('mousePressed', a.x, a.y);
  await mouse('mouseMoved', (a.x + b.x) / 2, (a.y + b.y) / 2);
  await mouse('mouseMoved', b.x, b.y);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(500);
};
const graph = () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  return {
    version: 3, savedAt: 0, packs: [],
    nodes: [
      { id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 'designer.bin' },
        source: { name: 'designer.bin', base: '0x1000', data: bytes.toString('base64') } },
      { id: 'h', packId: '', nodeId: 'structread', x: 340, y: 0, params: { structureId: 'layout/header', address: '0x1000' } },
    ],
    edges: [{ id: 'e1', from: { node: 'f', port: 'buffer' }, to: { node: 'h', port: 'buffer' } }],
    layouts: [{
      id: 'header', name: 'Header', endian: 'little', size: '8',
      fields: [
        { id: 'f1', name: 'tableOffset', kind: 'u16', at: '0' },
        { id: 'f2', name: 'count', kind: 'u8', at: '2' },
        { id: 'f3', name: 'magic', kind: 'u8', at: '3' },
        { id: 'f4', name: 'crc32', kind: 'u32', at: '4' },
      ],
    }, {
      id: 'flags', name: 'Flags', endian: 'little',
      fields: [
        { id: 'f1', name: 'kind', kind: 'bits', at: '0', bit: '0', width: '2', unit: '8' },
        { id: 'f2', name: 'active', kind: 'bits', at: '0', bit: '2', width: '1', unit: '8' },
        { id: 'f3', name: 'mode', kind: 'bits', at: '0', bit: '3', width: '3', unit: '8' },
      ],
    }, {
      id: 'mix', name: 'Mix', endian: 'little',
      fields: [
        { id: 'f1', name: 'a', kind: 'u8' },
        { id: 'f2', name: 'b', kind: 'u16' },
      ],
    }],
  };
};

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
  await evaluate(`localStorage.setItem('memlink:graph:v3', JSON.stringify(${JSON.stringify(graph())})); location.reload();`);
  await ready(`!!document.querySelector('[data-node-id="h"]')`, '载入测试图');
  await action('[data-node-id="h"]', 'pointerdown');
  await ready(`!!document.querySelector('.bp-structure-summary')`, '结构摘要');
  await button('打开结构设计器');
  await ready(`!!document.querySelector('.bp-dz')`, '设计器打开');
  assert.equal(await evaluate(`location.hash`), '#design/header');
  assert.equal(await evaluate(`document.getElementById('root')?.hasAttribute('inert')`), true);
  await ready(`document.activeElement?.id === 'bp-dz-title'`, '焦点进入设计器标题');
  assert.equal(await evaluate(`document.activeElement?.textContent`), '结构设计器');
  assert.equal(await evaluate(`document.querySelectorAll('.bp-dz-table tbody tr').length`), 4);
  console.log('PASS  从检查器打开设计器：全屏、hash、焦点进入、背景 inert');

  await click('[data-field-id="f2"]');
  await ready(`document.querySelector('.bp-dz-field.on')?.getAttribute('data-field-id') === 'f2'`, '单击字节字段选中');
  await ready(`document.querySelector('.bp-dz-status')?.textContent.includes('count')`, '状态栏同步字段');
  assert.equal(await evaluate(`document.querySelector('tr[data-row-index="1"]')?.getAttribute('aria-selected')`), 'true');
  console.log('PASS  单击画布字段选中，字段表与状态栏同步');
  const historyBeforeReset = await evaluate(`history.length`);
  await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].find(e => e.textContent.includes('Header'))?.click()`);
  await ready(`document.querySelector('.bp-dz-right')?.textContent.includes('布局属性')`, '回到布局属性');
  assert.equal(await evaluate(`history.length`), historyBeforeReset);

  await button('删除布局');
  await ready(`document.querySelector('.bp-dz-modal')?.textContent.includes('仍被')`, '删除被引用布局被拒绝');
  assert.ok(await evaluate(`document.querySelector('.bp-dz-modal')?.textContent.includes('读结构')`));
  await button('知道了');
  await ready(`!document.querySelector('.bp-dz-modal')`, '关闭引用提示');
  assert.ok(await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].some(e => e.textContent.includes('Header'))`));
  console.log('PASS  被引用布局拒绝删除并列出节点来源');

  await action('tr[data-row-index="1"]');
  await setValue('input[aria-label="字段名称"]', 'draft-escape', false);
  await sleep(120);
  await evaluate(`document.querySelector('input[aria-label="字段名称"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(200);
  assert.ok(await evaluate(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('count')`));
  assert.equal(await evaluate(`document.querySelector('input[aria-label="字段名称"]')?.value`), 'count');
  console.log('PASS  Esc 丢弃字段名草稿，不写入文档');
  await action('tr[data-row-index="1"]');
  await setValue('input[aria-label="字段名称"]', 'total', true);
  await ready(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('total')`, '表内改名');
  await action('.bp-dz-topbar button[title^="撤销"]');
  await ready(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('count')`, '撤销改名');
  console.log('PASS  字段表改名一次提交，撤销恢复');

  await drag('[data-field-id="f2"]', '[data-cell="4"]');
  await ready(`document.querySelector('.bp-dz-toast')?.textContent.includes('重叠')`, '非法拖动提示');
  assert.ok(await evaluate(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('0x02')`));
  console.log('PASS  非法落点回弹并说明冲突，不写字段');

  await action('tr[data-row-index="1"]');
  await setValue('input[aria-label="字段名称"]', 'total', true);
  await ready(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('total')`, '再次改名');
  await button('撤销本次修改');
  await ready(`!!document.querySelector('.bp-dz-modal')`, '会话检查点确认');
  await evaluate(`[...document.querySelectorAll('.bp-dz-modal-foot button')].find(b => b.textContent.trim() === '恢复')?.click()`);
  await ready(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('count')`, '会话恢复');
  console.log('PASS  撤销本次打开后的全部修改');

  await button('模板');
  await ready(`!!document.querySelector('.bp-dz-modal')`, '模板浮层');
  await evaluate(`[...document.querySelectorAll('.bp-dz-template')].find(b => b.textContent.includes('嵌套数组'))?.click()`);
  await ready(`!document.querySelector('.bp-dz-modal')`, '模板关闭');
  await ready(`[...document.querySelectorAll('.bp-dz-layout-card')].some(e => e.textContent.includes('Table'))`, '模板生成布局');
  await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].find(e => e.textContent.includes('Table'))?.click()`);
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Table')`, '打开 Table');
  await action('tr[data-row-index="1"]');
  await button('进入子布局');
  await ready(`location.hash.split('/').filter(Boolean).length === 3 && document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Entry')`, '进入子布局');
  await button('插入字段');
  await ready(`!!document.querySelector('.bp-dz-insert')`, '插入菜单');
  await evaluate(`[...document.querySelectorAll('.bp-dz-insert-grid button')].find(b => b.textContent.includes('u16'))?.click()`);
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Entry') && document.querySelectorAll('.bp-dz-table tbody tr').length === 3`, '子布局新增字段');
  await evaluate(`history.back()`);
  await ready(`location.hash.split('/').filter(Boolean).length === 2 && document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Table')`, '浏览器后退到父布局');
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('26 B')`, '父布局长度联动');
  await action('tr[data-row-index="1"]');
  await doubleClick('[data-field-id="f2"]');
  await ready(`location.hash.split('/').filter(Boolean).length === 3 && document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Entry')`, '双击字段进入子布局');
  await evaluate(`history.back()`);
  await ready(`location.hash.split('/').filter(Boolean).length === 2 && document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Table')`, '双击进入后返回');
  console.log('PASS  嵌套布局、父长度联动、浏览器后退、双击进入子布局');

  await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].find(e => e.textContent.includes('Mix'))?.click()`);
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Mix')`, '打开混合布局');
  await action('tr[data-row-index="0"]');
  await evaluate(`document.querySelector('tr[data-row-index="1"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await ready(`document.querySelectorAll('.bp-dz-table tbody tr.on').length === 2`, '混合多选');
  await drag('[data-field-id="f2"]', '[data-cell="3"]');
  await ready(`document.querySelector('.bp-dz-toast')?.textContent.includes('同类型')`, '混合类型拖动被拒绝');
  assert.ok(await evaluate(`document.querySelectorAll('.bp-dz-table tbody tr')[1]?.textContent.includes('u16')`));
  console.log('PASS  混合类型多选拖动明确拒绝');

  await evaluate(`[...document.querySelectorAll('.bp-dz-layout-card')].find(e => e.textContent.includes('Flags'))?.click()`);
  await ready(`document.querySelector('.bp-dz-canvas-title')?.textContent.includes('Flags')`, '打开位域布局');
  await click('[data-group-key="0:8"]');
  await ready(`document.querySelector('.bp-dz-status')?.textContent.includes('位域组')`, '单击位域组选中');
  assert.equal(await evaluate(`document.querySelectorAll('.bp-dz-table tbody tr.on').length`), 3);
  console.log('PASS  单击位域组选中整组，字段表同步');
  await action('.bp-dz-seg button:nth-child(2)');
  await ready(`document.querySelectorAll('.bp-dz-bit-group').length === 1`, '切到位视图');
  {
    const active = await box('[data-bit-id="f2"]');
    const kind = await box('[data-bit-id="f1"]');
    await mouse('mouseMoved', active.x, active.y);
    await mouse('mousePressed', active.x, active.y);
    await mouse('mouseMoved', (active.x + kind.x) / 2, active.y);
    await mouse('mouseMoved', kind.x, active.y);
    await ready(`document.querySelector('.bp-dz-bit-preview')?.className.includes('conflict')`, '位域冲突预览');
    await mouse('mouseReleased', kind.x, active.y);
    await ready(`document.querySelector('.bp-dz-toast')?.textContent.includes('重叠')`, '位域冲突拒绝');
    assert.ok((await evaluate(`[...document.querySelectorAll('.bp-dz-table tbody tr')].find(e => e.textContent.includes('active'))?.textContent ?? ''`)).includes('+2'));
  }
  console.log('PASS  位域拖动预览冲突并拒绝重叠');
  await action('.bp-dz-seg button:nth-child(1)');

  await button('完成');
  await ready(`!document.querySelector('.bp-dz')`, '关闭设计器');
  assert.equal(await evaluate(`location.hash`), '');
  assert.equal(await evaluate(`document.getElementById('root')?.hasAttribute('inert')`), false);
  assert.ok((await evaluate(`document.activeElement?.textContent ?? ''`)).includes('打开结构设计器'));
  console.log('PASS  关闭返回蓝图，hash 清空，焦点回到入口');

  const wideFields = Array.from({ length: 128 }, (_, i) => ({ id: `f${i + 1}`, name: `b${i + 1}`, kind: 'u8' }));
  const wideGraph = { ...graph(), layouts: [{ id: 'wide', name: 'Wide', endian: 'little', fields: wideFields }] };
  await evaluate(`localStorage.setItem('memlink:graph:v3', ${JSON.stringify(JSON.stringify(wideGraph))}); history.replaceState(null, '', location.pathname + '#design/wide'); 'ok'`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(900);
  await ready(`document.querySelectorAll('.bp-dz-field').length === 128`, '128 字段渲染');
  await button('适应');
  await ready(`document.querySelector('.bp-dz-zoom')?.textContent !== '100%'`, '128 字段适应宽度');
  console.log('PASS  128 字段布局可渲染、适应宽度');

  await evaluate(`history.replaceState(null, '', location.pathname + '#design/missing'); 'ok'`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(900);
  await ready(`!!document.querySelector('.bp-dz-center-empty')`, '缺失布局状态');
  assert.ok(await evaluate(`document.querySelector('.bp-dz-center-empty')?.textContent.includes('布局不存在')`));
  await button('返回蓝图');
  await ready(`!document.querySelector('.bp-dz')`, '缺失状态返回蓝图');
  console.log('PASS  缺失布局有恢复路径');

  assert.deepEqual(errors, []);
  console.log('\nOK  designer verification passed');
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill();
}
