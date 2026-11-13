# 11 本人候选没进裁决，且被统一标成「歧义待确认」

- 事实（run `902ca95f`）：联系人任务 22 个提取核验 + 23 个裁决 + 22 个关系核验，16 条自动采纳；本人任务只有 1 个提取核验步骤，产出 33 条候选，**没有任何裁决／关系核验步骤**，任务停在 `awaiting_decision`。
- 两边走同一套代码（`adjudication-service.ts` 的 `publish` 逐候选 `claim`→裁决→关系核验→自动采纳）。本人这边 `claim` 对 33 条都返回 null 并被 `continue` 静默跳过，没有记录原因（`adjudication-actions.ts` 只对 `memory_conditions_pending` 和歧义两个码留痕，其他门槛码如 `memory_verification_pending`、`memory_adjudication_pool_limit` 等不留痕）。具体是哪个码未确认。
- 误标：界面原因由 `management/read.ts` `pendingDerivation` 按 `produced_attempt_id` 查「门槛事件」，而门槛事件每个 attempt 只记一条（`recordCandidateGate` 已有同 kind 就 return）。33 条本人候选共用 1 个 attempt，于是全部显示 `memory_ambiguity_unconfirmed`。离线用 `ambiguitySignal` 复核，33 条里只有 4 条（`这个`×2、`这些`、`他`）真命中歧义规则；联系人侧 1 条命中（`他`）。
- 修复方向：门槛事件按 candidateId 匹配（payload 里已有 candidateId）；claim 返回 null 时记录具体门槛码；查明本人任务为何整体不进裁决。
- 关联：06（本人候选待决定）、10（原因无文案）。

## 根因（已用只读 dry-run 复现，库副本已删除）
- 在库副本里对 33 条本人候选逐条调用裁决 `claim`（事务内回滚）：30 条抛 `memory_source_stale`，3 条真命中歧义；联系人那 1 条命中歧义。
- `memory_source_stale` 来自 `freeze` 构建「同范围对比池」时的 `requireVersion`→`requireSources`（`qualification.ts:28`，无可用引用即报）。本人范围对比池里有 1 条既有 active 本人记忆（来自另一联系人，4 条引用），它的 4 条来源消息全在 `revoked` 绑定的旧副本上，已不是当前有效来源，引用被过滤成空。
- `adjudication-service.ts` 的 `publish` 把 `memory_source_stale` 当作「跳过本候选」静默 `continue`，于是**任何联系人的本人候选都会被这条失效的旧本人记忆挡住**，且不留原因。
- 与 01（已撤销绑定的重复副本）同源：旧副本绑定撤销后，依赖它们的记忆没有同步失效或迁移。
- 修复方向：绑定撤销／副本退出时让依赖它的记忆失效或转引用当前副本；对比池遇到来源失效的记忆应跳过该记忆而不是拖死整个范围；跳过时记录具体原因。

## 修复与补跑结果（2026-11-08，本地提交 b19e5ad3a、54c3b1bf0）
- b19e5ad3a：对比池跳过来源失效且未保护的 active 自动记忆。
- 54c3b1bf0：新增 `POST /api/memory-processing/contacts/{id}/readjudicate`，只让该联系人遗留待处理候选所在的最近一轮重新裁决；受总开关约束，无遗留时拒绝。UI 尚未接按钮。
- 对王威补跑：本人候选 33 → 28 条自动采纳，剩 5 条待确认（含歧义与 `memory_relation_evidence_incomplete`）；联系人侧 1 条歧义待确认。其他联系人 run 数不变（97），未触发 L2。
- 补跑时为防 L2 全局调度，临时把 7 条已过期的 L2 调度行 `due_at` 顺延 10 年，跑完已按原值恢复（本地记录在会话临时目录）。`.env` 已恢复；开发实例仍在 manual 模式，重启后回到 automatic。
- 仍待办：被跳过时不留原因；其他 stale 类静默跳过；L2/L3 尚无按联系人触发的入口；13 张图片仍未纳入（受第 09 条限制，现在可再试 startHistory）。
