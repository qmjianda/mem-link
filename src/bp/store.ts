/**
 * Pack 商店：索引格式、地址归一化、抓取与版本/哈希校验。
 *
 * 商店是一个静态 JSON 索引 + 相对路径的 `.bp.ts` 文件。默认走 jsDelivr 的
 * GitHub 镜像，因此不需要后端；打开商店和安装 pack 是仅有的联网动作。
 * 安装后的源码写入蓝图/缓存，离线仍可使用。
 */

import type { PackStoreRef } from './docstate';

export const STORE_FORMAT = 'memlink-pack-store/1';
/**
 * 默认用 jsDelivr 的 GitHub 镜像：跨域稳定，且发布脚本会主动 purge 缓存。
 * 不可达时自动回退到 GitHub Pages / raw.githubusercontent.com。
 */
export const DEFAULT_STORE_URL =
  'https://cdn.jsdelivr.net/gh/qmjianda/mem-link-packs@main/index.json';
export const KEY_STORE_PREFS = 'memlink:store:v1';
export const KEY_STORE_CACHE = 'memlink:store:cache:v1';
/** 索引和单个 pack 的抓取上限，避免误把大文件当商店内容 */
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_PACK_BYTES = 2 * 1024 * 1024;
/** 参考蓝图最多带一个几 KB 的示例缓冲区，超过这个上限就视为商店内容异常 */
export const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

export interface StoreSource {
  provider?: string;
  id?: string;
  format?: string;
  path?: string;
  url?: string;
  license?: string;
}

/** pack 目录附带的参考蓝图；下载后可直接作为临时示例打开 */
export interface StoreReference {
  path: string;
  sha256?: string;
  size?: number;
}

export interface StorePackEntry {
  id: string;
  name: string;
  version: string;
  category: string;
  order?: number;
  summary: string;
  description?: string;
  tags?: string[];
  author?: string;
  license?: string;
  homepage?: string;
  featured?: boolean;
  coverage?: 'complete' | 'partial';
  /** 动态辅助节点数量（calc/list/array/变体），partial 布局仍可用 */
  helpers?: number;
  source?: StoreSource;
  path: string;
  sha256?: string;
  size?: number;
  /** 参考蓝图（pack 目录下的 reference.blueprint.json） */
  reference?: StoreReference;
}

export interface StoreIndex {
  format: string;
  name?: string;
  description?: string;
  homepage?: string;
  updatedAt?: string;
  packs: StorePackEntry[];
}

export interface StoreParseResult {
  index?: StoreIndex;
  error?: string;
  warnings: string[];
}

export interface StoreFetchResult {
  url: string;
  index: StoreIndex;
  warnings: string[];
  bytes: number;
}

export type StoreInstallState = 'available' | 'installed' | 'update' | 'ahead';

export const STORE_CATEGORY_LABELS: Record<string, string> = {
  all: '全部',
  database: '数据库',
  image: '图像',
  archive: '压缩包',
  executable: '可执行文件',
  system: '系统',
  game: '游戏',
  media: '媒体',
  model: '模型',
  network: '网络',
  data: '数据',
  font: '字体',
  other: '其他',
};

export function categoryLabel(id: string): string {
  return STORE_CATEGORY_LABELS[id] ?? id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把用户输入统一成一个 `index.json` 地址。
 *
 * 支持：
 *   - `owner/repo`
 *   - `https://github.com/owner/repo`（默认 main 分支）
 *   - `https://github.com/owner/repo/tree/<branch>`
 *   - 任意以 `index.json` 结尾的 URL
 *   - 目录 URL（自动补 `index.json`）
 */
export function normalizeStoreUrl(input: string): string {
  let raw = input.trim();
  if (!raw) return DEFAULT_STORE_URL;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) raw = `https://github.com/${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('商店地址不是有效 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('商店地址必须使用 http(s)');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('GitHub 地址需要 owner/repo');
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    let branch = 'main';
    if (parts[2] === 'tree' && parts[3]) branch = parts.slice(3).join('/');
    else if (parts[2] === 'blob' && parts[3]) {
      // https://github.com/o/r/blob/main/index.json
      return `https://raw.githubusercontent.com/${owner}/${repo}/${parts.slice(3).join('/')}`;
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/index.json`;
  }

  if (host === 'raw.githubusercontent.com') {
    if (/\.json$/i.test(url.pathname)) return url.toString();
    // owner/repo/branch 目录
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 3) {
      url.pathname = `/${parts.slice(0, 3).join('/')}/index.json`;
      return url.toString();
    }
  }

  if (/\.json$/i.test(url.pathname)) return url.toString();
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/index.json`;
  return url.toString();
}

