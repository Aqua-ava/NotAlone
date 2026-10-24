# 票 20 根宿主集成说明

历史执行方是启动期唯一配置，不提供请求级切换或双写回退。

## 1. 配置边界

`NOTALONE_HISTORY_RUNTIME` 只接受：

- 缺省或 `python`：保持迁移前 Python history-only + TS 增量交替单页。
- `typescript`：Python 不再构造 history-only `CliBackgroundSync`，每轮只调用 TS
  `/api/runtime/sync-incremental/cycle`；该 TS 页负责历史和增量。

非法值失败关闭。`typescript` 缺少完整认证增量远端时也拒绝启动，不能进入半切换。
官方宿主由自身提供该远端，并按配置向 `createSyncIncrementalApi` 传同一个执行方；
`/api/runtime/status` 的 `ownership.wechatHistory` 直接反映该值。

## 2. Python 适配器

`RemoteIncrementalBackground` 的 `history` 可为 `None`。Python 模式构造并排空旧的
history-only 实例；TS 模式完全不创建该实例。`enable`、`disable`、`close`、
`shutdown`、`cancel_pending_io`、检查、暂停、重试、历史启动和 cycle 均按模式分支，
不会访问空 history。

Python 模式的 TS 状态覆盖仍由本地 history 投影；TS 模式严格解析远端
`history_coverages`，503、字段缺失、非法阶段/计数/游标/时间都失败关闭。

## 3. 公开同步状态

TS 引擎状态使用内部字段：

```text
history_coverages: [{ binding_id, contact_id, phase, failure_code,
  message_count, non_text_count, page_count, watermark_at,
  started_at, completed_at, updated_at, last_local_id, last_cursor }]
```

`history_coverages` 只含元数据。TS 模式下公开 `/api/sync/status` 从
`incremental.status()` 读取该字段并投影为既有桌面 `cli_history_coverages` 合同，
不向桌面暴露内部 `last_local_id`。缺失或坏字段返回 `sync_status_unavailable`，
不能因为字段缺失把覆盖判成 `complete`。Python 模式不改写本地权威覆盖。

无副作用的内部认证 `/status` 可在 Python legacy 赋值前响应，解决 TS 模式首轮
同步状态播种的顺序环；内部 `cycle`、事件和其他控制仍要求 Python 后端已就绪。

## 4. 新绑定授权边界

本组件只处理 `wechat_binding_history_authorization` 已有逐绑定授权的会话。迁移 108
保持原语义：升级时只快照当时已明确同意且仍有效、未排除的绑定，不追溯迁移前新增。
运行时 `SyncScopeService.enroll` 在同一事务创建新 active 绑定后，仅在账号级历史决定为
`accepted`、版本为 1、范围为 `all_private`、总开关开启，且会话为未排除私聊时，为这个
新绑定写入版本 1 授权。`selected`、`declined`、`required`、未知未来版本和排除项均不扩权。
重复或并发发现复用 owner 事务锁和绑定主键，只产生一份授权；授权写入失败会回滚联系人、
绑定、baseline 和授权。

公开 `not_started` 也必须结合真实逐绑定授权解释：没有历史快照的旧增量联系人显示未知，
不能自动标成待读或阻塞其仍获准的增量路径。历史执行器不得再按账号状态自行补授权。

## 5. 已验收范围

- 官方 profile 和认证 HTTP 验证默认 Python 合同、显式 TS 单写者、TS 历史分页与
  公开覆盖字段、关闭/退出停读、挂起读取排空、远端 503/坏响应失败关闭。
- Python `history=None` 单元验证所有生命周期和控制路径无空引用。

实际 App/微信、真实资料和真实模型仍未验收。本切片只使用合成 `_test` PG 与临时 CLI；
票 20 保持 claimed。本票没有新增数据库迁移，复用 104/107/108 与既有消息、来源、
处理回执和删除路径。
