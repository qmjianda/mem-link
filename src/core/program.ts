/**
 * Pack program runner.
 *
 * A pack may carry a `program` (a function body executed with an `api`
 * argument). It is the escape hatch for lists that cannot be described by a
 * single field transform: walk a table, follow a parent pointer, derive roots
 * from a header, etc. Programs run synchronously with a deadline checked on
 * every API call. They can only add roots — the graph builder still owns
 * decoding, transforms and edges.
 */

import type { Pack, RootDef } from './pack';
import type { Memory } from './mem';
import { packMemApi } from './packgraph';

export interface ProgramRun {
  roots: RootDef[];
  logs: string[];
  error?: string;
  ms: number;
}

export function runProgram(pack: Pack, mem: Memory): ProgramRun {
  const t0 = performance.now();
  const logs: string[] = [];
  const roots: RootDef[] = [];
  const deadline = t0 + (pack.program?.timeoutMs ?? 2000);
  const tick = () => {
    if (performance.now() > deadline) throw new Error('程序运行超时（超过 ' + (pack.program?.timeoutMs ?? 2000) + 'ms）');
  };
  const push = (type: string, address: number, label?: string) => {
    tick();
    if (!pack.types.some((t) => t.name === type)) throw new Error(`未知类型 ${type}`);
    if (!Number.isFinite(address)) throw new Error(`地址不是有限数字：${address}`);
    if (roots.some((r) => r.type === type && r.address === address)) return;
    roots.push({ type, address, label });
  };

  const api = {
    addStruct: push,
    root: push,
    find: (type?: string) => roots.filter((r) => !type || r.type === type).map((r) => ({ ...r })),
    link: () => undefined,
    mem: packMemApi(mem),
    consts: pack.constants,
    types: pack.types.map((t) => t.name),
    log: (...a: unknown[]) => { tick(); logs.push(a.map(String).join(' ')); },
  };

  let error: string | undefined;
  try {
    if (!pack.program?.code?.trim()) throw new Error('program.code 为空');
    // eslint-disable-next-line no-new-func
    const fn = new Function('api', `"use strict";\n${pack.program.code}\n//# sourceURL=memlink-program.js`);
    fn(api);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { roots, logs, error, ms: Math.round((performance.now() - t0) * 100) / 100 };
}
