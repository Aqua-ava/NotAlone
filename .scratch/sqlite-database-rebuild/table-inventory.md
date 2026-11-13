# SQLite逻辑表提案精确清点

日期：2026-10-28。范围：02–08当前提案逐项落表，未执行SQL或查询真实数据库。

**合计 107 个候选表名：100 个业务基线＋3 个条件持久化项＋4 个诊断能力表（位置待决）。未物理收敛前，业务库可能是100—107张，不能预先把诊断表排除。**

这些是物理收敛前的逻辑候选，不能声称已经明显少于100。迁移账本／实例元数据尚未命名，不在计数内；两个专用清理目标已被统一文件目标承接，不重复计数。

## 分组

| 分组 | 业务 | 条件 | 诊断 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 身份 | 4 | 0 | 0 | 4 |
| 消息来源 | 3 | 0 | 0 | 3 |
| 记忆及证据 | 14 | 0 | 0 | 14 |
| 处理与调用 | 12 | 0 | 0 | 12 |
| 助手与候选 | 14 | 0 | 0 | 14 |
| 集合与表达偏好 | 5 | 0 | 0 | 5 |
| 派生文档与投影 | 12 | 2 | 0 | 14 |
| Skill及审核 | 24 | 1 | 0 | 25 |
| 诊断能力（位置待决） | 0 | 0 | 4 | 4 |
| 读取及删除 | 12 | 0 | 0 | 12 |

## 逐表清单

下列键均为现稿的概形，不能当作完整物理DDL。诊断表的键有明确待定标记。

