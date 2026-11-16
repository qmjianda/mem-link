/**
 * Zoom frame-rate check on the 201-node / 373-edge benchmark graph.
 * Usage: node scripts/cdp-perf.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = `file:///${root.replace(/\\/g, '/')}/dist/index.html`;
const perf = JSON.parse(readFileSync(join(root, 'samples/perf.big.blueprint.json'), 'utf8'));
const payload = JSON.stringify({
  version: 1, savedAt: Date.now(),
  packs: perf.packs.map((p) => ({ ...p, enabled: true })),
  nodes: perf.nodes, edges: perf.edges,
});
const profile = mkdtempSync(join(tmpdir(), 'memlink-perf-'));
const PORT = 9334;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--no-first-run', '--disable-gpu',
  '--no-default-browser-check', '--window-size=1600,1000', url,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let seq = 0;
const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

async function main() {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* starting */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('Chrome did not start');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.bp-node')`)) break;
    await sleep(150);
  }

  // Inject the benchmark graph and reload so the app boots from it.
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('memlink:graph:v1', ${JSON.stringify(payload)})`,
  });
  await send('Page.reload', { ignoreCache: true });
  await sleep(1800);

  const counts = await evaluate(`(() => ({
    total: ${perf.nodes.length},
    dom: document.querySelectorAll('.bp-node').length,
    edges: document.querySelectorAll('[data-edge-id]').length,
  }))()`);
  console.log(`基准图：${counts.total} 节点 / ${perf.edges.length} 连线；当前绘制 ${counts.dom} 节点 / ${counts.edges} 连线（视口裁剪）`);

  const rect = await evaluate(`(() => { const r = document.querySelector('.bp-canvas').getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);

  // Start an rAF sampler, then drive 80 wheel events at ~16ms intervals.
  await send('Runtime.evaluate', {
    expression: `window.__fps = new Promise((done) => {
      let frames = 0; const t0 = performance.now();
      const tick = () => { frames++; const dt = performance.now() - t0;
        if (dt < 2500) requestAnimationFrame(tick); else done(frames / (dt / 1000)); };
      requestAnimationFrame(tick);
    });`,
  });
  for (let i = 0; i < 80; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(rect.x), y: Math.round(rect.y),
      deltaX: 0, deltaY: i % 2 ? -60 : 60, button: 'none', buttons: 0, clickCount: 0,
    });
    await sleep(18);
  }
  const fps = await evaluate(`window.__fps`);
  const ms = await evaluate(`document.querySelector('.statusbar')?.textContent`);
  console.log(`缩放期间平均帧率：${Number(fps).toFixed(1)} fps（80 次滚轮事件 / 2.5s）`);
  console.log(`状态栏：${String(ms).trim()}`);
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
