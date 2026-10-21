"""回复依据读取失败必须可见：与「确实没有资料」区分，不静默降级。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory.layered import LayeredMemorySnapshot
from notalone.memory.overview import RelationshipOverview
from notalone.reply.adapters.in_memory_store import InMemoryReplyStore
from notalone.reply.context import ReplyContext, RetrievalReplyContext
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.layered_context import LayeredReplyBudget
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ValidatedReply
from notalone.scopes import ContactScope, OwnerScope, VerifiedConversationScope
from notalone.retrieval import InMemoryRetrieval


OWNER = UUID("60000000-0000-0000-0000-000000000001")
CONTACT = UUID("60000000-0000-0000-0000-000000000002")
BINDING = UUID("60000000-0000-0000-0000-000000000003")
REQUEST_KEY = UUID("60000000-0000-0000-0000-000000000004")
SCOPE = ContactScope(OWNER, CONTACT)
VERIFIED = VerifiedConversationScope(OWNER, CONTACT, BINDING)
NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)
BUDGET = LayeredReplyBudget(4, 4, 4000)
DRAFT_TEXT = "想约对方周末徒步。"


def _command() -> GenerateReply:
    return GenerateReply(
        REQUEST_KEY,
        SCOPE,
        BINDING,
        RewriteDraft(DRAFT_TEXT, include_relationship_context=True),
    )


def _empty_snapshot(scope: ContactScope | OwnerScope) -> LayeredMemorySnapshot:
    return LayeredMemorySnapshot(
        schema_version=3,
        scope=scope,
        settings_generation=1,
        organization_generation=1,
        scenarios=(),
        dependency_ids=(),
    )


class _FailingLayeredMemory:
    """只模拟读取边界失败，不产生真实资料。"""

    def __init__(self, *, fail_contact: bool = False, fail_owner: bool = False) -> None:
        self.fail_contact = fail_contact
        self.fail_owner = fail_owner

    def capture(self, scope):
        if isinstance(scope, OwnerScope) and self.fail_owner:
            raise RuntimeError("合成的本人分层资料读取失败。")
        if isinstance(scope, ContactScope) and self.fail_contact:
            raise RuntimeError("合成的联系人分层资料读取失败。")
        return _empty_snapshot(scope)


class _EmptyOverview:
    def read_contact(self, scope):
        if scope != SCOPE:
            raise AssertionError("测试只能读取已验证联系人。")
        return RelationshipOverview(SCOPE, "a" * 64, 0, NOW, ())

    def read_owner(self, owner_id):
        if owner_id != OWNER:
            raise AssertionError("测试只能读取已验证本人。")
        return RelationshipOverview(OWNER, "b" * 64, 0, NOW, ())


class _FailingOverview:
    def __init__(self, *, fail_contact: bool = True, fail_owner: bool = True) -> None:
        self.fail_contact = fail_contact
        self.fail_owner = fail_owner

    def read_contact(self, scope):
        if self.fail_contact:
            raise RuntimeError("合成的联系人概览读取失败。")
        return RelationshipOverview(SCOPE, "a" * 64, 0, NOW, ())

    def read_owner(self, owner_id):
        if self.fail_owner:
            raise RuntimeError("合成的本人概览读取失败。")
        return RelationshipOverview(OWNER, "b" * 64, 0, NOW, ())


class ReplyEvidenceDegradationTest(unittest.TestCase):
    def _build(
        self,
        *,
        layered_memory=None,
        overview=None,
        reply_request_id: UUID | None = None,
    ) -> ReplyContext:
        builder = RetrievalReplyContext(
            retrieval=InMemoryRetrieval(),
            skill_library_revision=0,
            overview=overview,
            layered_memory=layered_memory,
            layered_budget=BUDGET,
            owner_layered_budget=BUDGET,
        )
        return builder.build(
            command=_command(),
            verified_scope=VERIFIED,
            reply_request_id=reply_request_id,
        )

    def test_layered_capture_failure_is_read_failed_not_unavailable_no_material(self):
        with self.assertLogs("notalone.reply.context", level="WARNING") as logs:
            context = self._build(
                layered_memory=_FailingLayeredMemory(fail_contact=True),
            )

        self.assertEqual(context.layered_status, "unavailable")
        self.assertTrue(context.layered_read_failed)
        self.assertEqual(context.owner_layered_status, "unavailable")
        self.assertFalse(context.owner_layered_read_failed)
        messages = "\n".join(logs.output)
        self.assertIn("分层", messages)
        self.assertNotIn(DRAFT_TEXT, messages)

    def test_owner_layered_capture_failure_stays_scoped_to_owner_material(self):
        with self.assertLogs("notalone.reply.context", level="WARNING"):
            context = self._build(
                layered_memory=_FailingLayeredMemory(fail_owner=True),
            )

        self.assertFalse(context.layered_read_failed)
        self.assertEqual(context.layered_status, "unavailable")
        self.assertTrue(context.owner_layered_read_failed)
        self.assertEqual(context.owner_layered_status, "unavailable")

    def test_overview_read_failure_is_marked_and_logged(self):
        with self.assertLogs("notalone.reply.context", level="WARNING") as logs:
            context = self._build(overview=_FailingOverview())

        self.assertTrue(context.overview_read_failed)
        self.assertIsNotNone(context.retrieval)
        self.assertEqual(context.retrieval.status, "unavailable")
        self.assertEqual(
            tuple(query.status for query in context.retrieval.queries[:2]),
            ("failed", "failed"),
        )
        messages = "\n".join(logs.output)
        self.assertIn("概览", messages)
        self.assertNotIn(DRAFT_TEXT, messages)

    def test_empty_layered_and_overview_reads_keep_existing_semantics(self):
        with self.assertNoLogs("notalone.reply.context", level="WARNING"):
            context = self._build(
                layered_memory=_FailingLayeredMemory(),
                overview=_EmptyOverview(),
            )

        self.assertFalse(context.layered_read_failed)
        self.assertFalse(context.owner_layered_read_failed)
        self.assertFalse(context.overview_read_failed)
        self.assertEqual(context.layered_status, "unavailable")
        self.assertEqual(context.owner_layered_status, "unavailable")
        self.assertEqual(context.retrieval.status, "empty")

    def test_saved_result_context_receipt_exposes_read_failures(self):
        from notalone.reply.adapters.in_memory_store import InMemoryReplyStore

        store = InMemoryReplyStore()
        command = _command()
        started = store.start(command, VERIFIED)
        context = self._build(
            layered_memory=_FailingLayeredMemory(fail_contact=True, fail_owner=True),
            overview=_FailingOverview(),
            reply_request_id=started.request.request_id,
        )
        evidence_id = context.evidence[0].evidence_id
        reply = ValidatedReply(
            candidates=(
                RuntimeCandidate(
                    text="周末一起去徒步吗？",
                    basis="用户本次补全的草稿方向。",
                    citation_ids=(evidence_id,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )

        saved = store.save(started.request, context, reply)

        self.assertTrue(saved.context_receipt.layered_read_failed)
        self.assertTrue(saved.context_receipt.owner_layered_read_failed)
        self.assertTrue(saved.context_receipt.overview_read_failed)

    def test_context_receipt_read_failure_defaults_are_false(self):
        store = InMemoryReplyStore()
        command = _command()
        started = store.start(command, VERIFIED)
        context = self._build(reply_request_id=started.request.request_id)
        evidence_id = context.evidence[0].evidence_id
        reply = ValidatedReply(
            candidates=(
                RuntimeCandidate(
                    text="周末一起去徒步吗？",
                    basis="用户本次补全的草稿方向。",
                    citation_ids=(evidence_id,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )

        saved = store.save(started.request, context, reply)

        self.assertFalse(saved.context_receipt.layered_read_failed)
        self.assertFalse(saved.context_receipt.owner_layered_read_failed)
        self.assertFalse(saved.context_receipt.overview_read_failed)

    def test_postgres_marker_snapshot_keeps_read_failure_flags(self):
        from notalone.persistence.reply_store import _snapshot_flag

        snapshot = {
            "layered_read_failed": True,
            "owner_layered_read_failed": False,
            "overview_read_failed": True,
        }

        self.assertTrue(_snapshot_flag(snapshot, "layered_read_failed"))
        self.assertFalse(_snapshot_flag(snapshot, "owner_layered_read_failed"))
        self.assertTrue(_snapshot_flag(snapshot, "overview_read_failed"))
        self.assertFalse(_snapshot_flag({}, "layered_read_failed"))
        with self.assertRaises(Exception):
            _snapshot_flag({"overview_read_failed": "true"}, "overview_read_failed")


if __name__ == "__main__":
    unittest.main()
