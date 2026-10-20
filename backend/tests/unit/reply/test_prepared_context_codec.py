"""固定准备格式的公开往返与明确拒绝合同。"""

import copy
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4
from typing import get_args, get_type_hints

from notalone.reply.context import ContinuedReplyCandidate, ReplyContext
from notalone.reply.interface import ReplyBasisChange
from notalone.reply.assistant_discussion import DiscussionContext, DiscussionSnapshot, DiscussionItem
from notalone.scopes import ContactScope

from notalone.memory.timing import MemoryTiming
from notalone.memory.events import MemoryEvent, EventStage, EventEvidence
from notalone.reply.prepared_context_codec import decode_context, encode_context
from tests.unit.reply.test_input_budget_runtime import prepared_context


class PreparedContextCodecTest(unittest.TestCase):
    def test_history_authorized_preparation_requires_an_explicit_frozen_id_set(self):
        original = prepared_context()
        command = replace(original.command,
                          content=replace(original.command.content, include_relationship_context=True))
        original = replace(original, command=command, history_message_ids=None)
        with self.assertRaises(ValueError):
            decode_context(encode_context(original), command)
        empty = replace(original, history_message_ids=())
        self.assertEqual(decode_context(encode_context(empty), command), empty)

    def test_current_format_preserves_temporal_state_and_frozen_history(self):
        original = prepared_context()
        timing = MemoryTiming(
            recorded_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            current_status="historical", current_status_reason="合成资料只证明过去。",
        )
        event = MemoryEvent(stage=EventStage.PLANNED,
            stage_evidence=(EventEvidence(original.evidence[0].evidence_id, 0, 2),), stage_verified=True,
            occurrence_start=datetime(2020, 1, 1, tzinfo=timezone.utc))
        original = replace(original, evidence=(replace(original.evidence[0], timing=timing, event=event),),
                           history_message_ids=(original.evidence[0].evidence_id,))

        payload = encode_context(original)

        self.assertEqual((payload["version"], payload.get("schema_revision")), (2, 12))
        self.assertEqual(decode_context(payload, original.command), original)

    def test_old_revision_unknown_fields_and_damaged_values_require_reprepare(self):
        original = prepared_context()
        payload = encode_context(original)
        variants = [
            {"version": 1, "context": payload["context"]},
            {**payload, "schema_revision": 0},
            {**payload, "schema_revision": 1},
            {**payload, "schema_revision": 3},
            {**payload, "schema_revision": 2},
            {**payload, "schema_revision": 4},
            {**payload, "schema_revision": 5},
            {**payload, "schema_revision": 6},
            {**payload, "schema_revision": 8},
            {**payload, "schema_revision": 9},
            {**payload, "schema_revision": 10},
            {**payload, "schema_revision": 11},
            {**payload, "schema_revision": True},
            {**payload, "context": {**payload["context"], "future_field": None}},
            {**payload, "context": None},
        ]
        damaged = copy.deepcopy(payload)
        damaged["context"]["evidence"][0]["fields"]["timing"]["fields"]["current_status"] = "invented"
        variants.append(damaged)
        for invalid in variants:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    decode_context(invalid, original.command)

    def test_frozen_historical_candidate_and_discussion_changes_round_trip_without_substitution(self):
        original = prepared_context()
        candidate, session, current_input, current_turn = uuid4(), uuid4(), uuid4(), uuid4()
        command = replace(original.command, continued_from_candidate_id=candidate)
        change = ReplyBasisChange(original.evidence[0].evidence_id, "confirmed_memory", "memory_revised")
        snapshot = DiscussionSnapshot(original.scope, session, command.idempotency_key,
            current_input, current_turn, "1" * 64, (), "2" * 64)
        discussion = DiscussionContext(original.scope, session, command.idempotency_key, current_input,
            (DiscussionItem("candidate_carry", "用户选定的编辑", uuid4(), basis_changes=(change,)),), snapshot)
        original = replace(original, command=command,
            continuation_basis=ContinuedReplyCandidate(candidate, original.scope,
                command.conversation_binding_id, "旧候选正文", (change,), "3" * 64),
            assistant_discussion=discussion)
        payload = encode_context(original)
        self.assertEqual(decode_context(payload, command), original)
        invalid = copy.deepcopy(payload)
        del invalid["context"]["continuation_basis"]["fields"]["basis_changes"]
        with self.assertRaises(ValueError):
            decode_context(invalid, command)
        for changed in (replace(command, continued_from_candidate_id=uuid4()),
                        replace(command, conversation_binding_id=uuid4()),
                        replace(command, idempotency_key=uuid4()),
                        replace(command, scope=ContactScope(uuid4(), uuid4()))):
            with self.subTest(command=changed):
                with self.assertRaises(ValueError):
                    decode_context(payload, changed)
        malformed = copy.deepcopy(payload)
        malformed["context"]["continuation_basis"]["fields"]["basis_changes"][0]["fields"]["reason"] = "deleted_body"
        with self.assertRaises(ValueError):
            decode_context(malformed, command)

    def test_skill_policy_change_round_trips_in_continued_and_carried_basis_with_strict_fields(self):
        original = prepared_context()
        candidate, session, current_input, current_turn = uuid4(), uuid4(), uuid4(), uuid4()
        command = replace(original.command, continued_from_candidate_id=candidate)
        change = ReplyBasisChange(uuid4(), "reply_skill", "skill_policy_changed")
        snapshot = DiscussionSnapshot(original.scope, session, command.idempotency_key,
            current_input, current_turn, "1" * 64, (), "2" * 64)
        discussion = DiscussionContext(original.scope, session, command.idempotency_key, current_input,
            (DiscussionItem("candidate_carry", "保留合成用户编辑。", uuid4(), basis_changes=(change,)),), snapshot)
        original = replace(original, command=command,
            continuation_basis=ContinuedReplyCandidate(candidate, original.scope,
                command.conversation_binding_id, "合成旧候选。", (change,), "3" * 64),
            assistant_discussion=discussion)
        payload = encode_context(original)
        self.assertEqual((payload["version"], payload["schema_revision"]), (2, 12))
        self.assertEqual(decode_context(payload, command), original)
        with self.assertRaises(ValueError):
            decode_context({**payload, "schema_revision": 6}, command)
        for location in ("continuation_basis", "assistant_discussion"):
            for field, value in (("kind", "unknown_skill"), ("reason", "unknown_policy"),
                                 ("kind", True), ("evidence_id", str(change.evidence_id)),
                                 ("evidence_id", {"uuid": "unknown"}), ("future_field", None)):
                invalid = copy.deepcopy(payload)
                branch = invalid["context"][location]["fields"]
                if location == "assistant_discussion":
                    branch = branch["items"][0]["fields"]
                branch["basis_changes"][0]["fields"][field] = value
                with self.subTest(location=location, field=field, value=value), self.assertRaises(ValueError):
                    decode_context(invalid, command)
            invalid = copy.deepcopy(payload)
            branch = invalid["context"][location]["fields"]
            if location == "assistant_discussion":
                branch = branch["items"][0]["fields"]
            del branch["basis_changes"][0]["fields"]["reason"]
            with self.subTest(location=location, field="missing reason"), self.assertRaises(ValueError):
                decode_context(invalid, command)

    def test_explicit_preference_round_trip_preserves_origin_and_rejects_forged_scope(self):
        from notalone.application.expression_preference_service import ExpressionPreference, ExpressionPreferenceScope
        self.assertEqual(get_args(get_type_hints(ReplyContext)["expression_preferences"]),
                         (ExpressionPreference, Ellipsis))
        original = prepared_context()
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)
        origin = uuid4()
        preference = ExpressionPreference(uuid4(), ExpressionPreferenceScope(original.scope.owner_id,
            original.scope.contact_id, "rewrite_draft"), "长期保存的合成要求。", 1, uuid4(),
            "message", origin, (origin, uuid4()), now, now)
        original = replace(original, expression_preferences=(preference,), expression_preference_revision=3)
        payload = encode_context(original)
        self.assertEqual(decode_context(payload, original.command), original)
        for field, value in (("origin_kind", "unknown"), ("source_ids", []),
                             ("confirmed_operation_key", None), ("revision", 0)):
            invalid = copy.deepcopy(payload)
            invalid["context"]["expression_preferences"][0]["fields"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                decode_context(invalid, original.command)

    def test_frozen_navigation_receipt_survives_restart_and_rejects_false_bindings(self):
        from notalone.reply.retrieval_receipt import (MemoryNavigation, OverviewRevision,
            ReplyRetrievalReceipt, RetrievalBudget, RetrievalQuery, SourceMessageBudget)
        original = prepared_context()
        identifier, source = uuid4(), uuid4()
        item = replace(original.evidence[0], evidence_id=identifier, kind="confirmed_memory",
            text="合成茶偏好", source_ids=(source,), revision=1,
            navigation=MemoryNavigation("contact", "a" * 64, identifier, 1,
                "source_supported", (source,), (source,)))
        receipt = ReplyRetrievalReceipt(OverviewRevision("a" * 64, 1), None,
            (RetrievalQuery("confirmed_memory", "recall", "succeeded", (identifier,), 6),),
            RetrievalBudget(6, 6000, 1, 5), RetrievalBudget(6, 6000, 0, 0),
            RetrievalBudget(3, 3000, 0, 0), SourceMessageBudget())
        original = replace(original, evidence=(item,), retrieval=receipt, history_message_ids=(source,))
        payload = encode_context(original)
        self.assertEqual(decode_context(payload, original.command), original)
        variants = []
        for field, value in (("memory_revision", True), ("projection_revision", "b" * 64),
                             ("scope_kind", "owner")):
            damaged = copy.deepcopy(payload)
            damaged["context"]["evidence"][0]["fields"]["navigation"]["fields"][field] = value
            variants.append(damaged)
        damaged = copy.deepcopy(payload)
        del damaged["context"]["evidence"][0]["fields"]["navigation"]["fields"]["dependency_ids"]
        variants.append(damaged)
        damaged = copy.deepcopy(payload)
        damaged["context"]["retrieval"]["fields"]["queries"][0]["fields"]["evidence_ids"] = [{"uuid": str(uuid4())}]
        variants.append(damaged)
        for invalid in variants:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    decode_context(invalid, original.command)
