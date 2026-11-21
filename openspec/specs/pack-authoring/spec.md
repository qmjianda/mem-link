# pack-authoring Specification

## Purpose

让 pack 作者（尤其是 AI）用一套统一、可预测的语法定义二进制结构：默认自动排布，需要固定位置时才写锚点；类型直接引用，位域与嵌套只有一种写法，减少算术和记忆负担。

## Requirements

### Requirement: 结构定义只有一套几何规则

pack MUST 只提供 `struct(name, fields, opts?)` 与 `union(name, fields, opts?)` 两种结构入口，`fields` 按声明顺序处理。未写 `at` 的字段 MUST 从当前游标开始，字段结束后游标推进到字段末尾；写了 `at` 的字段 MUST 固定在指定字节偏移，若其结束位置超过当前游标则游标推进到该结束位置。`pad(n)` MUST 在游标处增加 n 字节；`align(n)` MUST 把游标推进到 n 的整数倍。结构长度 MUST 等于最终游标；`opts.size` 显式覆盖时 MUST 不小于最终游标，否则报错。标量、字符串与字节字段的辅助函数 MUST 统一使用 `(name, opts?)` 形式，可选位置参数只能通过 `opts` 传入；`opts.at` 表示字节偏移。`record` / `array` 的必需参数（类型、数量）除外。不得为同一字段提供第二套位置参数重载。

#### Scenario: 默认自动排布

- **GIVEN** `struct('Header', [u16('magic'), u16('head'), u32('count')])`
- **WHEN** 加载并读取该结构
- **THEN** `magic` 偏移 0、`head` 偏移 2、`count` 偏移 4，结构长度 8

#### Scenario: 锚点固定字段位置

- **GIVEN** `struct('Header', [u8('kind'), u32('flags', { at: 16 }), u16('tail')])`
- **WHEN** 读取该结构
- **THEN** `flags` 位于偏移 16、`tail` 位于偏移 20，结构长度为 22，9–15 字节不被解释成字段

#### Scenario: 填充与对齐

- **GIVEN** `struct('Header', [u8('a'), align(4), u32('b'), pad(2)])`
- **WHEN** 读取该结构
- **THEN** `b` 位于偏移 4，结构长度为 10

#### Scenario: 显式长度不能小于内容

- **GIVEN** `struct('Header', [u32('value')], { size: 2 })`
- **WHEN** 加载 pack
- **THEN** 报错指出结构长度 2 小于字段结束位置 4

### Requirement: 类型直接引用且自动登记

`record(name, type, opts?)` 与 `array(name, type, count, opts?)` MUST 接受类型对象；数组也 MUST 接受标量 kind 字符串。pack MUST 自动登记被直接引用的类型及其递归引用，调用方不必把嵌套类型重复列进 `types`。同一个类型对象多处引用 MUST 只登记一次；不同定义使用同一类型名 MUST 报错，不得后写覆盖先写。按字符串名称引用记录类型的旧方式 MUST NOT 提供。

#### Scenario: 嵌套类型无需重复列出

- **GIVEN** `const Point = struct('Point', [i32('x'), i32('y')])`，以及 `struct('Shape', [record('origin', Point), array('points', Point, 4)])`
- **WHEN** pack 只把 `Shape` 写进 `types`
- **THEN** `Point` 被自动登记，`record` 与 `array` 都能正确解码

#### Scenario: 标量数组

- **GIVEN** `struct('Table', [array('values', 'u16', 8)])`
- **WHEN** 读取该结构
- **THEN** `values` 输出 8 个 `u16` 元素

#### Scenario: 同名不同类型被拒绝

- **GIVEN** pack 中有两个 `name` 都是 `Entry` 但字段不同的类型对象，分别被不同结构引用
- **WHEN** 加载 pack
- **THEN** 加载失败并指出两个 `Entry` 的定义位置

### Requirement: 位域只有一种写法

pack MUST 只提供 `bits(name, width, opts?)`：`width` 为 1–64 的位宽；`opts.bit` 为组内位偏移，`opts.unit` 为存储单元字节数（1/2/4/8）。未写 `bit` 的位域 MUST 加入当前位组，位偏移按声明顺序递增；位组从当前游标开始，存储单元取能容纳整组的最小 1/2/4/8 字节。写 `opts.unit` 或前一个字段不是位域时 MUST 开始新位组；写 `opts.bit` 时 MUST 从该位偏移开始在当前组内放置。位组结束时游标 MUST 推进到存储单元末尾，后续非位域字段从该处开始。位组总位数超过存储单元或 64 位 MUST 报错。位域 MUST 作为具名、可接线的字段输出，数值按结构字节序解释。

#### Scenario: 相邻位域共享一个字节

- **GIVEN** `struct('Flags', [bits('kind', 2), bits('active', 1), bits('mode', 3), u8('reserved')])`
- **WHEN** 读取该结构
- **THEN** 三个位域落在偏移 0 的同一个 1 字节单元，位偏移分别为 0、2、3，`reserved` 位于偏移 1

#### Scenario: 显式存储宽度

- **GIVEN** `struct('Flags', [bits('kind', 2, { unit: 2 }), bits('active', 1)])`
- **WHEN** 读取该结构
- **THEN** 两个位域共享偏移 0 的 2 字节单元，结构长度为 2

#### Scenario: 位宽溢出被拒绝

- **GIVEN** `struct('Flags', [bits('a', 7), bits('b', 2)])`
- **WHEN** 加载 pack
- **THEN** 报错指出当前位组需要 9 位，超过最小可用单元 1 字节

