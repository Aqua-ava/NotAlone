# 被围栏联系人的同步修复：单个试修与开发者批量修复

> 状态：方案已写定，待执行。决策已由用户确认：批量入口只放开发者调试区；范围为全部被围栏联系人。
> 日期：2026-11-05。证据均来自本机开发库的只读计数查询，不含任何聊天内容或联系人名称。
> 任务单：[issues/](issues/)（01–05）。读者：接手实现与验收的 Agent。

## 1. 背景与现状证据

### 1.1 现状（2026-11-05 22:10 前后只读查询）

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 活跃联系人 | 281 | 另有 7 位已删除 |
| 带 `history_continuity_fence` 的联系人 | 279 | 原因码全部是 `history_source_continuity_unverified`；且都有有效读取授权 |
| 有图片消息的联系人 | 149 | 其中 147 位被围栏（6708 条图片消息），2 位未被围栏（182 条） |
| 图片消息总数 | 6890 | 全部 `availability=available` |
| 已保存的图片（`media_file` 当前 `image_display`） | 206 | 全部属于被围栏联系人，是围栏出现前存下的 |
| `message_media` 行数 | 1900 | 即约 4990 条图片消息从未尝试过取图 |
| 图片取图尝试（`extract`）按结果 | completed 206；`media_association_unverified` 2593；`history_source_unverified` 127；`media_thumbnail_only` 18；其余少量 | 前者大多来自缺数据库密钥期间，见 `docs/verification/image-pick-standard-20261105.md` |
| 最近一次图片尝试 | 约 17:48（本机时间） | 此后到 22:10 没有新增，包括换上新读取程序重启之后 |

### 1.2 围栏的后果

- 取图：`media.imageSyncTargets` 的工作集 SQL 明确排除带围栏的联系人（`backend-ts/src/media/sqlite/image-sync-actions.ts` 中 `NOT EXISTS(... history_continuity_fence ...)`）。所以这 147 位联系人的图片一张也不会被取。
- 同步：同步页文案为“N 位联系人的聊天来源待重新核验，已保存的聊天不受影响”（`desktop/src/renderer/HistoryCoverageStatus.tsx` 约 185–201 行）。按代码与文案推断，围栏联系人**不再读取新内容**，只能查看已保存的聊天。这一条是推断，实现 Agent 须在任务 01 里用实测确认。
- 围栏不会自行消失。清除只有一条路径：对该联系人执行“来源重新认证”（界面叫“修复同步”），见 1.4。

### 1.3 围栏怎么来的（已知与未知）

- 创建点在 `backend-ts/src/history/sqlite/continuity.ts` 的 `fenceContinuity`，调用方在 `backend-ts/src/history/sqlite/actions.ts`：
  1. `history.guardAcquire`：已有守卫记录但不是“同一运行实例、同一绑定、同一来源代次的 active 守卫”（约 112–121 行）；
  2. `history.guardAcquire`：旧数据没有持久守卫记录但已有 `read_goal`（约 122 行）；
  3. `history.guardRelease`：释放时 `normalUse !== true` 或 `sourceLost === true`（约 138 行）；
  4. `history.markContinuityLost`：当前来源与记录的来源代次一致时被标记失证（约 143 行）。
- 含义：围栏防的不是“聊天数据变多或被删”，而是“读取程序有没有一直盯着微信数据文件”。读取程序被意外关闭、微信数据库被重建或换账号、上次的守卫没有被正常放下，都会触发。
- 已知的一个大来源：2026-11-05 之前，一张图片取失败会让原生客户端关闭**共享读取进程**，所有已读完联系人的守卫随之失效（`docs/verification/image-open-isolation-20261105.md`）。新读取程序 `image-open-local-20261105-v1`（2026-11-05 22:00 已启用）修复了这点，只对已查证的单图错误保留进程。
- 其他可能：2026-11-03 微信重建了 `message_resource.db` 并换盐；开发 App 的热重启；其他会话在工作树里反复改源码导致重启。
- **成因没有被证实**：围栏表只有 `reason`，没有时间戳或触发点。2026-11-01 的验收曾把围栏清零（285/285 完整覆盖，见 `docs/verification/source-recertification-20261101.md`），当时就观察到“有围栏出现但原始失证输入缺失”。任务 02 负责尽量查明。

