# 票 20 实现与验证

工作树：`/tmp/notalone-task20.RG0VFj`

分支：`codex/task20-history-gap-recovery`

基线：`65464802f8160082840a050e90ecd16809d3b8f9`

## 实现切片

- 新增 `SyncHistory`：只为已有逐绑定历史授权的 active 会话建任务；每片
  `tail --history --limit 50`，用持久 `last_cursor` 续读。
- 历史页在同一 PG 事务写入 `cli_history` 来源、规范消息、处理回执、覆盖计数/原因、
  历史检查点。中间页不推进增量游标；完成页只有在确实前移时建立可靠增量水位，
  已有更靠前游标不回退。
- 空历史、本机删除/空记录、缺表、timeout、freshness/游标异常均形成可恢复
  `incomplete`，不得标记完整。当前联系人优先且交替让出队列；单联系人失败不阻塞其他绑定。
- 历史页不逐条发布模型/消息事件；只按既有持久回执排队关系提取。消息历史完整与关系资料
  处理完成保持分离。
- 运行时自动纳入遵循 ADR-100：账号级 `accepted/version=1 + all_private + 总开关开启`
  的新私聊在同一事务获得逐绑定版本 1 授权；`selected`、`declined`、`required`、
  未知版本及排除项不扩权。108 迁移仍只快照升级时已有有效绑定，不回填迁移前新增。
- 当前联系人生成门禁复用既有 `requireReplyScope`：`syncing/not_started` 拒绝；
  `incomplete` 必须显式 `allow_incomplete_history`，持久请求保存固定警告。

## 合成验收

- `pnpm typecheck`：通过。
- `node --test test/sync-history.test.mjs`：8/8 通过，0 跳过。覆盖分页与不透明 ID
  回落、重启续读、稳定 ID 去重、旧授权不建任务、空/删除历史、不完整门禁、关闭停读、
  重开恢复、当前优先/其他不饥饿、非文字计数、ahead cursor 不回退、事务故障整体回滚
  和删除抑制不复活。
- 相关增量、范围与规范化组合 88/88 通过；测试只使用随机 `_test` PostgreSQL 和
  合成 CLI，无实际 App/微信/模型/真实资料。
- Desktop `npm run typecheck`：通过。
- Desktop 历史/同步相关 26 项：通过（历史警告、范围授权、四态覆盖、状态恢复、
  优先指标）。本票未改 UI。
- Backend TS 回复范围/准备/HTTP 16 项：通过（含历史未完成门禁）。
- 范围与历史授权回归覆盖 accepted 新私聊、selected/declined/required/未知版本拒绝、
  排除保留、重复及并发发现幂等、owner/account 隔离、授权触发失败整体回滚，以及
  `SyncScopeService.historyBindings`、`SyncHistory` 对新授权可见。
- 本轮窄修正定向组合 `sync-scope`、`sync-scope-migration`、`wechat-setup`、
  `sync-history` 为 27/27，0 跳过；`wechat-scope-api` 与 `reply-scope` 为 11/11。
  工作树公开历史扫描 issues=0。
- 基线失败复跑遗留的 4 个随机 `_test` PG 库已在确认无连接后按精确名称清理，
  复核均不存在；本票通过测试的随机库由夹具自行关闭和删除。

## 数据处理影响

- 已明确历史授权的私聊会增加本机 PG 中既有消息、来源、元数据和处理回执，并新增/更新
  每绑定历史覆盖元数据。未增加新表、媒体正文、外部模型用途或发送能力。
- 删除仍沿既有来源级联和自动读取抑制；历史页写入前经过同一抑制过滤。测试验证
  迟到/失败页不能留下部分消息、来源、游标或检查点。

## 未闭环

- 共享官方宿主尚未启用 `historyOwner: 'typescript'`，也未停止 Python 历史执行方；
  因此公开认证 HTTP、官方 profile 单执行方和实际 App/微信验收仍由根接线后完成。
- 基线提交的 `sync-incremental-reconnect.test.mjs` 清理断言在独立干净基线 worktree
  同样失败，属于既有测试问题，不由本票修复或计为通过。
