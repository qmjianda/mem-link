# mem-link 内存数据模型审阅

> 范围：`src/` 全部运行时数据结构（节点、边、端口、值、缓存、索引、问题、选择、历史、持久化）。
> 方法：逐个读取 `bp/types.ts`、`bp/docstate.ts`、`bp/eval.ts`、`bp/history.ts`、`bp/selection.ts`、`bp/persist.ts`、`core/*`、`v2/*`，沿真实调用路径追踪持有者与失效点。
>
> **历史文档（2026-11-17 注）**：v1 / v2 两代入口与 `v2/*`、`core/{cparse,edit,expr,graph,project,program,packedit}` 已删除。下文涉及这些路径的定位仅作当时记录；与蓝图编辑器（`src/bp`）相关的结论仍然有效。
> 结论只针对"数据怎么组织"，不涉及视觉设计；文末单列一小节说明数据变更对 UI 的直接影响。

---

## 0. 结论速览

| 维度 | 评分 | 依据 |
| --- | --- | --- |
| 领域建模（自然性） | **A** | "图 = 寻址 + 展开 + 校验"的切分是对的；数据源继承、元素端口、断链不中断求值，都是真实逆向工作流的形状 |
| 写路径（一致性） | **A-** | `commit()` 是唯一写入口，历史按引用共享数组，`sameDoc` 用引用比较短路，这一层非常干净 |
| 运行时契约（稳健性） | **B-** | 值域无标签、64 位地址丢精度、buffer 三份身份、求值器重入，都是会产出**错误结果**而非报错的问题 |
| 结构与冗余（简洁性） | **B-** | 同一份解码结果存在 3 处；同一"字段"有 2 套类型；同一"节点"有 3 个概念 |
| 可演进性 | **C+** | 无节点级缓存、无派生索引、无资产抽象；加数据源、CLI、AI 时成本会按平方放大 |

五条核心判断：

1. **最该修的不是"结构乱"，而是"值没有类型"**。`isInstanceView` 靠 `addr + typeName + fields` 三个字段做鸭子判型（`types.ts:292`），而 `calcNode` 允许返回任意对象——一个恰好带这三个键的计算结果会被当成元素，后续取 `addr` 去解码，**错得悄无声息**。

2. **同一份数据被复制了三遍**：`EntryView.raw/value` → `InstanceView.fields[]`（含预格式化的 `display`/`rawDisplay`）→ `out[f.name]` 字典。一个 4096 项的链表节点、每项 10 个字段，每次求值会产生约 8 万个字符串，只为渲染 8 行（`Canvas.tsx:148` 只显示 8 个元素端口）。

3. **引擎在替渲染层买单**。`dynamicOf()` 无条件生成最多 4096 个端口对象和一份 `values` 字典（`eval.ts:134-176`），而画布有 LOD、有折叠、只画 8 个。求值层不应该知道"可见性"。

4. **求值器把"数据源追溯"和"值求值"塞进了同一套 memo**。`resolveSource` 里直接 `evalNode(src)` 取端口值（`eval.ts:494`），而 `evalNode` 用 `state: 0/1/2` 判环。两种依赖方向共用一个状态机，合法的图也可能被判成环并返回空对象。

5. **可演进性缺口集中在三处**：没有节点级缓存（每次都全量重算）、没有持久索引（UI 到处 `nodes.find`）、没有资产抽象（字节藏在 `node.source.data` 的 base64 里，跟着历史与副本一起流动）。

---

## 1. 现状地图

### 1.1 对象清单与持有者

