# 根迁移持续目标
用户明确要求把“全新 Codex 会话，不是 sub-agent；会话直接通信；主会话统一集成并独占 App/微信验收”作为目标约束。
当前结论：DSH/TS 回复切片已由根完成 `ran` 实际 App 验收，票 08 已 resolved；证据见 [记录](reply-app-acceptance/ts-l3-real-app-20261025.md)。
票 12 已在 `0b039f97` 接入共享宿主并完成 `ran` 实际 App 只读追踪验收；历史显示 78 条且完整，来源批次详情 93 条，消息反查回到同批次。
既有模型许可 journal 有 5 条旧 TS `unknown`；Python 默认回退按设计 fail-closed。本轮仅开发进程显式使用 `NOTALONE_REPLY_RUNTIME=typescript`，未改 `.env`，后续切换票须收口恢复策略。
票 20 已关闭：`41d72218` 修复后端/桌面空覆盖门禁，`d39d89ff` 修复输入小窗只读状态 IPC；`ran` 实际 App 显示历史尚未追平且两个生成按钮禁用，没有新增生成。证据见 history-gap-recovery/verification.md。
`assistant-generation-quit-http` 已按异步 prepare/status 契约拆分修复并完整通过 42／42；失败与清理见仓库外私有证据目录。
11、16、20 的独立用户会话均已创建并直接通信；20 已签收，13 与 16 的隔离候选已交付，根下一步处理共享宿主和实际 App 验收。
新增会话都使用独立临时 worktree；内部 thread ID 只保存在仓库外私有协调记录，避免公开历史泄露内部标识。
主会话继续负责唯一共享源集成、冲突裁决和真实桌面／微信验收；本文件只作持久交接，不替代系统目标状态。