### 1.4 现有“修复同步”

- 界面：联系人页，选中联系人后，“清理聊天资料”下面的“修复同步”区块；只有被围栏时才出现（`desktop/src/renderer/HistoryClearPanel.tsx`，`showRepair`/`repairNeeded`）。
- 链路：`HistoryClearController.recertify`（`desktop/src/main/history-clear/controller.ts`）→ `POST /api/contacts/:id/history/recertify {request_key}`（短时返回接纳状态）→ 后台 `SqliteHistoryRecertifyService`（`backend-ts/src/history/sqlite/recertify.ts`）→ 之后按同一 `request_key` 用 `GET .../recertify?request_key=` 查进度，`POST .../recertify/cancel` 取消。
- 阶段：`metadata`（核对账号和联系人）→ `history`（重新读取并检查全部可读历史，暂存）→ `activation`（原子启用）→ `completed`。成功后 `onCompleted` 调 `firstHistory.wakeContact(id)`，交回普通同步（`backend-ts/src/sqlite-host-plugin.ts` 约 232 行）。
- 保护（不能改）：旧消息、原始来源、记忆、助手结果保留；删除排除、清空边界、撤回终态继续生效；失败或中断保持停读；不触发模型、不提取媒体（ADR-144）。
- 耗时参考（2026-11-01）：一个 8306 条旧消息的大范围，376.9 秒、305 批；另一次同类大范围在 138.8 秒时因热重启以 `history_native_closed` 安全失败。**修复期间发生热重启会让该次失败。**

## 2. 为什么需要这件事（回答“为什么要批量修复”）

1. 被围栏的不只是取图，还有新内容的读取。279 位联系人里绝大部分处于这种状态，等于大部分联系人没有在同步。
2. 逐位手工点“修复同步”不现实：279 位，每位要等重新读取全部历史，大的要几分钟。
3. 这是一次性清理历史遗留，不是日常功能。成因若是已修复的共享进程缺陷，以后正常用户不会再碰到。因此批量入口**只放开发者调试区、只在开发模式出现**，不进入普通用户界面，也不进入打包版。
4. 批量只是“替你一位位点，并在失败时安全停下”，仍走同一条修复流程，不绕过任何保护。

## 3. 范围与非目标

范围：

- 第 1 步：对 1 位被围栏联系人手工执行“修复同步”，量出耗时并验证“修好后图片会自己取出来”。
- 第 2 步：做开发者批量修复，一次确认，按序对全部被围栏联系人逐位修复，可停止、可重跑。
- 查明围栏成因（任务 02，不阻塞 1、2）。

非目标（不在本次范围，除非用户另行决定）：

- 直接删除围栏行、改写守卫、绕过认证。规格明确禁止（`architecture/current/privacy-deletion.md` 第 34 行、`wechat-sync.md` 第 43 行）。
- 自动修复（无人确认就修）。需要改规格，用户未同意。
- 重置图片取图的退避时间。见 9。
- 让普通用户看到批量入口。
- 修改读取程序（Go）、图片转换组件、记忆处理。

## 4. 必须遵守的硬边界

