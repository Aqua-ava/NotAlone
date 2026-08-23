# 05 — 规范化 CLI 消息并按稳定 ID 去重

Type: task
Triage: ready-for-agent
State: open
Blocked by: 01, 04

## What to build

将 CLI 的文字事件转换为统一 `message`，保存联系人和我方消息、sender/from_me、原始时间、稳定消息 ID 和来源引用。历史导入与 CLI 观察命中同一消息时复用规范消息，不生成重复记录。

## Acceptance criteria

- [ ] v1 只接受文字消息；媒体、群聊和未知类型明确跳过或返回稳定结果。
- [ ] `owner_id + contact_id` 在写入前确定且不可由 CLI 参数覆盖。
- [ ] 同一稳定消息 ID 只生成一个规范消息，可关联多个有效来源引用。
- [ ] 缺失原始时间保留未知，不以读取时间冒充发生时间。
- [ ] `is_from_me`/sender 映射为统一说话人；错误或缺失时 fail closed。
- [ ] 删除一个来源只移除该来源引用；所有来源都删除后才清理消息和派生资料。

## Verification

- 导入来源与 CLI 来源重叠、重复事件、同文不同 ID、我方消息和缺失时间测试。
- 联系人隔离、删除来源和来源引用剩余测试。

## Out of scope

- 不管理 tail 进程、不识别前台窗口、不生成候选回复。
