# 16 维度门回退语义

Triage: ready-for-agent
State: open

## 目标

`NOTALONE_MEMORY_DIMENSION_GATE=0` 只关闭历史逐维白名单，`verified_sources` 来源核验永远生效；消除「无核验自动采纳」后门。

## 证据

- `backend/src/notalone/memory_extraction/dimensions.py:298-308`：gate 关闭时 `allows()` 直接 `key is not None`，跳过来源核验。
- 生产 `run_extraction(automatic=True)`（`command.py:122`），automatic 分支无其他硬门（`adoption.py:1210-1216`，ADR-085）。
- README:213 / ADR-036 第5条 / 放行台账「怎么回退」与代码不一致。
- 用户 2026-10-22 决定：保留开关，只关白名单，来源核验不可回退。

## 范围

- `dimensions.py`：`verified_sources` 校验独立于 `gate_enabled`；gate 关闭仅跳过逐维证据/放行表。
- 更新 docstring、README 配置表、ADR-036 第5条、`docs/memory-adoption-dimension-release-ledger.md` 回退章节。
- 按仓库约定新增说明性 ADR（编号取当前最大值+1），替代/说明 ADR-036 第5条与台账第4节；旧 ADR 顶部补回链。
- 测试：gate=0 时无来源回执不自动采纳、有回执可采纳；历史 `verified_sources=False` 显式注入行为保持；gate=1 行为不变。
- 不改变 `DEFAULT_DIMENSION_RELEASE` 空放行集。

## 验收

- `tests/unit/memory_extraction/test_dimensions.py`、`test_adoption.py` + 相关模块；报告文档改动与数据影响（无 schema/数据变更）。

## Comments
