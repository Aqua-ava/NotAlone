# 新候选输入与旧讨论隔离

Triage: ready-for-agent
State: resolved

## 目标

确保任何一次“帮我表达”或“帮我想想”的新候选都不读取旧助手讨论正文，也不自动检索旧讨论片段；用户明确携入的已保存候选仍按现有合同进入新请求。

## 范围

- 审计所有候选输入装配入口，不只正常工作区入口。
- 正常工作区候选不读取 `discussion_entry` 作为候选材料。
- 旧输入合同如果仍携带讨论 entry，必须明确拒绝或过滤，不能隐式进入新候选。
- 每次候选继续使用独立运行副本，不通过旧讨论的 `current_runtime_id` 恢复 DSH Agent。
- 保留 `carriedSelectionId` 的显式携入语义：只带入用户选择的候选版本、正文实际输入和来源。
- 候选请求的冻结输入、模型 prompt 和候选依据都必须反映实际使用的材料。

## 测试 Seam

公开边界：SQLite 候选生成请求与冻结输入／候选依据。

先增加一个会在旧讨论混入候选时失败的合成回归：

1. 同一联系人创建多段历史助手讨论。
2. 发起新的“帮我表达”或“帮我想想”。
3. 断言旧讨论正文及其来源没有进入冻结输入、模型请求和候选依据。
4. 再显式携入已选择的候选版本，断言该候选及其来源仍按合同进入。

补充跨联系人与取消／失败路径：候选请求结束、取消、回看或切换联系人都不能把旧讨论带入新对象。

## 验收

- 存在任意数量旧讨论时，新候选的材料清单不包含旧讨论。
- 保留显式候选携入、来源复验、预算、删除和失败语义。
- 不改变最近 50 条聊天、关系记忆、关系文档和 Skill 的现有边界。
- 最小相关后端测试通过，并记录实际未执行的验证范围。

## 不在范围

- 修改助手讨论回看与继续的 UI。
- 修改 DSH Skill 加载流程。
- 修改 SQLite 后台任务排队和图片同步性能。
- 自动删除或压缩历史讨论。

## Answer

- 入口审计：候选输入装配只有 `candidates/http.ts` POST（正常工作区带 `workspace`，旧文字兼容入口不带）→ `candidates/turns.ts` → `reply.freezeInput` 冻结；`SqliteDiscussionTurns` 及旧讨论 HTTP 路由是助手讨论入口，不属于候选；桌面当前只发 `workspace`。实际缺口在兼容入口：`readItems` 原先把当前讨论内全部可用 `discussion_entry` 作为 `entry` 项提交，`freezeReplyInput` 只在 workspace 时跳过 entry，导致旧讨论用户/助手正文进入冻结输入、模型 prompt 与来源闭包。
- 实现（`turns.ts`）：候选只装配本次请求的显式消息（workspace 最近 50 条 / 兼容入口 20 条或显式 `contextMessageIds`），不再调用 `discussions.view` 读取讨论目录或 entry。
- 实现（`input.ts`）：`freezeReplyInput` 只冻结 `message` 项，不再查询/读取 `discussion_entry` 正文；旧输入合同的 entry 兼容槽即使被直接传入也被显式过滤（不再读取其正文，也不再从 entry 收集来源）；兼容文字入口的本次请求正文改由本次具名请求的 `queryText` 直接冻结为 `requestInput` 项，不再从 `discussion_entry` 回读；`replySourceContacts` 不再展开旧讨论 entry 的来源联系人。显式 `carriedSelectionId`、来源复验、50 条聊天/记忆/文档/Skill 预算、删除与失败语义均未改；每次候选仍由既有 `fresh` 运行副本分支保证不复用旧讨论 `current_runtime_id`，回归测试固定该事实。
- 变更文件：`backend-ts/src/reply/sqlite/candidates/input.ts`、`backend-ts/src/reply/sqlite/candidates/turns.ts`、`backend-ts/test/sqlite-reply-candidate-input-regressions.test.mjs`（新增 3 个合成回归）、`backend-ts/test/sqlite-reply-skill-loop.test.mjs`（仅一处契约适配：该单测直接调用 `reply.freezeInput` 并只传旧 entry 输入，现改为传 `queryText` 的当前请求正文；不涉及本票生产代码语义）。
- RED 证据（修复前，`node --test test/sqlite-reply-candidate-input-regressions.test.mjs` 3 失败）：① 兼容候选模型请求实际包含 `[2] entry 当前讨论早前用户发言`、`[3] entry 旧讨论助手正文-3`；② 直接传入旧 entry 的冻结输入返回旧讨论正文、缺本次请求正文；③ 失败候选的用户正文进入下一次候选请求。GREEN：同一文件 6/6；新增用例同时断言旧讨论运行副本保留且当前候选新建第 4 个运行副本、显式携入选稿正文与本次补充背景进入新请求且旧讨论四种正文均不出现。
- 命令与结果（PATH=`/tmp/notalone-node/bin`）：`node --test test/sqlite-reply-candidate-input-regressions.test.mjs` 6/6；`node --test test/sqlite-reply-candidates.test.mjs test/sqlite-reply-candidates-profile.test.mjs` 16/16；`node --test test/sqlite-reply-skill-loop.test.mjs` 14/14；`sqlite-reply-provenance` 8/8；`sqlite-discussion-model-steps` 6/6；`sqlite-reply-source-recovery` + `sqlite-memory-documents-reply` + `sqlite-reply-frozen-document-tool` + `sqlite-reply-status` 27/27；`sqlite-memory-reply-integration` + `sqlite-assistant-read` + `sqlite-reply-knowledge-integration` + `sqlite-reply-bounded-knowledge` 27/27；`sqlite-discussion-integration` + `sqlite-discussion-deletion` + `sqlite-skill-discard-deletion` 35/35；最终候选相关合集 50/50；`node node_modules/typescript/bin/tsc --noEmit` 通过。
- 未覆盖/风险：① `discussion.freezeContext` 为讨论与候选共用的存储动作，直接绕过装配塞入的 entry 行仍会写 `reply_context_item`；候选冻结已过滤其正文/来源，但该行在 dispatch 的 `inheritSources` 中仍可能产生 event_source，生产装配已不再传 entry，属防御边界风险；② `reply.sourceContacts` 当前生产未调用，已一并去掉 entry 来源展开；③ 未做桌面 UI/实际 App 验收（Lead 独占），未验证真实模型质量；④ `sqlite-adjudication-deletion.test.mjs` 7 例失败为 HEAD 既有环境问题（用 HEAD 源码副本 `/tmp/a01base` 复现，与本次改动无关）；⑤ 旧文字兼容入口仍保留（不读旧讨论），若后续决定彻底退役需另立任务。

## Comments

- 2026-11-04：当时 `State: claimed`，开始 A01；审计候选输入装配入口并先写 RED 合成回归。
- 2026-11-04：实现与合成回归完成（RED→GREEN、相关后端测试与 typecheck 通过），提交后当时保持 `claimed` 等待独立 Standards／Spec 审查，后由最终验收改为 `resolved`。
