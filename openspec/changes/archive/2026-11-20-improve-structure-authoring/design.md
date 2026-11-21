## Context

见 `proposal.md` — Why。当前实现有三套彼此独立的约定：

- `src/core/pack.ts` 的 `TypeDef` 用数值偏移解码，字段位置由调用方手写；`src/bp/load.ts` 在加载时校验。
- `src/bp/layouts.ts` 的 `BinaryLayout` 用文本偏移、扁平字段；`compileLayout` 只认本地布局。
- `src/bp/builtins.ts` 的 `structread` / `arrayread` / `listread` 只查 `doc.layouts`，pack 类型只能通过 pack 节点进入。

既有设计约定保留：布局是文档数据，不是自动生成的 pack；pack 是可信代码，执行模型与 CSP 不变。**本轮不保留旧 pack 签名、旧蓝图格式或旧结构 id 的兼容路径**：一次收敛到一套语法、一套 v3 文档格式和一套结构身份，随附示例全部迁移，旧格式明确拒绝。这样代码只维护一条定义与解析路径。

## Goals / Non-Goals

**Goals:**

- 一套 pack 结构 DSL：默认自动排布，`at` 锚定，位域、填充、对齐和直接类型引用各只有一种写法。
- 一套布局模型：字段写 `at` 或按顺序自动排布，结构长度推导或覆盖；支持嵌套布局、定长数组和位域。
- 一套结构身份：`structureId` 与 `field:<structureId>:<fieldId>` 端口；pack 类型和布局都能被同一组解析节点使用。
- 同一个结构从 pack 节点或无脚本节点进入时，走同一套解码与转换路径。

**Non-Goals:**

- 旧 `.bp.ts` 签名、旧 `memlink-blueprint/2`、旧裸 `layoutId` 的兼容、迁移或双解析。
- 同一字段的显式/自动两套重载，或布局的自动/手动模式开关。
- 布局内嵌 pack 类型；跨 pack 复用只发生在根结构选择和 pack 的 `layoutType`。
- 完整 C 预处理器、宏、条件编译、C ABI 对齐模式、任意变长布局、指针解引用语法。
- 跨蓝图结构库或独立布局文件。

## Decisions

### 1. pack DSL 只有一套位置规则

新签名（`types/memlink-bp.d.ts` 同步）：

```ts
struct(name, fields, opts?)          // opts.size 可覆盖推导长度
union(name, fields, opts?)
u16(name, opts?)                     // opts.at 锚定字节偏移；opts.values 数值→显示名
str(name, { size })                  // 定长字符串
bytes(name, { size })
record(name, Type, opts?)
array(name, Type | ScalarKind, count, opts?)
bits(name, width, opts?)             // opts.bit 组内位偏移，opts.unit 存储字节
pad(n) / align(n)                    // 只作为 fields 里的布局指令
layoutType('layout/<id>')
```

- 只有一条几何规则：游标从 0 开始；无 `at` 字段从游标开始，结束后游标推进；有 `at` 则固定，必要时把游标推到字段末尾；`pad`/`align` 调整游标；结构长度等于最终游标或 `opts.size`。
- 标量、字符串与字节字段统一为 `(name, opts?)`；不存在 `u16(name, offset, opts)` 这样的第二套位置参数。字符串/字节的长度放在 `opts.size`；`record` / `array` 的必需参数（类型、数量）除外。
- 位域只有 `bits(name, width, opts?)`：连续位域自动成组，取能容纳整组的最小 1/2/4/8 字节单元；`unit` 强制存储宽度，`bit` 指定位偏移；位组结束后游标推进到单元末尾；溢出报错。旧五参数写法删除。
- `record` / `array` 直接接收类型对象，递归登记进 `types`；数组元素也可以是 `'u16'` 这样的标量 kind。删除按字符串名称引用记录类型的路径。同名不同类型直接报错。
- 备选方案：保留旧签名并加重载。放弃，因为 AI 与人都要在两套参数顺序之间判断，正是本轮要消除的复杂度。

### 2. 蓝图升级为 `memlink-blueprint/3`，不读 v2

- `BLUEPRINT_FORMAT` 改为 `memlink-blueprint/3`；`parseDoc`、`persist.deserialize` 只接受 v3，旧版本返回明确的“不支持旧版蓝图”，不做字段猜测或迁移。
- 节点参数从 `layoutId` 改为 `structureId`；字段端口统一为 `field:<structureId>:<fieldId>`。不再接受裸布局 id 作为第二套写法。
- 本地缓存键升级为 `memlink:graph:v3`；旧缓存忽略，不读取。
- `samples/`、`scripts/gen-*.mjs`、默认示例和浏览器回归全部生成/读取 v3。
- 备选方案：在 v2 上增加可选字段并双读。放弃，因为布局字段形状、端口和 pack 引用都要改，双读会把分支扩散到文档、求值、端口和 UI。