| # | 表 | 一行含义 | 主键概形 | 状态 | 来源 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `owner` | 本机资料所有者身份 | `owner_id` | business | [02](issues/02-contact-identity-model.md):36 |
| 2 | `channel_account` | 已核验渠道账号身份 | `owner_id, account_id` | business | [02](issues/02-contact-identity-model.md):47 |
| 3 | `contact` | 属于用户的一位联系人 | `owner_id, contact_id` | business | [02](issues/02-contact-identity-model.md):69 |
| 4 | `conversation_binding` | 已核验渠道会话到联系人的稳定映射 | `owner_id, binding_id` | business | [02](issues/02-contact-identity-model.md):84 |
| 5 | `source_batch` | 一次有界CLI捕获页 | `owner_id, contact_id, batch_id` | business | [03](issues/03-message-source-model.md):41 |
| 6 | `source_record` | 捕获页中的一次原始出现 | `owner_id, contact_id, record_id` | business | [03](issues/03-message-source-model.md):65 |
| 7 | `message` | 可靠核验后的规范消息及非文字占位 | `owner_id, contact_id, message_id` | business | [03](issues/03-message-source-model.md):90 |
| 8 | `memory_candidate` | 一次待裁决记忆主张 | `owner_id, candidate_id` | business | [04](issues/04-memory-evidence-model.md):28 |
| 9 | `memory` | 一条稳定记忆身份及当前版本指针 | `owner_id, memory_id` | business | [04](issues/04-memory-evidence-model.md):47 |
| 10 | `memory_version` | 记忆的具体内容及依据版本 | `owner_id, memory_id, version_no` | business | [04](issues/04-memory-evidence-model.md):64 |
| 11 | `memory_version_parent` | 两个具体记忆版本间的来历边 | `owner_id, child_memory_id, child_version_no, parent_memory_id, parent_version_no` | business | [04](issues/04-memory-evidence-model.md):89 |
| 12 | `candidate_evidence` | 候选引用的一个消息片段 | `owner_id, candidate_id, evidence_id` | business | [04](issues/04-memory-evidence-model.md):104 |
| 13 | `candidate_required_message` | 候选成立必需的一条消息 | `owner_id, candidate_id, source_contact_id, message_id` | business | [04](issues/04-memory-evidence-model.md):105 |
| 14 | `memory_version_evidence` | 记忆版本引用的一个消息片段 | `owner_id, memory_id, version_no, evidence_id` | business | [04](issues/04-memory-evidence-model.md):106 |
| 15 | `memory_version_required_message` | 记忆版本成立必需的一条消息 | `owner_id, memory_id, version_no, source_contact_id, message_id` | business | [04](issues/04-memory-evidence-model.md):107 |
| 16 | `memory_trace` | 一次有界处理过程及正文生命周期 | `owner_id, trace_id` | business | [04](issues/04-memory-evidence-model.md):123 |
| 17 | `memory_trace_event` | 处理阶段事件及完整敏感载荷 | `owner_id, trace_id, event_no` | business | [04](issues/04-memory-evidence-model.md):137 |
| 18 | `trace_message_input` | 追踪实际目标或上下文消息输入 | `owner_id, trace_id, input_no` | business | [04](issues/04-memory-evidence-model.md):148 |
| 19 | `trace_source_input` | 追踪实际依赖的捕获来源 | `owner_id, trace_id, source_contact_id, record_id` | business | [04](issues/04-memory-evidence-model.md):149 |
| 20 | `trace_memory_input` | 追踪实际输入的具体旧记忆版本 | `owner_id, trace_id, input_no` | business | [04](issues/04-memory-evidence-model.md):150 |
| 21 | `memory_decision` | 采纳拒绝修正恢复删除的操作事实 | `owner_id, decision_id` | business | [04](issues/04-memory-evidence-model.md):158 |
| 22 | `processing_scope` | 跨轮稳定的本人或联系人控制范围 | `owner_id, scope_id` | business | [05](issues/05-processing-task-model.md):35 |
| 23 | `processing_run` | 一次用户手动启动 | `owner_id, run_id` | business | [05](issues/05-processing-task-model.md):48 |
| 24 | `processing_round` | 本次启动在一个范围上的固定分支 | `owner_id, run_id, scope_id` | business | [05](issues/05-processing-task-model.md):62 |
| 25 | `processing_input` | 点击时固定的可用消息成员 | `owner_id, run_id, scope_id, message_id` | business | [05](issues/05-processing-task-model.md):75 |
| 26 | `processing_receipt` | 某条消息跨轮处理或未知隔离结果 | `owner_id, contact_id, message_id` | business | [05](issues/05-processing-task-model.md):92 |
| 27 | `background_task` | 归属固定的一份有限工作 | `owner_id, task_id` | business | [05](issues/05-processing-task-model.md):102 |
| 28 | `background_task_step` | 有独立恢复价值的步骤 | `owner_id, task_id, step_no` | business | [05](issues/05-processing-task-model.md):116 |
| 29 | `step_attempt` | 步骤一次真实领取执行及租约历史 | `owner_id, task_id, step_no, attempt_no` | business | [05](issues/05-processing-task-model.md):122 |
| 30 | `step_attempt_guard` | 本次执行需要复验的硬范围门禁 | `owner_id, task_id, step_no, attempt_no, guard_scope_id` | business | [05](issues/05-processing-task-model.md):130 |
| 31 | `model_request` | 一次稳定逻辑模型操作 | `owner_id, request_id` | business | [05](issues/05-processing-task-model.md):138 |
| 32 | `model_call` | 一次物理模型调用无正文账目 | `owner_id, call_id` | business | [05](issues/05-processing-task-model.md):146 |
| 33 | `step_model_call` | 一次物理调用与实际步骤执行的关联 | `owner_id, call_id` | business | [05](issues/05-processing-task-model.md):165 |
| 34 | `assistant_session` | 联系人下的一段业务讨论 | `owner_id, contact_id, session_id` | business | [06](issues/06-assistant-history-model.md):37 |
| 35 | `assistant_turn` | 一次明确提交输入及逻辑请求 | `owner_id, contact_id, session_id, turn_id` | business | [06](issues/06-assistant-history-model.md):52 |
| 36 | `assistant_attempt` | 助手短请求的一次实际执行 | `owner_id, contact_id, session_id, turn_id, attempt_no` | business | [06](issues/06-assistant-history-model.md):72 |
| 37 | `reply_candidate` | 生成的一个稳定回复候选身份 | `owner_id, contact_id, session_id, candidate_id` | business | [06](issues/06-assistant-history-model.md):80 |
| 38 | `reply_candidate_version` | 回复候选的原稿或编辑版本 | `owner_id, contact_id, session_id, candidate_id, version_no` | business | [06](issues/06-assistant-history-model.md):86 |
| 39 | `reply_candidate_segment` | 候选内稳定的消息段身份与顺序 | `owner_id, contact_id, session_id, candidate_id, segment_id` | business | [06](issues/06-assistant-history-model.md):103 |
| 40 | `reply_candidate_version_message` | 某版本某段的正文 | `owner_id, contact_id, session_id, candidate_id, version_no, segment_id` | business | [06](issues/06-assistant-history-model.md):104 |
| 41 | `assistant_selection` | 用户一次显式选择具体候选版本 | `owner_id, contact_id, session_id, selection_no` | business | [06](issues/06-assistant-history-model.md):108 |
| 42 | `assistant_context_snapshot` | 一次实际构造的有界上下文快照 | `owner_id, contact_id, session_id, context_id` | business | [06](issues/06-assistant-history-model.md):114 |
| 43 | `assistant_context_item` | 上下文中一项带真实类型外键的材料 | `owner_id, contact_id, session_id, context_id, item_no` | business | [06](issues/06-assistant-history-model.md):120 |
| 44 | `candidate_version_citation` | 某版候选的具体显示依据定位 | `owner_id, contact_id, session_id, candidate_id, version_no, citation_no` | business | [06](issues/06-assistant-history-model.md):138 |
| 45 | `assistant_attempt_model_call` | 助手执行与实际上下文及物理调用关联 | `owner_id, call_id` | business | [06](issues/06-assistant-history-model.md):144 |
| 46 | `assistant_runtime_instance` | 业务会话的一个DSH运行副本 | `owner_id, contact_id, session_id, runtime_id` | business | [06](issues/06-assistant-history-model.md):156 |
| 47 | `assistant_runtime_context` | 运行副本实际纳入的上下文 | `owner_id, contact_id, session_id, runtime_id, context_id` | business | [06](issues/06-assistant-history-model.md):157 |
| 48 | `owner_collection_state` | 用户三个独立集合的单调修订 | `owner_id` | business | [07](issues/07-preference-document-skill-model.md):37 |
| 49 | `expression_preference` | 一条用户明确长期偏好身份 | `owner_id, preference_id` | business | [07](issues/07-preference-document-skill-model.md):47 |
| 50 | `expression_preference_version` | 偏好正文及适用范围的具体版本 | `owner_id, preference_id, version_no` | business | [07](issues/07-preference-document-skill-model.md):48 |
| 51 | `preference_version_source` | 偏好版本当时实际捕获支持 | `owner_id, preference_id, version_no, source_contact_id, record_id` | business | [07](issues/07-preference-document-skill-model.md):49 |
| 52 | `expression_preference_operation` | 偏好保存修改删除的幂等操作 | `owner_id, operation_key` | business | [07](issues/07-preference-document-skill-model.md):50 |
| 53 | `document_collection` | 同一本人或联系人范围的文档集合 | `owner_id, collection_id` | business | [07](issues/07-preference-document-skill-model.md):64 |
| 54 | `memory_document` | 一个稳定主题或画像身份 | `owner_id, document_id` | business | [07](issues/07-preference-document-skill-model.md):65 |
| 55 | `memory_document_version` | 文档一个具体内容版本 | `owner_id, document_id, version_no` | business | [07](issues/07-preference-document-skill-model.md):66 |
| 56 | `document_block` | 文档版本内一个有类型的内容块 | `owner_id, document_id, version_no, block_no` | business | [07](issues/07-preference-document-skill-model.md):67 |
| 57 | `document_version_parent` | 文档版本延续合并拆分来历边 | `owner_id, child_document_id, child_version_no, parent_document_id, parent_version_no` | business | [07](issues/07-preference-document-skill-model.md):68 |
| 58 | `trace_document_input` | 追踪实际使用的文档版本 | `owner_id, trace_id, input_no` | business | [07](issues/07-preference-document-skill-model.md):75 |
| 59 | `trace_feedback_input` | 追踪实际使用的有效组织反馈 | `owner_id, trace_id, feedback_id` | business | [07](issues/07-preference-document-skill-model.md):76 |
| 60 | `document_block_reference` | 文档块对实际版本输入的引用 | `owner_id, document_id, version_no, block_no, reference_no` | business | [07](issues/07-preference-document-skill-model.md):77 |
| 61 | `document_publication` | 同范围一次一致文档发布集合 | `owner_id, collection_id, publication_no` | business | [07](issues/07-preference-document-skill-model.md):79 |
| 62 | `document_publication_member` | 发布集合内一篇文档选用的一版 | `owner_id, collection_id, publication_no, document_id` | business | [07](issues/07-preference-document-skill-model.md):84 |
| 63 | `organization_feedback` | 针对具体文档块或记忆版本的有限纠错反馈 | `owner_id, feedback_id` | business | [07](issues/07-preference-document-skill-model.md):92 |
| 64 | `organization_feedback_input` | 纠错反馈实际保护输入及来源 | `owner_id, feedback_id, input_no` | business | [07](issues/07-preference-document-skill-model.md):94 |
| 65 | `overview_projection` | 有消费者的可重建无正文概览缓存 | `owner_id, projection_id` | conditional | [07](issues/07-preference-document-skill-model.md):100 |
| 66 | `overview_projection_member` | 概览缓存成员及无正文定位 | `owner_id, projection_id, member_no` | conditional | [07](issues/07-preference-document-skill-model.md):100 |
| 67 | `reply_skill` | Skill稳定身份及业务目录状态 | `owner_id, skill_id` | business | [07](issues/07-preference-document-skill-model.md):108 |
| 68 | `reply_skill_version` | 不可变Skill文件版本锚点及发布来历 | `owner_id, skill_id, version_no` | business | [07](issues/07-preference-document-skill-model.md):109 |
| 69 | `reply_method` | 回复方法的稳定身份 | `owner_id, method_id` | business | [07](issues/07-preference-document-skill-model.md):110 |
| 70 | `skill_version_method` | 某Skill版本的方法成员及顺序 | `owner_id, skill_id, version_no, method_id` | business | [07](issues/07-preference-document-skill-model.md):111 |
| 71 | `skill_method_parent` | 方法延续或替代祖先边 | `owner_id, child_method_id, parent_method_id` | business | [07](issues/07-preference-document-skill-model.md):112 |
| 72 | `skill_parent` | Skill合并或延续祖先边 | `owner_id, child_skill_id, parent_skill_id` | business | [07](issues/07-preference-document-skill-model.md):113 |
| 73 | `skill_scope_policy` | Skill或方法在明确范围的停用决定 | `owner_id, policy_id` | business | [07](issues/07-preference-document-skill-model.md):119 |
| 74 | `skill_policy_operation` | 范围政策的明确幂等操作 | `owner_id, operation_key` | business | [07](issues/07-preference-document-skill-model.md):120 |
| 75 | `skill_use` | 实际Skill版本及政策视图使用事实 | `owner_id, use_id` | business | [07](issues/07-preference-document-skill-model.md):121 |
| 76 | `skill_use_method` | 实际使用视图中的具体版本方法成员 | `owner_id, use_id, method_id` | business | [07](issues/07-preference-document-skill-model.md):121 |
| 77 | `skill_learning_scope` | 单联系人独立学习授权 | `owner_id, contact_id` | business | [07](issues/07-preference-document-skill-model.md):128 |
| 78 | `skill_learning_operation` | 学习授权启停的幂等操作 | `owner_id, contact_id, operation_key` | business | [07](issues/07-preference-document-skill-model.md):129 |
| 79 | `skill_learning_batch` | 一份有限授权学习批次及结果 | `owner_id, contact_id, batch_id` | business | [07](issues/07-preference-document-skill-model.md):130 |
| 80 | `skill_learning_input` | 本学习批次实际材料的类型化输入组件 | `owner_id, contact_id, batch_id, input_no` | business | [07](issues/07-preference-document-skill-model.md):131 |
| 81 | `skill_learning_receipt` | 实际材料预约及成功消费结果 | `owner_id, contact_id, material_key` | business | [07](issues/07-preference-document-skill-model.md):132 |
| 82 | `skill_draft` | 待审核策略草稿稳定身份 | `owner_id, contact_id, draft_id` | business | [07](issues/07-preference-document-skill-model.md):133 |
| 83 | `skill_draft_version` | 草稿一个修订的清洗策略及私人依据 | `owner_id, contact_id, draft_id, revision` | business | [07](issues/07-preference-document-skill-model.md):134 |
| 84 | `skill_draft_target` | 草稿修订明确针对的Skill版本 | `owner_id, contact_id, draft_id, revision, target_skill_id, target_version_no` | business | [07](issues/07-preference-document-skill-model.md):135 |
| 85 | `skill_review` | 冻结输入和草稿修订的业务对照审核 | `owner_id, contact_id, review_id` | business | [07](issues/07-preference-document-skill-model.md):136 |
| 86 | `skill_review_input` | 审核共同上下文实际类型化来源 | `owner_id, contact_id, review_id, input_no` | business | [07](issues/07-preference-document-skill-model.md):137 |
| 87 | `skill_review_target` | 审核冻结的具体目标版本 | `owner_id, contact_id, review_id, skill_id, version_no` | business | [07](issues/07-preference-document-skill-model.md):138 |
| 88 | `skill_review_side` | 审核一侧实际策略及执行结果 | `owner_id, contact_id, review_id, side` | business | [07](issues/07-preference-document-skill-model.md):139 |
| 89 | `skill_review_result_call` | 审核结果消费的真实物理调用链 | `owner_id, contact_id, review_id, side, call_id` | business | [07](issues/07-preference-document-skill-model.md):140 |
| 90 | `skill_catalog_operation` | 安装发布更新合并删除回滚的幂等决定 | `owner_id, operation_key` | business | [07](issues/07-preference-document-skill-model.md):146 |
| 91 | `skill_worktree_projection` | 可恢复的非权威Skill工作目录回写 | `owner_id, operation_key, skill_id` | conditional | [07](issues/07-preference-document-skill-model.md):150 |
| 92 | `quality_run` | 合成用途运行门禁下的一次质量数据集运行 | `owner_id, run_id〔键概形建议，现稿未逐表定键〕` | diagnostic | [07](issues/07-preference-document-skill-model.md):168 |
| 93 | `quality_case` | 冻结诊断输入及人工标注 | `owner_id, case_id〔键概形建议，run_id为外键〕` | diagnostic | [07](issues/07-preference-document-skill-model.md):168 |
| 94 | `quality_attempt` | 诊断案例一次真实调用及审阅 | `owner_id, attempt_id〔键概形建议，run/case/call为外键〕` | diagnostic | [07](issues/07-preference-document-skill-model.md):168 |
| 95 | `quality_fact_intent` | 精确纠错目标与有限质量案例衔接 | `owner_id, intent_id〔键概形建议，现稿未逐表定键〕` | diagnostic | [07](issues/07-preference-document-skill-model.md):168 |
| 96 | `deletion_operation` | 独立于被删对象的持久删除请求 | `operation_id` | business | [08](issues/08-deletion-consistency.md):50 |
| 97 | `deletion_row_target` | 待清理数据库对象的受控地址快照 | `operation_id, target_no` | business | [08](issues/08-deletion-consistency.md):73 |
| 98 | `deletion_file_target` | 受管文件清理目标与同操作身份 | `operation_id, target_no` | business | [08](issues/08-deletion-consistency.md):74 |
| 99 | `deletion_verification` | 一个计划修订的分面复核结果 | `operation_id, check_kind` | business | [08](issues/08-deletion-consistency.md):75 |
| 100 | `account_sync_control` | 账号读取开关及开关代次 | `owner_id, account_id` | business | [08](issues/08-deletion-consistency.md):85 |
| 101 | `conversation_read_grant` | 绑定上的一次独立读取授权 | `owner_id, grant_id` | business | [08](issues/08-deletion-consistency.md):86 |
| 102 | `contact_data_control` | 联系人硬数据代次及局部来源修订 | `owner_id, contact_id` | business | [08](issues/08-deletion-consistency.md):87 |
| 103 | `conversation_clear_boundary` | 覆盖尚未读历史的稳定会话分界凭据 | `owner_id, boundary_id` | business | [08](issues/08-deletion-consistency.md):93 |
| 104 | `ingestion_tombstone` | 旧捕获或消息身份的最小重读抑制 | `owner_id, account_id, conversation_identity_scheme, conversation_identity_key, tombstone_kind, identity_scheme, identity_key` | business | [08](issues/08-deletion-consistency.md):105 |
| 105 | `conversation_exclusion` | 独立于live联系人的稳定会话排除 | `owner_id, account_id, conversation_identity_scheme, conversation_identity_key` | business | [08](issues/08-deletion-consistency.md):107 |
| 106 | `history_restore_authorization` | 单联系人显式历史恢复的新资格 | `owner_id, restore_id` | business | [08](issues/08-deletion-consistency.md):115 |
| 107 | `sync_checkpoint` | 某授权代次和读取episode的进度与覆盖 | `owner_id, grant_id, data_generation, stream_episode_id` | business | [08](issues/08-deletion-consistency.md):119 |

