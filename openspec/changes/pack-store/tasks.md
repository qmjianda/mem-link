## 1. 商店格式与内容

- [x] 1.1 定义 `memlink-pack-store/1` 索引与 `meta.json` 字段
- [x] 1.2 编写 10 个手工核心 pack（NES、SQLite、PNG、BMP、ZIP、GIF、ELF、PE、JPEG、WAV）
- [x] 1.3 固定 Nybble registry 快照并编写 schema → pack 移植器
- [x] 1.4 编写 ImHex `.hexpat` 固定布局移植器
- [x] 1.5 生成并校验 377 个 pack，记录 `coverage`、`helpers` 与来源
- [x] 1.5b 动态部分生成 calc/list/array/变体辅助节点（321 个），不只保留固定前缀
- [x] 1.6 编写 `build-index.mjs`，生成 SHA-256、大小与排序
- [x] 1.7 添加 JSON Schema、GPL 许可文本、NOTICE 与商店 README

## 2. 应用内商店

- [x] 2.1 `store.ts`：URL 归一化、索引解析、镜像回退、超时
- [x] 2.2 `store.ts`：SHA-256、版本比较、安装状态、索引缓存
- [x] 2.3 `PackStore.tsx`：搜索、分类、地址编辑、安装/更新/重装、错误与哈希提示
- [x] 2.4 `LoadedPack.store` 元数据与蓝图/缓存持久化
- [x] 2.5 顶栏与节点库入口
- [x] 2.6 安装/更新提交：保留本地 id、显示名、启用态和节点
- [x] 2.7 默认 jsDelivr 地址与 raw 回退

## 3. 发布

- [x] 3.1 创建 `qmjianda/mem-link-packs` 公共仓库
- [x] 3.2 推送 377 个 pack、索引、脚本、许可与 README
- [x] 3.3 添加 `scripts/publish-pack-store.mjs` 与 CI `--check`
- [x] 3.4 添加 package scripts：`packs:index` / `packs:check` / `packs:port:*` / `packs:publish`

## 4. 验证与文档

- [x] 4.1 `tests/store-packs.test.ts` 加载全部 pack
- [x] 4.2 `tests/pack-store.test.ts` 覆盖 URL、索引、版本、哈希、镜像回退
- [x] 4.3 持久化测试覆盖 `store` 元数据往返
- [x] 4.4 浏览器冒烟：商店加载 377 个 pack，安装 PNG/SQLite/ImHex pack，节点库出现新 pack
- [x] 4.5 更新 README、`docs/pack-store.md`、docs 索引
- [x] 4.6 `tsc --noEmit`、全量 Vitest、单文件构建
