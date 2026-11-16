# Proposal

## Why

求值器目前用鸭子判型识别元素值、用 `name:base:length` 识别缓冲区、让数据源追溯回调上游求值，并在恰好达到上限时误报截断——这四条路径都会**静默产出错误结果**而不是报错。与此同时，蓝图内嵌 pack 源码并以 `new Function` 执行，打开他人蓝图即执行其代码，使产品无法通过任何安全评审。仓库也没有版本控制、CI 与 CSP，任何修复都缺少可回滚、可验证的前提。

## What Changes

- **工程底盘**：初始化 git 与首次提交；CI 跑类型检查、单测、构建；新增求值基准脚本并记录基线；补 LICENSE/EULA 草案与 `docs/README.md` 索引。
- **值类别显式化**：元素值携带不可伪造的类型标识；计算节点返回的非白名单形状降级为 JSON 并产生告警，不再被当成元素继续解码。
- **缓冲区身份**：以内容哈希生成资产 id，文档、求值、跟随地址与诊断共用同一身份；同名同长不同内容的 dump 不再互相顶替。
- **数据源解析解耦**：数据源追溯只读图结构与资产表，不再回调上游求值；直连、指定、继承、默认四级优先级的语义保持不变。
- **截断语义**：区分"自然结束于上限"与"因上限被截断"，对外给出 `limit` / `at` / `canContinue`。
- **问题条目结构化**：问题携带稳定原因码、定位信息与可选修复动作，正文不再把原因码拼进字符串。
- **信任最小集**：CSP 禁止网络请求；导入蓝图先列出 pack 清单与源码哈希，默认不编译、逐个授权后才执行；导出物声明"含可执行代码"并附哈希。
- **兼容性**：蓝图 JSON 格式、节点语义、pack 源码格式与旧缓存读取均不变；旧图可直接打开。

## Capabilities

### New Capabilities

- `blueprint-evaluation`: 图求值的可观察契约——值类别判别、数据源解析、截断语义与问题报告。
- `buffer-assets`: 缓冲区/资产的唯一身份、内容去重与跨节点一致性。
- `pack-trust`: pack 代码的执行边界、蓝图导入授权与离线约束。

### Modified Capabilities

（无：项目此前没有已归档的 spec。工程底盘类工作只落在任务清单，不虚构行为需求。）

## Impact

- **代码**：`src/bp/types.ts`、`src/bp/eval.ts`、`src/bp/persist.ts`、`src/bp/doc.ts`、`src/bp/BlueprintApp.tsx`、`src/bp/Inspector.tsx`、`src/bp/load.ts`、`src/bp/docstate.ts`、`index.html`；新增资产与问题定位的纯函数模块。
- **依赖**：不新增运行时依赖；开发侧新增 ESLint 与基准脚本。
- **兼容**：蓝图 `memlink-blueprint/1` 不变；`Problem.detail` 保留一版兼容读取；CSP 仍需 `unsafe-eval`（pack 执行路径本阶段不改）。
- **风险**：值类别收紧后，返回可疑形状的既有计算节点会从"看似可用"变为"告警 + 降级"，需用 NVMe 示例、`samples/` 与 293 条既有用例回归。
- **不在范围**：u64/bigint 与段基址、端口投影与缓存、IndexedDB 资产存储、CLI/报告/diff、WASM/Tauri、删除 v1/v2 遗留。
