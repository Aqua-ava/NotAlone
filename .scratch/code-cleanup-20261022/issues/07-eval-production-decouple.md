# 07 评测/实验与生产解耦

Triage: ready-for-agent
State: resolved

## 目标

解除生产源码对评测/实验包的反向依赖，使 `backend/src/notalone/experiments/` 可安全标 `dev-only`；本轮不迁出包。

## 证据

`.scratch/code-audit-20261022/verify-unused.md` 第 10、47-49 行；反向依赖点：`application/memory_pipeline_preview.py:94`（可随低风险删除）、`memory/organization_quality_suite_budget.py:193`、`memory/organization_quality_transport.py:115`、`memory_extraction/direct_adapter.py:133`、`memory_extraction/evaluation_http_budget.py:368`、`memory_trace/transport.py:131`、`reply/quality.py:121,209`。

## 范围

- 把被生产使用的 `problem_budget` 符号与 `reply_comparison` 的 `canonical_input`/`validate_*` 提升到生产模块（如 `memory/`、`reply/`），评测侧改为反向 import。
- `experiments/__init__.py` 与包文档标注「不进入产品装配、仅评测/测试」；`pyproject.toml` 两个评测 CLI 保留但注明 dev-only（不删注册）。
- 同时删除低风险生产 0 import 模块：`ledger/adapters.py`、`front_sync/emoji_tail.py`、`application/memory_pipeline_preview.py`、`application/organization_qualification.py`、`media/service.py`（按 verify-unused 清单，测试引用同步处理）。
- 不改评测行为与预算账本语义。

## 验收

- 生产 `backend/src` 内除 experiments 自身与测试外，`from notalone.experiments` 引用为 0（或仅剩已声明入口）。
- `python -m unittest discover -s tests/unit -t . -v` 相关目录通过；评测相关单测同跑。
- 报告 import 图变化、删除行数、保留的评测 CLI。

## Comments

- 2026-10-22 backend-cleaner 完成：
  1. **解耦**：生产 `src/notalone`（除 experiments 自身）`from notalone.experiments` 引用为 0。
     - `experiments.problem_budget` 提升为生产模块 `src/notalone/problem_budget.py`（183 行）；`experiments/problem_budget.py` 改为 22 行兼容 shim（re-export + `python -m` CLI 入口，`docs/agents/quality-diagnosis.md` 命令不变）。
     - `reply_comparison` 的 `canonical_input`/`validate_installation_binding`/`validate_persisted_installation`（含 `_candidate_material`/`_installed_candidate_fields`/`actual_evidence_material_receipt`）提升为 `src/notalone/reply/comparison_contract.py`（174 行）；评测包反向 import 并保留旧名称，`reply/quality.py` 改从生产模块 import，`evaluation_version` 的 source identity 增加 `reply/comparison_contract.py`（摘要随代码变化，属预期版本提升）。
     - 5 处生产 import 改为 `notalone.problem_budget`（organization_quality_{transport,suite_budget}、memory_extraction/direct_adapter、memory_trace/transport，另 evaluation_http_budget 反向后同改）。
  2. **dev-only 标注**：`experiments/__init__.py` 明确「不进入产品装配、只允许 experiments/离线评测/测试 import」；`pyproject.toml` 为 `notalone-memory-evaluate`、`notalone-retrieval-evaluate` 加 dev-only 注释，注册保留未删。
  3. **0 import 模块清理**：物理删除 `application/memory_pipeline_preview.py`(112)、`application/organization_qualification.py`(68)、`front_sync/emoji_tail.py`(23)；`ledger/adapters.py`(57) 与 `media/service.py`(219) 作为纯测试替身移入 `backend/tests/support/`（若物理删除将丢失 18 处台账替身与 ADR-094 联系人级联删除的媒体擦除覆盖，故采用「移出生产包」而非删测试）。
  4. **测试同步**：删 `test_memory_pipeline_preview.py`(130)、organization quality 中依赖已删 qualification source 的 1 个用例(27)、emoji 后缀用例(15)；更新 18 处 ledger import、3 处 media import、4 处 problem_budget import/patch 路径。
- 验证：全量单测 `python -m unittest discover -s tests/unit -t .`（2498 tests）13 failures + 1 error，与改动前基线**逐条一致**（1 条 pgvector 需仓库根 `experiments` 包 + 13 条 memory_extraction 既有失败），无新增；相关目录：experiments 155（仅基线 error）、reply 465 OK、memory_extraction 1022（仅基线失败）、persistence 16 OK、application 99 OK、server 107 OK、media 1 OK、ledger 9 OK、front_sync 233 OK、tasks 30 OK、skills 56 OK；受影响的 memory 模块单测（organization_quality_suite_budget 6、identity 3、sdk_verification 13、memory_store 9）OK；`compileall src tests` OK；`pyproject.toml` TOML 解析 OK。
- 数据影响：无迁移、无产品数据写入；仅代码位置与 import 图变化；评测 CLI 与预算账本语义未改。
- 剩余风险：① 集成测试未跑（需真实 PostgreSQL）：`tests/integration/media/test_lifecycle.py` 与 `test_contact_deletion.py`（ADR-094 媒体擦除）现经 `tests/support/media_service.py` 驱动，需 CI/Lead 用测试库补验；② `reply/adapters/reply_comparison_capture.py` 仍 import `memory_extraction.evaluation_http_budget`（生产适配器→评测模块），不在本 ticket 验收内，建议后续 ticket；③ `retrieval/__init__.py` 仍急切 import 931 行评测代码；④ `front_sync/emoji_presentation_data.py` 变成生产 0 import 未删。
