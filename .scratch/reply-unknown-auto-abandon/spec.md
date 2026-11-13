# 回复模型调用结果未知：自动放弃，不锁联系人

决策依据：[ADR-183](../../architecture/adr/183-auto-abandon-unknown-reply-model-calls.md)（2026-11-13 用户已决定）。现行规格已同步：`architecture/current/reply-generation.md` 第 33–35 行、`backend-ts/src/reply/sqlite/candidates/README.md` 第 7 行。本文件只描述实现方案与验收约束。

## 1. 问题与证据

模型请求发出后连接中断／超时／应用被打断，调用记为 `unknown`，该联系人此后所有新请求被拒绝（`discussion_call_unknown`），没有任何路径解除；界面「核对原请求」只读本机记录。

- 门禁：`backend-ts/src/reply/sqlite/requests.ts:52`，同联系人存在 `model_operation.state IN ('in_flight','unknown') AND commit_forbidden_at IS NULL` 即拒绝。
- 回复域唯一设置 `commit_forbidden_at` 的是删除 fence（`model-deletion.ts:48`）；没有用户或系统动作能封存。
- 进程内结算：`generation.ts:191-192` 超时／取消后调用 `discussion.failCall`；`model-actions.ts:210-226` 把已派发的 `sending` 调用改成 `unknown`，operation 与 `operation_scope` 也记 `unknown`。
- 重启恢复：`host-runtime.ts:30` 调 `discussion.recover`；`model-actions.ts:62-85` 把中断时 `sending` 的调用固化为 `unknown`，且只处理 `reply_attempt.state='running'` 的尝试，所以已经停在 `unknown` 的存量不会被清。
- 迟到结果拦截已有：`model-actions.ts:19` 要求 `commit_forbidden_at IS NULL`，封存后返回 `discussion_call_invalidated`。
- 先例：记忆侧 `backend-ts/src/memory/sqlite/unknown-recovery.ts`（调用记 `failed/unknown_abandoned`，`settlement_state` 保持 `unknown`）。该表组合合法：`model_call.state` 允许 `failed`，`settlement_state` 允许 `unknown`（`memory/sqlite/schema.ts:113-117`）。

## 2. 目标行为

已派发、未收到最终结果，且**本机确认不再有在途调用**时自动放弃（只有两个时点）：

1. `failCall` 结算时（本进程内调用已被取消／超时／断开）。
2. 启动 `recover` 时（含升级前遗留的存量 `unknown`）。

放弃 = 同一事务内：

| 对象 | 变化 |
| --- | --- |
| `model_call`（原将变 `unknown` 者） | `state='failed'`，`error_code='unknown_abandoned'`，`settlement_state` 与回执保持 `unknown`；保留已写入的安全 failure 证据 |
| `model_operation` | `state='sealed'`，`commit_forbidden_at=COALESCE(commit_forbidden_at, now)` |
| `operation_scope` | `state='released'` |
| `reply_attempt` / `reply_request` | 保持现有终态（`failed` / `cancelled`），`reply_attempt.error_code` 仍是原因（如 `discussion_generation_timeout`、`runtime_interrupted`），不新增请求级错误码 |

结果：`status` 返回 `phase='failed'`、`sent=true`、`retryable=true`；联系人可用**新请求身份**重新生成；旧请求迟到结果被拒收；原请求不重发。

未派发（`dispatched=false`）的失败保持现状（调用 `failed/settled`，operation `failed`，不封存）。

## 3. 硬约束（不得违反）

