# Pack 商店

mem-link 的 pack 商店是一个静态 GitHub 仓库：`index.json` 列出可安装的格式
pack，每个 pack 是一个 `.bp.ts` 文件。应用只在你打开商店和点击安装时联网，
安装后的源码写入蓝图/浏览器缓存，之后完全离线可用。

- 商店仓库：<https://github.com/qmjianda/mem-link-packs>
- 默认索引：`https://cdn.jsdelivr.net/gh/qmjianda/mem-link-packs@main/index.json`
- 本地内容：主仓库 [`store/`](../store/)

## 使用

### 打开商店

顶栏「Pack 商店」，或左栏节点库「导入 .bp.ts」旁边的「Pack 商店」。

商店浮层支持：

- 按名称、id、标签、作者搜索；
- 按分类过滤（图像、压缩包、可执行文件、系统、游戏……）；
- 输入任意 GitHub 仓库、分支或 `index.json` 地址；
- 查看版本、来源（Nybble / ImHex / 手工）、许可、SHA-256、是否「部分布局」；
- 安装、更新、重装。已安装状态按「商店地址 + pack id」识别，不受本地显示名影响。
- 「参考蓝图」：打开一张已经接好 File → 解析节点的临时示例图，不覆盖当前工作图。
  参考图带零填充示例 buffer 和一段使用说明；每个节点的帮助里也能打开它。

### 安装与更新

安装时应用会：

1. `fetch` 下载 `packs/<id>/pack.bp.ts`；
2. 如果索引提供了 `sha256`，用 WebCrypto 校验源码；
3. Sucrase 去类型并在 `new Function` 中执行（与本地导入同一路径）；
4. 把源码、编译产物和来源写入当前 `DocState`，一次 `commit` 形成一条撤销记录。

更新会保留本地 `LoadedPack.id`、显示名、启用状态和图中节点，只替换源码与
来源。若新版本改了 pack 内的节点 id，已有节点会按求值器规则报「未知节点」，
不会静默删除。

### 离线

- 已安装 pack 的源码随蓝图 JSON 和 `memlink:graph:v3` 缓存保存。
- 商店索引会缓存在 `memlink:store:cache:v1`；网络失败时仍可浏览上次目录，
  但安装/更新需要重新下载源码。
- 本机 `.bp.ts` 导入路径不变。

## 商店格式

```json
{
  "format": "memlink-pack-store/1",
  "name": "mem-link Pack Store",
  "homepage": "https://github.com/qmjianda/mem-link-packs",
  "packs": [
    {
      "id": "sqlite",
      "name": "SQLite 3",
      "version": "1.0.0",
      "category": "database",
      "order": 20,
      "summary": "数据库头、B-tree 页头、freelist、WAL 与 varint",
      "description": "……",
      "tags": ["sqlite", "database", "btree"],
      "author": "qmjianda",
      "license": "MIT",
      "homepage": "https://www.sqlite.org/fileformat2.html",
      "coverage": "complete",
      "source": { "provider": "manual", "url": "..." },
      "path": "packs/sqlite/pack.bp.ts",
      "sha256": "…64 位小写 hex…",
      "size": 5000,
      "reference": {
        "path": "packs/sqlite/reference.blueprint.json",
        "sha256": "…64 位小写 hex…",
        "size": 9258
      }
    }
  ]
}
```

- `path` 相对 `index.json` 解析，因此支持任意分支/子目录。
- `sha256` 可选；缺失时商店显示「无哈希」，仍可安装。
- `coverage: "partial"` 表示只移植了固定布局，pack 末尾列出未移植项。
- `source.provider` 目前有 `manual` / `nybble` / `imhex`。
- JSON Schema 见 [`store.schema.json`](../store/store.schema.json)。

## 地址归一化

商店地址输入支持：

| 输入 | 实际索引 |
| --- | --- |
| `owner/repo` | `https://raw.githubusercontent.com/owner/repo/main/index.json` |
| `https://github.com/owner/repo` | 同上 |
| `https://github.com/owner/repo/tree/dev` | `.../dev/index.json` |
| `https://github.com/owner/repo/blob/main/index.json` | 原 Raw 文件 |
| `https://example.com/store/` | `https://example.com/store/index.json` |
| `https://example.com/custom.json` | 原样 |

