# mem-link 优化方案（综合版）

> 输入：`docs/data-model-review.md`（数据模型）、`docs/optimization-research.md`（商业化方向）、`docs/description-format.md`（pack 参考）。
> 本轮同时抽查了 `src/` 并跑了验证：`tsc --noEmit` 0 错、18 个测试文件 293 用例全通过（2.2 s）、`dist/index.html` 742,168 B、`src/` 17,099 行。
> 本文不重复前两份文档的证据链，只做四件事：**合并冲突、修正过期结论、补齐两份文档都没覆盖的工程缺口、给一个能执行的顺序**。

---

## 0. 一页结论

1. **先花 2 天立底盘，再谈优化。** 仓库没有 `.git`、没有 CI、没有 lint/格式化、没有 LICENSE、没有 CSP。前三项是"每一步改动都能回滚、能验证"的前提；CSP 是"零网络"从 README 里的一句承诺变成可执行约束的唯一办法。
2. **正确性只需关掉四条路径，两周内可完成**：值打标签（D1）、缓冲区身份（D3）、追溯与求值解耦（D4）、截断语义（D15）。它们不改变产品形态，只改变"结果对不对"。
3. **64 位精度不要按文档全量改 bigint。** 地址的正解是"段基址 + 段内偏移"（即 `optimization-research` 的 AddressSpace），归一化后天然落在 2^53 内；只有 u64 **标量值/掩码**需要 bigint 显示通道。拆开后，D2 从"改类型签名的高风险工程"降为两个局部低风险改动。
4. **性能先测再做缓存。** 现状是 `for (const n of nodes) evalNode(n)`（`eval.ts:1000`）全量 eager 求值，且每个 list 节点无条件生成 4096 个端口与 values（`eval.ts:140`），画布默认只画 8 个（`Canvas.tsx:148`）。顺序应为：基线脚本 → 端口按"可见 + 已连线"投影 → 端口缓存 → 最后才是祖先链签名缓存。反过来会花两周优化一个没有度量的问题。
5. **信任模型先做"可上线最小集"。** 今天就能做：CSP 禁网、导入蓝图时列出 pack 源码哈希并逐个授权、导出时标注"此图含可执行代码"。三层执行模型（L0/L1/L2）留到有企业评审时按验收打，不要一次做完。
6. **交付物比第 19 个内置节点重要。** 两份文档各自独立收敛到"覆盖率"这个指标——两个独立分析撞到同一处，通常说明它就是产品核心度量。把它做成 CLI 的第一等输出，UI 只是它的可视化。

| 级别 | 事项 | 成本 | 为什么现在 |
| --- | --- | --- | --- |
| P0 | git/CI/lint、CSP + 导入授权、D1/D3/D4/D15、bench 基线 | 约 8 人日 | 全部是"不改架构、只改可信度"的改动；越晚做，后面每一步都在没有护栏的情况下改核心 |
| P1 | u64 显示通道 + 段基址、端口投影、预算/降级、IndexedDB 资产、meta 与 config 分离、删 v1 遗留、CLI + 报告 MVP | 约 4 周 | 决定"能不能跑大样本、能不能交付" |
| P2 | 覆盖率 UI、diff、断言、浅色主题、环可视化、注册表/App Mode/MCP | 3 个月+ | 依赖 P0/P1 的模型稳定；提前做会边做边改 |
| 暂缓 | Rust/WASM 核心、Tauri、AddressSpace 全量、包注册表 | — | 立项门槛未达（见 §3.2） |

---

## 1. 三份文档各自回答了什么

| 文档 | 回答的问题 | 主要读者 | 本轮复核 |
| --- | --- | --- | --- |
| `data-model-review.md` | 数据怎么组织、哪里会算出错值 | 引擎维护者 | 16 条里 15 条仍成立；D8 已过期（§3.4）；D2 需限定范围（§3.5） |
| `optimization-research.md` | 往哪走、怎么卖、不做什么 | 决策者 | 方向与"空位"判断成立；但把 12–18 个月的事排进了 3–9 个月（§3.2） |
| `description-format.md` | pack 怎么写、节点怎么用 | pack 作者 | README「写一个 pack」重复了同一套构造器表与字段选项表，两处已开始分叉（§4.7） |

值得保留的判断（不要在后续重构中丢掉）：

