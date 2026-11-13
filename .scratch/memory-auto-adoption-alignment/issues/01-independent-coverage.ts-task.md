# 01 核对并修复独立关系证据覆盖误拦

Triage: ready-for-human
State: resolved
Blocked by: —

按 spec.md 第 6.1、6.6 节实施；用户 2026-11-06 已确认整体方案与执行顺序（先修覆盖误拦）。

- `backend-ts/src/memory/sqlite/management/adjudication-actions.ts:150-156`（`relationCovered`）与 `:173`：`relation.kind==='independent'` 时只要求证据逐字有效且至少引用一条候选来源，不再要求覆盖 `related_memory_ids` 中旧记忆的来源；其他关系类型保持现状覆盖要求。
- `backend-ts/src/memory/adoption/adjudication-dsh.ts:169-181` 裁决提示追加一句：`independent` 时 `related_memory_ids` 只列被比较的旧记忆 ID，无需编造关联；不改 schema。
- 离线核对（只读、不调用模型）：读两份副本存档输出重算原因，明细存仓库外私有目录 `evidence/`，仓库内只留计数。

验证：`sqlite-memory-adjudication-evidence.test.mjs` 新增 `independent`+证据只引候选来源→自动采纳用例；相关 `sqlite-memory-*` 套件无回退。

## Answer（2026-11-06）

已完成并本地提交。改动：`adjudication-actions.ts` 的 `relationCovered` 增加 `kind` 参数并对 `independent` 短路（不要求覆盖无关旧记忆来源），`:173` 传 `relation.kind`；`adjudication-dsh.ts` 裁决提示补一句独立关系只列被比较旧记忆；证据测试新增「独立关系仅引用候选来源即可自动采纳」用例。

真实验证：
- 单元：`sqlite-memory-adjudication*` 5 个套件 27 用例全绿（含新增用例）。
- 离线重放（不调用模型）：RX 副本本轮 3 条 `memory_relation_pending`（独立）全部改判自动采纳；3M 副本 run 917f 的 9 条（`add` 6 + `keep` 3，关系均为 `independent`）全部改判；其余原因分布不变（1 条 `memory_media_relation_pending` 维持待确认）。计数见 `../evidence/01-relation-coverage-replay.md`，明细在仓库外私有副本目录。

## Comments
