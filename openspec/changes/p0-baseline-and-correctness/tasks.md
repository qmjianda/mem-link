# Tasks

## 1. 工程底盘与基线

- [x] 1.1 初始化 git 仓库并提交当前状态；确认 `.gitignore` 已排除 `node_modules`、`dist`、`.cache`。验证：`git log --oneline -1` 有提交，`git status --short` 无未跟踪的构建产物。
- [x] 1.2 消除 `vitest run` 默认 reporter 在本机不退出的问题（在 `vite.config.ts` 固定 `test.reporters` 或改 `package.json` 的 test 脚本）。验证：`pnpm test` 在 120 秒内退出且退出码为 0，连续跑三次不挂起。
- [x] 1.3 新增 CI 工作流，依次执行 `pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`、`pnpm build`。验证：本地按同顺序跑通四条命令；推送后工作流为绿。
- [x] 1.4 引入 ESLint 与格式化配置，规则集只拦真实缺陷（未使用变量、`any` 外的类型漏洞、hooks 依赖），不对现有代码做大规模改写。验证：`pnpm lint` 输出 0 error，warning 数量记录在提交说明里。
- [x] 1.5 编写求值基准脚本（节点规模 50/200/800，重复 20 次），输出 p50/p95 与全量求值耗时，结果写入 `docs/perf-baseline.md`。验证：`node scripts/bench-eval.mjs` 打印三档数据，文件内含本次基线数值与运行环境。
- [x] 1.6 补 LICENSE 与 EULA 草案、新建 `docs/README.md` 索引（指向 `data-model-review.md`、`description-format.md`、`optimization-research.md`、`optimization-plan.md`、`perf-baseline.md`）。验证：索引中每条链接都能打开对应文件。
- [x] 1.7 修正 `docs/data-model-review.md` 中已过期的结论（D8「primary 可为空但集合非空」已由 `selection.ts` 的 `retainSelection` 兜底），并统一 README 与 `description-format.md` 的构造器表为单向引用。验证：文档中不再出现该过期判定；构造器表只在一处维护，另一处为链接。

## 2. 值类别显式化

- [x] 2.1 在 `src/bp/types.ts` 引入模块内 `WeakSet` 品牌：`makeView` 产出实例时登记，`isInstanceView` 改为查表且签名不变。验证：新增用例证明手工构造的 `{addr,typeName,fields}` 不被认作实例，而 `makeView` 的产出被认作实例；`pnpm test` 全绿。
- [x] 2.2 在 `eval.ts` 的计算节点分支对 `def.run` 的返回值做规范化：非品牌实例一律按 JSON 处理，形状像元素时追加 `INVALID_VALUE` 告警。验证：用例覆盖「calc 返回伪元素 → 接 number 输入 → 告警且不按 addr 解码」与「真实 `elem:0` → 仍当地址使用」。
- [x] 2.3 确认展示层对降级值不崩溃：`Inspector` 的 calc 输出与 `Canvas` 的端口行能显示对象/数组的 JSON 摘要而不是抛错。验证：用例对降级值调用展示格式化函数无异常，并在 NVMe 示例中手工确认端口行可读。
- [x] 2.4 用 `samples/` 与既有 293 条用例回归，把每一处新增 `INVALID_VALUE` 逐条判定为「真 bug」或「误报」，结论写入 `docs/value-branding.md`。验证：文档列出每处告警的节点、原因与处置；无误报遗留。

## 3. 资产身份

- [x] 3.1 新增同步 64 位 FNV-1a 哈希函数，输出 `a1:` 前缀的 16 位十六进制串。验证：用例覆盖空输入、已知向量、跨块输入一致性；1 MiB 输入耗时断言小于 10 ms。
- [x] 3.2 引入运行时 `AssetTable`，`BufferValue` 增加 `assetId`，`bufferOfFile` 按节点缓存哈希结果。验证：用例证明「同名同长不同内容 → 不同 assetId」与「同内容两节点 → 同 assetId 且只有一份 `Uint8Array`」。
- [x] 3.3 跟随地址列表改用 `assetId@base` 去重，替换 `BlueprintApp.tsx` 的 `${name}:${base}:${length}` 键。验证：`tests/follow.test.ts` 新增两条用例——同内容不同基址保留两条、同内容同基址合并为一条。
- [x] 3.4 旧文档与旧缓存中的内联 base64 在载入时自动登记为资产，导出仍内联。验证：`tests/persist.test.ts` 覆盖旧 payload 载入后 `AssetTable` 非空；打开 `samples/demo.blueprint.json` 后跟随列表可用。
- [x] 3.5 `SourceInfo` 暴露 `assetId` 与资产名称，供检查器「数据源」区块显示。验证：用例断言下游节点读到的 `assetId` 与上游 File 一致。
- [x] 3.6 在 `docs/` 增加资产模型说明（身份规则、基址不属于身份、运行时表与文档内联的关系）。验证：文档被 `docs/README.md` 索引收录且描述与实现一致。

## 4. 数据源解析解耦