| 对象 | 定义位置 | 职责 | 生命周期 | 持有者 |
| --- | --- | --- | --- | --- |
| `DocState` | `docstate.ts:31` | 文档真相：packs / nodes / edges | 随 commit 替换，历史 100 步 | `BlueprintApp.doc` + `history.entries[].doc` |
| `LoadedPack` | `docstate.ts:12` | `source`（可序列化）+ `pack`（含闭包）+ `enabled` | 与文档同寿 | `DocState.packs` |
| `BPNode` | `types.ts:111` | 图节点实例：id / packId / nodeId / 坐标 / `params` / `portMode` / `source` | 随文档 | `DocState.nodes` |
| `BPEdge` | `types.ts:162` | 有向边：`from{node,port}` → `to{node,port}` | 随文档 | `DocState.edges` |
| `StoredMemory` | `types.ts:168` | File 节点的字节（**base64 字符串**）+ base | 随文档，可被裁剪 | `BPNode.source` |
| `BufferValue` | `types.ts:184` | 运行时缓冲：name / base / bytes | 单次求值（每次重建） | `BPResult.outputs`、`SourceInfo.buffer` |
| `PortSpec` | `types.ts:20` | 端口声明：名 / 类型 / label / `dynamic` / `context` | 每次 `portsFor` 重建 | `BPResult.ports` |
| `NodeView` | `types.ts:260` | 画布内绘制内容（7 种 kind 的联合） | 单次求值 | `BPResult.views` |
| `InstanceView` | `types.ts:205` | 解码后实例：addr / typeName / **fields[]（含显示串）** / mem | 单次求值 | view、`out`、元素端口值 |
| `SourceInfo` | `types.ts:216` | 数据源解析结果：6 种 mode + 4 个标志 + chain | 单次求值 | `BPResult.sources` |
| `InputValue` | `types.ts:245` | 输入端口实际收到的值 + 显示串 + 回退文本 | 单次求值 | `BPResult.inputs` |
| `Problem` | `core/types.ts:155` | 问题条目：severity / nodeKey / message / **detail（字符串里塞码）** | 单次求值 | `BPResult.problems` |
| `SelectionState` | `selection.ts:20` | 集合 + `primary` + `entry` | UI 态，不入历史 | `BlueprintApp.selection` |
| `HistoryState` | `history.ts:22` | base + entries[] + cursor + savedCursor + lastMerge | 会话 | `BlueprintApp.history` |
| `NavState` | `navhistory.ts:17` | 40 步视口 + 选择快照 | 会话 | `BlueprintApp.nav` |
| `GraphNode` | `core/types.ts:117` | **v1/v2 路线的求值产物**（也是一种"节点"） | 单次 build | `App.computed` |
| `Project` | `core/types.ts:101` | **v1/v2 路线的文档**（含 C 源码 + pools + links） | 会话 | `App.project` |

### 1.2 一次交互的访问路径

以"在检查器里悬停一个字段、看它高亮字节"为例：

```
Inspector(selection.kind==='node')
  → nodes.find(n => n.id === selection.id)        // O(n)，每次渲染都做
  → result.views.get(node.id)                     // 单次求值的 Map
  → view.inst.fields.find(f => f.offset 覆盖目标) // O(fields)
  → 计算 [addr, addr+size) 传给 HexView
HexView 再从 result.sources.get(node.id)?.buffer 取 bytes
```

问题不在链路长，而在于**每一跳都在重新查找已经存在的关系**：`nodes.find` 出现了 6 次以上（`Inspector.tsx:421,423,428,555,558`），其中一处还在 `map` 里对来源链逐项 `find` —— O(链长 × 节点数)。

### 1.3 数据在四个阶段之间的流转

```
        ┌─────────────── Document（JSON）───────────────┐
        │ nodes[].source.data = base64  ← 字节藏在这里   │
        └───────────────┬───────────────────────────────┘
                        │ evaluateGraph(nodes, edges, packsMap)
                        ▼
   ┌──────────── Evaluation（不可序列化，每次全量重建）────────────┐
   │ outputs / views / ports / sources / inputs / problems / ms    │
   │  ↑ 同一份解码结果在 outputs、views、dynamicOf 之间各存一份     │
   └───────────────┬───────────────────────────────────────────────┘
                   │ 每个组件按 id 再查一次
                   ▼
        ┌──────── Presentation（Canvas / Inspector / HexView）┐
        │ nodes.find、views.get、ports.get、sources.get …      │
        └──────────────────────────────────────────────────────┘
                   │ 800ms 防抖
                   ▼
        ┌──────── Persistence（localStorage，2MB 上限）────────┐
        │ 超限时把 data 置空 → 内存文档与磁盘副本不一致         │
        └──────────────────────────────────────────────────────┘
```

---

## 2. 四个维度的具体评估

### 2.1 稳健性：边界处理认真，但"错值"比"报错"多

做得好的地方（不要改）：

- 越界读取一律抛错并被 `catch` 成 `OUT_OF_BOUNDS`（`eval.ts:977`）。
- 链表有 `seen` 集合防环、有 `max` 硬上限、断链时 `valid=false` 但仍给真实读值（`eval.ts:911-937`）。
- 数据源冲突有专门检测，并列出候选文件名（`eval.ts:540-552`）。
- 旧内置节点有统一迁移入口，缓存与打开图两处共用（`types.ts:134`，`doc.ts:66`，`persist.ts:147`）。
- 缓存损坏/版本不符会整体丢弃并提示，不会带着坏数据继续跑（`persist.ts:107-151`）。

会产出错误结果的地方（优先级最高）：

