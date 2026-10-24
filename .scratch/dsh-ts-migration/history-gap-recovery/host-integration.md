# 票 20 根宿主集成说明

本组件默认 `historyOwner` 为 Python，以避免当前官方宿主中 TS 与 Python 同时执行
历史读取。根只在同一业务切片切换到 TS 后启用；不能先启用第二个写入方再排空旧方。

## 1. 启用 TS 执行方

在 `backend-ts/src/host-plugin.ts` 构造 `createSyncIncrementalApi` 时传入：

```ts
historyOwner: 'typescript',
```

启用条件应由根的一次性切换配置固定，建议使用显式环境值；“字段缺失”继续表示 Python，
不要用同步总开关或范围模式推断责任方。

## 2. 停用 Python 历史读取

当前 `backend/src/notalone/front_sync/factory.py` 在增量移交后仍创建
`CliBackgroundSync(history_only=True)`，并由
`RemoteIncrementalBackground.cycle()` 交替执行 Python 历史页和 TS 增量页。切换时必须：

1. 在 `SyncHost` 锁内停止新领取并排空正在执行的 Python 历史页；
2. 让 `RemoteIncrementalBackground` 不再创建或调用 Python `CliBackgroundSync`；
3. 普通周期只调用 TS `/api/runtime/sync-incremental/cycle`，由 TS 在同一循环内先读历史页，
   历史完成后下一片再读增量；
4. `enable`、`disable`、`stop`、重启恢复均仍走原控制/排空语义，禁止请求级双实现回退。

若 Python 历史进程无法在同一部署中停止，应保持 `historyOwner` 未启用并延期接线。

## 3. 公开同步状态

TS 引擎状态使用内部字段：

```text
history_coverages: [{ binding_id, contact_id, phase, failure_code,
  message_count, non_text_count, page_count, watermark_at,
  started_at, completed_at, updated_at, last_local_id, last_cursor }]
```

`history_coverages` 只含元数据。根的公开 `/api/sync/status` 装饰应读取
`incremental.status()`，并把该字段映射为既有桌面接口的
`cli_history_coverages`。不要让缺失字段自动变成 `complete`；行缺失或无授权时为
`not_started`。

```ts
const incrementalStatus = await incremental.status(check);
return {
  ...legacyReport,
  cli_history_coverages: incrementalStatus.history_coverages,
};
```

根还需把 `/api/runtime/status` 的 `ownership.wechatHistory` 从 `python` 改为
`typescript`，且只在上面的单一执行方切换完成后修改。

## 4. 新绑定授权边界

本组件只处理 `wechat_binding_history_authorization` 已有逐绑定快照的会话，不自行扩大
历史读取。当前 108 合同明确“未来新发现绑定不继承旧快照”；因此只选中确认、首连快照和
明确历史升级需要继续由范围入口写入对应快照。ADR-100 描述“以后新发现私聊也读历史”，
与 108 的旧授权防扩张实现存在范围差异；根若要求新账号授权覆盖以后新增会话，必须先在
范围入口形成明确、可追溯的授权决定，不能由历史执行器按账号旧状态猜测授权。

公开 `not_started` 也必须结合真实逐绑定授权解释：没有历史快照的旧增量联系人显示未知，
不能自动标成待读或阻塞其仍获准的增量路径。

## 5. 必需验收

- 官方 profile 测试走实际认证 HTTP：历史分页、重启续读、状态覆盖、同步中门禁、
  不完整确认、停读/撤销、TS 单执行方。
- 桌面控制器读取真实公开状态字段，确认当前联系人覆盖、其他联系人汇总和
  “消息覆盖 / 关系资料处理”分离。
- 实际 App/微信仍由根按用户范围单独验收；本组件没有操作 App、微信、真实库或发送消息。

本票没有新增数据库迁移，复用 104/107/108 与现有消息、来源、处理回执和删除路径。
