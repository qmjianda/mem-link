## 1. 蓝图 v3 与单一结构身份

- [x] 1.1 把 `BLUEPRINT_FORMAT` 升级为 `memlink-blueprint/3`，节点参数改为 `structureId`，字段端口统一为 `field:<structureId>:<fieldId>`；`parseDoc` 对 v2 返回明确的不支持错误，不做迁移或字段猜测。验证：v3 示例可打开，v2 文件被拒绝且不修改原文件。
- [x] 1.2 把本地缓存键升级为 `memlink:graph:v3`，`persist.deserialize` 只接受 v3；导出与自动缓存使用同一格式。验证：旧缓存被忽略，新缓存可重开。
- [x] 1.3 更新 `samples/*.blueprint.json` 与 `scripts/gen-*.mjs` 到 v3 的 `structureId` / 字段端口格式；删除旧格式生成分支。验证：两个无脚本示例与 NVMe 示例重新生成后可直接打开、求值无错误。

## 2. 新 pack DSL

- [x] 2.1 在 `src/core/pack.ts` 实现单套签名的布局构建器：`struct(name, fields, opts?)` / `union(name, fields, opts?)`，标量/字符串/字节字段统一 `(name, opts?)`，`opts.at` 锚定偏移，`opts.size` 覆盖结构长度；未锚定字段按游标自动排布。删除旧的 `(name, offset, ...)` 重载。验证：自动、锚定、混用、长度覆盖四类单测。
- [x] 2.2 实现 `pad(n)` 与 `align(n)` 布局指令，只允许出现在 `fields` 数组中；零、负数、非整数报字段级错误。验证：填充与对齐后的偏移和长度正确。
- [x] 2.3 实现 `record(name, Type, opts?)` 与 `array(name, Type | ScalarKind, count, opts?)`：直接类型引用递归登记，数组支持标量 kind；同名不同定义报错，同名同对象只登记一次；删除按字符串名称引用记录类型的路径。验证：嵌套结构与标量数组解码通过。
- [x] 2.4 实现单一位域语法 `bits(name, width, opts?)`：连续位域自动成组，取最小 1/2/4/8 字节单元；`unit` 强制宽度，`bit` 指定位偏移；溢出、零宽、超过 64 位报错。删除五参数写法。验证：小端/大端、共享单元、显式宽度、溢出用例。
- [x] 2.5 重写 `validateBlueprintPack`：重复字段名、重叠（union/位域除外）、越界、未知类型、循环引用、位宽非法、锚点非法给出类型/字段/期望值。验证：每类错误都有单测，节点不运行。
- [x] 2.6 把 `samples/*.bp.ts`、模板和测试中的 pack 全部迁移到新 DSL；更新 `types/memlink-bp.d.ts` 的声明与注释。验证：`tsc --noEmit` 通过，所有 pack 能加载并求值。
- [x] 2.7 实现字段 `values` 枚举显示映射与 `union` 重叠校验：`values` 只影响显示，原始/端口值保持整数；普通 `struct` 重叠报错，`union` 允许共享偏移。验证：枚举下游仍得到数字；union 两个字段各自解码。

## 3. 结构注册表与 pack 物化

- [x] 3.1 实现 `StructureRegistry`：文档布局 id 为 `layout/<id>`，pack 类型 id 为 `pack/<encodedPackId>/<encodedTypeName>`；只包含启用的 pack；精确匹配，缺失返回可定位问题，不按名称回退。验证：跨 pack 同名类型可区分，禁用 pack 解析失败。
- [x] 3.2 扩展 `TypeDef` 的 `ref` 标记并在 DSL 中提供 `layoutType('layout/<id>')`；实现 `materializePack(pack, registry)`，解析布局引用、计算自动偏移/长度/位域、检测缺失与循环，按 pack 身份与注册表修订缓存。验证：布局改宽后不重导 pack 即得到新偏移；缺失和循环报错。
- [x] 3.3 让求值、`portsFor`、结构树、跟随候选和节点库统计统一读物化后的 pack；删除这些路径对原始 `def.type` 的直接读取。验证：现有 pack 示例行为不变，单测通过。
- [x] 3.4 为 `layoutType` 写回归：pack 根节点引用布局、嵌套 `record` 引用布局、字段改名后连线仍有效、删除布局后节点报错。验证：对应单测与浏览器回归通过。

## 4. 布局模型与统一解码

- [x] 4.1 重构 `BinaryLayout` / `LayoutField`：去掉 `nextField` 和 `auto`，字段增加可选 `at`、`size`、`count`、`of`、`unit`、`bit`、`width`；kind 增加 `record`/`array`；布局增加可选 `size` 覆盖。更新 `validLayoutDocument`，只接受新形状。验证：新布局文档通过校验，缺字段/旧形状被拒绝。
- [x] 4.2 扩展 `compileLayout`：按单套几何规则解析 `at`/自动字段、嵌套布局、位组、长度覆盖，产出具体 `TypeDef`；字段 `name` 用稳定字段 id、`label` 用显示名；检测循环、越界、未知布局。验证：自动、锚定、嵌套、位域、循环、越界单测。
- [x] 4.3 实现统一 `readStructure`：pack 来源应用 `transform`，布局来源输出原始值；嵌套 record 返回 `InstanceView`，array 返回 `list`；复用深度、数量、字节预算。验证：同一结构两条入口结果一致，越界与预算错误可定位。
- [x] 4.4 更新端口生成：布局 `record` → `instance`、`array` → `list`，字段端口使用 `field:<structureId>:<fieldId>`；让 `element`、`item` 与 `StructTree` 能展开嵌套布局值。验证：表头嵌套表项数组的“读结构 → 列表 → 取项 → 字段”链路通过。
- [x] 4.5 给布局模型加入 `union?: boolean` 与字段 `values`：`union` 布局允许字段共享 `at`，普通布局重叠报错；`values` 只改变显示。验证：联合布局两个字段从同一偏移读取；枚举显示名不影响端口值。

