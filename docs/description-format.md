# `.bp.ts` pack 参考

mem-link 的 pack 是一个 TypeScript 文件：它定义**内存布局**（types）和**解析/计算节点**（nodes）。工具把 pack 里的节点变成左栏条目；用户把它们拖到画布上、填地址、连线。

> 设计目标：解析规则属于 pack，而不是工具。链表、数组、结构体、下标换算、位域解释都写在 pack 里。

## 1. 加载机制

```ts
export default definePack({ ... });
```

- 文件必须是单文件、无 `import`；可以用文件内的 `const`、函数、闭包。
- 工具用 Sucrase 去掉类型，再在 `new Function` 里注入 DSL 并执行。
- 执行结果 `pack` 保留函数引用（transform、next、run 都是 live 闭包）。
- 所以 pack 是**代码**：只加载可信文件；页面需要允许 `unsafe-eval`。

最小示例：

```ts
/// <reference path="../types/memlink-bp.d.ts" />

const Header = struct('Header', 8, [
  u16('magic', 0, { format: 'hex' }),
  u16('head', 2),
  u16('tail', 4),
  u16('count', 6),
]);

export default definePack({
  name: 'my-pack',
  endian: 'little',
  pointerSize: 4,
  types: { Header },
  nodes: {
    header: structNode(Header),
  },
});
```

## 2. `definePack`

```ts
definePack({
  name: string,
  endian: 'little' | 'big',
  pointerSize: 4 | 8,
  constants?: Record<string, number>,
  types: Record<string, TypeDef> | TypeDef[],
  nodes: Record<string, NodeDef>,
});
```

- `types` 可以写成对象或数组；内部统一成按名字索引。
- `nodes` 的 key 是节点定义的 id；画布上的实例只存 `packId + nodeId + 参数`。
- `constants` 会出现在节点编辑器的 `ctx.consts` 里，也显示在左栏。

## 3. 类型与布局

### 3.1 标量

```ts
u8(name, offset, opts?)
u16 / u32 / u64
i8 / i16 / i32 / i64
f32 / f64
bool / char / ptr
```

`ptr` 的宽度由 pack 的 `pointerSize` 决定。字段的 `size` 默认由 kind 推导。

### 3.2 字符串 / 字节 / 位域

```ts
str('name', 8, 12)                  // 12 字节，UTF-8，读到 \0 截止
bytes('blob', 16, 32)               // 32 字节，显示为 hex
bits('kind', 0, 2, 0, 2)            // 偏移 0，容器 2 字节，从 bit0 起 2 位
bits('active', 0, 2, 2, 1)          // 同一容器，bit2 起 1 位
```

位域按 `endian` 解释：小端从 LSB 数，大端从 MSB 数。

### 3.3 嵌套 / 数组

```ts
const Point = struct('Point', 8, [i32('x', 0), i32('y', 4)]);

const Shape = struct('Shape', 16, [
  record('origin', 0, Point),
  array('points', 8, Point, 1),  // 1 个 Point，从 offset 8 开始
]);
```

### 3.4 struct / union

```ts
struct(name, size, fields)
union(name, size, fields)
```

- `size` 是显式字节数；字段偏移由你写死。
- `struct` 的字段不能字节重叠（位域例外）；`union` 允许重叠。
- 工具不解析 C，也不推断 padding；请按目标 ABI 算好。

### 3.5 字段选项

```ts
u16('head', 2, {
  endian: 'big',
  format: 'hex',                 // hex | bin | time | timeMs | char
  transform: (v, ctx) => ...,    // 显示值 / 端口值
  label: '头下标',
})
```

`transform` 的上下文：

```ts
ctx = {
  v,          // 原始值
  addr,       // 字段所在地址
  self,       // 同一结构体的原始字段对象
  mem,        // 内存 API
  consts,     // pack.constants
  type,       // 类型名
  field,      // 字段定义
}
```

`mem`：`u8/u16/u32/u64`、`i8..i64`、`f32/f64`、`bytes(addr,len)`、`str(addr,len)`、`cstr(addr,max)`、`inBounds(addr,len)`。

> v3 不使用 `follow`。链表/数组由 `listNode` / `arrayNode` 定义，不再自动沿字段展开。

## 4. 节点

节点定义放在 `definePack({ nodes: { ... } })` 里。工具会根据定义生成左栏条目和端口。

### 4.1 `structNode(type)`

```ts
structNode(Header, { label: 'Header 文件头' })
```