### 3. 结构身份与注册表只有一条解析路径

```ts
type StructureId = `layout/${string}` | `pack/${string}/${string}`;
interface StructureEntry {
  id: StructureId;
  name: string;                 // 显示名，可改
  source: 'layout' | 'pack';
  size: number;                 // 解析后的长度
  type: TypeDef;                // 统一解码模型
  layout?: BinaryLayout;        // 仅布局
  packId?: string;
  typeName?: string;
}
```

- 文档布局 id 为 `layout/<layoutId>`；pack 类型 id 为 `pack/<encodedPackId>/<encodedTypeName>`，编码保证不含冒号，字段端口可安全用冒号分隔。
- `StructureRegistry` 在一次求值/一次 UI 查询内合并 `doc.layouts` 与启用的 pack；禁用 pack 不进入。`resolveStructure(id)` 只做精确匹配，缺失就报错。
- 不存在“先按裸 id，再按名称，再取第一个同名类型”的回退链。跨 pack 同名类型由 `structureId` 天然区分。
- 备选方案：保留裸布局 id 兼容。放弃，因为它会迫使每个消费点判断两种 id，并让端口格式分裂。

### 4. 布局模型只有一套几何与嵌套规则

```ts
interface BinaryLayout {
  id: string;
  name: string;
  endian: Endian;
  fields: LayoutField[];
  size?: string;        // 可选覆盖；缺省由最终游标推导
  union?: boolean;      // 字段共享偏移，允许重叠
}

interface LayoutField {
  id: string;
  name: string;
  kind: LayoutKind;     // 标量 | bytes | string | bits | record | array
  at?: string;          // 字节偏移锚点；缺省自动
  size?: string;        // bytes/string 长度
  count?: string;       // array 数量
  of?: string;          // record/array 的布局 id；array 也可是标量 kind
  endian?: Endian;
  unit?: string;        // bits 存储字节
  bit?: string;         // bits 组内位偏移
  width?: string;       // bits 位宽
  values?: Record<string, string>; // 枚举显示，不改变值
  role?: 'address' | 'offset' | 'index';
}
```

- 字段按顺序处理；`at` 锚定，否则接在游标后；结构长度推导或 `size` 覆盖。没有 `auto` 布尔、没有模式转换、没有第二套偏移输入。
- `record` 只引用 `layout/<id>`；`array` 引用布局或标量 kind。布局内不嵌入 pack 类型，避免把 pack 的 `transform` 带进不可序列化的布局。
- `union: true` 的布局允许字段共享 `at`；普通布局字段重叠报错。`values` 只是显示映射，原始值和端口值保持整数。
- 字段 id 稳定；新增字段时扫描现有 `f1..` 分配下一个，不再维护 `nextField`。端口只用字段 id，改名不断线。
- `compileLayout` 递归解析嵌套布局，产出具体 `TypeDef`：字段 `name` 用字段 id、`label` 用显示名。这样布局和 pack 共用 `decodeRecord` / `fieldSize`。
- 备选方案：自动/手动模式开关。放弃，因为“写 `at` 就固定，不写就自动”已经覆盖两种需求，少一个状态就少一组转换、撤销和迁移分支。

### 5. pack 引用布局用物化，而不是快照

`TypeDef` 增加 `ref?: { kind: 'layout'; id: string }`。`layoutType(id)` 返回占位类型；`materializePack(pack, registry)`：

- 递归解析布局引用；
- 按布局当前长度计算 pack 的自动偏移、位域组和结构长度；
- 检测缺失、禁用与循环；
- 返回 `types` 与节点 `def.type` 都是具体 `TypeDef` 的 pack 视图，`transform` 原样保留；
- 按 pack 对象身份 + 注册表修订缓存。

求值、`portsFor`、结构树、跟随候选统一读物化结果。布局修改后缓存失效，下一次求值自动生效，不需要重新导入 pack。

备选方案：加载时把布局复制成快照。放弃，因为布局改一次就会静默使用旧偏移，失去复用意义。

### 6. 解码与结构树共用一条路径

- `readStructure(src, at, entry, index?)`：pack 来源用物化后的 `decodeRecord` + `transform`；布局来源用 `compileLayout` 产出的 `TypeDef`，无 transform；嵌套 `record`/`array` 递归调用同一函数。
- 嵌套 record 输出 `InstanceView`，数组输出 `InstanceView[]` 或标量数组；端口类型分别为 `instance` / `list`，继续由元素解析、按下标取项和结构树展开。
- 布局来源的结构树构造一个合成 `BlueprintPack`（类型名、字段、布局 id），复用现有 `StructTree` 的展开、分页和问题定位。
- `FieldView` 增加可选稳定字段 id/端口名；pack 类型继续用字段名作为端口身份。

### 7. 布局编辑器与声明粘贴保持单一路径

