# 资产身份

## 规则

每份载入的字节都有一个 `assetId = "a1:" + fnv1a64(bytes)`。名称、基址、长度**都不参与**身份：

- 两个文件都叫 `dump.bin`、都是 4 KiB、基址都是 0，但内容不同 → 两个资产；
- 同一份字节被两个 File 节点载入 → 一个资产，`bytes` 是同一个 `Uint8Array`；
- 同一份字节挂在两个不同基址上 → **一个资产、两条引用**。

## 为什么基址不属于身份

基址是"怎么寻址"，不是"是什么字节"。把它并进 id 会让同一份 dump 在换了基址后变成两个资产，去重与将来的 diff 全部失效。

反过来说，只按 id 去重会丢掉一个合法基址。所以跟随地址列表的键是 `assetId@base`（`BlueprintApp.tsx` 的 `buffers`），而不是单独的 `assetId`。

## 为什么是 FNV-1a 64，不是 SHA-256

`evaluateGraph` 是同步的，被 `BlueprintApp` 的 `useMemo` 直接调用（`BlueprintApp.tsx:223`）。`crypto.subtle.digest` 是异步 API，换它就要把整条求值链路改成 async，波及 `follow.ts`、全部求值用例与 UI 的渲染时机。

这个 id 只回答"同一张图里是不是同一份字节"，不承担安全语义。需要跨机器核对来源时用 SHA-256——那是 pack 导入的信任哈希，发生在本来就异步的 `onOpenDoc` 里，异步没有代价。

64 位用两个 32 位半字实现（`src/bp/assets.ts`），1 MiB 输入约 2–3 ms；用 BigInt 会慢两个数量级，达不到基准里的可接受范围。

## 资产表是运行时的

`AssetTable`（`createAssetTable`）在每次求值时新建，随 `BPResult.assets` 返回。文档格式**没有** `assets[]` 字段：

- `node.source.data` 仍然是内联 base64，旧蓝图与旧缓存可以直接打开；
- 载入时按需解码并登记，不需要用户手工重新载入；
- 导出时仍然内联，保证单文件可移植。

代价：从文档层面看，同一份字节仍可能出现两次（两个 File 节点各存一份 base64）。本阶段保证的是**求值期只有一份 `Uint8Array`**，不是"文件里只有一份"。把字节搬进 IndexedDB 是后续变更。

## 相关字段

| 位置 | 字段 | 含义 |
| --- | --- | --- |
| `BufferValue` | `assetId` | 这份字节的身份 |
| `SourceInfo` | `assetId` | 该节点实际读到的字节身份（与上游 File 一致） |
| `BPResult` | `assets` | 本次求值登记的全部资产 |

## 验证

`tests/assets.test.ts` 覆盖：FNV 公开向量、1 MiB < 10 ms、同名同长不同内容不合并、同内容只留一份字节、同内容不同基址各自保留、继承链与上游共用 id、旧缓存内联字节自动登记。
