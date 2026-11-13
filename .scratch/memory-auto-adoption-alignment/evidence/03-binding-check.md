# 证据 03：绑定状态、读取与删除闭包核对（任务 B，只读）

日期：2026-11-06。依据 `.scratch/memory-auto-adoption-alignment/followup.md` 第 3 节。方法：代码审计 + 纯合成夹具（Node 24 直接加载仓库测试夹具与真实业务代码；临时 userData 目录；假模型端口，零外发）＋ 既有测试覆盖比对。未连真实库、未改真实库、未启动桌面 App、未提交。合成脚本与日志在仓库外（`/tmp/notalone-audit/run-audit.mjs`、`/tmp/notalone-audit/audit-registry.mjs`、`/tmp/notalone-audit/out.log`），32/32 断言通过。

## 0. 结论

**主结论 A（设计如此）**：被报告为「重复导入」的「一位联系人 9436 条消息 = 两个绑定各 4718 条」不是重复导入，而是 ADR-144 来源重新认证后的存储事实：旧绑定 `revoked` 但历史消息按设计保留，新绑定 `verified` 重新读取同一物理历史。真实验收记录已写明这是预期：「增量来自新绑定与保留的旧绑定，两者并存符合 ADR-144」（`docs/verification/fenced-contact-batch-repair-20261106.md:54`，同文件 `:53` 记「旧绑定的逐联系人消息范围 0 变化」）。用户可达的读消息路径、提取目标选择、回复上下文、媒体、目录/覆盖统计都经当前 `verified` 绑定过滤；删除闭包按联系人和物理来源覆盖 `revoked` 绑定下的消息。合成夹具逐条验证见第 2、3、4 节。

**附加发现（类 B，仅开发者调试面板的统计数字）**：`history.recertifyCandidates` / `history.recertifyCandidateState` 的 `stored_message_count` / `message_total` 按联系人统计 `message` 行、未过滤绑定状态（`backend-ts/src/history/sqlite/recertify-candidates.ts:25`、`:47-53`）。当联系人「已完成过一次重新认证（`revoked`+`verified` 双绑定）之后再次被围栏」时，开发者批量修复面板的「预计需重新读取消息」口径 = 两份之和（合成验证：面板 2 vs 可见 1）。该入口只在开发模式渲染（`desktop/src/renderer/DeveloperTraces.tsx:23`，ADR-173 明确打包版不暴露），不进入任何读取、提取、删除或模型路径；当前真库是否触发取决于是否存在「重认证完成后再被围栏」的联系人，详见第 5 节。**按严格二选一口径，这是唯一把 revoked 消息算进去的路径；但它不改变主结论 A。**

## 1. 为什么可以用合成夹具复刻真库结构

- 「同一联系人同一会话两个绑定、旧 `revoked` 新 `verified`」只有一条产生路径：开发者批量/逐位来源重新认证的 Rotate（`backend-ts/src/history/sqlite/recertify-actions.ts:172-175`：旧 grant 撤销、旧绑定 `state='revoked'`、插入新 `verified` 绑定与新 grant）。
- 合成做法：用 `backend-ts/test/sqlite-clear-support.mjs` 打开真实迁移的临时库 → 旧绑定同步 1 条合成消息 → `SqliteHistoryRecertifyService.recertify` 走完整认证（合成读取渠道 + 假模型端口）→ 得到与真库同构的两绑定结构。
- 夹具事实（全部合成）：`conversation_binding` 2 行（1 `revoked`、1 `verified`）；`message` 2 行（旧绑定 1 行、新绑定 1 行，均 `availability='available'`、同 `observed_key` 同一物理消息）；这就是真库「9436 = 2×4718」的合成复刻。
- 合成测试共 32 条断言全部通过；每个阶段 `storage.check()` 均为 `{integrity:'ok',foreignKeys:'ok'}`。

## 2. 读取层：逐路径过滤条件与合成结果

统一范围定义（所有读消息查询的共同根）：

- `backend-ts/src/history/sqlite/current-scope.ts:7-16`：`current_history_ranked` 只收 `EXISTS(... conversation_binding live ... live.state='verified')` 的历史目标（`:10`、`:14`）；`:21` 的 continuity scope 同样要求绑定 `verified`。
- `backend-ts/src/history/sqlite/current-scope.ts:37-39`：`currentSourcePredicate` 把 capture_record 的 `read_goal.binding_id` 固定到当前范围绑定，并用 `observed_key` 前缀限定分片/表实例。`revoked` 绑定的 read_goal 不进入范围，其消息自然不可读。

