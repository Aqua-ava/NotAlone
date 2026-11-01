/** 本轮实际 DDL 的结构基线：77 表逻辑目录中的实现、替代与暂缓分类（数量仅用于查漏）。 */
export const IMPLEMENTED_DESIGN_TABLES = [
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
/** 13 偏好、15 纠错／诊断本轮暂缓：不建空表，入口保持关闭。 */
export const DEFERRED_DESIGN_TABLES = ['expression_preference', 'expression_preference_version', 'preference_source',
  'organization_feedback', 'feedback_input', 'quality_case', 'quality_case_input', 'quality_run', 'quality_attempt'] as const;
/** 设计中的整会话读取排除由 06 的来源级排除替代；未实现未确认的整会话分支。 */
export const REPLACED_DESIGN_TABLES = ['read_exclusion'] as const;
/** 实现需要的关联/账本/范围表，均有对应票与真实动作，不冒充逻辑目录之外的领域平台。 */
export const IMPLEMENTATION_TABLES = ['memory_document_later_schedule', 'memory_document_later_cursor', 'memory_document_later_run_requirement', 'document_effect_scope', 'document_extraction_reuse', 'document_publication_identity',
  'document_replacement', 'history_cutoff_member', 'history_deletion_fence', 'history_continuity_fence', 'history_continuity_scope', 'history_guard_lease', 'history_message_quarantine', 'history_quote', 'history_quote_attempt', 'history_restore', 'history_source_exclusion', 'history_source_terminal',
  'message_alias', 'reply_candidate_context', 'reply_candidate_input', 'reply_candidate_input_source', 'reply_candidate_request',
  'reply_execution_input', 'runtime_file'] as const;
export const EXPECTED_TABLES: readonly string[] = [...IMPLEMENTED_DESIGN_TABLES, ...IMPLEMENTATION_TABLES].sort();
export const FORBIDDEN_TABLES: readonly string[] = [...DEFERRED_DESIGN_TABLES, ...REPLACED_DESIGN_TABLES].sort();
export const LOGICAL_CATALOG_TABLES = [...IMPLEMENTED_DESIGN_TABLES, ...DEFERRED_DESIGN_TABLES, ...REPLACED_DESIGN_TABLES].sort();