## 已共享，不重复建表

- **owner_collection_state**：三类owner一对一集合状态同存一行，三个计数器独立；承接 expression_preference_state、skill_library、skill_policy_state。
- **assistant_turn**：同一逻辑用户提交身份收敛；0:N执行历史由assistant_attempt承接；承接 assistant_session_input、assistant_session_turn、reply_request。
- **memory_trace / memory_trace_event**：07组织过程复用04，租约与模型账复用05，不把两个旧batch再计表；承接 layered_memory_batch的完整过程、layered_profile_batch的完整过程。
- **background_task / background_task_step / step_attempt**：共享确定性执行机制，授权及业务身份仍各自保留；承接 组织执行、授权学习执行、对照审核执行。
- **model_request / model_call**：共享逻辑请求与物理尝试，不据逻辑调用次数推断实际费用；承接 记忆模型调用、助手模型调用、Skill审核调用、诊断模型调用。
- **reply_skill_version**：07批准来历并入版本，不再保留壳表；承接 reply_skill_publication固定1:1发布来历。
- **deletion_file_target**：同一operation下按类型保留路径和预期身份，安全规则不得降级；承接 assistant_runtime_deletion_target、skill_file_cleanup_target。

## 别名与不建项

- assistant_runtime_deletion_target → deletion_file_target：08明确运行目录目标可由统一类型文件目标承接，不另计一张。
- skill_file_cleanup_target → deletion_file_target：07归08删除操作；08明确Skill专用文件目标可由统一目标承接。
- contact_channel_identity：02明确当前范围暂不单独建立。
- memory_processing_plan：05单任务plan弱一对一壳不再建立。
- memory_processing_round_task：Q38固定任务单轮，直接FK，不保留跨轮N:M。
- memory_processing_round_target：Q38不保留为旧task追加输入服务的第二套目标快照。
- style_sample及其偏好依赖：已退役，不因旧迁移存在恢复。
- reply_skill_resource：103目录清单权威，不重建SQL资源字节表。
- organization_quality_revocation：07未发现src/test消费者，候选不建／待覆盖审计。
- 旧资料升级与legacy-adoption专用表：空库不迁入旧业务数据，不照搬历史接入状态。

