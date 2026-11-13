# 历史物理候选清单（未获认可）

94表推荐已撤回，Q43暂缓。以下仅保留上一轮推导对照，当前入口为[按需求逐表审查](requirements-table-rationale.md)。旧PG仅查漏，不能要求照搬全部旧能力。

当前逻辑草案107项（100业务、3条件、4诊断），覆盖审计另补3个真实身份／操作／封存记录，再计2个数据库元数据。用途内收敛为100表；共享有类型材料清单方案为94表。

| 历史候选分类（未批准） | 数量 |
| --- | ---: |
| business | 86 |
| conditional | 2 |
| diagnostic | 4 |
| metadata | 2 |
| total | 94 |

字段类型、FK分支、索引、用途隔离、运行时和切换门禁见[物理设计方案](physical-schema-plan.md)。原始清点见[逻辑清单](table-inventory.md)，旧表覆盖见[物理覆盖矩阵](physical-coverage.md)。

## 处理与调用（13）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 1 | `background_task` | 归属固定的一份有限工作 | owner_id, task_id | business；[05](issues/05-processing-task-model.md) |
| 2 | `background_task_step` | 有独立恢复价值的步骤 | owner_id, task_id, step_no | business；[05](issues/05-processing-task-model.md) |
| 3 | `model_call` | 一次物理模型调用无正文账目 | owner_id, call_id | business；[05](issues/05-processing-task-model.md) |
| 4 | `model_call_execution` | 一次物理调用唯一对应的step/assistant/quality真实执行及调用槽 | owner_id,call_id | business；10／本文物理合并 |
| 5 | `model_request` | 一次稳定逻辑模型操作 | owner_id, request_id | business；[05](issues/05-processing-task-model.md) |
| 6 | `processing_input` | 点击时固定的可用消息成员 | owner_id, run_id, scope_id, message_id | business；[05](issues/05-processing-task-model.md) |
| 7 | `processing_operation` | 一次start/pause/resume等处理控制动作的幂等回执 | owner_id,operation_key | business；10／本文物理合并 |
| 8 | `processing_receipt` | 某条消息跨轮处理或未知隔离结果 | owner_id, contact_id, message_id | business；[05](issues/05-processing-task-model.md) |
| 9 | `processing_round` | 本次启动在一个范围上的固定分支 | owner_id, run_id, scope_id | business；[05](issues/05-processing-task-model.md) |
| 10 | `processing_run` | 一次用户手动启动 | owner_id, run_id | business；[05](issues/05-processing-task-model.md) |
| 11 | `processing_scope` | 跨轮稳定的本人或联系人控制范围 | owner_id, scope_id | business；[05](issues/05-processing-task-model.md) |
| 12 | `step_attempt` | 步骤一次真实领取执行及租约历史 | owner_id, task_id, step_no, attempt_no | business；[05](issues/05-processing-task-model.md) |
| 13 | `step_attempt_guard` | 本次执行需要复验的硬范围门禁 | owner_id, task_id, step_no, attempt_no, guard_scope_id | business；[05](issues/05-processing-task-model.md) |

## 读取及删除（10）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 14 | `account_sync_control` | 账号读取开关及开关代次 | owner_id, account_id | business；[08](issues/08-deletion-consistency.md) |
| 15 | `contact_data_control` | 联系人硬数据代次及局部来源修订 | owner_id, contact_id | business；[08](issues/08-deletion-consistency.md) |
| 16 | `conversation_clear_boundary` | 覆盖尚未读历史的稳定会话分界凭据 | owner_id, boundary_id | business；[08](issues/08-deletion-consistency.md) |
| 17 | `conversation_read_grant` | 绑定上的一次独立读取授权 | owner_id, grant_id | business；[08](issues/08-deletion-consistency.md) |
| 18 | `deletion_operation` | 独立于被删对象的持久删除请求 | operation_id | business；[08](issues/08-deletion-consistency.md) |
| 19 | `deletion_target` | 删除操作中一个具有明确存储类型及预期身份的清理目标 | operation_id,target_no | business；10／本文物理合并 |
| 20 | `deletion_verification` | 一个计划修订的分面复核结果 | operation_id, check_kind | business；[08](issues/08-deletion-consistency.md) |
| 21 | `history_restore_authorization` | 单联系人显式历史恢复的新资格 | owner_id, restore_id | business；[08](issues/08-deletion-consistency.md) |
| 22 | `read_exclusion` | 一个会话、消息或捕获身份的最小读取排除 | owner_id,exclusion_id | business；10／本文物理合并 |
| 23 | `sync_checkpoint` | 某授权代次和读取episode的进度与覆盖 | owner_id, grant_id, data_generation, stream_episode_id | business；[08](issues/08-deletion-consistency.md) |

