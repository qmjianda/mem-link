## Why

mem-link 的 pack 一直靠用户自己找、自己下载 `.bp.ts`、再拖进窗口。格式定义属于生态，不属于单个仓库：ImHex 有 300 多个 Pattern，Nybble 有 85 个声明式 format pack，用户不应该为了解析一个 NES ROM 或 SQLite 文件先去读别人的仓库结构。

现在需要一个可浏览、可安装、可更新的 pack 商店；它必须是静态的（无后端、可离线使用已安装内容），同时把「pack 是代码」的风险和来源说清楚。

## What Changes

- 新增独立的 GitHub 商店仓库 `qmjianda/mem-link-packs`，静态 `index.json` + 每个格式一个 `packs/<id>/pack.bp.ts` + `meta.json`。
- 应用新增「Pack 商店」浮层：搜索、分类、自定义商店地址、版本、来源、覆盖度、许可、SHA-256、安装/更新/重装。
- 安装包来源写入 `LoadedPack.store`，随蓝图与 `memlink:graph:v3` 缓存保存；更新保留本地 id、显示名、启用态与图中节点。
- 新增商店地址归一化：`owner/repo`、GitHub 仓库/分支、`index.json`、目录 URL；默认使用 jsDelivr 镜像，失败回退 `raw.githubusercontent.com`。
- 新增移植管线：Nybble TOML schema 与 ImHex `.hexpat` 的固定布局自动转成 `.bp.ts`；无法静态表达的条件/变长/指针字段在文件末尾列出，`meta.coverage` 标记 `partial`。
- 商店索引的安装前校验：格式校验、路径校验、可选 SHA-256（WebCrypto）。
- 内容：10 个手工 pack、83 个 Nybble pack、284 个 ImHex pack；192 个完整、185 个部分布局，其中 59 个部分布局带 321 个动态辅助节点；来源与许可分层记录。

## Capabilities

### New Capabilities

- `pack-store`: 商店索引格式、地址归一化、安装/更新、哈希校验、离线持久化、来源/覆盖度展示与发布流程。

### Modified Capabilities

（无：pack 的加载与执行模型不变，仍走现有 `new Function` 路径。）

## Impact

- **应用**：新增 `src/bp/store.ts`、`src/bp/PackStore.tsx`；`BlueprintApp` 挂载浮层与安装提交；`LoadedPack`/`BPDoc`/持久化增加可选 `store` 元数据；`Palette` 与顶栏增加入口。
- **内容**：主仓库新增 `store/`；独立仓库 `mem-link-packs` 由 `scripts/publish-pack-store.mjs` 发布。
- **联网边界**：只有打开商店、安装/更新时发起网络请求；其它解析与求值保持本地。已安装内容离线可用。
- **许可**：手工 pack MIT；Nybble 派生按上游声明；ImHex 派生 GPL-2.0-or-later，单独保留许可文本。
- **测试**：`tests/store-packs.test.ts` 加载全部 377 个 pack；`tests/pack-store.test.ts` 覆盖 URL、索引、版本、哈希、镜像回退；持久化测试覆盖 `store` 元数据往返。
