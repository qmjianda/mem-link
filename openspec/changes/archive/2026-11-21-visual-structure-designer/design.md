## Context

见 `proposal.md` — Why。当前实现把无脚本布局编辑压在一个 318px 检查器里：

- `src/bp/Inspector.tsx` 挂载 `LayoutEditor`，把结构选择、布局属性、字段表、声明导入和导出都放在右栏。
- `src/bp/LayoutEditor.tsx` 用表单逐字段编辑；偏移只能看推导值，自动/锚定、嵌套、位域和重叠关系不可见。
- `src/bp/layouts.ts` 的 `compileLayout` 是权威几何/校验入口，但遇到第一个错误就抛异常，且没有可供画布使用的 span、gap、位域占用诊断。
- `src/bp/BlueprintApp.tsx` 用单一文档对象、`commit` 和全局历史；`doc.layouts` 是布局的唯一来源，文档格式为 `memlink-blueprint/3`。
- `src/bp/structure.ts` 的 `StructureRegistry` 已经合并布局与 pack 类型，字段端口为 `field:<structureId>:<fieldId>`。
- `src/bp/ModalFocus.ts` 已提供模态焦点陷阱和关闭后焦点恢复；`src/bp/designer` 尚不存在。
- 原型 `prototype/structure-designer.html` 已验证字节/位视图、拖拽、位域、重叠、撤销和全屏入口的手感，但它是独立模拟数据，不作为生产实现。

关键约束：不改 `BinaryLayout`、`doc.ts`、`persist.ts` 或求值器；现有布局直接可用；pack 类型仍只读；设计器只是 `doc.layouts` 的另一种编辑视图。

## Goals / Non-Goals

**Goals:**

- 全屏、可深链、可键盘操作的结构设计器，覆盖字节视图、位视图、嵌套、引用和诊断。
- 所有可视操作与字段表编辑共用一套 `BinaryLayout` 几何、校验和撤销语义。
- 商业级交互：明确的拖动状态机、非法落点回弹、文本草稿、会话检查点、焦点恢复、问题定位、多选批量操作、性能预算。
- 不修改文档格式，不引入第二套布局模型或兼容分支。

**Non-Goals:**

- 任意节点连线、力导向图、自由画布外的结构关系。
- 编辑 `.bp.ts` / pack 类型；pack 仍只读，跨来源复用仍按现有 `structureId`。
- 完整 C 解析、宏展开、ABI 对齐推断、变长布局。
- 多用户协作、云端结构库、跨蓝图复用。
- 触摸优先；本轮以桌面指针 + 键盘为主，保留 pointer events 以便后续扩展。
- 跨类型混合多选拖动；多选只用于同类字节字段整体移动、批量删除、复制/粘贴、重复和批量锚定/恢复自动。

## Decisions

### 1. 页面级受控视图，而不是第二份文档

`DesignerApp` 作为全屏 portal 挂在 `document.body`，由 `BlueprintApp` 传入：

```ts
interface DesignerAppProps {
  layouts: BinaryLayout[];
  stack: string[];                    // layout ids, last = current
  open: boolean;
  usage: LayoutUsageIndex;            // 节点/连线/pack 引用
  sessionDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onNavigate(stack: string[]): void;
  onClose(): void;
  onApply(next: BinaryLayout[], label: string, mergeKey?: string): ApplyResult;
  onRestoreSession(): void;
  onUndo(): void;
  onRedo(): void;
}
```

