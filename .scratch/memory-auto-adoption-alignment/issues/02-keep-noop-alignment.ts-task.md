# 02 keep 与 noop 自动条件对齐

Triage: ready-for-human
State: resolved
Blocked by: 01

按 spec.md 第 6.2、6.3、6.5 节实施。

- `adjudication-actions.ts:174-197`：`keep` 允许 `independent | supplement | historical_supplement`（两个 changed 均为假）；`add` 仍要求 `independent`；`unresolved_conflict`、核验不支持、ID 不一致、多目标、受保护仍待确认。
- `noop`：模型判 `noop`、`duplicate_memory_id` 指向 auto 且未受保护旧记忆、两个 changed 均假、旧记忆正文不比候选更少信息（确定性代理：旧正文码点长度 ≥ 候选正文长度）→ 自动 `auto_noop`；先读 `management/actions.ts` 的 `auto_noop` 分支与来源绑定，确认「并入来源」是否已有安全实现，没有就只记执行事件 `skipped_duplicate`（含重复记法与未并入的候选新来源），不改旧记忆。
- 实施前必须核对 `applyDecision` 的 `auto_noop` 校验（`actions.ts:132-145`）与引用合并路径是否兼容放宽后的 noop。

验证：`sqlite-memory-adjudication-evidence.test.mjs` 增加 `noop` 同义不同字面→自动 noop、受保护→待确认、`keep`+supplement→自动采纳、`add`+非独立→仍待确认用例。

## Answer（2026-11-06）

已完成并本地提交（f0ad57a41）。

- `adjudication-actions.ts`：`keep` 放宽为 `independent|supplement|historical_supplement`（changed 均假）；`noop` 不再要求逐字相同，改为：非保护且 auto 的目标、两处 changed 均假、旧正文码点长度 ≥ 候选正文（信息量代理）→ `auto_noop`；noop 关系覆盖仍按旧规则引用被点名旧记忆来源。候选新增来源只记 `skipped_duplicate` 执行事件（来源模型不支持向旧版本追加引用，走 spec 的最小版本），不改旧记忆。
- `actions.ts` 的 `auto_noop` 分支核对：不需要改动即可兼容（adjudication_result payload 未变、parent_memory 角色照旧、无版本路径同前）。
- 夹具支持 `kind` 参数与 `noop` 动作；新增 4 用例全绿（同义 noop 自动跳过＋事件、保护目标待确认、keep 补充自动并存、add 补充待确认），证据套件 9 用例 + 其余 22 个裁决用例全绿。

存量失败与本任务无关：`sqlite-memory-runtime.test.mjs` 2 条（模型装配）与 `sqlite-memory-unknown-deletion.test.mjs` 1 条（未知占用）在改动前基线 `63cd07410` 的对照 worktree 中同样失败，未由本任务引入，未在本任务处理。

## Comments
