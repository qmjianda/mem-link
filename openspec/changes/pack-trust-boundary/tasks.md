# Tasks

> 本变更暂不实施，任务仅作记录。启动条件见 `proposal.md` 的「触发条件」。

## 1. 网络边界

- [ ] 1.1 生产构建注入 CSP（`default-src 'self'; connect-src 'none'; img-src 'self' data:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'`），dev 单独放开 HMR 所需的 `ws:`。验证：`pnpm build && pnpm preview` 后打开 NVMe 示例，Console 无 CSP 违规、Network 面板零请求。
- [ ] 1.2 编译 pack 前安装网络守卫（`fetch`/`XMLHttpRequest`/`WebSocket` 抛带标记错误），求值 catch 把标记映射为 `NO_NETWORK`。验证：用例中一个调用 `fetch` 的 pack 节点产生 `NO_NETWORK` 问题并定位到该节点。

## 2. 导入授权

- [ ] 2.1 `onOpenDoc` 改为两阶段：先解析并展示 pack 清单（名称、节点数、哈希前 12 位），默认全不勾选，仅对勾选项调用 `loadBlueprintPack`，其余以 `enabled:false` 载入。验证：打开含未知 pack 的图时无编译发生（对 `loadBlueprintPack` 计数为 0），节点可见并标记未启用。
- [ ] 2.2 哈希与当前源码不符时视为未授权，重新弹出清单并要求再次确认。验证：篡改导出文件中的 pack 源码后打开，出现不一致提示且不执行代码。
- [ ] 2.3 未启用 pack 的节点停在 `PACK_DISABLED` 提示态，不再叠加 `UNKNOWN_NODE`。验证：用例断言未启用 pack 的节点只产生 `PACK_DISABLED` 一条问题。

## 3. 导出声明

- [ ] 3.1 导出蓝图时写入 pack 哈希清单与「包含可执行代码」声明，导入方可核对。验证：用例断言导出 JSON 含两个 pack 的哈希与声明字段，且导出文件仍可被 `parseDoc` 正常解析。

## 4. 文档

- [ ] 4.1 在 `docs/` 增加信任模型说明（CSP 强制层、守卫归因层、授权粒度、导出元数据）。验证：文档说明与上述实现一致，并被 `docs/README.md` 索引。
