import type { LinkSpec, Project, RecordDecl, Schema } from './types';

export const DEMO_SOURCE = `// mem-link 示例：索引式链表（next/prev 是池下标，不是指针）
#pragma pack(push, 4)

typedef struct {
    uint16_t magic;   // 0xBEEF
    uint16_t head;    // 头节点在池中的下标
    uint16_t tail;
    uint16_t count;
} Header;

typedef struct {
    int16_t  next;     // 下一个节点的池下标，-1 = 结束
    int16_t  prev;
    uint16_t flags;
    uint16_t refcount;
    char     name[12];
    uint32_t ts;
} Entry;

#pragma pack(pop)

// 位域 + 紧凑布局（1 字节）
typedef struct {
    uint8_t kind  : 3;
    uint8_t dirty : 1;
    uint8_t flags : 4;
    uint8_t refs;
} Meta;
`;

export function defaultProject(): Project {
  return {
    version: 1,
    source: DEMO_SOURCE,
    ptrSize: 4,
    endian: 'little',
    pools: [
      { name: 'Entries', base: '0x100', stride: 24, count: 8, type: 'Entry' },
    ],
    roots: [
      { id: 'r1', label: 'Header', type: 'Header', addr: '0x0' },
      { id: 'r2', label: 'head', type: 'Entry', addr: '0x100 + u16(2) * 24' },
      { id: 'r3', label: '坏链示例', type: 'Entry', addr: '0x100 + 4 * 24' },
    ],
    links: {
      'Entry.next': { target: 'Entries', expr: 'v' },
    },
  };
}

export function emptyProject(): Project {
  return {
    version: 1,
    source: '',
    ptrSize: 4,
    endian: 'little',
    pools: [],
    roots: [],
    links: {},
  };
}

/* --------------------------------------------------------- demo binary */

function putU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function putU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function putStr(buf: Uint8Array, off: number, s: string, max: number): void {
  for (let i = 0; i < Math.min(s.length, max - 1); i++) buf[off + i] = s.charCodeAt(i);
}

export function demoBinary(): Uint8Array {
  const buf = new Uint8Array(0x200);
  // Header @ 0x00
  putU16(buf, 0, 0xbeef);
  putU16(buf, 2, 2);   // head index
  putU16(buf, 4, 7);   // tail index
  putU16(buf, 6, 4);   // count

  const base = 0x100;
  const stride = 24;
  const entries: { next: number; prev: number; flags: number; refs: number; name: string }[] = [
    { next: -1, prev: -1, flags: 0x01, refs: 0, name: 'free-0' },
    { next: 7, prev: 5, flags: 0x00, refs: 2, name: 'beta' },
    { next: 5, prev: 0, flags: 0x02, refs: 1, name: 'alpha' },
    { next: -1, prev: -1, flags: 0x01, refs: 0, name: 'free-1' },
    { next: 12, prev: -1, flags: 0x08, refs: 9, name: 'broken' }, // 越界下标 → 幽灵节点
    { next: 1, prev: 2, flags: 0x00, refs: 3, name: 'gamma' },
    { next: -1, prev: -1, flags: 0x01, refs: 0, name: 'free-2' },
    { next: -1, prev: 1, flags: 0x00, refs: 1, name: 'delta' },
  ];

  entries.forEach((e, i) => {
    const off = base + i * stride;
    putU16(buf, off + 0, e.next & 0xffff);
    putU16(buf, off + 2, e.prev & 0xffff);
    putU16(buf, off + 4, e.flags);
    putU16(buf, off + 6, e.refs);
    putStr(buf, off + 8, e.name, 12);
    putU32(buf, off + 20, 1700000000 + i * 37);
  });

  // Meta @ 0x1E0: kind=5, dirty=1, flags=9, refs=3
  buf[0x1e0] = (5 & 0x7) | (1 << 3) | (9 << 4);
  buf[0x1e1] = 3;
  return buf;
}

/* ------------------------------------------------------- serialization */

export interface StoredMemory {
  name: string;
  base: number;
  bytes: Uint8Array;
}

const B64_LIMIT = 8 * 1024 * 1024;

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeProject(p: Project, memory?: StoredMemory): string {
  const doc: Record<string, unknown> = { ...p };
  if (memory && memory.bytes.length > 0 && memory.bytes.length <= B64_LIMIT) {
    doc.memory = {
      name: memory.name,
      base: memory.base,
      size: memory.bytes.length,
      data: bytesToB64(memory.bytes),
    };
  }
  return JSON.stringify(doc, null, 2);
}

export function parseProject(text: string): { project?: Project; memory?: StoredMemory; error?: string } {
  try {
    const raw = JSON.parse(text) as Partial<Project> & { memory?: { name?: string; base?: number; data?: string } };
    if (!raw || typeof raw !== 'object') return { error: '不是有效的项目文件' };
    if (!Array.isArray(raw.roots) || !Array.isArray(raw.pools)) return { error: '缺少 roots / pools' };
    let memory: StoredMemory | undefined;
    if (raw.memory?.data && typeof raw.memory.data === 'string') {
      try {
        memory = {
          name: String(raw.memory.name ?? 'memory.bin'),
          base: Number(raw.memory.base ?? 0) | 0,
          bytes: b64ToBytes(raw.memory.data),
        };
      } catch {
        memory = undefined;
      }
    }
    return {
      project: {
        version: 1,
        source: String(raw.source ?? ''),
        ptrSize: raw.ptrSize === 8 ? 8 : 4,
        endian: raw.endian === 'big' ? 'big' : 'little',
        pools: raw.pools,
        roots: raw.roots,
        links: raw.links ?? {},
        notes: raw.notes,
      },
      memory,
    };
  } catch (e) {
    return { error: `解析失败：${(e as Error).message}` };
  }
}

/* ------------------------------------------------------- link suggestion */

const LINKISH = /^(next|prev|next_|prev_|nxt|prv|first|last|head|tail|child|children|parent|left|right|sibling|link|list|.*_next|.*_prev|.*_head|.*_tail)$/i;

export interface Suggestion { key: string; record: string; field: string; spec: LinkSpec; reason: string }

export function suggestLinks(schema: Schema, project: Project): Suggestion[] {
  const out: Suggestion[] = [];
  const poolsByName = new Map(project.pools.map((p) => [p.name, p]));
  for (const rec of Object.values(schema.records)) {
    for (const f of rec.fields) {
      const key = `${rec.name}.${f.name}`;
      if (project.links[key]) continue;
      if (f.derived) continue;
      const isNum = f.type.k === 'int' || f.type.k === 'ptr';
      if (!isNum) continue;
      if (!LINKISH.test(f.name) && !f.link) continue;

      if (f.type.k === 'ptr') {
        const ptrSize = schema.ptrSize;
        if (f.type.size !== ptrSize) continue;
        // pointer to a record: only if the record type is declared next to it
        out.push({
          key, record: rec.name, field: f.name,
          spec: { target: '@abs', expr: 'v' },
          reason: '指针字段 → 绝对地址',
        });
        continue;
      }
      const pool = poolsByName.get(rec.name)
        ?? (project.pools.length === 1 ? project.pools[0] : undefined);
      if (pool) {
        out.push({
          key, record: rec.name, field: f.name,
          spec: { target: pool.name, expr: 'v', type: pool.type },
          reason: `整型字段，按池 ${pool.name} 的下标解释`,
        });
      }
    }
  }
  return out;
}

/** Best-effort field-name based link rules for the demo-ish case. */
export function recordSize(rec: RecordDecl): number { return rec.size; }
