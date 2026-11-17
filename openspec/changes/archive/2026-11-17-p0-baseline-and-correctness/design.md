# Design

## Context

求值入口是 `evaluateGraph(nodes, edges, packs, opts)`（`src/bp/eval.ts:416`），它同步返回 `outputs / views / ports / sources / inputs / problems`，被 `BlueprintApp` 的一处 `useMemo` 消费（`BlueprintApp.tsx:223`）。这个"同步、一次算全图"的形态是本设计最强的约束：任何需要异步的能力（如 `crypto.subtle`）都无法进入求值路径。

现状的四个问题点在代码里各有明确落点：

- 判型靠结构：`isInstanceView`（`types.ts:292`）只看 `addr/typeName/fields` 三个字段。
- 缓冲区靠字符串键去重：`${name}:${base}:${length}`（`BlueprintApp.tsx:239`）。
- 来源追溯回调求值：`resolveSource` 内部执行 `evalNode(src)[port]`（`eval.ts:501`），并与求值共用 `stack`。
- 截断靠长度判断：`if (items.length >= max) truncated = true`（`eval.ts:951`），恰好在最后一项结束时也成立。

另外三个与实现方式直接相关的事实：

1. 文档格式把字节内联在节点上（`node.source.data` base64，`persist.ts:74`、`doc.ts:53`），没有独立的资产表。
2. pack 以字符串存在文档里，`loadBlueprintPack` 用 `new Function` + `eval` 执行（`load.ts:170-172`），导入时在 `onOpenDoc` 里立即编译（`BlueprintApp.tsx:1228`）。
3. `evaluateGraph` 已经支持 `disabledPacks`，被禁用的 pack 会让节点进入"已禁用"态而不是消失（`BlueprintApp.tsx:219`、`eval.ts:410` 附近的 `PACK_DISABLED`）。

最后一条决定了授权功能可以复用现有机制，而不必新造状态机。

## Goals / Non-Goals

**Goals:**

- 四种静默错误（伪元素、缓冲区顶替、值/来源依赖混淆、假截断）在**不改变图语义**的前提下变成正确行为或显式告警。
- 资产身份与信任身份分开：前者要同步、快、够用；后者要密码学强度。
- 授权复用既有 `enabled` 语义，不引入第二套开关。
- 所有决策都能被现有 293 条用例回归，新增行为各带用例。

**Non-Goals:**

- 不改 `memlink-blueprint/1` 的字段结构。新增信息只出现在运行时结构或可选的导出元数据里。
- 不改 pack 执行模型（仍是同 realm 的 `new Function`），因此 CSP 保留 `unsafe-eval`。
- 不做 u64/bigint、端口投影、缓存、IndexedDB、CLI——见 proposal 的"不在范围"。

## Decisions

### D1 值类别用 WeakSet 品牌，而不是 Symbol 或私有字段

`InstanceView` 的"真实性"由模块内 `WeakSet` 登记（`types.ts` 内新增 `brandInstance` / `isInstanceView`）。`makeView` 产出时登记；判别时查表。

- **为什么不是 Symbol 品牌**：pack 代码运行在同一 realm，拿到任意一个真实元素后可以用 `Object.getOwnPropertySymbols(el)` 取到品牌符号，再复制到伪造对象上。品牌必须不可被"观察后复制"。
- **为什么不是 `__brand: true` 字段**：同样可复制，且会污染序列化结果。
- **为什么不是类型收窄到构造函数**：`InstanceView` 是纯数据，序列化与跨模块传递都在用它，改成 class 会波及 `views`、`FollowTarget` 与测试夹具。
- **代价**：品牌不可序列化。这是可接受的——`InstanceView` 只存在于运行时，`outputs` 也不落盘。

`isInstanceView` 的签名不变，因此 `follow.ts`、`Inspector.tsx`、`Canvas.tsx` 的调用点不用改。

### D2 资产身份用同步 64 位 FNV-1a，信任身份用 SHA-256

`assetId = "a1:" + fnv1a64(bytes).toString(16).padStart(16, "0")`，按节点 id 缓存，1 MiB 约 2 ms。

- **为什么不用 `crypto.subtle.digest`**：它是异步的，而 `bufferOfFile`（`eval.ts:454`）在同步求值路径里。把 `evaluateGraph` 改成 async 会波及 `useMemo`、`follow.ts` 与全部求值用例，成本远超收益。
- **为什么同步哈希够用**：`assetId` 只用于同一张图内的相等判断，不用于安全。碰撞概率按 64 位、单图几十份 buffer 估算可忽略；且键里同时含长度，实际碰撞面更小。
- **为什么信任用 SHA-256**：pack 哈希要跨机器核对来源，属于安全语义，且发生在导入时（本来就在 async 的 `onOpenDoc` 里），异步没有代价。