/** 把索引里的相对路径解析成实际文件 URL。 */
export function resolveStorePackUrl(indexUrl: string, path: string): string {
  return new URL(path, indexUrl).toString();
}

/** 版本号比较：按数字段比较，忽略预发布后缀。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const base = v.trim().replace(/^v/i, '').split('-')[0].split('+')[0];
    const parts = base.split('.').map((x) => {
      const n = Number.parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function installState(installedVersion: string | undefined, entryVersion: string): StoreInstallState {
  if (!installedVersion) return 'available';
  const c = compareVersions(installedVersion, entryVersion);
  if (c === 0) return 'installed';
  return c < 0 ? 'update' : 'ahead';
}

/** 两个商店地址是否指向同一个索引（允许 GitHub Pages / raw / jsDelivr 镜像等价）。 */
export function sameStoreUrl(a: string, b: string): boolean {
  if (a === b) return true;
  return alternateStoreUrls(a).includes(b) || alternateStoreUrls(b).includes(a);
}

/** 找到同一商店、同一 pack id 的已安装记录。 */
export function installedPackOf<T extends { store?: PackStoreRef }>(
  packs: T[],
  storeUrl: string,
  packId: string,
): T | undefined {
  return packs.find((p) => p.store?.packId === packId && !!p.store && sameStoreUrl(p.store.url, storeUrl));
}

function validateEntry(raw: unknown, i: number, warnings: string[]): StorePackEntry | string {
  if (!isRecord(raw)) return `packs[${i}] 不是对象`;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return `packs[${i}].id 非法：${String(raw.id)}`;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return `packs[${i}] (${id}) 缺少 name`;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!version) return `packs[${i}] (${id}) 缺少 version`;
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'other';
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : name;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) return `packs[${i}] (${id}) 缺少 path`;
  if (!/\.bp\.ts$/i.test(path)) return `packs[${i}] (${id}) 的 path 不是 .bp.ts`;
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : undefined;
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) return `packs[${i}] (${id}) 的 sha256 非法`;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : undefined;
  const coverage = raw.coverage === 'partial' ? 'partial' : raw.coverage === 'complete' ? 'complete' : undefined;
  const helpers = typeof raw.helpers === 'number' && Number.isFinite(raw.helpers) && raw.helpers > 0 ? raw.helpers : undefined;
  const source = isRecord(raw.source) ? (raw.source as StoreSource) : undefined;
  let reference: StoreReference | undefined;
  if (isRecord(raw.reference)) {
    const refPath = typeof raw.reference.path === 'string' ? raw.reference.path.trim() : '';
    if (!/\.blueprint\.json$/i.test(refPath)) {
      warnings.push(`packs[${i}] (${id}) 的 reference.path 不是 .blueprint.json`);
    } else {
      const refSha = typeof raw.reference.sha256 === 'string' ? raw.reference.sha256.trim().toLowerCase() : undefined;
      if (refSha && !/^[0-9a-f]{64}$/.test(refSha)) {
        warnings.push(`packs[${i}] (${id}) 的 reference.sha256 非法`);
      } else {
        reference = {
          path: refPath,
          ...(refSha ? { sha256: refSha } : {}),
          ...(typeof raw.reference.size === 'number' && Number.isFinite(raw.reference.size) && raw.reference.size >= 0
            ? { size: raw.reference.size } : {}),
        };
      }
    }
  } else if (raw.reference !== undefined) {
    warnings.push(`packs[${i}] (${id}) 的 reference 不是对象`);
  }
  if (typeof raw.order === 'number' && !Number.isFinite(raw.order)) {
    warnings.push(`packs[${i}] (${id}) 的 order 不是有限数字，已忽略`);
  }
  return {
    id,
    name,
    version,
    category,
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}),
    summary,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(tags ? { tags } : {}),
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
    ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}),
    ...(raw.featured === true ? { featured: true } : {}),
    ...(coverage ? { coverage } : {}),
    ...(helpers ? { helpers } : {}),
    ...(source ? { source } : {}),
    path,
    ...(sha256 ? { sha256 } : {}),
    ...(typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
    ...(reference ? { reference } : {}),
  };
}

