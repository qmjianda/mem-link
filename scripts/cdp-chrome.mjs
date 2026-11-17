import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * 找到 CDP 回归需要的 Chrome/Chromium。
 *
 * 允许 CHROME_PATH 显式覆盖，Windows 保留原来的默认安装位置，
 * Linux/macOS 则优先使用 PATH 中的浏览器。这样回归脚本不会把
 * 操作系统当成产品前提。
 */
export function chromePath() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROME_PATH 不存在：${explicit}`);
    return explicit;
  }

  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFiles86 = process.env['ProgramFiles(x86)'];
    const candidates = [
      programFiles && `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      programFiles86 && `${programFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter(Boolean);
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
  }

  const locator = platform() === 'win32' ? 'where.exe' : 'which';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync(locator, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch { /* try the next browser name */ }
  }

  throw new Error('找不到 Chrome/Chromium；请设置 CHROME_PATH 指向可执行文件');
}