- "图 = 寻址 + 展开 + 校验"的职责切分，比"万物皆节点"更贴合逆向。
- `commit()` 单一写入口 + 结构共享 + 游标式历史，是这套代码最扎实的一层。
- 断链不中断（`valid=false` 但给真实读值）、数据源四优先级、多文件冲突检测，是产品表达力，不是冗余。
- 覆盖率作为核心指标，两份文档独立得出，可信度高。

---

## 2. P0：两周内必须完成

| 编号 | 事项 | 证据 | 动作 | 验收 |
| --- | --- | --- | --- | --- |
| P0-1 | 版本控制 | 目录下无 `.git` | `git init`，首次提交打 `v0.1.0`；`.gitignore` 补 `dist/`（若 dist 不作为产物入库则一并忽略） | 任意一次改动可 `git diff` / 回滚 |
| P0-2 | CI 与静态检查 | 无 workflow；代码里有 `eslint-disable` 注释但没有 eslint 依赖 | 加 `lint`（eslint + tsc）、`test`、`build` 三步；vitest 配置 `cacheDir` 指向仓库内 `.cache/vitest`，规避系统临时目录 EPERM | PR/提交必须全绿；`pnpm test` 一条命令可跑 |
| P0-3 | CSP 禁网 | `index.html` 无 CSP；pack 可 `fetch` | 加 meta CSP：`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'`；用 E2E 验证 pack 内 `fetch` 失败、导出下载仍可用 | 网络请求被浏览器拦截，而不是靠代码自觉 |
| P0-4 | 导入授权 | `load.ts:170-172` 用 `new Function` + `eval`；蓝图内嵌 pack 源码 | 打开外部蓝图时先解析 packs，列出"名称 / 行数 / 源码哈希"，默认不编译，逐个"启用"后才进图；导出时在 JSON 与报告里写明含可执行代码 | 打开陌生蓝图零 pack 执行 |
| P0-5 | 值打标签（D1） | `types.ts:292` 靠 `addr + typeName + fields` 三字段判型；`calcNode` 可返回任意对象 | instance 加不可伪造品牌（`Symbol` 或 `__kind`），`calcNode` 返回值过 `normalizeValue`，非白名单形状降级为 json 并告警 | 构造"恰好带三字段的 calc 输出"测试，断言不被当元素 |
| P0-6 | 缓冲区身份（D3） | `BlueprintApp.tsx:233` 按 `name:base:length` 去重；`eval.ts:453` 每节点重建 `BufferValue` | 引入 `AssetId`（内容哈希），`BufferValue` 带 id；去重、跟随地址下拉、diff 全部用 id | 同名同长不同内容的两个 dump 不再互相顶替 |
| P0-7 | 追溯与求值解耦（D4） | `eval.ts:501` 在 `resolveSource` 里 `evalNode(src)`，与 `state` 状态机共用 memo | `resolveSource` 只读图结构 + 资产表；"字符串/bytes 当数据源"改为在 `evalBody` 已算出的输入值上读取 | 构造合法图，断言不再误报 `CYCLE`、上游输出不为 `{}` |
| P0-8 | 截断与问题结构化（D15/D7） | `eval.ts:951` `items.length >= max` 误报；`eval.ts:449` 把 code 拼进 detail 字符串 | 截断区分"达到上限"与"因上限停止"，返回 `{limit, at, canContinue}`；`Problem` 加 `code/at/fix`，旧 `detail` 保留一版兼容 | 恰好 256 项且链在此结束 → 不报"已截断"；问题面板可按 code 过滤 |
| P0-9 | 评测基线 | `scripts/cdp-perf.mjs` 只测缩放 FPS；两份文档的 KPI 无脚本可验 | 新增 `scripts/bench-eval.mjs`（vitest bench 或 node 直跑），生成 100/500/2000 节点合成图，输出 p50/p95 到 `bench/baseline.json` | CI 记录基线，回归 > 20% 失败 |

---

## 3. 两份文档的冲突与修正

### 3.1 冲突一：先修正确性，还是先做信任与性能

- `data-model-review`：先修 D1/D3（结果对不对）。
- `optimization-research`：P0-1 信任、P0-2 性能（能不能进客户）。

