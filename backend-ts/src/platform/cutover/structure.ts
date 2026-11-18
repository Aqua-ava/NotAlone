/** 本轮实际 DDL 的结构基线：已实现的设计表、关联账本表与固定检索索引表合成 EXPECTED_TABLES。 */
const IMPLEMENTED_DESIGN_TABLES = [
  'owner', 'contact', 'channel_account', 'channel_conversation', 'conversation_binding', 'binding_verification', 'read_grant', 'read_goal',
  'history_cutoff', 'sync_capture', 'capture_record', 'message', 'manual_confirmation', 'processing_run', 'run_contact', 'processing_item',
  'run_input', 'processing_task', 'task_contribution', 'processing_step', 'step_input', 'step_attempt', 'model_operation', 'operation_item',
  'operation_scope', 'model_call', 'execution_event', 'execution_input', 'event_source', 'memory_candidate', 'memory', 'memory_version',
  'memory_decision', 'decision_candidate', 'memory_required_message', 'memory_citation', 'assistant_discussion', 'discussion_entry',
  'reply_request', 'reply_attempt', 'reply_context', 'reply_context_item', 'reply_candidate', 'reply_candidate_version', 'reply_version_part',
  'reply_basis', 'reply_selection', 'runtime_copy', 'runtime_context', 'memory_document', 'memory_document_version', 'document_block',
  'document_statement', 'document_basis', 'document_publication', 'publication_member', 'skill_package', 'skill_package_revision',
  'deletion_operation', 'deletion_target', 'deletion_check', 'request_tombstone', 'database_instance', 'schema_migration', 'message_media',
  'media_extraction_attempt', 'media_file',
] as const;
/** 实现需要的关联/账本/范围表，均有对应票与真实动作，不冒充逻辑目录之外的领域平台。 */
const IMPLEMENTATION_TABLES = ['contact_avatar', 'contact_avatar_clock', 'skill_group', 'skill_group_package', 'contact_skill_group', 'memory_document_later_schedule', 'memory_document_later_cursor', 'memory_document_later_run_requirement', 'document_effect_scope', 'document_extraction_reuse', 'document_publication_identity',
  'document_replacement', 'history_cutoff_member', 'history_deletion_fence', 'source_proof', 'history_source_equivalence', 'history_message_quarantine', 'history_quote', 'history_quote_attempt', 'history_restore', 'history_source_exclusion', 'history_source_terminal',
  'message_alias', 'reply_candidate_context', 'reply_candidate_input', 'reply_candidate_input_source', 'reply_candidate_request',
  'reply_execution_input', 'run_content_input', 'runtime_file'] as const;
/** 固定版本FTS5/vec0的真实主表与影子表都纳入结构核验。 */
const RETRIEVAL_INDEX_TABLES=['retrieval_document','retrieval_text_pending','retrieval_vector_cursor',
  'retrieval_fts','retrieval_fts_config','retrieval_fts_content','retrieval_fts_data','retrieval_fts_docsize','retrieval_fts_idx',
  'retrieval_vec','retrieval_vec_chunks','retrieval_vec_info','retrieval_vec_rowids','retrieval_vec_vector_chunks00'] as const;
export const EXPECTED_TABLES: readonly string[] = [...IMPLEMENTED_DESIGN_TABLES, ...IMPLEMENTATION_TABLES,...RETRIEVAL_INDEX_TABLES].sort();
/** 从不创建的表：13 偏好与 15 纠错／诊断暂缓、整会话读取排除由来源级排除替代、以及已退役的历史连续性账本。 */
export const FORBIDDEN_TABLES: readonly string[] = ['expression_preference', 'expression_preference_version', 'preference_source',
  'organization_feedback', 'feedback_input', 'quality_case', 'quality_case_input', 'quality_run', 'quality_attempt', 'read_exclusion',
  'history_continuity_fence', 'history_continuity_scope', 'history_guard_lease', 'history_source_recertification',
  'history_source_recertification_cancel', 'history_superseded_cleanup'].sort();