- 读取只在用户已授权的范围内；每位联系人修复前由后端复验当前账号、稳定会话与读取资格（`contacts.validate`）。同步总开关关闭或授权撤销时，批量立即停止。
- 联系人范围数据按 `owner_id + contact_id` 隔离；批量只是循环调用现有按联系人接口，不新增跨联系人读写。
- 不读取或展示聊天正文。日志、状态、测试夹具只含联系人 ID（日志里使用哈希或序号）、计数、阶段与原因码。联系人显示名只可出现在开发者调试面板里，不写日志、不写仓库。
- 不发送任何外部消息；不调用模型；修复本身不提取媒体。
- 不得删除或改写 `history_continuity_fence`、`history_guard_lease` 等表来“修复”；一切只能走 `history/recertify`。
- 开发运行只用 `pnpm run dev`（先 `cd desktop && pnpm run dev:status` 复用已有实例）。不得打包、不得运行打包版（见根 `AGENTS.md` 桌面运行硬约束与 `docs/agents/engineering.md`）。
- 新增文档、界面文案与注释用中文；标识符、路径与协议字段保持英文。
- 只提交本任务产生的变更；任何 `git push` 先取得用户同意。`.scratch/` 已被 `.gitignore` 忽略，本目录文件不会被提交，验收记录写进 `docs/verification/`（计数与原因码，无私人数据）。

## 5. 第 1 步：单个联系人试修

目的：（a）量出一位联系人修复所需时间与阶段；（b）确认修好后，该联系人的图片会被后台自动取出；（c）暴露批量方案还没考虑到的问题；（d）验证围栏联系人此前确实“不读新内容”。

### 5.1 前置检查（Agent 执行并记录）

1. `cd desktop && pnpm run dev:status`：应为 `development` 且只有一个监督器。没有则按 `docs/agents/engineering.md` 用 `nohup pnpm run dev > <日志> 2>&1 & disown` 启动，并用有界等待确认就绪。
2. `~/Library/Application Support/NotAloneDesktop/backend-launch.json` 的 `wechatCliPath` 应指向 `.../.notalone-builds/image-open-local-20261105-v1/bin/wechat-cli`（2026-11-05 22:00 已切换，备份为 `backend-launch.json.before-image-open-local-20261105`）。
3. **确认没有其他会话在改同一工作树的源码**。热重启（日志出现“源码已更新，等待 App 安全退出后重启…”）会打断修复，导致 `history_native_closed`。2026-11-05 22:00 前后另一个会话（记忆提取）曾每 1–2 分钟触发一次重启。发现正在重启时，等它停下或先让该会话暂停改动，不要硬跑。
4. 记录“修复前”基线（只读，计数）：
   - 该联系人的消息数、原始出现数、图片消息数、已保存图片数、`message_media` 行数、已有图片尝试按结果分组；
   - 全库 `model_call` 行数（修复前后应一致）；
   - 该联系人是否在 `history_continuity_fence`；最近一次 `history_source_recertification` 记录。
   只读命令统一用 `sqlite3 -readonly "$HOME/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite"`，**外包 `perl -e 'alarm 100; exec @ARGV' --` 做时间上限**。相关子查询在这个库上会很慢（曾超过 120 秒），只写“按主键或联系人 ID 过滤 + 分组计数”的简单查询，必要时先建 `CREATE TEMP TABLE`。

### 5.2 选哪位联系人

标准（不写名字，由用户在界面里选定并告知 Agent）：

- 被围栏、有效授权；
- 图片消息多，且大部分**从未尝试取图**（无 `media_extraction_attempt`），这样修好后立即“到期”，能很快观察到结果；
- 历史不太长（试修要尽快跑完）。作为参考，2026-11-05 的数据里存在“图片 150–250 张、总消息约 700–2500 条”的合适对象，也有图片近千但总消息两万的大对象，不宜做第一位。
- 若已有某位联系人的图片曾失败过（有退避），不选它，退避最长 24 小时会干扰观察。

### 5.3 步骤