- `DesignerApp` 不复制文档，不做自己的持久化；当前布局从 `layouts` 派生，编辑通过 `onApply` 回到 `BlueprintApp.commit`。
- `onApply` 在父级先校验全部布局，再一次性提交；返回 `{ ok: true }` 或 `{ ok: false, problems }`。失败时设计器保留上一有效状态并聚焦问题。
- 设计器只持有 UI 状态：当前视图、缩放/平移、选择、拖动预览、文本草稿、问题面板页签。它们不进入 `doc`。
- 会话检查点由父级保存 `designerBaseLayouts`；`sessionDirty` 用 `layoutsEqual(doc.layouts, base)` 计算，撤销/重做后仍准确。`onRestoreSession` 把 base 作为一次新编辑提交，因此“放弃本次修改”本身也可撤销。
- 备选方案：在设计器内维护一份 `DocState` 草稿，关闭时提交。放弃，因为会与全局撤销、自动缓存、浏览器后退和跨节点引用产生第二套状态。

### 2. 单一几何权威：把 `compileLayout` 拆成“构建 + 抛错”两层

新增纯函数层，避免画布、诊断和提交各算一遍：

```ts
interface LayoutBuild {
  layout: BinaryLayout;
  size: number;
  cursor: number;
  fields: PositionedField[];   // id, name, kind, offset, size, auto
  spans: Span[];
  bitGroups: BitGroup[];
  free: Span[];
  byteOverlaps: [Span, Span][];
  bitOverlaps: [string, string][];
  problems: LayoutProblem[];
}

buildLayout(layout, resolve, { collect: boolean }): LayoutBuild
```

- `compileLayout` 保持现有签名与抛错行为，但内部调用 `buildLayout(..., { collect: false })`；第一个问题仍抛出 `ReadIssue`。
- `analyzeLayouts(layouts)` 用同一构建器 `{ collect: true }` 产出所有布局的诊断，供设计器、字段表和问题面板使用。
- `measureLayout(layout, resolve)` 只做游标/span/位组计算，不校验，用于拖动预览；它仍然复用构建器的字段尺寸、位组分组和 overflow 判定。
- 在 `src/bp/layouts.ts` 中提取共享的 `fieldSize`/`bitGroup`/`cursor` 逻辑；`validLayoutDocument` 仍只做形状校验，语义校验由构建器负责。
- 备选方案：设计器自己写一套 span 计算。放弃，因为拖动预览、提交校验和运行期解码会逐渐分叉，正是本轮要消除的问题。

### 3. 纯操作 + 受控提交

新增 `src/bp/designer/operations.ts`，所有操作接收旧布局并返回新布局或问题，不修改输入：

```ts
createField(model, input, offset): OpResult
moveFields(model, ids, target): OpResult
resizeField(model, id, size): OpResult
reorderFields(model, ids, index): OpResult
anchorFields(model, ids): OpResult
restoreAuto(model, ids): OpResult
setFieldProp(model, id, patch): OpResult
setBitGroupUnit(model, groupKey, unit): OpResult
addBit(model, groupKey, bit?, width?): OpResult
deleteFields(model, ids): OpResult
duplicateFields(model, ids): OpResult
copyFields(model, ids): FieldClip
pasteFields(model, clip, target): OpResult
createLayout(model, input): OpResult
duplicateLayout(model, id): OpResult
```

- `model` 包含 `layouts`、当前布局和 `analyzeLayouts` 结果；操作只产生候选 `BinaryLayout`，由 `onApply` 统一校验/提交。
- 一次手势、一次文本 blur/Enter、一次导入、一次批量操作各调用一次 `onApply`。拖拽期间不调用。
- 键盘连续微调（方向键）可用 `mergeKey` 合并为一条历史；鼠标拖动始终一次。
- 备选方案：每个操作直接 `commit`。放弃，因为多字段操作、嵌套更新和失败回滚会产生半截状态。

### 4. 选择模型：单主选中 + 有限多选

```ts
type DesignerSelection =
  | { kind: 'none' }
  | { kind: 'layout' }
  | { kind: 'fields'; primary: string; ids: string[] }
  | { kind: 'bitsGroup'; key: string; member?: string };
```

