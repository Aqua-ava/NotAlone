# 真实表达与关系感知：工作流状态

更新：2026-10-12。[正式规格](spec.md)及[第三版拆分](ticket-proposal.md)的E01–E06现均为resolved，38条验收均勾选；完成证据以各票Answer和Comments为准。公开HTTP／页面、来源短片段拒绝、明确直接输入与删除组合已记录在[04](issues/04-style-sample-lifecycle.md)／[05](issues/05-bounded-style-reference.md)／[06](issues/06-combined-fidelity-acceptance.md)，受控模型证据不代签真实语义、自然度或用户相似度。

## 任务索引

| 标识 | 正式任务 | Blocked by |
| --- | --- | --- |
| E01 | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) | None (can start immediately) |
| E02 | [authentic-expression/02 当前意图优先的生成与改写](issues/02-current-intent-priority.md) | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) |
| E03 | [authentic-expression/03 无依据扩写的约束与失败呈现](issues/03-unsupported-content-boundary.md) | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) |
| E04 | [authentic-expression/04 表达样本的主动保存、查看和删除](issues/04-style-sample-lifecycle.md) | None (can start immediately) |
| E05 | [authentic-expression/05 生成时有界引用表达样本](issues/05-bounded-style-reference.md) | [authentic-expression/02 当前意图优先的生成与改写](issues/02-current-intent-priority.md)；[authentic-expression/03 无依据扩写的约束与失败呈现](issues/03-unsupported-content-boundary.md)；[authentic-expression/04 表达样本的主动保存、查看和删除](issues/04-style-sample-lifecycle.md) |
| E06 | [authentic-expression/06 跨场景保真、样本与删除组合验收](issues/06-combined-fidelity-acceptance.md) | [authentic-expression/05 生成时有界引用表达样本](issues/05-bounded-style-reference.md)；[conversation-reply-strategy/10 两种场景的连续修改与消息衔接](../conversation-reply-strategy/issues/10-continuous-scenario-revision.md)；[assistant-session-context/08 重新连接后恢复已保存会话](../assistant-session-context/issues/08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](../assistant-session-context/issues/09-delete-assistant-session.md)；[conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](../conversation-reply-strategy/issues/07-skill-version-continuity.md) |

E01是离线评测闭环；E04是可删除样本管理闭环，两者原先可并行，当前均已关闭。删除助手会话保留主动保存样本，原始来源删除仍传递清除，按ADR-044及E06已有组合验收处理。

## 执行规则

按Blocked by选择前置均完成的任务，在新上下文一次实现一票：读取规格与领域约束→TDD→最小相关及完整相关验证→Standards/Spec评审→记录Answer→本地提交。共享身份和版本约定在首张承接票中明确，不新增只有数据表或接口的任务。

最初规格发布阶段尚未实现；随后完成自主实现及A/B集成，当前6票已关闭。E01 的[离线逐例报告](reports/offline-controlled-v1.json)持久保留16例输入、允许变化、禁止新增内容、原输出、契约结果与显式标注依据，覆盖4例开发集和12例保留集。数据中的15次／1640ms是受控夹具计量，CLI当场没有调用模型；总成本因缺失项保持未知。报告不能证明真实语义、自然度或用户相似度。

E04–E06已经接续正式A/B接口并完成各自原票的自动和公开组合。复制后清空、后来复制、先删会话后短贴等反例及修复保留在原票，不再把中间“待接续”当作当前状态；来源不可判定粘贴明确拒绝，独立直接输入保留，来源删除联动由E05／E06证据核对。历史失败、超时原因未确定及当时的类型问题处理沿原票保留，不据对账预填人工或真实模型质量结果。新增功能冻结，OCR、具体邀约Skill、热梗、自动风格学习与外部模型评测保持原边界。当前入口见[总览](../unfinished-work/README.md)，发布历史见[原记录](../unfinished-work/resplit-20261011.md)。
