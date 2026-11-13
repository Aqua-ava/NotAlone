# 统一设计的旧 PG 查漏附录

静态迁移清单共115个旧名称，仅查业务事实落点，不读取用户数据库、不迁旧资料，也不表示消费者已改造。当前主方案见[统一设计](greenfield-design.md)；[查漏数据](consolidated-legacy-check.json)保留原消费者定位。媒体Q11已确认，旧媒体表按新三实体/共享墓碑映射，不照搬结构。

| 旧表 | 处理结论 | 新落点 | 接线与范围说明 |
| --- | --- | --- | --- |
| `assistant_candidate_selection` | 事实映射，接线未验证 | `reply_selection` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_candidate_version` | 事实映射，接线未验证 | `reply_candidate_version` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_runtime_deletion_target` | 事实映射，接线未验证 | `deletion_target` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_runtime_session` | 事实映射，接线未验证 | `runtime_copy`, `runtime_context` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_session` | 事实映射，接线未验证 | `assistant_discussion` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_session_input` | 事实映射，接线未验证 | `discussion_entry`, `reply_request` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `assistant_session_turn` | 事实映射，接线未验证 | `discussion_entry`, `reply_request` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `background_task` | 事实映射，接线未验证 | `processing_task` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `background_task_step` | 事实映射，接线未验证 | `processing_step`, `step_attempt`, `task_contribution` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `channel_identity` | 事实映射，接线未验证 | `conversation_binding` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `cli_backfill_state` | 事实映射，接线未验证 | `read_goal`, `history_cutoff`, `read_grant` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `cli_history_sync_state` | 事实映射，接线未验证 | `read_goal`, `history_cutoff`, `read_grant` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `confirmed_memory` | 事实映射，接线未验证 | `memory`, `memory_version` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `contact` | 事实映射，接线未验证 | `contact` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `contact_memory_index` | 查询派生 | — | 从当前有效版本和发布集合查询；不预建持久投影，现有概览接口及元数据仍须适配。 |
| `contact_memory_state` | 事实映射，接线未验证 | `contact` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `conversation_binding` | 事实映射，接线未验证 | `conversation_binding` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `cross_domain_deletion_operation` | 事实映射，接线未验证 | `deletion_operation`, `deletion_target`, `deletion_check` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `expression_preference` | 事实映射，接线未验证 | `expression_preference`, `expression_preference_version`, `preference_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `expression_preference_operation` | 事实映射，接线未验证 | `expression_preference_version`, `request_tombstone`, `deletion_operation` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `expression_preference_state` | 事实映射，接线未验证 | `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `front_sync_state` | 事实映射，接线未验证 | `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `import_confirmation` | 旧入口待接线核对 | — | 本轮非文字仅占位，不建媒体处理表；原导入／媒体消费者退役和历史副本清理需单独接线验收，不能视为已兼容。 |
| `layered_memory_batch` | 事实映射，接线未验证 | `step_attempt`, `execution_event`, `execution_input`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_memory_fact_correction` | 事实映射，接线未验证 | `organization_feedback`, `feedback_input` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_memory_feedback` | 事实映射，接线未验证 | `organization_feedback`, `feedback_input` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_memory_generation` | 事实映射，接线未验证 | `document_publication`, `publication_member` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_memory_job` | 事实映射，接线未验证 | `processing_task`, `processing_step`, `step_attempt` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_memory_state` | 事实映射，接线未验证 | `owner`, `contact` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_profile_batch` | 事实映射，接线未验证 | `step_attempt`, `execution_event`, `execution_input`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `layered_profile_version` | 事实映射，接线未验证 | `memory_document`, `memory_document_version`, `document_block`, `document_statement`, `document_basis` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `local_wechat_observation` | 事实映射，接线未验证 | `sync_capture` | 实际来源落到有界捕获；旧文件导入入口需逐项核对适配或退役。 |
| `manual_contact_confirmation` | 事实映射，接线未验证 | `manual_confirmation` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `media_attempt` | 事实映射，接线未验证 | `message_media`, `media_extraction_attempt`, `media_file` | 媒体Q11已确认，三实体区分消息管理、实际尝试与自有文件；不照搬旧artifacts JSON，不迁旧PG媒体资料，实际适配/解码/身份仍需验证。 |
| `media_request_tombstone` | 事实映射，接线未验证 | `request_tombstone`, `deletion_operation` | 共享请求墓碑与统一删除操作记录媒体失效/清除，读取/重提资格按本实例新代次核验；不迁旧PG墓碑。 |
| `memory_candidate` | 事实映射，接线未验证 | `memory_candidate` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_correction_decision` | 事实映射，接线未验证 | `memory_decision`, `memory_version` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_receipt` | 事实映射，接线未验证 | `processing_run`, `run_input`, `processing_item` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_schedule` | 事实映射，接线未验证 | `processing_run`, `run_input`, `processing_item` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_trace` | 事实映射，接线未验证 | `step_attempt`, `execution_event`, `execution_input`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_trace_call` | 事实映射，接线未验证 | `execution_event`, `model_call` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_trace_dependency` | 事实映射，接线未验证 | `execution_input`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_trace_event` | 事实映射，接线未验证 | `execution_event` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_trace_link` | 事实映射，接线未验证 | `execution_input`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_extraction_watermark` | 事实映射，接线未验证 | `processing_run`, `run_input`, `processing_item` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_legacy_adoption` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `memory_processing_operation` | 事实映射，接线未验证 | `processing_run`, `processing_task`, `request_tombstone` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_plan` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `memory_processing_receipt` | 事实映射，接线未验证 | `processing_run`, `run_input`, `processing_item` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_round` | 事实映射，接线未验证 | `processing_run`, `processing_task` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_round_target` | 事实映射，接线未验证 | `run_input` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_round_task` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `memory_processing_scope` | 事实映射，接线未验证 | `owner`, `contact` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_processing_target` | 事实映射，接线未验证 | `run_input` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `memory_upgrade_batch` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `memory_upgrade_job` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `memory_upgrade_operation` | 不复刻旧流程 | — | 空库无旧数据迁移，任务固定归属一轮；不复制旧升级或跨轮兼容状态。 |
| `message` | 事实映射，接线未验证 | `message` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `message_source_ref` | 事实映射，接线未验证 | `capture_record` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `model_call_learning_claim` | 事实映射，接线未验证 | `model_call` | 核心调用生产者由真实执行 FK 记录；Skill 学习认领部分按本次范围排除。 |
| `model_call_receipt` | 事实映射，接线未验证 | `model_operation`, `model_call` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `organization_quality_attempt` | 事实映射，接线未验证 | `quality_attempt` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `organization_quality_case` | 事实映射，接线未验证 | `quality_case`, `quality_case_input` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `organization_quality_fact_intent` | 事实映射，接线未验证 | `memory_decision`, `organization_feedback` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `organization_quality_revocation` | 不建候选 | — | 既有静态审查未见消费者；诊断删除由统一删除与调用资格承担，实施前复核消费者。 |
| `organization_quality_run` | 事实映射，接线未验证 | `quality_run` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `outbound_ledger_entry` | 事实映射，接线未验证 | `model_operation`, `model_call` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `owner` | 事实映射，接线未验证 | `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `owner_channel_identity` | 事实映射，接线未验证 | `channel_account` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `owner_memory` | 事实映射，接线未验证 | `memory`, `memory_version` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `owner_memory_state` | 事实映射，接线未验证 | `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `relationship_overview_projection` | 查询派生 | — | 从当前有效版本和发布集合查询；不预建持久投影，现有概览接口及元数据仍须适配。 |
| `reply_attempt` | 事实映射，接线未验证 | `reply_attempt` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_candidate` | 事实映射，接线未验证 | `reply_candidate`, `reply_candidate_version`, `reply_version_part` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_candidate_citation` | 事实映射，接线未验证 | `reply_basis` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_context_evidence` | 事实映射，接线未验证 | `reply_context`, `reply_context_item`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_exploration` | 事实映射，接线未验证 | `discussion_entry`, `reply_request` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_expression_preference_use` | 事实映射，接线未验证 | `reply_context_item` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_invalidated_key` | 事实映射，接线未验证 | `request_tombstone` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_original_source_use` | 事实映射，接线未验证 | `reply_context`, `reply_context_item`, `event_source` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_request` | 事实映射，接线未验证 | `reply_request` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_skill` | 事实映射，接线未验证 | `skill_package`, `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_skill_file_cleanup` | 事实映射，接线未验证 | `deletion_target` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_skill_method` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `reply_skill_publication` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `reply_skill_version` | 事实映射，接线未验证 | `skill_package_revision` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `reply_skill_working_copy` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `scenario_document_mapping` | 事实映射，接线未验证 | `publication_member` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `scenario_document_version` | 事实映射，接线未验证 | `memory_document`, `memory_document_version`, `document_block`, `document_statement`, `document_basis` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `skill_draft` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_history_operation` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_learning_batch` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_learning_operation` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_learning_receipt` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_learning_scope` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_library` | 事实映射，接线未验证 | `skill_package`, `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `skill_method_identity` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_policy_operation` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_policy_state` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_review_call` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_review_comparison` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_review_operation` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `skill_scope_policy` | 本次范围外 | — | 按用户最新 Skill 范围不建学习／审核／方法策略表；包修订锚点另保留，旧消费者需后续退役适配，未执行下线。 |
| `source_document` | 事实映射，接线未验证 | `sync_capture` | 实际来源落到有界捕获；旧文件导入入口需逐项核对适配或退役。 |
| `source_processing_batch` | 事实映射，接线未验证 | `sync_capture` | 实际来源落到有界捕获；旧文件导入入口需逐项核对适配或退役。 |
| `source_processing_capture_tombstone` | 事实映射，接线未验证 | `request_tombstone` | 阻止旧捕获重放；单个来源删除不能自动升级为整个渠道消息的永久读取排除。 |
| `source_processing_record` | 事实映射，接线未验证 | `capture_record` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_auto_read_suppression` | 事实映射，接线未验证 | `read_exclusion`, `history_cutoff` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_binding_history_authorization` | 事实映射，接线未验证 | `read_grant`, `read_goal` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_history_sync_authorization` | 事实映射，接线未验证 | `read_grant`, `read_goal` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_message_metadata` | 事实映射，接线未验证 | `capture_record`, `message` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_observation_baseline` | 事实映射，接线未验证 | `history_cutoff`, `read_goal` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_observation_cursor` | 事实映射，接线未验证 | `read_goal` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_sync_exclusion` | 事实映射，接线未验证 | `read_exclusion` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
| `wechat_sync_scope` | 事实映射，接线未验证 | `channel_account`, `owner` | 新模型保存所需事实，不保证旧字段、SQL 或接口一一兼容。 |
