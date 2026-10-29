# 04 增量同步与读取控制验证

日期：2026-10-30。范围：票 04「增量同步与读取控制」的本地实现、隔离 SQLite 合成验收、正式宿主与桌面状态接线。真实微信读取继续关闭；本记录不认证真实渠道能力。

## 实现摘要

工作树 `sqlite-rebuild-04`（分支同名，基线 `codex/sqlite-rebuild-integration`）。实现提交：

| 提交 | 内容 |
| --- | --- |
| `36470ec4` | 增量读取合同、原子交接检查点、共享逐条接受（`contracts.ts`、`cursor.ts`、`suppression.ts`、`ingest.ts`、`incremental-schema.ts`、`actions.ts`、`read.ts`、`registry.ts`） |
| `b9bf30a9` | `service.ts` 增量同步循环与 `incremental-coordinator.ts` 读取控制 |
| `03d29a15` | 正式宿主生命周期、`/api/sync/status` 增量投影、桌面解析与可见展示 |

关键合同：

- 历史终页可带保守续读游标 `HistoryPage.resumeCursor`；终页接受时在同一事务写入 `read_goal.resume_cursor` 与游标作用域摘要，并原子创建 `kind='incremental'` 目标，交接无数据库窗口。
- 游标作用域摘要覆盖账号实例、稳定会话、来源代次、固定目标（描述/分片/表实例）、支持档制品与结构、声明主键、状态/连续性语义、声明能力与游标合同；不含 `read_epoch`/grant/selection_generation，使关闭再开启与重选可续读，而账号/版本/分片/目标/语义变化一定失配。
- `ingestRecords` 是历史与增量共用的逐条接受：来源排除优先、稳定身份幂等、可认证字段仅在原值为空时补齐、状态只记录渠道原始值、身份冲突隔离、删除中的消息拒绝整页提交。
- 每页接受前由存储动作复验读资格（含总开关 `read_enabled`/`read_epoch`）、目标/游标、barrier 代次与删除围栏；取消/关闭后迟到页整事务回滚且检查点不推进。
- 增量协调器：仅启动/开启/重选唤醒并定时运行；关闭、退出、取消与范围变化停止后续查询并 abort 在途；范围失效类错误停止自动重试并保留可见原因，瞬时故障保留降级在后续 tick 重试。

迁移：`read_goal` 增加 `resume_cursor/cursor_scope_digest/cursor_scheme/handoff_from_goal_id/pages_accepted/last_accepted_at`，`message` 增加 `status_code/status_observed_at`；只 ALTER，不重建既有 CHECK、不建新表。当前工作树因 registry 要求版本连续、票 09 的 13 尚未进基线而暂用 13；09 集成后改为 14（只改函数参数与 registry 一行）。

## 合成验收（隔离 SQLite，合成渠道替身）

| 票内验收 | 证据 |
| --- | --- |
| 历史→增量无无声缺口、重复读取幂等、游标含完整作用域与稳定续读顺序 | `sqlite-incremental-handoff`：终页同事务创建增量目标；重叠页保留新来源记录但同一消息不重建；支持档/账号变化拒绝旧检查点；响应重放幂等。`sqlite-incremental-sync`：交接后新消息进入，续读游标来自持久检查点而非从头 |
| 仅 App 运行、总开关开启、联系人已选且账号/绑定/授权有效时读取 | 协调器生命周期表示 App 运行；未选/关闭/撤销/账号失效/协调器关闭均零渠道 IO；服务入口在关闭时直接 `read_not_authorized` |
| 关闭总开关不删资料、不撤销手动处理资格、不发起模型/媒体 | 关闭后消息仍可读、`read_enabled=0` 而绑定 active、`grant_id` 与 `selection_generation` 不变；未创建任何模型/媒体调用 |
| 取消某人只停该人并撤销提交资格，其他继续；重选只在新资格补齐、不复活旧执行、不清除旧排除 | 取消 A 在途页不提交而 B 继续；重选后旧目标 `invalidated` 且旧代次写入被拒；05 来源删除产生的排除在重读后仍不复活被删消息 |
| 账号变化/分片不连续/游标失效/覆盖不明确时停止范围并可见报错 | 账号变化、支持语义变化、游标失效、目标不连续分别 `blocked` 且错误码可见；状态 JSON 不含渠道会话细节；终页无续读游标时增量显式 `unavailable` |
| 新消息、发送状态补齐、可认证更新分别处理；不重复建消息、未知状态不猜完成 | 已存在行补齐发送时间与原始状态码；状态缺失不清除已有观察；无关语义；身份冲突进入隔离并可见 |
| 捕获写入、处理关联与检查点原子提交；每页复验资格/代次/删除；迟到页不推进水位 | 在途页在关闭（总开关或协调器 close）后 `pagesAccepted` 不推进、`lastAcceptedAt` 为空；旧代次迟到页 `read_not_authorized`；关闭等待在途释放且不挂起；重开从原检查点补齐 |
| 重开仅恢复仍有效且允许的读取；不自动调模型/媒体 | 关闭总开关后新协调器 wake 零渠道 IO；开启后按 `tail-1/tail-2` 持久游标恢复，不从头重读 |
| 现有界面核验开启/关闭/退出/取消重选/断线/覆盖不足；微信不在前台仍可同步 | 宿主合成测试覆盖启动→关闭→退出；桌面解析与覆盖界面单测覆盖停止/不可用/原因展示；**真实 App/微信界面验收未执行**，等待串行桌面窗口 |
| 03/06 未认证能力继续拒绝；合成正向路径证明合法新消息能进入 | 真实渠道仍无增量尾部能力并保持拒绝（宿主测试 `history_tail_unsupported`）；清空边界接缝 `assertHistoryReadBoundary` 仍拒绝 barrier/fence；合成正向路径已证明新消息可入库 |