| 编号 | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| D1 | 值域无标签，靠鸭子类型判型 | `types.ts:292-297`；`eval.ts:73-80` | `calcNode` 返回 `{addr, typeName, fields}` 形状的对象 → 被当成元素 → 用错地址继续解码 |
| D2 | 64 位地址/数值走 `Number` | `mem.ts:26`（逐字节乘加）、`packgraph.ts:68/72`（`Number(big)`）、`eval.ts:368` | > 2^53 的地址与 u64 值静默丢精度；内核/游戏 VA 场景直接不可用 |
| D3 | 同一个文件存在三份缓冲区身份，去重靠 `name:base:length` | `eval.ts:446-463`、`eval.ts:711-716`、`BlueprintApp.tsx:233-245` | 同名同长不同内容的两个 dump 被判为同一个；"跟随地址"下拉选错文件 |
| D4 | 数据源追溯与值求值共用 `state` memo | `eval.ts:473-570`（`trace`）→ `eval.ts:494`（`evalNode(src)`）→ `eval.ts:584-590`（state=1 报环） | 合法图被判 `CYCLE`，上游输出被当成 `{}`，下游静默拿到空值 |
| D5 | 解码时按名字线性查类型 | `packgraph.ts:94,100`（`pack.types.find`） | 嵌套 record/array 每字段一次线性扫描；pack 大了退化明显 |

### 2.2 一致性：写路径很干净，读路径有三套索引

**干净的部分**：`commit(updater, label, mergeKey)` 一次产出完整新文档（`BlueprintApp.tsx:268-279`），未改动的数组按引用复用；`sameDoc` 用引用相等判断"没变"（`docstate.ts:40`）；历史存的是"每次提交后的整份文档"，撤销只移游标（`history.ts:4-6`）。这是教科书式的做法，也是 100 步历史不复制 base64 的原因。

**不一致的地方**：

| 编号 | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| D6 | 同一个 pack 集合派生出三个 Map：`packsMap`（仅启用）/ `allPacks`（全量）/ `packNames` | `BlueprintApp.tsx:217-222` | 求值用 `packsMap`、标签用 `allPacks`、状态栏用 `packNames`；任一处用错就是"禁用的 pack 还能解析"这类 bug |
| D7 | `Problem` 的结构化码被拼进字符串 | `eval.ts:442`：`detail: `${code} · ${detail}`` | UI 要 `split`、无法统计、无法一键修复；`ProblemCode` 类型形同注释 |
| D8 | 选择有双重表示，且 `primary` 不变量可被破坏 | ~~`selection.ts:77-88` 删除 edge 后 `primary=null`~~ **已修**：`selection.ts:110-126` 的 `retainSelection` 在提交、撤销/重做、删除与 pack 操作后把 `primary` 收敛到仍存在的对象（5 处调用点，见 `BlueprintApp.tsx:289/324/1041/1166/1178`） | 残留风险：`primary` 仍是存储字段而非派生，新增变更路径若忘记调用 `retainSelection` 会再次破坏不变量 |
| D9 | `params` 是 `Record<string,string>`，且混入魔法键 | `types.ts:119-124`（`__title`）、`eval.ts:516`（`sourceId`） | 拼错键名静默变 `undefined` → 落到默认值；"显式清空"与"未设置"无法区分；迁移只能手写分支 |
| D10 | 端口名即协议，解析逻辑分散 | `eval.ts:42-44`（`elem:`）、`eval.ts:141/162/168`（三种拼接）、`Canvas.tsx:197-200`（只认 `^elem:(\d+)$`） | `elem:field:3` 这类端口在画布上取不到 index；新增端口形态要改三处 |
| D11 | 三套并行的图模型 | `core/types.ts:117`（GraphNode）、`bp/types.ts:111`（BPNode）、`App.tsx`（Project + positions + frozen + undoRef） | 概念同名不同义；v1/v2 的 undo 是 `Memory[]` 快照，v3 是文档快照，两套语义并存 |

### 2.3 自然性：心智模型对，命名不对

最值得保留的是**职责切分**：图控制"去哪里解析"，schema 控制"长什么样"，校验节点控制"对不对"。这比 ComfyUI 的"万物皆节点"更贴合逆向，也是图规模能压住的原因。

问题在命名与"值"的地位：

