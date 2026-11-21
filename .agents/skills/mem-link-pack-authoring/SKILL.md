---
name: mem-link-pack-authoring
description: Generate, port, review, and publish mem-link .bp.ts packs and the pack store. Use when working in store/packs, porting Nybble TOML schemas or ImHex .hexpat patterns, editing .bp.ts type/node definitions, adding store metadata, debugging pack load/evaluation errors, or updating index.json and the GitHub pack store.
license: MIT
metadata:
  author: mem-link
  version: "1.0"
---

# mem-link Pack Authoring

面向 mem-link 的 pack 生成、移植、审查与商店发布。核心教训：**固定结构体只是 pack 的一半能力**。遇到 computed、指针、repeat、动态数组、match 时，先考虑 `calcNode` / `listNode` / `arrayNode` / 变体 `structNode`，不要直接标成“无法表达”。

## 1. 能力映射（先查这张表）

| 上游构造 | mem-link 表示 | 说明 |
| --- | --- | --- |
| 固定字段 / 嵌套 struct | `struct(...)` + `structNode` | 偏移必须可静态确定 |
| union / 共享偏移 | `union(...)` | 字段重叠允许 |
| 位域 | `bits(name, width, { bit, unit })` | 同一存储单元，单位 1/2/4/8 |
| 枚举 | 整数字段 + `values` | 只改显示，不改数值/宽度 |
| 计算字段 `x = a * 2 + b` | `calcNode` | 输入接字段端口；输出 `value` |
| 指针 / `at + offset` | 地址 `calcNode` + 目标 `structNode` | `address = base + offset`；绝对指针不接 base |
| repeat / `while` 元素 | `listNode(Type, { next })` | `next` 返回**下一个元素地址**，`null` 停止 |
| 动态数组 `Type[countField]` | `arrayNode(Type)` | 省略 `count` 时暴露 count 输入 |
| match / 条件变体 | 每个分支一个 `structNode` | 由用户按判别字段选择；不要伪造固定字段 |
| varint / LEB128 | `calcNode` 读 1–9 字节 | 输出 `value` 与 `bytes`；静态布局在此停止 |
| cstring / 变长 bytes | 内置「读字符串」/「字节范围」或 calc 计算长度 | 不能塞进固定 struct |
| 运行时解压/校验 | 内置 `checksum` / 自定义 calc | 不要假装字段宽度已知 |

**判定顺序**：能静态确定 → `struct`；能由地址/字段计算 → `calcNode`；能按地址迭代 → `listNode`；数量来自字段 → `arrayNode`；分支 → 变体节点；只有完全无法确定地址或长度时才写“未移植”。

## 2. 生成器硬规则（这些错误已经踩过）

### 2.1 字节序

- 字段的显式 `endian` 必须回落到 **pack 的 endian**，不是硬编码 `little`。
  - 错误：`u32('size', { endian: 'little' })` 出现在 `definePack({ endian: 'big' })` 的 pack 里。
  - 正确：`ty.endian ?? prim.endian ?? pack.endian`；能省略时直接省略，让 pack 统一决定。
- `str` / `bytes` / `bits` 没有字段级 endian；位域按 pack endian 解释。
- 大端格式（AIFF、TIFF-BE、网络格式等）必须有测试断言字段 `endian === 'big'`。

### 2.2 标识符与 `export`

- 加载器用 `/\bexport\s+(?!default\b)/` 拒绝额外 `export`，**注释和字符串也会命中**。
- 所有生成文本（label、description、注释、footer）统一把单词 `export` 替换成 `导出`。
- 类型变量名必须避开 JS 保留字与危险名：`class`、`export`、`import`、`open`、`require`、`default`、`new`、`return` 等。使用 `JS_RESERVED` 集合 + `T_` 前缀。
- 字段名用字符串字面量传参，不要拼成变量名。

### 2.3 空类型

- `struct(..., [])` 或没有成员的 `bitfield` 会报 `XXX 的长度必须大于 0`。
- 生成前过滤空类型；父字段引用空类型时停止该字段并记录。
- 只有 `padding` 的 bitfield 可以降级为原始整数/字节：
  - 总位数 8/16/32/64 → `u8/u16/u32/u64('value')`
  - 否则 → `bytes('value', { size: ceil(bits/8) })`
- 不要为了“凑一个类型”生成 `u8` 假字段，偏移会错。

### 2.4 数组与括号

- 解析 `padding[...]` 时先 `eat('[')` 再调用数组长度解析；不要只 `at('[')` 就直接解析，否则会从 `[` 本身开始，永远找不到闭合。
- **不要**把 `]]` 词法化成单个 token（属性 `[[...]]` 应在 token 化前从文本移除）；否则嵌套数组 `Type[a[b]]` 会报 `expect ] actual eof`。
- 属性 `[[...]]`、注释、字符串必须先剥离/保护，再处理结构；否则注释里的 `[[` 会吞掉后文。
- 数组长度优先求值常量/宏；引用字段的 count 不要伪造，交给 `arrayNode` 的 count 输入。

