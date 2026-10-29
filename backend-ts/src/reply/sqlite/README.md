# SQLite 助手讨论与运行副本（实施11）

`schema.ts` 导出 `discussionMigration(version)`，暂号由集成方重新分配，已发布迁移不修改。

11拥有 `assistant_discussion`、`discussion_entry`、`reply_request`、`reply_attempt`、`reply_context`、`reply_context_item`、`runtime_copy`、`runtime_context`、`runtime_file`。07拥有通用模型调用和实际追踪表；必须组合安装后才能写发言和副本，不能给缺失父表提供空壳或关闭FK。

请求固定 `owner_id/contact_id/discussion_id`、`request_key`、`trigger_entry_id` 和身份依据。手动依据引用02的 `manual_confirmation`；自动依据引用同contact绑定和verification。请求先插入、触发用户发言随后插入，在同一短事务内由延迟FK完成闭环。`reply_attempt` 的 `lease_token/accepted_data_generation/accepted_discussion_generation/accepted_source_revision` 必须在每次写入复验。删除后旧请求不得换ID复活。

`reply_context` 的 request分支必须有真实 `request_id/attempt_id`，rebuild分支两者均NULL。当前材料仅开放真实message+capture_record、同讨论entry及实际Skill修订。候选/选择、偏好与文档分支由后续票增量扩展，不预建不存在的父表。运行副本通过 `runtime_context` 记录所有实际纳入的context，不能只存展示依据。

07接reply分支的合同：`model_operation.reply_request_id`；`model_call.reply_attempt_id/reply_context_id`；`execution_event.reply_attempt_id/originated_call_id`；`execution_input.reply_context_id/context_item_no`。模型发言引用真实成功call及其 `kind='assistant_message'` 的实际事件；事件JSON `text` 与发言正文完全一致，call所属attempt.request和operation.reply_request均须等于发言请求。候选编辑不写讨论模型发言。

`runtime_copy` 在创建目录前保存副本ID、官方SessionId、不可复用定位、讨论代次及contact资料代次。`address_json` 为05完整ManagedAddress（含父目录身份）；只有登记真实身份后才可dirty/写DSH。业务提交、官方flush/close、事件摘要与配置/来源核验分别完成后才ready。dirty/preparing不能直接恢复。

`runtime_file` 是关闭排空后完整清单，包含根目录及全部子目录/文件的独立身份。`manifest_complete` 不能由目录不存在推定；无身份准备件须通过同一创建意图核验后显式登记。删除fence后只准登记关闭产生的清理清单，不重新开放DSH writer。沿05同一operation的typed文件目标及holderKeys清理，文件I/O位于事务外。

`runtime_file` 仅是 `runtime_copy.expected_identity` 的完整子项文件身份索引，辅助05生成typed `deletion_target`；它不拥有独立删除操作或进度账本。唯一删除operation、计划修订、runner及最终复核均沿05。副本状态沿统一设计的preparing/dirty/ready/blocked/deleting/deleted；退役表示不再由current_runtime_id指向，不新增状态。

`deletion.ts` 导出 `collectDiscussionDeletionImpact(tx,operation)` 无正文影响清单，07通用调用/追踪清理复用同一实际输入闭包。来源通过真实context材料反查请求、后续entry引用及同一运行副本后续纳入位置，包含非current副本。注册次序为通用模型/追踪域、本讨论域、identity、skill_metadata。讨论域在跨域模型FK仍被引用时保持blocked，不清空未释放的父件。

精确讨论用 `discussionDeletionAuthority`，组合以 `withDiscussionDeletionAuthority(existing)`；`discussionDeletionRequiredDomains` 必须合入requiredDomains。contact_history仅清与聊天来源有关的请求和副本，独立user-only讨论及其无正文手动归属依据保留；旧确认仍受contact资料代次阻止新写入。联系人/账号删除继续清这些依据。

请求幂等命名空间固定为 `databaseId:discussion.begin`，request_key在同owner内唯一。相同key重送仅回查原contact/原讨论/原请求，跨contact、正文冲突、取消或失效均拒绝；空闲分段前先检查该键，不能因十二小时或换段重送模型。05以相同namespace/key写删除墓碑，来源闭包清理后仍不可重受理。

删除fence先把受影响实际发言从available不可逆转为cleared，擦除正文并断开实际call/event引用（请求身份保留到后续清行）。available状态始终要求真实成功call和原始事件，不允许更新旧正文；cleared不能复活。这样07可在排空后先清追踪，11随后清请求闭环，blocked期间产品读口也不会返回旧正文。文件目标仅在官方所有者排空、完整manifest登记后产生，不能提前冻结活动writer的旧清单。