- **三种东西都叫 node**：`BPNode`（图上实例）、`NodeDef`（pack 内定义）、`GraphNode`（v2 求值产物）。阅读时必须在脑中做三次映射。
- **`packId === ''` 当内置哨兵**（`types.ts:113`）：空字符串承担了一个枚举的职责，所有分支都要 `if (node.packId === '')`。
- **值没有身份**：`instance` 值携带整个 `fields[]` 数组和一个 `mem` 引用（`types.ts:205-213`）。这意味着"一个元素"在内存里是一棵完整的树，跨节点传递时被复制引用、被重复格式化；而它本可以只是 `(assetId, typeName, addr)` 三个标量。
- **`raw` 与 `value` 成对出现但没有统一抽象**：`FieldView` 同时存 `raw`、`value`、`rawDisplay`、`display`，而 `display` 又是拼出来的字符串（`eval.ts:348-361`）。显示逻辑（`formatPackValue`）因此被固定在求值阶段，无法按主题/宽度/语言重排。

### 2.4 简洁性：不是"代码多"，而是"同一件事说三遍"

| 概念 | 说了几遍 | 位置 |
| --- | --- | --- |
| 解码后的字段值 | 3 遍：`entry.raw/value` → `InstanceView.fields` → `out[f]` | `eval.ts:318-341`、`344-363`、`867` |
| 端口列表 | 2-4 遍：`portsFor` 在 `evalBody`、`evalNode`、`carriesContext`、`Canvas.metaFor` 各调一次 | `eval.ts:198`、`601`、`462`；`Canvas.tsx:209` |
| "这个节点用哪个文件" | 2 遍：`SourceInfo.buffer` 与 `outputs['buffer']` | `eval.ts:713`、`602-603` |
| 字段类型 | 2 套：`FieldDef`（pack 声明）与 `Field`+`CType`（C 解析） | `core/pack.ts:79`、`core/types.ts:34` |
| 节点概念 | 3 套 | 见 2.3 |

**"重复"的代价不是行数，是不变量无处安放**：当同一份值有三个副本，就没有一个地方能保证"它们一致"；只能靠每条写入路径自觉同步。

---

## 3. 问题清单（按严重度）

### P0 — 会算错，且不报错

**D1 值域打标签**
- 现状：`isInstanceView` 鸭子判型；`portTypeOf` 用 `typeof` 猜端口类型（`eval.ts:73-80`）。
- 建议：值统一为判别联合（见 §4 `Value`），或至少给 instance 加不可伪造的 `__kind: 'instance'`。`calcNode` 的返回值在发布前过一遍 `normalizeValue`，非白名单形状一律降级为 `{t:'json'}` 并告警。

**D2 地址与 64 位数值**
- 现状：`Memory.readUInt` 用 `v * 256 + byte` 累加（`mem.ts:26`），`readBig` 有 bigint 通道但 u64 解码立刻 `Number()`（`packgraph.ts:68`）；`toNumber` 全线 number。
- 建议：引入 `Addr = number | bigint` 双通道。规则：**指针、地址、u64/i64 字段一律 bigint；端口值可以是 `{t:'big'}`；显示层格式化；只有进入渲染/坐标计算时才降级并检查 `<= 2^53`**。这是唯一需要"改类型签名"的改动，越早越便宜。

**D3 缓冲区身份**
- 现状：`fileBuffers`（Map，每次求值）、`out['buffer']`（新对象）、`buffers` 派生列表（按 `name:base:length` 去重）三处各有一份。
- 建议：资产层（§4 `AssetStore`）给出唯一 `AssetId`，所有地方传 id 不传对象；去重按内容哈希。

**D4 求值重入**
- 现状：`resolveSource` 的 wire 分支里 `evalNode(src)(port)`，与 `evalNode` 的 `state` 状态机互相干扰。
- 建议：把"来源解析"降级为**只读图结构 + 资产表**的纯函数，不求值任何上游节点；唯一例外（字符串/bytes 直接当数据源）改为在 `evalBody` 阶段已算出的输入值上读取，或显式声明该端口为 `value-as-buffer` 类型。

**D5 类型索引**
- 现状：`compatPack()` 每次节点求值都 `Object.values(pack.types)` 建数组（`eval.ts:293`），`decodeRecord` 再 `find`（`packgraph.ts:94`）。
- 建议：编译期产出 `Map<string, TypeDef>`，`compatPack` 删除；嵌套解码用 map 查找。

### P1 — 一致性与可维护性

**D6 三个 pack Map**：合并为 `PackRegistry { all: Map, enabled: Set }`，所有消费点读同一个对象。

**D7 Problem 结构化**：`{ code, severity, at:{node,port?,addr?}, message, detail?, fix? }`。`fix` 直接携带一条命令（"断开这条线"/"给该 File 载入文件"），把现有的文字建议变成可执行入口。