- 字节视图与字段表支持 Ctrl/Cmd+点击切换、Shift+范围选择、Ctrl/Cmd+A 全选；位视图保持单选中（组或成员），避免跨存储单元的位域批量编辑产生语义歧义。
- 多选支持删除、复制/粘贴、重复、批量锚定/恢复自动；同类型的字节字段可以整体拖动并按同一 delta 锚定，混合位域/字节或跨类型拖动明确拒绝。属性面板对混合值显示“混合”，修改后统一应用。
- 选择在画布、字段表、检查器和状态栏同步；切换布局清空选择，切换视图保留可映射的选择。
- 备选方案：全量多选 + 多选拖动。放弃，因为位域、嵌套和 auto/anchor 混合拖动很难给出可预测结果。

### 5. 字节视图：DOM 绝对定位 + 局部预览

- 画布用 DOM 绝对定位字段块，SVG 只画标尺/叠层辅助线；128 个字段不需要 canvas 渲染，DOM 更容易做焦点、可访问名称和命中测试。
- 字段按 `rowBytes` 分段：`start` 每步推进实际段长，而不是整行宽；第一段可聚焦并带名称，续段 `aria-hidden`，避免屏幕阅读器重复。
- 画布外层 `transform: translate(pan) scale(zoom)`；指针坐标先减去画布 rect 再除以 zoom，得到逻辑坐标；缩放/平移不改变文档。
- 拖动状态机：

```
idle
  → pointerdown on body/handle
  → pressed（记录起点、抓取字节、快照）
  → 移动超过阈值 → dragging（显示 ghost + drop outline）
  → pointerup：合法 → onApply；非法 → rollback + problem focus
  → Escape / pointercancel / blur / route change → cancel
```

- 自动字段主体拖动 = 锚定预览，落下写 `at`；字段块内的重排手柄 = 只改声明顺序，落下不写 `at`；锚定字段主体拖动 = 更新 `at`。三类手势在视觉上用不同光标和标签区分，不提供模式开关。
- 非法落点（占用、越界、非联合重叠）显示红色 outline，松手回弹，不写文档、不产生历史；同时在问题面板给出冲突字段。
- 字符串/bytes 右边缘缩放；标量不提供隐式改类型/宽度。数组数量在检查器/字段表编辑，不在画布上拖拽改变。
- 联合布局用堆叠层显示共享偏移，不把重叠标成错误；普通布局的提交状态永远不重叠。
- 空白格点击/拖入创建；选中类型后画布进入 armed 状态，Esc 取消。另提供「插入字段」菜单（可编辑目标偏移），覆盖无拖动路径。
- 备选方案：HTML5 drag and drop。放弃，因为指针捕获、Escape 取消、缩放下坐标和预览一致性都更难控制。

### 6. 位视图：按存储单元分组，显示变换与数据分离

- 分组键为 `offset:unit`；组内成员按 `bit` 排序。`bitW = laneWidth / (unit * 8)`；MSB 在左只改变 `x = (bits - bit - width) * bitW`，不改变 `bit`/`width`/值/校验。
- 位域条是 `role=button` 的可聚焦元素；窄条只显示缩写/首字，`title` 和 `aria-label` 给出完整名称/范围。左右 4px 把手用于缩放，主体用于移动；位宽较窄时仍保留可拖动的中间区域。
- 组头提供 unit 选择、已用/空闲位、添加位域；右侧组检查器提供成员表、bit/width 输入和删除。
- 位域区间在 `buildLayout` 中按 `[bit, bit+width)` 检查；重叠是硬错误，不能提交。添加位域自动找第一个空位；移动/缩放若产生重叠则回弹并指出冲突。
- 没有位域的布局显示空状态：切回字节视图或插入位域；不伪造空组。
- 备选方案：把位域画成第二个画布/自由位布局。放弃，因为会把存储单元和字节偏移的语义拆成两套；按 `at + unit` 分组是唯一与模型一致的表示。

### 7. 检查器、字段表与文本草稿

