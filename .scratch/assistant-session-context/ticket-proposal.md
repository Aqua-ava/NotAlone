# 持续会话与上下文：第三版拆分与发布映射（13票）

更新：2026-10-11。用户已认可复审修订；本版已按依赖顺序发布，一票一文件。三份正式规格保留，表达样本留存补充按用户明确选择及ADR-044执行。C/R/E只是方案定位标识；正式身份、Blocked by和验收以链接的任务为准。

## 拆分原则

每票交付可独立验证的完整行为，包含所需存储、接口、界面与测试；E01作为离线评测工具，通过报告入口完成闭环。隔离、来源删除、最小日志和失效检查随新增路径交付，不等最后验收补安全。

| 标识 | 正式任务 | Blocked by（标识） | 交付 |
| --- | --- | --- | --- |
| C01 | [assistant-session-context/07 默认会话的一次生成与可靠保存](issues/07-default-session-persistence.md) | 无 | 确认联系人后创建默认助手会话，提交一次已有回复输入，并可通过公开入口读取同一轮讨论及候选。 |
| C02 | [assistant-session-context/08 重新连接后恢复已保存会话](issues/08-saved-session-recovery.md) | C01 | 重新连接或重新打开应用后显示该联系人的已保存讨论与候选，不自动生成。 |
| C03 | [assistant-session-context/09 用户删除一段助手会话](issues/09-delete-assistant-session.md) | C01 | 用户在当前会话主动删除讨论及使用痕迹，再次读取失败，独立微信资料与关系记忆仍保留。 |
| C04 | [assistant-session-context/10 新开、列出与选择旧会话](issues/10-session-list-and-new.md) | C01 | 同一联系人显式新开空会话、查看列表并选择旧会话；保留旧记录且不自动带候选或触发生成。 |
| C05 | [assistant-session-context/11 候选编辑、选择与版本回看](issues/11-candidate-edit-history.md) | C01 | 用户选择和编辑候选，保存修改前后及选择关系；主界面展示新版，可展开旧版并重新选取。 |
| C11 | [assistant-session-context/12 模型预算提醒与超限拒绝](issues/12-input-budget-guard.md) | C01 | 用户提交讨论时看到接近上限提醒，硬上限时不调用模型但可继续查看历史。 |
| C06 | [assistant-session-context/13 连续要求、改口与明确编号指代](issues/13-continuous-intent-reference.md) | C05, C11 | 用户说“第二条自然一点”或改变意愿后继续生成；明确编号映射当前展示组，含糊指代先澄清。 |
| C07 | [assistant-session-context/14 生成中替换请求与迟到结果失效](issues/14-replace-running-generation.md) | C01, C11 | 一次生成未完成时用户提交明确新要求，旧请求失效，新请求得到有效结果。 |
| C08 | [assistant-session-context/15 新消息提醒与用户触发重新生成](issues/15-new-message-opt-in.md) | C05, C07 | 新消息到达保留候选编辑与正在生成的结果，并标记尚未结合；用户点击结合新消息才替换生成。 |
| C09 | [assistant-session-context/16 切换会话或关闭小窗时保持生成归属](issues/16-background-result-ownership.md) | C04, C07 | 切换联系人、切换助手会话或关闭回复小窗后，原生成继续且结果只回到原会话。 |
| C10 | [assistant-session-context/17 退出停止与重开后的中断恢复](issues/17-quit-and-interrupted-recovery.md) | C02, C07 | 真正退出应用停止未完成生成，重开显示“上次生成中断”，只在用户重试后继续。 |
| C12 | [assistant-session-context/18 显式携候选新开与满会话分流](issues/18-carry-selected-candidate.md) | C04, C05, C11 | 在普通或已满会话中选择全新开始，或只带指定候选新开；临时要求与整段讨论不被搬入。 |
| C13 | [assistant-session-context/19 持续会话组合与真实App生命周期验收](issues/19-combined-native-acceptance.md) | C02, C03, C06, C08, C09, C10, C12 | 组合验证双联系人、多会话、预算、修改及删除，再以有限真实App窗口核对关闭/退出/恢复。 |

## 本次复审修订

保留13票。C11预算在正式编号12先发布，C06/C07依赖它，C08经C07沿用同一守卫；C05区分默认展示与用户实际选择。C01基本来源删除从第一天生效，日常使用的会话留存至少等C01+C03，不能把单票保存能力称作完整功能。原01–06仅拆分替代，未执行实现验收；新票07–19没有重用旧身份。

## 依赖、验证与下一步

[总览](../unfinished-work/resplit-20261011.md)记录跨规格依赖和旧票替代；[本功能工作流](planning.md)记录执行入口。共享模块修改需协调合并，不自动成为额外业务阻塞。每票执行自身最小验证，最后组合票只增加交叉证据。真实App和模型语义分别据实报告，OCR继续暂停。
