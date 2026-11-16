# Proposal

## Why

蓝图把 pack 源码内嵌在 JSON 里，打开时用 `new Function` 编译执行。也就是说，打开一份他人制作的蓝图，等于执行他人的代码，且代码可以发起网络请求。这个议题真实存在，但它和本项目的核心用途——拖入 bin、按结构体解码、跟链表——没有关系。

它被从 `p0-baseline-and-correctness` 中拆出来单独排期，原因是：在核心链路还没跑顺的时候先做 CSP、导入授权、导出哈希清单，会把「能不能解析」的问题和「敢不敢打开」的问题混在一起，两边都推进缓慢。

## What Changes

- **CSP**：生产构建禁止一切网络请求；dev 单独放开 HMR 所需的 `ws:`。
- **网络守卫**：编译 pack 前替换 `fetch` / `XMLHttpRequest` / `WebSocket`，被拦截的尝试映射为 `NO_NETWORK` 并定位到节点。
- **两阶段导入**：打开蓝图先列出 pack 清单与源码哈希，默认不编译，逐个授权后才执行。
- **导出声明**：导出物写入 pack 哈希清单与「包含可执行代码」声明。
- **一致性校验**：源码与清单哈希不符时视为未授权。
- **未启用状态**：未启用的 pack 节点只报 `PACK_DISABLED`，不叠加 `UNKNOWN_NODE`。

## Capabilities

### New Capabilities

- `pack-trust`: pack 代码的执行边界、蓝图导入授权与离线约束。

### Modified Capabilities

（无）

## Impact

- **代码**：`index.html`、`vite.config.ts`、`src/bp/load.ts`、`src/bp/BlueprintApp.tsx`、`src/bp/doc.ts`。
- **兼容**：需要保留 `unsafe-eval`，因为本变更不替换 pack 的执行模型（仍是 `new Function`），只收窄它的能力。
- **触发条件**：开始对外分享蓝图、或引入多人协作时再做。仅自己使用本地文件时，这一层不产生收益。

## 不在范围

- 替换 pack 执行模型（Worker / 解释器 / WASM）。
- 签名与密钥管理：本变更只做哈希核对，不做身份认证。
