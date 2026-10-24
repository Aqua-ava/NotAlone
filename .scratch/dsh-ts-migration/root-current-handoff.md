# 根迁移持续目标

用户已把以下约束写入目标正文：无依赖任务必须创建全新、用户可见的 Codex 会话，不是 sub-agent；会话直接通信，主会话统一集成并独占 App／微信验收。验收联系人使用 `ran`；不得发送未明确指定的外部消息。

当前 HEAD 为 `021a7038`：

- `80518cb9`：修复记忆页“继续处理”未调用唯一 TS Worker wake。
- `7eb823f8`：修复自然过期维护持久收敛；过期资料不重新生成，全过期按 ADR-080 收敛为 `empty`。
- `8d0c3327`：唯一 Worker 接管 `index|verify`，确定性目录最多 20 主题，来源、revision 和联系人隔离完整。
- `c9fae483`：唯一 TS Worker 接管 `organize_memory`，Python 只保留 L2 管理与入队。
- `021a7038`：修正记忆处理页面回归，按当前“更多操作”入口进入资料修正；13 项 React 用例通过。

已通过的最小验证：

- TS 严格类型检查；index/verify 30/30；宿主、导入、resume wake 44/44。
- L2 共享宿主及来源追踪 5/5；memory-processing controller 9/9；Python L2 管理 40/40。
- 600 秒全量 TS 测试曾超时终止，不能宣称全量通过；不得用局部结果替代最终矩阵。

用户可见会话（均非 sub-agent）：

- 13 L2：源码已集成，idle，票保持 claimed。
- 16 导入：提取 Worker 已集成，idle，票保持 claimed。
- index/verify：已集成 `66ee9f89`。
- 自然过期维护：已集成 `97ca4344`。
- resume wake：已集成 `6b3a3219`。
- invalid_output 脱敏诊断：active。

开发 App 经持久 PTY `2981` 运行 `npm run dev`；reply/history/extraction/task Worker 均为 TypeScript，唯一 Worker `068109fd-a3f1-4382-adc6-6049746e3768`。owner `6b0faa77-8bcf-4a14-a627-7629265624da`，`ran` contact `aaf9796e-1c92-4608-b9be-dc06a48df194`，任务 `4db4510b-a7e8-450b-b8b8-cc0b3b71751e`，78 条。

真实任务父状态 `running`、`extract_memory=retryable/invalid_output`、0/78，水位未推进，无候选或记忆。A receipt 成功；失败在 `SourceVerificationOutput` 根级工具参数或 `{results:[...]}` 包络校验，trace 没有 `verification_return`。不得放宽证据真实性、跳过 V、自动采纳或盲目重复“继续处理”。

下一步：

1. 等诊断会话提交后审查事件不含聊天正文、引文、prompt 或原始模型参数。
2. 集成最小修复，运行 extraction/model/protocol/contract、Runner、tsc 和公开扫描。
3. 正常退出并重启同一 TS 宿主后，在 `ran` 只点一次“继续处理”，等待真实 A/V、B、index、verify 完整结算。
4. App 内验收候选/记忆、来源、L2/L3 links、目录 revision、修正及删除；仅删除本次生成且证据明确的测试对象，不发送消息。
5. 13、16 实际验收闭合后按依赖创建 14→15、17、22、24→25→26 的全新用户会话。
6. 最终完成切换/回退、同模型质量与费用矩阵、真实 App/微信范围验收，再移除 Python/LangChain/LangGraph/Deep Agents 启动链；禁止 push、打包、PR。
