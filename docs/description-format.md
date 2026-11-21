# `.bp.ts` pack 参考

mem-link 的 pack 是一个 TypeScript 文件：它定义**内存布局**（types）和**解析/计算节点**（nodes）。工具把 pack 里的节点变成左栏条目；用户把它们拖到画布上、填地址、连线。

> 设计目标：解析规则属于 pack，而不是工具。链表、数组、结构体、下标换算、位域解释都写在 pack 里。结构只描述**解析后的字节布局**，不模拟 C 编译器或宏展开。

## 1. 加载机制

```ts
export default definePack({ ... });
```

- 文件必须是单文件、无 `import`；可以用文件内的 `const`、函数、闭包。
- 工具用 Sucrase 去掉类型，再在 `new Function` 里注入 DSL 并执行。
- 执行结果 `pack` 保留函数引用（transform、next、run 都是 live 闭包）。
- pack 是**代码**：只加载可信文件；页面需要允许 `unsafe-eval`。
- 「Pack 商店」安装的 pack 与本地 `.bp.ts` 走同一条加载路径；商店的版本、
  来源、SHA-256 与覆盖度只存在于 `meta.json`/文档的 `store` 元数据里，不进入
  `definePack`。详见 [`pack-store.md`](pack-store.md)。

最小示例：

```ts
/// <reference path="../types/memlink-bp.d.ts" />

const Header = struct('Header', [
  u16('magic', { format: 'hex' }),
  u16('head'),
  u16('tail'),
  u16('count'),
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
- `constants` 会出现在节点编辑器的 `ctx.consts` 里，也显示在左栏；它不参与布局推导。

## 3. 类型与布局

### 3.1 只有一套位置规则

字段按声明顺序处理：

- 不写 `at`：从当前游标开始，字段结束后游标推进到字段末尾。
- 写 `at`：固定在指定字节偏移；如果结束位置超过游标，游标推进到结束位置。
- `pad(n)`：在游标处增加 n 字节。
- `align(n)`：把游标推进到 n 的整数倍。
- 结构长度等于最终游标；可以用 `{ size }` 覆盖，但不能小于内容。

```ts
const Header = struct('Header', [
  u8('kind'),
  align(4),
  u32('flags'),
  pad(2),
]);

const Anchored = struct('Anchored', [
  u8('kind'),
  u32('flags', { at: 16 }),
  u16('tail'),
], { size: 32 });
```

### 3.2 标量

字段辅助函数统一为 `(name, opts?)`；`opts.at` 是字节偏移，`opts.size` 是可选覆盖。

```ts
u8(name, opts?)       i8 / u16 / i16 / u32 / i32 / u64 / i64
f32 / f64
bool / char / ptr
```

`ptr` 的宽度由 pack 的 `pointerSize` 决定。

### 3.3 字符串 / 字节

```ts
str('name', { size: 12 })       // 12 字节，UTF-8，读到 \0 截止
bytes('blob', { size: 32 })     // 32 字节，显示为 hex
```

### 3.4 位域

```ts
bits('kind', 2)                          // 自动加入当前位组
bits('active', 1)                        // 下一位
bits('mode', 3)                          // 再下 3 位
bits('flag', 1, { unit: 2, bit: 6 })     // 新 2 字节单元，位偏移 6
```

- 相邻、未写 `unit` 的位域共享一个存储单元；单元取能容纳整组的最小 1/2/4/8 字节。
- `unit` 强制存储宽度；`bit` 是组内位偏移。
- 位组结束后游标推进到单元末尾；超过单元或 64 位报错。
- 位域按 `endian` 解释：小端从 LSB 数，大端从 MSB 数。

### 3.5 嵌套 / 数组

直接传类型对象；被引用的类型会自动登记，不必重复列进 `types`。

```ts
const Point = struct('Point', [i32('x'), i32('y')]);

