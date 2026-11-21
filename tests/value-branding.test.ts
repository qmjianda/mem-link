/**
 * 值类别显式化：形状相同不等于元素，只有 `makeView` 登记过的实例才算。
 * 覆盖 spec `blueprint-evaluation` 的两条场景：伪元素降级为 JSON 并告警，
 * 真实元素仍可当地址使用。
 */
import { describe, expect, it } from 'vitest';
import demoDoc from '../samples/demo.blueprint.json';
import nvmeDoc from '../samples/nvme-sq.blueprint.json';
import { evaluateGraph } from '../src/bp/eval';
import { loadBlueprintPack } from '../src/bp/load';
import { parseDoc } from '../src/bp/doc';
import { brandInstance, isInstanceView, looksLikeInstance } from '../src/bp/types';
import type { BPEdge, BPNode, BlueprintPack } from '../src/bp/types';

const FAKE_PACK = `
export default definePack({
  name: 'brand-test',
  endian: 'little',
  pointerSize: 4,
  types: { T: struct('T', [u8('x')]) },
  nodes: {
    fake: calcNode({
      label: '伪元素',
      inputs: {},
      outputs: { obj: 'instance' },
      run: () => ({ obj: { addr: 0x1234, typeName: 'T', size: 4, fields: [] } }),
    }),
  },
});
`;

function fakePack(): BlueprintPack {
  const r = loadBlueprintPack(FAKE_PACK);
  expect(r.error).toBeUndefined();
  return r.pack!;
}

describe('值类别：品牌是唯一判据', () => {
  it('形状完全相同的普通对象不算元素', () => {
    const fake = { addr: 1, typeName: 'T', size: 4, fields: [] };
    expect(isInstanceView(fake)).toBe(false);
    expect(looksLikeInstance(fake)).toBe(true);
  });

  it('登记过的实例才算元素，且不再被当成伪元素', () => {
    const real = brandInstance({ addr: 1, typeName: 'T', size: 4, fields: [] });
    expect(isInstanceView(real)).toBe(true);
    expect(looksLikeInstance(real)).toBe(false);
  });

  it('复制品牌实例得到一个未登记的新对象', () => {
    const real = brandInstance({ addr: 1, typeName: 'T', size: 4, fields: [] });
    const copy = { ...real };
    expect(isInstanceView(copy)).toBe(false);
  });
});

describe('计算节点返回伪元素', () => {
  const nodes: BPNode[] = [
    { id: 'fake', packId: 'p1', nodeId: 'fake', x: 0, y: 0, params: {} },
    { id: 'calc', packId: '', nodeId: 'expr', x: 0, y: 0, params: { formula: 'a' } },
  ];
  const edges: BPEdge[] = [
    { id: 'e1', from: { node: 'fake', port: 'obj' }, to: { node: 'calc', port: 'a' } },
  ];
  const result = evaluateGraph(nodes, edges, new Map([['p1', fakePack()]]));

  it('产生 INVALID_VALUE 告警并定位到产出节点', () => {
    const p = result.problems.find((x) => x.code === 'INVALID_VALUE');
    expect(p?.severity).toBe('warn');
    expect(p?.nodeKey).toBe('fake');
  });

  it('不按 addr 解码：下游把它当成非法数字而不是 0x1234', () => {
    // 0x1234 一旦被当成地址，expr 的 a 会等于它；这里必须拿不到这个值
    expect(result.outputs.get('calc')?.value).not.toBe(0x1234);
    expect(result.problems.some((p) => p.nodeKey === 'calc' && p.code === 'BAD_INPUT')).toBe(true);
  });

  it('降级后的值不再携带可继续解码的地址', () => {
    const handed = result.outputs.get('fake')?.obj as Record<string, unknown>;
    expect(handed).toBeTruthy();
    expect(isInstanceView(handed)).toBe(false);
    expect(handed.mem).toBeUndefined();
  });

  it('端口行把降级值显示为对象摘要而不是抛错', () => {
    expect(result.inputs.get('calc')?.a?.display).toBe('{…}');
  });
});

describe('真实元素仍可当地址使用', () => {
  it('列表 elem:0 接到 address 后按元素地址解码', () => {
    const parsed = parseDoc(JSON.stringify(demoDoc));
    expect(parsed.error).toBeUndefined();
    const doc = parsed.doc!;
    const packs = new Map<string, BlueprintPack>();
    for (const p of doc.packs) {
      const r = loadBlueprintPack(p.source);
      expect(r.pack).toBeTruthy();
      packs.set(p.id, r.pack!);
    }
    const result = evaluateGraph(doc.nodes, doc.edges, packs);
    const detail = result.views.get('n_detail');
    const inst = detail && 'inst' in detail ? detail.inst : undefined;
    // demo 的 head 指向池下标 2，即 0x100 + 2 × 24 = 0x130；
    // 说明 instance → number 走的是 addr，而不是把整个对象当成值
    expect(inst?.addr).toBe(0x130);
    expect(result.problems.some((p) => p.detail?.includes('INVALID_VALUE'))).toBe(false);
  });
});

describe('既有示例图不产生误报', () => {
  it.each([
    ['demo', demoDoc],
    ['nvme-sq', nvmeDoc],
  ])('%s 没有任何 INVALID_VALUE', (_name, raw) => {
    const parsed = parseDoc(JSON.stringify(raw));
    expect(parsed.error).toBeUndefined();
    const doc = parsed.doc!;
    const packs = new Map<string, BlueprintPack>();
    for (const p of doc.packs) {
      const r = loadBlueprintPack(p.source);
      expect(r.pack).toBeTruthy();
      packs.set(p.id, r.pack!);
    }
    const result = evaluateGraph(doc.nodes, doc.edges, packs);
    expect(result.problems.filter((p) => p.detail?.includes('INVALID_VALUE'))).toHaveLength(0);
  });
});