- 编辑器字段表直接展示推导后的偏移（只读）和可选 `at` 输入；改字段类型/宽度、插入、删除、重排都立即重算未锚定部分。没有“自动模式”开关或“转换为手动”动作。
- 嵌套字段的目标选择器只列布局；pack 类型在“读结构”的根结构选择器中出现。
- “粘贴声明生成布局”使用纯函数解析器（建议 `src/bp/declaration.ts`）：
  - 支持 `struct` / `union` / `typedef struct`、`Type name;`、`Type name[N];`、`Type name : width;`、`//` 与 `/* */`、同批或现有布局引用；
  - 类型映射覆盖常用定宽整数、浮点、`char[N]`；
  - 只做紧凑排布；需要 ABI 填充时由用户给字段写 `at`，没有对齐选项；
  - 返回 `layouts` + 逐行 `problems`，有错误不返回可提交结果；UI 预览后一次提交，多个布局也是一条撤销记录；
  - 不执行任何输入。
- 备选方案：用 `new Function` 复用 pack 解析。放弃，因为粘贴内容必须走无执行路径。

### 8. 导出与模板只生成新格式

- 布局导出为 pack 源码：递归导出被引用的布局，按当前几何生成 `at` 或自动字段，位域用 `bits(name, width, { unit, bit })`，数组用 `array(name, LayoutType, count)`。布局只嵌套布局，因此不需要处理 pack 转换函数。
- pack 模板全部使用新 DSL；模板校验作为单元测试运行。
- 文档给出旧写法到新写法的对照表，但运行时**不**做自动转换。

### 9. C 构造映射到最小原语

不实现 C 解析器或预处理器。复杂 C 源码先解析成最终内存布局，再按以下映射表达：

| C 构造 | pack 表示 | 布局表示 |
| --- | --- | --- |
| 命名嵌套结构 | `record(name, Type)` / `array(name, Type, count)` | `record` / `array` 引用另一布局 |
| 匿名嵌套结构或联合 | 生成稳定类型名后 `record` / `array` | 生成稳定布局名后引用 |
| `union` | `union(name, fields)` 共享偏移 | `union: true` 布局，字段共享 `at` |
| 枚举 | 整数字段 + `values` 显示映射 | 整数字段 + `values` 显示映射；粘贴时底层宽度必须显式，否则报错 |
| 宏 / `#define` | 不展开；影响布局的值写成具体数字 | 不展开；粘贴前解析成具体数字，否则报未知标识符 |
| `#pragma pack` / 自然对齐 | 不推断；用 `at` / `align` / `pad` | 不推断；用字段 `at` 显式对齐 |
| 指针 | `ptr`，宽度由 `pointerSize` 决定，不自动解引用 | 固定宽度整数 + `role: address`，不自动解引用 |
| 位域 | `bits(name, width, { unit, bit })` | 位域字段的 `unit` / `bit` / `width` |

原则：结构定义描述**解析后的字节布局**，不描述编译器、宏或 ABI 的推导过程。这样同一份定义在任何机器上都得到相同结果；C 源码的语义由作者或外部转换负责落地。

## Risks / Trade-offs

- **旧 pack 与旧蓝图全部失效** → 同一次变更更新所有随附示例、生成脚本、缓存键和回归脚本；旧格式返回明确错误。用户已有文件保持原样，不被改写。
- **新 DSL 需要重新学习** → 入口更少：只有 `(name, opts?)`、`at`、`pad/align` 和 `bits(name, width, opts?)`；文档给出对照表与模板。
- **布局不能嵌套 pack 类型** → 跨来源组合通过根结构选择、`layoutType` 或导出实现；避免 transform 无法序列化的问题。
- **物化缓存失效错误** → 缓存键包含布局数组引用与启用 pack 集合；用“改布局后不重导 pack”的回归覆盖。
- **声明解析器覆盖不全** → 只承诺文档化子集；宏、条件编译、未知类型给出具体行号，不执行、不猜测。
- **嵌套结构深递归** → 复用现有深度、数量、字节预算；结构树继续分页。

## Migration Plan

1. 定义 v3 文档类型、`structureId` 与端口格式；更新 `doc.ts`、`persist.ts`、示例生成脚本，旧版本直接拒绝。
2. 实现新 pack DSL 的单套签名、几何规则、位域、直接类型引用与校验；把 `samples/*.bp.ts` 和模板全部迁移，删除旧重载。
3. 实现 `StructureRegistry`、`materializePack`、`compileLayout` 到 `TypeDef` 的统一解码；接入求值、端口、结构树、跟随与节点库。
4. 布局模型、编辑器、嵌套布局、声明粘贴与导出；更新无脚本示例。
5. 模板、文档、单元测试与浏览器回归；全量构建验证。

回滚策略：不提供运行时迁移。回滚到旧版本时，旧版本不读 v3；新版本不读 v2。用户文件不被自动改写，避免任何“猜格式”的兼容分支。
