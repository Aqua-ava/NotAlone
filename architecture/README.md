# NotAlone 架构阅读入口

本页只负责按任务定位文档。产品硬边界见 [AGENTS.md](../AGENTS.md)，领域词汇见 [CONTEXT.md](../CONTEXT.md)；现行要求集中在 `current/`，实现与验收按代码、测试和具名记录分别核验。

## 按任务阅读

先定位相关章节；需要核验某项决定的来源或复审取舍时，再读该章节引用的 ADR 及其有效范围。默认检索现行规格和相关实现，历史材料按追溯需要读取。

| 当前任务 | 现行入口 |
| --- | --- |
| 联系人身份、消息、关系资料、记忆与检索的数据边界 | [领域与数据契约](current/domain-data.md) |
| 了解完整产品闭环 | [核心流程](current/core-flows.md)；各业务详细合同按下面分支读取 |
| 连接联系人、历史与增量同步、图片／引用或前台定位 | [微信同步与前台定位](current/wechat-sync.md) |
| 候选回复、输入预算、工具或助手会话 | [回复生成](current/reply-generation.md) |
| 图文记忆、自动采纳、历史／增量调度、后台任务与恢复 | [记忆处理](current/memory-processing.md) |
| 模型调用、资料出站、持久运行记录、来源失效与删除 | [隐私与删除](current/privacy-deletion.md)；运行记录见 [DSH 数据边界](current/privacy-deletion.md#dsh-迁移的数据边界) |
| Skill 发现、启用、组合、审核发布与删除 | [Skill Library](current/skill-library.md) |
| 记忆提取过程、来源反查与追踪删除 | [记忆提取追踪](current/memory-extraction-trace.md) |

当前开发入口是 Electron／React 桌面与 TypeScript／DSH 后台，业务存储使用受控本机 SQLite。源码导航见[后台说明](../backend-ts/README.md)和[模块入口](../backend-ts/src/README.md)，桌面开发及发布边界见[工程工作流](../docs/agents/engineering.md)。涉及 DSH 接线或生命周期时执行[源码查证流程](../docs/agents/dsh-development.md)。这些入口不替代实际运行与质量验收。

## 按需查阅

| 目的 | 入口与边界 |
| --- | --- |
| 理解决定原因、核验条款来源或复审既有取舍 | [ADR 完整目录](adr/README.md)。先读目标 ADR 的替代提示，标题和“已采纳”记录不表示所有旧条款仍有效。 |
| 核对历史评测协议、旧接口或阶段实现 | [历史协议与实施记录](history/README.md)。三门等流程仅保留于显式历史协议；默认自动采纳从现行记忆处理与数据契约定位。 |
| 讨论尚未决定的表达质量问题 | [真实表达草案](drafts/authentic-expression.md)。热梗、自动风格学习和长期影响仍为研究方向；已收束的第一版讨论及旧样本方案不作为当前要求。 |
| 追溯旧框架、会话、记忆或 Skill 讨论 | [历史设计归档](drafts/archive/README.md)。旧路径的简短跳转页仅兼容历史任务链接。 |
| 查任务范围、实施进度或当时验收 | 按[任务约定](../docs/agents/issue-tracker.md)读取对应 `.scratch/` 记录；公开验证材料见[文档索引](../docs/README.md)。历史结果只覆盖记录中的版本与范围。 |

## 文档职责与更新

- `CONTEXT.md` 定义领域词汇，`current/` 保存当前已采纳要求。
- `drafts/` 保存尚未收束的设计；已收束讨论正文进入 `drafts/archive/`，具体后继见归档目录。
- `adr/` 保存决定及原因。部分替代时标明失效条款、仍有效范围和后继链接，保留原路径供追溯。
- `history/` 保存退出当前正文的旧协议和阶段实现记录；现行规格正文应直接说明适用要求，ADR 作为来源，历史材料按需追溯。
- 决定、实现和验收状态分别记录；实际进度写入对应任务或验证记录，架构首页保持阅读路由。

设计变更时同步受影响的现行规格、ADR 状态与阅读入口。完成条件及冲突处理见[领域文档工作流](../docs/agents/domain.md#设计变更的文档收敛)。
