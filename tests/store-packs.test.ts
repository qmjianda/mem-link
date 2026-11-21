import { describe, expect, it } from 'vitest';
import { loadBlueprintPack } from '../src/bp/load';

/**
 * 商店里的所有 pack 都必须在当前 pack DSL 下可加载。
 * 用 Vite 的 `import.meta.glob` 读取，避免测试依赖 Node 类型。
 */
const packSources = import.meta.glob('../store/packs/*/pack.bp.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const packMeta = import.meta.glob('../store/packs/*/meta.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function dirOf(path: string): string {
  return path.split('/').slice(-2, -1)[0] ?? '';
}

const dirs = Object.keys(packSources)
  .map(dirOf)
  .filter(Boolean)
  .sort();

describe('store packs', () => {
  it('至少有核心格式与移植格式', () => {
    expect(dirs).toContain('nes');
    expect(dirs).toContain('sqlite');
    expect(dirs.length).toBeGreaterThanOrEqual(20);
  });

  it('动态部分生成 calc / list / array / 变体辅助节点', () => {
    const sevenZip = loadBlueprintPack(packSources['../store/packs/7z/pack.bp.ts']).pack!;
    expect(Object.keys(sevenZip.nodes)).toEqual(expect.arrayContaining([
      'calc_SevenZip_nextHeaderPos',
      'ptr_SevenZip_nextHeader',
      'ptrtarget_SevenZip_nextHeaderKind',
    ]));
    const wasm = loadBlueprintPack(packSources['../store/packs/wasm/pack.bp.ts']).pack!;
    expect(Object.keys(wasm.nodes)).toEqual(expect.arrayContaining([
      'read_varint',
      'list_Wasm_sections',
      'array_WasmFuncType_params',
    ]));
    const caf = loadBlueprintPack(packSources['../store/packs/caf/pack.bp.ts']).pack!;
    expect(Object.keys(caf.nodes).some((id) => id.startsWith('match_CafChunk_decoded'))).toBe(true);
    expect(Object.keys(caf.nodes)).toContain('list_Caf_chunks');
  });

  it('生成的 Nybble 大端 pack 保留大端字段', () => {
    const aiff = loadBlueprintPack(packSources['../store/packs/aiff/pack.bp.ts']).pack!;
    const field = aiff.types.Aiff.fields.find((f) => f.name === 'fileSize');
    expect(field?.endian).toBe('big');
    const be = loadBlueprintPack(packSources['../store/packs/tiff-be/pack.bp.ts']).pack!;
    expect(be.types.Tiff.fields.find((f) => f.name === 'byteOrder')?.endian).toBe('big');
  });

  for (const dir of dirs) {
    it(`${dir} 可加载`, () => {
      const source = packSources[`../store/packs/${dir}/pack.bp.ts`];
      expect(source, `${dir}/pack.bp.ts`).toBeTruthy();
      const r = loadBlueprintPack(source);
      expect(r.error, `${dir}: ${r.error ?? ''}`).toBeUndefined();
      expect(r.pack, dir).toBeTruthy();
      expect(Object.keys(r.pack!.nodes).length, `${dir} 至少一个节点`).toBeGreaterThan(0);
      expect(Object.keys(r.pack!.types).length, `${dir} 至少一个类型`).toBeGreaterThan(0);
    });

    it(`${dir} 的 meta 与目录一致`, () => {
      const raw = packMeta[`../store/packs/${dir}/meta.json`];
      expect(raw, `${dir}/meta.json`).toBeTruthy();
      const meta = JSON.parse(raw) as { id?: string; coverage?: string };
      expect(meta.id, `${dir}/meta.json id`).toBe(dir);
      if (meta.coverage !== undefined) {
        expect(['complete', 'partial']).toContain(meta.coverage);
      }
    });
  }
});
