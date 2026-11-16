# 值类别：为什么元素要带品牌

## 规则

`InstanceView`（解码出来的元素/记录）只有经过 `brandInstance` 登记才算真实元素。登记表是 `src/bp/types.ts` 内的一个模块级 `WeakSet`；`isInstanceView` 只查表，不看字段形状。

`makeView`（`src/bp/eval.ts:350` 附近）是**唯一**的构造点，它在返回前完成登记。因此：

- 解析节点产出的元素 → 已登记，下游可当地址使用；
- 计算节点自行拼出的 `{ addr, typeName, fields }` → 未登记，按 JSON 处理；
- 复制一个真实元素（`{ ...inst }`）→ 新对象未登记，不再是元素。

## 为什么不用 Symbol 或 `__brand` 字段

pack 代码与宿主运行在同一个 realm，且 pack 会拿到真实元素（作为输入）。拿到之后：

- `Object.getOwnPropertySymbols(el)` 能取出品牌符号，复制到伪造对象上；
- `{ ...el }` 能连字段带 `__brand: true` 一起复制。

WeakSet 的键不可被外部枚举，也无法通过复制对象写入——只有模块内调用 `brandInstance` 才能登记。这是"不可伪造"与"可传递"之间唯一不需要引入 realm 隔离的做法。

代价：品牌不可序列化。这是可接受的——`InstanceView` 只存在于运行时，`outputs`、`views` 都不落盘。

## 降级行为

计算节点的返回值在发布前逐个检查（`eval.ts` 的 calc 分支）：

1. 已登记 → 原样输出；
2. 形似元素但未登记 → 产出 `INVALID_VALUE` 告警，并整体转成纯 JSON（`toPlainJson`：断开 `mem` 引用、去掉原型）；
3. 其它值 → 原样输出。

下游因此拿不到可继续解码的地址：把降级值接到 `number` 输入，会得到 `BAD_INPUT`（"不是数字"），而不是静默地按 `addr` 去解码。端口行显示为 `{…}`，不会抛错。

## 回归结论

改动后 `pnpm test` 303 条全绿（原 293 条 + 新增 10 条）。新增用例覆盖：

- 形状完全相同的普通对象不算元素；登记过的才算；
- 伪元素接 `number` → `INVALID_VALUE` + 下游 `BAD_INPUT`，且 `outputs` 里不是 `0x1234`；
- 降级值不含 `mem`、端口行显示 `{…}`；
- 真实 `elem:0` → 仍按 `addr` 解码（demo 的 `head=2` → `0x130`）；
- 两张随附示例图（`demo`、`nvme-sq`）产生 **0** 条 `INVALID_VALUE`。

**没有发现误报**：仓库内所有内置节点与两个示例 pack 都通过 `structNode` / `listNode` / `arrayNode` 产出元素，不自行拼对象。

## 升级须知

如果第三方 pack 的 `calcNode.run` 返回自行拼的"元素"对象，升级后会开始收到 `INVALID_VALUE` 告警。正确做法是让解析节点（`structNode` / `listNode` / `arrayNode` / `element`）产出元素，计算节点只做数值与字符串变换。