1. 用户在联系人页选中该联系人，打开“修复同步”，点“修复同步”，在确认弹窗里点“确认修复同步”。（Agent 没有桌面操作工具时，只能由用户点；Agent 做前后观测。）
2. 修复期间 Agent 每隔一段时间（有界等待，不要紧循环）读 `history_source_recertification` 里这位联系人最新一行的 `state/stage/failure_code`，并记录各阶段起止时间、`message_count/non_text_count/page_count`。
3. 状态为 `completed` 后，立即再读：围栏是否消失；`history_guard_lease` 状态；同步页是否不再显示这位联系人为“待重新核验”；覆盖是否 `complete`、增量是否 `ready`。
4. 观察图片：每 1–2 分钟读一次该联系人在“修复完成时刻”之后新增的 `media_extraction_attempt`（按 `state, error_code` 分组）与新增 `media_file`。最长观察 15 分钟。
5. 对照“修复前”基线，核对所有保留项（见 5.5）。
6. 写 `docs/verification/fenced-contact-repair-20261105.md`（计数、耗时、阶段、原因码；不含名称与正文）。

### 5.4 通过标准

- P1 修复 `completed`，围栏行消失，同步恢复（覆盖 `complete`，增量 `ready`）。
- P2 修复完成后 15 分钟内，该联系人出现新的图片尝试；至少部分成功保存。若出现从未见过的错误码，逐个记录，不要自行放宽。
- P3 无模型调用：`model_call` 行数不变。
- P4 旧资料不丢：消息数、原始出现数、别名数、终态数都不少于基线；失效的删除/清空保护数不变。
- P5 修复期间没有热重启；若有，本次作废，重做。
- P6 记录实测耗时与每万条消息耗时，供批量估算。

### 5.5 失败时怎么办

- 状态 `failed/interrupted`：记录 `failure_code` 与阶段；对照 `desktop/src/shared/history-clear-bridge.ts` 的 `historyRecertifyFailureMessage`；若是 `history_native_closed`，先查是否有热重启，再重试一次；其他码不要重试到成功为止，先写入记录并停下来问用户。
- 修好但没有新图片尝试：先查是否真的到期（这位联系人是否有未到期的退避）、图片协调器是否被唤醒（见 6.6）、读取程序进程是否存在；这是批量方案的关键风险，务必查明再进入第 2 步。

### 5.6 这一步的产出

- 一份验收记录（5.3 第 6 项）。
- 对第 2 步参数的建议：单位耗时、停滞看门狗阈值（6.4）、默认 `limit`。

## 6. 第 2 步：开发者批量修复

### 6.1 设计原则

1. 只做“替用户逐位点现有修复”：每位联系人走现有 `history/recertify` 三个接口，不新增绕过路径。
2. 一次确认，覆盖弹窗里列明的联系人集合（数量与排序规则写明）。每位联系人后端仍独立复验。
3. 严格串行，一位完成（或确定失败）再下一位。共享读取进程本来就用排他租约串行切换联系人，并发没有收益且放大风险。
4. 可随时停止；中断后重跑只会处理“仍被围栏”的联系人，天然幂等。
5. 出现全局性问题就整体停下，不对 279 位逐个撞同一堵墙。
6. 只在开发模式出现；打包版不暴露 IPC，也不渲染面板。

### 6.2 候选集与排序（后端只读聚合）

- 候选集 = 当前 `contact.state='active'`、有有效读取授权、且存在 `history_continuity_fence` 的联系人。
- 来源以后端为准，不要从渲染进程的 `issue==='source'` 反推（那个只是展示用，且条件更窄）。
- 先核实现有“同步状态”接口是否已给出被围栏联系人列表；没有就在后端新增只读接口（建议 `GET /api/history/recertify/candidates`），只返回：联系人 ID、是否围栏、`stored_message_count`、`image_message_count`、`image_unsaved_count`；不含名称、不含正文。查询要走索引（见 5.1 第 4 点的性能教训）；用 `EXPLAIN QUERY PLAN` 核对，必要时先对联系人逐个小查询，不要一条大相关子查询。
- 排序：`image_unsaved_count` 降序，其次 `stored_message_count` 升序（同样图片数下先修短的，更快见效）。
- 弹窗显示：候选总数、其中有未保存图片的数量、预计总消息数；不显示名称。