1. 不自动重发原请求，不沿用原请求身份重试。
2. 成本仍记未知：放弃后的调用在 `usage-summary.ts` 里必须仍计入 `authorizedUnconfirmedCalls`，不得并入已确认成本；回执不得被清空或改写成 settled。
3. 只改状态字段：不删除、不改写任何候选、聊天、记忆、回执正文；不新增迁移、表或列。若约束或触发器使上述状态组合非法，停下来报告，不自行加迁移。
4. 不得放行真正在途的调用：当前运行时仍在跑的 `in_flight` 继续被 `requests.ts:52` 拦截并发请求；`recover` 的存量扫描只处理不属于当前 `runtime_id + storage_epoch` 的运行中尝试遗留。
5. 不保存供应商请求编号，不向服务商查询（见 ADR-183 拒绝的方案）。
6. 不改记忆侧（`backend-ts/src/memory/**`）的任何逻辑；记忆侧「放弃未知并重试」继续需要用户二次确认。只读参照。
7. 不新增手动「放弃」按钮或确认弹窗；不超时自动放行后保留 `unknown` 阻断。
8. 保留错误码 `discussion_call_unknown` 不改名（仍用于真正在途的并发拦截），只改它的用户文案。
9. 删除路径不退化：被放弃的调用／operation 仍在 `model-deletion.ts` 的删除闭包内，联系人／来源删除能完成；本机仍在途的调用仍被删除流程等待。
10. 联系人、owner 隔离：放弃只作用于对应 `owner_id` 与该请求所属 operation，不影响其他联系人。
11. 幂等：`recover` 与 `failCall` 重复执行不改变已封存的数据（`commit_forbidden_at` 不被覆盖）。

## 4. 改动清单

后端（`backend-ts/src/reply/sqlite/`）：

- `model-actions.ts`：抽一个内部函数（如 `abandonUnknown(tx, ownerId, operationId, now)`），在 `failCall` 与 `recover` 两处复用，替代「写 `unknown`」的分支；`recover` 另加存量扫描（`purpose='discussion'`、`state IN ('in_flight','unknown')`、`commit_forbidden_at IS NULL`、`reply_request_id` 非空、且其请求下没有属于当前 runtime/epoch 的 `running` 尝试）。
- 其余调用点（如 `candidates/actions.ts:65-67` 的 `status`、`:140` 的 `generationState`）预期无需改，但要用测试证明输出为 `failed`、`sent=true`、`retryable=true`。
- 不改 `requests.ts:52` 的门禁条件；只为它补测试。

桌面（`desktop/`）：

- `src/main/reply/sqlite-reply-candidates.ts:6`：改 `discussion_call_unknown`（现为「已有模型调用结果未知，请先核对原请求，不能换请求重发」，改为「已有生成仍在进行，请等待结束后再试」）、`runtime_interrupted`、`discussion_generation_failed` 等引导「核对原请求」来解除未知的文案。
- `src/renderer/SqliteReplyCandidatesPanel.tsx:13-17、176-177、226、236`：已发出且已放弃的失败（`sent=true`）显示「已发出但没有收到结果，已自动放弃；可重新生成，旧请求可能已产生费用」，并给出「重新生成」；`unknown` 分支改为不再出现「不能换身份重发」。「核对原请求」按钮仍保留给「仍在准备」与「状态暂不可读」。
- `src/shared/sqlite-reply-candidates.ts:16、87`：枚举值 `unknown` 保留（容忍旧数据），不删。
- 桌面端没有独立持久化的未知阻断：`generationBlock` 是联系人确认门禁，与本问题无关，不要动。

测试里编码旧规则的两处必须改写（不是删掉）：

- `desktop/tests/sqlite-reply-candidates.test.mjs:535`（「模型结果未知时不能换请求重发」）改为：`status` 返回 `phase='failed'、sent=true、retryable=true` 时显示自动放弃文案，「重新生成」可用并以**新 requestKey** 发起 `generate`。
- `desktop/tests/sqlite-reply-candidate-bridge.test.mjs:121`：断言新文案。

文档收尾：实现与验证完成后，把 ADR-183「状态」与「实现状态」改为已实现并写明实际验证范围；`reply-generation.md` 与 `candidates/README.md` 里「实现状态见该 ADR」的提示保留。

## 5. 测试计划（先红后绿）

后端新增 `backend-ts/test/sqlite-discussion-unknown-abandon.test.mjs`，夹具方式参照 `sqlite-discussion-generation.test.mjs`、`sqlite-discussion-failure.test.mjs`；合成数据，不用真实资料。