const Shape = struct('Shape', [
  record('origin', Point),
  array('points', Point, 4),
  array('ids', 'u16', 8),
]);
```

### 3.6 struct / union / 枚举

```ts
struct(name, fields, opts?)
union(name, fields, opts?)
```

- `union` 的字段共享偏移，允许重叠；普通 `struct` 的字段重叠报错（位域除外）。
- 枚举是整数字段加显示映射，不新增存储类型：

```ts
u16('state', { values: { 0: 'Idle', 1: 'Run' } })
```

原始值、端口值和下游计算仍是整数。

### 3.7 字段选项

```ts
u16('head', {
  at: 2,                         // 固定偏移；省略则自动
  endian: 'big',
  format: 'hex',                 // hex | bin | time | timeMs | char
  values: { 1: 'Run' },
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

## 4. 引用蓝图布局

```ts
const Header = layoutType('layout/header');

export default definePack({
  types: { Header },
  nodes: { header: structNode(Header) },
});
```

- 布局 id 使用 `layout/<id>`。
- 引用是 live 的：改布局字段后下一次求值生效，不需要重新导入 pack。
- 布局缺失、被删除或成环时报错；不会退化成空结构。

## 5. 节点

节点定义放在 `definePack({ nodes: { ... } })` 里。工具会根据定义生成左栏条目和端口。

每个节点都应写 `description`：说明解析什么、输入怎么接、输出是什么。它显示在节点库 `?`、快速添加底部和检查器「帮助」里；旧 pack 没写时加载器会按类型字段补一条默认说明，但商店 pack 应显式写清楚。每个 pack 还必须在目录里提供 `reference.blueprint.json`，由 `store/scripts/build-references.mjs` 生成。

### 5.1 `structNode(type)`

```ts
structNode(Header, { label: 'Header 文件头' })
```

- 输入：`buffer: buffer`（可选数据源口）、`address: number`
- `buffer` 接 File 时直连该文件；不接则沿任意入边向上**逐级继承**上游节点的文件。
- 输出：类型的每个字段，以及 `array` / `record` 字段里每个成员各一个端口（`elem:字段:下标`）。

### 5.2 `listNode(type, opts)`

```ts
listNode(Entry, {
  label: 'Entry 链表',
  next: (e) => {
    const v = e.value.next;
    return typeof v === 'number' ? v : null;
  },
  nulls: [-1],
  max: 256,
})
```

- 输入：`buffer: buffer`、`address: number`
- 输出：`list`、`count`，以及每个元素一个 `elem:0`、`elem:1` … 端口
- `next` 返回**下一个元素的地址**；返回 `null` 停止；`nulls` 也会停止；`max` 默认 4096。

`entry` 结构：`{ addr, index, type, raw, value, fields }`。

### 5.3 `arrayNode(type, opts)`

```ts
arrayNode(Entry, { label: 'Entry 数组', count: 8, stride: 24 })
```

- 第 i 项地址：`address + i * stride`；`stride` 默认 `type.size`。

### 5.4 `calcNode(opts)`

```ts
calcNode({
  label: '下标 → 地址',
  inputs: { index: 'number' },
  outputs: { address: 'number' },
  run: ({ index }) => ({ address: 0x100 + Number(index) * 24 }),
})
```

- `PortType`：`number | integer | string | bytes | boolean | instance | list | buffer`。
- `run(inputs, ctx)` 返回一个对象，key 对应 `outputs`。

## 6. 内置节点

内置节点不依赖 pack，声明集中在 `src/bp/builtins.ts`；节点库分组、快速添加列表与求值器共用同一份定义。节点库按六组组织。

| 分组 | 节点 | 用途 |
| --- | --- | --- |
| 数据源 | `file` 载入转储 | 只读数据源，输出 `buffer`、`base`、`size` |
| 数据源 | `slice` 字节范围 | 输出保留原始地址和资产身份的 `span` |
| 读取 | `readint` 读数值 | 按 `scalar` 类型和字节序读取一个值 |
| 读取 | `text` 读字符串 | 定长或零终止，支持 ASCII、UTF-8、UTF-16LE/BE |
| 读取 | `structread` 读结构 | 引用 `structureId`，输出记录与具名字段 |
| 定位 | `address` 换算地址 | 基址加偏移，或基址加池下标乘步长；不读取 |
| 定位 | `ptrwalk` 读指针 | 读取一个指针，区分空指针、读取失败和目标未映射 |
| 集合 | `arrayread` 展开数组、`listread` 遍历链表 | 输出可取项的集合 |
| 集合 | `item` 按下标取项、`element` 元素解析 | 从集合取项、展开结构字段 |
| 校验 | `checksum`、`assert` | 计算校验和、判断相等或闭区间 |
| 辅助 | `number`、`string`、`note`、`expr` | 常量、便签与数值表达式 |

**结构来源**：`structread` / `arrayread` / `listread` 的结构选择器同时列出本图布局和已启用 pack 的类型。`structureId` 是唯一参数：布局为 `layout/<id>`，pack 类型为 `pack/<encodedPackId>/<encodedTypeName>`。

## 7. 图求值

- 图是 DAG；每个节点的输出按需惰性计算，带记忆化。
- 同一输入端口只允许一条边；重新连会替换旧边。
- 边的类型必须一致（`instance` 可以接到 `number`，取元素地址；任意输出可以接到 `buffer`，表示继承上游文件）。
- 环会被检测并报问题。
- 未连接的输入使用节点内联参数；一旦连线，输入框显示上游真实值。
- 数据源优先级：手动指定 File > 显式数据源连线 > 沿入边继承 > 唯一可用转储。
- 链表/数组的每个元素、结构体与 `Element` 节点里 `array`/`record` 字段的每个成员都有独立输出端口；默认显示前 8 个。
- 越界、未知类型、`next` 抛错等都会变成节点上的问题。

## 8. 图文件 v3

导出生成 `memlink-blueprint/3`：

```json
{
  "format": "memlink-blueprint/3",
  "packs": [{ "id": "p1", "name": "demo", "source": "..." }],
  "layouts": [
    {
      "id": "header",
      "name": "表头",
      "endian": "little",
      "fields": [
        { "id": "f1", "name": "count", "kind": "u16" },
        { "id": "f2", "name": "entries", "kind": "array", "of": "layout/entry", "count": "4" }
      ]
    }
  ],
  "nodes": [
    { "id": "r1", "packId": "", "nodeId": "structread", "x": 0, "y": 0,
      "params": { "structureId": "layout/header", "address": "0x1000" } }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "f1", "port": "buffer" }, "to": { "node": "r1", "port": "buffer" } }
  ]
}
```

- 字段端口为 `field:<structureId>:<fieldId>`。
- 布局字段：`at` 是可选字节偏移；`size` 是 bytes/string 长度；`count` 是数组数量；`of` 指向 `layout/<id>` 或标量 kind；位域用 `unit` / `bit` / `width`。
- `union: true` 的布局允许字段共享偏移。
- 旧版 v2 文档会被明确拒绝，不做迁移。

## 9. C 构造映射

结构定义描述**解析后的字节布局**，不执行 C 源码。

| C 构造 | pack 表示 | 布局表示 |
| --- | --- | --- |
| 命名嵌套结构 | `record(name, Type)` / `array(name, Type, count)` | `record` / `array` 引用另一布局 |
| 匿名嵌套结构或联合 | 生成稳定类型名后引用 | 生成稳定布局名后引用 |
| `union` | `union(name, fields)` | `union: true`，字段共享 `at` |
| 枚举 | 整数字段 + `values` | 整数字段 + `values` |
| 宏 / `#define` | 不展开；写成具体数字 | 不展开；粘贴前解析成具体数字 |
| `#pragma pack` / 自然对齐 | 用 `at` / `align` / `pad` 显式写出 | 用字段 `at` 显式写出 |
| 指针 | `ptr`；宽度由 `pointerSize` 决定 | 固定宽度整数 + `role: address` |
| 位域 | `bits(name, width, { unit, bit })` | `unit` / `bit` / `width` |

## 10. 模板

`samples/templates/` 提供可编译模板：

- `auto-layout.bp.ts` — 自动排布
- `bitfields.bp.ts` — 位域
- `nested-array.bp.ts` — 嵌套类型与标量数组
- `pool-list.bp.ts` — 池下标链表
- `layout-ref.bp.ts` — 引用蓝图布局

模板随单元测试一起校验。

## 11. 自检清单

- [ ] `export default definePack(...)`，没有 `import` / 其它 `export`。
- [ ] 自动字段的偏移符合目标 ABI；需要固定位置时写了 `at`。
- [ ] 位域组没有超过存储单元或 64 位。
- [ ] 链表 `next` 返回**地址**；负数/空值返回 `null`。
- [ ] `listNode.max` 足够大，但不要超过 4096。
- [ ] 节点端口类型和下游一致（`list` 接 `list`，`number` 接 `number`）。
- [ ] 每个节点有 `description`，说明用途/输入/输出。
- [ ] 目录中有可打开的 `reference.blueprint.json`。
- [ ] 加载后看左栏「检查」：错误会阻止节点运行。

## 12. 结构设计器（无脚本布局）

无脚本布局在独立的全屏「结构设计器」中编辑；检查器只保留结构选择、摘要、`next` 字段和入口。文档格式不变，仍是 `memlink-blueprint/3`。

### 12.1 打开与返回

- **入口**：选中读结构 / 展开数组 / 遍历链表节点 → 检查器「打开结构设计器」。新建布局会直接进入设计器。
- **URL**：`#design/<layoutId>`；嵌套布局为 `#design/<parent>/<child>`。浏览器后退/前进会在布局栈和蓝图之间导航。
- **关闭**：顶栏「完成」或根布局按 Esc；回到原节点、原视口，焦点回到触发按钮。
- **会话**：编辑立即进入文档历史；「撤销本次修改」整体回到打开设计器时的布局，本身也可撤销。

### 12.2 字节视图

- 每行 4/8/16/32 字节，显示字节标尺、行偏移、字段块、空白格。极长布局只渲染前一段画布并提示上限，其余字节用字段表或检查器定位。
- 虚线 = 自动排布；实线 = 锚定。字段块显示偏移、长度、数组数量/元素布局、record 目标，位域组显示存储单元与成员色条。
- **拖动字段主体**：锚定到落点；自动字段会从虚线变成实线。
- **拖动重排手柄**（左上角 `⠿`）：只改变声明顺序，不写 `at`。
- **拖右边缘**：只对 string / bytes 改长度；标量宽度由类型决定。
- 非法落点（重叠、越界、非联合重叠）回弹并说明原因，不写历史。一次手势只提交一次。
- 缩放 50%–200%，空格/中键拖动平移，`Ctrl/Cmd+滚轮` 缩放，「适应」按内容适配。

### 12.3 位视图

- 按 `at + unit` 分组；每个存储单元一条位标尺。LSB 在左 / MSB 在左只影响显示。
- 拖动位域条移动 `bit`；拖左右把手改 `width`；位宽较窄时把手收窄，仍保留中间拖动区域；组头切换 1/2/4/8 字节单元。
- 同一存储单元内位域区间不得重叠；重叠会回弹并在问题面板指出冲突。没有位域时显示空状态和创建入口。

### 12.4 检查器与字段表

- 右栏只编辑当前选中项；无选中时编辑布局名称、字节序、联合、长度覆盖和引用。
- 字段属性包括名称、类型、自动/锚定、偏移、长度、数组数量/目标、字节序、数值语义、位域成员和显示映射（JSON：`{"0":"Idle"}`）。
- 底部字段表按声明顺序显示偏移、大小/位宽、自动/锚定和错误；`↑/↓/Home/End/PageUp/PageDown` 移动，`F2` 内联改名，`Enter` 定位到画布。
- 「问题」页签列出当前布局的错误与警告；点击问题会选中字段并切到合适视图。

### 12.5 嵌套、引用与删除

- record/array 可以进入子布局；子布局长度变化会立即更新父布局的自动偏移和长度，锚定字段保持原偏移。
- 「被引用」显示父布局、图节点、连线和 pack；删除仍被引用的布局会被拒绝并列出这些来源。
- 删除被节点/连线使用的字段会先列出受影响入口；确认后保留缺失连线，由求值器报告 `PORT_MISSING`，不会静默改接。
- 选择嵌套目标时会阻止成环；pack 类型只读。

### 12.6 声明导入、导出与模板

- 设计器「导入」支持 `struct` / `union` / `typedef`、定长数组、位域、注释和同批布局引用；先预览诊断，失败不导入半份。
- 「导出」把当前布局递归导出为 pack 类型源码（`struct` / `array` / `bits` 等），不执行代码。
- 「模板」提供表头、位域、嵌套数组、池下标链表，只生成文档布局。
- 宏、条件编译、未知类型和 C ABI 对齐仍不自动推断；需要固定位置时写 `at`。

### 12.7 快捷键

| 键 | 作用 |
| --- | --- |
| `Tab` / `Shift+Tab` | 在区域和字段间移动焦点 |
| `Enter` | 选择字段；record/array 上进入子布局 |
| `F2` | 聚焦名称输入 |
| `Delete` / `Backspace` | 删除选中字段/位域（已接线时先确认） |
| 方向键 | 移动字段/位域；`Shift` 加速 |
| `Alt+方向键` | 调整 string/bytes 长度或位域宽度 |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | 撤销 / 重做 |
| `Ctrl/Cmd+C` / `V` / `D` | 复制 / 粘贴 / 重复 |
| `Ctrl/Cmd+A` | 全选字段 |
| `Esc` | 取消手势 → 关闭浮层 → 返回父布局 → 退出设计器 |
| `+` / `-` / `0` | 放大 / 缩小 / 适应 |

输入法组合期间的 Enter、方向键和 Esc 不会触发应用命令。