### Requirement: C 构造只映射到少量原语

pack MUST 用最小原语表示 C 构造，不引入 C 解析器或预处理器：命名嵌套结构与数组分别用 `record` / `array`，匿名嵌套结构或联合 MUST 生成稳定的类型名后再引用；`union` MUST 共享字段偏移并允许重叠，普通 `struct` 的字段重叠 MUST 报错。枚举 MUST 表示为整数字段加可选 `values` 映射（数值 → 显示名），映射只影响显示，不改变字段宽度、原始值或端口值。宏 MUST NOT 展开：影响偏移、数量或长度的宏值 MUST 在编写 pack 前解析成具体数字；`constants` 只供 transform / next / calc 使用，不参与布局推导。`#pragma pack`、`__attribute__((packed))` 与编译器自然对齐 MUST NOT 自动推断；需要对齐或填充时 MUST 用 `at` / `align` / `pad` 显式写出。指针 MUST 用 `ptr`，宽度由 `pointerSize` 决定，不自动解引用。

#### Scenario: 匿名嵌套结构获得稳定类型名

- **GIVEN** 一个 C 结构在字段中内联匿名 `struct { u16 x; u16 y; } pos;`
- **WHEN** 把它表示为 pack
- **THEN** 生成一个具名嵌套类型并用 `record('pos', Pos)` 引用，字段端口可继续展开，类型名在重复导入时保持稳定

#### Scenario: 联合共享偏移

- **GIVEN** `union('Value', [u32('asU32'), f32('asF32')])`
- **WHEN** 读取该联合
- **THEN** 两个字段从同一偏移读取，宽度都为 4，普通 `struct` 中同样的重叠会被拒绝

#### Scenario: 枚举只改变显示

- **GIVEN** `u16('state', { values: { 0: 'Idle', 1: 'Run' } })`
- **WHEN** 读取值为 1 的字段
- **THEN** 显示为 `Run`，原始值、端口值和字段宽度仍是整数 1 与 2 字节

#### Scenario: 宏与对齐必须显式落地

- **GIVEN** C 源码使用 `#define COUNT 8` 与 `#pragma pack(1)`，`COUNT` 决定数组长度
- **WHEN** 把它表示为 pack
- **THEN** 数组写 `array('items', Item, 8)`，偏移按紧凑规则或 `at` 显式给出；pack 不尝试读取或展开 `#define` / `#pragma`

### Requirement: pack 可引用蓝图布局

pack MUST 提供 `layoutType(id)`，按稳定布局 id（`layout/<id>`）返回可用于根节点或嵌套字段的类型引用。该引用 MUST 指向当前文档中的布局定义，而不是加载时复制的一份快照；布局字段变化后，下一次求值 MUST 使用新定义。布局不存在、被删除或引用成环时 MUST 产生可定位的错误，不得退化成空结构或同名类型。

#### Scenario: pack 引用布局并跟随修改

- **GIVEN** pack 使用 `structNode(layoutType('layout/header'))`，文档中存在 `header` 布局
- **WHEN** 用户把布局中的 `count` 字段宽度从 `u8` 改成 `u16` 并重新求值
- **THEN** pack 节点输出新的字段宽度和结构长度，不需要重新导入 pack

#### Scenario: 缺失布局不是空结构

- **GIVEN** pack 引用了文档中不存在的布局 id
- **WHEN** 加载或求值该 pack
- **THEN** 报告布局缺失，节点不输出任何伪造字段

### Requirement: 模板可直接作为 AI 起点

项目 MUST 提供并持续校验一组可编译的 pack 模板，至少覆盖自动布局、位域、嵌套数组、池下标链表和布局引用。模板 MUST 与当前 DSL 同步，能够通过现有 pack 加载与求值流程；文档 MUST 给出每个模板的用途和可修改点。模板不得包含特定协议依赖或不可运行的占位代码。

#### Scenario: 模板随 DSL 一起回归

- **GIVEN** 仓库中的全部 pack 模板
- **WHEN** 运行模板校验
- **THEN** 每个模板都能加载、通过定义期校验，并在示例数据上得到预期的字段值

#### Scenario: AI 复制模板即可扩展

- **GIVEN** 一个需要“结构体 + 定长数组 + 位域”的新 pack
- **WHEN** 作者从模板复制自动布局和位域片段并替换类型名
- **THEN** 不手算偏移即可得到可加载的 pack

### Requirement: 定义期诊断指出具体字段

pack 加载与校验 MUST 报告重复字段名、字段重叠（union 与位域除外）、超出结构范围、非法偏移/长度、未知类型引用、嵌套引用成环、位宽非法以及自动布局无法容纳的位域。诊断 MUST 指出类型名、字段名和可比较的期望值与实际值；布局构建器 MUST NOT 静默修正非法锚点或猜测字段宽度。

#### Scenario: 越界字段被拒绝

- **GIVEN** 一个结构长度为 8，字段 `flags` 锚定在偏移 8、宽度为 4
- **WHEN** 加载 pack
- **THEN** 报错指出 `flags` 的 `offset 8 + size 4 > 8`，节点不运行

#### Scenario: 嵌套循环引用被拒绝

- **GIVEN** 类型 A 包含类型 B，类型 B 又包含类型 A
- **WHEN** 加载 pack
- **THEN** 报错指出循环经过的类型与字段，不进入无限解码