### D3 资产表是运行时派生物，文档格式不动

新增 `AssetTable`（`assetId → { bytes, size }`）由求值入口按需从 `node.source` 构建；`BufferValue` 增加 `assetId`，但**保留** `name`、`base`、`bytes` 三个字段以兼容既有读取点。

- **为什么不在文档里加 `assets[]`**：会破坏 `memlink-blueprint/1` 与旧缓存，而 spec 明确要求旧文档直接可用、导出仍内联。
- **关键取舍：基址不属于资产身份**。同一份字节挂在两个不同 `base` 上时，`assetId` 相同而引用不同。因此跟随地址列表按 `assetId@base` 去重，而不是只按 `assetId`——否则会丢掉一个合法基址。这条直接替换 `BlueprintApp.tsx:239` 的字符串键。
- **复制节点不复制字节**：`source.data` 本来就在文档里跟着节点走，本阶段无法避免。D3 保证的是"求值期只有一份 `Uint8Array`"，而不是"文档里只有一份"。

### D4 数据源解析改为两阶段：静态分类 + 预先求来源

在求值前跑一遍 `resolveAllSources`，只读图结构、节点参数与资产表；`evalNode` 不再被来源追溯调用。

分类规则（不需要求值即可判定）：

| 数据源线的上游端口静态类型 | 依赖性质 | 解析方式 |
| --- | --- | --- |
| `text` / `bytes` / `buffer` | 值依赖 | 求值该上游端口，基址 0；由求值状态机判环 |
| 其它（`number` / `instance` / 无端口） | 来源依赖 | 沿上游节点的来源链走，基址 0 |

- **为什么按静态端口类型而不是看返回值的运行时形状**：现在的 `valueAsBuffer`（`eval.ts:93`）是在求值后判型，这正是耦合的来源。`portsFor` 已经能给出端口类型（`eval.ts:278`），判定不需要执行代码。
- **为什么值依赖仍允许求值**：spec 明确保留这个例外——用户接一段文本就是要读它。区别在于这条依赖现在登记为值依赖，环检测交给 `state` 状态机，而不是与来源遍历共用 `stack`。
- **来源环怎么办**：`resolveAllSources` 有自己的访问集，遇到来源环时返回 `mode: 'none'` 并置 `sourceCycle: true`，报新原因码 `SOURCE_CYCLE`。这样 spec 里"不产生 `CYCLE`"成立，同时真的成环也不会静默变成"没有数据源"。
- **为什么预先算全图而不是惰性缓存**：来源信息现在与求值顺序无关，一次 O(V+E) 的遍历比"边求值边补缓存"更容易验证，也让 `sources` 在节点求值失败时依然完整。

### D5 截断由循环是否走完判定，并携带可继续位置

列表分支改为 `let i = 0; for (; i < max; i++) {...}`，循环结束后 `truncated = i === max`。新增 `Truncation { limit, at, unit: 'index' | 'address', canContinue }`：

- 列表：`at` 是**尚未访问的下一项地址**（最后一次 `next()` 的返回值），`unit: 'address'`。
- 数组：`at` 是**未读到的元素下标**，`unit: 'index'`。
- `canContinue = truncated && !cycle && !error`。

- **为什么不"多探测一次 `next()`"**：`next()` 是 pack 代码，可能抛错、可能读到越界地址；为了判定是否结束而多跑一次用户代码，会把"恰好结束"变成一个可能失败的路径。用下标判定零副作用。
- **为什么区分 `unit`**：两者数值含义不同，UI 与将来的 CLI 要能正确显示"从 0x1a40 继续"还是"从第 256 项继续"。

### D6 问题条目加字段，`detail` 保留一版

`Problem` 增加 `code: ProblemCode`、`nodeId?`、`port?`、`addr?`、`fix?: { label: string; kind: string }`；`detail` 继续写入，但不再把原因码拼进字符串（当前 `eval.ts:449` 的 `${code} · ${detail}` 要去掉）。

- **为什么保留 `detail`**：`Inspector` 与 `persist.ts` 的告警展示都在读它，一次性删掉会同时改三处展示逻辑。保留一版，展示改读 `code`，下个变更删。
- **为什么不新建 `BPProblem` 类型**：`Problem` 已被 `core` 与 `bp` 共用，另起类型要做并集与转换，收益只是"不动老代码"。

