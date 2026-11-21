/**
 * Real-Chrome verification for the blueprint editor.
 * Usage: node scripts/cdp-verify.mjs
 *
 * Runs against dist/index.html over file://, drives real mouse/keyboard input
 * through CDP, and asserts the behaviours that unit tests cannot prove.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './cdp-chrome.mjs';

const CHROME = chromePath();
const PORT = 9333;
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

async function main() {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
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

  // Wait for the app to mount. 启动默认是空白工作区，先进入「示例」临时副本。
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.bp-app .bp-node')`)) break;
    if (i === 0) {
      await evaluate(`(() => {
        const b = [...document.querySelectorAll('.bp-top .btn')]
          .find(e => e.textContent.trim() === '示例');
        b?.click();
        return !!b;
      })()`);
    }
    await sleep(150);
  }

  /* ---------------------------------------------------------- 1. demo graph */
  const nodes = await evaluate(`document.querySelectorAll('.bp-node').length`);
  check('NVMe demo renders 12 nodes', nodes === 12, `实际 ${nodes}`);
  const titles = await evaluate(`[...document.querySelectorAll('.bp-node-title')].map(e=>e.textContent)`);
  check('SQE / PRP / 数据页节点齐全',
    ['提交队列 SQ', 'PRP / 分散页', '数据页'].every((t) => titles.includes(t)),
    titles.slice(0, 14).join(' | '));
  const badges = await evaluate(`document.querySelectorAll('.bp-node-badge').length`);
  check('示例图求值为 0 个节点错误', badges === 0, `问题角标 ${badges}`);
  const circles = await evaluate(`document.querySelectorAll('circle[data-edge-cap]').length`);
  check('连线端点圆点已渲染', circles > 0, `${circles} 个端点`);
  // 已从上游继承数据源的节点不再显示数据源圆点，避免叠出第二条来源线。
  const ctxHidden = await evaluate(`(() => {
    const n = document.querySelector('[data-node-id="n_sqe"]');
    const srcRow = [...n.querySelectorAll('.bp-row')].map(r => r.textContent)
      .find(t => t.includes('数据源')) ?? '';
    return { srcRow, port: !!n.querySelector('.bp-port[data-port="buffer"]') };
  })()`);
  check('继承数据源的节点隐藏数据源端点',
    ctxHidden.srcRow.includes('继承') && !ctxHidden.port, JSON.stringify(ctxHidden));

  /* ------------------------------------------- 2. palette groups / built-ins */
  const groups = await evaluate(`[...document.querySelectorAll('.bp-group-title')].map(e=>e.textContent)`);
  check('节点库按 6 组分类并含 pack 分组', groups.length >= 7, groups.join(' / '));
  const items = await evaluate(`document.querySelectorAll('.bp-pal-item').length`);
  check('节点库含通用节点和已导入 pack 节点', items >= 24, `${items} 项`);
  const gone = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.bp-pal-item')].map(e => e.textContent);
    return {
      removed: ['指针解引用', '浮点读取', '位运算'].filter(t => labels.some(l => l.includes(t))),
      kept: ['读指针', '读数值'].filter(t => labels.some(l => l.includes(t))),
    };
  })()`);
  check('冗余节点已从节点库移除，合并节点仍在',
    gone.removed.length === 0 && gone.kept.length === 2, JSON.stringify(gone));

  /* ---------------------------------------- 3. endpoint dots follow the drag */
  const dragTarget = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="n_sq"] .bp-node-head');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const before = await evaluate(`(() => {
    window.__dragBase = window.__bp ? window.__bp.evalRuns : 0;
    return [...document.querySelectorAll('circle[data-edge-cap]')]
      .map(c => c.getAttribute('cx') + ',' + c.getAttribute('cy'));
  })()`);
  await mouse('mousePressed', dragTarget.x, dragTarget.y);
  await mouse('mouseMoved', dragTarget.x + 90, dragTarget.y + 55);
  await sleep(120); // let one rAF apply the direct DOM writes
  const during = await evaluate(`[...document.querySelectorAll('circle[data-edge-cap]')]
    .map(c => c.getAttribute('cx') + ',' + c.getAttribute('cy'))`);
  const evalRunsDuring = await evaluate(`window.__bp ? window.__bp.evalRuns : 0`);
  const movedDots = before.filter((v, i) => v !== during[i]).length;
  check('拖动中端点圆点跟随节点移动', movedDots >= 2, `${movedDots} 个端点位移`);
  check('拖动期间不触发重新求值', evalRunsDuring === (await evaluate(`window.__dragBase`)),
    `evalRuns ${await evaluate(`window.__dragBase`)} → ${evalRunsDuring}`);
  await mouse('mouseReleased', dragTarget.x + 90, dragTarget.y + 55);
  await sleep(160);
  const after = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="n_sq"]');
    return { left: el.style.left, circles: [...document.querySelectorAll('circle[data-edge-cap]')]
      .map(c => c.getAttribute('cx') + ',' + c.getAttribute('cy')) };
  })()`);
  check('松手后文档提交且端点保持同步',
    after.left !== '' && after.circles.some((v, i) => v !== before[i]),
    `left=${after.left}`);

  /* ------------------------------------------- 4. wheel: no passive warnings */
  const canvasRect = await evaluate(`(() => { const r = document.querySelector('.bp-canvas').getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  await mouse('mouseWheel', canvasRect.x, canvasRect.y, { deltaX: 0, deltaY: -120, button: 'none', buttons: 0, clickCount: 0 });
  await sleep(150);
  const passiveErrors = events.filter((e) =>
    (e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    && JSON.stringify(e.params).includes('preventDefault'));
  check('缩放无 passive 事件警告', passiveErrors.length === 0, `${passiveErrors.length} 条`);
  const transform = await evaluate(`document.querySelector('.bp-world').style.transform`);
  check('滚轮改变了视口缩放', /scale\(/.test(transform), transform);

  /* ------------------------------------------- 5. quick-add lands at centre */
  await chord('k', 'KeyK', 75, 2); // Ctrl+K
  await sleep(120);
  const quickOpen = await evaluate(`!!document.querySelector('.bp-quick')`);
  check('Mod+K 打开快速添加', quickOpen);
  await chord('Enter', 'Enter', 13);
  await sleep(220);
  const added = await evaluate(`document.querySelectorAll('.bp-node').length`);
  check('快速添加只新增 1 个节点', added === nodes + 1, `${nodes} → ${added}`);
  const placement = await evaluate(`(() => {
    const c = document.querySelector('.bp-canvas').getBoundingClientRect();
    const heads = [...document.querySelectorAll('.bp-node-head')];
    const r = heads[heads.length - 1].getBoundingClientRect();
    return { dx: (r.left + r.width/2) - (c.left + c.width/2), dy: (r.top + r.height/2) - (c.top + c.height/2) };
  })()`);
  check('快速添加落在视口中心', Math.abs(placement.dx) < 24 && Math.abs(placement.dy) < 24,
    `偏移 ${placement.dx.toFixed(1)}, ${placement.dy.toFixed(1)} px`);

  /* ------------------------------------ 6. palette drag-to-add drop accuracy */
  const pal = await evaluate(`(() => {
    const el = document.querySelector('.bp-pal-item');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  const drop = { x: canvasRect.left + canvasRect.w * 0.62, y: canvasRect.top + canvasRect.h * 0.45 };
  await mouse('mousePressed', pal.x, pal.y);
  await mouse('mouseMoved', pal.x + 30, pal.y + 12);
  await mouse('mouseMoved', drop.x, drop.y);
  await sleep(80);
  await mouse('mouseReleased', drop.x, drop.y);
  await sleep(220);
  const afterDrop = await evaluate(`document.querySelectorAll('.bp-node').length`);
  check('拖放添加只新增 1 个节点（无 click 重复）', afterDrop === added + 1, `${added} → ${afterDrop}`);
  const dropDelta = await evaluate(`(() => {
    const heads = [...document.querySelectorAll('.bp-node-head')];
    const r = heads[heads.length - 1].getBoundingClientRect();
    return { dx: (r.left + r.width/2) - ${drop.x}, dy: (r.top + r.height/2) - ${drop.y} };
  })()`);
  check('拖放落点对齐指针', Math.abs(dropDelta.dx) < 24 && Math.abs(dropDelta.dy) < 24,
    `偏移 ${dropDelta.dx.toFixed(1)}, ${dropDelta.dy.toFixed(1)} px`);

  /* ------------------------------------- 6b. / search focus and empty state */
  await chord('/', 'Slash', 191, 0, '/');
  await sleep(100);
  const searchFocused = await evaluate(`document.activeElement?.hasAttribute('data-bp-search')`);
  check('/ 聚焦节点库搜索框', searchFocused);
  await chord('a', 'KeyA', 65, 2);
  await send('Input.insertText', { text: '__nomatch__' });
  await sleep(160);
  const emptySearch = await evaluate(`document.querySelector('.bp-empty-search')?.textContent`);
  check('搜索无匹配时显示提示', emptySearch === '无匹配节点', String(emptySearch));
  await chord('a', 'KeyA', 65, 2);
  await chord('Backspace', 'Backspace', 8);
  await sleep(120);

  /* ---------------------------------------------- 6c. F2 node rename */
  // 取 DOM 中最后一个节点（层级最高，不会与其它卡片重叠，点击命中稳定）。
  const renameHead = await evaluate(`(() => {
    const heads = [...document.querySelectorAll('.bp-node-head')];
    const el = heads[heads.length - 1];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, id: el.parentElement.getAttribute('data-node-id') };
  })()`);
  await mouse('mousePressed', renameHead.x, renameHead.y);
  await mouse('mouseReleased', renameHead.x, renameHead.y);
  await sleep(100);
  await chord('F2', 'F2', 113);
  await sleep(120);
  check('F2 打开行内重命名', await evaluate(`!!document.querySelector('.bp-rename-input')`));
  await chord('a', 'KeyA', 65, 2);
  await send('Input.insertText', { text: '提交队列 · 已核对' });
  await sleep(120);
  const renameValue = await evaluate(`document.querySelector('.bp-rename-input')?.value`);
  await chord('Enter', 'Enter', 13);
  await sleep(200);
  const titled = await evaluate(
    `document.querySelector('[data-node-id=${JSON.stringify(renameHead.id)}] .bp-node-title')?.textContent ?? null`,
  );
  check('重命名写入节点标题', titled === '提交队列 · 已核对',
    `目标 ${renameHead.id}；输入框值=${JSON.stringify(renameValue)}；画布标题=${JSON.stringify(titled)}`);
  await chord('z', 'KeyZ', 90, 2); // Ctrl+Z 撤销重命名
  await sleep(160);
  const undone = await evaluate(
    `document.querySelector('[data-node-id=${JSON.stringify(renameHead.id)}] .bp-node-title')?.textContent`,
  );
  check('撤销恢复原节点标题', undone !== '提交队列 · 已核对', String(undone));

  /* ------------------------------------------- 6d. context menu completeness */
  const blank = { x: canvasRect.left + 40, y: canvasRect.top + canvasRect.h - 40 };
  await mouse('mousePressed', blank.x, blank.y, { button: 'right' });
  await mouse('mouseReleased', blank.x, blank.y, { button: 'right' });
  await sleep(140);
  const menuLabels = await evaluate(`[...document.querySelectorAll('.bp-menu-item span')].map(e=>e.textContent)`);
  check('画布右键菜单含撤销/重做/问题/导出/清空',
    menuLabels.length >= 11 && menuLabels.some((t) => t.includes('清空画布')),
    `${menuLabels.length} 项：${menuLabels.join(' / ')}`);
  await chord('Escape', 'Escape', 27);
  await sleep(100);

  /* --------------------------------- 6e. 逆向主链路：跟随地址与导航历史 */
  // 回归：元素端口的值是 InstanceView（不是 number），双击必须取它的 addr；
  // 曾经只认 number，导致提示「该值不是缓冲区内的有效地址」。
  const elemPort = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="n_sq"] .bp-element-row [data-port^="elem:"][data-side="out"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, port: el.getAttribute('data-port'), reachable: !!hit && (hit === el || hit.contains(el)) };
  })()`);
  check('元素端口已渲染且可命中', !!elemPort && elemPort.reachable, JSON.stringify(elemPort));
  if (elemPort && elemPort.reachable) {
    const dbl = async () => {
      await mouse('mousePressed', elemPort.x, elemPort.y, { clickCount: 1 });
      await mouse('mouseReleased', elemPort.x, elemPort.y, { clickCount: 1 });
      await mouse('mousePressed', elemPort.x, elemPort.y, { clickCount: 2 });
      await mouse('mouseReleased', elemPort.x, elemPort.y, { clickCount: 2 });
      await sleep(200);
    };
    await dbl();
    const elemFollow = await evaluate(`document.querySelector('.bp-follow')?.textContent ?? ''`);
    check('双击元素端口按元素地址打开跟随浮层',
      /在此地址解析/.test(elemFollow) && /0x1000/.test(elemFollow),
      String(elemFollow).slice(0, 80));
    await chord('Escape', 'Escape', 27);
    await sleep(140);

    const listPort = await evaluate(`(() => {
      const el = document.querySelector('[data-node-id="n_sq"] .bp-out-row [data-port="list"][data-side="out"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (listPort) {
      await mouse('mousePressed', listPort.x, listPort.y, { clickCount: 1 });
      await mouse('mouseReleased', listPort.x, listPort.y, { clickCount: 1 });
      await mouse('mousePressed', listPort.x, listPort.y, { clickCount: 2 });
      await mouse('mouseReleased', listPort.x, listPort.y, { clickCount: 2 });
      await sleep(200);
      const hint = await evaluate(`document.querySelector('.toast')?.textContent ?? ''`);
      const stillOpen = await evaluate(`!!document.querySelector('.bp-follow')`);
      check('列表端口双击给出「展开后双击单个元素」提示',
        !stillOpen && /展开后双击单个元素/.test(hint), String(hint).slice(0, 80));
      await sleep(1400); // 等 toast 退场，避免影响后续断言
    }
  }

  const basePort = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="n_file"] [data-port="base"][data-side="out"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, reachable: !!hit && (hit === el || el.contains(hit)) };
  })()`);
  check('File.base 输出端口可命中', !!basePort && basePort.reachable, JSON.stringify(basePort));
  if (basePort && basePort.reachable) {
    const viewBefore = await evaluate(`document.querySelector('.bp-world').style.transform`);
    const nBefore = await evaluate(`document.querySelectorAll('.bp-node').length`);
    const eBefore = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);

    await mouse('mousePressed', basePort.x, basePort.y, { clickCount: 1 });
    await mouse('mouseReleased', basePort.x, basePort.y, { clickCount: 1 });
    await mouse('mousePressed', basePort.x, basePort.y, { clickCount: 2 });
    await mouse('mouseReleased', basePort.x, basePort.y, { clickCount: 2 });
    await sleep(170);
    const followText = await evaluate(`document.querySelector('.bp-follow')?.textContent ?? ''`);
    check('双击输出端口打开跟随地址浮层并显示 0x1000',
      /在此地址解析/.test(followText) && /0x1000/.test(followText),
      String(followText).slice(0, 80));

    await chord('Enter', 'Enter', 13);
    await sleep(260);
    const nAfter = await evaluate(`document.querySelectorAll('.bp-node').length`);
    const eAfter = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    check('跟随地址原子创建节点与连线',
      nAfter === nBefore + 1 && eAfter >= eBefore + 1,
      `节点 ${nBefore}→${nAfter}；连线 ${eBefore}→${eAfter}`);
    const viewAfter = await evaluate(`document.querySelector('.bp-world').style.transform`);
    check('跟随地址后自动居中新节点', viewAfter !== viewBefore, `${viewAfter}`);

    await chord('ArrowLeft', 'ArrowLeft', 37, 1);
    await sleep(190);
    const viewBack = await evaluate(`document.querySelector('.bp-world').style.transform`);
    check('Alt+← 返回上一视图', viewBack === viewBefore, String(viewBack));
    await chord('ArrowRight', 'ArrowRight', 39, 1);
    await sleep(190);
    const viewFwd = await evaluate(`document.querySelector('.bp-world').style.transform`);
    check('Alt+→ 前进到下一视图', viewFwd === viewAfter, String(viewFwd));

    // 视口已被 centerOn / 导航移动过，n_file 可能已在可视区外：
    // 先适配全图，再重新取端口坐标右键。
    await chord('0', 'Digit0', 48, 2);
    await sleep(220);
    const rightPort = await evaluate(`(() => {
      const el = document.querySelector('[data-node-id="n_file"] [data-port="base"][data-side="out"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await mouse('mousePressed', rightPort.x, rightPort.y, { button: 'right' });
    await mouse('mouseReleased', rightPort.x, rightPort.y, { button: 'right' });
    await sleep(150);
    const portMenu = await evaluate(`[...document.querySelectorAll('.bp-menu-item span')].map(e=>e.textContent)`);
    check('端口右键菜单含「跟随地址」', portMenu.some((t) => t.includes('跟随地址')),
      portMenu.join(' / '));
    await chord('Escape', 'Escape', 27);
    await sleep(110);
  }

  /* --------------------------------------- 6f. Ctrl+F 图内查找与地址跳转 */
  await chord('f', 'KeyF', 70, 2);
  await sleep(130);
  check('Ctrl+F 打开图内查找', await evaluate(`!!document.querySelector('.bp-search-graph')`));
  await send('Input.insertText', { text: '0x1400' });
  await sleep(180);
  const addrHits = await evaluate(`[...document.querySelectorAll('.bp-search-graph .bp-quick-item em')]
    .map(e => e.textContent)`);
  check('地址 0x1400 命中覆盖它的实例', addrHits.length >= 1 && addrHits.some((t) => /0x1400/.test(t)),
    addrHits.slice(0, 3).join(' | '));
  await chord('Enter', 'Enter', 13);
  await sleep(200);
  const picked = await evaluate(`document.querySelector('.bp-insp-head > span')?.textContent`);
  check('回车定位并选中实例所在节点', !!picked, String(picked));

  await chord('f', 'KeyF', 70, 2);
  await sleep(120);
  await chord('a', 'KeyA', 65, 2);
  await send('Input.insertText', { text: 'PRP' });
  await sleep(180);
  const nameHits = await evaluate(`document.querySelectorAll('.bp-search-graph .bp-quick-item').length`);
  check('按名称检索到 PRP 相关节点', nameHits >= 2, `${nameHits} 条`);
  await chord('Escape', 'Escape', 27);
  await sleep(120);

  /* ------------------------------ 6g. 检查器字段级逆向工具 */
  const rowRect = await evaluate(`(() => {
    const row = document.querySelector('.bp-ft .ft-row');
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      hit: hit ? (hit.closest('.ft-row') ? 'row' : hit.tagName + '.' + hit.className) : 'none',
      hint: !!document.querySelector('.bp-field-hint'),
      rows: document.querySelectorAll('.bp-ft .ft-row').length,
      overlay: !!document.querySelector('.bp-overlay'),
    };
  })()`);
  check('字段表显示可发现性提示', !!rowRect && rowRect.hint, JSON.stringify(rowRect));
  if (rowRect) {
    // 用真实点击锁定字段（pinned），比 hover 断言更可靠且不依赖鼠标位移历史。
    const preHit = await evaluate(`(() => {
      const hit = document.elementFromPoint(${rowRect.x}, ${rowRect.y});
      return { hit: hit ? hit.tagName + '.' + hit.className : 'none',
        rows: document.querySelectorAll('.bp-ft .ft-row').length,
        pinned: !!document.querySelector('.ft-row.pinned') };
    })()`);
    await mouse('mousePressed', rowRect.x, rowRect.y);
    await mouse('mouseReleased', rowRect.x, rowRect.y);
    await sleep(180);
    const postHit = await evaluate(`(() => ({
      pinned: !!document.querySelector('.ft-row.pinned'),
      addr: document.querySelector('.bp-field-addr-text')?.textContent ?? '',
    }))()`);
    check('点击字段锁定并显示绝对地址范围',
      /0x[0-9a-f]+/.test(postHit.addr),
      `pre=${JSON.stringify(preHit)}；post=${JSON.stringify(postHit)}`);
    const tools = await evaluate(`(() => {
      const bars = document.querySelectorAll('.bp-field-addr').length;
      const btns = [...document.querySelectorAll('.bp-field-tools .bp-ft-btn')].map(e => e.textContent);
      const selected = document.querySelector('.bp-insp-head > span')?.textContent;
      return { bars, btns, selected };
    })()`);
    check('字段工具条含复制与解析按钮',
      tools.btns.includes('值') && tools.btns.includes('地址') && tools.btns.includes('HEX'),
      JSON.stringify(tools));
  }

  /* ----------------------------------- 6h. 多级指针：偏移链 + 逐级预览 */
  // 前序查找/字段测试会把视口移到别的节点，n_sqe 可能不在可视区。
  // 用图内查找定位到 prp2 端口所在节点（回车选中并居中），再 100% 放大，
  // 避免在缩略档（38%）下端口只相距几像素而互相抢命中。
  await chord('f', 'KeyF', 70, 2);
  await sleep(140);
  await chord('a', 'KeyA', 65, 2);
  await send('Input.insertText', { text: 'prp2' });
  await sleep(220);
  await chord('Enter', 'Enter', 13);
  await sleep(260);
  await chord('1', 'Digit1', 49, 2);
  await sleep(260);
  const prp2Port = await evaluate(`(() => {
    const el = document.querySelector('[data-node-id="n_sqe"] [data-port="prp2"][data-side="out"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const owner = hit && hit.closest ? hit.closest('[data-node-id]') : null;
    return { x, y, reachable: !!hit && (hit === el || el.contains(hit)),
      hit: hit ? hit.tagName + '.' + hit.className : 'none',
      owner: owner ? owner.getAttribute('data-node-id') : null };
  })()`);
  check('SQE.prp2 输出端口可命中', !!prp2Port && prp2Port.reachable, JSON.stringify(prp2Port));
  if (prp2Port && prp2Port.reachable) {
    const n0 = await evaluate(`document.querySelectorAll('.bp-node').length`);
    const e0 = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    await mouse('mousePressed', prp2Port.x, prp2Port.y, { clickCount: 1 });
    await mouse('mouseReleased', prp2Port.x, prp2Port.y, { clickCount: 1 });
    await mouse('mousePressed', prp2Port.x, prp2Port.y, { clickCount: 2 });
    await mouse('mouseReleased', prp2Port.x, prp2Port.y, { clickCount: 2 });
    await sleep(170);
    check('跟随浮层再次打开', await evaluate(`!!document.querySelector('.bp-follow')`));

    const chainBox = await evaluate(`(() => {
      // 偏移链属于高级用法，默认折叠；先展开再量取输入框位置。
      const adv = document.querySelector('.bp-follow-advanced');
      if (adv) adv.open = true;
      const el = document.querySelector('.bp-follow-chain input');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await mouse('mousePressed', chainBox.x, chainBox.y, { buttons: 0 });
    await mouse('mouseReleased', chainBox.x, chainBox.y, { buttons: 0 });
    await sleep(90);
    await send('Input.insertText', { text: '+0x0' });
    await sleep(200);
    const previewText = await evaluate(`document.querySelector('.bp-chain-preview')?.textContent ?? ''`);
    check('偏移链逐级预览显示 0x1100 → 0x1400',
      /0x1100/.test(previewText) && /0x1400/.test(previewText) && /最终/.test(previewText),
      String(previewText).slice(0, 120));

    await chord('Enter', 'Enter', 13);
    await sleep(280);
    const n1 = await evaluate(`document.querySelectorAll('.bp-node').length`);
    const e1 = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    check('多级指针展开 2 个节点与 2 条连线',
      n1 === n0 + 2 && e1 >= e0 + 2, `节点 ${n0}→${n1}；连线 ${e0}→${e1}`);
    const titles = await evaluate(`[...document.querySelectorAll('.bp-node-title')].map(e=>e.textContent)`);
    check('画布出现「读指针」节点', titles.includes('读指针'), titles.filter((t) => t.includes('指针')).join('/'));
    const chainVals = await evaluate(`[...document.querySelectorAll('.bp-out-row')]
      .map(r => r.textContent).filter(t => /0x1400/.test(t))`);
    check('步进节点 target 输出为 0x1400', chainVals.length >= 1,
      chainVals.slice(0, 2).join(' | '));
    await chord('Escape', 'Escape', 27);
    await sleep(100);
  }

  /* --------------------------------------------- 6i. 标注节点（图上便签） */
  const noteItem = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.bp-pal-item')]
      .find(b => b.textContent.includes('标注'));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('节点库提供标注节点', !!noteItem, JSON.stringify(noteItem));
  if (noteItem) {
    const n0 = await evaluate(`document.querySelectorAll('.bp-node').length`);
    await mouse('mousePressed', noteItem.x, noteItem.y);
    await mouse('mouseReleased', noteItem.x, noteItem.y);
    await sleep(220);
    const n1 = await evaluate(`document.querySelectorAll('.bp-node').length`);
    const noteCard = await evaluate(`(() => {
      const el = document.querySelector('.bp-node[data-node-kind="note"]');
      if (!el) return null;
      return { tone: el.getAttribute('data-note-tone'),
        title: el.querySelector('.bp-node-title')?.textContent };
    })()`);
    check('单击添加标注节点并显示便签样式',
      n1 === n0 + 1 && !!noteCard && noteCard.tone === 'note',
      `${n0}→${n1}；${JSON.stringify(noteCard)}`);
    // 新节点可能落在视口之外：按 F 适配选中，把它带进可视区再操作。
    await chord('f', 'KeyF', 70, 0);
    await sleep(200);

    const area = await evaluate(`(() => {
      const el = document.querySelector('.bp-node[data-node-kind="note"] .bp-note-text');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(60, r.width / 2), y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, reachable: !!hit && (hit === el || el.contains(hit)) };
    })()`);
    check('便签文本框可命中', !!area && area.reachable, JSON.stringify(area));
    if (area && area.reachable) {
      // 真实按下才会聚焦 textarea；便签的 onPointerDown 已 stopPropagation，
      // 不会误触发节点拖动。
      await mouse('mousePressed', area.x, area.y);
      await mouse('mouseReleased', area.x, area.y);
      await sleep(100);
      await send('Input.insertText', { text: '结论：CRC 头在 0x100' });
      await sleep(220);
      const typed = await evaluate(
        `document.querySelector('.bp-node[data-node-kind="note"] .bp-note-text')?.value`,
      );
      check('画布便签可直接输入文本', typed === '结论：CRC 头在 0x100', String(typed));
      const inspSync = await evaluate(`document.querySelector('.bp-note-area')?.value`);
      check('检查器同步显示标注内容', inspSync === '结论：CRC 头在 0x100', String(inspSync));

      await chord('f', 'KeyF', 70, 2);
      await sleep(120);
      await send('Input.insertText', { text: 'CRC 头' });
      await sleep(180);
      const hits = await evaluate(`document.querySelectorAll('.bp-search-graph .bp-quick-item').length`);
      check('Ctrl+F 能检索到标注文本', hits >= 1, `${hits} 条`);
      await chord('Escape', 'Escape', 27);
      await sleep(110);
    }
  }

  /* --------------------------------- 6j. hex 与画布双向定位 */
  await chord('f', 'KeyF', 70, 2);
  await sleep(120);
  await send('Input.insertText', { text: 'n_file' });
  await sleep(160);
  await chord('Enter', 'Enter', 13);
  await sleep(200);
  check('跳转框出现在检查器（选中文件节点）',
    await evaluate(`!!document.querySelector('.bp-hex-go .in')`));

  const goBox = await evaluate(`(() => {
    const el = document.querySelector('.bp-hex-go .in');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await mouse('mousePressed', goBox.x, goBox.y);
  await mouse('mouseReleased', goBox.x, goBox.y);
  await sleep(90);
  await send('Input.insertText', { text: '0x1100' });
  await chord('Enter', 'Enter', 13);
  await sleep(200);
  const jumpState = await evaluate(`(() => {
    const h = document.querySelector('.hexview.virtual');
    return {
      top: h?.scrollTop ?? 0,
      sel: !!document.querySelector('.hb.sel'),
      range: document.querySelector('.bp-hex-range')?.textContent.trim() ?? '',
      bar: document.querySelector('.bp-field-addr .bp-field-addr-text')?.textContent ?? '',
    };
  })()`);
  check('跳转 0x1100 后滚动到目标并显示选中位点',
    jumpState.top > 0 && jumpState.sel && /0x1100/.test(jumpState.bar),
    JSON.stringify(jumpState));

  const byte = await evaluate(`(() => {
    const host = document.querySelector('.hexview.virtual');
    const hr = host.getBoundingClientRect();
    // 跳过视口上方的 overscan 行，点真正可见的字节
    const el = [...host.querySelectorAll('.hb')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= hr.top + 24 && r.bottom <= hr.bottom - 8;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { addr: el.dataset.addr, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (byte) {
    await mouse('mousePressed', byte.x, byte.y);
    await mouse('mouseReleased', byte.x, byte.y);
  }
  await sleep(160);
  const pickedInfo = await evaluate(`(() => ({
    sel: !!document.querySelector('.hb.sel'),
    bar: document.querySelector('.bp-field-addr .bp-field-addr-text')?.textContent ?? '',
  }))()`);
  const expectedHex = `0x${(0x1000 + Number(byte?.addr ?? -0x1000)).toString(16)}`;
  check('点击字节即选中并在缓冲区中定位',
    !!byte && pickedInfo.sel && pickedInfo.bar.toLowerCase().includes(expectedHex),
    JSON.stringify({ expectedHex, pickedInfo }));

  const followBtn = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.bp-field-addr .bp-ft-btn.go')].at(-1);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (followBtn) {
    await mouse('mousePressed', followBtn.x, followBtn.y);
    await mouse('mouseReleased', followBtn.x, followBtn.y);
    await sleep(160);
    const followText = await evaluate(`document.querySelector('.bp-follow')?.textContent ?? ''`);
    check('hex 点选字节可直接跟随解析',
      /在此地址解析/.test(followText) && followText.toLowerCase().includes(expectedHex),
      String(followText).slice(0, 60));
    await chord('Escape', 'Escape', 27);
    await sleep(110);
  }

  /* ------------------------------------- 6m. 检查器缓冲区：滚动 / 跳转 / 展开 */
  const selectNode = (id) => evaluate(`(() => {
    const n = document.querySelector('[data-node-id="${id}"]');
    if (!n) return false;
    const h = n.querySelector('.bp-node-head') ?? n;
    const r = h.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 };
    h.dispatchEvent(new PointerEvent('pointerdown', opts));
    h.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  })()`);
  await selectNode('n_file');
  await sleep(450);
  const hexBox = await evaluate(`(() => {
    const h = document.querySelector('.bp-insp-body .hexview.virtual');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
      clientH: h.clientHeight, scrollH: h.scrollHeight,
      rows: h.querySelectorAll('.hex-row').length,
      range: document.querySelector('.bp-hex-range')?.textContent.trim() ?? '' };
  })()`);
  check('缓冲区覆盖整份转储且可滚动',
    !!hexBox && hexBox.scrollH > hexBox.clientH + 200 && hexBox.rows < 60
      && /共 4096 B/.test(hexBox.range),
    JSON.stringify(hexBox));
  if (hexBox) {
    const topBefore = await evaluate(`document.querySelector('.bp-hex-range')?.textContent ?? ''`);
    await mouse('mouseWheel', hexBox.x, hexBox.y, { deltaX: 0, deltaY: 480, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(260);
    const scrolled = await evaluate(`(() => {
      const h = document.querySelector('.bp-insp-body .hexview.virtual');
      return { top: h?.scrollTop ?? 0, rows: h?.querySelectorAll('.hex-row').length ?? 0,
        range: document.querySelector('.bp-hex-range')?.textContent.trim() ?? '',
        first: h?.querySelector('.hex-row .hex-addr')?.textContent ?? '' };
    })()`);
    check('滚轮滚动缓冲区并同步顶部地址',
      scrolled.top > 0 && scrolled.rows < 60 && scrolled.range !== topBefore,
      JSON.stringify({ topBefore, scrolled }));

    await evaluate(`(() => {
      const i = document.querySelector('input[aria-label="跳转到缓冲区地址"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, '0x11F0');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.bp-insp-body button')].find((b) => b.textContent.trim() === '跳转')?.click();
    })()`);
    await sleep(300);
    const jumped = await evaluate(`(() => {
      const host = document.querySelector('.bp-insp-body .hexview.virtual');
      const sel = host?.querySelector('.hb.sel');
      const hr = host?.getBoundingClientRect();
      const sr = sel?.getBoundingClientRect();
      return {
        top: host?.scrollTop ?? 0,
        picked: document.querySelector('.bp-field-addr-text')?.textContent.trim() ?? '',
        sel: !!sel,
        visible: !!hr && !!sr && sr.top >= hr.top + 20 && sr.bottom <= hr.bottom,
      };
    })()`);
    check('跳转滚动到目标并保留试读位点',
      jumped.top > 0 && /0x11f0/i.test(jumped.picked) && jumped.sel && jumped.visible,
      JSON.stringify(jumped));

    const box2 = await evaluate(`(() => {
      const h = document.querySelector('.bp-insp-body .hexview.virtual');
      const r = h.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: h.scrollTop };
    })()`);
    await evaluate(`[...document.querySelectorAll('.bp-insp-body button')].find((b) => b.textContent.trim() === '展开')?.click()`);
    await sleep(320);
    const expanded = await evaluate(`(() => {
      const o = document.querySelector('.bp-hex-expanded');
      const h = o?.querySelector('.hexview.virtual');
      const p = document.querySelector('.bp-inspector')?.getBoundingClientRect();
      const r = o?.getBoundingClientRect();
      return { open: !!o, fill: !!r && !!p && Math.abs(r.height - p.height) < 4,
        hexH: h?.clientHeight ?? 0, scrollTop: h?.scrollTop ?? 0 };
    })()`);
    check('展开缓冲区占满检查器并保持阅读位置',
      expanded.open && expanded.fill && expanded.hexH > 300
        && Math.abs(expanded.scrollTop - box2.top) < 40,
      JSON.stringify({ box2, expanded }));
    await key('keyDown', 'Escape', 'Escape', 27);
    await key('keyUp', 'Escape', 'Escape', 27);
    await sleep(260);
    const collapsed = await evaluate(`(() => ({
      closed: !document.querySelector('.bp-hex-expanded'),
      top: document.querySelector('.bp-insp-body .hexview.virtual')?.scrollTop ?? 0,
    }))()`);
    check('Esc 收起缓冲区并保留位置',
      collapsed.closed && Math.abs(collapsed.top - expanded.scrollTop) < 40,
      JSON.stringify({ expandedTop: expanded.scrollTop, collapsed }));
  }

  /* -------------------------------- 6n. 结构体 → 来源文件的完整缓冲区 */
  await selectNode('n_sqe');
  await sleep(450);
  const openLink = await evaluate(`(() => {
    const b = document.querySelector('.bp-hex-open');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(450);
  const linked = await evaluate(`(() => ({
    title: document.querySelector('.bp-node.on .bp-node-title')?.textContent ?? '',
    picked: document.querySelector('.bp-field-addr-text')?.textContent.trim() ?? '',
    sel: !!document.querySelector('.bp-insp-body .hb.sel'),
    hex: !!document.querySelector('.bp-insp-body .hexview.virtual'),
  }))()`);
  check('结构体「在缓冲区打开」选中来源文件并定位',
    openLink && linked.title.includes('载入转储') && /0x1000/.test(linked.picked) && linked.sel && linked.hex,
    JSON.stringify(linked));

  /* ------------------------------------------- 6k. 一键自动布局 */
  const layoutBtn = await evaluate(`(() => {
    const el = document.querySelector('button[aria-label="自动布局"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('顶栏提供布局按钮', !!layoutBtn, JSON.stringify(layoutBtn));
  if (layoutBtn) {
    const before = await evaluate(`(() => {
      const out = {};
      document.querySelectorAll('.bp-node').forEach((el) => {
        out[el.getAttribute('data-node-id')] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      });
      return out;
    })()`);
    await mouse('mousePressed', layoutBtn.x, layoutBtn.y);
    await mouse('mouseReleased', layoutBtn.x, layoutBtn.y);
    await sleep(320);
    const after = await evaluate(`(() => {
      const out = {};
      document.querySelectorAll('.bp-node').forEach((el) => {
        out[el.getAttribute('data-node-id')] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      });
      return out;
    })()`);
    const moved = Object.keys(after).filter((id) => before[id]
      && (before[id].x !== after[id].x || before[id].y !== after[id].y)).length;
    check('布局移动了有连线的节点', moved >= 10, `${moved} 个节点位移`);

    // 层级：n_file 无上游应在最左；n_sq 的下游 n_sqe 在其右侧
    const fx = after.n_file?.x; const sx = after.n_sq?.x; const ex = after.n_sqe?.x;
    check('数据流方向从左到右（file → sq → sqe）', fx < sx && sx < ex,
      `file=${fx} sq=${sx} sqe=${ex}`);

    // 不重叠：两两比较矩形面积交
    const ids = Object.keys(after);
    const countOverlaps = (map) => {
      const ks = Object.keys(map);
      let n = 0;
      const pairs = [];
      for (let i = 0; i < ks.length; i += 1) {
        for (let j = i + 1; j < ks.length; j += 1) {
          const a = map[ks[i]]; const b = map[ks[j]];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 4 && oy > 4) { n += 1; pairs.push(`${ks[i]}×${ks[j]}`); }
        }
      }
      return { n, pairs };
    };
    const beforeOv = countOverlaps(before);
    const afterOv = countOverlaps(after);
    // 自动布局只负责它重排的主图；保持原位的孤立节点若是本来就叠在一起，
    // 不算布局引入的问题——验收标准是「不引入新的重叠」。
    check('布局不引入新的重叠', afterOv.n <= beforeOv.n,
      `前 ${beforeOv.n} 处（${beforeOv.pairs.join(',')}）→ 后 ${afterOv.n} 处（${afterOv.pairs.join(',')}）`);
    const toastText = await evaluate(`document.querySelector('.toast')?.textContent ?? ''`);
    check('布局后提示重排数量', /重排/.test(toastText), toastText);
  }

  /* ------------------------------------------- 6l. 空画布引导 */
  await chord('a', 'KeyA', 65, 2);
  await chord('Delete', 'Delete', 46);
  await sleep(280);
  const emptyState = await evaluate(`(() => ({
    nodes: document.querySelectorAll('.bp-node').length,
    hint: document.querySelector('.bp-canvas-empty')?.textContent ?? '',
  }))()`);
  check('清空画布后显示操作引导',
    emptyState.nodes === 0 && /从左侧节点库/.test(emptyState.hint) && /Ctrl\+L/.test(emptyState.hint),
    JSON.stringify(emptyState));

  /* --------------------------------- 6m. 新节点继承下拉配置（少一步设置） */
  const readItem = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.bp-pal-item')]
      .find(b => b.textContent.includes('读数值'));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const addRead = async () => {
    await mouse('mousePressed', readItem.x, readItem.y);
    await mouse('mouseReleased', readItem.x, readItem.y);
    await sleep(220);
  };
  const setSize = async (v) => {
    await evaluate(`(() => {
      const el = document.querySelector('label.bp-param:not(.bp-src-param) select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(v)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(120);
  };
  const readSize = () => evaluate(
    `document.querySelector('label.bp-param:not(.bp-src-param) select')?.value ?? ''`,
  );
  if (readItem) {
    await addRead();
    check('新读数值默认类型 u32', (await readSize()) === 'u32', String(await readSize()));
    await setSize('u16');
    check('检查器可改宽度为 u16', (await readSize()) === 'u16', String(await readSize()));
    await addRead();
    check('再添加的读数值自动继承 u16', (await readSize()) === 'u16', String(await readSize()));
    await setSize('u32');
  }

  /* ------------------------- 6j. 数据源接受字符串、拒绝无内容的来源 */
  // 字符串/字节输出本身就是数据源内容（基址 0）；数字常量这类没有内容可传，
  // 拖线时应显示不可接（no），松手给出提示且不产生连线。
  await chord('0', 'Digit0', 48, 2);
  await sleep(220);
  const quickAdd = async (label) => {
    await chord('k', 'KeyK', 75, 2);
    await sleep(140);
    await send('Input.insertText', { text: label });
    await sleep(160);
    await chord('Enter', 'Enter', 13);
    await sleep(240);
    return evaluate(`[...document.querySelectorAll('.bp-node')].at(-1)?.dataset.nodeId ?? ''`);
  };
  const constId = await quickAdd('文本常量');
  const textId = await quickAdd('读字符串');
  await chord('1', 'Digit1', 49, 2); // 100%：确保端口行渲染
  await sleep(260);
  const portAt = (id, port, side) => evaluate(`(() => {
    const el = document.querySelector('[data-node-id="${id}"] [data-port="${port}"][data-side="${side}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, reachable: !!hit && (hit === el || el.contains(hit)) };
  })()`);
  const dragTo = async (from, to) => {
    await mouse('mousePressed', from.x, from.y, { clickCount: 1 });
    await mouse('mouseMoved', from.x + 24, from.y + 24, { clickCount: 0 });
    await sleep(90);
    await mouse('mouseMoved', to.x, to.y, { clickCount: 0 });
    await sleep(140);
  };
  const lenOut = constId ? await portAt(constId, 'length', 'out') : null;
  const textIn = textId ? await portAt(textId, 'buffer', 'in') : null;
  const textOut = constId ? await portAt(constId, 'text', 'out') : null;
  check('文本常量 / 字符串读取已添加且端口可命中',
    !!constId && !!textId && !!lenOut?.reachable && !!textIn?.reachable && !!textOut?.reachable,
    JSON.stringify({ constId, textId, lenOut, textIn, textOut }));

  if (lenOut?.reachable && textIn?.reachable) {
    const edgesBefore = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    await dragTo(lenOut, textIn);
    const cls = await evaluate(
      `document.querySelector('[data-node-id="${textId}"] [data-port="buffer"][data-side="in"]')?.className ?? ''`,
    );
    check('数字输出拖到数据源时端口标记不可接', /\bno\b/.test(cls), cls);
    await mouse('mousePressed', textIn.x, textIn.y, { clickCount: 1 });
    await mouse('mouseReleased', textIn.x, textIn.y, { clickCount: 1 });
    await sleep(320);
    const warn = await evaluate(`document.querySelector('.bp-wire-error')?.textContent ?? ''`);
    const edgesAfter = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    check('无内容的来源不能接数据源：给出提示且不新增连线',
      /不携带文件或字符串/.test(warn) && edgesAfter === edgesBefore,
      `${warn.slice(0, 60)} · 连线 ${edgesBefore}→${edgesAfter}`);
    await sleep(1200); // 等气泡退场
  }

  if (textOut?.reachable && textIn?.reachable) {
    const edgesBefore = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    await dragTo(textOut, textIn);
    const cls = await evaluate(
      `document.querySelector('[data-node-id="${textId}"] [data-port="buffer"][data-side="in"]')?.className ?? ''`,
    );
    check('字符串拖到数据源时端口标记可接', /\bok\b/.test(cls), cls);
    await mouse('mousePressed', textIn.x, textIn.y, { clickCount: 1 });
    await mouse('mouseReleased', textIn.x, textIn.y, { clickCount: 1 });
    await sleep(320);
    const edgesAfter = await evaluate(`document.querySelectorAll('[data-edge-id]').length`);
    const row = await evaluate(
      `document.querySelector('[data-node-id="${textId}"] .bp-wired-val')?.textContent ?? ''`,
    );
    check('字符串可以当数据源：连线成立且显示「字符串」',
      edgesAfter === edgesBefore + 1 && /字符串/.test(row),
      `${row.slice(0, 30)} · 连线 ${edgesBefore}→${edgesAfter}`);
  }

  /* -------------------------------------------------------- console errors */
  const severe = events.filter((e) =>
    e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'
    || e.method === 'Runtime.exceptionThrown');
  check('无未捕获异常 / console error', severe.length === 0,
    severe.slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));
}

let exitCode = 0;
try {
  await main();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) exitCode = 1;
} catch (e) {
  console.error('CDP 验证异常：', e);
  exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(exitCode);
