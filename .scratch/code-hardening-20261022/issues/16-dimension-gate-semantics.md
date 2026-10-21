# 16 维度门回退语义

Triage: ready-for-agent
State: resolved

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

- 2026-10-22 完成（用户决策：保留开关，只关白名单，来源核验不可回退）：`DimensionRelease.allows()` 在 `verified_sources=True` 时只看同次来源核验回执，`gate_enabled` 不参与该路径；`gate_enabled=False` 只影响显式历史协议（`verified_sources=False`）的逐维白名单，保留原评测注入语义。
- 文档同步：`README.md` 配置表、ADR-036 顶部回链与第 5 条、`docs/memory-adoption-dimension-release-ledger.md` 第 4 节；新增 [ADR-097](../../architecture/adr/097-dimension-gate-rollback-keeps-source-verification.md) 并登记 `architecture/README.md`。
- 测试更新：`test_dimensions.py` 断言 gate=0 只关白名单、无回执不采纳、显式历史协议保留；`test_adoption.py` 断言 gate=0 下无回执候选仍进待确认。
- 验证：`python -m unittest tests.unit.memory_extraction.test_dimensions tests.unit.memory_extraction.test_adoption` 56 条通过；加入 `test_automatic_memory` 共 66 条通过。`tests/unit/memory_extraction` 全量仍有 13 条失败，均为 `test_merge_batch_timeline`/`test_upgrade_transaction_ports`，与同时进行的 memory-fix 未提交改动相关（本 ticket 改动前后这些用例属于并发编辑面），留待集成后全量复核。
- 数据影响：无 schema/数据变更；默认（门开启 + `verified_sources=True`）行为与改动前完全一致。剩余风险：显式注入 `verified_sources=False` 的历史评测装配仍可绕过来源核验，仅限测试/冻结评测，不应进入生产装配。
- Commit：见 `git log --grep '维度门回退'`。

- 2026-10-22 复核修复：`gate_enabled` 不再影响 `expected_dimension_evidence` 绑定、owner 写入分支与 correction 例外；新增 `DimensionRelease.requires_evidence_binding = verified_sources or gate_enabled`。回退只关逐维白名单，候选依据复验与来源核验都不受开关影响；显式 `verified_sources=False` 历史协议行为保持不变。
