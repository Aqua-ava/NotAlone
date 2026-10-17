# 归档草稿与未提交记录收尾

2026-10-17，基线 `7b2f936b`。用户要求检查清理后保留的草稿和主目录七份未提交文件，将适合合入的内容验证并提交；随后检查公开隐私，检查通过后推送 `main`。本次不恢复旧工作树、不新增构建包、不运行真实模型或迁移业务资料。

## 主目录七份记录

七份文件均为 A01 来源忠实性局部回归的历史记录：三个任务评论、两份目标断点、固定计划的终态及一份结果文档。对照保留的 `completion.json` 与独立终态回执，核验 SHA-256、两次请求、14 字段、局部两项完整结果、累计 68 次请求及关闭状态，内容一致，补入主线。

结果仍限定为 2026-10-14 的单窗局部回归，完整 21 窗、140 窗及逐维度质量均未据此认证；自动采纳为零。结果文档增加历史截止说明，旧“下一步”不作为当前执行指令，不恢复旧预算。私有原始回执继续留在忽略目录，仅提交现有结果摘要。

## 草稿逐组处置

以下文件数均为快照相对父提交的增量。核验依据包括逐文件 blob 对比及当前生产入口、数据合同和相关测试的静态覆盖；本次不把静态审计写成新运行验收。

| 来源 / 恢复快照 | 文件数 | 处置与覆盖依据 |
| --- | ---: | --- |
| authentic-expression-page-diagnosis / `9684fb32` | 1 | headless 表达分组测试与主线逐字相同，不重复合入。 |
| author-quote-proof-b / `a628e29e` | 17 | 5 文件相同；其余已由当前来源证明、V4、有界窗口、代际失效实现及后续 ADR/spec 覆盖，保留新版。 |
| conversation-reply-strategy / `8857d2d8` | 12 | 2 个 headless 测试相同；生成归属、准备命令身份、队列、关闭恢复和终态复验已有后续实现，不回退。 |
| mac-app-12-reply-evidence / `127e908c` | 1 | 仅旧 `desktop/node_modules` 绝对路径符号链接，不属于可提交交付。 |
| skill-learning-review / `c2999155` | 10 | 当前 Skill 学习已具备授权版本、幂等、联系人外键、来源删除、runner、审核发布和回滚；不覆盖为旧骨架，也不覆盖现行迁移。 |
| authentic-expression-c / `4a402261` | 1 | `048_assistant_sessions.sql` 与主线逐字相同。 |
| reply-strategy-b / `0e9543fe` | 48 | 补回独有的[六条合成语义用例](../conversation-reply-strategy/semantic-cases.md)。其余旧探索代码由持久操作 UUID、输入版本和重放保护的当前服务、`exploration-client.ts`、`StrategyControls.tsx` 及对应页面/持久化测试承接。 |
| standalone-wechat-setup / `6a4cce04` | 27 | 1 个旧认领状态、12 个桌面文件和 14 个原生文件。按 [ADR-065](../../architecture/adr/065-manual-input-standalone-first-release.md) 保留延期与恢复快照，不恢复已中止的特权初始化路线；草稿也未接通完整主进程及原生构建。 |

额外复核早期归档 `00f5ac8d` 的 8 文件：旧观察调度已由 `EventBusMessagePublisher.publish_message_created` → `TaskHost.wake_observation` → `enqueue_observation_message` 接管，当前 `test_observation_auto_flow.py` 包含调度失败隔离，不恢复旧 scheduler。

恢复引用及含未提交内容的快照继续仅在本地保留，不合并原始未脱敏谱系，不推送恢复引用。新增合成用例明确原阶段与本次补回的区别，不新增真实模型或人工质量结论。

## 验证与数据边界

- 历史回执摘要及关键计数对照通过；没有新增模型请求。
- 对本次变更检查 Markdown 文件链接、任务元数据和 `git diff --check`。
- 提交前后检查当前文件与 `main` 完整可达历史中的隐私风险，并核对忽略规则及二进制资产。
- 本次仅补交记录与合成用例，不改变运行时代码、SQL、自动采纳、资料读取或发送能力；不重建 App，不运行业务库迁移。