## 5. 无脚本节点接入 pack 类型

- [x] 5.1 让 `structread` / `arrayread` / `listread` 从 `StructureRegistry` 解析 `structureId`，不再只查 `doc.layouts`；旧参数名不保留。验证：布局与 pack 类型都能作为目标，缺失时节点报错。
- [x] 5.2 更新 `LayoutEditor` 的结构选择器：按“本图布局 / pack 名称”分组，显示名称、大小与来源；只写入 `structureId`；禁用 pack 不出现。验证：选择 pack 类型后保存重开仍指向同一类型。
- [x] 5.3 更新跟随候选与快速入口：pack 类型可作为“读结构 / 展开数组 / 遍历链表”的解析入口，候选注明来源与大小；禁用后消失。验证：从合法地址发起解析能看到可用 pack 类型。
- [x] 5.4 增加节点级诊断：结构缺失、pack 禁用、循环引用、来源与类型不匹配带稳定原因码和字段定位；节点不输出空记录。验证：问题面板能选中并居中对应节点。

## 6. 布局编辑器与声明粘贴

- [x] 6.1 重做字段表：显示推导后的偏移（只读）与可选 `at` 输入；插入、删除、改类型/宽度后未锚定字段立即重排；不提供自动/手动模式开关或模式转换。验证：中部插入、锚点保持、长度覆盖三类交互。
- [x] 6.2 增加 `record` / `array` 字段编辑：目标选择器只列布局，数组可填数量；缺失目标、循环、数量非法时阻止提交。验证：嵌套布局保存重开后可继续读取。
- [x] 6.3 实现布局位域编辑：`unit`、`bit`、`width` 三项；连续位域自动成组，溢出时阻止提交。验证：共享存储单元的多个位段独立可选、可高亮字节。
- [x] 6.4 新建纯函数声明解析器（建议 `src/bp/declaration.ts`）：支持 `struct` / `union` / `typedef struct`、匿名嵌套（生成稳定名称）、定长数组、位域、注释、同批与现有布局引用；`enum` 只接受显式底层整数类型并生成 `values`；宏与未知标识符报行号错误；只做紧凑排布，不执行输入。验证：合法/非法声明单测。
- [x] 6.5 在编辑器中加入“粘贴声明生成布局”：预览生成的布局与诊断，确认后一次提交；有错误时不写入任何布局；多个布局只产生一条历史。验证：错误声明提交后文档不变，正确声明一次撤销可全部移除。
- [x] 6.6 布局编辑即时校验：重复字段名、越界、未知嵌套、循环、位宽非法时阻止写入并指出字段。验证：两个节点引用同一布局时，修改一次、撤销一次即恢复。

## 7. 布局导出与跨入口一致性

- [x] 7.1 实现 `layoutToPackSource(layout, registry)`：输出新 DSL 的类型源码，保留字段名、`at` 或自动排布、字节序、位域、嵌套布局引用和数组数量；递归导出依赖布局。验证：导出源码能被 `loadBlueprintPack` 加载。
- [x] 7.2 在布局编辑器加入“导出为 pack 类型”动作，结果放入可复制面板或剪贴板；字段名安全转义。验证：导出的带位域/嵌套数组布局与布局读取在同一字节上字段值一致。
- [x] 7.3 增加跨入口一致性测试：同一 pack 类型通过 `structNode` 与“读结构”读取；同一布局通过布局节点与导出的 pack 类型读取。验证：字段值、偏移、长度、地址一致。

## 8. 模板、文档与全量回归

- [x] 8.1 增加可编译模板：自动布局、位域、嵌套数组、池下标链表、布局引用；新增模板校验测试，确保每个模板能加载并在示例数据上求值。验证：模板测试随 `pnpm test` 运行。
- [x] 8.2 更新 `docs/description-format.md`：新 DSL 的 `at`/自动规则、直接类型引用、`bits`、`layoutType`、布局导出、声明子集；增加 C 构造映射表（嵌套/匿名、union、enum、宏、`#pragma pack`、指针、位域）和旧写法到新写法的对照表（只作文档，不做运行时转换）；更新 `README.md` 与 `types/memlink-bp.d.ts` 注释。验证：文档示例与测试一致。
- [x] 8.3 更新或新增一个同时使用布局与 pack 类型的最小示例，覆盖“同一结构两种入口”；确保打开即有结果、无问题。验证：示例在 v3 格式下可打开、可导出、可重开。
- [x] 8.4 增加浏览器回归：粘贴声明生成布局、插入字段自动重排、嵌套数组读取、小端/大端位域、pack 类型选择、布局导出。验证：新增 `scripts/cdp-verify-structure.mjs` 或扩展现有脚本，全部断言通过。
- [x] 8.5 运行全量验证：`node node_modules/vitest/vitest.mjs run`、`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vite/bin/vite.js build`，并确认 NVMe/无脚本示例、v3 导出与缓存无回归。