- 右栏分两个页签：「属性」和「问题 N」。属性页在无选中时显示布局名称/字节序/联合/长度覆盖/推导长度/引用；单字段显示字段属性；位域组显示 unit 和成员；多选显示批量动作与混合值。
- 文本/数字输入用统一 `DraftInput`：
  - 本地保存输入串，不逐键提交；
  - blur 或 Enter 时校验并提交一次；
  - Escape 还原到上一个有效值；
  - 校验失败时保留错误提示并阻止提交；如果用户直接离开，则还原并 toast 说明。
- select/checkbox 立即提交（一次编辑）；`at` 的自动/锚定是字段状态，不是模式开关：自动字段显示推导偏移和「锚定到当前」，锚定字段显示偏移输入和「恢复自动」。
- 字段表按声明顺序显示，不提供会改变语义的排序；列为 `# / 名称 / 类型 / 偏移 / 大小或位宽 / 自动或锚定 / 状态`。行是 roving tabindex；Up/Down、Home/End、PageUp/PageDown 移动，Shift 扩展，F2 在名称单元格内联编辑，Enter 定位到画布。
- 问题点击后：选中字段 → 切到合适视图（字节/位）→ 滚动到可见 → 聚焦字段/输入。布局级问题聚焦布局名称或长度输入。
- 字段和空白格提供右键菜单：改名、复制、重复、删除、锚定/恢复、进入子布局、插入字段；菜单项与工具栏/检查器共享同一操作和禁用原因，不能出现只在右键菜单里才有的命令。
- 备选方案：继续在画布上双击直接改所有字段值。放弃，因为画布命中区域小、缩放下易误触，且与拖动/进入嵌套冲突；画布只做选择和直接几何操作，精确值由检查器/表格承担。

### 8. 布局生命周期与引用安全

新增 `buildLayoutUsage(doc, packs)` 纯函数，汇总：

- 布局父字段：所有 `field.of === layout/<id>` 的布局与字段。
- 图节点：`node.params.structureId === layout/<id>` 的读结构/数组/链表节点。
- 连线端口：`from.port` / `to.port` 以 `field:layout/<id>:` 开头的边，按字段 id 计数。
- pack：递归扫描已加载 pack 的 `types` 与节点 `def.type` 中的 `ref.kind === 'layout'`，得到 pack id/name。

规则：

- 删除布局：有父布局、节点、连线或 pack 引用时拒绝并列出；全部移除后才能删除。删除当前布局后导航到父布局/布局列表/蓝图。
- 删除字段：若有连线使用，先显示受影响节点/端口数量并允许取消；确认后保留边（不求值、不自动改接），求值器继续报告 `PORT_MISSING`。若布局被 pack 引用，额外警告 pack 节点端口可能失效。
- 重命名字段/布局：id 不变，连线不断；显示名重复时给警告但不阻止保存（identity 是 id）。
- 复制布局：新 id，复制字段内容和字段 id（字段 id 在布局内唯一即可），不复制外部引用。
- 备选方案：删除字段时按名称自动改接到同名字段。放弃，因为会静默改变用户图语义，且与稳定 id 契约冲突。

### 9. 路由、焦点与键盘作用域

- `src/bp/designer/route.ts` 提供纯函数：

```ts
parseDesignerHash('#design/header/entry') // { stack: ['header','entry'], missing?: ... }
designerHash(['header','entry'])          // '#design/header/entry'
```

