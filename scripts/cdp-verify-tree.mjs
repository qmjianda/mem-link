/**
 * 结构树回归：真实 Chrome 里走一遍「打开 → 展开 → 搜索 → 跳下标 → 树内定位 →
 * footer 入口 → 生成解析节点 → 跟随并返回 → 退出」，并核对会话恢复与节点图不变。
 * 用法：node scripts/cdp-verify-tree.mjs（需先 build）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './cdp-chrome.mjs';

const CHROME = chromePath();
const PORT = 9351;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const profile = mkdtempSync(join(tmpdir(), 'memlink-tree-'));

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
const consoleErrors = [];
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
const esc = () => evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const closeTree = () => evaluate(`document.querySelector('.bp-tree-overlay')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
/** 真实按键：浮层监听的是 window 上的 keydown，合成事件不够可靠 */
async function pressKey(key, code, vk, ctrl = false) {
  const modifiers = ctrl ? 2 : 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}
const openPrp = () => evaluate(`(() => {
  const btn = [...document.querySelectorAll('.bp-node-open')].find((b) =>
    (b.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '').includes('PRP 列表'));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
const typeSearch = (text) => evaluate(`(() => {
  const input = document.querySelector('.bp-tree-search input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

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
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.exception?.description ?? 'exception');
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.querySelectorAll('.bp-node').length > 2`)) break;
    await sleep(150);
  }
  await sleep(400);

  const nodesBefore = await evaluate(`document.querySelectorAll('.bp-node').length`);
  const openButtons = await evaluate(`document.querySelectorAll('.bp-node-open').length`);
  check('struct/list/array 节点带展开按钮', openButtons > 0, `${openButtons} 个`);

  // ---- 入口一：节点卡按钮（用 PRP 列表验证链表/数组根）
  const opened = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.bp-node-open')];
    const pick = btns.find((b) => (b.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '').includes('PRP 列表')) ?? btns[0];
    const head = pick?.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '';
    pick?.click();
    return head;
  })()`);
  await sleep(400);
  check('节点卡按钮进入全屏结构树', await evaluate(`!!document.querySelector('.bp-tree-overlay')`), String(opened));
  check('全屏覆盖整个窗口', await evaluate(`(() => {
    const el = document.querySelector('.bp-tree-overlay');
    const r = el?.getBoundingClientRect();
    return !!r && r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
  })()`));
  check('根行与元素行已渲染', await evaluate(`document.querySelectorAll('.bp-tree-row').length`) >= 3);

  // ---- 展开一个元素
  const expandableRow = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bp-tree-row')].find((r) => r.querySelector('.bp-tree-chev')?.textContent === '▸');
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  check('双击行能展开子层', expandableRow, `${await evaluate(`document.querySelectorAll('.bp-tree-row').length`)} 行`);

  // ---- 搜索：命中值与祖先保留
  await evaluate(`(() => {
    const input = document.querySelector('.bp-tree-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0x');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  check('搜索能过滤行', await evaluate(`document.querySelectorAll('.bp-tree-row').length`) > 0,
    `${await evaluate(`document.querySelectorAll('.bp-tree-row').length`)} 行`);
  await evaluate(`(() => {
    const input = document.querySelector('.bp-tree-search input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);

  // ---- 下标跳转
  const hasJump = await evaluate(`!!document.querySelector('.bp-tree-jump input')`);
  if (hasJump) {
    await evaluate(`(() => {
      const input = document.querySelector('.bp-tree-jump input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(400);
    const cursorText = await evaluate(`document.querySelector('.bp-tree-row.on .bp-tree-name')?.textContent ?? ''`);
    check('下标跳转定位到目标行', cursorText.includes('[3]'), cursorText.trim());
  }

  // ---- Esc 退出，节点图状态不变
  await esc();
  await sleep(300);
  check('Esc 退出回到节点图', await evaluate(`!document.querySelector('.bp-tree-overlay')`));

  // ---- 入口二：检查器「打开」
  const sq = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.bp-node')]
      .find((n) => (n.querySelector('.bp-node-title')?.textContent ?? '').includes('SQ'));
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 14 };
  })()`);
  if (sq) {
    await mouse('mousePressed', sq.x, sq.y);
    await mouse('mouseReleased', sq.x, sq.y);
    await sleep(300);
  }
  check('检查器出现「打开」按钮', await evaluate(`[...document.querySelectorAll('.bp-inspector button')].some((b) => b.textContent.trim() === '打开')`));
  await evaluate(`[...document.querySelectorAll('.bp-inspector button')].find((b) => b.textContent.trim() === '打开')?.click()`);
  await sleep(350);
  check('检查器按钮进入结构树', await evaluate(`!!document.querySelector('.bp-tree-overlay')`));
  await esc();
  await sleep(250);

  // ---- 入口三：双击节点空白处
  const dblOpened = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.bp-node')]
      .find((n) => (n.querySelector('.bp-node-title')?.textContent ?? '').includes('SQ'));
    if (!node) return false;
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(350);
  check('双击节点主体进入结构树', dblOpened && await evaluate(`!!document.querySelector('.bp-tree-overlay')`));
  await esc();
  await sleep(250);

  // ---- 地址字段的「图上解析」
  const goOpened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.bp-node-open')].find((b) =>
      (b.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '').includes('Sqe'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(400);
  const goCount = await evaluate(`document.querySelectorAll('.bp-tree-go').length`);
  const locateCount = await evaluate(`document.querySelectorAll('.bp-tree-go[aria-label="在树内定位"]').length`);
  check('指针字段有图上解析与树内定位按钮', goOpened && goCount > 0 && locateCount > 0,
    `共 ${goCount} 个 · 定位 ${locateCount}`);
  await evaluate(`document.querySelector('.bp-tree-go[aria-label="在树内定位"]')?.click()`);
  await sleep(200);
  const notice = await evaluate(`document.querySelector('.bp-tree-notice')?.textContent ?? ''`);
  check('树内定位给出结果提示且不关闭浮层',
    /已定位|还没/.test(notice) && await evaluate(`!!document.querySelector('.bp-tree-overlay')`), notice);
  await closeTree();
  await sleep(250);

  // ---- 会话恢复：展开 [0] + 搜索词，退出再进来还在
  await openPrp();
  await sleep(350);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bp-tree-row')].find((r) => r.querySelector('.bp-tree-chev')?.textContent === '▸');
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(250);
  await typeSearch('数据页地址');
  await sleep(250);
  const rowsBefore = await evaluate(`document.querySelectorAll('.bp-tree-row').length`);
  await closeTree();
  await sleep(250);
  await openPrp();
  await sleep(350);
  const restoredQuery = await evaluate(`document.querySelector('.bp-tree-search input')?.value ?? ''`);
  const rowsAfter = await evaluate(`document.querySelectorAll('.bp-tree-row').length`);
  const hasChild = await evaluate(`[...document.querySelectorAll('.bp-tree-name')].some((n) => n.textContent.includes('数据页地址'))`);
  check('再次打开恢复搜索词', restoredQuery === '数据页地址', restoredQuery);
  check('再次打开恢复展开路径', rowsAfter === rowsBefore && hasChild, `${rowsBefore} → ${rowsAfter}`);
  await closeTree();
  await sleep(250);

  const nodesAfter = await evaluate(`document.querySelectorAll('.bp-node').length`);
  check('多次进出后节点图不变', nodesAfter === nodesBefore, `${nodesBefore} → ${nodesAfter}`);

  // ---- 节点卡 footer 的「⤢ 全部」入口（截断 / 隐藏元素时的一键出口）
  const footLinks = await evaluate(`document.querySelectorAll('.bp-node-foot-link').length`);
  check('容器节点底部常驻结构树入口', footLinks > 0, `${footLinks} 个`);
  const footOpened = await evaluate(`(() => {
    const links = [...document.querySelectorAll('.bp-node-foot-link')];
    const pick = links.find((b) => (b.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '').includes('PRP 列表')) ?? links[0];
    if (!pick) return false;
    pick.click();
    return true;
  })()`);
  await sleep(350);
  check('footer 入口打开结构树', footOpened && await evaluate(`!!document.querySelector('.bp-tree-overlay:not(.hidden)')`));
  check('从 footer 进来的树有可展开元素', await evaluate(`document.querySelectorAll('.bp-tree-row').length`) >= 3);

  // ---- ⊕：按当前类型在图上生成解析节点，结构树保持打开
  const edgesBeforeResolve = await evaluate(`document.querySelectorAll('path[data-edge-id]').length`);
  const resolveClicked = await evaluate(`(() => {
    const b = document.querySelector('.bp-tree-go[aria-label="生成解析节点"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(950); // 等待蓝图自动保存，以便核对连线端点
  const resolveNotice = await evaluate(`document.querySelector('.bp-tree-notice')?.textContent ?? ''`);
  check('⊕ 生成解析节点且结构树不关闭',
    resolveClicked && /已在图上生成/.test(resolveNotice)
      && await evaluate(`!!document.querySelector('.bp-tree-overlay:not(.hidden)')`),
    resolveNotice.slice(0, 40));
  check('⊕ 从原节点的元素端口连到新节点',
    await evaluate(`document.querySelectorAll('path[data-edge-id]').length`) === edgesBeforeResolve + 1
      && await evaluate(`(() => {
        const doc = JSON.parse(localStorage.getItem('memlink:graph:v1'));
        const edge = doc?.edges.at(-1);
        return edge?.from.node === 'n_prpList' && edge.from.port === 'elem:0'
          && edge.to.node === doc.nodes.at(-1)?.id && edge.to.port === 'address';
      })()`));
  await closeTree();
  await sleep(250);

  // ---- ↗：跟随浮层让位但树不卸载，取消 / 选完都回到树
  await pressKey('0', 'Digit0', 48, true); // Mod+0 适配全图，保证节点卡按钮可见
  await sleep(300);
  const goTree = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.bp-node-open')]
      .find((b) => (b.closest('.bp-node')?.querySelector('.bp-node-title')?.textContent ?? '').includes('Sqe'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(350);
  const followClicked = await evaluate(`(() => {
    const b = document.querySelector('.bp-tree-go[aria-label="在图上解析"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(300);
  check('↗ 打开跟随浮层时结构树只是隐藏、没有卸载',
    goTree && followClicked
      && await evaluate(`!!document.querySelector('.bp-tree-overlay.hidden') && !!document.querySelector('.bp-follow')`));
  await pressKey('Escape', 'Escape', 27);
  await sleep(300);
  check('取消跟随也回到结构树',
    await evaluate(`!!document.querySelector('.bp-tree-overlay:not(.hidden)') && !document.querySelector('.bp-follow')`));
  const edgesBeforeFollow = await evaluate(`document.querySelectorAll('path[data-edge-id]').length`);
  await evaluate(`document.querySelector('.bp-tree-go[aria-label="在图上解析"]')?.click()`);
  await sleep(300);
  await pressKey('Enter', 'Enter', 13);
  await sleep(450);
  check('选完解析节点后回到结构树（闭环）',
    await evaluate(`!!document.querySelector('.bp-tree-overlay:not(.hidden)') && !document.querySelector('.bp-follow')`),
    await evaluate(`document.querySelector('.bp-tree-notice')?.textContent ?? ''`));
  check('树中跟随字段也增加一条画布连线',
    await evaluate(`document.querySelectorAll('path[data-edge-id]').length`) === edgesBeforeFollow + 1);
  await closeTree();
  await sleep(250);

  check('无未捕获异常 / console error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