### 2.5 枚举底层类型

- `enum E : s32`、`u24`、`uint8_t`、`ULONG32` 等不要直接把 repr 当函数名。
  - 标准别名映射到 `i32/u32/u8...`。
  - `u24` → `bytes(size:3)`，`u128` → `bytes(size:16)`；数值映射不可用时明确记录。
  - `vint`/`LEB128` 变长 → 生成 varint `calcNode`，不要映射成固定宽度。

### 2.6 指针偏移引用计算字段

- Nybble 的 `at nextHeaderPos Struct` 中 `nextHeaderPos` 可能是 computed 字段。
- `numericField` / 输入收集必须同时接受 `kind:'field'` 与 `kind:'computed'`；否则会误报“非标量”。
- 指针地址节点：
  - 相对：`base + offset`
  - 绝对：`offset`
  - 目标类型若是 enum，生成 enum 包装 `struct` 后再给 `structNode`。

### 2.7 Nybble 语法要点

- 指针关键字是 `at`（单词），不是 `@`；支持 `at +expr`。
- computed 是 `name = expr`，表达式保留 AST 才能生成 calc。
- `repeat T until cond` / `while pattern`；`until` 条件针对刚读出的元素。
- `match path { 1 => T, "TAG" => U, default => V }`：解析 arms，不要只跳过大括号。
- `at` 指针字段不占字节；computed 字段不占字节。遇到它们不要错误地停止静态布局。
- 条件字段 / `repeat` / `match` / 动态数组 / varint 之后的静态字段可能偏移未知；固定前缀到此为止，但辅助节点仍要生成。

### 2.8 ImHex 语法要点

- 先移除注释/字符串保护，再移除 `import`、`#pragma`、`#define`、函数 `fn {...}`、属性 `[[...]]`。
- 保留 `#pragma endian`；字段前缀 `be`/`le` 覆盖 pack endian。
- 支持 struct 继承 `struct B : A {...}`（把基类字段平铺进 B）；模板 `<...>` 跳过。
- `if` / `match` / `try` / `break` 表示动态控制流：静态布局停止，但可生成变体/辅助节点。
- `char[N]` → `str`；`u8[N]`/`i8[N]` → `bytes`；其它标量数组 → `array`。
- `padding[N]` → `pad(N)`；`u24/u128` → bytes；`type::LEB128` → varint 辅助节点。
- 命名空间 `ns::Type` 统一扁平化为 `ns_Type`，定义与引用使用同一规则。

### 2.9 辅助节点生成

- 每个 computed 字段：`calcNode({ inputs:{...}, outputs:{ value:'number' }, run })`。
- 每个指针：地址 `calcNode` + 目标 `structNode`；label 写清 `指针地址` / `指针目标`。
- 每个 repeat：`listNode(elemRef, { next: e => e.addr + elemRef.size, max:4096 })`；`until` 条件转成 `if (cond) return null`。
- 每个动态数组：`arrayNode(elemRef, { label })`；描述里写明 count 来自哪个字段。
- 每个 match：每个可转换 arm 一个 `structNode`，label 带 key；不要只留下“match 未移植”。
- varint：整包只生成一次 `read_varint`，输入 `address`，输出 `value`/`bytes`。
- 辅助节点也要去重 id，并计入 `meta.helpers`。

### 2.10 覆盖度语义

- `complete`：静态布局完整，且没有动态辅助节点/未移植项。
- `partial`：静态类型只覆盖固定前缀，**不代表完全无法解析**。
- `meta.helpers`：动态辅助节点数量（calc/list/array/变体）。
- 商店 UI 显示「部分布局 · N 辅助」；不要把有辅助节点的 pack 和纯空壳混为一谈。
- 文件末尾的「未移植项」只列真正无法自动覆盖的内容；已生成辅助节点的项写到「动态辅助节点」注释或只在 header 计数。

## 3. 常见故障速查

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| `s32 is not defined` / `u24 is not defined` | 把枚举 repr 原样当函数名 | 经 PRIMS/别名映射；未知定宽转 bytes |
| `Elem_u8 is not defined` | 额外类型只存了 `struct(...)`，没生成 `const Ref =` | `addExtraType` 存完整 `const ${ref} = ${code};` |
| `XXX 的长度必须大于 0` | 空 struct / 空 bitfield | 过滤空类型；padding-only bitfield 降级为整数/bytes |
| `只支持 export default` | 注释/字符串里有单词 `export` | 生成文本统一替换为 `导出` |
| `Unexpected token (line:col)` | 类型变量名是 `class`/`export`/`open` 等 | JS 保留字/危险名加 `T_` 前缀 |
| `数组长度没有闭合的 ]` | `padding[` 未先消费 `[`；或 `]]` 被当成单 token | 先 `eat('[')`；属性预处理后再词法化 |
| 大端字段读成小端 | 字段 endian 硬编码 `little` | 回落 `pack.endian` |
| `pointer offset ... 非标量` | offset 引用 computed 字段 | `numericField` 接受 computed |
| `match` 分支全丢 | parser 只跳过大括号 | 解析 arms，按 key 生成变体节点 |
| 生成器只产 `structNode`，大量 partial | 遇到动态构造就停 | 生成 calc/list/array/变体；记录 `helpers` |
| `index.json` 与 pack 不一致 | 改了 pack 没重建索引 | `node store/scripts/build-index.mjs store` |
| 商店仍是旧版本 | jsDelivr `@main` 缓存 | 发布后 purge，或确认走 raw/Pages |