**裁决**：两者不矛盾，是时间尺度不同。正确性改动都在求值核心（`eval/types/packgraph`），信任改动在加载路径（`load/main/index.html`），性能改动在调度与投影——三条线改的文件几乎不重叠，可以按 P0 → P0-4 → P1 顺序推进，但**不要同周并行**：任何一周同时动 `eval.ts` 与 `load.ts`，都会让"结果不对"和"加载不对"混在一起难以定位。

### 3.2 冲突二：WASM/Tauri/AddressSpace 与 S1–S6 内核改造

`optimization-research` 的 B 阶段（3–9 月：Rust/WASM 核心 + mmap + Tauri）与 `data-model-review` 的 S3–S6 改的是同一批文件。并行等于两次重写。

**裁决**：串行，并给出立项门槛，三条同时满足才启动 WASM 核心：

1. 有真实客户样本 > 1 GB，且现有单文件方案在其上不可用；
2. `bench-eval` 显示纯 TS 在目标图规模（500 节点 / 10 万字段）P95 > 500 ms，且已排除端口投影与缓存可解决的部分；
3. CLI + 报告已被真实交付使用（说明核心语义稳定，值得固化）。

在此之前，`AddressSpace` 可以先做"接口 + 段表"的 TS 版本（`AddressSpace.read(addr, len)`），它同时是 D2 的解法与将来 WASM 的边界。

### 3.3 冲突三：缓存键用内容哈希还是版本号

- review：`assetRevision`，每次写入 +1。
- research：`(fileId, version, 采样页哈希)`。

**裁决**：`assetId + rev + size + 采样页哈希（首/中/尾各 4 KB）`。理由：dump 可能被外部工具原地改写而版本号不变，纯 rev 会读到旧值；全量内容哈希在 GB 级样本上太贵，采样是成本与正确性的折中。写进 ADR，并在"强制重算"按钮旁注明这条假设。

### 3.4 修正：D8 已不成立

`selection.ts:119-124` 的 `retainSelection` 已在 primary 失效时回落到集合内第一个对象，`toggleNode`/`toggleEdge` 也维护了 primary。这条应从问题清单移除并标注"已修"，否则后续会按错误前提重构选择模型。

### 3.5 修正：D2 需要限定范围

`mem.ts:26` 的累加在 size=8 时确实丢精度，`packgraph.ts:68/72` 立即 `Number()` 也是事实。但：

- 47/48 位 canonical VA 在 2^53 内是精确的，普通用户态 dump 不受影响；
- 真正会错的是**内核高半区地址**（符号扩展后 > 2^63）与 **u64 标量/掩码**；
- 前者用段基址归一化解决（`addr - segmentBase`），后者只需 `{t:'big'}` 显示与比较通道。

按这个拆法，D2 不需要"全线改类型签名"，可以放进 P1 而不是 P0。

---

## 4. 两份文档都没覆盖的缺口（本轮新发现）

