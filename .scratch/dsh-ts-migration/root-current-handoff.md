# 根迁移持续目标
用户明确要求把“全新 Codex 会话，不是 sub-agent；会话直接通信；主会话统一集成并独占 App/微信验收”作为目标约束。
当前结论：DSH/TS 回复切片已由根完成 `ran` 实际 App 验收，票 08 已 resolved；证据见 [记录](reply-app-acceptance/ts-l3-real-app-20261025.md)。
票 12 已在 `0b039f97` 接入共享宿主并完成 `ran` 实际 App 只读追踪验收；历史显示 78 条且完整，来源批次详情 93 条，消息反查回到同批次。
既有模型许可 journal 有 5 条旧 TS `unknown`；Python 默认回退按设计 fail-closed。本轮仅开发进程显式使用 `NOTALONE_REPLY_RUNTIME=typescript`，未改 `.env`，后续切换票须收口恢复策略。
票 20 显式 TS 历史实机验收发现公开 `cli_history_coverages=[]` 时 `ran` 显示“尚未确认”，但生成门禁仍放行；一次生成得到无结果且保持 unknown，未重试。票 20 继续 claimed。
`assistant-generation-quit-http` 已按异步 prepare/status 契约拆分修复并完整通过 42／42；失败与清理见仓库外私有证据目录。
下一步必须创建 11、16、20 三个全新 Codex 会话，它们是并列任务而非 sub-agent；会话之间直接发送 thread ID 协调。
已创建并运行三个会话；thread ID 只保存在仓库外私有协调记录，避免公开历史泄露内部标识。
每个新会话使用独立临时 worktree 与合成 `_test` PG，不写主树、不运行实际 App/微信、不发送外部消息、不 push/打包。
主会话继续负责唯一共享源集成、冲突裁决和真实桌面／微信验收；本文件只作持久交接，不替代系统目标状态。
