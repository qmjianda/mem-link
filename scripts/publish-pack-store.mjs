#!/usr/bin/env node
/**
 * 把主仓库的 `store/` 发布到独立的 GitHub pack 商店仓库。
 *
 * 用法：
 *   node scripts/publish-pack-store.mjs --dry-run
 *   node scripts/publish-pack-store.mjs
 *   node scripts/publish-pack-store.mjs --repo git@github.com:me/my-packs.git --branch main
 *
 * 默认目标：https://github.com/qmjianda/mem-link-packs
 * 商店仓库是 `store/` 的镜像；pack 源码仍在主仓库维护与测试。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {
    repo: 'git@github.com:qmjianda/mem-link-packs.git',
    branch: 'main',
    message: '',
    dryRun: false,
    noPush: false,
    noPurge: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-push') out.noPush = true;
    else if (a === '--no-purge') out.noPurge = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/publish-pack-store.mjs [--repo URL] [--branch main] [--message TEXT] [--dry-run] [--no-push] [--no-purge]');
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${a}`);
    }
  }
  return out;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
}

function parseGitHubRepo(repo) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repo.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 推送后刷新 jsDelivr 的 @branch 缓存；失败只警告，不影响发布。 */
async function purgeJsDelivr(repo, branch) {
  const gh = parseGitHubRepo(repo);
  if (!gh) return;
  const base = `https://purge.jsdelivr.net/gh/${gh.owner}/${gh.repo}@${branch}`;
  for (const path of ['/*', '/index.json']) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`✓ 已请求 jsDelivr 刷新缓存 ${path}`);
    } catch (e) {
      console.warn(`! jsDelivr 缓存刷新失败（${path}，不影响发布）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = resolve(process.cwd());
  const source = join(repoRoot, 'store');
  if (!existsSync(source)) throw new Error('找不到 store/ 目录');

  console.log('→ 生成参考蓝图');
  execFileSync(process.execPath, [join(source, 'scripts', 'build-references.mjs'), '--root', source], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  console.log('→ 生成 index.json');
  execFileSync(process.execPath, [join(source, 'scripts', 'build-index.mjs'), source], {
    stdio: 'inherit',
    cwd: repoRoot,
  });

  const cacheRoot = join(repoRoot, '.cache');
  mkdirSync(cacheRoot, { recursive: true });
  const clone = join(cacheRoot, 'pack-store-publish');

  if (existsSync(join(clone, '.git'))) {
    console.log(`→ 更新本地镜像 ${clone}`);
    git(clone, ['fetch', 'origin', args.branch], { capture: true });
    git(clone, ['checkout', args.branch], { capture: true });
    git(clone, ['reset', '--hard', `origin/${args.branch}`], { capture: true });
    git(clone, ['clean', '-fdx'], { capture: true });
  } else {
    rmSync(clone, { recursive: true, force: true });
    console.log(`→ 克隆 ${args.repo}`);
    git(cacheRoot, ['clone', '--depth=1', '--branch', args.branch, args.repo, clone]);
  }

  // 清空工作树（保留 .git），再复制 store/ 的内容。
  for (const name of readdirSync(clone)) {
    if (name === '.git') continue;
    rmSync(join(clone, name), { recursive: true, force: true });
  }
  cpSync(source, clone, {
    recursive: true,
    filter: (src) => !src.includes(`${join('store', '.cache')}`),
  });

  const status = git(clone, ['status', '--porcelain'], { capture: true }).trim();
  if (!status) {
    console.log('✓ 商店仓库已经是 store/ 的最新内容，无需提交');
    return;
  }
  if (args.dryRun) {
    console.log('--- 将提交的变更 ---');
    console.log(git(clone, ['status', '--short'], { capture: true }));
    console.log('（--dry-run：未提交、未推送）');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const message = args.message || `packs: sync ${stamp}`;
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', message]);
  if (args.noPush) {
    console.log(`✓ 已提交到本地镜像（--no-push）：${clone}`);
    return;
  }
  console.log(`→ 推送到 ${args.repo} ${args.branch}`);
  git(clone, ['push', 'origin', `HEAD:${args.branch}`]);
  console.log('✓ 商店已发布');
  if (!args.noPurge) await purgeJsDelivr(args.repo, args.branch);
}

try {
  await main();
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
