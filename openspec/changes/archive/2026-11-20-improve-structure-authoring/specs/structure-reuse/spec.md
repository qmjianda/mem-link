## Purpose

让在 pack 或蓝图布局中定义的结构互相可用，按单一稳定身份引用而不是复制字段表，从而避免同一个结构在两种入口之间分叉。

## ADDED Requirements

### Requirement: 结构身份只有一种表示

结构引用 MUST 只使用 `structureId` 一个参数。文档布局的稳定 id MUST 为 `layout/<layoutId>`，pack 类型的稳定 id MUST 为 `pack/<encodedPackId>/<encodedTypeName>`；字段端口 MUST 统一为 `field:<structureId>:<fieldId>`。节点参数与端口 MUST NOT 再提供裸布局 id、按显示名引用或按名称回退的第二条解析路径。显示名与 pack 名可修改，稳定 id 不变；重命名不得断开已有节点或连线。旧版蓝图格式不进入本格式的解析路径。

#### Scenario: 选择布局与选择 pack 类型使用同一参数

- **GIVEN** 用户分别用一个读取节点选择 `layout/header`，用另一个节点选择 `pack/p1/Header`
- **WHEN** 保存并重新打开蓝图
- **THEN** 两个节点仍保存各自的 `structureId`，字段端口分别使用对应的 `field:...` 名称

#### Scenario: 改名不断开

- **GIVEN** 一个读取节点引用 `layout/header`
- **WHEN** 用户把布局显示名改为“文件头”或把 pack 显示名改名
- **THEN** `structureId` 与字段端口不变，节点和连线继续有效

### Requirement: 结构选择器统一列出布局与 pack 类型

“读结构”“展开数组”“遍历链表”以及元素解析的结构选择器 MUST 同时列出当前文档的布局和已启用 pack 的类型，并按来源分组、标明名称、大小与来源。禁用的 pack MUST NOT 提供结构候选；重新启用后候选恢复。已有节点引用被禁用 pack 的类型时 MUST 报告结构不可用，不得悄悄改用其他类型。

#### Scenario: 用 pack 类型做无脚本读取

- **GIVEN** 图中已导入一个包含 `Header` 类型的 pack，但没有任何该 pack 的结构节点
- **WHEN** 用户在“读结构”的结构选择器中选择 `pack/p1/Header`
- **THEN** 节点按该类型读取记录并输出字段端口，不需要添加 pack 的结构节点

#### Scenario: 禁用 pack 后候选消失

- **GIVEN** 一个读取节点当前引用某个 pack 类型
- **WHEN** 用户禁用该 pack 后打开结构选择器
- **THEN** 该 pack 的类型不再出现在候选中；已有节点报告结构不可用

### Requirement: pack 可以按稳定 id 引用布局

pack MUST 通过 `layoutType('layout/<id>')` 按稳定布局 id 引用文档布局，并可在 `structNode`、`listNode`、`arrayNode` 以及 `record`/`array` 字段中使用。引用 MUST 保持 live 关系：布局被修改后，下一次求值使用最新定义，不需要重新导入 pack。由布局派生的字段端口 MUST 使用布局的稳定字段身份，使字段改名不断开连线。布局缺失、被删除或形成循环引用时 MUST 报告可定位错误，不得回退到同名类型或空结构。

#### Scenario: 布局字段改名后连线仍有效

- **GIVEN** pack 的 `structNode(layoutType('layout/header'))` 已把 `count` 字段接到下游节点
- **WHEN** 用户把布局字段显示名从 `count` 改为 `itemCount`
- **THEN** 节点显示新名称，原连线仍绑定同一字段，求值不需要重新导入 pack

#### Scenario: 引用成环

- **GIVEN** 布局 A 引用布局 B，布局 B 又引用布局 A，且 pack 引用 A
- **WHEN** 求值引用 A 的 pack 节点
- **THEN** 报错指出循环经过的布局与字段，不进入无限递归

### Requirement: 布局可以导出为 pack 类型

布局编辑器 MUST 提供“导出为 pack 类型”，根据当前布局生成可直接粘贴进 `.bp.ts` 的类型定义源码。导出 MUST 保留字段名、锚点或自动排布语义、字节序、位域、嵌套布局引用、数组数量、枚举 `values` 与联合共享偏移；引用其他布局时 MUST 递归生成可解析的依赖片段。布局只嵌套布局，因此导出不需要处理 pack 转换函数。生成的源码 MUST 能通过现有 pack 加载与校验，并在同一段字节上得到与布局读取一致的字段值。

#### Scenario: 导出带位域和嵌套数组的布局

- **GIVEN** 一个布局包含共享存储单元的位域，以及一个引用另一布局的定长数组
- **WHEN** 用户选择“导出为 pack 类型”并把结果粘贴进新的 pack
- **THEN** pack 加载成功，位域数值与数组元素字段值和布局读取一致

#### Scenario: 导出联合与枚举

- **GIVEN** 一个 `union: true` 布局包含 `u32 asU32` 与 `f32 asF32`，另一个布局字段带 `values` 枚举映射
- **WHEN** 用户导出为 pack 类型
- **THEN** 生成 `union(...)` 与带 `values` 的整数字段，读取值与布局一致

#### Scenario: 导出不执行布局内容

- **GIVEN** 布局字段名中包含引号或换行等字符
- **WHEN** 用户导出为 pack 源码
- **THEN** 生成器正确转义或规范化名称，导出过程不执行任何布局文本

### Requirement: 同一结构从不同入口得到一致结果

同一个结构通过 pack 节点或无脚本读取节点进入时，MUST 使用相同的字段偏移、长度、字节序、嵌套和位域解释，并得到相等的字段值。pack 来源的字段转换函数 MUST 在无脚本读取中同样生效；布局来源没有转换函数时 MUST 使用原始值，不得伪造转换。两侧的 `typeName`、结构长度与字段定位 MUST 指向同一段字节。

#### Scenario: pack 节点与读结构结果一致

- **GIVEN** 同一个 pack 类型既通过 `structNode` 读取，也通过“读结构”在相同地址读取
- **WHEN** 比较两边的字段值、字段偏移与结构长度
- **THEN** 全部相等；带 `transform` 的字段在两边都显示转换后的值

#### Scenario: 布局没有转换函数

- **GIVEN** 一个布局字段是普通 `u16`
- **WHEN** 分别通过布局读取和由该布局导出的 pack 类型读取
- **THEN** 两边都输出原始数值，不出现仅在一侧生效的隐式转换

### Requirement: 结构引用诊断不静默回退

结构引用 MUST 按 `structureId` 解析到唯一来源。以下情况 MUST 产生可定位的问题，并停止该节点的结构读取：布局或 pack 不存在、pack 已禁用、引用类型被删除、不同 pack 声明了同名类型但 `structureId` 未记录来源、嵌套或布局引用成环。系统 MUST NOT 按显示名选择第一个同名类型，也不得用空字段或全零记录代替失败结果。

#### Scenario: 删除被引用的布局

- **GIVEN** 一个读取节点引用 `layout/header`
- **WHEN** 用户删除该布局并求值
- **THEN** 节点报告结构缺失并指出原结构 id；不会读取同名的其他布局或输出空记录

#### Scenario: 跨 pack 同名类型不猜

- **GIVEN** 两个已启用 pack 都声明了 `Header`
- **WHEN** 用户从候选列表选择其中一个
- **THEN** 候选项按 `pack/<encodedPackId>/Header` 区分；节点记录明确的 pack 与类型，后续不会因加载顺序改变而换用另一个 `Header`