| 路径 | 入口 file:line | 实际过滤 | 合成断言 |
| --- | --- | --- | --- |
| 历史列表/详情分页 | `backend-ts/src/history/sqlite/read.ts:228-241`（`history.read`/`history.readChat` 见 `actions.ts:346-347`） | `currentSourceScopeCTE` + `currentMessageSource`（`read.ts:7-9`）→ 只取 verified 绑定目标 | 各返回 1 条，`bindingId` = 新绑定 |
| 候选工作区近消息 | `backend-ts/src/history/sqlite/read.ts:251-258`（`actions.ts:370`） | 同上 | 返回 1 条 |
| 覆盖统计计数 | `backend-ts/src/history/sqlite/read.ts:85`（`actions.ts:332`） | `currentSourceScopeCTE` + quarantine | `messageCount`=1（库内 2 行） |
| 联系人目录消息数 | `backend-ts/src/contacts/sqlite/actions.ts:10-19`（`identity.directory` `:117-118`） | `currentSourceScopeCTE` + `currentSourcePredicate` | `data_status.message_count`=1 |
| 引用回复载体校验 | `backend-ts/src/history/sqlite/read.ts:154-184` | `JOIN conversation_binding ... qb.state='verified'`（`:172`） | 未单独合成（文本消息无引用） |
| 单条来源明细 | `backend-ts/src/history/sqlite/actions.ts:315-331` | `currentSourcePredicate` + 围栏/守卫复核 | 旧绑定来源 → `history_source_not_found`；新绑定来源 → 成功 |
| 提取目标选择 | `backend-ts/src/memory/sqlite/runs.ts:145-172`（`currentMessageRows`） | `sourceScopeCTE(tx)`（`:26-33`，当前 schema 即 `currentSourceScopeCTE`）+ `currentSourcePredicate`（`:170`） | 合成：`memory.startHistory` 目标数 = 1（库内 message 2 行） |
| 提取轮的联系人资格 | `backend-ts/src/memory/sqlite/runs.ts:178-181`（`currentRunContactScope`） | `read_grant.revoked_at IS NULL AND live_binding.state='verified'` | 同上（运行轮可建立） |
| 调度输入统计 | `backend-ts/src/memory/sqlite/schedule-inputs.ts:36-62` | `currentSourcePredicate('source','g')`（`:49`） | 未单独合成（与提取目标同源） |
| 回复上下文-本地消息 | `backend-ts/src/reply/sqlite/actions.ts:65-75`（`discussion.localMessages`） | `savedSourceScopeCTE` + `currentSourcePredicate`；saved 模式只排除 `state='revoked'`（`current-scope.ts:10,14,21,34`） | 未走完整 discussion 夹具；改用其依赖校验（下一行） |
| 回复上下文-指定消息 | `backend-ts/src/reply/sqlite/actions.ts:76-85` | 同上 | 同上 |
| 回复依赖复核 | `backend-ts/src/history/sqlite/reply-local-source.ts:4` → `source.ts:38-45`；`backend-ts/src/reply/sqlite/provenance.ts:64` | saved scope（`binding.state<>'revoked'`） | 合成：旧绑定来源 → `history_source_not_available`；新绑定 → ok |
| 回复开始的身份证明 | `backend-ts/src/reply/sqlite/requests.ts:15-30` | `b.state='verified'` + 活跃 grant + verification 代次 | 未启用回复流程（无需模型） |
| 媒体工作集/取图 | `backend-ts/src/media/sqlite/image-sync-actions.ts:35-40` | `g.binding_id=m.binding_id ... g.revoked_at IS NULL AND b.state='verified'` | 文本夹具未覆盖图片媒体，仅代码核对 |
| 媒体单条读/预览/提取 | `backend-ts/src/media/sqlite/actions.ts:21-36`（`message`/`source`）、`:97-124`（`begin` 要求 `token.binding_id=m.binding_id` 且 `assertSourceEligibility`） | 单条 API，不按联系人枚举；实际文件读取须来源资格/当前 token | 仅代码核对 |
| 助手只读通道 | `backend-ts/src/reply/sqlite/read-channel.ts:11-16` | 仅开放 `history.readRecent`、discussion/reply/deletion 只读，落到上述过滤 | 未单独合成 |

