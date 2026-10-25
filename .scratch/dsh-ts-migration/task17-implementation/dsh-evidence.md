# Ticket 17 DSH 查证

- 锁定版本：`@deepseek-ai/dsh@0.2.1-rc.2`，tag 对应 commit
  `687f282e8625c6b8d11ff58211a90524be2e4317`。依赖由 `backend-ts/pnpm-lock.yaml` 固定。
- [AgentHandle 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L147-L162)
  的 `dispose()` 负责停止循环、等待退出并移除框架 session/world，不拥有 PostgreSQL
  `owner_id + contact_id` 数据、Skill 文件、媒体、备份、追踪或业务任务。
- [Cordis effect 文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md#L5)
  的 disposer 用于宿主资源排空，不能代替数据库删除事务或文件清理完成凭证。
- [Agent README 限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#L173)
  说明 initiator 是进程内身份，`cancel()` 默认清 inbox，不等于 PostgreSQL 租约或跨重启恢复。

## 适配结论

删除是确定性的普通 TS 业务模块：PostgreSQL 保存删除请求、租约、阶段和最小凭证；业务代码
负责 owner/contact 锁、范围检查、依赖闭包、文件/媒体清理、提交后复核和失败重试。来源引用
数据库触发器在来源离开 `active` 后拒绝迟到写入。未新增 DSH Tool、自治删除 Agent、会话日志
或检查点恢复路径，也不新增外部聊天发送能力。

锁定源码来自项目已安装的 rc.2 依赖与 01 的固定官方归档；DSH profile 回归继续使用现有
`host-model-integration-profile.test.mjs`，本轮没有替换 profile 或修改 DSH 核心。