- [x] 4.1 新增静态分类器：按上游端口声明的 `PortType` 判定该数据源线是「值依赖」还是「来源依赖」，不执行任何节点。验证：用例覆盖 `text`/`bytes`/`buffer` → 值依赖，`number`/`instance`/未知端口 → 来源依赖。
- [x] 4.2 实现 `resolveAllSources`：一次遍历算出全图来源，自带访问集，来源环返回 `mode:'none'` 且 `sourceCycle: true`。验证：用例覆盖来源环报 `SOURCE_CYCLE` 且不产生 `CYCLE`。
- [x] 4.3 删除 `resolveSource` 内对 `evalNode` 的调用，`evalBody` 改读预计算结果；保留 `explicit > override > file > upstream > default` 四级优先级。验证：源码中来源解析路径不再出现 `evalNode`；四级优先级矩阵用例逐条通过。
- [x] 4.4 值依赖环走求值状态机：A 的缓冲区来自 File、B 的数据源线来自 A、A 的字段输入来自 B 时，不误报环且两者都有结果。验证：新增用例复现该拓扑，断言 `problems` 无 `CYCLE`。
- [x] 4.5 字符串与字节作为数据源时以基址 0 生效，并登记为值依赖。验证：用例断言 `sourceInfo.mode === 'explicit'`、`base === 0`，且该边计入值依赖集合。
- [x] 4.6 把来源解析耗时并入基准脚本输出（与 1.5 同口径）。验证：`docs/perf-baseline.md` 增列「来源解析」一行，数值可复现。

## 5. 截断语义

- [x] 5.1 列表分支改用循环下标判定是否走完（`i === max`），删除 `items.length >= max` 判断。验证：用例「上限 256、链恰好 256 项且末项 next 为空」断言 `truncated` 为假。
- [x] 5.2 新增 `Truncation { limit, at, unit, canContinue }` 并挂到列表/数组视图与 `SourceInfo` 之外的求值结果上。验证：用例断言截断时 `limit=256`、`at` 为未访问的下一地址、`unit='address'`、`canContinue` 为真。
- [x] 5.3 数组分支对齐同一语义：`count > limit` 才算截断，`at` 为未读到的下标、`unit='index'`。验证：用例覆盖 `count = limit` 与 `count = limit + 1` 两种边界。
- [x] 5.4 画布与检查器的截断提示区分「自然结束」与「因上限停止」，后者显示可继续位置。验证：截断用例对应的视图在检查器中显示上限与位置文案；自然结束不显示任何截断提示。
- [x] 5.5 截断产生结构化问题条目（原因码 `TRUNCATED`，携带 `limit`/`at`）。验证：`tests/problems.test.ts` 断言问题条目字段，且不再依赖文案匹配。

## 6. 问题结构化

- [x] 6.1 扩展 `Problem`：新增 `code`、`nodeId?`、`port?`、`addr?`、`fix?`；`add()` 不再把原因码拼进 `detail`。验证：`pnpm exec tsc --noEmit` 通过；用例断言 `p.code === 'NO_SOURCE'` 且 `detail` 不以原因码开头。
- [x] 6.2 删除 `add()` 里把原因码拼进 `detail` 的写法，所有调用点改为显式传 `code`（由签名强制，漏传即类型错误）。验证：`pnpm exec tsc --noEmit` 通过；`tests/problems.test.ts` 按 `p.code` 过滤且不解析文案。
- [x] 6.5 在 `docs/` 增加原因码表，与 `ProblemCode` 联合类型逐项对应。验证：文档条目数与联合类型成员数一致，且每条有触发条件说明。

## 7. 暂缓（本变更不做）

- 原第 7 组「信任边界」（CSP、导入授权、导出哈希清单）→ 已拆到独立变更 `pack-trust-boundary`，等开始对外分享蓝图时再做。
- 问题面板按原因码过滤与点击定位。理由：核心链路是 bin → 结构体 → 链表，面板先不扩。
- `Problem` 的 `port`/`addr` 定位字段：类型已预留，但没有消费方，先不填。
- `detail` 兼容读取：问题条目是求值产物、不进入持久化文档，不存在需要兼容的旧数据。

## 8. 验收

- [x] 8.1 全量回归：`pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`（总数不少于 290——v1/v2 用例随入口删除后基线为 294）、`pnpm build` 四条命令连续通过。验证：输出全绿，构建产物小于 800 KB。
- [x] 8.2 对比基线：基准脚本 800 节点 p95 相对 `docs/perf-baseline.md` 的劣化不超过 10%。验证：脚本输出与基线表并列记录，超阈值则回退对应改动。
- [ ] 8.3 核心链路手工清单：拖入 `samples/demo.bin`、导入 `samples/demo.bp.ts`、在 `0x100` 解析 `Entry`、沿 `next` 走完整条链、在十六进制视图跟随一个字段地址。验证：五步都符合预期，Console 无报错。

## Workflow follow-up

- 变更归档前确认所有任务已完成，并执行 `openspec validate p0-baseline-and-correctness --strict`。
- 归档后把 `docs/optimization-plan.md` 中 W1–W2 的状态更新为已完成，并指向本变更。
