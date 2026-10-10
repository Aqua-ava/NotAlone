# 已发布任务全量索引（2026-10-11）

范围：`.scratch/*/issues/*.md`，共166张。状态快照取自原任务字段，包含Markdown引用格式；不把规格、实验报告或草图混入任务数量。

统计：160 resolved、4 claimed、2 open。resolved中5张wontfix，表示关闭处理而非功能交付；历史实验可因结论明确而关闭，旧Swift实现也不代表当前Electron已验收。未关闭项的细节见[总览](README.md)。

本索引不重写历史元数据。部分旧票没有规范的Answer标题，或Triage使用旧值resolved；完成证据须沿原票的完成记录/评论核对，不能只看勾选和字段。本次未重跑历史测试，也未将历史状态格式问题擅自改成新的产品待办。

## app-data-permission-lifecycle

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [修复重复初始化、复用退出与嵌套签名](../app-data-permission-lifecycle/issues/01-bound-runtime-and-signing.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## background-import-tasks

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 导入创建幂等后台任务](../background-import-tasks/issues/01-create-idempotent-import-task.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [02 — Worker 执行记忆提取](../background-import-tasks/issues/02-worker-extract-memory.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 确定性联系人记忆目录](../background-import-tasks/issues/03-deterministic-contact-memory-index.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 删除、恢复和任务留存](../background-import-tasks/issues/04-delete-recover-and-retain-tasks.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [05 — Worker 启动命令](../background-import-tasks/issues/05-worker-command.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## cli-background-sync

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [全局 CLI 增量同步与前台 OCR 双通道](../cli-background-sync/issues/01-global-cli-sync-dual-channel.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## cli-background-sync-backfill

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 已确认会话缺口检测与单联系人补齐](../cli-background-sync-backfill/issues/01-single-contact-gap-recovery.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 可靠位置回退、交错去重与非文字进度](../cli-background-sync-backfill/issues/02-reliable-replay-dedup-and-nontext.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 多联系人有界调度与可恢复补齐](../cli-background-sync-backfill/issues/03-bounded-multi-contact-recovery.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — App 覆盖状态与补齐控制面](../cli-background-sync-backfill/issues/04-app-coverage-control-surface.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 回填暂停时当前联系人仍需实时读取](../cli-background-sync-backfill/issues/05-priority-live-read-when-backfill-paused.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 当前联系人独立三秒级增量读取](../cli-background-sync-backfill/issues/06-priority-contact-three-second-read.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [关闭窗口生命周期缺陷族：永不过期、重复 enable 非幂等、绑定重建丢水位](../cli-background-sync-backfill/issues/07-disabled-window-lifecycle.md) | resolved | wontfix | 关闭但不作为成功交付 |

## contact-identity

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [将 contact_id 迁移为内部稳定身份](../contact-identity/issues/01-migrate-contact-id.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [解除规范消息对微信字段的强制依赖](../contact-identity/issues/02-separate-wechat-fields.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [实现来源级删除与不可检索验证](../contact-identity/issues/03-implement-source-deletion.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## conversation-paths-prototype

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [两条聊天辅助链路的真实模型原型验证](../conversation-paths-prototype/issues/01-model-validation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [同句不同前文的理解与方向验证](../conversation-paths-prototype/issues/02-context-directions.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## core-business-flow

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01：公开 HTTP 核心闭环验收](../core-business-flow/issues/01-http-core-acceptance.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02：失败任务的业务恢复入口](../core-business-flow/issues/02-failed-task-recovery.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03：普通润色的历史查询权限](../core-business-flow/issues/03-rewrite-history-permission.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## desktop-test-scheduling

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [修复跨工作树真实桌面验收的并发与焦点干扰](../desktop-test-scheduling/issues/01-desktop-test-scheduling.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [轻量无头页面验证与生产业务接线](../desktop-test-scheduling/issues/02-headless-page-checks.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## dsh-session-probe

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [持续会话运行时小验证](../dsh-session-probe/issues/01-runtime-comparison.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## hindsight-memory-recall

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 合成数据与词法基线](../hindsight-memory-recall/issues/01-synthetic-lexical-baseline.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 本机 Hindsight 最小闭环](../hindsight-memory-recall/issues/02-local-hindsight-smoke.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 隔离、更新、删除与故障验证](../hindsight-memory-recall/issues/03-lifecycle-isolation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 正式对照实验与报告](../hindsight-memory-recall/issues/04-calibrated-comparison-report.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## import-memory-auto

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01：后台调用让回复优先，并可有界关闭](../import-memory-auto/issues/01-reply-priority-and-bounded-shutdown.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02：导入后可靠自动处理与状态查询](../import-memory-auto/issues/02-reliable-import-memory-wakeup.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## local-wechat-cli-observation

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 建立本地微信 CLI 只读适配器](../local-wechat-cli-observation/issues/01-cli-read-only-adapter.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 实现前台选中会话定位器](../local-wechat-cli-observation/issues/02-selected-session-resolver.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 持久化 CLI 会话绑定与一次性重名确认](../local-wechat-cli-observation/issues/03-conversation-binding-locator.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 增加本地微信观察来源与联系人 cursor](../local-wechat-cli-observation/issues/04-local-observation-cursor-store.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 规范化 CLI 消息并按稳定 ID 去重](../local-wechat-cli-observation/issues/05-message-normalization-dedup.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 实现按联系人切换、补读和恢复的 tail 生命周期](../local-wechat-cli-observation/issues/06-tail-lifecycle-catchup.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07 — 完成前台定位到消息入库的端到端接线](../local-wechat-cli-observation/issues/07-front-session-end-to-end.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [08 — 菜单栏驱动前台同步与状态展示](../local-wechat-cli-observation/issues/08-menubar-sync-driver.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [09 — App bundled wechat-cli 运行时依赖修复](../local-wechat-cli-observation/issues/09-app-bundled-cli-runtime-dependency.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## mac-desktop-app

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01：双窗口 App 与品牌外观](../mac-desktop-app/issues/01-dual-window-app.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02：后端连接与认证退出停读](../mac-desktop-app/issues/02-backend-lifecycle.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03：本机环境诊断与启动恢复](../mac-desktop-app/issues/03-startup-diagnostics.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04：快捷键与小窗桌面操作](../mac-desktop-app/issues/04-window-shortcuts.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05：首启身份与模型配置](../mac-desktop-app/issues/05-first-run-setup.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06：联系人选择与双窗口隔离](../mac-desktop-app/issues/06-contact-session.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07：单联系人历史预览](../mac-desktop-app/issues/07-import-preview.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [08：导入提交、处理进度与重试](../mac-desktop-app/issues/08-import-submit-progress.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [09：草稿改写与候选编辑](../mac-desktop-app/issues/09-draft-rewrite.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [10：真实复制与复制后隐藏](../mac-desktop-app/issues/10-candidate-copy.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [11：按明确方向回复消息](../mac-desktop-app/issues/11-directed-reply.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [12：候选依据与上下文核对](../mac-desktop-app/issues/12-reply-evidence.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [13：关系资料查看与来源回溯](../mac-desktop-app/issues/13-memory-reading.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [14：资料补充、修正与撤销](../mac-desktop-app/issues/14-memory-editing.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [15：来源删除到不可检索](../mac-desktop-app/issues/15-source-deletion.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [16：首次会话选择与绑定授权](../mac-desktop-app/issues/16-binding-consent.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [17：同步开关、停读与补齐](../mac-desktop-app/issues/17-sync-control.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [18：前台定位与人工消歧](../mac-desktop-app/issues/18-foreground-locator.md) | claimed | ready-for-human | 未关闭，见总览 |
| [19：新消息事件与编辑保护](../mac-desktop-app/issues/19-message-events.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [20：本机 App 打包与完整交付验收](../mac-desktop-app/issues/20-mac-app-delivery.md) | open | needs-info | 未关闭，见总览 |

## memory-accuracy-next

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 提示词整合压缩，恢复短消息召回](../memory-accuracy-next/issues/01-prompt-consolidation.md) | resolved | wontfix | 关闭但不作为成功交付 |
| [02 — 待确认候选参与回复（证据类型、理由落库、界面展示）](../memory-accuracy-next/issues/02-pending-in-replies.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 按维度放行自动采纳的准则与实现](../memory-accuracy-next/issues/03-per-dimension-rollout.md) | claimed | ready-for-human | 未关闭，见总览 |
| [04 — 评测用例文件维护](../memory-accuracy-next/issues/04-evaluation-cases-maintenance.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 短期时效记忆自动过期](../memory-accuracy-next/issues/05-transient-memory-expiry.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 记忆界面展示备选解释与短理由](../memory-accuracy-next/issues/06-alternatives-in-memory-ui.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-backlog-completion

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [续跑记忆积压并交付真实结果验收](../memory-backlog-completion/issues/01-complete-authorized-backlog.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-core-claim-retention

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [修复核心事实被扩写与阶段标签丢失](../memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md) | claimed | ready-for-human | 未关闭，见总览 |

## memory-extraction

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 提取接缝、证据契约与主体标注](../memory-extraction/issues/01-extraction-runtime-seam.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — owner 级自我记忆存储与拼接检索](../memory-extraction/issues/02-owner-level-memory.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 自动采纳、置信度门槛与删除指纹](../memory-extraction/issues/03-adoption-threshold-fingerprint.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 写入裁决：同事件演变与版本化失效](../memory-extraction/issues/04-write-adjudication.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 记忆命令族与台账接线](../memory-extraction/issues/05-memory-commands.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 真实提取冒烟与候选回复受益验证](../memory-extraction/issues/06-real-extraction-smoke.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-extraction-accuracy

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 评测骨架与现有用例迁入](../memory-extraction-accuracy/issues/01-evaluation-harness.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 本机真实聊天找错一轮](../memory-extraction-accuracy/issues/02-real-chat-error-hunt.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 主体归属维度评测与修复](../memory-extraction-accuracy/issues/03-subject-attribution.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 真假与意图维度补全](../memory-extraction-accuracy/issues/04-intent-truthfulness.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 时间与时效维度评测与修复](../memory-extraction-accuracy/issues/05-time-and-validity.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 转述与本人维度评测与修复](../memory-extraction-accuracy/issues/06-reported-vs-self.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07 — 指代消解维度评测与修复](../memory-extraction-accuracy/issues/07-reference-resolution.md) | open | needs-info | 未关闭，见总览 |
| [08 — 改写保真维度评测与修复](../memory-extraction-accuracy/issues/08-paraphrase-fidelity.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [09 — 媒体占位维度评测与修复](../memory-extraction-accuracy/issues/09-media-placeholder.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [10 — 模型对照实验与生产配置定案](../memory-extraction-accuracy/issues/10-model-comparison.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [11 — 放行记录与下一轮任务票](../memory-extraction-accuracy/issues/11-release-ledger-and-next.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-extraction-recovery

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 提取失败的批次级恢复](../memory-extraction-recovery/issues/01-batch-failure-recovery.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [提取链路与 CLI 边界遗留项（第二轮审查）](../memory-extraction-recovery/issues/02-extraction-cli-edge-cases.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-extraction-trace

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01：从提取窗口到最终保存结果的可查询追踪](../memory-extraction-trace/issues/01-extraction-trace.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02：从新原始聊天到规范消息的完整来源处理链](../memory-extraction-trace/issues/02-source-processing-trace.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03：在 App 查看全过程并接通所有默认提取入口](../memory-extraction-trace/issues/03-app-and-all-entrypoints.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-method-replication

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [复刻来源叙事与时间机制并完成配对实验](../memory-method-replication/issues/01-paired-experiment.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-recall

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 共享中文词法评分模块](../memory-recall/issues/01-lexical-scorer.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 联系人记忆相关性召回](../memory-recall/issues/02-contact-memory-recall.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 本人记忆独立召回](../memory-recall/issues/03-owner-memory-recall.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 离线召回评测与 CI 门槛](../memory-recall/issues/04-recall-evaluation-gate.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 标定基线与常量固化](../memory-recall/issues/05-calibration-baseline.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 回填架构 current 文档](../memory-recall/issues/06-current-docs-backfill.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [词法召回 MAX_QUERY_CHARS 在分词前截断，长 query 尾部关键词静默归零](../memory-recall/issues/07-query-tail-truncation.md) | resolved | wontfix | 关闭但不作为成功交付 |

## memory-semantic-support

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 来源语义核验与严格评测](../memory-semantic-support/issues/01-source-support-and-evaluation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-skill-context

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 关系记忆采纳与来源证据](../memory-skill-context/issues/01-memory-adoption-provenance.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — L2 联系人记忆目录与失效](../memory-skill-context/issues/02-contact-memory-index-lifecycle.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 基础 ReplyContext 与每轮 Prompt](../memory-skill-context/issues/03-baseline-reply-context.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — L0 历史按需查询 Tool](../memory-skill-context/issues/04-on-demand-l0-tools.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — Skill 目录与按需加载](../memory-skill-context/issues/05-progressive-skill-loading.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 候选回复安全校验与追踪](../memory-skill-context/issues/06-reply-evidence-guardrails.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07 — 检索评测与向量补充](../memory-skill-context/issues/07-retrieval-evaluation-vector-extension.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-source-scope-fidelity

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [修复主张来源范围并完成前后对照](../memory-source-scope-fidelity/issues/01-reproduce-repair-and-compare.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-subject-state-fidelity

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [修复主体与事实状态核验并交付验收对照](../memory-subject-state-fidelity/issues/01-source-checks-and-acceptance.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## memory-time-context

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 全链路记忆时间信息](../memory-time-context/issues/01-memory-time-context.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## migration-and-sync-boundary

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 可恢复迁移命令](../migration-and-sync-boundary/issues/01-migration-runner.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 同步授权规则与默认选择](../migration-and-sync-boundary/issues/02-sync-boundary.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## native-app-backend

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 后端服务骨架与进程内测试接缝](../native-app-backend/issues/01-backend-service-skeleton.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 事件总线与 SSE 契约](../native-app-backend/issues/02-event-bus-and-sse-contract.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — CLI 适配器 --follow 流式读取与事件驱动同步](../native-app-backend/issues/03-follow-stream-event-driven-sync.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 真实微信 --follow 只读冒烟（人工）](../native-app-backend/issues/04-real-wechat-follow-smoke.md) | claimed | ready-for-human | 未关闭，见总览 |
| [05 — 主窗口骨架：联系人列表、同步开关、菜单栏降级](../native-app-backend/issues/05-main-window-skeleton.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 消息流展示与实时更新](../native-app-backend/issues/06-message-stream-view.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07 — 绑定确认界面化](../native-app-backend/issues/07-binding-confirmation-ui.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [08 — 回复闭环](../native-app-backend/issues/08-reply-closed-loop.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [09 — 记忆管理（含 pending 候选确认）](../native-app-backend/issues/09-memory-management.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [10 — 导入与任务进度](../native-app-backend/issues/10-import-and-task-progress.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [11 — Skill 库管理与设置页](../native-app-backend/issues/11-skill-library-and-settings.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [12 — 首启向导与安装脚本](../native-app-backend/issues/12-first-run-wizard-and-setup-script.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [13 — 同步状态读取超时](../native-app-backend/issues/13-sync-status-timeout.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [14 — 回复生成中的 Skill 资源重试导致 500](../native-app-backend/issues/14-reply-skill-resource-retry.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [后端 HTTP 层结构化缺口（第二轮审查遗留项）](../native-app-backend/issues/15-http-robustness-gaps.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [macOS App 与前台探针遗留项（第三轮审查）](../native-app-backend/issues/16-macos-app-probe-gaps.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [拒绝损坏的桌面后端连接地址](../native-app-backend/issues/17-validate-backend-connection.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [按导入端点和错误码显示提交失败](../native-app-backend/issues/18-import-error-classification.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [初始化查询失败后恢复事件订阅](../native-app-backend/issues/19-recover-setup-subscription.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [桌面消息对账连续性与独立历史分页](../native-app-backend/issues/20-message-pagination-continuity.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [菜单栏状态轮询防重入与旧请求失效](../native-app-backend/issues/21-menubar-status-polling.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [App 缺少 Skill 回滚入口](../native-app-backend/issues/22-skill-rollback-entry.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## observation-memory-auto

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 支持增量观察记忆任务的持久状态](../observation-memory-auto/issues/01-observation-task-state.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 观察提交后自动唤醒记忆任务](../observation-memory-auto/issues/02-observation-event-wakeup.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## observation-model-smoke

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 准备真实模型的隔离观察验收入口](../observation-model-smoke/issues/01-prepare-isolated-entry.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## pgvector-memory-recall

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 临时 PostgreSQL＋pgvector 运行与实验向量表](../pgvector-memory-recall/issues/01-isolated-pgvector-runtime.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 向量候选导航与本地权威复验](../pgvector-memory-recall/issues/02-vector-candidate-revalidation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 独立阈值校准与 A/B 评测](../pgvector-memory-recall/issues/03-calibrated-ab-evaluation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 生命周期、安全、清理与报告](../pgvector-memory-recall/issues/04-lifecycle-cleanup-report.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## postgres-memory

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 实现 PostgreSQL MemoryStore](../postgres-memory/issues/01-postgres-memory-store.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [并发来源删除 × 提取 worker：owner 记忆创建绕过来源校验，留下引用已删消息的残留](../postgres-memory/issues/02-owner-memory-concurrent-deletion-residue.md) | resolved | wontfix | 关闭但不作为成功交付 |

## postgres-reply-store-skill-port

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [回复链路语义缺口（第二轮审查遗留项）](../postgres-reply-store-skill-port/issues/01-reply-tooling-and-contract-gaps.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## postgres-retrieval

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 实现 PostgreSQL 消息检索](../postgres-retrieval/issues/01-postgres-message-retrieval.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [检索层性能与结构缺口（第二轮审查）](../postgres-retrieval/issues/02-retrieval-performance-and-structure.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## real-memory-fidelity-repair

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 已有记忆原文审计及语义回归](../real-memory-fidelity-repair/issues/01-audit-and-repair.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## real-model-integration

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — DeepSeek 模型构造与可选冒烟](../real-model-integration/issues/01-deepseek-model-provider.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 出站台账 port 与 PostgreSQL 持久化](../real-model-integration/issues/02-outbound-ledger.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 台账接线真实调用与失败路径收敛](../real-model-integration/issues/03-wire-ledger-and-failure-paths.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## reply-module-flow

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — 外层流程验证联系人与会话范围](../reply-module-flow/issues/01-validate-conversation-scope.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [02 — 统一回复与改写输入](../reply-module-flow/issues/02-unify-reply-inputs.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链](../reply-module-flow/issues/03-scoped-context-retrieval-memory.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [04 — 收敛 ReplyStore 的幂等与候选生命周期](../reply-module-flow/issues/04-reply-store-lifecycle.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [05 — 持久化已验证会话绑定](../reply-module-flow/issues/05-persist-conversation-binding.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [06 — 接入 PostgreSQL ReplyStore](../reply-module-flow/issues/06-postgres-reply-store.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [07 — 接入 PostgreSQL SkillPort](../reply-module-flow/issues/07-postgres-skill-port.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [08 — 完成候选回复端到端集成与边界验收](../reply-module-flow/issues/08-end-to-end-reply-boundaries.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## reply-timeout

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [回复与继续生成的运行时限及超时收尾](../reply-timeout/issues/01-bounded-continuation.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [大历史联系人回复生成时模型不产出结构化输出，预算内循环后失败](../reply-timeout/issues/02-structured-output-loop.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |
| [回复生成租约与模型超时矛盾：长生成结果必然被丢弃](../reply-timeout/issues/03-lease-vs-model-timeout.md) | resolved | wontfix | 关闭但不作为成功交付 |

## reply-vertical-slice

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [实现正式候选回复纵切](../reply-vertical-slice/issues/01-implement-reply-generator.md) | resolved | ready-for-agent | 原票范围已关闭；具体证据及限制见原文 |

## skill-library

| 任务 | State | Triage | 解释 |
| --- | --- | --- | --- |
| [01 — Skill 包导入与原子发布](../skill-library/issues/01-import-and-publish.md) | resolved | ready-for-human | 原票范围已关闭；具体证据及限制见原文 |
| [02 — Reply Runtime 渐进式加载 Skill 辅助资源](../skill-library/issues/02-runtime-resource-loading.md) | resolved | resolved | 原票范围已关闭；具体证据及限制见原文 |
| [03 — Skill 版本生命周期与回滚](../skill-library/issues/03-lifecycle-and-rollback.md) | resolved | resolved | 原票范围已关闭；具体证据及限制见原文 |
| [04 — Skill 删除与隐私清理](../skill-library/issues/04-delete-and-privacy-cleanup.md) | resolved | resolved | 原票范围已关闭；具体证据及限制见原文 |
| [05 — Skill 导出与试用预览](../skill-library/issues/05-export-and-preview.md) | resolved | resolved | 原票范围已关闭；具体证据及限制见原文 |
