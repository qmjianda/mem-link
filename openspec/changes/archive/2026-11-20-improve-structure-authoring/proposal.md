## Why

同一个结构现在要在两条互不相通的路径里各写一遍：pack 手算偏移，读结构逐字段填写；布局不能嵌套，pack 类型也不能被无脚本节点使用。如果同时保留旧 pack 签名、旧蓝图格式和旧结构 id，只会多出多层兼容分支，让“定义结构”这件事继续分成三套语义。

本轮选择一次性收敛：一套结构语法、一套文档格式、一套结构身份，随附示例全部迁移，旧格式明确拒绝。效率来自少写、少算、少抄；效果来自两边解码结果一致，错误在定义时就能定位。

## What Changes

- **统一的 pack 结构 DSL（BREAKING）**：字段默认按声明顺序自动排布，需要固定位置时在选项里写 `at`；`struct` / `union` 只有一个字段列表入口，结构长度由末尾推导或显式覆盖；`pad(n)` / `align(n)` 处理填充与对齐。移除“显式偏移/自动偏移”两套重载。
- **直接类型引用**：`record` / `array` 直接接收类型对象，嵌套类型自动登记；数组元素可以是类型对象或标量 kind。移除按字符串查类型的写法。
- **单一位域语法（BREAKING）**：`bits(name, width, opts?)` 统一处理自动分组与显式容器，`bit` 指定位偏移、`unit` 指定存储宽度；移除五参数写法。
- **单一结构身份（BREAKING）**：蓝图升级为 `memlink-blueprint/3`；节点只保存 `structureId`，端口统一为 `field:<structureId>:<fieldId>`。文档布局 id 为 `layout/<id>`，pack 类型 id 为 `pack/<encodedPackId>/<encodedTypeName>`。旧 v2 文档和旧 `layoutId` 不再解析。
- **C 构造按解析后的内存布局表示**：命名嵌套用 `record`/`array`，匿名嵌套生成稳定类型名；`union` 共享偏移；枚举是整数字段加 `values` 显示映射，不新增存储类型；宏不展开，影响布局的宏值必须先解析成具体数字；`#pragma pack` 与自然对齐不自动推断，用 `at`/`align` 显式写出；指针用 pack 的 `ptr`，布局用固定宽度整数加 `role: address`。
- **布局快速定义**：字段同样只有一条几何规则——写 `at` 就固定偏移，否则按字段顺序自动排布；结构长度默认推导，可显式覆盖。去掉自动/手动模式切换与模式转换。
- **布局嵌套**：布局字段可引用其他布局，支持定长 `record` 与 `array`；嵌套引用只指向布局，跨 pack 复用发生在“读结构”的根结构选择与 pack 的 `layoutType`，不做布局内嵌 pack 类型的混合路径。
- **粘贴声明生成布局**：支持文档化的 C / TypeScript 风格结构子集（定长数组、嵌套布局、位域、注释），一次性生成多个布局；解析器只做紧凑排布，遇到需要 C ABI 填充的位置由用户给字段写 `at`。
- **双向复用**：pack 类型直接出现在“读结构 / 展开数组 / 遍历链表”的结构选择器里；pack 通过 `layoutType('layout/<id>')` 实时引用布局；布局可导出为 `.bp.ts` 类型源码。引用只按稳定 id，不按显示名。
- **一致解码**：同一个结构从 pack 节点或无脚本节点进入时，偏移、长度、转换、位域、越界与缺失引用诊断一致。
- **模板与校验**：提供可编译的 pack 模板，并加强重复字段、重叠、越界、未知引用、循环引用与位宽错误的定位。

不改变 pack 的信任边界和执行模型；不引入跨蓝图结构库；不实现完整 C 预处理器或任意变长布局。

## Capabilities

### New Capabilities

- `pack-authoring`: pack 结构定义效率，包括单一自动布局规则、直接类型引用、位域、填充对齐、模板与定义期诊断。
- `layout-authoring`: 蓝图内无脚本布局的快速定义，包括单一声明式布局、嵌套布局、粘贴声明生成与即时校验。
- `structure-reuse`: pack 类型与布局之间的双向引用、单一稳定 id、来源选择与导出，保证同一结构在不同入口复用且解码一致。

### Modified Capabilities

- `default-node-library`: 读结构、展开数组、遍历链表与元素端口改为消费统一结构注册表；布局支持嵌套 `record`/`array`；pack 类型可直接作为无脚本解析目标。
- `blueprint-evaluation`: 结构引用缺失、循环与跨来源解析按明确规则报告；同一结构从不同入口进入时字段值一致，不做静默回退。

## Impact

- **BREAKING**：蓝图格式升级为 `memlink-blueprint/3`，旧 v2 文档明确拒绝；旧 `.bp.ts` 的显式偏移/五参数位域写法不再加载，随附示例与模板全部迁移到新 DSL。不为旧写法保留重载、双解析或迁移层。
- **pack DSL 与加载**：`src/core/pack.ts`、`src/core/packgraph.ts`、`src/bp/dsl.ts`、`src/bp/load.ts`、`types/memlink-bp.d.ts`；新增布局构建器、类型引用收集与 `layoutType` 解析。
- **布局与节点**：`src/bp/layouts.ts`、`src/bp/LayoutEditor.tsx`、`src/bp/builtins.ts`、`src/bp/eval.ts`、`src/bp/tree.ts`；结构注册表、嵌套解码、端口生成与诊断。
- **文档与持久化**：`src/bp/doc.ts`、`src/bp/persist.ts`、`src/bp/docstate.ts`、`src/bp/BlueprintApp.tsx`；只接受 v3，缓存与导出使用同一格式。
- **示例与文档**：`samples/`、`scripts/gen-*.mjs`、`docs/description-format.md`、`README.md` 全部更新；新增单元测试与浏览器回归。
