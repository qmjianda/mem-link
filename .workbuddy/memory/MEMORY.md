# 项目约定

## 定位

- 这是一个**小工具**，核心链路只有三段：拖入 bin → 按结构体解码 → 跟链表/指针。
- 判断一个改动要不要做，先问它是否服务这三段。平台化能力（CLI/报告、WASM/Tauri、多用户、信任边界）默认不做。

## pack 用 TypeScript 写，这是特性

- 已明确：**保留** TS 编写 pack（`definePack` / `struct` / `listNode`），不做字段表单生成器，也不做「粘贴 C 结构体」转换。
- 因此不要提议「让用户不写代码」的方案；要改善这条路径，只能改善 TS 本身（类型声明、模板、报错、样例）。
- 样例 `samples/*.bp.ts` 已纳入 `tsc` 范围（`tsconfig.json` 的 `include`），改坏会直接报错。

## 入口与遗留

- 默认入口是 `src/bp/BlueprintApp.tsx`；`#v1` → `src/App.tsx`（C 声明 + 图），`#v2` → `src/v2/PackApp.tsx`（旧 pack 编辑器）。
- v1/v2 与新入口是三代实现，各自有 pack 格式（`types/memlink.d.ts` vs `types/memlink-bp.d.ts`）。删除需单独立项，不要顺手清理。

## 常用命令

- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`
- 求值基准：`node scripts/bench-eval.mjs`（`--write` 更新 `docs/perf-baseline.md`）
- 真实浏览器回归：`node scripts/cdp-verify.mjs`、`node scripts/cdp-verify-follow.mjs`（跑 `dist/index.html`，需先 build）
- 文档索引：`docs/README.md`

## 已固化的求值契约

见 `openspec/changes/p0-baseline-and-correctness/`：值品牌用 WeakSet、资产 id 用同步 FNV-1a 64、来源解析不调用求值、截断区分自然结束与上限。改 `eval.ts` 前先读这份 spec。