## 4. 标准工作流

### 4.1 移植 Nybble

```bash
# vendor 快照已在 store/vendor/nybble-registry.json
node store/scripts/port-nybble.mjs --root store --write
```

- 先在 `--report` 模式看：每个包的类型数/节点数/跳过项。
- 生成后检查：computed/pointer/repeat/dynamic/match 是否都有辅助节点。
- 只清理 `source.provider === 'nybble'` 且本次未生成的目录；带 id 过滤运行时不要清理。

### 4.2 移植 ImHex

```bash
# 下载/解压 ImHex-Patterns 到 .cache
node store/scripts/port-imhex.mjs --root store --src .cache/ImHex-Patterns-master/patterns --write
```

- ImHex 是 C 风格语言，先保护字符串/注释，再剥属性/函数/预处理。
- 动态控制流处停止静态布局，但保留已确定前缀。
- 每个 ImHex 派生 pack 的 `license` 必须是 `GPL-2.0-only`，并保留 `source.path`。

### 4.3 校验

```bash
node node_modules/typescript/bin/tsc --noEmit
node store/scripts/build-index.mjs store --check
node node_modules/vitest/vitest.mjs run tests/store-packs.test.ts tests/pack-store.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build
```

`tests/store-packs.test.ts` 必须加载**所有** `store/packs/*/pack.bp.ts`；任何编译失败都不能发布。

### 4.4 发布

```bash
node store/scripts/build-index.mjs store
node scripts/publish-pack-store.mjs          # 推送 + 自动 purge jsDelivr
```

- 商店默认索引：`https://cdn.jsdelivr.net/gh/qmjianda/mem-link-packs@main/index.json`
- 回退：GitHub Pages / `raw.githubusercontent.com`
- 发布后确认 jsDelivr 返回的 pack 数等于 `store/index.json`。
- 如果 Git push 出现 HTTP2 framing 错误，改用 SSH remote 或 `--repo git@github.com:...`。

## 5. 来源与许可

- 手工 pack：MIT。
- Nybble registry：上游声明可自由使用/再分发；保留 `meta.source` 与 `author`。
- ImHex-Patterns：GPL-2.0-only；保留 `store/licenses/GPL-2.0-only.txt` 与每个 pack 的上游路径。
- 不得把 GPL 派生 pack 重新标成 MIT；不得删除来源注释。

## 6. 文件地图

```text
store/packs/<id>/pack.bp.ts     生成的 pack（不要手改自动生成文件）
store/packs/<id>/meta.json      id/version/category/coverage/helpers/source
store/scripts/port-nybble.mjs   Nybble → mem-link
store/scripts/port-imhex.mjs    ImHex 固定布局 → mem-link
store/scripts/build-index.mjs   生成/校验 index.json + SHA-256
src/bp/store.ts                 商店 URL/索引/哈希/版本/镜像
src/bp/PackStore.tsx            商店 UI
src/bp/BlueprintApp.tsx         安装提交、持久化、更新
scripts/publish-pack-store.mjs  发布 + jsDelivr purge
tests/store-packs.test.ts       全部 pack 编译
tests/pack-store.test.ts        URL/索引/哈希/镜像
```

## 7. 交付前检查清单

- [ ] 所有 `pack.bp.ts` 能通过 `loadBlueprintPack`（`tests/store-packs.test.ts`）。
- [ ] 没有空 struct/bitfield；padding-only bitfield 已降级。
- [ ] 大端 pack 的字段 endian 正确。
- [ ] computed / 指针 / repeat / 动态数组 / match 已生成辅助节点，或明确记录无法覆盖。
- [ ] `meta.json` 有 `coverage`、`source`、许可、作者；有辅助节点时写 `helpers`。
- [ ] `index.json` 与 pack 一致，SHA-256/大小已更新。
- [ ] 商店 UI 显示辅助节点数量，而不是只显示“部分布局”。
- [ ] 来源/许可未被改写；ImHex 派生仍是 GPL-2.0-only。
- [ ] 发布后 jsDelivr 返回的 pack 数正确。
- [ ] 主仓库改动未擅自提交；商店仓库推送与 purge 已完成。
