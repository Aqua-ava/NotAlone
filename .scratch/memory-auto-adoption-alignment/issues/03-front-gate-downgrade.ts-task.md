# 03 前置门槛由拦截改为降级

Triage: ready-for-human
State: resolved
Blocked by: 02

按 spec.md 第 5 节实施；用户已确认：`alternatives` 自由文本降级放行（不新增人工门），低把握只记执行事件 payload（方案 A，不加表不加列）。

- `backend-ts/src/memory/sqlite/management/adjudication-actions.ts:78`（`freeze`）与 `management/actions.ts:129`（系统路径）拆分同一组条件：
  1. `memoryTimeEligibility!=='eligible'` 保持拦截；
  2. `alternatives` 全为 `AMBIGUITY_NOTE` 保持拦截，`AMBIGUITY_NOTE` 常量从 `extraction/bounded.ts:39` 导出，不复制字符串；
  3. `alternatives` 含自由文本 → 继续裁决，采纳事件 payload 记 `adopted_with_alternatives`（保留原文）；
  4. 条件无来源支持保持拦截；
  5. 事件未核实（stage_verified 假，或 occurrence_verified 假且 occurrence_start 非空）→ 按 memory-processing.md 第 4 条丢弃事件标注、正文继续、记 `time_unverified`；先写失败用例复现「整体被拦」再改。
- 手动采纳路径（用户亲自点采纳）不受此门槛约束，保持现状。

验证：`sqlite-memory-dsh-flow.test.mjs` 新增四类条件行为用例；`sqlite-memory-adjudication-evidence.test.mjs` 全绿。

## Answer（2026-11-06）

已完成并本地提交。

先核对的结论（spec 5.2 条件 4 的「先核对」）：直接提取路径的核验层**已经**实现了「事件不可采纳时丢弃标注并记 `time_unverified`」（`extraction/protocol.ts` 的 `timeUnverified` 分支，`eventAdoptionVerified`），冻结门槛第 4 条为防御代码。因此：

- `adjudication-actions.ts`：`freeze` 前置门槛拆分——只拦时间不合格、整组 `AMBIGUITY_NOTE`、条件无来源；`alternatives` 自由文本/混合文本降级放行；事件标注不可核实仍改为「丢弃标注 + 正文继续」，同时在 Basis 加 `eventTimeUnverified` 标记并在 `adjudication_result` payload 记 `time_unverified` 与 `adopted_with_alternatives`（无新表新列）。
- `actions.ts`：系统路径同口径；直发采纳（publishRun）路径在没有 authority 的采纳事务里向提取 attempt 写 `time_unverified` / `adopted_with_alternatives` 执行事件。
- 夹具：`adjudication-support.mjs` 新增 `setExtractionTransform`（改动提取候选事实），`adjudication-registry.mjs` 新增 `fixture.extractionTrace`。

验证（单元，不调用模型）：
- `sqlite-memory-adjudication-evidence.test.mjs` 13/13，含 4 个新用例：自由文本 alternatives → 自动采纳且 `adopted_with_alternatives` 留痕；全为 `AMBIGUITY_NOTE` → 仍待确认且无裁决结果；事件未核实 → 采纳且核验结果记 `time_unverified`；条件无来源 → 核验层拒绝（现行实现为 `unsupported_rejected`，强于待确认，与 5.2 的「保持拦截」一致方向，但形态不同，如实记录）。
- 相关套件 52/52 全绿（adjudication×4、verified-results、auto-switch、auto-profile、extraction-protocol、extraction-arguments）。
- 与本任务无关的存量失败仍是 `sqlite-memory-runtime`×2 与 `sqlite-memory-unknown-deletion`×1（见任务 02 的基线对照）。

## Comments
