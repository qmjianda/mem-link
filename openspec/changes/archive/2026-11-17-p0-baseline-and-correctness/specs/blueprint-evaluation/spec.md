# Spec Delta

## Purpose

定义蓝图求值器对外可观察的行为：每个端口值属于哪一类、数据源如何被解析、截断如何被报告、问题如何被表达。它是画布、检查器、问题面板与后续 CLI 的共同契约。

## ADDED Requirements

### Requirement: 值类别必须显式可判别

求值器产出的每个端口值 MUST 携带显式类别。元素/记录类值 MUST 使用 pack 代码无法伪造的标识；未声明类别的对象 MUST 按 JSON 值处理，MUST NOT 按元素解码。计算节点的返回值 MUST 先经过规范化再发布。

#### Scenario: 计算节点返回伪元素

- **GIVEN** 一个计算节点返回普通对象 `{ addr, typeName, fields }`
- **WHEN** 下游把它接到 `number` 输入
- **THEN** 该值按 JSON 处理，节点产生原因码为 `INVALID_VALUE` 的告警，且不按 `addr` 解码

#### Scenario: 真实元素仍可当地址使用

- **GIVEN** 链表节点的 `elem:0` 输出
- **WHEN** 把它接到 `number` 输入
- **THEN** 使用该元素地址，行为与当前版本一致

### Requirement: 数据源解析不得触发上游求值

节点确定数据源时 MUST 只依赖图结构、节点参数与资产表，MUST NOT 为解析数据源而求值上游节点。唯一例外是数据源由上游的字符串或字节输出显式提供：此时该依赖 MUST 按值依赖参与环检测。字符串与字节输出作为数据源时 MUST 以基址 0 生效。

#### Scenario: 值依赖与来源依赖不互相判环

- **GIVEN** 解析节点 A 的缓冲区来自 File，B 的数据源线来自 A 的 `buffer` 输出，且 A 的某个字段输入来自 B 的输出
- **WHEN** 求值整张图
- **THEN** 不产生 `CYCLE`，A 与 B 都得到各自的结果

#### Scenario: 字符串仍可直接作为内存镜像

- **GIVEN** 文本常量的文本输出接到节点 B 的数据源口
- **WHEN** 求值 B
- **THEN** B 以基址 0 解析这段文本，且该依赖被登记为值依赖而非来源依赖

### Requirement: 截断必须区分自然结束与因上限停止

求值器 MUST 区分"数量恰好等于上限且遍历自然结束"与"因达到上限而停止"。后者 MUST 报告上限、停止位置与是否可继续，MUST NOT 与自然结束共用同一个截断标记。

#### Scenario: 恰好达到上限但链在此结束

- **GIVEN** 链表上限为 256，链恰好有 256 项且第 256 项的 `next` 为空
- **WHEN** 求值该链表
- **THEN** 结果为 256 项且 `truncated = false`

#### Scenario: 因上限被截断

- **GIVEN** 链表上限为 256，链仍有后续项
- **WHEN** 求值该链表
- **THEN** 结果为 256 项，`truncated = true`，并给出 `limit`、`at` 与 `canContinue = true`

### Requirement: 问题条目必须结构化

每条问题 MUST 暴露稳定原因码、严重度、定位信息（节点，可选端口与地址）与人类可读消息；可选修复动作 MUST 以可执行描述给出。原因码 MUST NOT 只存在于展示字符串中。

#### Scenario: 按原因码聚合

- **GIVEN** 图中有三条 `NO_SOURCE` 问题
- **WHEN** 用户打开问题面板并按原因码过滤
- **THEN** 三条同时显示，且过滤不依赖解析展示文案

#### Scenario: 从问题定位到字节

- **GIVEN** 一条带地址的 `OUT_OF_BOUNDS` 问题
- **WHEN** 用户点击该问题
- **THEN** 对应节点被选中，并高亮该地址所在字节
