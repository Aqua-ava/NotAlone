# 历史覆盖矩阵（未批准）

本表映射至上一轮94表候选，仅供旧PG查漏，不能作为新库保留需求或实现任务。当前见[按需求逐表审查](requirements-table-rationale.md)。

静态CREATE/DROP重放，不是实际用户库元数据。115项均给出计划；本轮没有完成115项实现或运行验收。原8个缺口已补实体／字段／投影／候选退役方案。

4张质量表保留真实消费者；只有createRun有既有_test门禁，不能宣称case均已隔离。移除旧文件导入／媒体／升级入口须同步退役API和恢复耦合。

| 旧表 | 物理候选 | 计划状态 | 依据／范围 |
| --- | --- | --- | --- |
| `assistant_candidate_selection` | `assistant_selection` | 已给映射，待实现验证 | 显式选择指具体版本，复制/编辑不自动选择或证明发送。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L298) |
| `assistant_candidate_version` | `reply_candidate_version` | 已给映射，待实现验证 | 统一原稿和用户编辑版本，完整父版范围FK和幂等edit key。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L271) |
| `assistant_runtime_deletion_target` | `deletion_target` | 已给映射，待实现验证 | 目标独立于live业务行，FK删除操作，预期目录/manifest身份先持久化，同操作可安全重试。；[代码](../../backend-ts/src/reply/runtime/assistant-runtime-erasure.ts#L11) |
| `assistant_runtime_session` | `assistant_runtime_instance`、`assistant_runtime_context` | 已给映射，待实现验证 | 业务记录权威与JSONL运行副本分层，current映射、完整资格、配置和真实event seal保留；重建不伪造turn。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L411) |
| `assistant_session` | `assistant_session` | 已给映射，待实现验证 | 当前会话、输入、选择、runtime指针均同session；浏览历史不切current。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L205) |
| `assistant_session_input` | `assistant_turn` | 已给映射，待实现验证 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L455) |
| `assistant_session_turn` | `assistant_turn` | 已给映射，待实现验证 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。；[代码](../../backend-ts/src/preferences/preference-erasure.ts#L21) |
| `background_task` | `background_task` | 已给映射，待实现验证 | 有限工作任务复用，记忆task归属及固定输入合同明确。删除控制账本独立于被删owner生命周期。；[代码](../../backend-ts/src/contacts/contact-context.ts#L41) |
| `background_task_step` | `background_task_step`、`step_attempt`、`step_attempt_guard` | 已给映射，待实现验证 | 当前步骤与执行历史/租约guard分开，单调lease_generation不能由重置计数替代。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L34) |
| `channel_identity` | `conversation_binding` | 已给映射，待实现验证 | 当前binding-service以locator查询channel_identity；合并前必须保留真正稳定external_id，不以昵称或未证locator猜同一。；[代码](../../backend-ts/src/contacts/binding-service.ts#L115) |
| `cli_backfill_state` | `sync_checkpoint`、`conversation_clear_boundary`、`conversation_read_grant` | 已给映射，待实现验证 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。；[代码](../../backend-ts/src/sync/sync-incremental-recovery.ts#L21) |
| `cli_history_sync_state` | `sync_checkpoint`、`conversation_clear_boundary`、`conversation_read_grant` | 已给映射，待实现验证 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。；[代码](../../backend-ts/src/reply/generation/reply-scope.ts#L23) |
| `confirmed_memory` | `memory`、`memory_version`、`memory_version_parent` | 已给映射，待实现验证 | 本人/联系人共表但明确范围；版本和父边保留，手录独立根与manual采纳不同。；[代码](../../backend-ts/src/memory/adoption/engine.ts#L245) |
| `contact` | `contact` | 已给映射，待实现验证 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。；[代码](../../backend-ts/src/contacts/binding-service.ts#L127) |
| `contact_memory_index` | `scope_projection` | 有类型投影 | projection_kind=contact_index，独立字段合同；不冒称等同long_term_overview。；[代码](../../backend-ts/src/memory/overview/catalog.ts#L151) |
| `contact_memory_state` | `processing_scope` | 补集合字段 | 稳定范围增加memory_revision；不是head_revision或document dirty_revision。；[代码](../../backend-ts/src/memory/overview/catalog.ts#L122) |
| `conversation_binding` | `conversation_binding` | 已给映射，待实现验证 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。；[代码](../../backend-ts/src/contacts/binding-service.ts#L72) |
| `cross_domain_deletion_operation` | `deletion_operation`、`deletion_target`、`deletion_verification` | 已给映射，待实现验证 | Q42统一控制及复核、先fence后枚举/清理，地址快照不FK到即将删除的live对象。；[代码](../../backend-ts/src/reply/runtime/assistant-runtime-erasure.ts#L7) |
| `expression_preference` | `expression_preference`、`expression_preference_version`、`material_reference` | 已给映射，待实现验证 | head与实际版本分层，manual范围可改变，message来源固定原联系人；来源任一相交擦除的现行合同不可擅改OR。；[代码](../../backend-ts/src/preferences/preference-service.ts#L55) |
| `expression_preference_operation` | `expression_preference_operation` | 已给映射，待实现验证 | 明确确认/更新/删除幂等；历史op不能回退当前，删除清摘要及依赖。；[代码](../../backend-ts/src/preferences/preference-service.ts#L108) |
| `expression_preference_state` | `owner_collection_state` | 已给映射，待实现验证 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。；[代码](../../backend-ts/src/preferences/preference-service.ts#L46) |
| `front_sync_state` | `account_sync_control` | 已给映射，待实现验证 | 同一旧bool被CLI读取和前台observe共同消费；转账号控制时必须迁移两个消费者，不新增另一份相互冲突开关。；[代码](../../backend-ts/src/contacts/contact-context.ts#L72) |
| `import_confirmation` | 不建 | 按确认范围退役 | 用户已明确移除手动文件导入入口；不能只删表却留下确认/导入HTTP和代码路径。；[代码](../../backend-ts/src/imports/history-import-service.ts#L99) |
| `layered_memory_batch` | `memory_trace`、`memory_trace_event`、`material_reference` | 已给映射，待实现验证 | 实际参与窗口及输入输出归完整trace，租约/调用归共享attempt/call，不能只迁展示引句。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L108) |
| `layered_memory_fact_correction` | `organization_feedback`、`material_reference` | 已给映射，待实现验证 | 摘要错误与精确事实版本保护属于有限反馈，不是偏好/新事实，保留实际窗口与撤销。；[代码](../../backend-ts/src/memory/records/documents/facts.ts#L20) |
| `layered_memory_feedback` | `organization_feedback`、`material_reference` | 已给映射，待实现验证 | 摘要错误与精确事实版本保护属于有限反馈，不是偏好/新事实，保留实际窗口与撤销。；[代码](../../backend-ts/src/memory/profiles/service.ts#L295) |
| `layered_memory_generation` | `document_publication`、`document_publication_member` | 已给映射，待实现验证 | 一致L2版本集合及可选L3必须保留，避免新主题配旧画像。；[代码](../../backend-ts/src/memory/profiles/service.ts#L245) |
| `layered_memory_job` | `background_task`、`background_task_step`、`step_attempt`、`document_collection` | 已给映射，待实现验证 | 复用执行/租约，保留有限组织目标和来源资格，不新增另一套自动恢复。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L102) |
| `layered_memory_state` | `document_collection` | 已给映射，待实现验证 | owner/contact组织控制、dirty/settings修订及current publication；自动maintenance不能照搬手动处理新规则。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L102) |
| `layered_profile_batch` | `memory_trace`、`memory_trace_event`、`material_reference` | 已给映射，待实现验证 | 实际参与窗口及输入输出归完整trace，租约/调用归共享attempt/call，不能只迁展示引句。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L111) |
| `layered_profile_version` | `memory_document`、`memory_document_version`、`document_block`、`document_block_reference` | 已给映射，待实现验证 | Q40共同head/version但保留L2/L3类型、不确定性、时态和依据。；[代码](../../backend-ts/src/memory/profiles/service.ts#L441) |
| `local_wechat_observation` | `source_batch` | 已给映射，待实现验证 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。；[代码](../../backend-ts/src/contacts/contact-context.ts#L17) |
| `manual_contact_confirmation` | `manual_contact_confirmation` | 补真实实体 | assistant_turn用真实manual_confirmation_id与binding_id排他，保留本次客户端确认代次。；[代码](../../backend-ts/src/contacts/contact-context.ts#L51) |
| `media_attempt` | `deletion_target` | 按确认范围退役 | 本轮仅非文字占位，实际媒体能力不建；现有敏感缓存/旧副本仍须经切换文件目标清理，不能忽略删除消费者。；[代码](../../backend-ts/src/deletion/cross-domain-deletion.ts#L330) |
| `media_request_tombstone` | `deletion_target` | 按确认范围退役 | 本轮仅非文字占位，实际媒体能力不建；现有敏感缓存/旧副本仍须经切换文件目标清理，不能忽略删除消费者。；[代码](../../backend-ts/src/deletion/cross-domain-deletion.ts#L331) |
| `memory_candidate` | `memory_candidate` | 已给映射，待实现验证 | 保留待裁决主张及subject/原会话，未采纳不冒充事实。；[代码](../../backend-ts/src/memory/adoption/engine.ts#L246) |
| `memory_correction_decision` | `memory_decision`、`memory_version_parent` | 已给映射，待实现验证 | 人工拒绝/纠错/恢复为真实决定和版本关系；保护窗口引用与防复活规则仍需完整闭合。；[代码](../../backend-ts/src/memory/overview/evidence/sources.ts#L103) |
| `memory_extraction_receipt` | `processing_run`、`processing_input`、`processing_receipt` | 已给映射，待实现验证 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。；[代码](../../backend-ts/src/memory/extraction/tasks/store-processing.ts#L109) |
| `memory_extraction_schedule` | `processing_run`、`processing_input`、`processing_receipt` | 已给映射，待实现验证 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。；[代码](../../backend-ts/src/memory/extraction/tasks/store-schedule.ts#L19) |
| `memory_extraction_trace` | `memory_trace` | 已给映射，待实现验证 | 完整记忆提取trace保留实际过程与删除资格。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L49) |
| `memory_extraction_trace_call` | `memory_trace_event`、`model_call` | 已给映射，待实现验证 | 最小无正文调用关联保留真实物理call；来源删/整联系人删边界不同。；[代码](../../backend-ts/src/memory/adoption/host.ts#L54) |
| `memory_extraction_trace_dependency` | `material_reference` | 已给映射，待实现验证 | 完整实际窗口、消息及来源/旧记忆版本用真实类型FK，不能只迁最终引用。；[代码](../../backend-ts/src/memory/adoption/engine.ts#L815) |
| `memory_extraction_trace_event` | `memory_trace_event` | 已给映射，待实现验证 | 实际输入输出与阶段结果是敏感载荷，不进普通日志。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L50) |
| `memory_extraction_trace_link` | `memory_candidate`、`memory_version`、`memory_decision` | 已给映射，待实现验证 | 产生关系由candidate.trace_id、version.created_from_trace及真实决定引用承接；不重建record_kind+任意ID。；[代码](../../backend-ts/src/memory/adoption/engine.ts#L801) |
| `memory_extraction_watermark` | `processing_run`、`processing_input`、`processing_receipt` | 已给映射，待实现验证 | 自动调度退役为用户手动固定目标；逐消息成功/unknown/无新记忆结果与读取cursor分开，不能仅靠水位推全成功。；[代码](../../backend-ts/src/memory/adoption/service.ts#L378) |
| `memory_processing_legacy_adoption` | 不建 | 按确认范围退役 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。；[代码](../../backend-ts/src/memory/processing/history.ts#L31) |
| `memory_processing_operation` | `processing_operation` | 补控制回执 | 明确start/pause/resume幂等键与旧动作拒绝，不能只有run启动键。；[代码](../../backend-ts/src/memory/processing/control.ts#L155) |
| `memory_processing_plan` | `background_task`、`processing_round` | 按确认范围退役 | Q38任务直接属于固定轮次，去掉旧N:M归属和plan壳；不是去掉目标/来源/成功事实。；[代码](../../backend-ts/src/memory/adoption/service.ts#L393) |
| `memory_processing_receipt` | `processing_receipt` | 已给映射，待实现验证 | 跨轮逐消息结果，unknown_hold阻止重发但不能计成功。；[代码](../../backend-ts/src/memory/adoption/service.ts#L380) |
| `memory_processing_round` | `processing_run`、`processing_round` | 已给映射，待实现验证 | 一次启动与每范围固定分支分别表达，当前状态不等于单个task状态。；[代码](../../backend-ts/src/memory/extraction/tasks/store-schedule.ts#L65) |
| `memory_processing_round_target` | `processing_input` | 已给映射，待实现验证 | 固定本轮实际消息集合与target/context角色；Q38下不追加新消息。；[代码](../../backend-ts/src/memory/extraction/tasks/store-processing.ts#L22) |
| `memory_processing_round_task` | `background_task`、`processing_round` | 按确认范围退役 | Q38任务直接属于固定轮次，去掉旧N:M归属和plan壳；不是去掉目标/来源/成功事实。；[代码](../../backend-ts/src/memory/extraction/tasks/store-processing.ts#L15) |
| `memory_processing_scope` | `processing_scope` | 已给映射，待实现验证 | 稳定范围和硬撤销代次保留；普通暂停派发意图与硬撤销分离。；[代码](../../backend-ts/src/memory/extraction/tasks/store-processing.ts#L30) |
| `memory_processing_target` | `processing_input` | 已给映射，待实现验证 | 固定本轮实际消息集合与target/context角色；Q38下不追加新消息。；[代码](../../backend-ts/src/memory/adoption/service.ts#L374) |
| `memory_upgrade_batch` | 不建 | 按确认范围退役 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L91) |
| `memory_upgrade_job` | 不建 | 按确认范围退役 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L91) |
| `memory_upgrade_operation` | 不建 | 按确认范围退役 | 空库不迁旧业务，不建旧任务接入/资料升级流程；须移除旧恢复/计费/删除耦合而非让死表反向成为新库前提。 |
| `message` | `message` | 已给映射，待实现验证 | 保留文字及非文字占位，原始出现/规范消息和真实来源分层。；[代码](../../backend-ts/src/contacts/contact-context.ts#L28) |
| `message_source_ref` | `source_record` | 已给映射，待实现验证 | 通过已核验record到message的真实范围关系表达多份捕获支持，不丢多来源OR语义。；[代码](../../backend-ts/src/contacts/contact-context.ts#L15) |
| `model_call_learning_claim` | `model_call_execution` | 已给映射，待实现验证 | 真实授权slot与step_attempt关联；旧propose_skill每租约一次约束不能泛化成每个提取步骤总共一次模型调用。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L175) |
| `model_call_receipt` | `model_request`、`model_call` | 已给映射，待实现验证 | 逻辑请求与物理尝试分层，兼容出站投影需审计非模型消费者；unknown/费用不随任务清理退款。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L96) |
| `organization_quality_attempt` | `quality_case`、`quality_run`、`quality_attempt`、`quality_fact_intent` | 保留诊断能力，非默认测试库隔离事实 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。；[代码](../../backend-ts/src/diagnostics/organization-quality-store.ts#L151) |
| `organization_quality_case` | `quality_case`、`quality_run`、`quality_attempt`、`quality_fact_intent` | 保留诊断能力，非默认测试库隔离事实 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。；[代码](../../backend-ts/src/diagnostics/organization-quality-store.ts#L82) |
| `organization_quality_fact_intent` | `quality_case`、`quality_run`、`quality_attempt`、`quality_fact_intent` | 保留诊断能力，非默认测试库隔离事实 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。；[代码](../../backend-ts/src/diagnostics/organization-quality-snapshot.ts#L72) |
| `organization_quality_revocation` | 不建 | 候选不建 | 只见迁移定义、无src/test业务消费者；初始化结构检查随新schema改造，不能宣称已做运行验收。 |
| `organization_quality_run` | `quality_case`、`quality_run`、`quality_attempt`、`quality_fact_intent` | 保留诊断能力，非默认测试库隔离事实 | 保留诊断能力；createRun有_test/fixed_synthetic门禁，但case冻结/读取/人工标注没有同一测试库门禁。独立诊断库是待改造决策，不能据此移除当前业务消费者。；[代码](../../backend-ts/src/diagnostics/organization-quality-store.ts#L111) |
| `outbound_ledger_entry` | `model_request`、`model_call` | 已给映射，待实现验证 | 逻辑请求与物理尝试分层，兼容出站投影需审计非模型消费者；unknown/费用不随任务清理退款。；[代码](../../backend-ts/src/platform/models/model-ledger.ts#L132) |
| `owner` | `owner` | 已给映射，待实现验证 | 保留用户、联系人及验证绑定身份；具体行按同名目标映射，字段并非逐列照搬。；[代码](../../backend-ts/src/memory/extraction/tasks/store-processing.ts#L99) |
| `owner_channel_identity` | `channel_account` | 已给映射，待实现验证 | 本人渠道账号合并为已核验channel_account，仍需活动唯一及跨owner真实身份约束。；[代码](../../backend-ts/src/contacts/binding-service.ts#L56) |
| `owner_memory` | `memory`、`memory_version`、`memory_version_parent` | 已给映射，待实现验证 | 本人/联系人共表但明确范围；版本和父边保留，手录独立根与manual采纳不同。；[代码](../../backend-ts/src/memory/adoption/engine.ts#L246) |
| `owner_memory_state` | `processing_scope` | 补集合字段 | 本人范围同样维护memory_revision，空集合也初始化。；[代码](../../backend-ts/src/reply/context/reply-context-overview.ts#L26) |
| `relationship_overview_projection` | `scope_projection`、`material_reference` | 已给映射，待实现验证 | 无正文导航projection及built_at/revision有真实消费者，不与L2/L3正文混表。；[代码](../../backend-ts/src/memory/overview/service.ts#L69) |
| `reply_attempt` | `assistant_attempt` | 已给映射，待实现验证 | 短请求执行历史保留，不假扮background长任务。；[代码](../../backend-ts/src/reply/discussion/assistant-discussion-service.ts#L753) |
| `reply_candidate` | `reply_candidate`、`reply_candidate_version`、`reply_candidate_segment`、`reply_candidate_version_message` | 已给映射，待实现验证 | Q39 root只身份，全部正文从v1统一版本化，稳定段身份不等于外部message_id。；[代码](../../backend-ts/src/preferences/preference-erasure.ts#L27) |
| `reply_candidate_citation` | `candidate_version_citation` | 已给映射，待实现验证 | 实际候选版本依据定位；不替代完整context来源依赖。；[代码](../../backend-ts/src/reply/generation/reply-store.ts#L152) |
| `reply_context_evidence` | `material_set`、`material_reference` | 已给映射，待实现验证 | 实际构造上下文与具体message/memory candidate/version/source等typed引用，不能仅存kind+source_ids。；[代码](../../backend-ts/src/host/pure-ts-reply-evidence.ts#L44) |
| `reply_exploration` | `assistant_turn` | 已给映射，待实现验证 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。；[代码](../../backend-ts/src/reply/discussion/assistant-generation-explored.ts#L32) |
| `reply_expression_preference_use` | `material_reference` | 已给映射，待实现验证 | 实际使用具体preference_version真FK，不以当前值回填历史。；[代码](../../backend-ts/src/preferences/preference-erasure.ts#L25) |
| `reply_invalidated_key` | `assistant_request_tombstone` | 补子请求封存 | 与删除操作键不同；删除／中断后旧回复不能重建。；[代码](../../backend-ts/src/host/pure-ts-reply-evidence.ts#L35) |
| `reply_original_source_use` | `material_set`、`material_reference` | 已给映射，待实现验证 | 实际构造上下文与具体message/memory candidate/version/source等typed引用，不能仅存kind+source_ids。；[代码](../../backend-ts/src/preferences/preference-erasure.ts#L23) |
| `reply_request` | `assistant_turn` | 已给映射，待实现验证 | 合并已提交输入与逻辑请求，kind区分generation/exploration/carry；input只存一次，实际attempt另存。；[代码](../../backend-ts/src/host/pure-ts-reply-evidence.ts#L33) |
| `reply_skill` | `reply_skill` | 已给映射，待实现验证 | 保留原目录及官方DSH加载，只必要业务身份/状态，不能把缺DB引用当删除授权。；[代码](../../backend-ts/src/reply/exploration/reply-exploration-guards.ts#L67) |
| `reply_skill_file_cleanup` | `deletion_target` | 已给映射，待实现验证 | 目标独立于live业务行，FK删除操作，预期目录/manifest身份先持久化，同操作可安全重试。；[代码](../../backend-ts/src/preferences/preference-files.ts#L64) |
| `reply_skill_method` | `reply_method`、`skill_version_method`、`skill_method_parent` | 已给映射，待实现验证 | 方法身份、版本成员与祖先延续真实FK，停用不能被改名/合并洗掉。；[代码](../../backend-ts/src/skills/skill-execution-view.ts#L19) |
| `reply_skill_publication` | `reply_skill_version`、`skill_operation` | 已给映射，待实现验证 | 固定批准来历可并入version，真实review/draft/source关系不能丢；普通包与reviewed不可洗来源。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L31) |
| `reply_skill_version` | `reply_skill_version` | 已给映射，待实现验证 | 正文/描述/资源清单以不可变文件为权威，DB完整性锚点及审核/来源/范围。；[代码](../../backend-ts/src/preferences/preference-files.ts#L67) |
| `reply_skill_working_copy` | `skill_worktree_projection` | 已给映射，待实现验证 | 工作目录投影可恢复但非第二份正文权威，不能覆盖用户并发修改。；[代码](../../backend-ts/src/preferences/preference-files.ts#L64) |
| `scenario_document_mapping` | `document_version_parent` | 已给映射，待实现验证 | 延续/合并/拆分两端都真实FK，旧source端缺FK不照搬。；[代码](../../backend-ts/src/memory/scenarios/service.ts#L669) |
| `scenario_document_version` | `memory_document`、`memory_document_version`、`document_block`、`document_block_reference` | 已给映射，待实现验证 | Q40共同head/version但保留L2/L3类型、不确定性、时态和依据。；[代码](../../backend-ts/src/memory/profiles/service.ts#L253) |
| `skill_draft` | `skill_draft`、`skill_draft_version`、`skill_draft_target` | 已给映射，待实现验证 | proposed根、不可变草稿修订、私密依据及实际target version分层，不冒充已发布策略。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L36) |
| `skill_history_operation` | `skill_operation` | 已给映射，待实现验证 | 更新/合并/回滚和批准幂等，当前版本与目录修订双重预期，回滚保留停用。；[代码](../../backend-ts/src/skills/skill-history-policy-store.ts#L95) |
| `skill_learning_batch` | `skill_learning_batch`、`skill_learning_receipt`、`material_reference` | 已给映射，待实现验证 | 有限真实材料及消费事实，no_change/reuse也可成功；具体引用不藏无FK数组。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L50) |
| `skill_learning_operation` | `skill_operation` | 已给映射，待实现验证 | 独立学习用途授权默认关闭，旧操作不得覆盖后来关闭；不能由同步/记忆按钮授予。；[代码](../../backend-ts/src/skills/skill-learning-store.ts#L137) |
| `skill_learning_receipt` | `skill_learning_batch`、`skill_learning_receipt`、`material_reference` | 已给映射，待实现验证 | 有限真实材料及消费事实，no_change/reuse也可成功；具体引用不藏无FK数组。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L45) |
| `skill_learning_scope` | `skill_learning_scope` | 已给映射，待实现验证 | 独立学习用途授权默认关闭，旧操作不得覆盖后来关闭；不能由同步/记忆按钮授予。；[代码](../../backend-ts/src/host/host-model-accounting.ts#L83) |
| `skill_library` | `owner_collection_state` | 已给映射，待实现验证 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。；[代码](../../backend-ts/src/reply/discussion/assistant-generation-format.ts#L26) |
| `skill_method_identity` | `reply_method`、`skill_version_method`、`skill_method_parent` | 已给映射，待实现验证 | 方法身份、版本成员与祖先延续真实FK，停用不能被改名/合并洗掉。；[代码](../../backend-ts/src/skills/skill-learning-store.ts#L203) |
| `skill_policy_operation` | `skill_operation` | 已给映射，待实现验证 | 明确范围政策动作幂等，不留反馈原话。；[代码](../../backend-ts/src/skills/skill-history-policy-store.ts#L169) |
| `skill_policy_state` | `owner_collection_state` | 已给映射，待实现验证 | 三种owner集合计数器可同一行存储但分别单调，空集合也必须捕获。；[代码](../../backend-ts/src/skills/skill-history-policy-store.ts#L131) |
| `skill_review_call` | `skill_review_result_call`、`model_call_execution`、`model_call` | 已给映射，待实现验证 | 审核结果固定真实attempt与实际消费call链，不从后来current attempt猜测。；[代码](../../backend-ts/src/skills/skill-review-store.ts#L355) |
| `skill_review_comparison` | `skill_review`、`material_reference`、`skill_draft_target`、`skill_review_side` | 已给映射，待实现验证 | 独立审核输入不必来自助手session，冻结同输入两侧策略/结果，不伪造assistant turn。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L25) |
| `skill_review_operation` | `skill_operation` | 已给映射，待实现验证 | 更新/合并/回滚和批准幂等，当前版本与目录修订双重预期，回滚保留停用。；[代码](../../backend-ts/src/skills/skill-cleanup.ts#L26) |
| `skill_scope_policy` | `skill_scope_policy` | 已给映射，待实现验证 | 用户范围停用与不可变正文独立，目标方法要真实FK及祖先归属。；[代码](../../backend-ts/src/skills/skill-execution-view.ts#L29) |
| `source_document` | `source_batch` | 已给映射，待实现验证 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。；[代码](../../backend-ts/src/contacts/contact-context.ts#L16) |
| `source_processing_batch` | `source_batch` | 已给映射，待实现验证 | CLI捕获来源归有界batch；来源可靠性、模式、adapter及同绑定观察锚点必须保留。文件导入入口另按用户决定移除。；[代码](../../backend-ts/src/imports/history-import-service.ts#L177) |
| `source_processing_capture_tombstone` | `read_exclusion` | 已给映射，待实现验证 | 捕获UUID和可靠消息身份是不同tombstone种类，均不能代替未读历史边界。；[代码](../../backend-ts/src/sync/sync-incremental-store-write.ts#L36) |
| `source_processing_record` | `source_record`、`message` | 已给映射，待实现验证 | 原始出现归source_record，规范消息保存已证identity/order；raw协议字段不得丢失，不能宣称旧local_id+time已可靠。；[代码](../../backend-ts/src/imports/history-import-service.ts#L194) |
| `wechat_auto_read_suppression` | `read_exclusion` | 已给映射，待实现验证 | 捕获UUID和可靠消息身份是不同tombstone种类，均不能代替未读历史边界。；[代码](../../backend-ts/src/sync/sync-auto-read-suppression.ts#L37) |
| `wechat_binding_history_authorization` | `conversation_read_grant`、`history_restore_authorization` | 已给映射，待实现验证 | 授权协议版本、grant生命周期代次及显式恢复资格分开；旧账号/绑定历史授权需逐入口改造。；[代码](../../backend-ts/src/reply/generation/reply-scope.ts#L24) |
| `wechat_history_sync_authorization` | `conversation_read_grant`、`history_restore_authorization` | 已给映射，待实现验证 | 授权协议版本、grant生命周期代次及显式恢复资格分开；旧账号/绑定历史授权需逐入口改造。；[代码](../../backend-ts/src/contacts/contact-context.ts#L74) |
| `wechat_message_metadata` | `source_record`、`message` | 已给映射，待实现验证 | 原始出现归source_record，规范消息保存已证identity/order；raw协议字段不得丢失，不能宣称旧local_id+time已可靠。；[代码](../../backend-ts/src/contacts/contact-context.ts#L106) |
| `wechat_observation_baseline` | `sync_checkpoint`、`conversation_clear_boundary`、`conversation_read_grant` | 已给映射，待实现验证 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。；[代码](../../backend-ts/src/contacts/binding-service.ts#L136) |
| `wechat_observation_cursor` | `sync_checkpoint`、`conversation_clear_boundary`、`conversation_read_grant` | 已给映射，待实现验证 | 按grant/data_generation/episode保存读取及历史覆盖；不照搬时间/最大local_id假定。真实CLI合同未证明，字段映射不代表续读已可用。；[代码](../../backend-ts/src/host/pure-ts-follow-smoke.ts#L17) |
| `wechat_sync_exclusion` | `read_exclusion` | 已给映射，待实现验证 | 联系人删除后仍保留必要渠道排除，不能外键级联随contact消失。；[代码](../../backend-ts/src/contacts/contact-context.ts#L75) |
| `wechat_sync_scope` | `account_sync_control` | 补范围字段 | scope_mode、scope_generation、明确授权版本／时间独立于read_enabled；默认仍按已确认所选范围，保留前台共同消费者。；[代码](../../backend-ts/src/contacts/contact-context.ts#L73) |

详细来源、原始分类和所有证据见[JSON矩阵](physical-coverage.json)；字段／门禁见[物理方案](physical-schema-plan.md)。