| 编号 | 类别 | 发现 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| G1 | 版本控制 | 无 `.git` | 目录根 | 无法回滚、无法定位回归、无发布基线 | P0-1 |
| G2 | CI | 无 workflow；有 `eslint-disable` 但无 eslint | `package.json`、`BlueprintApp.tsx:360` 等 | 规范靠人记，测试靠手动 | P0-2 |
| G3 | 许可 | 无 LICENSE / EULA | 目录根 | 商业化文档已写定价与"禁止绕过 DRM"的法务边界，却没有许可文件落地 | 补 LICENSE（核心闭源则补 EULA + 第三方声明：Sucrase/React/Vite） |
| G4 | 大文件护栏 | `readFile` 整读无上限 | `BlueprintApp.tsx:92-94` | 拖入 2 GB 文件直接 OOM，且无提示 | 加阈值（如 256 MB）显式拒绝并提示"等分页/切片能力"；P1 换 IndexedDB |
| G5 | 性能不可验收 | 只有缩放 FPS 脚本 | `scripts/cdp-perf.mjs:2` | 文档 KPI 表无法判定是否达成 | P0-9 |
| G6 | 测试入口不稳 | `vitest run` 默认 reporter 在本机 600 s 未退出；`--reporter=basic` 2.2 s 通过 293/293 | 本轮实测 | CI 会随机挂起 | 加 `vitest.config.ts`（固定 environment/reporter/cacheDir），并保留一次重试 |
| G7 | 文档双源 | README 与 `description-format.md` 重复节点表/构造器表；README 写 685 KB，实际 742 KB | README:22、README:256-267 | 两处必然漂移（尺寸数字已经漂了） | README 只留"是什么/怎么用/限制"，pack 参考单一来源放 docs；尺寸改为构建后自动写 |
| G8 | 遗留代码 | 三个入口都在 `main.tsx` 静态导入 | `main.tsx:1-6` | v1（`App.tsx`）+ v2（`v2/*` + `ui/{Left,Right,Graph}Panel` + `core/cparse`）约 4.5k 行（26%）仍打进单文件 | 先删 v1（已被 v2 完全取代），v2 保留到字段写回迁进蓝图检查器；CLI 可复用 `evaluateGraph` 而不带 UI |
| G9 | 领域逻辑泄漏 | NVMe 专用 `prp` 在内置注册表 | `builtins.ts:554` | 每加一个领域就要改内核注册表 + 画布 + 检查器 + 迁移 | 内置层只留通用原语；`prp` 下沉到 pack 或标准库，作为"格式即测试"的第一个样板 |
| G10 | 端口命名 | 画布只解析 `elem:(\d+)` | `Canvas.tsx` 的 `elementIndex()` | `elem:field:3` 这类端口取不到 index，画布行为与端口语义不一致 | 与 D10 一起做：唯一 `parsePort()`，三种形态共用 |
| G11 | 持久化 | localStorage 同步写 + base64 膨胀 33% + 2 MB 上限 | `persist.ts:17/63-80`、`doc.ts:5-19` | 稍大的 dump 就被裁剪，重载后要重新载入；每次编辑防抖写盘会卡主线程 | 字节进 IndexedDB（Blob/Uint8Array），文档仍走 localStorage；导出时再内联 base64 保持单文件可移植 |
| G12 | 治理 | 无 ADR、无 CHANGELOG、无 docs 索引 | docs/ | 三份文档谁优先、哪条已修，没有地方记录 | `docs/README.md` 索引（状态 + 最后复核日期）、`CHANGELOG.md`、4 篇 ADR（见 §7） |

---

## 5. 六周计划

| 周 | 主题 | 具体交付 | 验收 |
| --- | --- | --- | --- |
| W1 | 底盘 | git + 首次提交；lint/tsc/test CI；vitest 配置；CSP；LICENSE/EULA 草案；`docs/README.md` 索引 | CI 全绿；陌生蓝图零执行；`pnpm test` 稳定 |
| W2 | 正确性 | D1 值标签；D3 AssetId；D4 追溯解耦；D15 截断；D7 Problem 结构化 | 每条配一个"会算错"的回归用例；NVMe 快照逐字节一致 |
| W3 | 规模 | 端口投影（可见 + 已连线）；`portsFor` 单次缓存；`bench-eval` 接入 CI；大文件阈值提示 | 4096 项链表的端口对象分配下降 > 80%；bench p95 有基线 |
| W4 | 存储与响应 | IndexedDB 资产层（双写兼容）；导出仍单文件；求值预算（超时/节点数上限 → 可见"未求值"） | 50 MB dump 不再触发 TRIMMED；长任务 < 100 ms |
| W5 | 交付物 MVP | `memlink check <blueprint> <dump>`：JSON 输出 + 退出码（0 通过 / 1 断言失败 / 2 用法错误）+ 覆盖率 | 在 20 个样本上批量跑；失败定位到节点与字节 |
| W6 | 报告与整理 | 单文件 HTML 报告（字段树 + 字节证据 + 哈希 + 覆盖率 + 内嵌蓝图）；删 v1；README 去重 | 报告可独立打开并一键恢复图；`src/` 减约 2k 行 |

顺序原则：**W1 不写业务代码，W2 不改 UI，W3/W4 不改文档格式，W5 不动求值语义**。任何一周同时动"求值"和"加载"都会让回归难以归因。

---

## 6. 指标与门禁