**D8 选择**（部分已修）：`primary` 已由 `retainSelection` 在每次文档变更后规范化，删除/撤销不再出现"集合非空但 primary 为空"。**仍需做**的是把它改成**派生**（`primaryOf(state)`：优先 entry，其次唯一选中项），从根上消除"忘记调用就破不变量"的可能。

**D9 params**：`config: Record<string, Json>` + `meta { title?, sourcePin? }` 分离；每个节点定义声明 `paramSchema`（type/default/validate），加载时校验、Inspector 自动生成表单。序列化格式向后兼容（读旧 `params` 时按 schema 迁移）。

**D10 端口引用**：`PortKey = { node: NodeId; dir: 'in'|'out'; name: string; path?: (string|number)[] }`，或用规范化的 `elem/0`、`elem/field/2` 字符串 + **唯一解析函数**。`Canvas`、`eval`、`follow` 共用它。

**D11 三套模型**：明确 v1/v2 冻结（只修 bug，不再加功能），把 `Memory`、`decodeRecord`、`format` 抽成共用内核；v2 的 `positions` 不要再和文档分离（它已经是"第二份坐标真相"）。

### P2 — 性能与边界

**D12 求值为渲染买单**：`dynamicOf` 生成 4096 端口 + values；`makeView` 预格式化全部字段。建议：求值只产出 `RecordView[]`；端口由 `portsOf(node, eval, visibleRange)` 投影，画布只请求可见 + 已连线的；`display` 改为惰性 getter。

**D13 `portsFor` 在 `carriesContext` 里被反复调用**（`eval.ts:462`，在 `trace` 的递归里），复杂度 O(V·E·fields)。建议单次求值内缓存 `Map<nodeId, PortSpec[]>`。

**D14 阈值散落**：`4096` 出现 4 次（`eval.ts:46,899,913`；`builtins.ts:429`），`256` 出现 3 次（`eval.ts:161`；`core/graph.ts:128`；`cstr` 默认值）。建议 `LIMITS = { listItems, arrayItems, elementPorts, nestedMembers, readBytes }` 单点定义，每处截断返回 `{ limit, at, canContinue }`。

**D15 截断误报**：`if (items.length >= max) truncated = true`（`eval.ts:939`）——恰好 `max` 项且链在此结束时会误报"已截断"。应区分"达到上限"与"因上限停止"。

**D16 持久化裁剪**：`trimForQuota` 作用于副本（正确），但重载后 buffer 消失只剩一次性 toast（`BlueprintApp.tsx:344-347`）。建议把"待重新载入的资产"做成持久化列表，UI 常驻提示。

---

## 4. 目标数据模型

核心原则：**四层单向依赖，每层只允许依赖下一层；文档层只含 JSON；字节只有一个容器；值带标签且轻量。**

```
① Document（可序列化，进历史/持久化）
      ↓ 只读
② AssetStore（字节，不进历史，引用计数）
      ↓ 只读
③ CompiledPack（源码哈希 → 不可变 IR）
      ↓ 只读
④ Evaluation（按签名缓存，可整体丢弃）
      ↓ 投影
⑤ Presentation（端口、行、覆盖率；不落库）
```

### 4.1 类型草案（规格，不是实现）

```ts
/* ① 文档层：只有 JSON 值，没有函数、Map、Set、Uint8Array */
interface Document {
  readonly rev: number;              // 每次 commit +1，用于派生索引失效
  nodes: NodeInstance[];
  edges: Edge[];
  packs: PackSource[];               // { id, name, source, sourceHash }
  assets: AssetRef[];                // 只存引用，不存字节
}

interface NodeInstance {
  id: NodeId;                        // 'n123'，全局单调
  kind: 'builtin' | 'pack';          // 取代 packId === '' 哨兵
  type: { pack: PackId | null; node: string };
  at: { x: number; y: number };
  config: Record<string, Json>;      // 用户参数，无魔法键
  meta?: { title?: string };
  sourcePin?: AssetId;               // 取代 params.sourceId
  portMode?: 'value' | 'raw';
}

interface AssetRef { id: AssetId; name: string; base: number; hash: string; length: number }

/* ② 资产层：字节的唯一容器 */
interface Asset {
  id: AssetId;
  bytes: Uint8Array;
  hash: string;                      // 内容哈希，去重与 diff 都用它
  origin: 'file' | 'inline' | 'derived' | 'slice';
}
interface AssetStore {
  put(bytes: Uint8Array, name: string, base: number, origin: Asset['origin']): AssetId;
  get(id: AssetId): Asset | undefined;
  retain(id: AssetId): void;         // 引用计数，0 时延迟回收
}

/* ③ 编译层：不可变 IR */
interface CompiledPack {
  sourceHash: string;
  endian: Endian;
  pointerSize: 4 | 8;
  constants: Readonly<Record<string, number>>;
  types: ReadonlyMap<string, TypeDef>;   // 关键：Map，不是数组
  nodes: ReadonlyMap<string, NodeDef>;
  paramSchema: ReadonlyMap<string, ParamSchema>;
}

/* ④ 求值层：按依赖签名缓存 */
interface Evaluation {
  rev: number;                       // docRev + assetRev + packRev
  node: Map<NodeId, NodeEvaluation>;
  problems: Problem[];
  coverage: { described: number; total: number };   // 覆盖率：解释了多少字节
}

interface NodeEvaluation {
  sig: string;                       // 依赖签名（见 4.3）
  values: Record<string, Value>;
  record?: RecordView;               // 唯一一份解码产物
  source: SourceResolution;
  problems: Problem[];
  ms: number;
}

/* ⑤ 值：带标签、轻量 */
type Value =
  | { t: 'null' }
  | { t: 'num'; v: number }
  | { t: 'big'; v: bigint }
  | { t: 'str'; v: string }
  | { t: 'bytes'; v: Uint8Array }
  | { t: 'bool'; v: boolean }
  | { t: 'record'; ref: RecordRef }
  | { t: 'list'; of: Value['t']; refs: RecordRef[] };

interface RecordRef { asset: AssetId; type: string; addr: Addr; size: number }
```

