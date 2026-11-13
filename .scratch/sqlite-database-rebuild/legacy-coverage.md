# 旧业务结构到新逻辑模型覆盖矩阵

日期：2026-10-28。只读静态分析，未连接数据库。

静态重放 **128** 份迁移，123 次 CREATE、8 次 DROP，最终 **115 张业务表**；不含程序另建迁移账本。

## 分类统计

| 分类 | 数量 |
| --- | --- |
| retain | 20 |
| merge | 74 |
| drop_legacy | 9 |
| diagnostic_only | 4 |
| unmapped | 8 |

分类是逻辑模型覆盖建议，不是已经迁移、实现或验收。diagnostic_only 表示能力用途，不证明当前数据只在测试库。

## 必须闭合的缺口

- **manual_scope_confirmation**：手动联系人确认真实持久身份和代次尚缺；不能只用turn.scope_origin或伪造binding。 依据：backend-ts/src/host/pure-ts-reply-scope.ts:20–46；backend-ts/src/contacts/contact-context.ts:51。
- **memory_collection_revisions**：联系人/本人memory_revision集合修订需明确物理落点，不能拿单条head、最大version或文档dirty代替。 依据：018_contact_memory_index.sql:3–13；064_owner_memory_revision.sql:2–8；reply-context.ts:149–151。
- **sealed_reply_keys**：子回复旧键封存与删除操作key不同，需要长期防重放合同。 依据：backend-ts/src/reply/discussion/assistant-generation-store.ts:118；backend-ts/src/reply/generation/reply-assistant-erasure.ts。
- **scope_mode**：selected/all_private及其显式授权尚未被开关bool覆盖，须明确当前产品范围收敛。 依据：backend-ts/database/migrations/100_all_private_sync_scope.sql:4–13。
- **quality_storage_boundary**：仅createRun受_test门禁，case准备/读取/审阅没有同一门禁，不能把全部质量数据视为当前纯测试数据。 依据：backend-ts/src/diagnostics/organization-quality-store.ts:42–118,122–142。
- **owner_display_name**：仅查到初始化写入/结构检查，未见功能读取；候选不带入字段，但初始化API必须适配。 依据：backend-ts/src/platform/database/host-storage.ts:239。
- **retrieval**：当前词法/embedding在运行时语料上计算，未发现持久vector/tsvector表；不能无消费者新增向量表。范围、来源、有效期与候选保护过滤仍需迁移。 依据：backend-ts/src/retrieval/retrieval-hybrid.ts:4–23；backend-ts/src/reply/context/reply-context-memory.ts:54–76。
- **followup_observation**：可靠同binding/task锚点后续观察仍标sending_status/effectiveness unknown；原source/observation可靠性不可因合并而丢，不能推已发送。 依据：backend-ts/src/skills/skill-learning-materials.ts:133–168。
- **front_switch_consumers**：front_sync_state同一bool被前台和CLI共同使用，可并account控制但两端都需迁移，不是另加一张独立开关表。 依据：backend-ts/src/foreground/foreground-location-api.ts:27；backend-ts/src/sync/sync-incremental-store.ts:173–181。

## 逐表矩阵