## 共用材料（2）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 24 | `material_reference` | 材料清单中的一个有类型、有真实FK的来源或具体版本 | owner_id,material_set_id,item_no | business；10／本文物理合并 |
| 25 | `material_set` | 某一明确用途、时点及业务归属的不可变材料清单/快照 | owner_id,material_set_id | business；10／本文物理合并 |

## 集合与表达偏好（4）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 26 | `expression_preference` | 一条用户明确长期偏好身份 | owner_id, preference_id | business；[07](issues/07-preference-document-skill-model.md) |
| 27 | `expression_preference_operation` | 偏好保存修改删除的幂等操作 | owner_id, operation_key | business；[07](issues/07-preference-document-skill-model.md) |
| 28 | `expression_preference_version` | 偏好正文及适用范围的具体版本 | owner_id, preference_id, version_no | business；[07](issues/07-preference-document-skill-model.md) |
| 29 | `owner_collection_state` | 用户三个独立集合的单调修订 | owner_id | business；[07](issues/07-preference-document-skill-model.md) |

## 记忆及证据（9）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 30 | `claim_evidence` | 候选或已采纳记忆版本的一处真实消息片段 | owner_id,evidence_id | business；10／本文物理合并 |
| 31 | `claim_required_message` | 一个主张成立必须存在的一条消息 | owner_id,requirement_id | business；10／本文物理合并 |
| 32 | `memory` | 一条稳定记忆身份及当前版本指针 | owner_id, memory_id | business；[04](issues/04-memory-evidence-model.md) |
| 33 | `memory_candidate` | 一次待裁决记忆主张 | owner_id, candidate_id | business；[04](issues/04-memory-evidence-model.md) |
| 34 | `memory_decision` | 采纳拒绝修正恢复删除的操作事实 | owner_id, decision_id | business；[04](issues/04-memory-evidence-model.md) |
| 35 | `memory_trace` | 一次有界处理过程及正文生命周期 | owner_id, trace_id | business；[04](issues/04-memory-evidence-model.md) |
| 36 | `memory_trace_event` | 处理阶段事件及完整敏感载荷 | owner_id, trace_id, event_no | business；[04](issues/04-memory-evidence-model.md) |
| 37 | `memory_version` | 记忆的具体内容及依据版本 | owner_id, memory_id, version_no | business；[04](issues/04-memory-evidence-model.md) |
| 38 | `memory_version_parent` | 两个具体记忆版本间的来历边 | owner_id, child_memory_id, child_version_no, parent_memory_id, parent_version_no | business；[04](issues/04-memory-evidence-model.md) |

## 派生文档与投影（10）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 39 | `document_block` | 文档版本内一个有类型的内容块 | owner_id, document_id, version_no, block_no | business；[07](issues/07-preference-document-skill-model.md) |
| 40 | `document_block_reference` | 文档块对实际版本输入的引用 | owner_id, document_id, version_no, block_no, reference_no | business；[07](issues/07-preference-document-skill-model.md) |
| 41 | `document_collection` | 同一本人或联系人范围的文档集合 | owner_id, collection_id | business；[07](issues/07-preference-document-skill-model.md) |
| 42 | `document_publication` | 同范围一次一致文档发布集合 | owner_id, collection_id, publication_no | business；[07](issues/07-preference-document-skill-model.md) |
| 43 | `document_publication_member` | 发布集合内一篇文档选用的一版 | owner_id, collection_id, publication_no, document_id | business；[07](issues/07-preference-document-skill-model.md) |
| 44 | `document_version_parent` | 文档版本延续合并拆分来历边 | owner_id, child_document_id, child_version_no, parent_document_id, parent_version_no | business；[07](issues/07-preference-document-skill-model.md) |
| 45 | `memory_document` | 一个稳定主题或画像身份 | owner_id, document_id | business；[07](issues/07-preference-document-skill-model.md) |
| 46 | `memory_document_version` | 文档一个具体内容版本 | owner_id, document_id, version_no | business；[07](issues/07-preference-document-skill-model.md) |
| 47 | `organization_feedback` | 针对具体文档块或记忆版本的有限纠错反馈 | owner_id, feedback_id | business；[07](issues/07-preference-document-skill-model.md) |
| 48 | `scope_projection` | 同范围某一类型导航/概览投影的当前元数据 | owner_id,projection_id | conditional；10／本文物理合并 |