**关键收益**：`RecordRef` 只有 4 个标量。一个元素从"整棵树 + 一个 Memory 引用"变成"三个 id + 一个地址"，可以自由跨节点传递、参与 diff、进缓存、序列化。字段值按 `(asset, type, addr)` 在 `Evaluation` 里惰性取。

### 4.2 数据源解析收敛

现在的 `SourceInfo` 是 6 种 mode × 2 个 missing 标志 + conflict + candidates，状态空间 24+。改为"结果 + 单一原因"：

```ts
interface SourceResolution {
  asset?: AssetId;
  base?: number;
  length?: number;
  origin: 'self' | 'wire' | 'pinned' | 'inherited' | 'default';
  chain: NodeId[];
  issue?: 'wire-empty' | 'pin-empty' | 'no-file' | 'upstream-conflict';
  candidates?: AssetId[];            // 仅 issue === 'upstream-conflict'
}
```

不变量：`issue` 存在 ⇒ `asset` 只在 `origin !== 'wire' && origin !== 'pinned'` 时允许存在（即"线接了但没有内容"必须表现为无 asset，而不是悄悄回退）。这条不变量现在只写在注释里（`eval.ts:486-489`），改后由类型强制。

### 4.3 依赖签名

```
sig(node) = hash(
  node.type + node.config + node.portMode        // 自身
  + sorted(inEdges.map(e => e.from.node + ':' + result(e.from).sig))  // 上游签名（祖先链）
  + assetRevision(source.asset)                  // 字节版本
  + packRevision(node.type.pack)                 // 定义版本
)
```

要点：

- 用**祖先链签名**而不是节点 id，改一个常量只重算下游（对应 ComfyUI 的 `CacheKeySetInputSignature`）。
- 决定端口集合的标量（list 的 `count`、array 的 `count`、struct 的 `typeName`）进入 `sig`；**元素的值不进**。这样"改一个字段值"不会让端口集合抖动、不会让已连线的 `elem:3` 失效。
- 缓存条目可整体丢弃（`Evaluation` 是纯派生），不参与持久化。

### 4.4 派生索引（按 `doc.rev` 失效）

| 索引 | 用途 | 现在谁在重复建 |
| --- | --- | --- |
| `nodeById` | 所有 UI 查找 | `Inspector` 的 6 处 `find` |
| `inByNode` / `outByNode` | 求值、画布连线、布局 | `evaluateGraph` 每次、`autolayout` 每次 |
| `edgeByInputPort` | 输入去重（一个输入只能接一条） | 现在靠 `incoming.set` 覆盖，无校验 |
| `typeIndex` | 类型查找 | `packgraph` 的 `find`、`findTypeByName` 的全 pack 扫描 |
| `assetUsage` | 引用计数与回收 | 不存在 |

索引是**只读派生**，可以懒建、可以整体丢弃；不要放进 `DocState`，否则历史会跟着变重。

### 4.5 生命周期

