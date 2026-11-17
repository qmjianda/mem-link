# 项目约定

## 定位

- 这是一个**小工具**，核心链路只有三段：拖入 bin → 按结构体解码 → 跟链表/指针。
- 判断一个改动要不要做，先问它是否服务这三段。平台化能力（CLI/报告、WASM/Tauri、多用户、信任边界）默认不做。

## pack 用 TypeScript 写，这是特性

- 已明确：**保留** TS 编写 pack（`definePack` / `struct` / `listNode`），不做字段表单生成器，也不做「粘贴 C 结构体」转换。
- 因此不要提议「让用户不写代码」的方案；要改善这条路径，只能改善 TS 本身（类型声明、模板、报错、样例）。
- 样例 `samples/*.bp.ts` 已纳入 `tsc` 范围（`tsconfig.json` 的 `include`），改坏会直接报错。

## 入口

- 唯一入口：`src/main.tsx` → `src/bp/BlueprintApp.tsx`。
- v1（`#v1`，C 声明 + 图）与 v2（`#v2`，旧 pack 编辑器）已于 2026-11-17 整体删除，连同 `v2/*`、`ui/{GraphCanvas,LeftPanel,RightPanel,format}`、`core/{cparse,edit,expr,graph,packedit,program,project}`、`types/memlink.d.ts`、`samples/{demo.pack.ts,demo.json}`。不要再按「三代实现」理解仓库。
- `styles.css` 里仍有 v2 段落未清理（与蓝图共享 `.btn`/`.ft-*` 等类名），要删需先做视觉核对。

## 仓库

- GitHub：https://github.com/qmjianda/mem-link（公开，默认分支 `main`，CI 见 `.github/workflows/ci.yml`）。
- LICENSE 为**专有**（All rights reserved）：仓库公开但不允许使用/修改/分发，属 source-available。要改开源需先换 LICENSE。
- 提交前门禁：`pnpm typecheck && pnpm lint && pnpm test && pnpm build`（CI 同序执行）。

## 常用命令

- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`
- 求值基准：`node scripts/bench-eval.mjs`（`--write` 更新 `docs/perf-baseline.md`）
- 真实浏览器回归：`node scripts/cdp-verify.mjs`（功能面）、`cdp-verify-follow.mjs`（跟随）、`cdp-verify-core.mjs`（核心链路：拖 bin → 解码 → 链表 → 跟随）。三者都跑 `dist/index.html`，需先 build。
- 文档索引：`docs/README.md`

## 已固化的求值契约

见 `openspec/specs/blueprint-evaluation/spec.md` 与 `openspec/specs/buffer-assets/spec.md`：值品牌用 WeakSet、资产 id 用同步 FNV-1a 64、来源解析不调用求值、截断区分自然结束与上限。改 `eval.ts` 前先读这两份 spec。

变更 `p0-baseline-and-correctness` 已于 2026-11-17 归档到 `openspec/changes/archive/`；信任边界仍挂在 `openspec/changes/pack-trust-boundary/`（未启动）。