搜索：仓库没有按正文搜索消息的 SQL（对 `message` 未见 `LIKE`/`MATCH` 正文查询）；`backend-ts/src/retrieval/*` 只作用于记忆/知识候选，不扫描 `message` 表。因此不存在「搜索把两份都列出来」的路径。

## 3. 提取只取 verified 绑定（第二证据）

- 代码：第 2 节 `runs.ts` 两处过滤；目标选择读取 `message` 前先经 `currentSourcePredicate`，`revoked` 绑定的 read_goal 不在 `current_history_scope` 中。
- 合成：recertify 完成后库内 2 条 `message` 行，`SqliteMemoryExtraction.startHistory` 的 `run.total` = 1。
- 既有测试：`backend-ts/test/sqlite-history-recertify.test.mjs:276-284`（「来源认证正常关闭后，历史记忆启动…」）断言 `started.run.total` = 1；同文件 `:23-50` 断言认证期间 `history.read`/`history.readChat` 为 0、完成后只出现新绑定消息并保留旧行。与 R2「提取目标 101/101、窗口库内 202 行」一致：每个物理消息只有当前绑定的一份进入目标。

## 4. 删除闭包覆盖 revoked 绑定

文档条款：`architecture/current/privacy-deletion.md:118-133`（整联系人 `:123` 要求清除全部来源、消息、会话绑定等；单一来源 `:120`；封禁/闭包/复核/压缩 `:128-133`）；来源重新认证保留旧资料但不恢复使用资格见 `:34`（ADR-144）。

代码路径：

- 联系人范围 `backend-ts/src/contacts/sqlite/deletion.ts:27-30` 封禁（撤销 grant、`contact.state='deleting'`）；`:55-77` 收集闭包；`:93` 新绑定置 `revoked` 墓碑；`:95` 联系人置 `deleted` 并清名。
- 消息域 `backend-ts/src/history/sqlite/deletion.ts:39-44`：按 `owner+contact+accepted_data_generation` 选 capture_record，**不按绑定状态过滤**，因此 `revoked` 旧绑定的来源也在闭包内；`:101-107` 对同一代次内的全部目标统一把 message/capture 置 `deleting`；`:71-75` 生成 message/message_alias 删除目标；`:138-159` 复核要求 `scopeRows` 为空，否则整体 `blocked`。
- 单一来源 `backend-ts/src/history/sqlite/source-deletion.ts:24-42`：按 ADR-161 的已完成认证审计把「同一物理出现」的跨绑定副本映射为同一来源集合，删除时一并清除并登记无正文排除。

合成删除实跑（关键断言与结果）：

- **整个联系人删除**（先确认双绑定 + 各 1 条消息）：`DeletionService.plan` + `advance` → `state='completed'`；`history` 域 `history_rows_cleared`、`identity` 域 `identity_private_facts_cleared`、`sqlite_pages_wal` 等全部 passed。删后：`message`=0、`capture_record`=0、`read_goal`=0、`binding_verification`=0、`message_alias`=0、`history_quote*`=0、围栏/租约/认证记录=0；`conversation_binding` 2 行均为 `revoked` 墓碑；`contact.state='deleted'` 且 `display_name` 为空；`history_deletion_fence` 1 行且仅 `owner_id,contact_id,operation_id`（无正文抑制墓碑）；同 owner 下其他合成联系人的行不受影响；`storage.check()` ok。
- **单一来源删除**（删除旧 `revoked` 绑定下的物理消息）：计划阶段命中 2 条 capture_record + 2 条 message（即同一物理消息在两绑定下的两份副本）；`advance` → `completed`；删后 `message`=0、`capture_record`=0，登记 1 条无正文 `history_source_exclusion`，随后重新同步不会恢复该消息；`storage.check()` ok。

