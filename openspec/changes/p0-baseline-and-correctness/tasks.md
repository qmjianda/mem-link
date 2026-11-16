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

- [ ] 2.1 在 `src/bp/types.ts` 引入模块内 `WeakSet` 品牌：`makeView` 产出实例时登记，`isInstanceView` 改为查表且签名不变。验证：新增用例证明手工构造的 `{addr,typeName,fields}` 不被认作实例，而 `makeView` 的产出被认作实例；`pnpm test` 全绿。
- [ ] 2.2 在 `eval.ts` 的计算节点分支对 `def.run` 的返回值做规范化：非品牌实例一律按 JSON 处理，形状像元素时追加 `INVALID_VALUE` 告警。验证：用例覆盖「calc 返回伪元素 → 接 number 输入 → 告警且不按 addr 解码」与「真实 `elem:0` → 仍当地址使用」。
- [ ] 2.3 确认展示层对降级值不崩溃：`Inspector` 的 calc 输出与 `Canvas` 的端口行能显示对象/数组的 JSON 摘要而不是抛错。验证：用例对降级值调用展示格式化函数无异常，并在 NVMe 示例中手工确认端口行可读。
- [ ] 2.4 用 `samples/` 与既有 293 条用例回归，把每一处新增 `INVALID_VALUE` 逐条判定为「真 bug」或「误报」，结论写入 `docs/value-branding.md`。验证：文档列出每处告警的节点、原因与处置；无误报遗留。

## 3. 资产身份

- [ ] 3.1 新增同步 64 位 FNV-1a 哈希函数，输出 `a1:` 前缀的 16 位十六进制串。验证：用例覆盖空输入、已知向量、跨块输入一致性；1 MiB 输入耗时断言小于 10 ms。
- [ ] 3.2 引入运行时 `AssetTable`，`BufferValue` 增加 `assetId`，`bufferOfFile` 按节点缓存哈希结果。验证：用例证明「同名同长不同内容 → 不同 assetId」与「同内容两节点 → 同 assetId 且只有一份 `Uint8Array`」。
- [ ] 3.3 跟随地址列表改用 `assetId@base` 去重，替换 `BlueprintApp.tsx` 的 `${name}:${base}:${length}` 键。验证：`tests/follow.test.ts` 新增两条用例——同内容不同基址保留两条、同内容同基址合并为一条。
- [ ] 3.4 旧文档与旧缓存中的内联 base64 在载入时自动登记为资产，导出仍内联。验证：`tests/persist.test.ts` 覆盖旧 payload 载入后 `AssetTable` 非空；打开 `samples/demo.blueprint.json` 后跟随列表可用。
- [ ] 3.5 `SourceInfo` 暴露 `assetId` 与资产名称，供检查器「数据源」区块显示。验证：用例断言下游节点读到的 `assetId` 与上游 File 一致。
- [ ] 3.6 在 `docs/` 增加资产模型说明（身份规则、基址不属于身份、运行时表与文档内联的关系）。验证：文档被 `docs/README.md` 索引收录且描述与实现一致。

## 4. 数据源解析解耦

- [ ] 4.1 新增静态分类器：按上游端口声明的 `PortType` 判定该数据源线是「值依赖」还是「来源依赖」，不执行任何节点。验证：用例覆盖 `text`/`bytes`/`buffer` → 值依赖，`number`/`instance`/未知端口 → 来源依赖。
- [ ] 4.2 实现 `resolveAllSources`：一次遍历算出全图来源，自带访问集，来源环返回 `mode:'none'` 且 `sourceCycle: true`。验证：用例覆盖来源环报 `SOURCE_CYCLE` 且不产生 `CYCLE`。
- [ ] 4.3 删除 `resolveSource` 内对 `evalNode` 的调用，`evalBody` 改读预计算结果；保留 `explicit > override > file > upstream > default` 四级优先级。验证：源码中来源解析路径不再出现 `evalNode`；四级优先级矩阵用例逐条通过。
- [ ] 4.4 值依赖环走求值状态机：A 的缓冲区来自 File、B 的数据源线来自 A、A 的字段输入来自 B 时，不误报环且两者都有结果。验证：新增用例复现该拓扑，断言 `problems` 无 `CYCLE`。
- [ ] 4.5 字符串与字节作为数据源时以基址 0 生效，并登记为值依赖。验证：用例断言 `sourceInfo.mode === 'explicit'`、`base === 0`，且该边计入值依赖集合。
- [ ] 4.6 把来源解析耗时并入基准脚本输出（与 1.5 同口径）。验证：`docs/perf-baseline.md` 增列「来源解析」一行，数值可复现。

## 5. 截断语义