- 输入：`buffer: buffer`（**可选数据源口**）、`address: number`
- `buffer` 接 File 时直连该文件；不接则沿任意入边向上**逐级继承**上游节点的文件。它是上下文端口，不参与值计算。
- 输出：类型的每个字段（端口类型由字段 kind 决定），以及 `array` / `record` 字段里每个成员各一个端口（`elem:字段:下标`）
- 节点卡上直接显示字段的原始/转换值；选中后右栏显示字段表和字节。

### 4.2 `listNode(type, opts)`

```ts
listNode(Entry, {
  label: 'Entry 链表',
  next: (e) => {
    const v = e.value.next;          // 默认是 transform 后的值
    return typeof v === 'number' ? v : null;
  },
  nulls: [-1],
  max: 256,
})
```

- 输入：`buffer: buffer`（可选数据源口）、`address: number`
- 输出：`list: list`、`count: number`，外加**每个元素一个** `elem:0`、`elem:1` … 端口（类型 `instance`，值带地址、字段和所属 buffer）
- 遍历：从 `address` 开始，反复调用 `next(entry)`；返回 `null` 停止。
- `next` 返回的是**下一个元素的地址**（不是下标），除非你的 pack 自己换算。
- `nulls` 里的值也会停止；`max` 是安全上限（默认 4096）。

`entry` 结构：

```ts
{
  addr, index, type,
  raw:   { [field]: unknown },   // 原始字段
  value: { [field]: unknown },   // transform 后的字段
  fields: FieldView[],
}
```

### 4.3 `arrayNode(type, opts)`

```ts
arrayNode(Entry, { label: 'Entry 数组', count: 8, stride: 24 })
```

- 输入：`buffer: buffer`（可选数据源口）、`address: number`、可选 `count: number`（没有 `opts.count` 时从端口取）
- 输出：`list`、`count`，以及每个元素一个 `elem:i` 输出端口
- 第 i 项地址：`address + i * stride`；`stride` 默认 `type.size`。

### 4.4 `calcNode(opts)`

```ts
calcNode({
  label: '下标 → 地址',
  inputs: { index: 'number' },
  outputs: { address: 'number' },
  run: ({ index }, ctx) => ({ address: 0x100 + Number(index) * 24 }),
})
```

- `inputs` / `outputs` 是 `Record<string, PortType>`。
- `PortType`：`number | string | bytes | boolean | instance | list | buffer`。
- `run(inputs, ctx)` 返回一个对象，key 对应 `outputs`。
- `ctx` 里同样有 `mem`、`consts`、`pack`、`nodeId` 等。

## 5. 内置节点

内置节点不依赖 pack，声明集中在 `src/bp/builtins.ts`；节点库分组、快速添加列表与求值器共用同一份定义。节点库按六组组织。

| 分组 | 节点 | 用途 |
| --- | --- | --- |
| 数据源 | `file` 文件 / Buffer | 持有 buffer，是继承链起点；输出 `buffer` / `base` / `size` |
| 数据源 | `slice` 缓冲区切片 | 按地址与长度截取，输出原始字节、hex、ASCII，并在明细区显示带地址与 ASCII 栏的转储 |
| 常量 | `number` 数值 | 常量；不携带文件上下文 |
| 常量 | `string` 文本常量 | 文本与长度 |
| 常量 | `note` 标注 / Note | 图上便签：`text` 多行内容 + `tone` 标记色；`inputs`/`outputs` 均为空，不携带文件上下文、不参与数据源继承，画布上直接编辑；右下角手柄可改宽高，双击复位 |
| 解析 | `element` 元素解析 | 空节点：接实例 / 列表后展开字段；跟随地址时按推断类型解码；不手动指定类型 |
| 解析 | `readint` 数值读取 | 整数 u8/i8…u64/i64 与浮点 f32/f64，可选符号、字节序；输出十进制 / 十六进制 / 二进制（浮点是 IEEE 位模式） |
| 解析 | `text` 字符串读取 | 定长或 C 字符串，支持 ASCII、UTF-16LE/BE |
| 解析 | `arrayread` 数组读取 | 按步长连续读整数，输出值列表 |
| 数值 | `expr` 表达式 | `a` / `b` / `c` 与常量组成的算术、位运算表达式（如 `(a + 1) * b`），支持 `& | ^ << >> ~` 与比较，自带无副作用的解析器 |
| 数值 | `bitfield` 位域 | 位布局、置位下标、置位数、最高/最低置位 |
| 数值 | `enum` 枚举 / 标志 | `值=名称` 映射，输出名称与置位标志 |
| 数值 | `timestamp` 时间戳 | 秒 / 毫秒 / 微秒 → UTC |
| 地址 | `address` 地址计算 | `base + offset × scale` |
| 地址 | `ptrwalk` 指针步进 | 在 `base+offset` 处读 4/8 字节指针，输出读取地址、目标、位模式与 `valid`；偏移填 0 即纯解引用；**断链不中断求值**（读取越界时 `target=0`、`valid=false`），是多级指针自动展开的基本单元 |
| 地址 | `prp` PRP / 分散页 | 展开 PRP1 + PRP2 列表为数据页地址，明细区逐页显示头部字节与数据文本 |
| 校验 | `checksum` 校验和 | CRC32 / 累加和 / FNV-1a |
| 校验 | `compare` 数值比较 | 相等、大小、差值 |

