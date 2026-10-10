# 持续会话与上下文：工作流状态

更新：2026-10-11。[正式规格](spec.md)及[第三版拆分](ticket-proposal.md)已确认，13张独立任务已发布，均为open / ready-for-agent；功能尚未实现。

## 任务索引

| 标识 | 正式任务 | Blocked by |
| --- | --- | --- |
| C01 | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) | None (can start immediately) |
| C02 | [assistant-session-context/08 重新连接后恢复已保存会话](issues/08-saved-session-recovery.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) |
| C03 | [assistant-session-context/09 用户删除一段助手会话](issues/09-delete-assistant-session.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) |
| C04 | [assistant-session-context/10 新开、列出与选择旧会话](issues/10-session-list-and-new.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) |
| C05 | [assistant-session-context/11 候选编辑、选择与版本回看](issues/11-candidate-edit-history.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) |
| C11 | [assistant-session-context/12 模型预算提醒与超限拒绝](issues/12-input-budget-guard.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) |
| C06 | [assistant-session-context/13 连续要求、改口与明确编号指代](issues/13-continuous-intent-reference.md) | [assistant-session-context/11 候选编辑、选择与版本回看](issues/11-candidate-edit-history.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](issues/12-input-budget-guard.md) |
| C07 | [assistant-session-context/14 生成中替换请求与迟到结果失效](issues/14-replace-running-generation.md) | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](issues/12-input-budget-guard.md) |
| C08 | [assistant-session-context/15 新消息提醒与用户触发重新生成](issues/15-new-message-opt-in.md) | [assistant-session-context/11 候选编辑、选择与版本回看](issues/11-candidate-edit-history.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](issues/14-replace-running-generation.md) |
| C09 | [assistant-session-context/16 切换会话或关闭小窗时保持生成归属](issues/16-background-result-ownership.md) | [assistant-session-context/10 新开、列出与选择旧会话](issues/10-session-list-and-new.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](issues/14-replace-running-generation.md) |
| C10 | [assistant-session-context/17 退出停止与重开后的中断恢复](issues/17-quit-and-interrupted-recovery.md) | [assistant-session-context/08 重新连接后恢复已保存会话](issues/08-saved-session-recovery.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](issues/14-replace-running-generation.md) |
| C12 | [assistant-session-context/18 显式携候选新开与满会话分流](issues/18-carry-selected-candidate.md) | [assistant-session-context/10 新开、列出与选择旧会话](issues/10-session-list-and-new.md)；[assistant-session-context/11 候选编辑、选择与版本回看](issues/11-candidate-edit-history.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](issues/12-input-budget-guard.md) |
| C13 | [assistant-session-context/19 持续会话组合与真实App生命周期验收](issues/19-combined-native-acceptance.md) | [assistant-session-context/08 重新连接后恢复已保存会话](issues/08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](issues/09-delete-assistant-session.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](issues/13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](issues/15-new-message-opt-in.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](issues/16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](issues/17-quit-and-interrupted-recovery.md)；[assistant-session-context/18 显式携候选新开与满会话分流](issues/18-carry-selected-candidate.md) |

原01–06保留文件和历史，以resolved / wontfix结清“拆分替代”，不代表实现成功。其Answer链接到新票，当前从07开始，不领取旧票。C11预算的正式编号为12，先于连续讨论13和替换生成14。

## 执行规则

按Blocked by选择前置均完成的任务，在新上下文一次实现一票：读取规格与领域约束→TDD→最小相关及完整相关验证→Standards/Spec评审→记录Answer→本地提交。共享身份和版本约定在首张承接票中明确，不新增只有数据表或接口的任务。

本轮仅完成规格补充和任务发布，未实现或验收产品。OCR、具体邀约Skill、热梗、自动风格学习与外部模型评测保持原边界。跨功能并行见[总览](../unfinished-work/resplit-20261011.md)。