## 可以讨论的物理收敛

- **merge_trace_inputs**：trace_message_input、trace_source_input、trace_memory_input、trace_document_input、trace_feedback_input → 一个带独立类型字段与真实FK的trace_input。条件成立时最多净少4张。 须保留目标/上下文/支持用途、所有类型真实FK、scope条件和完整参与依赖；禁止kind+任意id伪引用。
- **merge_claim_evidence**：candidate_evidence、memory_version_evidence → 候选或已采纳版本为排他目标的claim_evidence。条件成立时最多净少1张。 恰一目标完整非空，候选同原联系人、owner版本范围等约束仍真实可执行。
- **merge_claim_required_messages**：candidate_required_message、memory_version_required_message → 排他目标的claim_required_message。条件成立时最多净少1张。 仍与片段证据分开，AND集合不因统一表变成任意引用。
- **share_input_manifests**：assistant_context_snapshot、assistant_context_item、skill_learning_input、skill_review_input、organization_feedback_input、overview_projection_member、preference_version_source → 研究共享材料清单／真实类型引用结构。净减少量尚不能定，须先计新增父表／关联。 需计入新增清单头和归属关系；业务授权、scope、快照时间与删除生命周期不同，不能直接宣称删几张。
- **merge_skill_lineage**：skill_method_parent、skill_parent → 按明确类型FK分支的skill_lineage。条件成立时最多净少1张。 方法与Skill图各自无环、同owner、批准来历和祖先政策继承不丢失。
- **merge_skill_operations**：skill_policy_operation、skill_learning_operation、skill_catalog_operation → 研究Skill明确管理操作共同凭证。条件成立时最多净少2张。 只合并相同生命周期的操作事实，不合并授权scope、三种revision或动作资格；须明确不同kind的真实目标FK和幂等键。
- **review_target_derivation**：skill_draft_target、skill_review_target → 若审核目标严格等于不可变draft revision目标，则可由版本引用派生。条件成立时最多净少1张。 现已补代码证据：审核目标复制draft且不能独立重定；新immutable draft_version关系可承接冻结集合，仍保留当前目标CAS、来源资格和发布范围。
- **merge_deletion_targets**：deletion_row_target、deletion_file_target → 统一deletion_target但明确storage_kind与地址shape。条件成立时最多净少1张。 保持受控数据库键地址与受管文件预期身份不同校验，FK仍到operation，不允许任意路径/SQL。
- **conditional_persistence**：overview_projection、overview_projection_member、skill_worktree_projection → 是否计算投影或用既有可恢复机制承接。条件成立时最多净少3张。 须有API消费者、负载与恢复覆盖证据；不可因为可重建就删。

