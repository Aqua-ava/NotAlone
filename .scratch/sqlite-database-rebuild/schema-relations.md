# 全表关系索引

由[结构化目录](consolidated-schema.json)生成，与[主方案](greenfield-design.md)同版。媒体Q11已确认并整合。

共77张表、215条基础外键。相同表对的多条FK在图中合为一条箭头，实际列组及范围约束见主方案。箭头由父表指向引用子表；基数由唯一性与分支CHECK决定。蓝色为本组，灰色为跨组引用。

## 身份与来源

```mermaid
flowchart LR
  binding_verification["binding_verification"]:::local
  capture_record["capture_record"]:::local
  channel_account["channel_account"]:::local
  channel_conversation["channel_conversation"]:::local
  contact["contact"]:::local
  conversation_binding["conversation_binding"]:::local
  history_cutoff["history_cutoff"]:::local
  manual_confirmation["manual_confirmation"]:::local
  message["message"]:::local
  owner["owner"]:::local
  read_exclusion["read_exclusion"]:::local
  read_goal["read_goal"]:::local
  read_grant["read_grant"]:::local
  sync_capture["sync_capture"]:::local
  deletion_operation["deletion_operation"]:::external
  document_publication["document_publication"]:::external
  binding_verification --> read_grant
  channel_account --> channel_conversation
  channel_conversation --> conversation_binding
  channel_conversation --> history_cutoff
  channel_conversation --> read_exclusion
  contact --> capture_record
  contact --> conversation_binding
  contact --> manual_confirmation
  contact --> message
  contact --> read_goal
  contact --> read_grant
  contact --> sync_capture
  conversation_binding --> binding_verification
  conversation_binding --> message
  conversation_binding --> read_goal
  conversation_binding --> read_grant
  deletion_operation --> history_cutoff
  deletion_operation --> read_exclusion
  document_publication --> contact
  document_publication --> owner
  message --> capture_record
  owner --> channel_account
  owner --> contact
  read_goal --> sync_capture
  read_grant --> read_goal
  sync_capture --> capture_record
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 处理与调用

```mermaid
flowchart LR
  model_call["model_call"]:::local
  model_operation["model_operation"]:::local
  operation_item["operation_item"]:::local
  operation_scope["operation_scope"]:::local
  processing_item["processing_item"]:::local
  processing_run["processing_run"]:::local
  processing_step["processing_step"]:::local
  processing_task["processing_task"]:::local
  run_contact["run_contact"]:::local
  run_input["run_input"]:::local
  step_attempt["step_attempt"]:::local
  step_input["step_input"]:::local
  task_contribution["task_contribution"]:::local
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  document_publication["document_publication"]:::external
  memory_candidate["memory_candidate"]:::external
  memory_document_version["memory_document_version"]:::external
  memory_version["memory_version"]:::external
  message["message"]:::external
  organization_feedback["organization_feedback"]:::external
  owner["owner"]:::external
  quality_attempt["quality_attempt"]:::external
  quality_case["quality_case"]:::external
  quality_run["quality_run"]:::external
  read_grant["read_grant"]:::external
  reply_attempt["reply_attempt"]:::external
  reply_context["reply_context"]:::external
  reply_request["reply_request"]:::external
  capture_record --> run_input
  contact --> operation_scope
  contact --> processing_item
  contact --> processing_task
  contact --> run_contact
  contact --> run_input
  contact --> task_contribution
  document_publication --> processing_task
  memory_candidate --> step_input
  memory_document_version --> run_input
  memory_document_version --> step_input
  memory_version --> run_input
  memory_version --> step_input
  message --> processing_item
  message --> run_input
  model_operation --> model_call
  model_operation --> operation_item
  model_operation --> operation_scope
  organization_feedback --> run_input
  organization_feedback --> step_input
  owner --> processing_run
  processing_item --> operation_item
  processing_item --> run_input
  processing_run --> processing_task
  processing_run --> run_contact
  processing_run --> run_input
  processing_run --> task_contribution
  processing_step --> model_operation
  processing_step --> step_attempt
  processing_step --> step_input
  processing_task --> processing_step
  processing_task --> task_contribution
  quality_attempt --> model_call
  quality_case --> model_operation
  quality_run --> model_operation
  read_grant --> run_contact
  reply_attempt --> model_call
  reply_context --> model_call
  reply_request --> model_operation
  run_input --> step_input
  step_attempt --> model_call
  step_attempt --> processing_item
  step_attempt --> processing_step
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 实际追踪

