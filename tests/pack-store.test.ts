import { describe, expect, it } from 'vitest';
import {
  alternateStoreUrls,
  compareVersions,
  DEFAULT_STORE_URL,
  fetchStoreIndex,
  fetchStoreReference,
  installState,
  installedPackOf,
  normalizeStoreUrl,
  parseStoreIndex,
  resolveStorePackUrl,
  sha256Hex,
  verifyPackSource,
  type StoreIndex,
} from '../src/bp/store';

const INDEX = {
  format: 'memlink-pack-store/1',
  name: 'Test store',
  packs: [
    {
      id: 'nes',
      name: 'NES ROM',
      version: '1.2.0',
      category: 'game',
      summary: 'NES header',
      tags: ['nes', 'rom'],
      path: 'packs/nes/pack.bp.ts',
      sha256: 'a'.repeat(64),
      size: 1200,
      coverage: 'partial',
      source: { provider: 'nybble', id: 'nes' },
      reference: {
        path: 'packs/nes/reference.blueprint.json',
        sha256: 'b'.repeat(64),
        size: 2400,
      },
    },
    {
      id: 'sqlite',
      name: 'SQLite 3',
      version: '1.0.0',
      category: 'database',
      summary: 'SQLite header',
      path: 'packs/sqlite/pack.bp.ts',
    },
  ],
};

describe('normalizeStoreUrl', () => {
  it('空输入回落到默认商店', () => {
    expect(normalizeStoreUrl('')).toBe(DEFAULT_STORE_URL);
  });

  it('owner/repo、GitHub 仓库与分支都转成 Raw index.json', () => {
    expect(normalizeStoreUrl('qmjianda/mem-link-packs')).toBe(
      'https://raw.githubusercontent.com/qmjianda/mem-link-packs/main/index.json',
    );
    expect(normalizeStoreUrl('https://github.com/qmjianda/mem-link-packs')).toBe(
      'https://raw.githubusercontent.com/qmjianda/mem-link-packs/main/index.json',
    );
    expect(normalizeStoreUrl('https://github.com/qmjianda/mem-link-packs/tree/dev')).toBe(
      'https://raw.githubusercontent.com/qmjianda/mem-link-packs/dev/index.json',
    );
    expect(normalizeStoreUrl('https://github.com/o/r/blob/main/index.json')).toBe(
      'https://raw.githubusercontent.com/o/r/main/index.json',
    );
  });

  it('目录地址补 index.json，index.json 保持原样', () => {
    expect(normalizeStoreUrl('https://example.com/store/')).toBe('https://example.com/store/index.json');
    expect(normalizeStoreUrl('https://example.com/store')).toBe('https://example.com/store/index.json');
    expect(normalizeStoreUrl('https://example.com/custom.json')).toBe('https://example.com/custom.json');
  });

  it('非法地址给出可读错误', () => {
    expect(() => normalizeStoreUrl('ftp://example.com')).toThrow(/http/);
  });
});

describe('parseStoreIndex', () => {
  it('保留 coverage / source / size 并排序', () => {
    const r = parseStoreIndex(JSON.stringify(INDEX));
    expect(r.error).toBeUndefined();
    expect(r.index?.packs.map((p) => p.id)).toEqual(['nes', 'sqlite']);
    expect(r.index?.packs[0]).toMatchObject({
      coverage: 'partial',
      size: 1200,
      source: { provider: 'nybble' },
      reference: {
        path: 'packs/nes/reference.blueprint.json',
        sha256: 'b'.repeat(64),
        size: 2400,
      },
    });
  });

  it('非法 reference 只记警告，不影响 pack 安装', () => {
    const r = parseStoreIndex(JSON.stringify({
      format: 'memlink-pack-store/1',
      packs: [{
        ...INDEX.packs[0],
        reference: { path: 'packs/nes/pack.bp.ts' },
      }],
    }));
    expect(r.index?.packs).toHaveLength(1);
    expect(r.index?.packs[0].reference).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/reference/);
  });

  it('拒绝错误格式与坏条目，重复 id 只保留第一个', () => {
    expect(parseStoreIndex('{}').error).toMatch(/格式/);
    const dup = parseStoreIndex(JSON.stringify({
      ...INDEX,
      packs: [...INDEX.packs, { ...INDEX.packs[0], name: 'dup' }],
    }));
    expect(dup.warnings.join(' ')).toMatch(/重复/);
    expect(dup.index?.packs).toHaveLength(2);
  });

  it('缺失 path 或非法 sha256 的条目被跳过', () => {
    const r = parseStoreIndex(JSON.stringify({
      format: 'memlink-pack-store/1',
      packs: [
        { id: 'a', name: 'A', version: '1.0.0', path: 'x.bp.ts', summary: 'a' },
        { id: 'b', name: 'B', version: '1.0.0', path: 'b.bp.ts', sha256: 'xyz', summary: 'b' },
      ],
    }));
    expect(r.index?.packs.map((p) => p.id)).toEqual(['a']);
    expect(r.warnings.join(' ')).toMatch(/sha256/);
  });
});

