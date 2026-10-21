# ADR-097：维度门运维回退保留来源核验

> 状态：已采纳
> 决策日期：2026-10-22
>
> 修订 [ADR-036](036-per-dimension-adoption-release.md) 第 5 条与
> [维度放行台账](../../docs/memory-adoption-dimension-release-ledger.md) 第 4 节；
> 不改变 ADR-085 的默认自动采纳边界与历史评测合同。

## 背景

ADR-036 引入运维回退开关 `NOTALONE_MEMORY_DIMENSION_GATE=0`：关闭逐维门，
恢复本门启用前的行为（当时是置信度／语用／风险三道门槛）。之后 ADR-070 与
ADR-085 把默认自动维护改为「逐条来源核验后自动处理」，并取消 automatic 路径
的额外置信度／语用／风险人工门，来源核验成为唯一硬准入。

代码里的回退分支没有随默认策略收敛：`DimensionRelease.allows()` 在门关闭时
先跳过 `_verified_current_sources`，再直接返回「维度键可推导」，于是
`gate=0` 同时关闭逐维白名单与来源核验。生产提取入口使用 `automatic=True`，
automatic 分支没有其他硬门，实际效果是任何能推导出维度的事实都可能不经核验
自动采纳。README 与台账却仍写成「回退到原有三道门槛」，与 ADR-085 后的默认
路径不符。

2026-10-22 用户确认保留该环境变量，但把它收敛为「只关闭逐维白名单」。

## 决定

- `NOTALONE_MEMORY_DIMENSION_GATE=0` 只关闭逐维放行白名单；`verified_sources`
  开启时，同次来源核验回执仍是准入条件，回退不能绕过。
- 未设置、空值与其他值保持门开启（fail-closed）。
- 生产装配仍只传 `None`；显式历史协议（`verified_sources=False` 的注入）保留
  原评测语义，仅供测试与冻结评测装配使用。
- `DEFAULT_DIMENSION_RELEASE` 仍为空放行集；不回填任何维度。
- 不新增启动告警或 UI 开关；该变量仍只由运维显式设置。

## 替代与保留

- 替代 ADR-036 第 5 条中「关闭后恢复本门启用前三道门槛行为」的表述；
  ADR-036 的其他条款、ADR-046／ADR-070／ADR-085 的评测与来源边界保持不变。
- 台账第 4 节「运维级全量回退」改写为「只关闭逐维白名单」。
- 不改变 `verified_sources=True` 的默认自动采纳规则，不改变人工确认、修正、
  删除保护与联系人隔离。

## 依据与验证

- 代码：`backend/src/notalone/memory_extraction/dimensions.py` 的
  `DimensionRelease.allows()` 先校验当前来源回执，再判断逐维放行。
- 测试：`tests/unit/memory_extraction/test_dimensions.py` 覆盖 gate=0 只关白名单、
  无回执不采纳、显式历史协议保留；`test_adoption.py` 覆盖 gate=0 下无回执候选
  仍进待确认。
- 本决定不修改运行配置、业务数据或 schema；`gate=0` 是显式运维动作，默认
  路径行为不变，不据此宣称真实提取质量或桌面验收通过。
