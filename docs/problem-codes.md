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
| `OUT_OF_BOUNDS` | error | 求值抛错且消息匹配"越界/超出/不在缓冲/out of range" | 节点 |
| `SOURCE_CONFLICT` | warn | 上游连到了不同的输入文件 | 节点 |
| `SOURCE_CYCLE` | warn | 数据源继承链自身成环（与值依赖的 `CYCLE` 是两件事） | 节点 |
| `INVALID_VALUE` | warn | 计算节点返回了形似元素但未登记的对象，已降级为 JSON（见 `value-branding.md`） | 节点 |
| `TRUNCATED` | warn | 列表/数组因达到上限停止（自然结束不算） | 节点 |
| `PORT_MISSING` | warn | 连线一端指向已不存在的端口 | 目标节点 |

## 已知不足

- **`OUT_OF_BOUNDS` 靠正则判定**（`eval.ts:1039`）：匹配的是异常消息文本，pack 换一种措辞就会掉进 `EVAL_FAILED`。要彻底解决需要 pack 抛出带类型的错误，属于后续变更。
- **定位信息还不完整**：目前只有 `nodeKey`，端口与地址字段（`port` / `addr`）已在 `Problem` 上定义但多数调用点还没填（任务 6.2）。因此"点击问题跳到字节"还只能到节点级。
- **`fix` 尚未使用**：字段已预留，没有任何调用点填充。

## 维护约定

新增原因码时：先加进 `ProblemCode` 联合类型 → 在调用点传 `code` → 更新本表 → 在 `tests/problems.test.ts` 的 `CODES` 里补上。三处缺一，测试就会挡住。