## 宿主与桌面证据

- `backend-ts/test/sqlite-history-host.test.mjs`（Electron 自带 Node 执行）：宿主启动后 `/api/sync/status` 的历史覆盖仍为 complete，增量字段显示 `blocked` 且原因为 `history_tail_unsupported`（真实适配器未认证/未提供增量能力），消息正文不增加；`POST /api/sync/disable` 返回 200 且 `sync_enabled=false`，资料与选择保留；`POST /api/runtime/shutdown` 正常退出。
- `backend-ts/test/sqlite-history-http.test.mjs`：增量阶段/失败/检查点数/最后接受时间投影与运行态覆盖；全部不可用时不伪报已同步。
- `desktop/tests/incremental-sync-status.test.mjs`：新增可选字段严格解析（缺失不推断、非法枚举整份失败），覆盖界面单独显示“新消息同步已停止/不可用/正在同步”及可操作原因。
- `desktop/tests/{sync-status-recovery,local-history-sync,sync-priority-status,sqlite-history-messages,sqlite-history-clearing}.test.mjs`：24 项通过。

## 复现命令

```bash
cd backend-ts && npx tsc --noEmit
node --test test/sqlite-incremental-{handoff,sync,controls}.test.mjs \
  test/sqlite-first-history-coordinator.test.mjs test/sqlite-history-http.test.mjs \
  test/sqlite-history-hooks.test.mjs test/sqlite-history-source-holder.test.mjs \
  test/sqlite-history-sync-status.test.mjs test/sqlite-deletion.test.mjs \
  test/sqlite-deletion-metadata.test.mjs test/sqlite-adjudication-migration.test.mjs
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --test test/sqlite-history-host.test.mjs
cd desktop && npx tsc --noEmit && node --test tests/incremental-sync-status.test.mjs ...
```

结果：backend typecheck 0 错误；相关后端测试 71/71 通过；新增增量测试 handoff 4、sync 4、controls 7（含 5 个子场景）全部通过；宿主测试 8/8（Electron node）；desktop typecheck 0 错误，新增桌面测试 2/2、相关桌面同步测试 24/24。`node scripts/check_public_history.mjs --ref HEAD --working-tree` 0 问题。

环境说明：工作树默认无 `node_modules`；运行宿主测试时临时软链主仓依赖，提交/检查前已移除（软链会使公开前检查报本机路径）。`sync-scope-view` 等 Playwright 页面测试因本机缺浏览器二进制未运行，属环境缺口而非本票代码回归。

## 真实边界与剩余缺口

- 真实微信读取保持关闭：`wechat-channel` 未配置/未认证时 inspect 返回 `unverified`，靶目标被拒绝；生产适配器不实现 `tail`，增量显示明确不可用/受阻，不伪造已同步。票 03 的渠道状态语义与来源连续性仍未认证。
- 票 06 的精确清空边界（verified B）未接入：`suppression.ts` 的 `assertHistoryReadBoundary` 仍按 `barrier_generation`/`history_deletion_fence` 拒绝，清空后读取恢复不放行。
- 未启动真实 App/微信/模型/媒体；无真实界面与真实渠道证据。桌面窗口待 Lead 在 09 后安排。
- 迁移 14 编号与最终基线合并待 09（13）进入集成分支后完成。
