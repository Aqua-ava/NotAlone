# 13 confirm 事务合并

Triage: ready-for-agent
State: resolved

## 目标

`memory_store.confirm` 与 `owner_memory_store.confirm_candidate` 的复制事务收敛为共享实现；`expected_dimension_evidence` 校验时点统一，消除重复来源查询。

## 证据

- `memory_store.py:490`（233行）vs `owner_memory_store.py:166`（265行）结构逐段相同。
- owner 版在幂等重放前校验 expected_dimension_evidence；contact 版只在新分支；contact 版 `_ensure_active_sources` 重复 3 次。
- 复核：`verify-backend.md` A6。

## 范围

- 抽公共 `_confirm_candidate_in_transaction`（或等价），两个 store 薄包装；统一校验时点（fail-closed，重放也校验）。
- 保留两侧独有规则（如 owner `FactSubject is SELF` 拒绝）。
- 不改写删除/来源/版本语义；事务边界不变。
- 测试：现有记忆确认/重放/陈旧证据测试全绿 + 新增「重放时证据变化」两侧一致用例。

## 验收

- 记忆相关单测/集成；报告确认路径行为差异点。

## Comments

- 结构：新增 `backend/src/notalone/persistence/memory_confirm.py`，承载唯一一份确认事务状态机（加锁读候选 → 保护/人工决定 → 幂等重放或新建版本 → 来源合并与校验 → 版本回执 → 写入与旧版失效）。contact/owner 两个 store 各自只剩薄包装（参数校验 + 异常归一化）与 `ConfirmFlavor` 适配器（表名、行投影、对象构造、锁定依据复验、依赖清理顺序）。`memory_store.confirm` 从 233 行降到约 40 行，`owner_memory_store.confirm_candidate` 从 265 行降到约 45 行；不再有第二份复制事务。
- 校验时点统一：调用方给出 `expected_dimension_evidence` 时，在保护判定之后、幂等重放与新建分支之前统一调用 `require_current_dimension_evidence`，重放同样 fail-closed；未给出预期时保留两侧原有的写入前锁定复验（contact AUTO / owner AUTO 或 ALL 维度依据）。owner 适配器读取候选时先按当前来源绑定维度依据，使预期校验看到真实绑定状态而非仅比较 JSON 载荷。
- 来源查询去重：contact 版原有的 3 次 `_ensure_active_sources`（旧版来源、合并前、ALL/ANY 分支）收敛为合并后一次校验；ALL 模式直接使用更严格的 `ensure_all_sources`。owner 版保留 `_ensure_memory_sources`（手录根链）与按 owner 范围校验，`FactSubject is SELF` 拒绝仍是 owner 独有规则。
- 行为差异点（均为 fail-closed，未改删除/失效/版本语义）：
  - contact 重放现在也校验 `expected_dimension_evidence`（此前重放直接返回）；owner 重放预期不符时的错误由 `MemoryVersionConflict`(本人候选核验依据已变化) 统一为与 contact 相同的 `DimensionEvidenceChangedError`。
  - contact MANUAL 确认在调用方给出预期依据时也会校验（此前只有 AUTO 分支校验）。
  - owner AUTO+expected_previous 的 `require_replacement_evolution` 改用存储行构造的候选（权威数据），不再使用调用方 DTO。
  - 来源校验与版本冲突同时不满足时错误优先级可能变化（旧文档删除优先 vs 叶版本冲突优先），两种都在写入前拒绝并回滚。
- 回归测试（先红后绿）：`backend/tests/integration/persistence/test_memory_confirm_consistency.py` 覆盖两 store 重放时预期依据变化、新建时预期依据不符（均断言 `DimensionEvidenceChangedError` 且候选/记忆状态原子不变）、无预期时重放仍幂等、confirm 来源校验次数（去重后 1 次）。
- 验证命令与结果：
  - `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" perl -e 'alarm 300; exec @ARGV' -- python -m unittest tests.integration.persistence.test_memory_confirm_consistency -v` → 22 项通过（含继承的 timing 基线用例）。
  - 记忆相关模块：`python -m unittest tests.unit.memory tests.unit.memory_extraction tests.unit.persistence tests.integration.persistence.test_memory_timing tests.integration.persistence.test_memory_merge tests.integration.persistence.test_all_source_persistence tests.integration.persistence.test_dimension_evidence tests.integration.persistence.test_dimension_evidence_v2 tests.integration.persistence.test_dimension_evidence_v3 tests.integration.persistence.test_bounded_runtime_migration tests.integration.persistence.test_memory_read_batching tests.integration.persistence.test_memory_confirm_consistency tests.integration.persistence.test_pending_candidate_projection` → `Ran 154 tests ... OK`。
  - server 集成：`python -m unittest tests.integration.server.test_memory_api tests.integration.server.test_memory_integration tests.integration.server.test_memory_correction_protection tests.integration.server.test_memory_timeline tests.integration.server.test_memory_evolution_reply` → 通过；`tests.integration.server.test_memory_correction_grounded` 8 failures、`tests.integration.server.test_import_auto_flow` 1 failure/1 error，均用 `git archive HEAD` 导出基线源码在 `/tmp` 复跑同样失败，非本改动引入。
  - 全量单测 `python -m unittest discover -s tests/unit -t .` → `Ran 2487 tests`，13 failures + 1 error；同一批失败在基线源码 `tests.unit.memory_extraction.test_merge_batch_timeline`、`test_upgrade_transaction_ports`、`test_pgvector_evidence` 上原样复现，非本改动引入。
  - 环境既有失败：`test_memory_retirement`/`test_layered_memory_management` 需要外部注入 `NOTALONE_TEST_DATABASE_URL`（`KeyError`），默认 `notalone_test` 旧结构问题同 ticket 11 记录，与本改动无关。
- 数据影响：无 schema/数据迁移；确认事务边界不变（同一写事务内完成写入、旧版失效、候选状态与删除依赖清理）。
- 剩余风险：保持「先写新版本再失效旧版本再更新候选状态」的原有三条语句顺序，未合并为单条 SQL；适配器与共享内核之间仍靠协议约定，后续新增 store 需实现同一组方法；错误优先级差异已在上面列出。