## 身份（5）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 49 | `channel_account` | 已核验渠道账号身份 | owner_id, account_id | business；[02](issues/02-contact-identity-model.md) |
| 50 | `contact` | 属于用户的一位联系人 | owner_id, contact_id | business；[02](issues/02-contact-identity-model.md) |
| 51 | `conversation_binding` | 已核验渠道会话到联系人的稳定映射 | owner_id, binding_id | business；[02](issues/02-contact-identity-model.md) |
| 52 | `manual_contact_confirmation` | 一次用户明确手动联系人确认，不授予微信读取资格 | owner_id,confirmation_id | business；10／本文物理合并 |
| 53 | `owner` | 本机资料所有者身份 | owner_id | business；[02](issues/02-contact-identity-model.md) |

## 数据库元数据（2）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 54 | `database_instance` | 数据库实例UUID、用途和格式身份 | singleton_key=1 | metadata；10／本文物理合并 |
| 55 | `schema_migration` | 新SQLite结构的一次已提交版本及校验和 | migration_no | metadata；10／本文物理合并 |

## 消息来源（3）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 56 | `message` | 可靠核验后的规范消息及非文字占位 | owner_id, contact_id, message_id | business；[03](issues/03-message-source-model.md) |
| 57 | `source_batch` | 一次有界CLI捕获页 | owner_id, contact_id, batch_id | business；[03](issues/03-message-source-model.md) |
| 58 | `source_record` | 捕获页中的一次原始出现 | owner_id, contact_id, record_id | business；[03](issues/03-message-source-model.md) |

## 诊断能力（位置待决）（4）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 59 | `quality_attempt` | 诊断案例一次真实调用及审阅 | owner_id, attempt_id〔键概形建议，run/case/call为外键〕 | diagnostic；[07](issues/07-preference-document-skill-model.md) |
| 60 | `quality_case` | 冻结诊断输入及人工标注 | owner_id, case_id〔键概形建议，run_id为外键〕 | diagnostic；[07](issues/07-preference-document-skill-model.md) |
| 61 | `quality_fact_intent` | 精确纠错目标与有限质量案例衔接 | owner_id, intent_id〔键概形建议，现稿未逐表定键〕 | diagnostic；[07](issues/07-preference-document-skill-model.md) |
| 62 | `quality_run` | 合成用途运行门禁下的一次质量数据集运行 | owner_id, run_id〔键概形建议，现稿未逐表定键〕 | diagnostic；[07](issues/07-preference-document-skill-model.md) |

## 助手与候选（12）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 63 | `assistant_attempt` | 助手短请求的一次实际执行 | owner_id, contact_id, session_id, turn_id, attempt_no | business；[06](issues/06-assistant-history-model.md) |
| 64 | `assistant_request_tombstone` | 已删除或中断回复请求的最小封存键 | owner_id,contact_id,request_key | business；10／本文物理合并 |
| 65 | `assistant_runtime_context` | 运行副本实际纳入的上下文 | owner_id, contact_id, session_id, runtime_id, context_id | business；[06](issues/06-assistant-history-model.md) |
| 66 | `assistant_runtime_instance` | 业务会话的一个DSH运行副本 | owner_id, contact_id, session_id, runtime_id | business；[06](issues/06-assistant-history-model.md) |
| 67 | `assistant_selection` | 用户一次显式选择具体候选版本 | owner_id, contact_id, session_id, selection_no | business；[06](issues/06-assistant-history-model.md) |
| 68 | `assistant_session` | 联系人下的一段业务讨论 | owner_id, contact_id, session_id | business；[06](issues/06-assistant-history-model.md) |
| 69 | `assistant_turn` | 一次明确提交输入及逻辑请求 | owner_id, contact_id, session_id, turn_id | business；[06](issues/06-assistant-history-model.md) |
| 70 | `candidate_version_citation` | 某版候选的具体显示依据定位 | owner_id, contact_id, session_id, candidate_id, version_no, citation_no | business；[06](issues/06-assistant-history-model.md) |
| 71 | `reply_candidate` | 生成的一个稳定回复候选身份 | owner_id, contact_id, session_id, candidate_id | business；[06](issues/06-assistant-history-model.md) |
| 72 | `reply_candidate_segment` | 候选内稳定的消息段身份与顺序 | owner_id, contact_id, session_id, candidate_id, segment_id | business；[06](issues/06-assistant-history-model.md) |
| 73 | `reply_candidate_version` | 回复候选的原稿或编辑版本 | owner_id, contact_id, session_id, candidate_id, version_no | business；[06](issues/06-assistant-history-model.md) |
| 74 | `reply_candidate_version_message` | 某版本某段的正文 | owner_id, contact_id, session_id, candidate_id, version_no, segment_id | business；[06](issues/06-assistant-history-model.md) |

