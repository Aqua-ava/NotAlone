# 21 Vision 并行任务

接手 DSH/TS 迁移票 21 的 Vision 阻塞诊断与可行实现，不要只做只读报告。所有路径均相对仓库根目录。

1. 先读 `docs/agents/workflow.md`、`engineering.md`、`domain.md`，再读 `.scratch/dsh-ts-migration/spec.md` 的 21、`planning.md`、`next-agent-handoff.md` 和 `foreground-location/` 证据。
2. 遵守 ADR-049：只处理当前前台唯一微信窗口的自动定位会话名称区，不读聊天正文/列表，不切换或滚动，视觉帧仅端侧内存。
3. 查明 Vision/ANE XPC 最小安全诊断，尝试可逆固定材料原生正例。不得用 mock 冒充真实 OCR；不得改 2500ms 产品预算或降低门槛。
4. 不占用主开发 App/微信。需要实际桌面操作时给 root 精确矩阵。测试用独立临时文件和合成窗口，PG 禁止写 5432 的 `notalone_dev`。
5. 不修改 07 UI、10 extraction 或 root 正在改的 L3 回复文件；不打包、push、PR。
6. 用户明确授权并行：需要 07/10 接口结论时，直接给 `/root/task07_ui_audit` 或 `/root/task10_integration_audit` 发消息，并同步 `/root`。

交付：根因和最小复现；修复/补丁或环境阻塞证明；2500ms 正反例证据；root 需要的唯一 App 操作；资源清理和剩余风险。审计写 `root-next-21/audit.md`，完成后向 root 发 `FINAL_ANSWER`。