export function parseStoreIndex(text: string): StoreParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `商店索引不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, warnings: [] };
  }
  if (!isRecord(raw)) return { error: '商店索引必须是对象', warnings: [] };
  if (raw.format !== STORE_FORMAT) {
    return { error: `不支持的商店格式：${String(raw.format)}（需要 ${STORE_FORMAT}）`, warnings: [] };
  }
  if (!Array.isArray(raw.packs)) return { error: '商店索引缺少 packs 数组', warnings: [] };

  const warnings: string[] = [];
  const packs: StorePackEntry[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.packs.length; i += 1) {
    const entry = validateEntry(raw.packs[i], i, warnings);
    if (typeof entry === 'string') {
      warnings.push(entry);
      continue;
    }
    if (ids.has(entry.id)) {
      warnings.push(`重复的 pack id：${entry.id}（保留第一个）`);
      continue;
    }
    ids.add(entry.id);
    packs.push(entry);
  }
  if (!packs.length) return { error: '商店索引没有可用的 pack', warnings };
  packs.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));
  return {
    index: {
      format: STORE_FORMAT,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}),
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      packs,
    },
    warnings,
  };
}

async function readCapped(res: Response, limit: number): Promise<string> {
  const text = await res.text();
  if (new TextEncoder().encode(text).length > limit) {
    throw new Error(`内容超过 ${Math.round(limit / 1024)} KB 上限`);
  }
  return text;
}

/** fetch + 超时；调用方的 signal 仍可提前取消。 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted && !outer?.aborted) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** 同一商店的镜像地址：GitHub Pages / raw / jsDelivr。 */
export function alternateStoreUrls(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  const host = u.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 4) {
      const [owner, repo, branch, ...rest] = parts;
      const path = rest.join('/');
      out.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`);
      if (branch === 'main') out.push(`https://${owner}.github.io/${repo}/${path}`);
    }
  } else if (host === 'cdn.jsdelivr.net') {
    const m = /^\/gh\/([^/]+)\/([^@/]+)@([^/]+)\/(.+)$/.exec(u.pathname);
    if (m) {
      const [, owner, repo, branch, path] = m;
      out.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
      if (branch === 'main') out.push(`https://${owner}.github.io/${repo}/${path}`);
    }
  } else if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    const parts = u.pathname.split('/').filter(Boolean);
    if (owner && parts.length >= 2) {
      const [repo, ...rest] = parts;
      const path = rest.join('/');
      out.push(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`);
      out.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/${path}`);
    }
  }
  return [...new Set(out)].filter((x) => x !== url);
}

export const STORE_TIMEOUT_MS = 10_000;
export const PACK_TIMEOUT_MS = 12_000;

/** 依次尝试原地址与 Pages / raw / jsDelivr 镜像；返回实际成功的地址。 */
async function fetchTextWithMirror(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ url: string; text: string; bytes: number }> {
  const candidates = [url, ...alternateStoreUrls(url)];
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error('已取消');
    try {
      const res = await fetchWithTimeout(fetchImpl, candidate, { ...init, signal }, timeoutMs);
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const text = await readCapped(res, limit);
      return { url: candidate, text, bytes: new TextEncoder().encode(text).length };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (signal?.aborted) throw lastError;
    }
  }
  throw lastError ?? new Error('请求失败');
}

