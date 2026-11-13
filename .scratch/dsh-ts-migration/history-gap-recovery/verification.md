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
- 单执行方宿主切片：Backend TS 与 Desktop `tsc --noEmit` 通过；历史执行方、
  官方 DSH profile、认证宿主、HTTP 与历史页组合 26/26；Python 远端、history-only、
  FullSyncEngine 与 SyncHost 组合 63/63。默认 Python 与显式 TS 两种模式均覆盖。
- 官方 profile 实测显式 TS 时所有历史 tail 属于 TS 宿主且 Python 历史调用为 0；
  TS 历史分页完成后的 `cli_history_coverages` 经公开认证 HTTP 返回，关闭和退出后无
  新读取。远端 503、覆盖字段缺失或非法值失败关闭；非法配置不发布业务握手。
- 基线失败复跑遗留的 4 个随机 `_test` PG 库已在确认无连接后按精确名称清理，
  复核均不存在；本票通过测试的随机库由夹具自行关闭和删除。

## 数据处理影响

- 已明确历史授权的私聊会增加本机 PG 中既有消息、来源、元数据和处理回执，并新增/更新
  每绑定历史覆盖元数据。未增加新表、媒体正文、外部模型用途或发送能力。
- 删除仍沿既有来源级联和自动读取抑制；历史页写入前经过同一抑制过滤。测试验证
  迟到/失败页不能留下部分消息、来源、游标或检查点。

## 未闭环

- 实际 App/微信、真实聊天资料与真实模型仍由根按用户范围单独验收；本切片没有启动
  App/微信，也没有处理真实资料。票 20 保持 claimed。
- 基线提交的 `sync-incremental-reconnect.test.mjs` 清理断言在独立干净基线 worktree
  同样失败，属于既有测试问题，不由本票修复或计为通过。

## 根级实际 App 验收（2026-10-25）

- 开发实例显式设置 `NOTALONE_HISTORY_RUNTIME=typescript` 与
  `NOTALONE_REPLY_RUNTIME=typescript`；`/api/runtime/status` 返回
  `ownership.wechatHistory=typescript`。
- 同步总开关关闭，公开 `/api/sync/status` 返回 `cli_history_coverages=[]`；
  `ran` 页面显示 78 条已保存消息，但覆盖状态为“尚未确认”，符合停止读取边界。
- 输入小窗未把该“尚未确认”覆盖作为生成门禁：仍允许发起一次生成，随后返回
  “未收到生成结果”，没有候选。该请求保持 unknown，未重试。
- 未修改同步总开关、范围、资料或记忆，未发送外部消息。覆盖展示与回复门禁不一致，
  因此本票保持 claimed；修复后需重新做一次实际 App 门禁验收。

## 根级实际 App 复验（2026-10-25，续）

- 定位到第二个门禁缺口：输入小窗读取 `sync-control:get-state` 与
  `sync-control:refresh` 时被管理窗专属 IPC 拒绝，历史报告因此保持 `undefined`，
  前端无法把 accepted 账号下的空覆盖解释为 `not_started`。
- 只把这两项只读查询开放给 manager/helper；范围、历史授权、启停、暂停和重试仍仅限
  manager。后端 accepted 账号兜底和桌面空/缺失/仅其他联系人覆盖判定已经由
  `41d72218` 接收。
- `page-role-scope` 与 `sync-scope` 14/14、相关页面 18/18 通过，Desktop
  `tsc --noEmit` 通过。首次页面命令未指定系统 Chrome 时因 Playwright 浏览器缺失
  失败，设置 `NOTALONE_TEST_CHROMIUM_PATH` 后重新运行通过。
- 开发实例继续使用显式 TS 历史与回复运行时。实际 `ran` 输入小窗显示
  “历史尚未追平，请等待当前联系人历史同步完成后生成。”，“帮我表达”和
  “帮我想想”均禁用。本次没有点击生成，没有新增模型请求。
- 同步总开关、读取范围、资料和记忆均未修改，未发送外部消息。此复验闭合了覆盖展示
  与可见生成门禁不一致；本票其余验收项继续按下述证据审查。

## 结票审计

- 后端核心回复/历史组合 21/21；官方 profile 单一执行方、停读排空、来源删除抑制、
  恢复和范围组合 16/16；Desktop 历史/同步页面 18/18；页面角色与同步桥 14/14；
  Desktop 类型检查通过。
- 审计逐项确认：accepted、空、缺失和仅其他联系人覆盖均进入 `not_started`；
  incomplete 必须显式接受且确认不跨联系人、会话或重开继承；历史页不发布逐消息关系
  事件；停读、迟到页、删除抑制、重放和新旧执行方边界不会形成第二轮正文写入。
- 实际 `ran` 门禁复验与上述测试证据共同满足票 20 全部验收条件，票已标记 resolved。
