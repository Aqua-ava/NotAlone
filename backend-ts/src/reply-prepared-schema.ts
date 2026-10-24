/** 从旧 prepared_context_codec v2/schema15 白名单值对象的实际注解生成；不自动补字段。 */
export const preparedSchema:Record<string,Record<string,any>> = {
 "ReplyContext": {
  "reply_request_id": "UUID",
  "scope": "ContactScope",
  "current_text": "str",
  "direction": {
   "union": [
    "ConfirmedDirection",
    "NoneType"
   ]
  },
  "evidence": {
   "tuple": "ContextEvidence"
  },
  "skill_library_revision": "int",
  "risk_notes": {
   "tuple": "str"
  },
  "memory_revision": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "index_revision": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "tool_calls": {
   "tuple": "ToolCallTrace"
  },
  "assistant_discussion": {
   "union": [
    "DiscussionContext",
    "NoneType"
   ]
  },
  "continuation_basis": {
   "union": [
    "ContinuedReplyCandidate",
    "NoneType"
   ]
  },
  "retrieval": {
   "union": [
    "ReplyRetrievalReceipt",
    "NoneType"
   ]
  },
  "layered_context": {
   "union": [
    "LayeredReplyMaterial",
    "NoneType"
   ]
  },
  "layered_status": "str",
  "layered_read_failed": "bool",
  "layered_scenario_reads": {
   "tuple": "dict"
  },
  "owner_layered_context": {
   "union": [
    "LayeredReplyMaterial",
    "NoneType"
   ]
  },
  "owner_layered_status": "str",
  "owner_layered_read_failed": "bool",
  "owner_layered_scenario_reads": {
   "tuple": "dict"
  },
  "overview_read_failed": "bool",
  "expression_preferences": {
   "tuple": "ExpressionPreference"
  },
  "expression_preference_revision": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "history_message_ids": {
   "union": [
    {
     "tuple": "UUID"
    },
    "NoneType"
   ]
  }
 },
 "LayeredMemorySnapshot": {
  "schema_version": "int",
  "scope": {
   "union": [
    "ContactScope",
    "OwnerScope"
   ]
  },
  "settings_generation": "int",
  "organization_generation": "int",
  "scenarios": {
   "tuple": "ScenarioDirectoryEntry"
  },
  "dependency_ids": {
   "tuple": "UUID"
  },
  "profile_version_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "profile_entries": {
   "tuple": "dict"
  },
  "quality_receipt": {
   "union": [
    "str",
    "NoneType"
   ]
  }
 },
 "ScenarioDirectoryEntry": {
  "scenario_id": "UUID",
  "version_id": "UUID",
  "title": "str",
  "hint": "str",
  "paragraph_count": "int"
 },
 "LayeredReplyMaterial": {
  "snapshot": "LayeredMemorySnapshot",
  "payload_json": "str"
 },
 "MemoryTiming": {
  "recorded_at": {
   "union": [
    "datetime",
    "NoneType"
   ]
  },
  "source_started_at": {
   "union": [
    "datetime",
    "NoneType"
   ]
  },
  "source_ended_at": {
   "union": [
    "datetime",
    "NoneType"
   ]
  },
  "source_time_complete": "bool",
  "current_status": "str",
  "current_status_reason": "str"
 },
 "DiscussionContext": {
  "scope": "ContactScope",
  "session_id": "UUID",
  "request_key": "UUID",
  "current_input_version_id": "UUID",
  "items": {
   "tuple": "DiscussionItem"
  },
  "snapshot": "DiscussionSnapshot",
  "notice": "str"
 },
 "DiscussionItem": {
  "kind": {
   "literal": [
    "discussion_input",
    "generation_input",
    "candidate_version",
    "candidate_carry"
   ]
  },
  "text": "str",
  "input_version_id": "UUID",
  "turn_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "reply_request_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "candidate_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "version_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "parent_version_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "candidate_number": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "version_number": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "is_default_display": "bool",
  "is_explicitly_selected": "bool",
  "basis_changes": {
   "tuple": "ReplyBasisChange"
  }
 },
 "DiscussionSnapshot": {
  "scope": "ContactScope",
  "session_id": "UUID",
  "request_key": "UUID",
  "current_input_version_id": "UUID",
  "current_turn_id": "UUID",
  "current_payload_sha256": "str",
  "records": {
   "tuple": "DiscussionIdentity"
  },
  "basis_revision_sha256": {
   "union": [
    "str",
    "NoneType"
   ]
  }
 },
 "DiscussionIdentity": {
  "kind": {
   "literal": [
    "discussion_input",
    "generation_input",
    "candidate_version",
    "candidate_carry"
   ]
  },
  "input_version_id": "UUID",
  "payload_sha256": "str",
  "turn_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "candidate_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "version_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  }
 },
 "ContextEvidence": {
  "evidence_id": "UUID",
  "kind": {
   "literal": [
    "message",
    "confirmed_memory",
    "owner_memory",
    "user_draft",
    "user_current_chat",
    "user_purpose",
    "continued_candidate",
    "pending_candidate"
   ]
  },
  "text": "str",
  "scope": "ContactScope",
  "source_ids": {
   "tuple": "UUID"
  },
  "selection_reason": "str",
  "status": "str",
  "valid_at": {
   "union": [
    "datetime",
    "NoneType"
   ]
  },
  "invalid_at": {
   "union": [
    "datetime",
    "NoneType"
   ]
  },
  "revision": {
   "union": [
    "int",
    "NoneType"
   ]
  },
  "timing": "MemoryTiming",
  "model_visible": "bool",
  "navigation": {
   "union": [
    "MemoryNavigation",
    "NoneType"
   ]
  },
  "event": {
   "union": [
    "MemoryEvent",
    "NoneType"
   ]
  },
  "conditions": {
   "union": [
    "MemoryConditions",
    "NoneType"
   ]
  },
  "evolution": {
   "union": [
    "MemoryEvolution",
    "NoneType"
   ]
  },
  "speaker_role": {
   "literal": [
    "owner",
    "contact",
    "system",
    "unknown"
   ]
  }
 },
 "ToolCallTrace": {
  "tool_name": "str",
  "status": {
   "literal": [
    "succeeded",
    "empty",
    "failed",
    "timeout",
    "budget_exceeded"
   ]
  },
  "evidence_ids": {
   "tuple": "UUID"
  },
  "latency_ms": {
   "union": [
    "int",
    "NoneType"
   ]
  }
 },
 "ConfirmedDirection": {
  "text": "str",
  "source": "DirectionSource",
  "suggestion": {
   "union": [
    "SuggestionReference",
    "NoneType"
   ]
  }
 },
 "SuggestionReference": {
  "task_id": "UUID",
  "input_version": {
   "union": [
    "UUID",
    "int"
   ]
  },
  "suggestion_id": "UUID"
 },
 "ContactScope": {
  "owner_id": "UUID",
  "contact_id": "UUID"
 },
 "OwnerScope": {
  "owner_id": "UUID",
  "contact_id": "NoneType"
 },
 "ContinuedReplyCandidate": {
  "candidate_id": "UUID",
  "scope": "ContactScope",
  "conversation_binding_id": "UUID",
  "text": "str",
  "basis_changes": {
   "tuple": "ReplyBasisChange"
  },
  "basis_revision_sha256": {
   "union": [
    "str",
    "NoneType"
   ]
  }
 },
 "ReplyBasisChange": {
  "evidence_id": "UUID",
  "kind": {
   "literal": [
    "confirmed_memory",
    "owner_memory",
    "pending_candidate",
    "reply_skill"
   ]
  },
  "reason": {
   "literal": [
    "memory_revised",
    "memory_expired",
    "memory_not_yet_valid",
    "memory_time_changed",
    "memory_generation_forbidden",
    "skill_policy_changed"
   ]
  }
 },
 "ExpressionPreferenceScope": {
  "owner_id": "UUID",
  "contact_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "reply_mode": {
   "union": [
    {
     "literal": [
      "reply_to_message",
      "rewrite_draft",
      "initiate_conversation"
     ]
    },
    "NoneType"
   ]
  }
 },
 "ExpressionPreference": {
  "preference_id": "UUID",
  "scope": "ExpressionPreferenceScope",
  "text": "str",
  "revision": "int",
  "confirmed_operation_key": "UUID",
  "origin_kind": "str",
  "origin_id": {
   "union": [
    "UUID",
    "NoneType"
   ]
  },
  "source_ids": {
   "tuple": "UUID"
  },
  "confirmed_at": "datetime",
  "updated_at": "datetime"
 },
 "MemoryNavigation": {
  "scope_kind": {
   "literal": [
    "contact",
    "owner"
   ]
  },
  "projection_revision": "str",
  "memory_id": "UUID",
  "memory_revision": "int",
  "provenance_kind": {
   "literal": [
    "manual_entry",
    "source_supported"
   ]
  },
  "source_message_ids": {
   "tuple": "UUID"
  },
  "dependency_ids": {
   "tuple": "UUID"
  }
 },
 "OverviewRevision": {
  "projection_revision": "str",
  "memory_revision": "int"
 },
 "ReplyRetrievalReceipt": {
  "contact_overview": {
   "union": [
    "OverviewRevision",
    "NoneType"
   ]
  },
  "owner_overview": {
   "union": [
    "OverviewRevision",
    "NoneType"
   ]
  },
  "queries": {
   "tuple": "RetrievalQuery"
  },
  "contact_memory": "RetrievalBudget",
  "owner_memory": "RetrievalBudget",
  "pending_candidate": "RetrievalBudget",
  "source_messages": "SourceMessageBudget",
  "status": {
   "literal": [
    "succeeded",
    "empty",
    "budget_exhausted",
    "unavailable"
   ]
  }
 },
 "RetrievalQuery": {
  "kind": {
   "literal": [
    "confirmed_memory",
    "owner_memory",
    "pending_candidate",
    "message"
   ]
  },
  "purpose": {
   "literal": [
    "recall",
    "source_window"
   ]
  },
  "status": {
   "literal": [
    "succeeded",
    "empty",
    "budget_exceeded",
    "failed"
   ]
  },
  "evidence_ids": {
   "tuple": "UUID"
  },
  "limit": "int"
 },
 "RetrievalBudget": {
  "limit": "int",
  "char_limit": "int",
  "used_count": "int",
  "used_chars": "int",
  "exhausted": "bool"
 },
 "SourceMessageBudget": {
  "call_limit": "int",
  "item_limit": "int",
  "token_limit": "int",
  "used_calls": "int",
  "used_count": "int",
  "used_tokens": "int",
  "exhausted": "bool"
 }
};
