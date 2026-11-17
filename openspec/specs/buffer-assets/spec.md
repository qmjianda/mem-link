# buffer-assets Specification

## Purpose
保证同一份字节在文档、求值、跟随地址与持久化中只有一个身份。身份由内容决定，而不是文件名与长度，从而使去重、诊断与将来的 diff 有可靠依据。

## Requirements

### Requirement: 资产身份由内容决定

系统 MUST 为每份载入的字节计算内容哈希并分配资产 id。名称、基址、长度相同但内容不同的两份字节 MUST 视为不同资产；内容相同的两份 MUST 视为同一资产。

#### Scenario: 同名同长不同内容

- **GIVEN** 两个 4 KiB 文件都命名为 `dump.bin` 且基址都是 0
- **WHEN** 分别载入两个 File 节点
- **THEN** 跟随地址列表出现两个不同条目，各自指向自己的字节

#### Scenario: 同内容重复载入

- **GIVEN** 同一份字节被两个 File 节点载入
- **WHEN** 查看资产身份
- **THEN** 两个节点引用同一个资产 id，且只保留一份字节

### Requirement: 跨节点共享同一资产身份

所有读取同一份字节的节点 MUST 通过资产 id 引用它。复制、粘贴节点 MUST NOT 复制字节。求值产出的元素值 MUST 能回溯到所属资产 id。

#### Scenario: 复制已载入文件的节点

- **GIVEN** 一个已载入 1 MiB 字节的 File 节点
- **WHEN** 复制并粘贴该节点
- **THEN** 新节点复用同一资产 id，字节不被复制

#### Scenario: 元素值可回溯到资产

- **GIVEN** 链表元素被接到另一个解析节点
- **WHEN** 查看该节点的数据源信息
- **THEN** 显示其资产 id 对应的名称与基址，且与上游一致

### Requirement: 旧文档无需重新载入

旧蓝图与旧缓存中以 base64 内联的字节 MUST 在载入时自动登记为资产，MUST NOT 要求用户手工重新载入。导出时 MUST 仍可内联字节，以保持单文件可移植。

#### Scenario: 打开含内联字节的旧蓝图

- **GIVEN** 一份 `memlink-blueprint/1` 文档，其中 File 节点带 base64 `source.data`
- **WHEN** 打开该文档
- **THEN** 图正常解析，且资产表包含这段内容

#### Scenario: 导出仍可独立打开

- **GIVEN** 一张使用外置资产的图
- **WHEN** 执行“保存图”导出
- **THEN** 字节被内联进导出文件，该文件可在另一台机器独立打开