### 6.3 编排器

位置：桌面主进程，新模块 `desktop/src/main/history-clear/recertify-batch.ts`；通过 `BackendHost.requestJson` 调现有接口（参考 `controller.ts` 的 `recertify`/`cancelRecertify`/`read` 与 `recertifyView` 的严格校验，可直接复用其解析函数，必要时抽成共享小模块，不要复制）。不放在 `HistoryClearController` 里，因为那个控制器与“当前选中的联系人”绑定。

状态机（单例，内存）：`idle → confirming（仅渲染进程）→ running → stopping → finished`，另有 `interrupted`（见 6.6）。公开状态（不含名称与正文）：

- `batchId`、`phase`、`total`、`completed`、`failedByCode: Record<code, number>`、`skippedByCode`、`alreadyFixed`、`current: { index, stage, messageCount, pageCount, startedAt } | null`、`startedAt`、`finishedAt`、`stopRequested`、`limit`。

每位联系人的流程：

1. 取当前候选快照（启动时一次，之后每位处理前用 `GET .../recertify` 的 `state` 与后端候选接口复核仍被围栏；已不再围栏的计 `alreadyFixed` 并跳过，这就是“幂等重跑”）。
2. `request_key = "batch-" + batchId + "-" + 序号 + "-" + contactId`，须满足 `/^[A-Za-z0-9_.:@-]{1,200}$/`；`batchId` 取 `yyyymmddHHMMSS` 加 4 位随机，保证总长度 ≤ 200。
3. `POST .../history/recertify`，等待接纳。响应丢失按现有约定只用同一 `request_key` 的 `GET` 查询，**绝不换键重发**。
4. 轮询 `GET ...?request_key=`（初始 2 秒，逐步退到 5 秒；不要更短），直到 `completed/failed/interrupted`。
5. `completed`：计数、短暂停（不超过 1 秒让出事件循环即可），进入下一位。是否等“普通同步接回”再继续不是必须；但每修完 5 位或批量结束时，读一次汇总状态记录（覆盖 `complete` 的数量）。
6. 失败按 6.4 分类。

### 6.4 失败分类与熔断

下表码取自 `desktop/src/shared/history-clear-bridge.ts` 的 `historyRecertifyFailureMessage` 与已见数据，**实现 Agent 须对照 `backend-ts/src/history/sqlite/recertify*.ts` 实际可能返回的全部码补全，未知码按“联系人级失败 + 计数”处理，连续 3 个未知码则整体停止。**

| 类别 | 码 | 处理 |
| --- | --- | --- |
| 已不需要 | `history_recertify_not_required` | 计 `alreadyFixed`，继续 |
| 联系人级，跳过 | `history_recertify_source_changed`（旧资料无法可靠对应，必须人工处理）、`history_recertify_deletion_pending`、`history_no_active_binding`、`history_recertify_stale`、`read_eligibility_stale`、`history_recertify_page_limit`、`history_recertify_incomplete`、`history_recertify_already_running` | 记录码，继续下一位；`already_running` 时先只读等待其结果 |
| 联系人级，可能是瞬时的 | `history_source_continuity_unverified`、`history_source_not_available` | 记录并继续；**连续 3 位出现同一码即整体停止**（说明是微信未运行、数据库密钥缺失等全局问题） |
| 连接级，整体停止 | `history_recertify_interrupted`、`history_recertify_cancelled`、`history_native_closed`、后端连接代次变化 | 批量以 `interrupted` 结束，不自动恢复（见 6.6） |
| 授权级，整体停止 | `read_not_authorized` | 立即停止；同步已关闭或授权已撤销 |
| 能力级，整体停止 | `history_recertify_guard_required` | 读取工具不支持，停止 |
| 程序错误，整体停止 | `history_recertify_request_conflict`、回包格式校验失败 | 停止并提示 |