## Skill及审核（20）

| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |
| ---: | --- | --- | --- | --- |
| 75 | `reply_method` | 回复方法的稳定身份 | owner_id, method_id | business；[07](issues/07-preference-document-skill-model.md) |
| 76 | `reply_skill` | Skill稳定身份及业务目录状态 | owner_id, skill_id | business；[07](issues/07-preference-document-skill-model.md) |
| 77 | `reply_skill_version` | 不可变Skill文件版本锚点及发布来历 | owner_id, skill_id, version_no | business；[07](issues/07-preference-document-skill-model.md) |
| 78 | `skill_draft` | 待审核策略草稿稳定身份 | owner_id, contact_id, draft_id | business；[07](issues/07-preference-document-skill-model.md) |
| 79 | `skill_draft_target` | 草稿修订明确针对的Skill版本 | owner_id, contact_id, draft_id, revision, target_skill_id, target_version_no | business；[07](issues/07-preference-document-skill-model.md) |
| 80 | `skill_draft_version` | 草稿一个修订的清洗策略及私人依据 | owner_id, contact_id, draft_id, revision | business；[07](issues/07-preference-document-skill-model.md) |
| 81 | `skill_learning_batch` | 一份有限授权学习批次及结果 | owner_id, contact_id, batch_id | business；[07](issues/07-preference-document-skill-model.md) |
| 82 | `skill_learning_receipt` | 实际材料预约及成功消费结果 | owner_id, contact_id, material_key | business；[07](issues/07-preference-document-skill-model.md) |
| 83 | `skill_learning_scope` | 单联系人独立学习授权 | owner_id, contact_id | business；[07](issues/07-preference-document-skill-model.md) |
| 84 | `skill_method_parent` | 方法延续或替代祖先边 | owner_id, child_method_id, parent_method_id | business；[07](issues/07-preference-document-skill-model.md) |
| 85 | `skill_operation` | 一次明确的Skill目录、政策或学习授权动作及幂等结果 | owner_id,operation_key | business；10／本文物理合并 |
| 86 | `skill_parent` | Skill合并或延续祖先边 | owner_id, child_skill_id, parent_skill_id | business；[07](issues/07-preference-document-skill-model.md) |
| 87 | `skill_review` | 冻结输入和草稿修订的业务对照审核 | owner_id, contact_id, review_id | business；[07](issues/07-preference-document-skill-model.md) |
| 88 | `skill_review_result_call` | 审核结果消费的真实物理调用链 | owner_id, contact_id, review_id, side, call_id | business；[07](issues/07-preference-document-skill-model.md) |
| 89 | `skill_review_side` | 审核一侧实际策略及执行结果 | owner_id, contact_id, review_id, side | business；[07](issues/07-preference-document-skill-model.md) |
| 90 | `skill_scope_policy` | Skill或方法在明确范围的停用决定 | owner_id, policy_id | business；[07](issues/07-preference-document-skill-model.md) |
| 91 | `skill_use` | 实际Skill版本及政策视图使用事实 | owner_id, use_id | business；[07](issues/07-preference-document-skill-model.md) |
| 92 | `skill_use_method` | 实际使用视图中的具体版本方法成员 | owner_id, use_id, method_id | business；[07](issues/07-preference-document-skill-model.md) |
| 93 | `skill_version_method` | 某Skill版本的方法成员及顺序 | owner_id, skill_id, version_no, method_id | business；[07](issues/07-preference-document-skill-model.md) |
| 94 | `skill_worktree_projection` | 可恢复的非权威Skill工作目录回写 | owner_id, operation_key, skill_id | conditional；[07](issues/07-preference-document-skill-model.md) |

## 计数约束

- 94包括86基础业务、2项暂保留的条件投影、4项诊断能力、2项数据库元数据；不是94类产品功能。
- 4项诊断没有擅自搬出业务库；同schema的隔离测试实例另设角色门禁，真实case仍按敏感数据清理。
- 新增手动确认、处理控制回执及子回复封存键来自旧功能覆盖，不能为减表省略。
- 学习材料单元由既有receipt真实引用material_set并保留batch/ordinal归属；若改成独立membership实现，需要再加表重算。
- 不合并Skill与方法祖先两张图；不靠预期缓存性能删除暂保留项。
- 清单与主外键概形不是已执行的全量DDL，Q43选择、各类型完整约束及接口改造尚待后续。
