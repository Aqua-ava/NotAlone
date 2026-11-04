# 历史回看与明确继续分离

Triage: ready-for-agent
State: resolved
Blocked by: 01

## 目标

把历史讨论的“回看”与“继续”拆成两个可验证的状态转换：回看只读且无副作用；只有用户明确继续某一段讨论时，才将它设为当前讨论并允许后续助手讨论使用其内容。

## 范围

- 历史目录和单段正文继续通过只读通道读取。
- 打开历史讨论只更新页面选择状态，不写 `assistant_discussion.is_current`，不刷新活跃时间，不恢复运行时，不创建模型请求。
- 继续动作必须显式、幂等，并只接受已确认联系人和该联系人范围内的讨论 ID。
- 继续成功后只把目标讨论设为当前项；同联系人其他历史讨论保持可回看，但不得自动合并。
- 继续动作本身不自动生成候选；生成仍由用户随后明确点击表达动作。
- 若现有接口无法区分回看和继续，新增专用动作，禁止让读取接口隐式切换状态。

## 测试 Seam

公开边界：助手讨论列表、历史讨论读取、继续讨论动作和当前讨论状态。

1. 打开历史讨论后断言当前讨论、活跃时间、运行状态和请求数量均不变。
2. 明确继续后断言只有目标讨论成为当前项。
3. 继续另一段历史讨论时，不携带前一段讨论内容。
4. 跨联系人或撤销来源的讨论 ID 必须被拒绝。
5. 界面刷新、复制、切换联系人不得触发继续。

## 验收

- 回看不产生任何写状态或模型副作用。
- 明确继续只切换选定讨论，且不自动生成候选。
- 讨论范围、来源失效和删除边界继续由现有合同复验。
- 相关后端与桌面测试通过；实际 App 中回看和继续两种状态分别可见。

## 不在范围

- 修改候选输入装配；由 01 完成。
- 修改历史讨论的删除语义。
- 自动继续、自动摘要或自动迁移旧讨论。

## Comments

## Answer

- 历史目录与单段正文仍只走助手只读通道；新增回归固定列表/正文读取不改变 `is_current`、活跃时间、运行副本、请求数或模型调用数。
- 明确继续改为专用 `POST /api/contacts/:contactId/assistant-sessions/:discussionId/continue`，桌面主进程同步改用该动作；旧 `/resume`、`/select` 不再作为隐式或兼容切换入口。
- `discussion.continue` 只切换目标讨论：首次切换清旧 current、把目标设为 current 并续期；重复继续同一目标是无写入幂等操作。它不创建请求、不调用模型、不恢复或改写运行副本，也不合并其他讨论正文。
- 继续前按 `owner_id + contact_id + discussion_id` 复验目标讨论及其全部实际请求依赖；跨联系人返回 `discussion_unavailable`，失效请求/来源返回 `discussion_source_unavailable`，且不改变原 current。
- 变更文件：`backend-ts/src/reply/sqlite/actions.ts`、`backend-ts/src/reply/sqlite/http.ts`、`desktop/src/main/reply/assistant-session-catalog.ts`、`backend-ts/test/sqlite-discussion-history-continue.test.mjs`（新增）、`backend-ts/test/fixtures/sqlite/discussion-history-registry.mjs`（新增）、`backend-ts/test/sqlite-discussion-host.test.mjs`，以及既有桌面会话测试/fixture 的 continue 路径适配。
- RED：实现前同一边界 2 个业务断言失败（重复继续刷新活跃时间；失效来源仍可继续）；原 HTTP 用例使用本机 `listen`，在当前沙箱直接 `EPERM`，已改为同进程调用公开 `SqliteDiscussionHttp.handle`，不使用无界等待掩盖失败。
- GREEN：`node --test --test-timeout=20000 test/sqlite-discussion-history-continue.test.mjs` 4/4；桌面会话切换/目录/空闲分段/恢复证据相关 5 个文件 24/24。`git diff --check` 通过。
- 历史阶段记录（后由最终验收取代）：未执行：`sqlite-discussion-host.test.mjs` 与既有讨论集成/候选回归需要监听本机 HTTP，本会话沙箱返回 `EPERM`；工作树没有安装 `node_modules`，测试通过只读复用主仓库依赖并屏蔽未使用的 `sharp` 原生模块，完整正式 typecheck 未作为本票通过证据。

历史阶段记录（后由最终验收改为 `resolved`）：当时 State 保持 `claimed`，等待独立审查与本票提交后的 03 集成。