停滞看门狗：某位联系人在 `running` 状态下，`page_count` 与 `message_count` 连续 10 分钟无变化，调用 `.../recertify/cancel`（同一 `request_key`），确认终态后计为联系人级失败并继续。10 分钟是起始值，按任务 01 的实测调整。

### 6.5 与其他操作互斥

- 批量运行时，联系人页的单个“修复同步”、“清空已保存的聊天”、“重新同步”按钮禁用并说明原因；批量开始前若有联系人正在单独修复/清空/重读，拒绝开始。
- 联系人删除进行中不开始；某位联系人在批量中被删除，后端会返回 `history_recertify_deletion_pending` 或 `read_eligibility_stale`，按 6.4 跳过。
- 用户中途关闭同步总开关，后端返回 `read_not_authorized`，批量停止。
- 批量运行时不得再触发另一个批量。

### 6.6 重启与断连

- 开发 App 的热重启会让当次修复失败（`history_native_closed`），并且后端启动时会把残留的 `running` 标成 `interrupted`（`history.recertifyInterruptStale`）。
- 批量**不自动恢复**：主进程重启则状态丢失；后端连接代次变化则批量以 `interrupted` 结束，保留已完成/失败统计，等用户再次确认重跑。重跑只会处理仍被围栏的联系人，所以不会重复已完成的。
- 不要把批量状态持久化到数据库，避免引入新结构版本；若实现 Agent 认为必须持久化，需先回来问用户。
- 批量开始前，面板上显示一行提醒：“开发模式下改动源码会触发重启并中断修复，请暂停其他会话的改动。”
- 关键风险（任务 01 必须查明）：修复完成后图片后台是否被唤醒。线索：`backend-ts/src/sqlite-host-plugin.ts` 约 206 行，历史写入回调里会 `imageSync.wake(contactId)`；约 211 行 `setReadStart` 与 382 行启动完成后会 `imageSync.wake()`（全量）；`SqliteImageSyncCoordinator` 在一轮排空后若仍有待办会按 60 秒窗口排下一轮。若修复完成后不会唤醒图片协调器，需要补一个只读唤醒（在 `historyRecertify` 的 `onCompleted` 里，同样受 `automaticImages` 开关约束），并写测试。

### 6.7 界面（只在开发模式）

- 位置：联系人页“高级”区里的 `DeveloperTraces`（`desktop/src/renderer/DeveloperTraces.tsx`，由 `desktop/src/renderer/index.tsx` 约 177 行挂载）。沿用文件里 `import.meta.env.DEV && <QuarantinePanel />` 的做法，新增 `import.meta.env.DEV && <FencedRepairBatchPanel />`。
- 复用 `.button` 与 `desktop/src/renderer/style.css` 现有变量，按 `docs/agents/engineering.md` 的界面组件复用规则；验收覆盖普通、悬停、按下、聚焦、禁用状态。
- 内容：
  - 概览：被围栏联系人 N 位（其中有未保存图片 M 位）、预计需读取的消息总数、排序规则；
  - “本次最多修复”输入（默认 5，可改为全部）；
  - 按钮“开始批量修复”→ 确认弹窗：写明范围、顺序、会重新读取每位的全部可读历史、期间该联系人旧资料暂时撤下、不调用模型、不提取媒体、可随时停止、失败会停止并显示原因码；用户点“确认修复 N 位”；
  - 运行中：总进度 n/N、当前阶段与已检查条数、已完成/失败/跳过及原因码分布、“停止批量修复”；
  - 结束：汇总与“再次修复剩余”。
- 不显示联系人名称以外的敏感内容；名称可显示当前正在处理的一位，便于排查，但不进日志。

### 6.8 合同与接线