地址保存在 `memlink:store:v1`，下次打开沿用。默认地址使用 jsDelivr 的 GitHub 镜像；发布脚本会在推送后调用 jsDelivr 的
purge 接口刷新 `@main` 缓存。拉取失败时会依次回退到 GitHub Pages 与
`raw.githubusercontent.com`。填写 GitHub 仓库地址、raw 或 Pages 地址时，
也会自动尝试其它镜像。

## 内容来源与覆盖度

> 移植/生成 pack 前先读
> [`.agents/skills/mem-link-pack-authoring/SKILL.md`](../.agents/skills/mem-link-pack-authoring/SKILL.md)：
> 它记录了 endian、保留字、空类型、数组括号、辅助节点与发布的已知坑。
>
> 许可分层：手工 pack 为 MIT；Nybble 派生 pack 按上游 README 声明可自由
> 使用/再分发（除非该 pack 另有说明）；ImHex 派生 pack 为 **GPL-2.0-only**
> （上游识别为 GPL-2.0，不是 or-later），与 mem-link 根目录的专有许可分开。
> 完整文本见 [`store/licenses/GPL-2.0-only.txt`](../store/licenses/GPL-2.0-only.txt)
> 与 [`store/NOTICE.md`](../store/NOTICE.md)。

当前 `store/` 有 377 个 pack：

- 10 个手工 pack：NES、SQLite、PNG、BMP、ZIP、GIF、ELF、PE、JPEG、WAV。
- 83 个从 [Nybble format registry](https://github.com/itsmajdbuilds/binary-explorer-registry)
  移植：`store/scripts/port-nybble.mjs` 解析上游 schema，生成固定前缀。
- 284 个从 [ImHex-Patterns](https://github.com/WerWolv/ImHex-Patterns) 移植：
  `store/scripts/port-imhex.mjs` 解析 `.hexpat` 中的 struct/union/bitfield/enum/
  using/padding 和固定数组；其余 28 个 pattern 只有条件/varint/运行时逻辑，
  没有可静态确定的字段，未生成 pack。

mem-link 的静态类型不能表达条件字段、`repeat`、`match`、变长数组、指针跟随、
运行时解压/校验。移植器会保留已经确定的字段，并把动态部分尽量生成辅助节点：
computed → `calcNode`，指针 → 地址 `calcNode` + 目标 `structNode`，repeat →
`listNode`，动态数组 → `arrayNode`，match 分支 → 变体 `structNode`。生成的
`meta.json` 标记 `coverage: "partial"` 并记录 `helpers` 数量；文件末尾列出仍无法
自动覆盖的项。当前 377 个 pack 中 192 个完整、185 个部分布局，59 个部分布局
带有 321 个动态辅助节点。

## 发布

主仓库的 `store/` 是源；独立商店仓库是它的镜像：

```bash
pnpm packs:index          # 重新生成 store/index.json
pnpm packs:check          # 校验索引是否最新
node scripts/publish-pack-store.mjs --dry-run
node scripts/publish-pack-store.mjs
```

发布脚本会重新生成索引，把 `store/` 同步到 `.cache/pack-store-publish` 的
Git 克隆，提交并推送到 `qmjianda/mem-link-packs`；推送成功后调用
`purge.jsdelivr.net` 刷新 `@main` 缓存（`--no-purge` 可跳过）。商店仓库的 CI
只运行 `node scripts/build-index.mjs --check`，不需要 npm 依赖。

## 安全边界

- 商店索引是数据，打开商店不会执行 pack。
- 安装是显式动作；源码在安装时才下载、校验、编译。
- pack 是代码：运行在页面里，拥有页面的网络与 DOM 权限。当前不提供沙箱或
  签名；只安装信任来源。
- 如果未来对外分享蓝图，参见
  [`openspec/changes/pack-trust-boundary`](../openspec/changes/pack-trust-boundary/proposal.md)
  的信任边界候选方案。
