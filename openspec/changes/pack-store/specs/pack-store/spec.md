# Spec Delta

## ADDED Requirements

### Requirement: 商店索引是静态且可校验的

商店 MUST 由单个 `index.json` 与相对路径的 `packs/<id>/pack.bp.ts` 组成，格式为 `memlink-pack-store/1`。索引条目 MUST 包含唯一 `id`、`name`、`version`、`category`、`summary`、`path`；`path` MUST 以 `.bp.ts` 结尾并相对索引地址解析。`sha256` 可选，存在时 MUST 是 64 位小写十六进制。索引可携带 `source`（provider/id/path/url/license）与 `coverage`（`complete`/`partial`）。

#### Scenario: 相对路径解析

- **GIVEN** 索引地址为 `https://cdn.jsdelivr.net/gh/o/r@main/index.json`
- **WHEN** 条目 `path` 为 `packs/nes/pack.bp.ts`
- **THEN** 实际下载地址是 `https://cdn.jsdelivr.net/gh/o/r@main/packs/nes/pack.bp.ts`

#### Scenario: 坏条目被跳过

- **GIVEN** 索引里有一个 `sha256: "xyz"` 的条目
- **WHEN** 应用解析索引
- **THEN** 该条目被跳过并产生一条可读警告，其它条目仍可浏览

### Requirement: 商店地址可归一化并有镜像回退

应用 MUST 接受 `owner/repo`、`https://github.com/owner/repo`、`.../tree/<branch>`、`.../blob/<branch>/index.json`、以 `.json` 结尾的 URL 与目录 URL，并归一化为索引地址。默认地址 MUST 使用 jsDelivr 的 GitHub 镜像；拉取失败时 MUST 依次回退到 GitHub Pages 与 `raw.githubusercontent.com`。发布脚本 SHOULD 在推送后调用 jsDelivr purge，避免 `@branch` 缓存导致目录滞后。地址 MUST 持久化到 `memlink:store:v1`。

#### Scenario: GitHub 仓库地址

- **GIVEN** 输入 `qmjianda/mem-link-packs`
- **WHEN** 打开商店
- **THEN** 归一化为 `https://raw.githubusercontent.com/qmjianda/mem-link-packs/main/index.json`，实际拉取失败时尝试 jsDelivr 镜像

#### Scenario: 商店不可达

- **GIVEN** 两个镜像都不可达
- **WHEN** 用户打开商店
- **THEN** 显示网络/CORS 错误，已安装 pack 与本地图不受影响

### Requirement: 安装与更新必须显式且校验来源

应用 MUST 只在用户点击「安装/更新/重装」后下载并编译 pack。下载后 MUST 在索引提供 `sha256` 时用 WebCrypto 校验源码；不匹配 MUST 阻止安装。编译 MUST 复用本地 `.bp.ts` 的加载器。更新 MUST 保留本地 `LoadedPack.id`、显示名、启用状态、节点与连线，只替换源码、编译产物和 `store` 元数据。

#### Scenario: 哈希不匹配

- **GIVEN** 索引条目带 `sha256`，下载到的源码被篡改
- **WHEN** 用户点击安装
- **THEN** 安装被拒绝并显示哈希不匹配，文档不变化

#### Scenario: 更新保留图中节点

- **GIVEN** 图中已有某个商店 pack 的节点
- **WHEN** 用户更新到新版本
- **THEN** pack 的本地 id、显示名、启用态和节点/连线都保留；若节点 id 变化，求值器按原规则报问题

### Requirement: 商店来源随文档与缓存持久化

`LoadedPack` MUST 支持可选 `store` 元数据（商店地址、pack id、版本、sha256、path、provider、coverage）。该元数据 MUST 写入蓝图导出与 `memlink:graph:v3`，读取时 MUST 校验结构；非法 `store` 元数据 MUST NOT 阻止 pack 加载，只丢弃来源信息。安装后的源码 MUST 离线可用。

#### Scenario: 导出再导入

- **GIVEN** 一个从商店安装的 pack
- **WHEN** 导出蓝图后在另一台机器打开
- **THEN** pack 源码与 `store` 来源信息都在；已安装状态可再次识别

#### Scenario: 离线打开

- **GIVEN** 商店不可达
- **WHEN** 用户打开已缓存的蓝图
- **THEN** pack 正常编译、节点正常求值，不发起网络请求

### Requirement: 移植内容必须标注来源与覆盖度

自动移植的 pack MUST 在文件头与 `meta.json` 记录上游仓库、路径与许可；无法静态表达的字段 MUST 在文件末尾列出。`coverage: "partial"` 的 pack MUST 在商店界面显示「部分布局」。不得把条件/变长/指针字段静默当成固定字段读取。能通过 `calcNode` / `listNode` / `arrayNode` / 变体 `structNode` 表达的动态部分 SHOULD 生成辅助节点，并在 `meta.json` 记录 `helpers` 数量；商店 SHOULD 显示辅助节点数量，而不是把这类 pack 等同于完全无法解析。

#### Scenario: 部分布局

- **GIVEN** 一个 ImHex pack 在条件字段处停止移植
- **WHEN** 用户在商店查看该 pack
- **THEN** 卡片显示「部分布局」，pack 文件末尾列出未移植项，`meta.coverage` 为 `partial`

#### Scenario: 动态字段转为辅助节点

- **GIVEN** 一个 Nybble pack 含 computed 字段、指针和 repeat
- **WHEN** 移植器生成 pack
- **THEN** 固定前缀仍是 `structNode`，computed 生成 `calcNode`，指针生成地址 `calcNode` 与目标 `structNode`，repeat 生成 `listNode`，`meta.helpers` 大于 0

### Requirement: 发布索引前必须校验

主仓库 MUST 提供 `packs:index` 与 `packs:check`；商店仓库 CI MUST 运行 `node scripts/build-index.mjs --check`。索引 MUST 由脚本从 `meta.json` 与 `pack.bp.ts` 重新生成，包含每个源码的 SHA-256 与大小。

#### Scenario: 索引过期

- **GIVEN** 修改了某个 `pack.bp.ts` 但没有重新生成索引
- **WHEN** CI 运行 `--check`
- **THEN** 校验失败并提示重新生成 `index.json`
