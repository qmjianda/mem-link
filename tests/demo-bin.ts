/**
 * 测试夹具：0x200 字节的索引链表 dump。
 *
 * 原先放在 v1 的 `src/core/project.ts`（已随 v1 删除），现在由测试自己持有。
 * 布局与 `samples/demo.bin` 一致：Header @0x00、Entry 池 @0x100（步长 24）、
 * Meta @0x1E0。第 4 个 Entry 的 next=12 越界，用于验证幽灵节点。
 */

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