1. `failCall` 已派发：调用 `failed/unknown_abandoned` 且 `settlement_state='unknown'`；operation `sealed` 且 `commit_forbidden_at` 非空；scope `released`；随后同联系人用新 requestKey `begin` 成功。
2. `failCall` 未派发：行为与现状一致（operation `failed`，未封存）。
3. `recover`：遗留 `running` 尝试、`sending` 调用 → 同第 1 条结果。
4. `recover` 存量：构造升级前形态（尝试 `failed`、调用 `unknown`、operation `unknown`、scope `unknown`、`commit_forbidden_at` 空）→ 恢复后封存，`begin` 成功。
5. 在途不误伤：当前 runtime/epoch 下的 `running` 尝试与 `in_flight` operation 不被扫描清掉，`begin` 仍返回 `discussion_call_unknown`。
6. 迟到结果：封存后对该调用执行提交类动作返回 `discussion_call_invalidated`，不产生候选行。
7. `status`：放弃后 `phase='failed'`、`sent=true`、`retryable=true`、`errorCode` 为原因码。
8. 成本：扩展 `model-usage-summary.test.mjs`，放弃调用仍计入 `authorizedUnconfirmedCalls`，不计入已确认调用与已知成本。
9. 删除：扩展 `sqlite-discussion-deletion.test.mjs`，含已放弃调用的联系人／来源删除能完成，闭包不遗漏。
10. 幂等与隔离：重复 `recover`／`failCall` 不改变结果；联系人 A 的放弃不影响联系人 B。
11. 回归：`sqlite-memory-adjudication-unknown-recovery.test.mjs` 保持通过。

桌面：改写上面两处测试，并确认面板在 `phase='failed'` 且 `sent=true` 时的文案、按钮状态和新 requestKey。

## 6. 验证阶梯与命令

1. 单用例：`cd backend-ts && node --test --test-name-pattern="<名称>" test/sqlite-discussion-unknown-abandon.test.mjs`。
2. 相关模块：`cd backend-ts && node --test test/sqlite-discussion-*.test.mjs test/model-usage-summary.test.mjs test/model-scope-deleted.test.mjs test/sqlite-memory-adjudication-unknown-recovery.test.mjs`。
3. 桌面：`cd desktop && npm run typecheck`，再按 `desktop/tests/README.md` 跑受影响的两个测试文件。
4. 全量 `npm test` 仅在改动触及共享模块时运行，用 `perl -e 'alarm 600; exec @ARGV' --` 限时；输出用 `(set -o pipefail; … 2>&1 | tail -60)` 裁剪并保留退出状态。
5. 提交后：`node scripts/check_public_history.mjs --ref HEAD --working-tree`。

## 7. 桌面验收

- 先 `cd desktop && pnpm run dev:status`，复用热更新实例；Agent 的验收用独立合成资料目录：`pnpm run dev -- --user-data-dir <独立合成目录>`，不得终止用户的实例，不打包、不运行打包版。
- 不读取真实聊天，不向微信或任何外部渠道发送消息。真实服务商的「未知」难以人为触发：用合成存储夹具把联系人置于升级前的卡住形态，启动后验证联系人可重新生成；无法覆盖的部分在报告里列为验收缺口，不用单元测试结论冒充端到端。

## 8. 范围外

手动放弃按钮；向服务商查询结果；保存请求编号；记忆侧未知回执处理；`discussion_call_unknown` 改名；任何数据库迁移；`AssistantSessionPanel` 的 `unconfirmed` 预算状态（另一概念）。

## 9. 完成定义

- 第 5 节全部用例通过，第 6 节命令已执行并如实报告。
- 联系人卡住的存量形态启动后可重新生成（合成夹具证明）。
- ADR-183 状态更新为已实现，且只写实际验证过的范围。
- 本地提交只含本任务变更；`git push` 与 PR 须用户同意。报告数据处理影响（仅状态字段）、实际命令、剩余风险（含「旧请求可能多计一次费用」）。