带 `数据源` 输入的节点在无线时沿上游继承文件；宽度、符号、字节序、编码、映射和表达式在检查器「配置」区设置；多行结果（hex 转储、位布局、PRP 页预览）在「明细」区展示。地址一律按绝对地址解释，文件的 `base` 参与边界判断。

`Element` 的 `index` 可以接线，也可以内联填写。接了 `instance` 时忽略 `list`/`index`。

**按地址解析**：只有「在此地址解析 → 元素解析」在**能推断出类型**时才会创建这种节点：`typeId` 随推断写入、`address` 自动接好并在该地址解码。类型不通过检查器手动指定——猜错类型会得到看似成功、实际字段全错的结果；推断不出来、或同一地址已有多种类型时，浮层里不会出现「元素解析」这一项。

**端口跟随实际元素**：一旦接上 `instance` 或 `list`，`Element` 的字段端口就按解码出来的元素生成（类型来自该元素的 `typeName`，嵌套 `array`/`record` 成员也会展开成独立端口）；空节点不铺任何模板字段。接的是 `Entry` 就显示 `next`/`prev`/`name`/`ts`，不会凭空显示某个结构体的 `magic`/`head`。`packId`/`typeId` 只由跟随地址的推断写入，用于地址模式。

元素端口（`instance`）可以直接接到 `number` 输入：这时用的是元素的地址，且下游节点沿继承链沿用同一份文件。例如「链表 #2 → 另一个 Struct 节点的 address」，就会在 #2 的地址上按另一种类型重新解析。任意输出也可以接到某个节点的 `buffer`（数据源）口，含义是「继承该上游节点的文件」。

### 添加节点

左栏节点库的每个条目都可以**拖到画布任意位置**：

- 位移超过 5px 才算拖拽（几像素的抖动仍按单击处理），拖动时有跟随鼠标的卡片显示节点名，画布上出现虚线落点框并高亮边框；光标在画布外时卡片变灰并提示「拖到画布内」。
- 松开即在落点创建：落点先用画布当前的平移/缩放换算成世界坐标，再让新节点水平居中于光标、光标落在标题栏上，因此缩放后位置依然精确。新建节点自动选中，可继续拖节点头微调。
- 拖出画布释放或按 `Esc` 取消，不创建节点。取消状态保留到 `pointerup`，避免松开时补发的 `click` 又建一个节点。
- **单击**仍是原来的快速添加：自动寻找预置空位。拖拽结束后的 `click` 会被抑制，两种方式不会重复创建。
- 拖放提交在 window 层的 `pointerup` 完成（只用坐标、不依赖事件目标），因此触屏的隐式指针捕获把 `pointerup` 派发回节点库条目时也能正确放置。

## 6. 图求值

- 图是 DAG；每个节点的输出按需惰性计算，带记忆化。
- 同一输入端口只允许一条边；重新连会替换旧边。点输入值旁的 `×` 可以断开，恢复手动输入。
- 边的类型必须一致（`instance` 可以接到 `number`，取元素地址；任意输出可以接到 `buffer`，表示继承上游文件）；类型不匹配时不会建立连接。拖线时兼容端口高亮、不兼容端口变暗；输出 → 输入、输入 → 输出两个方向都能起线。
- 环会被检测并报问题（不会无限递归）。
- **未连接的输入使用节点内联参数；一旦连线，输入框自动变成上游传来的真实值**（地址按 `0x…` 显示），并带来源提示；断开后恢复原来手填的文本。
- **数据源依次继承**：`File` 是数据源起点，每个解析节点有一个可选的 `buffer`（数据源）口。节点按以下优先级决定自己属于哪个文件：
  1. 检查器里手动指定的 File（`params.sourceId`）；
  2. `buffer` 口上的显式连线（可以来自 File，也可以来自任意上游值，含义是继承它的文件）；
  3. 沿其它入边向上逐级继承：先问直接上游，上游再问它自己的上游，直到遇到 `File`；
  4. 完全孤立且图里有文件时，用第一个已载入的 File。

  节点头部显示实际文件名与来源方式（直连 / 继承 / 手动 / 默认），检查器显示完整继承链。纯常量节点（`Number`）不携带文件上下文，不会把默认文件误传给下游造成假冲突。
