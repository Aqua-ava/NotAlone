# 真实表达与关系感知：工作流状态

更新：2026-10-11。[正式规格](spec.md)及[第三版拆分](ticket-proposal.md)已确认，6张独立任务已发布，均为open / ready-for-agent；功能尚未实现。

## 任务索引

| 标识 | 正式任务 | Blocked by |
| --- | --- | --- |
| E01 | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) | None (can start immediately) |
| E02 | [authentic-expression/02 当前意图优先的生成与改写](issues/02-current-intent-priority.md) | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) |
| E03 | [authentic-expression/03 无依据扩写的约束与失败呈现](issues/03-unsupported-content-boundary.md) | [authentic-expression/01 保真评测的离线逐例报告](issues/01-offline-fidelity-report.md) |
| E04 | [authentic-expression/04 表达样本的主动保存、查看和删除](issues/04-style-sample-lifecycle.md) | None (can start immediately) |
| E05 | [authentic-expression/05 生成时有界引用表达样本](issues/05-bounded-style-reference.md) | [authentic-expression/02 当前意图优先的生成与改写](issues/02-current-intent-priority.md)；[authentic-expression/03 无依据扩写的约束与失败呈现](issues/03-unsupported-content-boundary.md)；[authentic-expression/04 表达样本的主动保存、查看和删除](issues/04-style-sample-lifecycle.md) |
| E06 | [authentic-expression/06 跨场景保真、样本与删除组合验收](issues/06-combined-fidelity-acceptance.md) | [authentic-expression/05 生成时有界引用表达样本](issues/05-bounded-style-reference.md)；[conversation-reply-strategy/10 两种场景的连续修改与消息衔接](../conversation-reply-strategy/issues/10-continuous-scenario-revision.md)；[assistant-session-context/08 重新连接后恢复已保存会话](../assistant-session-context/issues/08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](../assistant-session-context/issues/09-delete-assistant-session.md)；[conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](../conversation-reply-strategy/issues/07-skill-version-continuity.md) |

E01是离线评测闭环；E04是可删除样本管理闭环，两者可先并行。删除助手会话保留主动保存样本，原始来源删除仍传递清除，按ADR-044及E06组合验收。

## 执行规则

按Blocked by选择前置均完成的任务，在新上下文一次实现一票：读取规格与领域约束→TDD→最小相关及完整相关验证→Standards/Spec评审→记录Answer→本地提交。共享身份和版本约定在首张承接票中明确，不新增只有数据表或接口的任务。

本轮仅完成规格补充和任务发布，未实现或验收产品。OCR、具体邀约Skill、热梗、自动风格学习与外部模型评测保持原边界。跨功能并行见[总览](../unfinished-work/resplit-20261011.md)。