| 旧表 | 分类 | 新逻辑目标 | 主要证据 | 边界／备注 |
| --- | --- | --- | --- | --- |
| assistant_candidate_selection | merge | assistant_selection | backend-ts/src/reply/discussion/assistant-discussion-service.ts:298；backend-ts/src/reply/discussion/reply-discussion-context.ts:94 | 显式选择指具体版本，复制/编辑不自动选择或证明发送。 |
| assistant_candidate_version | merge | reply_candidate_version | backend-ts/src/reply/discussion/assistant-discussion-service.ts:271；backend-ts/src/reply/discussion/assistant-generation-continuation.ts:81 | 统一原稿和用户编辑版本，完整父版范围FK和幂等edit key。 |
| assistant_runtime_deletion_target | merge | deletion_file_target | backend-ts/src/reply/runtime/assistant-runtime-erasure.ts:11；backend-ts/src/reply/runtime/assistant-runtime.ts:347 | 目标独立于live业务行，FK删除操作，预期目录/manifest身份先持久化，同操作可安全重试。 |
| assistant_runtime_session | merge | assistant_runtime_instance、assistant_runtime_context | backend-ts/src/reply/discussion/assistant-discussion-service.ts:411；backend-ts/src/reply/runtime/assistant-runtime-erasure.ts:19 | 业务记录权威与JSONL运行副本分层，current映射、完整资格、配置和真实event seal保留；重建不伪造turn。 |
| assistant_session | retain | assistant_session | backend-ts/src/reply/discussion/assistant-discussion-service.ts:205；backend-ts/src/reply/discussion/assistant-generation-store.ts:64 | 当前会话、输入、选择、runtime指针均同session；浏览历史不切current。 |
| assistant_session_input | merge | assistant_turn | backend-ts/src/reply/discussion/assistant-discussion-service.ts:455；backend-ts/src/reply/discussion/assistant-generation-format.ts:13 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。 |
| assistant_session_turn | merge | assistant_turn | backend-ts/src/preferences/preference-erasure.ts:21；backend-ts/src/reply/discussion/assistant-discussion-service.ts:89 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。 |
| background_task | retain | background_task | backend-ts/src/contacts/contact-context.ts:41；backend-ts/src/host/host-model-accounting.ts:33 | 有限工作任务复用，记忆task归属及固定输入合同明确。删除控制账本独立于被删owner生命周期。 |
| background_task_step | retain | background_task_step、step_attempt、step_attempt_guard | backend-ts/src/host/host-model-accounting.ts:34；backend-ts/src/host/pure-ts-task-events.ts:22 | 当前步骤与执行历史/租约guard分开，单调lease_generation不能由重置计数替代。 |
| channel_identity | merge | conversation_binding | backend-ts/src/contacts/binding-service.ts:115；backend-ts/src/imports/history-import-service.ts:82 | 当前binding-service以locator查询channel_identity；合并前必须保留真正稳定external_id，不以昵称或未证locator猜同一。 |
| cli_backfill_state | merge | sync_checkpoint、conversation_clear_boundary、conversation_read_grant | backend-ts/src/sync/sync-incremental-recovery.ts:21 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。 |
| cli_history_sync_state | merge | sync_checkpoint、conversation_clear_boundary、conversation_read_grant | backend-ts/src/reply/generation/reply-scope.ts:23；backend-ts/src/sync/sync-incremental-store.ts:81 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。 |
| confirmed_memory | merge | memory、memory_version、memory_version_parent | backend-ts/src/memory/adoption/engine.ts:245；backend-ts/src/memory/overview/catalog.ts:98 | 本人/联系人共表但明确范围；版本和父边保留，手录独立根与manual采纳不同。 |
| contact | retain | contact | backend-ts/src/contacts/binding-service.ts:127；backend-ts/src/contacts/contact-context.ts:30 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。 |
| contact_memory_index | unmapped | 尚未明确 | backend-ts/src/memory/overview/catalog.ts:151；backend-ts/src/memory/records/mutations/erasure.ts:73 | 有独立目录topics/built_from_memory_revision消费者；overview_projection可能承接但需projection_kind及语义/字段审计，不能只因可重建删除。 |
| contact_memory_state | unmapped | 尚未明确 | backend-ts/src/memory/overview/catalog.ts:122；backend-ts/src/memory/overview/service.ts:29 | 当前reply与目录依赖单调memory_revision集合修订，前面模型尚无已明确落点。可并入稳定scope，但不能用head_revision/文档dirty_revision/max版本替代。 |
| conversation_binding | retain | conversation_binding | backend-ts/src/contacts/binding-service.ts:72；backend-ts/src/contacts/contact-context.ts:70 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。 |
| cross_domain_deletion_operation | merge | deletion_operation、deletion_row_target、deletion_file_target、deletion_verification | backend-ts/src/reply/runtime/assistant-runtime-erasure.ts:7；backend-ts/src/reply/runtime/assistant-runtime.ts:346 | Q42统一控制及复核、先fence后枚举/清理，地址快照不FK到即将删除的live对象。 |
| expression_preference | retain | expression_preference、expression_preference_version、preference_version_source | backend-ts/src/preferences/preference-service.ts:55；backend-ts/src/reply/discussion/reply-discussion-context.ts:142 | head与实际版本分层，manual范围可改变，message来源固定原联系人；来源任一相交擦除的现行合同不可擅改OR。 |
| expression_preference_operation | retain | expression_preference_operation | backend-ts/src/preferences/preference-service.ts:108 | 明确确认/更新/删除幂等；历史op不能回退当前，删除清摘要及依赖。 |
| expression_preference_state | merge | owner_collection_state | backend-ts/src/preferences/preference-service.ts:46；backend-ts/src/skills/skill-review-store.ts:185 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。 |
| front_sync_state | merge | account_sync_control | backend-ts/src/contacts/contact-context.ts:72；backend-ts/src/foreground/foreground-location-api.ts:27 | 同一旧bool被CLI读取和前台observe共同消费；转账号控制时必须迁移两个消费者，不新增另一份相互冲突开关。 |
| import_confirmation | drop_legacy | 尚未明确 | backend-ts/src/imports/history-import-service.ts:99；backend-ts/src/memory/processing/legacy-adoption.ts:52 | 用户已明确移除手动文件导入入口；不能只删表却留下确认/导入HTTP和代码路径。 |
| layered_memory_batch | merge | memory_trace、memory_trace_event、trace_document_input | backend-ts/src/host/host-model-accounting.ts:108；backend-ts/src/memory/extraction/tasks/store.ts:166 | 实际参与窗口及输入输出归完整trace，租约/调用归共享attempt/call，不能只迁展示引句。 |
| layered_memory_fact_correction | merge | organization_feedback、organization_feedback_input | backend-ts/src/memory/records/documents/facts.ts:20；backend-ts/src/memory/records/documents/source-policy.ts:11 | 摘要错误与精确事实版本保护属于有限反馈，不是偏好/新事实，保留实际窗口与撤销。 |
| layered_memory_feedback | merge | organization_feedback、organization_feedback_input | backend-ts/src/memory/profiles/service.ts:295；backend-ts/src/memory/records/documents/source-policy.ts:9 | 摘要错误与精确事实版本保护属于有限反馈，不是偏好/新事实，保留实际窗口与撤销。 |
| layered_memory_generation | merge | document_publication、document_publication_member | backend-ts/src/memory/profiles/service.ts:245；backend-ts/src/memory/records/documents/facts.ts:37 | 一致L2版本集合及可选L3必须保留，避免新主题配旧画像。 |
| layered_memory_job | merge | background_task、background_task_step、step_attempt、document_collection | backend-ts/src/host/host-model-accounting.ts:102；backend-ts/src/memory/extraction/tasks/store.ts:164 | 复用执行/租约，保留有限组织目标和来源资格，不新增另一套自动恢复。 |
| layered_memory_state | merge | document_collection | backend-ts/src/host/host-model-accounting.ts:102；backend-ts/src/memory/extraction/tasks/store.ts:221 | owner/contact组织控制、dirty/settings修订及current publication；自动maintenance不能照搬手动处理新规则。 |
| layered_profile_batch | merge | memory_trace、memory_trace_event、trace_document_input | backend-ts/src/host/host-model-accounting.ts:111；backend-ts/src/memory/processing/control.ts:172 | 实际参与窗口及输入输出归完整trace，租约/调用归共享attempt/call，不能只迁展示引句。 |
| layered_profile_version | merge | memory_document、memory_document_version、document_block、document_block_reference | backend-ts/src/memory/profiles/service.ts:441；backend-ts/src/memory/records/documents/facts.ts:46 | Q40共同head/version但保留L2/L3类型、不确定性、时态和依据。 |
| local_wechat_observation | merge | source_batch | backend-ts/src/contacts/contact-context.ts:17；backend-ts/src/host/pure-ts-follow-smoke.ts:18 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。 |
| manual_contact_confirmation | unmapped | 尚未明确 | backend-ts/src/contacts/contact-context.ts:51；backend-ts/src/host/pure-ts-reply-scope.ts:20 | 存在真实显式手动联系人确认读写；turn.scope_origin字段不是持久确认身份/代次的替代。需补正式实体或有证据的等价合同。 |
| media_attempt | drop_legacy | deletion_file_target | backend-ts/src/deletion/cross-domain-deletion.ts:330 | 本轮仅非文字占位，实际媒体能力不建；现有敏感缓存/旧副本仍须经切换文件目标清理，不能忽略删除消费者。 |
| media_request_tombstone | drop_legacy | deletion_file_target | backend-ts/src/deletion/cross-domain-deletion.ts:331 | 本轮仅非文字占位，实际媒体能力不建；现有敏感缓存/旧副本仍须经切换文件目标清理，不能忽略删除消费者。 |
| memory_candidate | retain | memory_candidate | backend-ts/src/memory/adoption/engine.ts:246；backend-ts/src/memory/overview/evidence/sources.ts:99 | 保留待裁决主张及subject/原会话，未采纳不冒充事实。 |
| memory_correction_decision | merge | memory_decision、memory_version_parent | backend-ts/src/memory/overview/evidence/sources.ts:103；backend-ts/src/memory/records/mutations/erasure.ts:41 | 人工拒绝/纠错/恢复为真实决定和版本关系；保护窗口引用与防复活规则仍需完整闭合。 |
| memory_extraction_receipt | merge | processing_run、processing_input、processing_receipt | backend-ts/src/memory/extraction/tasks/store-processing.ts:109；backend-ts/src/memory/extraction/tasks/store-schedule.ts:11 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。 |
| memory_extraction_schedule | merge | processing_run、processing_input、processing_receipt | backend-ts/src/memory/extraction/tasks/store-schedule.ts:19；backend-ts/src/memory/extraction/tasks/store.ts:468 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。 |
| memory_extraction_trace | merge | memory_trace | backend-ts/src/host/host-model-accounting.ts:49；backend-ts/src/memory/adoption/engine.ts:794 | 完整记忆提取trace保留实际过程与删除资格。 |
| memory_extraction_trace_call | merge | memory_trace_event、model_call | backend-ts/src/memory/adoption/host.ts:54；backend-ts/src/memory/extraction/service.ts:185 | 最小无正文调用关联保留真实物理call；来源删/整联系人删边界不同。 |
| memory_extraction_trace_dependency | merge | trace_message_input、trace_source_input、trace_memory_input | backend-ts/src/memory/adoption/engine.ts:815；backend-ts/src/memory/adoption/service.ts:409 | 完整实际窗口、消息及来源/旧记忆版本用真实类型FK，不能只迁最终引用。 |
| memory_extraction_trace_event | merge | memory_trace_event | backend-ts/src/host/host-model-accounting.ts:50；backend-ts/src/memory/adoption/engine.ts:797 | 实际输入输出与阶段结果是敏感载荷，不进普通日志。 |
| memory_extraction_trace_link | merge | memory_candidate、memory_version、memory_decision | backend-ts/src/memory/adoption/engine.ts:801；backend-ts/src/memory/adoption/service.ts:404 | 产生关系由candidate.trace_id、version.created_from_trace及真实决定引用承接；不重建record_kind+任意ID。 |
| memory_extraction_watermark | merge | processing_run、processing_input、processing_receipt | backend-ts/src/memory/adoption/service.ts:378；backend-ts/src/memory/extraction/tasks/runner.ts:104 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。 |
| memory_processing_legacy_adoption | drop_legacy | 尚未明确 | backend-ts/src/memory/processing/history.ts:31；backend-ts/src/memory/processing/legacy-adoption.ts:31 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。 |
| memory_processing_operation | unmapped | 尚未明确 | backend-ts/src/memory/processing/control.ts:155 | 旧pause/continue操作键有真实读写；新run.start_operation_id只覆盖start，需明确控制动作的幂等/旧操作拒绝如何保存，intent_revision单字段不能冒称全部API回放已覆盖。 |
| memory_processing_plan | drop_legacy | background_task、processing_round | backend-ts/src/memory/adoption/service.ts:393；backend-ts/src/memory/extraction/tasks/store-processing.ts:35 | Q38任务直接属于固定轮次，去掉旧N:M归属和plan壳；不是去掉目标/来源/成功事实。 |
| memory_processing_receipt | merge | processing_receipt | backend-ts/src/memory/adoption/service.ts:380；backend-ts/src/memory/extraction/tasks/store-processing.ts:55 | 跨轮逐消息结果，unknown_hold阻止重发但不能计成功。 |
| memory_processing_round | merge | processing_run、processing_round | backend-ts/src/memory/extraction/tasks/store-schedule.ts:65；backend-ts/src/memory/extraction/tasks/store.ts:240 | 一次启动与每范围固定分支分别表达，当前状态不等于单个task状态。 |
| memory_processing_round_target | merge | processing_input | backend-ts/src/memory/extraction/tasks/store-processing.ts:22；backend-ts/src/memory/processing/legacy-adoption.ts:193 | 固定本轮实际消息集合与target/context角色；Q38下不追加新消息。 |
| memory_processing_round_task | drop_legacy | background_task、processing_round | backend-ts/src/memory/extraction/tasks/store-processing.ts:15；backend-ts/src/memory/extraction/tasks/store.ts:241 | Q38任务直接属于固定轮次，去掉旧N:M归属和plan壳；不是去掉目标/来源/成功事实。 |
| memory_processing_scope | merge | processing_scope | backend-ts/src/memory/extraction/tasks/store-processing.ts:30；backend-ts/src/memory/extraction/tasks/store-schedule.ts:64 | 稳定范围和硬撤销代次保留；普通暂停派发意图与硬撤销分离。 |
| memory_processing_target | merge | processing_input | backend-ts/src/memory/adoption/service.ts:374；backend-ts/src/memory/extraction/tasks/store-processing.ts:51 | 固定本轮实际消息集合与target/context角色；Q38下不追加新消息。 |
| memory_upgrade_batch | drop_legacy | 尚未明确 | backend-ts/src/host/host-model-accounting.ts:91；backend-ts/src/memory/records/mutations/erasure.ts:45 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。 |
| memory_upgrade_job | drop_legacy | 尚未明确 | backend-ts/src/host/host-model-accounting.ts:91；backend-ts/src/memory/records/mutations/erasure.ts:53 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。 |
| memory_upgrade_operation | drop_legacy | 尚未明确 | backend-ts/database/migrations/067_memory_upgrade_batches.sql:93 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。 |
| message | retain | message | backend-ts/src/contacts/contact-context.ts:28；backend-ts/src/host/pure-ts-follow-smoke.ts:15 | 保留文字及非文字占位，原始出现/规范消息和真实来源分层。 |
| message_source_ref | merge | source_record | backend-ts/src/contacts/contact-context.ts:15；backend-ts/src/host/pure-ts-follow-smoke.ts:16 | 通过已核验record到message的真实范围关系表达多份捕获支持，不丢多来源OR语义。 |
| model_call_learning_claim | merge | step_model_call | backend-ts/src/host/host-model-accounting.ts:175 | 真实授权slot与step_attempt关联；旧propose_skill每租约一次约束不能泛化成每个提取步骤总共一次模型调用。 |
| model_call_receipt | merge | model_request、model_call | backend-ts/src/host/host-model-accounting.ts:96；backend-ts/src/memory/extraction/service.ts:148 | 逻辑请求与物理尝试分层，兼容出站投影需审计非模型消费者；unknown/费用不随任务清理退款。 |
| organization_quality_attempt | diagnostic_only | quality_case、quality_run、quality_attempt、quality_fact_intent | backend-ts/src/diagnostics/organization-quality-store.ts:151；backend-ts/src/diagnostics/quality-model-authorization.ts:50 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。 |
| organization_quality_case | diagnostic_only | quality_case、quality_run、quality_attempt、quality_fact_intent | backend-ts/src/diagnostics/organization-quality-store.ts:82；backend-ts/src/diagnostics/quality-model-authorization.ts:40 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。 |
| organization_quality_fact_intent | diagnostic_only | quality_case、quality_run、quality_attempt、quality_fact_intent | backend-ts/src/diagnostics/organization-quality-snapshot.ts:72；backend-ts/src/diagnostics/organization-quality-store.ts:87 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。 |
| organization_quality_revocation | unmapped | 尚未明确 | backend-ts/database/migrations/079_organization_quality.sql:111 | 只见迁移定义，src/test未找到消费者；候选不建但需最终覆盖审计，不宣称已使用或强保留。 |
| organization_quality_run | diagnostic_only | quality_case、quality_run、quality_attempt、quality_fact_intent | backend-ts/src/diagnostics/organization-quality-store.ts:111；backend-ts/src/diagnostics/quality-model-authorization.ts:40 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。 |
| outbound_ledger_entry | merge | model_request、model_call | backend-ts/src/platform/models/model-ledger.ts:132；backend-ts/src/diagnostics/source-processing-trace.ts:134 | 逻辑请求与物理尝试分层，兼容出站投影需审计非模型消费者；unknown/费用不随任务清理退款。 |
| owner | retain | owner | backend-ts/src/memory/extraction/tasks/store-processing.ts:99；backend-ts/src/memory/processing/control.ts:151 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。 |
| owner_channel_identity | merge | channel_account | backend-ts/src/contacts/binding-service.ts:56；backend-ts/src/contacts/contact-context.ts:71 | 本人渠道账号合并为已核验channel_account，仍需活动唯一及跨owner真实身份约束。 |
| owner_memory | merge | memory、memory_version、memory_version_parent | backend-ts/src/memory/adoption/engine.ts:246；backend-ts/src/memory/processing/query.ts:141 | 本人/联系人共表但明确范围；版本和父边保留，手录独立根与manual采纳不同。 |
| owner_memory_state | unmapped | 尚未明确 | backend-ts/src/reply/context/reply-context-overview.ts:26 | 当前reply与目录依赖单调memory_revision集合修订，前面模型尚无已明确落点。可并入稳定scope，但不能用head_revision/文档dirty_revision/max版本替代。 |
| relationship_overview_projection | merge | overview_projection、overview_projection_member | backend-ts/src/memory/overview/service.ts:69 | 无正文导航projection及built_at/revision有真实消费者，不与L2/L3正文混表。 |
| reply_attempt | merge | assistant_attempt | backend-ts/src/reply/discussion/assistant-discussion-service.ts:753；backend-ts/src/reply/discussion/assistant-generation-format.ts:36 | 短请求执行历史保留，不假扮background长任务。 |
| reply_candidate | retain | reply_candidate、reply_candidate_version、reply_candidate_segment、reply_candidate_version_message | backend-ts/src/preferences/preference-erasure.ts:27；backend-ts/src/reply/discussion/assistant-discussion-service.ts:227 | Q39 root只身份，全部正文从v1统一版本化，稳定段身份不等于外部message_id。 |
| reply_candidate_citation | merge | candidate_version_citation | backend-ts/src/reply/generation/reply-store.ts:152 | 实际候选版本依据定位；不替代完整context来源依赖。 |
| reply_context_evidence | merge | assistant_context_snapshot、assistant_context_item | backend-ts/src/host/pure-ts-reply-evidence.ts:44；backend-ts/src/preferences/preference-erasure.ts:22 | 实际构造上下文与具体message/memory candidate/version/source等typed引用，不能仅存kind+source_ids。 |
| reply_exploration | merge | assistant_turn | backend-ts/src/reply/discussion/assistant-generation-explored.ts:32；backend-ts/src/reply/discussion/assistant-generation-store.ts:204 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。 |
| reply_expression_preference_use | merge | assistant_context_item | backend-ts/src/preferences/preference-erasure.ts:25；backend-ts/src/preferences/preference-service.ts:168 | 实际使用具体preference_version真FK，不以当前值回填历史。 |
| reply_invalidated_key | unmapped | 尚未明确 | backend-ts/src/host/pure-ts-reply-evidence.ts:35；backend-ts/src/preferences/preference-erasure.ts:36 | 删除/中断后的旧reply键存在真实拒绝消费者；deletion_operation只封存删除请求键，不能自动覆盖所有子回复键。需独立最小封存关系或被保留turn tombstone的明确定义。 |
| reply_original_source_use | merge | assistant_context_snapshot、assistant_context_item | backend-ts/src/preferences/preference-erasure.ts:23；backend-ts/src/reply/generation/reply-assistant-erasure.ts:141 | 实际构造上下文与具体message/memory candidate/version/source等typed引用，不能仅存kind+source_ids。 |
| reply_request | merge | assistant_turn | backend-ts/src/host/pure-ts-reply-evidence.ts:33；backend-ts/src/memory/records/mutations/erasure.ts:70 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。 |
| reply_skill | retain | reply_skill | backend-ts/src/reply/exploration/reply-exploration-guards.ts:67；backend-ts/src/reply/generation/reply-assistant-erasure-sql.ts:19 | 保留原目录及官方DSH加载，只必要业务身份/状态，不能把缺DB引用当删除授权。 |
| reply_skill_file_cleanup | merge | deletion_file_target | backend-ts/src/preferences/preference-files.ts:64；backend-ts/src/reply/discussion/assistant-discussion-service.ts:1043 | 目标独立于live业务行，FK删除操作，预期目录/manifest身份先持久化，同操作可安全重试。 |
| reply_skill_method | merge | reply_method、skill_version_method、skill_method_parent | backend-ts/src/skills/skill-execution-view.ts:19；backend-ts/src/skills/skill-history-policy-store.ts:49 | 方法身份、版本成员与祖先延续真实FK，停用不能被改名/合并洗掉。 |
| reply_skill_publication | merge | reply_skill_version、skill_catalog_operation | backend-ts/src/skills/skill-cleanup.ts:31；backend-ts/src/skills/skill-history-policy-store.ts:40 | 固定批准来历可并入version，真实review/draft/source关系不能丢；普通包与reviewed不可洗来源。 |
| reply_skill_version | retain | reply_skill_version | backend-ts/src/preferences/preference-files.ts:67；backend-ts/src/reply/exploration/exploration-service.ts:36 | 正文/描述/资源清单以不可变文件为权威，DB完整性锚点及审核/来源/范围。 |
| reply_skill_working_copy | merge | skill_worktree_projection | backend-ts/src/preferences/preference-files.ts:64；backend-ts/src/skills/skill-cleanup.ts:10 | 工作目录投影可恢复但非第二份正文权威，不能覆盖用户并发修改。 |
| scenario_document_mapping | merge | document_version_parent | backend-ts/src/memory/scenarios/service.ts:669 | 延续/合并/拆分两端都真实FK，旧source端缺FK不照搬。 |
| scenario_document_version | merge | memory_document、memory_document_version、document_block、document_block_reference | backend-ts/src/memory/profiles/service.ts:253；backend-ts/src/memory/records/documents/facts.ts:42 | Q40共同head/version但保留L2/L3类型、不确定性、时态和依据。 |
| skill_draft | retain | skill_draft、skill_draft_version、skill_draft_target | backend-ts/src/skills/skill-cleanup.ts:36；backend-ts/src/skills/skill-learning-materials.ts:173 | proposed根、不可变草稿修订、私密依据及实际target version分层，不冒充已发布策略。 |
| skill_history_operation | merge | skill_catalog_operation | backend-ts/src/skills/skill-history-policy-store.ts:95 | 更新/合并/回滚和批准幂等，当前版本与目录修订双重预期，回滚保留停用。 |
| skill_learning_batch | retain | skill_learning_batch、skill_learning_receipt、skill_learning_input | backend-ts/src/skills/skill-cleanup.ts:50；backend-ts/src/skills/skill-learning-store.ts:91 | 有限真实材料及消费事实，no_change/reuse也可成功；具体引用不藏无FK数组。 |
| skill_learning_operation | retain | skill_learning_operation | backend-ts/src/skills/skill-learning-store.ts:137 | 独立学习用途授权默认关闭，旧操作不得覆盖后来关闭；不能由同步/记忆按钮授予。 |
| skill_learning_receipt | retain | skill_learning_batch、skill_learning_receipt、skill_learning_input | backend-ts/src/skills/skill-cleanup.ts:45；backend-ts/src/skills/skill-learning-materials.ts:69 | 有限真实材料及消费事实，no_change/reuse也可成功；具体引用不藏无FK数组。 |
| skill_learning_scope | retain | skill_learning_scope | backend-ts/src/host/host-model-accounting.ts:83；backend-ts/src/memory/extraction/tasks/store.ts:39 | 独立学习用途授权默认关闭，旧操作不得覆盖后来关闭；不能由同步/记忆按钮授予。 |
| skill_library | merge | owner_collection_state | backend-ts/src/reply/discussion/assistant-generation-format.ts:26；backend-ts/src/reply/exploration/exploration-store.ts:37 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。 |
| skill_method_identity | merge | reply_method、skill_version_method、skill_method_parent | backend-ts/src/skills/skill-learning-store.ts:203；backend-ts/src/skills/skill-review-store.ts:253 | 方法身份、版本成员与祖先延续真实FK，停用不能被改名/合并洗掉。 |
| skill_policy_operation | retain | skill_policy_operation | backend-ts/src/skills/skill-history-policy-store.ts:169 | 明确范围政策动作幂等，不留反馈原话。 |
| skill_policy_state | merge | owner_collection_state | backend-ts/src/skills/skill-history-policy-store.ts:131 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。 |
| skill_review_call | merge | skill_review_result_call、step_model_call、model_call | backend-ts/src/skills/skill-review-store.ts:355 | 审核结果固定真实attempt与实际消费call链，不从后来current attempt猜测。 |
| skill_review_comparison | merge | skill_review、skill_review_input、skill_review_target、skill_review_side | backend-ts/src/skills/skill-cleanup.ts:25；backend-ts/src/skills/skill-learning-store.ts:86 | 独立审核输入不必来自助手session，冻结同输入两侧策略/结果，不伪造assistant turn。 |
| skill_review_operation | merge | skill_catalog_operation | backend-ts/src/skills/skill-cleanup.ts:26；backend-ts/src/skills/skill-learning-store.ts:89 | 更新/合并/回滚和批准幂等，当前版本与目录修订双重预期，回滚保留停用。 |
| skill_scope_policy | retain | skill_scope_policy | backend-ts/src/skills/skill-execution-view.ts:29；backend-ts/src/skills/skill-history-policy-store.ts:132 | 用户范围停用与不可变正文独立，目标方法要真实FK及祖先归属。 |
| source_document | merge | source_batch | backend-ts/src/contacts/contact-context.ts:16；backend-ts/src/host/host-model-accounting.ts:44 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。 |
| source_processing_batch | merge | source_batch | backend-ts/src/imports/history-import-service.ts:177；backend-ts/src/memory/extraction/sources.ts:36 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。 |
| source_processing_capture_tombstone | merge | ingestion_tombstone | backend-ts/src/sync/sync-incremental-store-write.ts:36；backend-ts/src/diagnostics/source-processing-trace.ts:421 | 捕获UUID和可靠消息身份是不同tombstone种类，均不能代替未读历史边界。 |
| source_processing_record | merge | source_record、message | backend-ts/src/imports/history-import-service.ts:194；backend-ts/src/memory/extraction/sources.ts:36 | 原始出现归source_record，规范消息保存已证identity/order；raw协议字段不得丢失，不能宣称旧local_id+time已可靠。 |
| wechat_auto_read_suppression | merge | ingestion_tombstone | backend-ts/src/sync/sync-auto-read-suppression.ts:37；backend-ts/src/deletion/cross-domain-deletion.ts:628 | 捕获UUID和可靠消息身份是不同tombstone种类，均不能代替未读历史边界。 |
| wechat_binding_history_authorization | merge | conversation_read_grant、history_restore_authorization | backend-ts/src/reply/generation/reply-scope.ts:24；backend-ts/src/sync/sync-incremental-store.ts:80 | 授权协议版本、grant生命周期代次及显式恢复资格分开；旧账号/绑定历史授权需逐入口改造。 |
| wechat_history_sync_authorization | merge | conversation_read_grant、history_restore_authorization | backend-ts/src/contacts/contact-context.ts:74；backend-ts/src/reply/generation/reply-scope.ts:25 | 授权协议版本、grant生命周期代次及显式恢复资格分开；旧账号/绑定历史授权需逐入口改造。 |
| wechat_message_metadata | merge | source_record、message | backend-ts/src/contacts/contact-context.ts:106；backend-ts/src/host/pure-ts-follow-smoke.ts:19 | 原始出现归source_record，规范消息保存已证identity/order；raw协议字段不得丢失，不能宣称旧local_id+time已可靠。 |
| wechat_observation_baseline | merge | sync_checkpoint、conversation_clear_boundary、conversation_read_grant | backend-ts/src/contacts/binding-service.ts:136；backend-ts/src/sync/sync-incremental-store.ts:189 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。 |
| wechat_observation_cursor | merge | sync_checkpoint、conversation_clear_boundary、conversation_read_grant | backend-ts/src/host/pure-ts-follow-smoke.ts:17；backend-ts/src/sync/sync-incremental-store.ts:185 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。 |
| wechat_sync_exclusion | merge | conversation_exclusion | backend-ts/src/contacts/contact-context.ts:75；backend-ts/src/sync/sync-scope-history.ts:4 | 联系人删除后仍保留必要渠道排除，不能外键级联随contact消失。 |
| wechat_sync_scope | unmapped | 尚未明确 | backend-ts/src/contacts/contact-context.ts:73；backend-ts/src/sync/sync-scope.ts:44 | 旧表保存selected/all_private及明确授权时间；新account开关bool不覆盖范围模式。须明确selected-only后如何禁用旧入口或补范围字段，不能猜已覆盖。 |

## 方法与限制

- 不是实际数据库元数据；DO块动态DDL、动态表名、触发器内部引用及字符串拼接不能由简单字面扫描完整证明。
- 消费者数量是导航线索，不等同于业务已启用或测试已通过；deletion/schema检查引用不单独证明正常写入。
- 映射到02–08逻辑提案，父Agent后续物理合并/表名收敛必须再映射一次。
- 未读取用户配置、聊天、Skill、凭据或业务库；未运行App/模型/SQL/安装/远端操作。

未强制加入Git；两个报告文件位于被忽略的本地设计目录。
