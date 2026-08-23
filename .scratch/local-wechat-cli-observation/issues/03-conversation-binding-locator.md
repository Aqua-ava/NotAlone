# 03 — 持久化 CLI 会话绑定与一次性重名确认

Type: task
Triage: ready-for-agent
State: open
Blocked by: 01, 02

## What to build

把唯一 CLI 外部会话定位标识绑定到已有 NotAlone `contact_id`。首次重名、display name 改名或备用视觉指纹变化时提供一次性选择；之后使用保存的 `username`/`talker` 和匹配元数据自动切换。

## Acceptance criteria

- [ ] 绑定始终带 `owner_id + contact_id + channel + account_scope`。
- [ ] 保存外部 `username`/`talker`、display name 映射、左侧元数据匹配摘要和可选视觉指纹摘要。
- [ ] 同一外部会话不能被同一 owner 同时绑定到两个 active 联系人。
- [ ] 无匹配、重名无法区分、头像/元数据变化时不自动改绑。
- [ ] 撤销绑定后不能继续读取或进入候选回复。

## Verification

- 两个同名候选只能通过一次性选择绑定，后续唯一匹配自动通过。
- 改名、头像变化、跨 owner/contact 和重复绑定均 fail closed。

## Out of scope

- 不读取聊天正文，不管理 tail 进程，不管理 cursor。