既有测试覆盖比对：`sqlite-history-recertify.test.mjs:23-50` 覆盖「保留旧消息 + 读取隔离」，但**没有**「已完成认证的双绑定 → 删除」用例；既有联系人删除测试使用单绑定夹具（如 `sqlite-history-guard.test.mjs:381-391`）；认证与删除同场出现的用例只覆盖「认证进行中/准备阶段删除、取消」（`sqlite-history-recertify.test.mjs:183-196`、`:197-208`；`sqlite-history-recertify-async.test.mjs:72-80`）。本次合成补上该缺口。

## 5. 附加发现（类 B）：开发者批量修复面板的统计口径

- 位置：`backend-ts/src/history/sqlite/recertify-candidates.ts:10-30`（候选聚合 SQL；`:25` 的 `LEFT JOIN message m ON m.owner_id=c.owner_id AND m.contact_id=c.id` 没有绑定过滤，`:11-16` 的 `count(m.id)`/图片计数据此得出）；`:47-53`（单联系人复核计数）同样无绑定过滤；`:88-94` 汇总为 `stored_message_count`/`message_total`。
- 使用面：`backend-ts/src/history/sqlite/recertify.ts:58` → `GET /api/contacts/<id>/history/recertify/candidates`（仅开发宿主注册，ADR-173 `:11`「入口只在开发模式渲染…打包版不暴露」）→ 开发者调试区面板 `desktop/src/renderer/FencedRepairBatchPanel.tsx:126` 文案「预计需重新读取消息 N 条」；渲染门 `desktop/src/renderer/DeveloperTraces.tsx:23`。
- 触发条件（合成已验证）：联系人已完成过一次重新认证（存在 `revoked` 旧绑定 + `verified` 新绑定），之后因来源连续性再次出现 `history_continuity_fence` 且仍有有效 grant。此时按联系人 `count(*)` 把旧绑定保留行也计入。
- 合成结果：同一联系人 `history.recertifyCandidates.stored_message_count` = 2、`history.recertifyCandidateState.message_total` = 2，而 `history.coverage.messageCount` = 1（当前可见消息）。即面板会把「需重新读取」显示成约两倍，形态上与真库 9436/4718 的观感一致，但它是统计口径，不是重复导入，也不进入删除计划。
- 影响面：只影响开发者面板的「预计需重新读取消息」数字与按消息数的排序；不改数据、不叫模型、不进入用户界面、不进入删除/读取决策。真实数据在 2026-11-06 验收时 3 位残留围栏联系人是「接纳阶段被拒、未 Rotate」，故当时不会触发；之后任何「已完成认证的联系人再次失稳被围栏」都会触发。
- 修复方向（本任务不执行，供 Lead 决定是否开任务）：`recertifyCandidateIdsSql` 的 message 连接加 `AND m.binding_id=b.id`（`b` 已是唯一 verified 绑定），`recertifyCandidateCountsSql` 增加 verified binding 参数并用同样条件；首修单绑定场景语义不变。`backend-ts/src/history/sqlite/recertify-actions.ts:146` 的 `preserved_message_count` 用 `count(*)` 统计全部存储行，语义上确为「保留的旧消息」（重试场景会含上一代新绑定行），建议保留但注释口径。

## 6. 未覆盖与剩余风险

- 未重复执行真实库只读查询（避免与运行中后端/WAL 交互）；真库结构证据采用已有验收记录的汇总口径（`docs/verification/fenced-contact-batch-repair-20261106.md:53-54`）。
- 媒体只做代码核对：合成为文本消息，未构造图片双绑定夹具；媒体工作集路径有 verified 过滤（`image-sync-actions.ts:35-40`），单条 API 有 token 绑定/来源资格校验（`media/sqlite/actions.ts:97-124`），但真实图片在 revoked 绑定下的可读性未实测。
- 未实测账户级删除（`scope.kind='account'`）的双绑定闭包；它复用同一 history/identity 域，本任务只实测 contact 与 source 两种 scope。
- 未实测「双绑定后再次重新认证」产生第三代绑定的场景；删除闭包以联系人代次为范围（`accepted_data_generation` 链），理论上覆盖全部代次，但未合成验证。
- 未核验记忆管理页对旧绑定引用记忆的展示/可读性（ADR-144 保旧资料但降权；属于展示语义，既非两份计数也非本次删除问题），如需可单列观察项。
- 第 5 节的开发者面板统计口径问题未修（任务要求只报告）；若真实库存在「重认证完成后再围栏」的联系人，其面板估算会偏高。