## 物理收敛候选计数（不改上述107基线）

| 累积方案 | 总表候选 | 业务 | 条件 | 诊断位置待决 |
| --- | ---: | ---: | ---: | ---: |
| 原草案基线 | 107 | 100 | 3 | 4 |
| 共享材料清单及真实类型引用 | 97 | 91 | 2 | 4 |
| 补覆盖查证遗漏的手动联系人确认 | 98 | 92 | 2 | 4 |
| 两类主张的片段证据与必需消息分别统一 | 96 | 90 | 2 | 4 |
| Skill三类明确用户操作凭证统一 | 94 | 88 | 2 | 4 |
| Skill及方法祖先边统一 | 93 | 87 | 2 | 4 |
| 数据库与文件删除目标统一 | 92 | 86 | 2 | 4 |
| 会话排除并入分类型读取抑制 | 91 | 85 | 2 | 4 |
| 审核目标沿不可变草稿版本派生 | 90 | 84 | 2 | 4 |

小合并方案（不抽通用material_set，仅trace五输入合一、证据对合并、统一删除目标、审核目标派生及补手动确认）仍为 **100**。完整候选组合为 **90**，尚未加迁移账本／实例元数据；不是已经批准的数字。

共享材料替换的12个表：`trace_message_input`、`trace_source_input`、`trace_memory_input`、`trace_document_input`、`trace_feedback_input`、`assistant_context_snapshot`、`assistant_context_item`、`preference_version_source`、`organization_feedback_input`、`skill_learning_input`、`skill_review_input`、`overview_projection_member`。新增 material_set/material_reference 两表，净少10。学习批次若需要额外多对多成员表，须再加1；如由既有receipt保存单元set归属及batch顺序则不用另加。

