# Pack 节点帮助与参考蓝图

Pack 商店解决了“去哪里找格式定义”，但只安装一个 pack 仍然不知道：

- 应该先加哪个节点；
- 数据源和地址怎么接；
- 每个节点输出什么；
- 这个 pack 最小可用图长什么样。

现在每个 pack 都带两样交付物：**每个节点的帮助说明**，以及**一张可直接打开的参考蓝图**。

## 节点帮助

帮助内容来自 `structNode` / `listNode` / `arrayNode` / `calcNode` 的 `description`。旧 pack 没有写 `description` 时，加载器会按类型、字段、端口自动补一条，不会出现只有名字的节点。

入口：

| 位置 | 行为 |
| --- | --- |
| 节点库条目右侧 `?` | 打开节点帮助弹层 |
| 快速添加（`Ctrl/Cmd+K`） | 底部显示当前节点的说明；按「节点帮助」打开弹层 |
| 检查器节点标题旁「帮助」 | 打开同一个弹层 |
| 检查器标题下方 | 直接显示一行说明，不用先点开 |

弹层包含：

- 节点做什么；
- 输入 / 输出端口及类型（数据源端口会标记「数据源」）；
- 引用类型的字段表（偏移、字段、类型、字节数）；
- 三步左右的接线方法；
- 「打开参考蓝图」（pack 来自商店时可用）。

## 参考蓝图

标准位置：

```text
store/packs/<id>/reference.blueprint.json
```

生成器：

```bash
node store/scripts/build-references.mjs --root store
```

生成规则：

1. 放一个 `File` 节点，内联一个 **512 B – 4 KB 的零填充示例 buffer**；
2. 把 pack 的所有结构 / 数组 / 链表节点摆到画布上；
3. 用 `buffer` 连线把 File 接到每个解析节点，地址默认 `0x0`；
4. 放一个 `note` 节点，写清楚：这是临时示例、如何载入真实文件、有多少解析/辅助节点、许可与来源；
5. 计算节点不强行入图，在 note 里提示到节点库按 `?` 查看。

零填充示例不是格式有效样本，只用于让字段表和接线立即可见。真实文件通常更大；超过 4 KB 的类型会在 note 里注明“示例只覆盖前 4 KB”。

打开方式：

- Pack 商店卡片上的「参考蓝图」；
- 节点帮助弹层里的「打开参考蓝图」。

参考蓝图始终以**临时示例**打开：不会覆盖当前工作图，顶栏显示「返回我的蓝图」。如果参考蓝图里的 pack 还没安装，也会随图加载，不需要先装再打开。

## 商店索引

`store/index.json` 的每个条目新增：

```json
"reference": {
  "path": "packs/sqlite/reference.blueprint.json",
  "sha256": "…",
  "size": 9258
}
```

`build-index.mjs` 会强制检查参考蓝图存在且 `format` 为 `memlink-blueprint/3`；`build-references.mjs --check` 检查它是否与 pack 源码同步。

## 作者检查清单

- [ ] 每个节点都有 `description`；至少写“解析什么、输入怎么接、输出是什么”。
- [ ] pack 目录有 `reference.blueprint.json`，并已由生成器更新。
- [ ] 参考蓝图能打开，节点不报“未知节点”，至少一个 pack 节点能显示字段。
- [ ] 改了 pack 源码后运行 `pnpm packs:index`，不要手改 `index.json`。
- [ ] 发布前运行 `pnpm packs:check`。
