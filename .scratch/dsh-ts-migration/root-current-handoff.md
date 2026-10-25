# 根迁移持续目标

用户要求的目标正文修正无法由当前目标工具改写，以下为持久执行约束：无依赖任务必须创建全新、用户可见的 Codex 会话，不是 sub-agent；会话直接通信，主会话统一集成并独占 App／微信验收。当前验收联系人使用 `cloudy`；此前 `ran` 的证据保留但不再使用。不得发送未明确指定的外部消息。用户已授权全部可用额度并确认后续可安全推进的步骤，禁止 push、打包或创建 PR。`get_goal` 仍返回旧 `ran` 正文和 `blocked` 状态，不得谎称目标正文已更新。

当前代码 HEAD 为 `489136fd`，根 App 证据提交会另行推进：

- Ticket 01—24 均 `resolved`；Ticket 25 为 `claimed`，Ticket 26 为 `open`。
- `282f43af` 收紧未知/风险项候选并修正 SSE 终态；`d59ffd0a` 修复跨助手会话停止投影；`cca335e4` 补齐 Python 兼容中断路由的 `user_cancelled`。
- Ticket 25 在 `282f43af` 的正式 96 次重跑仍为 `not approved`：新臂 46/48；`stale:new:1/2` 的
  多消息候选文本不满足 `text === messages.join('\n\n')`；token 比 0.915 通过，费用比 1.411
  （95% CI 1.309–1.521）超过 1.10；语义门禁与延迟因失败项保持 `undetermined`。
- 实际 App 停止验收已通过：按钮可见，补丁 `queued→generating→stopping→cancelled`，turn `88e65711-0d21-4cd6-934b-2e3de6909937` 为 `failed/user_cancelled`，候选 0，界面明确显示未保存候选。

用户可见会话（均非 sub-agent）：

- Ticket 25 用户可见会话：修复 stale 多消息候选合同并重跑完整真实模型、盲评和门禁。
- Ticket 25 费用用户可见会话：独立只读审计 1.411 是真实成本差异或费用口径错误。
- 停止切片用户可见会话：根实际 App 复验通过，等待其签收报告。
- 盲评使用独立用户可见评审线程，不能看到映射；最终由根核对包 SHA、裁决与报告一致性。

开发 App 经会话 `1168` 运行 `npm run dev`，显式保留五项 TS 开关与 `NOTALONE_DEV_CDP=1`，使用原资料目录；CDP 仅作脱敏事件观察，所有验收点击与 DB 终态核对由根完成。全程未发送微信消息，未保存或上传视觉帧。

下一步：

1. 等费用会话与 Ticket 25 直接沟通；若 1.411 是真实差异，继续优化成本，不能改门槛掩盖。
2. Ticket 25 修复 stale 合同后完整重跑、重新双盲/第三裁决；任何门禁失败都不得签收。
3. 根 App 已完成联系人切换、关闭停读、覆盖门禁、主动停止、重启恢复与用量/费用可见性；记忆审核/修正/删除引用既有合成 App 签收证据。
4. Ticket 25 真正通过后，创建新的用户可见会话推进 Ticket 26；退役后重跑启动、退出、数据库兼容和关键业务闭环。
5. 最终保持全私聊自动同步关闭，正常退出开发 App，清理合成来源、测试库和自有进程，保留证据并完成目标。

绝不暂存：`desktop/tests/fixtures/expression-preference-backend.py`、`desktop/tests/fixtures/expression-preferences-page.py`、`desktop/tests/memory-correction/retirement-react.test.mjs`。