### D7 CSP 是强制层，网络守卫是归因层

生产构建在 `index.html` 注入 `Content-Security-Policy` meta：`default-src 'self'; connect-src 'none'; img-src 'self' data:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'`。同时在编译 pack 前把 `fetch` / `XMLHttpRequest` / `WebSocket` 替换为抛出带标记错误的桩，`evalBody` 的 catch 把该标记映射为 `NO_NETWORK`。

- **两层各管一件事**：CSP 保证"发不出去"（即使守卫被绕过），守卫保证"知道是谁发的"——纯 CSP 只能给一个 `TypeError: Failed to fetch`，无法定位到节点。
- **dev 与 prod 必须不同**：Vite HMR 需要 `ws:`，所以 dev 的 CSP 放开 `connect-src` 到 localhost，prod 收紧为 `'none'`。"零网络"只在生产构建上断言，验证任务必须跑 `pnpm build && pnpm preview`。
- **为什么保留 `unsafe-eval`**：pack 执行模型本阶段不改。CSP 的价值在于把"网络"这一维先关死，而不是假装代码隔离已经做完。

### D8 授权 = 启用，复用 `enabled`，不新增状态

`onOpenDoc` 改为：`parseDoc` → 计算每个 pack 的 SHA-256 → 展示清单（名称、节点数、哈希前 12 位）→ 默认全部不勾选 → 仅对勾选项调用 `loadBlueprintPack`，其余以 `enabled: false` 进入文档。

- **为什么复用 `enabled`**：`disabledPacks` 已经让节点显示"已禁用"且不求值（`BlueprintApp.tsx:219`），这正是 spec 要求的"图结构可见、节点标记未启用、代码不执行"。新增 `authorized` 字段会让两个开关产生四种组合，语义无法解释。
- **为什么默认不勾选**：默认全选等于一次回车就执行全部代码，门形同虚设。
- **哈希不符时**：视为未授权，重新弹清单。草图里记录的哈希来自导出元数据，与当前源码不符说明文件被改过。
- **未启用 pack 的节点不应报错**：它们应停在 `PACK_DISABLED` 的提示态，而不是满屏 `UNKNOWN_NODE`。

## Risks / Trade-offs

- **收紧判型会让既有 pack 从"能用"变"告警"** → 先跑 293 条用例与 `samples/`，把降级范围限定在"形状像元素但品牌缺失"的对象；真实元素路径不改。逐个确认告警是误报还是真 bug，不为了绿而放宽。
- **FNV-1a 碰撞** → 键含长度；`assetId` 只用于同图相等判断；碰撞表现为跟随列表少一条，不会读错字节（字节仍来自各自 `BufferValue`）。
- **静态端口分类对动态端口不精确** → `elem:N` 这类动态端口类型为 `instance`，会走来源链而不是值依赖，与当前行为一致；只是不再为了判型而求值上游。
- **CSP 可能让既有功能静默失败**（如 `data:` 图片、内联字体）→ 上线前用生产构建跑完整手工清单；CSP 写在 meta 里，回退是删一行。
- **授权弹窗被无脑通过** → 清单默认不勾选、显示哈希前缀、来源未知的 pack 单独标红；不追求"防住不看的人"，只保证"不看就不会执行"。
- **两阶段来源解析改变 `sources` 的填充时机** → 节点求值失败时 `sources` 仍有值，这与当前"先 `sourceOf` 后 `evalBody`"的顺序一致（`eval.ts:609`），用例应覆盖求值抛错后仍能显示数据源。

## Migration Plan

1. 工程底盘（git、CI、lint、基准）先落地，后续每一步都有回滚点与度量。
2. 值品牌 → 资产 → 来源解耦 → 截断 → 问题结构，按此顺序。问题结构放最后，因为它要收口前面新增的原因码。
3. CSP 与导入授权最后上：它们会暴露既有失败（dev 的 ws、`data:` 资源），放在语义修复之后才能区分"新问题"与"暴露的老问题"。
4. 回滚：每个决策是独立提交，可单独 revert；`detail` 兼容层保证展示层不必同步回退；CSP 是 `index.html` 的单行 meta。

## Open Questions

- 授权清单是否需要在会话之间记住"这个哈希我已信任"？本阶段按"每次打开都问"实现，持久化信任库留待有真实用户反馈后决定——不影响 specs 与任务拆分。
- 导出元数据（pack 哈希清单）放在 `memlink-blueprint/1` 的同级字段还是 `meta` 子对象？两者都不影响现有解析（`parseDoc` 只读已知字段），实现时按"最小侵入"选同级可选字段。