### 审核目标可派生的事实

- backend-ts/src/skills/skill-learning-contract.ts:162–166：ReviewInput仅incoming_text/intent/scene，没有独立target输入。
- backend-ts/src/skills/skill-review-store.ts:295–310：先核draft targets，再复制到comparison目标快照。
- backend-ts/src/skills/skill-review-store.ts:188–199,416–440：复验comparison与当前draft修订一致并按该draft发布。
- backend-ts/src/skills/skill-review-store.ts:242–264：用户编辑改strategy/status、增加revision，不修改targets。

### 维护取舍

- **material_set共用**：purpose、owner/contact和授权时点不同，不能按正文hash自动跨用途复用；材料所属对象清理后要有合法引用/回收协议，不能造孤儿敏感payload。 共用schema和明确类型FK，不共用权限；同review两侧共享同set可，学习与助手原样跨purpose共用不可默认。
- **typed material_reference**：列多且大部分可空，需要每种类型完整非空/其余NULL、跨scope语义及反向partial indexes；CHECK/FK不等于来源语义获批。 保持有限已核定类型，业务接口校验purpose并在调用和提交再复验；不得对外暴露任意引用创建。
- **Skill操作合表**：原学习operation键带contact而其他动作是owner，幂等命名空间和FK需明确；单一revision会洗掉授权和政策变化。 先定义有限kind和稳定操作键合同，typed目标保留；不能仅把输入/结果塞通用JSON。
- **Skill祖先边**：方法祖先与逻辑Skill祖先有不同成员资格及遍历规则，少1表收益有限。 允许为可维护性保留两张，不应为了数字强合。
- **删除目标合表**：文件地址与数据库键都不是活业务FK，但预期身份/代次检查不同；任意地址JSON会变成危险执行接口。 有限预定义kind和严格address schema，受管根身份不降级，保留统一operation FK。
- **仍不能省的实体**：如继续追求显著低于80张，可能会混淆业务身份或遗漏现行能力。 表数不是硬指标；若要进一步缩小，需要明确功能范围选择或更多消费者证据，不应Agent静默砍学习、审核、政策和质量能力。