- 共享类型：`desktop/src/shared/history-recertify-batch-bridge.ts`（仿 `history-clear-bridge.ts`：只含状态、计数与码）。
- 主进程：`desktop/src/main/history-clear/recertify-batch.ts` + `bridge.ts` 注册 IPC。**仅在开发宿主（`desktop/src/main/index.ts` 约 66 行 `readDevelopmentServer` 判定为开发）时注册**，打包宿主不注册。
- 预加载：`desktop/src/preload/history-recertify-batch.ts`（仿 `history-clear.ts`），仅开发模式暴露。
- 渲染：`FencedRepairBatchPanel.tsx` 与小的状态 hook。
- 后端：只读候选接口（6.2）；如 6.6 所述的唤醒补丁（若需要）。
- 测试登记：新增测试须登记在 `desktop/tests/inventory.json`，并跑 `pnpm --dir desktop run test:inventory`。

### 6.9 日志与隐私

- 允许：批次 ID、序号、阶段、计数、原因码、耗时。
- 禁止：联系人名称、联系人 ID 的明文（用序号或前 8 位哈希）、消息正文、文件路径中的账号目录。
- 日志用现有的 `[notalone-dev-backend]` 风格单行 JSON，只在开发模式输出。

### 6.10 规格与 ADR

- 新增 ADR-173（见 `architecture/adr/README.md` 列表，现最后一号是 172）：说明开发者批量重新认证。要点：
  - 仍是“用户明确选择”：一次确认，范围是弹窗列明的“全部当前被围栏且在有效读取范围内的联系人”，每位后端独立复验；
  - 严格串行、可停止、不自动恢复；
  - 只在开发模式出现，不进入打包版；
  - 不改变 ADR-144 的任何保护；不新增跳过认证的路径；
  - 与 ADR-151（共享读取进程）和 ADR-144 的关系。
- 同时更新 `architecture/current/wechat-sync.md`（“来源重新认证”段）与 `docs/verification/` 对应记录，并在 `architecture/adr/README.md` 加一行。
- **ADR 采纳需用户确认**：Agent 起草后请用户过目；用户确认前，实现任务 04 不开始写产品代码（可先做不改行为的准备，如抽共享解析函数）。

## 7. 测试计划

后端（`cd backend-ts && node --test test/<文件>.test.mjs`，先单例再模块）：

- 候选接口：只含被围栏且有效授权的联系人；不含已删除、已撤销授权的；排序正确；无正文字段；查询计划使用索引（对比 10/100/300 位联系人的耗时不随联系人数二次增长）。
- 若补了唤醒：`onCompleted` 触发 `imageSync.wake(contactId)`，且受 `automaticImages` 开关约束；关闭时不触发。

桌面（`cd desktop && node --test tests/<文件>.test.mjs`；先 `pnpm run typecheck`）：

- 编排器纯逻辑，用合成后端替身：
  - 全部成功；
  - 中途 `failed`（每类码一例，核对 6.4 的处理）；
  - 连续 3 次同码熔断；未知码处理；
  - 停止：当前联系人取消并确认终态后结束，不再开始下一位；
  - 响应丢失：只用同一 `request_key` 查询，不换键；
  - 连接代次变化：以 `interrupted` 结束，不自动恢复；
  - 看门狗：停滞触发取消；
  - 幂等：重跑时已不被围栏的计 `alreadyFixed`；
  - 互斥：批量运行时单个“修复同步”等被拒；
  - `limit` 生效；
  - 日志内容不含名称、正文、明文联系人 ID。
- 预加载/IPC：打包宿主不注册；开发宿主注册。
- 视图：`import.meta.env.DEV` 之外不渲染；确认弹窗文案；各状态可见；按钮状态。
- 现有的 `history-recertify*.test.mjs`、`sqlite-history-clear-contract.test.mjs`、`sqlite-history-clearing.test.mjs` 不得因此回归。

## 8. 真实验收（任务 05）

