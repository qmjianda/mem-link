/**
 * End-to-end regression for the shipped NVMe Submission Queue demo.
 * Loads the exact JSON the app boots with, compiles its pack and evaluates the
 * whole SQE → PRP → data chain.
 */
import { describe, expect, it } from 'vitest';
import nvmeDemo from '../samples/nvme-sq.blueprint.json';
import { parseDoc } from '../src/bp/doc';
import { loadBlueprintPack } from '../src/bp/load';
import { evaluateGraph } from '../src/bp/eval';
import type { BlueprintPack } from '../src/bp/types';

function loadGraph() {
  const parsed = parseDoc(JSON.stringify(nvmeDemo));
  expect(parsed.error).toBeUndefined();
  const doc = parsed.doc!;
  const packs = new Map<string, BlueprintPack>();
  for (const p of doc.packs) {
    const r = loadBlueprintPack(p.source);
    expect(r.error).toBeUndefined();
    expect(r.pack).toBeTruthy();
    packs.set(p.id, r.pack!);
  }
  return { doc, packs, result: evaluateGraph(doc.nodes, doc.edges, packs) };
}

describe('NVMe Submission Queue demo', () => {
  it('ships a 4 KiB image at base 0x1000 and a 12-node graph', () => {
    const { doc, packs } = loadGraph();
    expect(packs.get('p1')?.name).toBe('nvme-sq');
    expect(doc.nodes).toHaveLength(12);
    expect(doc.edges).toHaveLength(13);
    const file = doc.nodes.find((n) => n.nodeId === 'file')!;
    expect(file.source?.name).toBe('nvme-sq.bin');
    expect(file.source?.base).toBe(0x1000);
    expect(atob(file.source!.data)).toHaveLength(0x1000);
  });

  it('decodes SQE #0 fields from CDW0 / PRP1 / PRP2 / CDW12', () => {
    const { result } = loadGraph();
    const sqe = result.outputs.get('n_sqe')!;
    expect(sqe.opc).toBe(0x02);           // Read
    expect(sqe.cid).toBe(1);
    expect(sqe.nsid).toBe(1);
    expect(sqe.prp1).toBe(0x1200);
    expect(sqe.prp2).toBe(0x1100);
    expect(sqe.nlb).toBe(5);             // 6 blocks
    expect(sqe.cdw10).toBe(0);
    expect(result.views.get('n_sqe')?.kind).toBe('element');
  });

  it('keeps the submission queue array at 4 entries', () => {
    const { result } = loadGraph();
    expect(result.views.get('n_sq')?.kind).toBe('array');
    expect(result.outputs.get('n_sq')?.count).toBe(4);
    expect(result.ports.get('n_sq')?.outputs.some((p) => p.name === 'elem:0')).toBe(true);
  });

  it('computes transfer length and the number of PRP pages', () => {
    const { result } = loadGraph();
    expect(result.outputs.get('n_transfer')?.bytes).toBe(3072);
    expect(result.outputs.get('n_transfer')?.pages).toBe(6);
  });

  it('names the opcode through the enum node', () => {
    const { result } = loadGraph();
    expect(result.outputs.get('n_opc')?.name).toBe('Read');
    expect(result.outputs.get('n_opc')?.known).toBe(true);
  });

  it('expands PRP1 + PRP2 list into six data pages with previews', () => {
    const { result } = loadGraph();
    const prp = result.outputs.get('n_prp')!;
    expect(prp.pages).toBe(6);
    expect(prp.first).toBe(0x1200);
    expect(prp.p0).toBe(0x1200);
    expect(prp.p1).toBe(0x1400);
    expect(prp.p2).toBe(0x1600);
    expect(prp.p3).toBe(0x1800);
    const view = result.views.get('n_prp');
    expect(view?.kind).toBe('calc');
    if (view?.kind === 'calc') expect(view.detail).toContain('NVMe READ DATA');
  });

  it('decodes the PRP list page and its first entry', () => {
    const { result } = loadGraph();
    expect(result.outputs.get('n_prpList')?.count).toBe(5);
    expect(result.outputs.get('n_prp0')?.addr).toBe(0x1400);
    expect(result.views.get('n_prp0')?.kind).toBe('element');
  });

  it('follows PRP1 and a list entry to the corresponding data blocks', () => {
    const { result } = loadGraph();
    const first = result.outputs.get('n_data1')!;
    const second = result.outputs.get('n_data2')!;
    expect(first.magic).toBe(0x454d564e);
    expect(first.lba).toBe(0);
    expect(String(first.payload)).toContain('NVMe READ DATA');
    expect(second.magic).toBe(0x454d564e);
    expect(second.lba).toBe(1);
    expect(String(second.payload)).toContain('PRP 0x1400');
  });

  it('reads a raw slice and a checksum of the first data page', () => {
    const { result } = loadGraph();
    expect(result.outputs.get('n_dump')?.size).toBe(64);
    expect(String(result.outputs.get('n_dump')?.hex)).toMatch(/^4e 56 4d 45/);
    const sum = result.outputs.get('n_sum')!;
    expect(sum.crc32).toBeGreaterThan(0);
    expect(result.views.get('n_sum')?.kind).toBe('calc');
  });

  it('evaluates the whole graph without errors', () => {
    const { result } = loadGraph();
    const errors = result.problems.filter((p) => p.severity === 'error');
    expect(errors.map((p) => `${p.nodeKey ?? '?'}: ${p.message}`)).toEqual([]);
  });
});
