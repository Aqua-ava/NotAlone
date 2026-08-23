# 06 — 实现按联系人切换、补读和恢复的 tail 生命周期

Type: task
Triage: ready-for-agent
State: open
Blocked by: 02, 03, 04, 05

## What to build

实现当前前台联系人对应的 `tail --follow` 生命周期：启动、停止、切换、切回补读、同步暂停、CLI 失败重试和应用异常恢复。任何时刻只允许当前唯一联系人拥有有效读取任务。

## Acceptance criteria

- [ ] display name/选中行元数据变化时先停止旧联系人，再启动新联系人。
- [ ] 每个联系人使用自己的 cursor；切回时只补读该联系人并标记 `cli_catchup`。
- [ ] 同步关闭、微信非前台、定位失败或 CLI 不可用时停止读取，不退回 OCR 正文。
- [ ] 应用重启且同步仍开启时从当前联系人的 cursor 恢复。
- [ ] tail 进程退出、超时、重复事件和并发启动都有稳定状态，不创建重复消息。

## Verification

- A -> B -> A 切换隔离测试。
- A 离开期间来消息、切回补读、暂停期间不补读、进程崩溃恢复测试。

## Out of scope

- 不监听所有联系人，不自动滚动或控制微信，不发送消息。