- 打开/进入子布局使用 `history.pushState`；`popstate` 是唯一的路由来源，解析后更新 `designerStack`。关闭时用 `history.replaceState` 回到打开前的 hash，避免留下失效的设计器条目。直接深链缺少布局时保留路由并显示缺失状态。
- 设计器通过 `createPortal` 挂到 `document.body`，使用页面级 topmost focus trap：打开时聚焦标题，Tab 在根或当前弹层（`.bp-dz-modal` / 插入菜单 / 右键菜单优先）内循环；弹窗自己的 focus hook 只负责初始聚焦与关闭恢复，避免父子 trap 互相抢占。背景 `#root` 设置 `inert`（不支持时用 `aria-hidden` + 焦点陷阱），并禁用 BlueprintApp 的全局文件 drop/快捷键。
- `BlueprintApp` 的 keydown/drop 监听在设计器打开时 early-return；设计器注册自己的 capture 阶段键盘处理，处理过的键 `preventDefault` + `stopPropagation`，避免 Ctrl+O/Ctrl+S 等后台命令穿透。
- Escape 分层：取消拖动/缩放 → 关闭菜单/弹窗 → 返回父布局 → 关闭设计器。`popstate` 若发生在拖动中，先取消预览再应用路由。
- 备选方案：只做内部 React 状态，不改 hash。放弃，因为无法满足深链、浏览器后退和“关闭后回到原位置”的商业级导航预期。

### 10. 视图状态、缩放与性能

- 设计器 UI 状态：`view: 'byte' | 'bit'`、`rowBytes: 4|8|16|32`、`bitOrder: 'lsb'|'msb'`、`zoom: 0.5..2`、`pan`、`tableOpen`、`problemsTab`、`selection`。`rowBytes`/`bitOrder`/`tableOpen` 写入现有 `memlink:ui:v1` 偏好，不进入文档；zoom/pan 仅会话内保留。
- 缩放范围 50%–200%；`fit` 按内容宽高和容器计算；空格拖动或中键拖动平移；Ctrl/Cmd+滚轮缩放，普通滚轮保持滚动。
- 拖动预览使用独立的 `DragLayer`（ghost + target outline），只更新 transform/left/top/width，不重建字段列表；字段块用 `React.memo`，几何按 `layouts` 引用和 `rowBytes` 记忆化。
- 提交/诊断只发生在 drop、blur、Enter、select 变更和删除确认，不在 pointermove。
- 128 字段、8 层嵌套和 64 位位组的目标是拖动期间稳定交互；表格无需虚拟化（128 行上限），但避免在 hover 时触发全表重渲染。字节画布额外限制渲染窗口（最多 4096 行 / 32768 个单元格），极长布局显示提示，字段表仍可定位全部字段。
- 备选方案：Canvas 2D 渲染。放弃，因为可访问名称、焦点、命中测试和文本标签都要另做一套；DOM 在 128 字段规模足够。

### 11. 校验、问题与提交边界

- `onApply` 在父级对候选 `layouts` 跑 `analyzeLayouts`；只要存在 error 就拒绝提交，返回 `problems` 和首个问题字段。设计器显示 banner/问题页签并聚焦。
- `compileLayout` 的语义是唯一权威：字段重名、越界、普通布局重叠、位域重叠、未知/循环引用、非法数组数量/位宽、长度覆盖过小都在这里拦截。
- 失败回滚使用“上一有效布局 + 预览层”，不把半成品写入 `doc.layouts`；历史栈只有成功提交。
- 打开一个已无效的布局时，`analyzeLayouts` 给出全部问题；设计器进入修复模式：允许提交减少或保持问题集合的修改，但拒绝新增错误类别；有效布局仍拒绝任何无效候选。这样用户能逐个修复，不会一次要求修完所有问题，也不会把新的破坏写进文档。设计器不崩溃，也不让求值器按部分字段继续。
- 警告（共享布局被多处引用、显式长度覆盖、被 pack 引用）显示在属性/问题页但不阻止合法编辑。
- 备选方案：允许保存无效草稿，关闭时再校验。放弃，因为现有求值器和自动缓存会把无效状态当成可读取文档。

### 12. 测试与验收边界