```mermaid
flowchart LR
  event_source["event_source"]:::local
  execution_event["execution_event"]:::local
  execution_input["execution_input"]:::local
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  memory_candidate["memory_candidate"]:::external
  memory_document_version["memory_document_version"]:::external
  memory_version["memory_version"]:::external
  message["message"]:::external
  model_call["model_call"]:::external
  organization_feedback["organization_feedback"]:::external
  quality_attempt["quality_attempt"]:::external
  quality_case["quality_case"]:::external
  quality_case_input["quality_case_input"]:::external
  reply_attempt["reply_attempt"]:::external
  reply_context_item["reply_context_item"]:::external
  step_attempt["step_attempt"]:::external
  step_input["step_input"]:::external
  capture_record --> event_source
  capture_record --> execution_input
  contact --> event_source
  execution_event --> event_source
  execution_event --> execution_input
  memory_candidate --> execution_input
  memory_document_version --> execution_input
  memory_version --> execution_input
  message --> execution_input
  model_call --> execution_event
  organization_feedback --> execution_input
  quality_attempt --> execution_event
  quality_case --> execution_input
  quality_case_input --> execution_input
  reply_attempt --> execution_event
  reply_context_item --> execution_input
  step_attempt --> execution_event
  step_input --> execution_input
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 记忆与裁决

```mermaid
flowchart LR
  decision_candidate["decision_candidate"]:::local
  memory["memory"]:::local
  memory_candidate["memory_candidate"]:::local
  memory_citation["memory_citation"]:::local
  memory_decision["memory_decision"]:::local
  memory_required_message["memory_required_message"]:::local
  memory_version["memory_version"]:::local
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  message["message"]:::external
  owner["owner"]:::external
  quality_attempt["quality_attempt"]:::external
  step_attempt["step_attempt"]:::external
  capture_record --> memory_citation
  contact --> memory
  contact --> memory_candidate
  contact --> memory_required_message
  memory --> memory_decision
  memory --> memory_version
  memory_candidate --> decision_candidate
  memory_candidate --> memory_citation
  memory_candidate --> memory_required_message
  memory_decision --> decision_candidate
  memory_decision --> memory
  memory_decision --> memory_version
  memory_version --> memory
  memory_version --> memory_citation
  memory_version --> memory_decision
  memory_version --> memory_required_message
  memory_version --> memory_version
  message --> memory_citation
  message --> memory_required_message
  owner --> memory
  quality_attempt --> memory_decision
  step_attempt --> memory_candidate
  step_attempt --> memory_decision
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 助手与副本

```mermaid
flowchart LR
  assistant_discussion["assistant_discussion"]:::local
  discussion_entry["discussion_entry"]:::local
  reply_attempt["reply_attempt"]:::local
  reply_basis["reply_basis"]:::local
  reply_candidate["reply_candidate"]:::local
  reply_candidate_version["reply_candidate_version"]:::local
  reply_context["reply_context"]:::local
  reply_context_item["reply_context_item"]:::local
  reply_request["reply_request"]:::local
  reply_selection["reply_selection"]:::local
  reply_version_part["reply_version_part"]:::local
  runtime_context["runtime_context"]:::local
  runtime_copy["runtime_copy"]:::local
  binding_verification["binding_verification"]:::external
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  conversation_binding["conversation_binding"]:::external
  document_publication["document_publication"]:::external
  expression_preference_version["expression_preference_version"]:::external
  manual_confirmation["manual_confirmation"]:::external
  memory_candidate["memory_candidate"]:::external
  memory_document_version["memory_document_version"]:::external
  memory_version["memory_version"]:::external
  message["message"]:::external
  model_call["model_call"]:::external
  skill_package_revision["skill_package_revision"]:::external
  assistant_discussion --> discussion_entry
  assistant_discussion --> reply_context
  assistant_discussion --> reply_request
  assistant_discussion --> runtime_copy
  binding_verification --> reply_request
  capture_record --> reply_context_item
  contact --> assistant_discussion
  contact --> discussion_entry
  contact --> reply_context
  contact --> reply_request
  contact --> runtime_copy
  conversation_binding --> reply_request
  discussion_entry --> reply_context_item
  discussion_entry --> reply_request
  document_publication --> reply_context
  expression_preference_version --> reply_context_item
  manual_confirmation --> reply_request
  memory_candidate --> reply_context_item
  memory_document_version --> reply_context_item
  memory_version --> reply_context_item
  message --> reply_context_item
  model_call --> discussion_entry
  model_call --> reply_candidate_version
  reply_attempt --> reply_context
  reply_candidate --> reply_candidate_version
  reply_candidate_version --> reply_basis
  reply_candidate_version --> reply_candidate_version
  reply_candidate_version --> reply_context_item
  reply_candidate_version --> reply_selection
  reply_candidate_version --> reply_version_part
  reply_context --> reply_context_item
  reply_context --> runtime_context
  reply_context_item --> reply_basis
  reply_request --> discussion_entry
  reply_request --> reply_attempt
  reply_request --> reply_candidate
  reply_request --> reply_context
  reply_request --> reply_selection
  reply_request --> runtime_copy
  reply_selection --> reply_context_item
  reply_selection --> reply_request
  runtime_copy --> assistant_discussion
  runtime_copy --> runtime_context
  skill_package_revision --> reply_context_item
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 偏好与文档

```mermaid
flowchart LR
  document_basis["document_basis"]:::local
  document_block["document_block"]:::local
  document_publication["document_publication"]:::local
  document_statement["document_statement"]:::local
  expression_preference["expression_preference"]:::local
  expression_preference_version["expression_preference_version"]:::local
  memory_document["memory_document"]:::local
  memory_document_version["memory_document_version"]:::local
  preference_source["preference_source"]:::local
  publication_member["publication_member"]:::local
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  discussion_entry["discussion_entry"]:::external
  execution_input["execution_input"]:::external
  message["message"]:::external
  owner["owner"]:::external
  processing_run["processing_run"]:::external
  processing_task["processing_task"]:::external
  step_attempt["step_attempt"]:::external
  capture_record --> preference_source
  contact --> document_publication
  contact --> expression_preference_version
  contact --> memory_document
  discussion_entry --> preference_source
  document_block --> document_statement
  document_publication --> publication_member
  document_statement --> document_basis
  execution_input --> document_basis
  expression_preference --> expression_preference_version
  expression_preference_version --> expression_preference
  expression_preference_version --> expression_preference_version
  expression_preference_version --> preference_source
  memory_document --> memory_document_version
  memory_document_version --> document_block
  memory_document_version --> memory_document_version
  memory_document_version --> publication_member
  message --> preference_source
  owner --> document_publication
  owner --> expression_preference
  owner --> memory_document
  processing_run --> document_publication
  processing_task --> document_publication
  step_attempt --> memory_document_version
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## Skill最小关联

