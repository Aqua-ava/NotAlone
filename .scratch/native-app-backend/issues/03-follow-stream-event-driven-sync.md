# 03 — CLI 适配器 --follow 流式读取与事件驱动同步

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 消息读取从一次性轮询升级为 `tail --follow` 常驻流（兑现 ADR-016 第 3 条原设计）：任何时刻只有当前绑定联系人保持一个流；切换联系人停旧启新；流崩溃后指数退避重启并从水位补读；`--follow` 不可用时降级回一次性轮询退避；失败关闭语义不变。新消息入库后经事件通道推送。本票全部用 fake CLI 流式扩展验证，真实微信冒烟由 04 票负责。

**Blocked by:** 01（后端服务骨架）、02（事件总线与 SSE 契约）

- [ ] fake CLI 适配器扩展出 `--follow` 流式语义，支撑本票与后续测试。
- [ ] follow 流消息经既有稳定消息身份去重与规范化，写入正确联系人范围；重复事件不产生重复消息。
- [ ] 切换联系人停旧启新；切回补读保留 `cli_catchup` 标记与联系人独立水位。
- [ ] 手动关闭窗口内的消息只前移水位不写入。
- [ ] 流进程崩溃进入指数退避重启并从水位补读；`--follow` 不可用降级回一次性轮询退避。
- [ ] 新消息入库后产生事件推送，fake CLI 流式集成测试覆盖观察→入库→事件全链路。
- [ ] 既有 `TailLifecycle` 集成测试（切换隔离、去重、非前台停读、重启恢复等）更新后全部通过。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-016、ADR-020。
- 实现前重读 `.scratch/local-wechat-cli-observation/issues/06-tail-lifecycle-catchup.md` 与 07 票的"剩余风险"部分。
