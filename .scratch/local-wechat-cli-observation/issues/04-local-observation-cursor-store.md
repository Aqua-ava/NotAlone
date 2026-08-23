# 04 — 增加本地微信观察来源与联系人 cursor

Type: task
Triage: ready-for-agent
State: open
Blocked by: 01, 03

## What to build

增加 `local_wechat_observation` 来源持久化和按联系人独立的 cursor/local_id 水位。来源记录保存 CLI 版本、外部会话定位、读取时间、`live`/`cli_catchup` 模式和业务引用，不保存全量导出或消息正文副本。

## Acceptance criteria

- [ ] 同一 `owner_id + contact_id` 的 cursor 独立保存，重启后可恢复。
- [ ] 首次读取不使用非法 `since_local_id=0`；后续使用成功返回的 cursor/local_id。
- [ ] 同一来源批次重试幂等，不重复创建来源记录或移动水位。
- [ ] 手动关闭同步期间不创建补读来源；切回联系人时可标记 `cli_catchup`。
- [ ] 来源删除、绑定撤销和联系人删除遵循来源级删除路径。

## Verification

- 两个联系人 A/B/A 切换后 cursor 不串。
- 进程中断、重启、重复 tail 和 CLI 错误恢复测试。

## Out of scope

- 不负责 CLI 事件字段解析和 message 规范化。
