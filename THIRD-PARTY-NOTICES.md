# 第三方组件与许可声明

mem-link 的构建产物（`dist/index.html`）是一个内联了 JavaScript 的单文件 HTML。
其中包含下列开源软件的代码。我们按各自许可保留版权与许可声明。

> 本文件是工程合规声明，不构成法律意见。若你是权利人并认为某项使用不当，
> 请通过仓库 issue 联系我们，我们会核实并更正或移除相关内容。

## 随构建产物分发的运行时组件

以下组件会被 Vite 打进了 `dist/index.html`：

| 组件 | 版本 | 许可 | 版权 |
| --- | --- | --- | --- |
| [React](https://github.com/facebook/react) | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| [ReactDOM](https://github.com/facebook/react) | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| [Scheduler](https://github.com/facebook/react/tree/main/packages/scheduler) | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| [Sucrase](https://github.com/alangpierce/sucrase) | 3.35.0 | MIT | Copyright (c) 2012-2018 various contributors (see AUTHORS) |
| [@jridgewell/gen-mapping](https://github.com/jridgewell/gen-mapping) | 0.3.13 | MIT | Copyright 2024 Justin Ridgewell |
| [@jridgewell/sourcemap-codec](https://github.com/jridgewell/sourcemap-codec) | 1.6.0 | MIT | Copyright 2024 Justin Ridgewell |
| [@jridgewell/trace-mapping](https://github.com/jridgewell/trace-mapping) | 0.3.31 | MIT | Copyright 2024 Justin Ridgewell |
| [@jridgewell/resolve-uri](https://github.com/jridgewell/resolve-uri) | 3.1.2 | MIT | Copyright 2019 Justin Ridgewell |
| [lines-and-columns](https://github.com/eventualbuddha/lines-and-columns) | 1.2.4 | MIT | Copyright (c) 2015 Brian Donovan |

上述 MIT 组件统一适用以下许可文本：

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

各组件完整许可文本也随依赖包分发在 `node_modules/<包名>/LICENSE`。

## 仅用于构建 / 测试的工具

以下工具不会进入运行时产物，但仓库的开发、构建和 CI 依赖它们：

| 工具 | 许可 |
| --- | --- |
| Vite | MIT |
| @vitejs/plugin-react | MIT |
| vite-plugin-singlefile | MIT |
| esbuild | MIT |
| TypeScript | Apache-2.0 |
| Vitest | MIT |
| ESLint | MIT |
| typescript-eslint | MIT |
| eslint-plugin-react-hooks | MIT |
| @types/react、@types/react-dom | MIT |

TypeScript 以 Apache-2.0 分发；其许可文本见
<https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt>。

## Pack 商店内容

`store/` 下的格式 pack 与主程序分开授权：

- 手工维护 pack（NES、SQLite、PNG、BMP、ZIP、GIF、ELF、PE、JPEG、WAV）：MIT。
- 从 [Nybble format registry](https://github.com/itsmajdbuilds/binary-explorer-registry)
  移植的 pack：按上游 README 的声明使用/再分发，除非该 pack 另有说明；来源与
  作者见各 `meta.json`。
- 从 [ImHex-Patterns](https://github.com/WerWolv/ImHex-Patterns) 移植的 pack：
  **GPL-2.0-only**。这些 pack 是独立文件，不链接进主程序；完整许可文本见
  [`store/licenses/GPL-2.0-only.txt`](store/licenses/GPL-2.0-only.txt)，来源快照
  与修改说明见 [`store/NOTICE.md`](store/NOTICE.md)。

## 名称与商标

ImHex、Nybble 以及各文件格式名称是其各自权利人的名称或商标。本项目使用这些
名称仅用于说明格式来源与兼容性，不代表与上游项目存在隶属、赞助或背书关系。