describe('resolveStorePackUrl / versions', () => {
  it('相对路径基于索引地址解析', () => {
    expect(
      resolveStorePackUrl(
        'https://raw.githubusercontent.com/o/r/main/index.json',
        'packs/nes/pack.bp.ts',
      ),
    ).toBe('https://raw.githubusercontent.com/o/r/main/packs/nes/pack.bp.ts');
  });

  it('Pages / raw / jsDelivr 互为镜像', () => {
    const pages = 'https://qmjianda.github.io/mem-link-packs/index.json';
    const raw = 'https://raw.githubusercontent.com/qmjianda/mem-link-packs/main/index.json';
    const cdn = 'https://cdn.jsdelivr.net/gh/qmjianda/mem-link-packs@main/index.json';
    expect(alternateStoreUrls(pages)).toContain(raw);
    expect(alternateStoreUrls(pages)).toContain(cdn);
    expect(alternateStoreUrls(raw)).toContain(pages);
    expect(alternateStoreUrls(cdn)).toContain(pages);
  });

  it('版本比较与安装状态', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(installState(undefined, '1.0.0')).toBe('available');
    expect(installState('1.0.0', '1.0.0')).toBe('installed');
    expect(installState('1.0.0', '1.1.0')).toBe('update');
    expect(installState('2.0.0', '1.1.0')).toBe('ahead');
  });
});

describe('hash verification', () => {
  it('sha256Hex 与已知向量一致', async () => {
    expect(await sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('哈希不匹配时拒绝', async () => {
    expect((await verifyPackSource('hello', await sha256Hex('hello'))).ok).toBe(true);
    const r = await verifyPackSource('hello', '0'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/哈希不匹配/);
  });
});

describe('installedPackOf', () => {
  it('按商店地址与 packId 匹配，不受本地 id 影响', () => {
    const packs = [
      { id: 'p1', store: { url: 'https://x/index.json', packId: 'nes', version: '1.0.0' } },
      { id: 'p2', store: { url: 'https://y/index.json', packId: 'nes', version: '1.0.0' } },
    ];
    expect(installedPackOf(packs, 'https://x/index.json', 'nes')?.id).toBe('p1');
    expect(installedPackOf(packs, 'https://z/index.json', 'nes')).toBeUndefined();
    // raw / jsDelivr 镜像视为同一个商店
    const mirrored = [
      { id: 'p3', store: { url: 'https://raw.githubusercontent.com/o/r/main/index.json', packId: 'nes', version: '1.0.0' } },
    ];
    expect(installedPackOf(mirrored, 'https://cdn.jsdelivr.net/gh/o/r@main/index.json', 'nes')?.id).toBe('p3');
  });
});

describe('fetchStoreIndex', () => {
  it('用 fetchImpl 读取并解析索引', async () => {
    const fake = (async () => new Response(JSON.stringify(INDEX), { status: 200 })) as typeof fetch;
    const r = await fetchStoreIndex('https://example.com/index.json', fake);
    expect(r.index.packs).toHaveLength(2);
    expect(r.url).toBe('https://example.com/index.json');
  });

  it('HTTP 失败给出可读错误', async () => {
    const fake = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(fetchStoreIndex('https://example.com/index.json', fake)).rejects.toThrow(/HTTP 500/);
  });

  it('raw 失败时回退 jsDelivr，jsDelivr 失败时回退 raw', async () => {
    const calls: string[] = [];
    const rawFails = (async (url: string) => {
      calls.push(url);
      if (url.includes('raw.githubusercontent.com')) throw new Error('blocked');
      return new Response(JSON.stringify(INDEX), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchStoreIndex('https://raw.githubusercontent.com/o/r/main/index.json', rawFails);
    expect(r.url).toBe('https://cdn.jsdelivr.net/gh/o/r@main/index.json');
    expect(calls).toHaveLength(2);

    calls.length = 0;
    const cdnFails = (async (url: string) => {
      calls.push(url);
      if (url.includes('cdn.jsdelivr.net')) throw new Error('blocked');
      return new Response(JSON.stringify(INDEX), { status: 200 });
    }) as unknown as typeof fetch;
    const r2 = await fetchStoreIndex('https://cdn.jsdelivr.net/gh/o/r@main/index.json', cdnFails);
    expect(r2.url).toBe('https://raw.githubusercontent.com/o/r/main/index.json');
    expect(calls).toHaveLength(2);
  });
});

describe('fetchStoreReference', () => {
  it('按相对路径读取并校验参考蓝图', async () => {
    const text = JSON.stringify({ format: 'memlink-blueprint/3', packs: [], nodes: [], edges: [] });
    const fake = (async () => new Response(text, { status: 200 })) as typeof fetch;
    const r = await fetchStoreReference(
      'https://example.com/index.json',
      { path: 'packs/nes/reference.blueprint.json' },
      fake,
    );
    expect(r.url).toBe('https://example.com/packs/nes/reference.blueprint.json');
    expect(r.text).toBe(text);
  });

  it('内容不像蓝图或哈希不匹配时拒绝', async () => {
    const noFormat = (async () => new Response('{"packs":[]}', { status: 200 })) as typeof fetch;
    await expect(fetchStoreReference(
      'https://example.com/index.json',
      { path: 'packs/nes/reference.blueprint.json' },
      noFormat,
    )).rejects.toThrow(/不像/);

    const text = JSON.stringify({ format: 'memlink-blueprint/3', packs: [], nodes: [], edges: [] });
    const badHash = (async () => new Response(text, { status: 200 })) as typeof fetch;
    await expect(fetchStoreReference(
      'https://example.com/index.json',
      { path: 'packs/nes/reference.blueprint.json', sha256: '0'.repeat(64) },
      badHash,
    )).rejects.toThrow(/校验失败/);
  });
});

// 只用于类型检查：StoreIndex 结构可被外部构造
const _typed: StoreIndex = { format: 'memlink-pack-store/1', packs: [] };
void _typed;