- 前置：任务 01 通过；ADR-173 已被用户确认；任务 04 已完成并通过自动检查；开发实例已核验（`dev:status`），期间没有其他会话改源码。
- 先小批：`limit=3`，覆盖一位图片多的、一位很小的；核对与单个修复一致的 P1–P4。
- 再放大：`limit=20`，观察失败码分布、每万条消息耗时、是否出现新错误；无新类型再放开全部。
- 全部跑完后核对：
  - 围栏数；
  - `history_source_recertification` 新增行按 `state/stage/failure_code` 分组；
  - 覆盖：同步页汇总“已保存本机历史 X / Y”；
  - 图片：按 `state, error_code` 分组的新尝试，已保存数量变化；
  - `model_call` 行数不变；
  - 备份与对比：开始前停读做 SQLite 备份（与 2026-11-01 一致：`quick_check`、外键检查），完成后逐范围比较消息/来源/别名/终态“缺失或改写为 0”。
- 记录写入 `docs/verification/fenced-contact-batch-repair-<日期>.md`：计数、耗时、原因码分布、限制。不含名称。
- 没有桌面操作工具时，点击确认由用户完成，Agent 做前后观测；在记录里分别写明“自动检查”“用户实操”“Agent 只读观测”。

## 9. 已知限制与不在本次范围

- 图片取图的退避：失败过的图片按 1 分钟、5 分钟、30 分钟、6 小时、24 小时退避（`backend-ts/src/media/sqlite/image-refresh.ts`）。缺密钥期间失败的约 2593 次尝试可能已处在 6 小时或 24 小时档，修复围栏后不会立刻重试。是否重置这批退避是另一个决定，**本方案不做**；需要时另开任务，先量化受影响条数。
- 约 4990 条从未尝试过的图片修复后应立即到期。
- 批量不整理记忆、不触发记忆处理；图片进入记忆是另一段逻辑，未在真实环境验证（见 `docs/verification/image-pick-standard-20261105.md` 的限制）。
- 围栏成因不明时，修好后仍可能再次出现围栏；这是任务 02 的价值。
- 2 位没有被围栏、有 182 条图片消息的联系人，为什么至今 0 张已保存、0 次尝试，没有查明（可能没有有效绑定）。不在本次范围，列在任务 02 顺手核对。

## 10. 任务拆分

| 编号 | 任务 | 类型 | 依赖 |
| --- | --- | --- | --- |
| 01 | 单个联系人试修与观测 | 人工 + Agent 观测 | 无 |
| 02 | 查明围栏成因 | research | 无 |
| 03 | 起草 ADR-173 与现行规格更新 | task | 无（采纳需用户确认） |
| 04 | 开发者批量修复实现 | task | 01、03 |
| 05 | 批量修复真实验收 | task | 04 |

## 11. 假设与待确认

已确认：入口只放开发者调试区；范围为全部被围栏联系人。

我的假设（若有异议请回头修改）：

1. 批量不自动恢复，中断后由用户重新确认。
2. 默认“本次最多修复”为 5，首次真实运行只做小批。
3. 不持久化批量状态。
4. 候选来源是后端权威数据，新增只读聚合接口；若现有接口已够用则不新增。
5. ADR-173 由用户过目后才开始产品代码。

## 12. 候选规模与预计耗时（2026-11-05 23:50 只读复核）

- 试修后围栏 278 位（全部 `active` 且有有效读取授权）。
- 候选消息总量 158,537 条（全库 164,640 条）；图片消息 6,476 条；未保存图片约 6,270 张。
- 预计总耗时：按试修实测 10ms/条约 26 分钟；按 2026-11-01 大对象 45ms/条约 119 分钟。建议真实全量按 30–120 分钟预留。
- 未保存图片数前 5 位（只列计数）：1162 图/15670 条、893/19955、874/5013、827/29327、521/13166。按排序规则会先修图片多且消息少的。
- 注意：修复后每位都会唤醒图片取图；当前图片密钥未就绪时这些尝试会全部 `needs_image_key` 并按退避重试，全量跑批前应先处理图片密钥（见任务 01 记录第 5 节）。