```mermaid
flowchart LR
  skill_package["skill_package"]:::local
  skill_package_revision["skill_package_revision"]:::local
  owner["owner"]:::external
  owner --> skill_package
  skill_package --> skill_package_revision
  skill_package_revision --> skill_package
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 删除与元数据

```mermaid
flowchart LR
  database_instance["database_instance"]:::local
  deletion_check["deletion_check"]:::local
  deletion_operation["deletion_operation"]:::local
  deletion_target["deletion_target"]:::local
  request_tombstone["request_tombstone"]:::local
  schema_migration["schema_migration"]:::local
  deletion_operation --> deletion_check
  deletion_operation --> deletion_target
  deletion_operation --> request_tombstone
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 纠错与诊断

```mermaid
flowchart LR
  feedback_input["feedback_input"]:::local
  organization_feedback["organization_feedback"]:::local
  quality_attempt["quality_attempt"]:::local
  quality_case["quality_case"]:::local
  quality_case_input["quality_case_input"]:::local
  quality_run["quality_run"]:::local
  capture_record["capture_record"]:::external
  contact["contact"]:::external
  document_block["document_block"]:::external
  memory_document_version["memory_document_version"]:::external
  memory_version["memory_version"]:::external
  message["message"]:::external
  owner["owner"]:::external
  capture_record --> feedback_input
  capture_record --> quality_case_input
  contact --> organization_feedback
  contact --> quality_case
  document_block --> organization_feedback
  memory_document_version --> quality_case_input
  memory_version --> feedback_input
  memory_version --> organization_feedback
  memory_version --> quality_case_input
  message --> feedback_input
  message --> quality_case_input
  organization_feedback --> feedback_input
  owner --> quality_run
  quality_attempt --> organization_feedback
  quality_case --> quality_attempt
  quality_case --> quality_case_input
  quality_run --> quality_attempt
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

## 媒体提取

```mermaid
flowchart LR
  media_extraction_attempt["media_extraction_attempt"]:::local
  media_file["media_file"]:::local
  message_media["message_media"]:::local
  binding_verification["binding_verification"]:::external
  capture_record["capture_record"]:::external
  message["message"]:::external
  read_grant["read_grant"]:::external
  binding_verification --> media_extraction_attempt
  capture_record --> media_extraction_attempt
  media_extraction_attempt --> media_file
  media_file --> media_extraction_attempt
  media_file --> media_file
  message --> message_media
  message_media --> media_extraction_attempt
  message_media --> media_file
  read_grant --> media_extraction_attempt
  classDef local fill:#e8f1ff,stroke:#245ca8,color:#172b4d;
  classDef external fill:#f2f3f5,stroke:#89919c,color:#333;
```

