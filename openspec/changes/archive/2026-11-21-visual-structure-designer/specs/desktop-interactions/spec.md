## ADDED Requirements

### Requirement: 全屏设计器遵循页面导航与焦点约定

结构设计器 MUST 作为页面级视图打开：打开时焦点 MUST 进入设计器标题或第一个可操作项，背景蓝图 MUST inert 且不可通过 Tab 或屏幕阅读器访问；关闭时焦点 MUST 回到触发控件或读结构节点。URL hash MUST 反映当前布局栈，浏览器后退/前进 MUST 在嵌套布局和蓝图之间导航。Escape MUST 按「取消手势 → 关闭浮层 → 返回父布局 → 退出设计器」的顺序只处理最上层。所有拖动或画布操作 MUST 有可见的点击或键盘路径；输入法组合期间的 Enter、方向键和 Escape MUST NOT 触发应用命令。

#### Scenario: 打开与关闭焦点

- **GIVEN** 用户从检查器的「打开结构设计器」进入
- **WHEN** 设计器打开，随后按「完成」关闭
- **THEN** 打开时焦点进入设计器且背景不可 Tab 进入；关闭后焦点回到原按钮，原节点仍被选中

#### Scenario: 浏览器返回嵌套布局

- **GIVEN** 用户从 `Header` 进入 `Entry`
- **WHEN** 用户按浏览器后退
- **THEN** 只回到 `Header`，不离开当前蓝图；再后退才回到蓝图

#### Scenario: Escape 只关最上层

- **GIVEN** 设计器中打开了一个模板浮层
- **WHEN** 用户按 Escape
- **THEN** 只关闭模板浮层；再次按 Escape 才返回父布局或退出设计器

#### Scenario: 无拖动也能创建

- **GIVEN** 用户只使用键盘
- **WHEN** 用户打开「插入字段」菜单并选择类型和偏移
- **THEN** 创建结果与拖拽创建一致，并收到成功或失败的文字反馈

#### Scenario: 输入法组合不触发命令

- **GIVEN** 用户正在设计器的文本输入中使用输入法
- **WHEN** 用户按 Enter、方向键或 Escape
- **THEN** 输入法优先处理，不触发提交、移动或退出
