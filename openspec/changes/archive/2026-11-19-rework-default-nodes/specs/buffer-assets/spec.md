## ADDED Requirements

### Requirement: 当前蓝图内联其转储字节

当前格式的蓝图 MUST 能独立打开。文档里内联的内容 MUST 在载入时登记为资产，导出 MUST 保留内联内容；节点用到同一资产不意味着复制字节。旧版蓝图 MUST 提示不支持，而不是用新版节点语义重新解释旧配置。

#### Scenario: 打开另一台机器导出的新版蓝图

- **GIVEN** 一张导出的 `memlink-blueprint/2` 文档，数据源包含内联的转储字节
- **WHEN** 在另一台机器打开该图
- **THEN** 资产可供求值，无需重新载入原始转储文件

#### Scenario: 打开旧版蓝图

- **GIVEN** 一张 `memlink-blueprint/1` 文档
- **WHEN** 用户尝试打开
- **THEN** 提示版本不支持，不按新版语义求值，也不修改原文件

## REMOVED Requirements

### Requirement: 旧文档无需重新载入

**Reason**：重整后同名节点的配置与端口契约改变，旧图不再迁移；当前版的单文件便携性由新要求延续。

**Migration**：不自动迁移已保存的图或旧缓存。如需用新版解析，从原始转储开始创建新版图；用户原文件与旧缓存保持原样。