| 指标 | 采集方式 | 现状 | W6 目标 |
| --- | --- | --- | --- |
| 类型检查 / 单测 | CI | 0 错 / 293 通过 | 保持，且新增用例只增不减 |
| 求值 p50 / p95（500 节点） | `bench-eval` | 未测 | 记录基线，回归 > 20% 失败 |
| 4096 项链表端口分配 | bench 内计数 | 4096 端口 + values | 只投影可见 + 已连线（默认 ≤ 8 + 已连线） |
| 单文件体积 | 构建输出 | 742 KB | ≤ 650 KB（删 v1 + 去重后） |
| 打开 50 MB dump | E2E | 触发 TRIMMED 或卡顿 | 不裁剪、可交互 |
| 陌生蓝图执行 | E2E | 直接执行 | 零执行，需逐个授权 |
| 覆盖率 | CLI 输出 | 无 | 有（解释字节 / 总字节） |
| UI 查找 | 代码审查 + profile | 每渲染多次 `nodes.find` | 派生索引 O(1)（P2） |

---

## 7. 四个待定决策的建议答案（ADR 种子）

| 决策 | 建议 | 理由 | 备选与否决原因 |
| --- | --- | --- | --- |
| 缓存键 | `assetId + rev + size + 采样页哈希` | 兼顾外部原地改写与 GB 级成本 | 纯 rev：外部写回读旧值；全量哈希：太贵 |
| 值模型 | 带标签联合 + `RecordRef(asset,type,addr,size)` | 值可跨节点传递/缓存/序列化；字段按需取 | 保留整棵 `fields[]`：字符串分配是当前最大开销 |
| 资产存储 | 字节进 IndexedDB，文档只存引用；导出时内联 | 解除 2 MB 与 33% 膨胀；单文件可移植性不丢 | 继续 base64 内联：天花板不变 |
| 信任模型 | 先 CSP + 导入授权，L0/L1 声明式后置 | 最小成本关掉"打开即执行" | 一次做三层：周期长，且 L0/L1 需要 pack 语言先稳定 |

---

## 8. 明确不做（补充清单）

在 `optimization-research` §9 的"不做"之外，再补五条：

1. **不做全量 bigint 化**：段基址 + 局部 u64 通道足够，全量改签名会把两周的活变成两个月。
2. **不做节点级缓存之前先不做 WASM**：缓存策略在 TS 里试错成本是 WASM 的十分之一。
3. **不引入状态管理库/UI 框架**：现状 `useState + ref 镜像 + commit` 已经够用，换库只会增加迁移面。
4. **不做 i18n**：中文用户是当前唯一验证过的市场；等有海外需求再做，且届时用词条表而不是重写组件。
5. **不再往内核加领域节点**：`prp` 是第一个也是最后一个；新领域走 pack，内核只留通用原语。

视觉上同理：`styles.css:1-22` 已有完整 token 层，浅色主题是"补一套变量 + 清掉约 60 处硬编码色"，是 1 天的事，不是设计重构。放在 P2，与报告模板共用同一套 token。

---

## 9. 附：本轮验证记录

- `node node_modules/typescript/bin/tsc --noEmit` → 退出码 0。
- `node node_modules/vitest/vitest.mjs run --reporter=basic` → 18 文件 293 用例通过，2.20 s。
- 同一命令去掉 `--reporter` → 600 s 未退出（SIGTERM），需在 CI 配置里固定 reporter 与 cacheDir。
- `dist/index.html` → 742,168 B（README 写 685 KB，已漂移）。
- 依赖方向抽查：`core` 不依赖 `bp/ui/v2`；`ui` 只依赖 `core`；`v2` 不依赖 `bp`。分层是干净的，重构时用 lint 固化，不要破坏。
- 抽查文件：`bp/types.ts`、`bp/eval.ts`、`bp/Canvas.tsx`、`bp/BlueprintApp.tsx`、`bp/persist.ts`、`bp/selection.ts`、`bp/load.ts`、`bp/doc.ts`、`bp/history.ts`、`core/mem.ts`、`core/packgraph.ts`、`core/expr.ts`、`bp/builtins.ts`、`v2/*`、`main.tsx`、`styles.css`。

---

## 10. 一句话总结

**前两份文档把"哪里有问题、往哪走"说清楚了，缺的是"先做哪一件、做完怎么算过"。** 补上底盘与门禁，把正确性四条路径关掉，再按"端口投影 → 预算 → 资产外置"的顺序拿性能，最后用 CLI 与报告把能力变成可交付物——这条路径不需要重写，六个月能看到商业化的第一个闭环。
