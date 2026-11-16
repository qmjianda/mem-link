/// <reference path="../types/memlink.d.ts" />
/**
 * mem-link demo pack — 索引链表
 *
 * 拖进工具即可解析 samples/demo.bin。这个文件本身就是可执行的 TS：
 * definePack / struct / u16 ... 由工具注入，不需要 import。
 *
 * 链表不是指针，而是池下标：addr = BASE + idx * STRIDE。
 * next = -1 表示结束；坏链示例的 next = 12 会越界，工具会画成幽灵节点。
 */

const BASE = 0x100;
const STRIDE = 24;
const NULL_INDEX = -1;

const idxToAddr = (v: number): number | null =>
  v === NULL_INDEX || v < 0 ? null : BASE + v * STRIDE;

const FLAGS = ['READ', 'WRITE', 'DIRTY'];

export default definePack({
  name: 'demo-index-list',
  endian: 'little',
  pointerSize: 4,
  constants: { BASE, STRIDE, NULL_INDEX },

  types: [
    struct('Header', 8, [
      u16('magic', 0, { format: 'hex' }),
      u16('head', 2, {
        label: 'head 下标→地址',
        follow: 'Entry',
        transform: (v) => idxToAddr(Number(v)),
      }),
      u16('tail', 4, {
        label: 'tail 下标→地址',
        transform: (v) => idxToAddr(Number(v)),
      }),
      u16('count', 6),
    ]),

    struct('Entry', 24, [
      i16('next', 0, {
        label: 'next',
        follow: 'self',
        transform: (v) => idxToAddr(Number(v)),
      }),
      i16('prev', 2, {
        label: 'prev',
        transform: (v) => idxToAddr(Number(v)),
      }),
      u16('flags', 4, {
        format: 'hex',
        transform: (v) => {
          const n = Number(v);
          const names = FLAGS.filter((_, i) => n & (1 << i));
          return names.length ? names.join('|') : '0';
        },
      }),
      u16('refcount', 6),
      str('name', 8, 12),
      u32('ts', 20, { format: 'time', label: '创建时间' }),
    ]),

    struct('Meta', 2, [
      bits('kind', 0, 1, 0, 2, { label: '类型' }),
      bits('active', 0, 1, 2, 1),
      bits('mode', 0, 1, 3, 3),
      u8('reserved', 1),
    ]),
  ],

  program: {
    code: [
      "const { BASE, STRIDE } = api.consts;",
      "const seen = new Set();",
      "let idx = api.mem.u16(0x2); // Header.head",
      "for (let n = 0; idx >= 0; n++) {",
      "  const addr = BASE + idx * STRIDE;",
      "  if (seen.has(addr)) { api.log('检测到回环，下标', idx); break; }",
      "  seen.add(addr);",
      "  api.addStruct('Entry', addr, 'scan #' + n);",
      "  idx = api.mem.i16(addr); // Entry.next",
      "}",
      "api.log('程序扫描完成：', seen.size, '个 Entry');",
    ].join('\n'),
  },

  roots: [
    { type: 'Header', address: 0x0, label: '文件头' },
    { type: 'Entry', address: BASE + 4 * STRIDE, label: '坏链示例' },
    { type: 'Meta', address: 0x1e0, label: '元数据' },
  ],
});