- [ ] 5.1 列表分支改用循环下标判定是否走完（`i === max`），删除 `items.length >= max` 判断。验证：用例「上限 256、链恰好 256 项且末项 next 为空」断言 `truncated` 为假。
- [ ] 5.2 新增 `Truncation { limit, at, unit, canContinue }` 并挂到列表/数组视图与 `SourceInfo` 之外的求值结果上。验证：用例断言截断时 `limit=256`、`at` 为未访问的下一地址、`unit='address'`、`canContinue` 为真。
- [ ] 5.3 数组分支对齐同一语义：`count > limit` 才算截断，`at` 为未读到的下标、`unit='index'`。验证：用例覆盖 `count = limit` 与 `count = limit + 1` 两种边界。
- [ ] 5.4 画布与检查器的截断提示区分「自然结束」与「因上限停止」，后者显示可继续位置。验证：截断用例对应的视图在检查器中显示上限与位置文案；自然结束不显示任何截断提示。
- [ ] 5.5 截断产生结构化问题条目（原因码 `TRUNCATED`，携带 `limit`/`at`）。验证：`tests/problems.test.ts` 断言问题条目字段，且不再依赖文案匹配。

## 6. 问题结构化

- [ ] 6.1 扩展 `Problem`：新增 `code`、`nodeId?`、`port?`、`addr?`、`fix?`；`add()` 不再把原因码拼进 `detail`。验证：`pnpm exec tsc --noEmit` 通过；用例断言 `p.code === 'NO_SOURCE'` 且 `detail` 不以原因码开头。
- [ ] 6.2 逐个更新 `add()` 调用点，补齐原因码与定位信息（端口、地址）。验证：源码中不再存在 `${code} · ${detail}` 形式；所有调用点都传 `code`。
- [ ] 6.3 问题面板支持按原因码过滤与点击定位（选中节点、高亮地址所在字节）。验证：`NO_SOURCE` 三条问题可一次筛出；点击带 `addr` 的问题后画布选中对应节点且字节高亮。
- [ ] 6.4 保留 `detail` 兼容读取一版：旧缓存与旧导出中的问题文本仍可展示。验证：`tests/problems.test.ts` 覆盖只带 `detail` 的旧条目仍能渲染出消息。
- [ ] 6.5 在 `docs/` 增加原因码表，与 `ProblemCode` 联合类型逐项对应。验证：文档条目数与联合类型成员数一致，且每条有触发条件说明。

## 7. 信任边界

- [ ] 7.1 生产构建注入 CSP（`default-src 'self'; connect-src 'none'; img-src 'self' data:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'`），dev 单独放开 HMR 所需的 `ws:`。验证：`pnpm build && pnpm preview` 后打开 NVMe 示例，DevTools Console 无 CSP 违规、Network 面板零请求。
- [ ] 7.2 编译 pack 前安装网络守卫（`fetch`/`XMLHttpRequest`/`WebSocket` 抛带标记错误），求值 catch 把标记映射为 `NO_NETWORK`。验证：用例中一个调用 `fetch` 的 pack 节点产生 `NO_NETWORK` 问题并定位到该节点。
- [ ] 7.3 `onOpenDoc` 改为两阶段：先解析并展示 pack 清单（名称、节点数、哈希前 12 位），默认全不勾选，仅对勾选项调用 `loadBlueprintPack`，其余以 `enabled:false` 载入。验证：打开含未知 pack 的图时无编译发生（对 `loadBlueprintPack` 计数为 0），节点可见并标记未启用。
- [ ] 7.4 导出蓝图时写入 pack 哈希清单与「包含可执行代码」声明，导入方可核对。验证：用例断言导出 JSON 含两个 pack 的哈希与声明字段，且导出文件仍可被 `parseDoc` 正常解析。
- [ ] 7.5 哈希与当前源码不符时视为未授权，重新弹出清单并要求再次确认。验证：篡改导出文件中的 pack 源码后打开，出现不一致提示且不执行代码。
- [ ] 7.6 未启用 pack 的节点停在 `PACK_DISABLED` 提示态，不再叠加 `UNKNOWN_NODE`。验证：用例断言未启用 pack 的节点只产生 `PACK_DISABLED` 一条问题。
- [ ] 7.7 在 `docs/` 增加信任模型说明（CSP 强制层、守卫归因层、授权粒度、导出元数据）。验证：文档说明与 7.1–7.6 的实现一致，并被 `docs/README.md` 索引。

## 8. 集成验收

- [ ] 8.1 全量回归：`pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`（含新增用例，总数不少于 320）、`pnpm build` 四条命令连续通过。验证：输出全绿，构建产物小于 800 KB。
- [ ] 8.2 对比基线：基准脚本三档 p95 相对 `docs/perf-baseline.md` 的劣化不超过 10%，来源解析耗时不高于全量求值的 5%。验证：脚本输出与基线表并列记录，超阈值则回退对应改动。
- [ ] 8.3 生产构建手工清单：打开 NVMe 示例、跟随地址、切换数据源、导出后在新会话导入、打开含未知 pack 的图并逐项授权。验证：五项全部符合预期，Console 无报错、Network 零请求，清单结果附在变更说明里。

## Workflow follow-up

- 变更归档前确认所有任务已完成，并执行 `openspec validate p0-baseline-and-correctness --strict`。
- 归档后把 `docs/optimization-plan.md` 中 W1–W2 的状态更新为已完成，并指向本变更。