| 阶段 | 触发 | 变化 |
| --- | --- | --- |
| 创建节点 | 拖放/粘贴/跟随地址 | 新增 `NodeInstance`（无 runtime 字段）；`rev+1` |
| 求值 | `rev` / asset / pack 变化 | 旧 `Evaluation` 失效；逐节点比对 `sig`，命中则复用 |
| 渲染 | 视口/选择变化 | 只投影可见节点的 `PortProjection` 与行数据 |
| 持久化 | 800ms 防抖 | `Document` 序列化；`AssetStore` 走独立通道（见 5.1） |
| 历史 | 每次 commit | 新 `Document` 入栈（结构共享）；`AssetStore` 不变 |
| 删除 | 删除节点/清空 | `release(assetId)`，计数为 0 时回收 |

---

## 5. 六项改造方案

按"收益 ÷ 风险"排序。每项都能独立合入，不需要一次性重写。

### 5.1 资产外置（AssetStore）

- **做法**：`node.source` 从"内联 base64"改为 `AssetRef`；字节进 `AssetStore`。持久化分两条：小文件内联（保持单文件可移植），大文件进 IndexedDB（内存文档不变）。
- **收益**：历史不再持有大对象；复制粘贴零拷贝；diff/去重有内容哈希；持久化 2MB 上限与"内网单文件"定位解耦。
- **代价**：多一个模块 + 一次格式迁移（旧 `source.data` 读入时进 store，写出时按大小选择内联或外置）。
- **验收**：100 步历史内存增量 < 1MB；同一文件粘贴 10 次不产生 10 份字节。

### 5.2 编译层单一 IR

- **做法**：`loadBlueprintPack` 产出 `CompiledPack`（types 用 `Map`）；删除 `compatPack` 与 `pack.types.find`；`FieldDef` 与 `RecordDecl` 合并为唯一的 `FieldDef`（`CType` 降级为 `FieldDef.kind` 的一种输入方言）。
- **收益**：删掉两层适配；`union` 等语义不再双轨；嵌套解码从 O(fields×types) 降到 O(1) 查找。
- **代价**：v1/v2 的 C 解析器要改为"产出 `FieldDef`"，但可以保留适配器过渡。
- **验收**：同一 pack 的解码结果与改前逐字节一致（用现有 NVMe 示例做快照测试）。

### 5.3 节点级 memo + 依赖签名

- **做法**：`Evaluation.node` 按 `sig` 复用；`sig` 用祖先链哈希；buffer 用 `assetRevision`（每次写入 +1）。
- **收益**：改常量/改地址只重算下游；拖动节点不再触发全图解码（现在靠"拖动不 commit"绕开，属于用流程规避架构问题）。
- **代价**：签名正确性是唯一高风险点——漏一个输入就会读到旧值。必须配"金标准测试"：对每个内置节点构造"改 X 应重算/不应重算"的用例。
- **验收**：改单个常量 P95 < 50ms；`evalRuns` 在拖动期为 0（保留现有钩子）。

### 5.4 值轻量化 + 记录按需

- **做法**：`Value` 带标签；`instance` 变 `RecordRef`；`RecordView` 只存在 `Evaluation` 里，字段按 `(asset,type,addr)` 取；`display` 改惰性。
- **收益**：值可跨节点共享、可缓存、可序列化；4096 项链表的求值内存与字符串分配下降一个量级。
- **代价**：所有消费 `instance` 的点（Canvas、Inspector、follow、compare 节点）改取值方式。
- **验收**：`makeView` 的字符串分配下降 > 60%（用 `performance.measureUserAgentSpecificMemory` 或简单计数）。

### 5.5 端口投影下沉 + 单解析器

- **做法**：求值产出 `items`/`fields`；`portsOf(node, eval, { visible, wired })` 由展示层调用；`PortKey` 规范化为 `elem/0`、`elem/field/2`，一个解析函数三处共用。
- **收益**：求值不再为渲染买单；端口不再随值抖动；`elem:field:3` 这类端口在画布上能正确取 index。
- **代价**：Canvas 需要按需请求端口（有 LOD，天然适合）。
- **验收**：500 节点图首次求值 < 300ms；`PORT_MISSING` 告警归零。

### 5.6 Problem 结构化 + LIMITS + 命令层

- **做法**：`Problem { code, severity, at, message, detail?, fix? }`；`LIMITS` 单点定义；每个 mutation 升级为 `Command { do, undo, label, mergeKey }`（现在 `commit` 已经是它的 90%）。
- **收益**：问题可统计、可一键修复、可进 CI；截断有统一语义与"继续"入口；命令层直接支撑 CLI / 录制 / AI 调用（上一份报告里的 P1-5）。
- **代价**：UI 渲染改一处；`commit` 签名扩展。
- **验收**：问题面板可按 code 过滤；CLI 能复放一条命令序列得到同一文档。

---

## 6. 迁移顺序