- 纯函数单测：`buildLayout`/`analyzeLayouts`/`measureLayout`、`operations`、`geometry`、`route`、`buildLayoutUsage`、`layoutsEqual`。
- 集成/浏览器验收：
  - 从读结构节点打开 → 拖动/锚定/撤销 → 关闭 → 端口更新；
  - 位视图拖动/缩放/unit/重叠拒绝；
  - 嵌套进入/返回、父布局长度联动；
  - 深链、浏览器后退、Escape 分层、焦点恢复、背景 inert；
  - 键盘插入/移动/删除/F2/多选、IME 不误触；
  - 删除已接线字段的警告与缺失端口；
  - 128 字段拖动预览、缩放/平移；
  - 问题列表点击定位。
- 现有 `compileLayout` 回归必须全部保留；位域重叠是新增的语义收紧，已存在重叠的布局会显示错误，不做自动修复。
- 浏览器脚本建议新增 `scripts/cdp-verify-designer.mjs`，并补充 `cdp-verify-default-nodes.mjs` 的检查器摘要/设计器入口断言。

## Risks / Trade-offs

- **范围过大** → 按任务阶段拆分：几何/诊断纯函数 → 页面壳/路由/焦点 → 字节视图 → 位视图 → 检查器/表格 → 嵌套/引用安全 → 键盘/性能/文档。每阶段可独立验收。
- **自动/锚定语义仍可能含混** → 重排手柄只改顺序，主体拖动锚定，落下前显示“将锚定到 0x…”；没有模式开关；回归覆盖三种手势。
- **位域重叠收紧会让旧布局报错** → 不做静默修复；问题面板列出冲突字段，用户可调整或删除。由于旧版本来就没有可靠的重叠语义，这视为修正而不是兼容性破坏。
- **全屏 portal + 全局快捷键冲突** → 设计器打开时 BlueprintApp 的 keydown/drop 早退；设计器 capture 阶段处理并阻止穿透；焦点陷阱 + inert 双重保障。
- **浏览器后退/深链与拖拽状态竞争** → `popstate` 先取消手势再应用路由；路由解析纯函数化并有浏览器回归。
- **性能回退** → 预览层局部更新、分析按文档引用记忆化、字段块 memo；128 字段作为验收数据。
- **多选拖动语义** → 同类型字节字段整体移动；混合位域/字节、跨类型或包含锚定冲突时明确拒绝，不做部分移动。
- **删除已接线字段造成缺失端口** → 删除前列出影响，确认后保留边并由求值器报告；不静默改接。
- **pack 引用布局的删除** → `buildLayoutUsage` 扫描 pack 的 `ref`，删除被 pack 引用的布局直接阻止；避免求值期才暴露物化失败。
- **无文档迁移** → 回滚只需回退 UI；布局文档保持不变。若新 UI 不可用，旧 `LayoutEditor` 可临时恢复，但不与新设计器并存。

## Migration Plan

1. 先落 `buildLayout` 重构和 `analyzeLayouts`，保持 `compileLayout` API 与全部现有测试通过；再新增位域重叠校验和对应回归。
2. 新增 `src/bp/designer/` 纯函数（geometry/operations/route/usage）和单测，不接 UI。
3. 新增 `DesignerApp` 壳、hash 路由、focus/inert、会话检查点和 `StructureSummary` 入口；暂时保留旧 `LayoutEditor` 作为回滚路径，但不渲染。
4. 按字节视图 → 位视图 → 检查器/字段表 → 嵌套/引用安全 → 键盘/性能的顺序接入；每步跑 `tsc`、vitest 和浏览器脚本。
5. 删除旧 `LayoutEditor` 的表单路径，更新 `Inspector`、`BlueprintApp`、README/docs 和示例回归；最后跑完整 `cdp-verify` 系列。
6. 文档格式不变，无需迁移；已存在的无效布局显示问题，不自动改写。

**回滚**：设计器是独立 UI 层，回退到旧 `LayoutEditor` 不影响 `doc.layouts`；位域重叠校验若造成阻塞，可单独回退该语义校验，但需保留问题提示。