- 每个 `File` 节点的 buffer 独立；同一个图里可以放多个 File 节点，分别解析 A/B 文件。上游来自不同文件时会告警，可在检查器里手动指定。
- 链表/数组的每个元素、结构体与 `Element` 节点里 `array`/`record` 字段的每个成员都有独立输出端口；默认显示前 8 个，点「展开全部」可以看到剩下的，已连线的端口始终可见。
- 端口集合是运行时算出来的：`Element` 换了实际元素类型（或 pack 被移除）后，指向已消失端口的连线会报「连线端点已不存在」警告，重连一次即可。
- 越界、未知类型、`next` 抛错等都会变成节点上的问题，不会让整张图崩掉。

## 7. 错误与校验

加载时校验：

- 类型名、size、字段 offset + size 是否越界；
- struct 字段是否重叠（bits 除外）；
- `record` / `array` 的 `of` 是否存在；
- `str` / `bytes` 的 count；
- 节点引用的 type 是否存在；
- `next` / `run` 是否为函数；
- 端口类型是否合法；
- 未使用的类型/字段不会报错。

加载失败时左栏「检查」显示错误，画布空状态，顶栏错误数同步。

## 8. 图文件

`保存图` 导出：

```json
{
  "format": "memlink-blueprint/1",
  "packs": [{ "id": "p1", "name": "demo", "source": "..." }],
  "nodes": [
    { "id": "f1", "packId": "", "nodeId": "file", "x": 0, "y": 56, "params": { "name": "a.bin" },
      "source": { "name": "a.bin", "base": 0, "data": "base64..." } },
    { "id": "n1", "packId": "p1", "nodeId": "header", "x": 350, "y": 30,
      "params": { "address": "0x0" } },
    { "id": "n2", "packId": "p1", "nodeId": "entryList", "x": 350, "y": 300,
      "params": { "address": "" } }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "f1", "port": "buffer" }, "to": { "node": "n1", "port": "buffer" } },
    { "id": "e2", "from": { "node": "n1", "port": "head" }, "to": { "node": "n2", "port": "address" } }
  ]
}
```

`f1.buffer → n1.buffer` 是显式数据源连线；`n2` 没有 `buffer` 线，它沿 `n1.head` 继承同一个文件。`n2.address` 为空是因为值来自连线，画布上会显示上游的真实值。

`params.sourceId` 可选：写了就固定用那个 File 节点（覆盖连线和继承），不写就按「直连 > 继承 > 默认」自动决定。数据源连线是普通边，保存时原样写入 `edges`，打开时原样恢复；只有端点已不存在的悬空边会被丢弃。

没有全局 `memory` 字段；每个 `File` 节点把自己的 `source`（名称、基址、base64）带在图里。`打开图` 会重新编译每个 pack 的 `source`，恢复节点、连线、位置和各个 File 节点的 buffer。

## 9. 安全边界

- pack 可以执行任意 JS（在页面上下文里）；只加载自己信任的文件。
- 工具不发网络请求；但 pack 代码本身可以（如果你写了 `fetch`）。
- 没有沙箱；不要加载来源不明的 `.bp.ts`。
- 页面 CSP 需要允许 `unsafe-eval`，否则 Sucrase/`new Function` 无法工作。

## 10. 自检清单

- [ ] `export default definePack(...)`，没有 `import` / 其它 `export`。
- [ ] 每个 type 的 `size` 和字段 `offset+size` 匹配目标 ABI。
- [ ] 链表 `next` 返回**地址**；负数/空值返回 `null`。
- [ ] `listNode.max` 足够大，但不要超过 4096。
- [ ] 节点端口类型和下游一致（`list` 接 `list`，`number` 接 `number`）。
- [ ] 加载后看左栏「检查」：错误会阻止节点运行，警告需要确认。