## 不应为表数混同的记录

- owner、channel_account、contact、conversation_binding：所有者、账号、真实联系人与渠道映射身份及生命周期不同。
- source_batch、source_record、message：有界捕获、原始出现与规范消息基数不同，去重和删除路径不同。
- memory_candidate、memory、memory_version：未裁决主张、稳定记忆身份与可引用版本不同，不能由正文相同合并。
- memory_version_evidence、memory_version_required_message：引用片段与正文成立必需消息是不同事实，前者多片段不能重复required标志。
- processing_input、processing_receipt、step_attempt、model_call：固定成员、完成事实、执行租约与物理外部调用不能用一个状态代替。
- memory、expression_preference、memory_document、reply_skill：事实、用户明确表达决定、派生概括与表达策略有不同来源和授权。
- skill_draft、skill_review、reply_skill_version：建议、冻结对照审核与已发布文件版不能互相冒充。
- deletion_operation、deletion_file_target：控制凭证与多目标状态有1:N及独立重试意义，不能随被删业务行消失。

## 新发现但不属于02—08既有清单

- manual_contact_confirmation：覆盖查证发现的真实遗漏，后续物理提案须加1；不回填成既有草案已经有的表。

## 证据与限制

- 逻辑表名清点不证明DDL可执行、功能完整、访问性能或真实CLI稳定身份。
- 3个conditional是当前明确写为暂保留/若需要的持久化项；删除它们仍需证据，不能直接当确定节省。
- 4个quality表是诊断能力候选，存储位置待决；run创建有_test/fixed_synthetic门禁，case冻结/读取/标注不能据此宣称全部在独立测试库。键概形尚未逐表定稿。
- 别名归并依据08公共文件目标；如最终决定保留专用物理子表，数量必须重新增加。
- 没有运行SQL、App、模型或真实资料读取；只写本任务两个被忽略的清点文件。
- 本清点的机器可读字段和来源SHA256见[table-inventory.json](table-inventory.json)。
