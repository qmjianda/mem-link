# 问题原因码

`Problem.code` 是稳定锚点：问题面板、测试与将来的 CLI 都按它过滤，**不解析展示文案**。`message` 只写"对象：事实"，`detail` 放可执行建议，`fix` 预留给一键修复。

| 原因码 | 严重度 | 触发条件 | 现有定位 |
| --- | --- | --- | --- |
| `CYCLE` | error | 求值时节点回到自身（值依赖成环） | 节点 |
| `NO_SOURCE` | warn / error | 需要缓冲区的节点没有可用文件；数据源线接到的来源没有内容；指定的 File 还没载入；File 节点本身未载入 | 节点 |
| `BAD_INPUT` | error | 必需输入缺失；输入不是数字；元素节点缺少地址或类型 | 节点 |
| `INDEX_OUT_OF_RANGE` | error | 列表下标超出元素数量 | 节点 |
| `UNKNOWN_NODE` | error | 内置节点 id 不在注册表里 | 节点 |
| `NODE_MISSING` | error | pack 里找不到该节点定义 | 节点 + `packId/nodeId` |
| `PACK_DISABLED` | error | 节点所属 pack 被禁用 | 节点 |
| `EVAL_FAILED` | error | 节点求值抛错，且错误不像越界 | 节点 |
| `OUT_OF_BOUNDS` | error | 读取范围越界；pack 未提供结构化原因时按异常消息判定 | 节点；内置读取提供地址 |
| `SOURCE_CONFLICT` | warn / error | 数据源不唯一，或地址与所选映射冲突 | 节点 / 地址 |
| `SOURCE_CYCLE` | warn | 数据源继承链自身成环（与值依赖的 `CYCLE` 是两件事） | 节点 |
| `INVALID_VALUE` | warn | 计算节点返回了形似元素但未登记的对象，已降级为 JSON（见 `value-branding.md`） | 节点 |
| `TRUNCATED` | warn | 列表/数组因达到上限停止（自然结束不算） | 节点 |
| `PORT_MISSING` | warn | 连线一端指向已不存在的端口 | 目标节点 |
| `READ_LIMIT` | error | 文本或校验范围超过读取预算，不输出部分结果 | 节点 / 地址 |
| `MISSING_TERMINATOR` | error | 在允许的范围内未找到零终止符 | 节点 / 地址 |
| `INVALID_ENCODING` | error | 文本字节与所选编码不兼容 | 节点 / 地址 |
| `UNMAPPED_POINTER` | error | 已读到非空指针，但目标未映射 | 节点 / 指针值的读取地址 |
| `INVALID_LAYOUT` | error | 布局或 `next` 绑定缺失、无效 | 节点 |
| `RECORD_CYCLE` | warn | 再次遇到已读记录；保留已读取前缀 | 节点 / 环入口 |
| `ASSERT_FAILED` | error | 有效的实际值不满足预期条件 | 节点 / 来源字段或范围 |
| `ASSERT_UNAVAILABLE` | error | 输入缺失、无效或上游读取失败 | 节点 / 可用来源 |

## 已知不足

- **pack 异常仍靠正则判断**：内置读取明确发布越界等原因码，脚本 pack 异常的兜底仍按消息匹配。
- **定位取决于是否有原始字节**：内置断言使用上游字段或字节范围；没有对应来源或整个地址不可读时，只显示节点和诊断。
- **`fix` 尚未使用**：字段已预留，没有任何调用点填充。

## 维护约定

新增原因码时：先加进 `ProblemCode` 联合类型 → 在调用点传 `code` → 更新本表 → 在 `tests/problems.test.ts` 的 `CODES` 里补上。三处缺一，测试就会挡住。