export async function fetchStoreIndex(
  input: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<StoreFetchResult> {
  const url = normalizeStoreUrl(input);
  let fetched: { url: string; text: string; bytes: number };
  try {
    fetched = await fetchTextWithMirror(
      fetchImpl, url, { cache: 'no-store', headers: { Accept: 'application/json' } },
      STORE_TIMEOUT_MS, MAX_INDEX_BYTES, signal,
    );
  } catch (e) {
    throw new Error(`无法访问商店（网络或 CORS）：${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseStoreIndex(fetched.text);
  if (!parsed.index) throw new Error(parsed.error ?? '商店索引无效');
  return { url: fetched.url, index: parsed.index, warnings: parsed.warnings, bytes: fetched.bytes };
}

export async function fetchStorePack(
  indexUrl: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ url: string; source: string }> {
  const url = resolveStorePackUrl(indexUrl, path);
  let fetched: { url: string; text: string; bytes: number };
  try {
    fetched = await fetchTextWithMirror(
      fetchImpl, url, { cache: 'no-store' }, PACK_TIMEOUT_MS, MAX_PACK_BYTES, signal,
    );
  } catch (e) {
    throw new Error(`无法下载 pack：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!fetched.text.includes('definePack')) throw new Error('下载内容不像一个 .bp.ts pack');
  return { url: fetched.url, source: fetched.text };
}

export async function fetchStoreReference(
  indexUrl: string,
  reference: StoreReference,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ url: string; text: string }> {
  const url = resolveStorePackUrl(indexUrl, reference.path);
  let fetched: { url: string; text: string; bytes: number };
  try {
    fetched = await fetchTextWithMirror(
      fetchImpl, url, { cache: 'no-store', headers: { Accept: 'application/json' } },
      PACK_TIMEOUT_MS, MAX_REFERENCE_BYTES, signal,
    );
  } catch (e) {
    throw new Error(`无法下载参考蓝图：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!fetched.text.includes('memlink-blueprint/3')) throw new Error('下载内容不像 mem-link 蓝图');
  if (reference.sha256) {
    const verified = await verifyPackSource(fetched.text, reference.sha256);
    if (!verified.ok) throw new Error(`参考蓝图校验失败：${verified.error ?? '哈希不匹配'}`);
  }
  return { url: fetched.url, text: fetched.text };
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 SHA-256 校验');
  const data = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPackSource(
  source: string,
  expected?: string,
): Promise<{ ok: boolean; actual?: string; error?: string }> {
  if (!expected) return { ok: true };
  try {
    const actual = await sha256Hex(source);
    if (actual !== expected.toLowerCase()) {
      return { ok: false, actual, error: `哈希不匹配：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…` };
    }
    return { ok: true, actual };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface StorePrefs {
  url: string;
}

export function readStorePrefs(): StorePrefs {
  try {
    const raw = window.localStorage.getItem(KEY_STORE_PREFS);
    if (raw) {
      const env = JSON.parse(raw) as { version?: number; url?: unknown };
      if (env.version === 1 && typeof env.url === 'string') {
        return { url: normalizeStoreUrl(env.url) };
      }
    }
  } catch {
    /* 隐私模式 / 坏 JSON：使用默认地址 */
  }
  return { url: DEFAULT_STORE_URL };
}

export function writeStorePrefs(prefs: StorePrefs): void {
  try {
    window.localStorage.setItem(KEY_STORE_PREFS, JSON.stringify({ version: 1, url: prefs.url }));
  } catch {
    /* 存储不可用时只保留内存态 */
  }
}

export interface StoreCache {
  url: string;
  at: number;
  index: StoreIndex;
}

export function readStoreCache(url: string): StoreCache | null {
  try {
    const raw = window.localStorage.getItem(KEY_STORE_CACHE);
    if (!raw) return null;
    const env = JSON.parse(raw) as { version?: number; url?: string; at?: number; index?: unknown };
    if (env.version !== 1 || env.url !== url || !isRecord(env.index)) return null;
    const parsed = parseStoreIndex(JSON.stringify(env.index));
    if (!parsed.index) return null;
    return { url, at: typeof env.at === 'number' ? env.at : 0, index: parsed.index };
  } catch {
    return null;
  }
}

export function writeStoreCache(cache: StoreCache): void {
  try {
    window.localStorage.setItem(
      KEY_STORE_CACHE,
      JSON.stringify({ version: 1, url: cache.url, at: cache.at, index: cache.index }),
    );
  } catch {
    /* 超配额或隐私模式：忽略 */
  }
}

/** 商店条目上的来源标签（Nybble / ImHex / 手工）。 */
export function sourceLabel(entry: StorePackEntry): string {
  const provider = entry.source?.provider;
  if (provider === 'nybble') return 'Nybble';
  if (provider === 'imhex') return 'ImHex';
  return '手工';
}