风险从低到高，每步都能单独合入并保持行为不变（现有 18 个测试文件、3273 行是护栏）。

| 步 | 内容 | 风险 | 行为变化 |
| --- | --- | --- | --- |
| S1 | `LIMITS` 单点、`Problem` 结构化（旧 `detail` 保留兼容）、截断语义修正（D15）、`ProblemCode` 进 `code` | 低 | 无（除误报的"已截断"消失） |
| S2 | `portsOf` 单次缓存、`dynamicOf` 下沉、`makeView.display` 惰性 | 低 | 无 |
| S3 | `CompiledPack`（types 用 Map）+ 删除 `compatPack` | 中 | 无（快照对比） |
| S4 | `AssetStore` + `RecordRef`（先双写：`node.source` 仍写 base64 以兼容旧格式） | 中 | 持久化格式向后兼容 |
| S5 | 节点级 memo + `sig`（先在叶子节点启用，再全量） | 中高 | 交互更快，结果不变 |
| S6 | `NodeInstance.kind/config/meta`、`PortKey`、`Command` | 高 | 文档格式升版（写迁移，读兼容） |

建议把 S1-S2 作为一次"契约整理"提交，S3-S4 作为"内核"提交，S5 单独一次（可灰度开关），S6 随下一次文档版本升级。

---

## 7. 不要为了简洁而过度简化

以下复杂度是产品的表达力，简化会直接砍功能。逐条标注"为什么必须留"：

| 必须保留 | 原因 | 简化后的后果 |
| --- | --- | --- |
| 数据源四优先级（直连 > 指定 > 继承 > 默认） | 这是"一张图接多个 dump"的核心 | 每个节点都要手动接 File，图立刻不可读 |
| 动态元素端口 | 逆向的核心动作是"从第 3 个元素继续跟" | 只能看不能跟，退回 hexdump |
| 断链不中断（`valid=false` 但给真实值） | 能看出"断在哪一级" | 整图报错，无法定位 |
| `transform` 脚本逃生舱 | 真实格式总有声明式覆盖不到的地方 | 用户被迫改 pack 源码 |
| `portMode: value/raw` | 同一个地址要同时看"原始值"和"换算后地址" | 需要建两个节点，图翻倍 |
| 多文件冲突检测 | 防止"悄悄读了另一个文件" | 静默错误，比报错危险十倍 |

反过来，**可以放心简化的**是"实现层重复"：三份解码结果、三个 pack Map、两套类型、两套选择表示——它们不承载表达力，只承载维护成本。

---

## 8. 验收指标

| 指标 | 现状（估） | 目标 |
| --- | --- | --- |
| 改一个常量后重算耗时 | 全量（随图规模线性） | P95 < 50ms（只算下游） |
| 500 节点图首次求值 | 未测（含 4096 端口分配） | < 300ms |
| 4096 项链表求值内存 | 3 份副本 + 8 万字符串 | 1 份 `RecordView` + 惰性显示 |
| 100 步历史内存增量 | 随 buffer 大小 | < 1MB（资产外置后） |
| `PORT_MISSING` 告警 | 值变化即可能触发 | 归零（端口投影稳定） |
| 64 位地址解析 | > 2^53 静默错误 | 精确（bigint 通道） |
| UI 查找 | 每渲染多次 `nodes.find` | 索引 O(1) |

---

## 9. 对 UI 的直接影响

数据模型改完后，界面上三处能立刻落地（呼应设计系统的语义色与信息层级）：

1. **覆盖率条**：`Evaluation.coverage` 直接给出"本次解析解释了缓冲区多少字节"，未解释区域用中性灰着色——这是 Nybble 验证过的最强产品指标。
2. **问题条按 `code` 分组**：`Problem.code` 结构化后，同一类问题（如 `NO_SOURCE`）可以聚合展示 + 一键修复，而不是逐条读中文。
3. **截断提示变成"可继续"**：`{limit, at, canContinue}` 让画布上的"已截断"从告警变成入口（点一下继续解析下一段），语义色从"红=错误"降为"琥珀=待决"。

---

## 10. 一句话总结

**这套代码的"编辑模型"已经是商用水准，"运行时模型"还是原型水准。** 前者靠 `commit` 单一写入口 + 引用共享 + 纯函数测试撑住了，后者靠"每次全量重算 + 到处 find + 三份副本"在勉强工作。修的顺序应该是：先给值打标签、把字节收进一个容器（D1/D3），再拆开数据源追溯与值求值（D4），然后才是缓存与索引（5.3/5.5）——因为前两步决定"结果对不对"，后两步只决定"快不快"。
