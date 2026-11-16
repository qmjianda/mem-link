# 文档索引

本目录放**设计与决策**文档。面向使用者的说明在根目录 [`README.md`](../README.md)，pack 的写法只在 [`description-format.md`](description-format.md) 维护一份。

| 文档 | 读者 | 内容 | 何时读 |
| --- | --- | --- | --- |
| [`description-format.md`](description-format.md) | pack 作者 | `.bp.ts` 的完整参考：加载机制、`definePack`、类型与字段构造器、节点构造器、图求值、错误码、图文件格式、自检清单 | 写或改 pack 时；它是构造器的**唯一**事实来源 |
| [`data-model-review.md`](data-model-review.md) | 维护者 | 数据模型审阅：对象清单、访问路径、16 条问题（D1–D16，带 `file:line`）、目标五层模型、迁移步骤与验收指标 | 改求值器、持久化或选择模型之前 |
| [`value-branding.md`](value-branding.md) | 维护者 / pack 作者 | 元素值为什么用 WeakSet 品牌、未登记对象如何降级、升级后哪些 pack 会开始告警 | 写 `calcNode` 或排查"字段全错"之前 |
| [`assets.md`](assets.md) | 维护者 | 资产 id 如何由内容决定、基址为什么不算身份、运行时资产表与文档内联的关系 | 改载入、去重、跟随地址之前 |
| [`problem-codes.md`](problem-codes.md) | 维护者 / pack 作者 | 14 个稳定原因码的触发条件与定位能力，以及"哪些还靠正则/文案"的已知不足 | 加原因码、写断言、排查告警之前 |
| [`optimization-research.md`](optimization-research.md) | 产品 / 架构 | 商业化方向调研：竞品坐标、六大优化方向、目标架构、三阶段路线图、定价与 UI 方向 | 排优先级、对外讲路线时 |
| [`optimization-plan.md`](optimization-plan.md) | 维护者 | 把上述两份分析与代码复核结果合并后的可执行方案：12 项缺口、六周顺序、验收指标、不做清单 | 决定"下一步做什么"时 |
| [`perf-baseline.md`](perf-baseline.md) | 维护者 | 求值基准（50/200/800 节点，p50/p95），由 `node scripts/bench-eval.mjs --write` 生成 | 改动求值路径前后对比 |
| [`perf-history.md`](perf-history.md) | 维护者 | 基准的历史对比与"这 14% 花在哪"的结论；基准脚本只留最新快照，趋势看这里 | 判断某个改动是否值得、要不要优化 |
| [`eula-draft.md`](eula-draft.md) | 产品 / 法务 | 最终用户许可协议草案，含"蓝图可执行"的风险条款与待确认清单 | 对外发布或试用前 |

## 与 OpenSpec 的关系

行为契约不在本目录，而在 `openspec/`：`openspec/specs/` 是已生效的能力规格，`openspec/changes/` 是进行中的变更。本目录只解释**为什么这样设计**，不重复 MUST/SHALL 条款。

当前进行中的变更：[`p0-baseline-and-correctness`](../openspec/changes/p0-baseline-and-correctness/proposal.md)。

## 维护约定

- 同一事实只写一处；其它位置给链接。构造器表曾同时在 README 与本目录出现并产生措辞分叉，现已收敛到 `description-format.md`。
- 结论带证据：引用 `file:line`，并在结论失效时标注"已修"而不是删除，保留判断的历史。
- 数字要可复现：性能与体积类数字必须附生成命令。
