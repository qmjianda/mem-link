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
- 同日晚些时候清理了残留死代码：`styles.css` 只剩蓝图样式（84 → 50 KB），`core/types.ts` 只留 `Endian` + `Problem`，v1 图层构建器（`buildPackGraph`）、`validatePack`、`loadPack`、`hexdump` 等一并删除。改动前请先确认这些确实没人用了。

## 结构树全屏视图

- 入口三个：节点标题栏 `⤢`（仅 struct/list/array）、检查器「打开」、双击节点空白处；Esc 退出，图的缩放与选中不变。**没有** Enter 快捷键（用户明确不要）。
- `src/bp/tree.ts` 是懒解码模型：结构体浅解码、链表/数组分页（200/页）、`locateIndex` 跳下标、搜索只过滤已展开行并保留祖先、`follow`/hex 指针可内联展开。
- `src/bp/StructTree.tsx` 是虚拟滚动 UI。图上求值仍截断 4096，树里不受此限（受 pack 的 list `max` 约束），所以两处上限语义不同，改的时候别混。
- 同一节点再次打开会恢复展开/搜索/游标/滚动（`BlueprintApp` 的 `treeSessions`，仅本次会话）；数组容器（含嵌套数组字段）支持 `g` 跳下标；地址行有 `⌖` 树内定位与 `↗` 图上解析两个按钮。
- 回归：`node scripts/cdp-verify-tree.mjs`（17 项）+ `tests/tree.test.ts`。

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
