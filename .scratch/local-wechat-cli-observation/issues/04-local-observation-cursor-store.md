# 04 — 增加本地微信观察来源与联系人 cursor

Type: task
Triage: ready-for-agent
State: resolved
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

## Answer

提交 0cdfdb2「持久化本地微信观察来源与联系人级 cursor」与 502f232 评审修复。

1、迁移 020 新增 `local_wechat_observation` 来源表（CLI 版本、读取时间、水位区间、
`live`/`cli_catchup` 模式、消息计数，不含正文）与 `wechat_observation_cursor`
按 `owner_id + contact_id` 的独立水位；两表随联系人和绑定行删除级联清理。
2、`PostgresObservationStore` 同事务写来源并前移水位：首次读取返回 None 水位、
拒绝 `since_local_id=0`；同一批次经表达式唯一索引幂等返回既有来源；水位只单调前移，
持平（空批次）无害、倒退拒绝。撤销或跨范围绑定拒绝写入。
3、验证：9 个集成测试覆盖 A/B/A 切换 cursor 不串、新 store 实例重启恢复、重试幂等、
空批次、范围删除与级联；全量 317 个测试通过；迁移在两个库重复执行幂等。
4、剩余：「手动关闭同步期间不创建补读来源」属于同步开关状态，由任务 06 的 tail
生命周期编排实现；存储层已提供 `cli_catchup` 模式标记。
