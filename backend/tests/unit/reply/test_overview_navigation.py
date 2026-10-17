"""概览导航仍通过原检索接口取得回复实际依据。"""

from datetime import datetime, timezone
from dataclasses import replace
import unittest
from uuid import UUID

from notalone.memory import AdoptionMethod, ConfirmedMemoryStatus, InMemoryMemoryStore, MemoryCandidate, MemoryCategory, OwnerMemory, MemoryTopic
from notalone.memory.overview import OverviewEntry, OverviewMemoryIdentity, OverviewSourceReference, OverviewUnavailable, RelationshipOverview
from notalone.reply.context import ReplyContextInvariantError, RetrievalReplyContext
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.retrieval import InMemoryRetrieval, RetrievalError, RetrievedMessage, RetrievedOwnerMemory
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER = UUID("70000000-0000-0000-0000-000000000001")
CONTACT = UUID("70000000-0000-0000-0000-000000000002")
BINDING = UUID("70000000-0000-0000-0000-000000000003")
SOURCE = UUID("70000000-0000-0000-0000-000000000004")
SCOPE = ContactScope(OWNER, CONTACT)
VERIFIED = VerifiedConversationScope(OWNER, CONTACT, BINDING)
NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)


class OverviewFixture:
    """替换持久化边界；不运行数据库或生成器。"""

    def __init__(self, entries=()) -> None:
        self.contact = RelationshipOverview(SCOPE, "a" * 64, 1, NOW, tuple(entries))
        self.owner = RelationshipOverview(OWNER, "b" * 64, 0, NOW, ())

    def read_contact(self, scope):
        if scope != SCOPE:
            raise AssertionError("测试只能读取已验证联系人。")
        return self.contact

    def read_owner(self, owner_id):
        if owner_id != OWNER:
            raise AssertionError("测试只能读取已验证本人。")
        return self.owner


class OverviewNavigationTest(unittest.TestCase):
    def test_failed_original_window_is_unavailable_and_does_not_inject_or_claim_missing_history(self):
        class FailedOriginalWindow(InMemoryRetrieval):
            def query_messages(self, **kwargs):
                raise RetrievalError("合成原话窗口不可用。")

        message_id = UUID("75000000-0000-0000-0000-000000000012")
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000012"), SCOPE,
            "最近周末在加班", MemoryCategory.RECENT_STATE, (message_id,),
        ))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((OverviewEntry(memory, OverviewMemoryIdentity(memory.memory_id, 1), "source_supported", (
            OverviewSourceReference(SOURCE, "source_document", message_id,
                                    UUID("76000000-0000-0000-0000-000000000012")),
        )),))
        context = RetrievalReplyContext(retrieval=FailedOriginalWindow(memory_store=store), skill_library_revision=0,
            overview=overview).build(command=GenerateReply(UUID("72000000-0000-0000-0000-000000000012"),
                SCOPE, BINDING, RewriteDraft("周末加班", include_relationship_context=True)), verified_scope=VERIFIED)
        self.assertEqual(context.retrieval.status, "unavailable")
        self.assertEqual(context.retrieval.queries[-1].status, "failed")
        self.assertEqual(context.retrieval.queries[-1].evidence_ids, ())
        self.assertEqual(context.retrieval.source_messages.used_calls, 1)
        self.assertFalse(any(item.kind == "message" for item in context.evidence))

    def test_not_yet_valid_overview_item_leaves_the_reply_generic(self):
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000022"), SCOPE,
            "周末徒步", MemoryCategory.PREFERENCE, (SOURCE,),
            valid_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
        ))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                               adoption_method=AdoptionMethod.MANUAL)
        context = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=store), skill_library_revision=0,
            overview=OverviewFixture((OverviewEntry(memory, OverviewMemoryIdentity(memory.memory_id, 1), "manual_entry", ()),)),
        ).build(command=GenerateReply(UUID("72000000-0000-0000-0000-000000000022"), SCOPE, BINDING,
            RewriteDraft("周末徒步", include_relationship_context=True)), verified_scope=VERIFIED)
        self.assertEqual([item.kind for item in context.evidence], ["user_draft"])
        self.assertEqual(context.retrieval.status, "empty")

    def test_unconfirmed_budget_exhaustion_is_recorded_without_injecting_partial_claim(self):
        store = InMemoryMemoryStore()
        store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000033"), SCOPE,
            "周末徒步" * 80, MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        context = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=store),
            skill_library_revision=0, overview=OverviewFixture()).build(command=GenerateReply(
                UUID("72000000-0000-0000-0000-000000000033"), SCOPE, BINDING,
                RewriteDraft("周末徒步", include_relationship_context=True),
            ), verified_scope=VERIFIED)

        self.assertFalse(any(item.kind == "pending_candidate" for item in context.evidence))
        self.assertEqual(context.retrieval.status, "budget_exhausted")
        self.assertTrue(context.retrieval.pending_candidate.exhausted)
        self.assertEqual(context.retrieval.queries[-1].status, "budget_exceeded")

    def test_invalid_overview_revision_is_not_persisted_as_a_valid_retrieval_receipt(self):
        overview = OverviewFixture()
        overview.contact = replace(overview.contact, projection_revision="不能核验的旧投影")
        builder = RetrievalReplyContext(retrieval=InMemoryRetrieval(), skill_library_revision=0,
                                        overview=overview)
        with self.assertRaises(ReplyContextInvariantError):
            builder.build(command=GenerateReply(
                UUID("72000000-0000-0000-0000-000000000044"), SCOPE, BINDING,
                RewriteDraft("周末徒步", include_relationship_context=True),
            ), verified_scope=VERIFIED)

    def test_related_original_window_and_model_tools_share_the_same_call_budget(self):
        from json import loads
        from notalone.reply.tools import HistoryToolAccess

        message_id = UUID("75000000-0000-0000-0000-000000000001")
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000055"), SCOPE,
            "最近周末在加班", MemoryCategory.RECENT_STATE, (message_id,),
        ))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                               adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, 1), "source_supported", (
                OverviewSourceReference(SOURCE, "source_document", message_id,
                    UUID("76000000-0000-0000-0000-000000000001")),
            )),))
        retrieval = InMemoryRetrieval(memory_store=store, messages=(
            RetrievedMessage(message_id, SCOPE, "这阵子周末都在加班", (SOURCE,), NOW),
        ))
        context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0,
            overview=overview).build(command=GenerateReply(
                UUID("72000000-0000-0000-0000-000000000055"), SCOPE, BINDING,
                RewriteDraft("周末加班", include_relationship_context=True),
            ), verified_scope=VERIFIED)

        self.assertEqual([item.text for item in context.evidence if item.kind == "message"], ["这阵子周末都在加班"])
        self.assertEqual(context.retrieval.source_messages.used_calls, 1)
        tools = HistoryToolAccess(retrieval=retrieval, scope=SCOPE, conversation_binding_id=BINDING,
            initial_evidence_ids=tuple(item.evidence_id for item in context.evidence),
            prior_budget=context.retrieval.source_messages)
        self.assertEqual(loads(tools.search(query="完全无关甲"))["status"], "empty")
        self.assertEqual(loads(tools.search(query="完全无关乙"))["status"], "empty")
        self.assertEqual(loads(tools.search(query="完全无关丙"))["status"], "budget_exceeded")

    def test_historical_navigation_uses_the_actual_old_version_and_keeps_it_unverified(self):
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000066"), SCOPE,
            "去年在合成公司加班", MemoryCategory.RECENT_STATE, (SOURCE,),
        ))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                               adoption_method=AdoptionMethod.MANUAL)
        old = store.invalidate(scope=SCOPE, memory_id=memory.memory_id)
        overview = OverviewFixture((OverviewEntry(old, None, "source_supported", ()),))
        builder = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=store),
                                        skill_library_revision=0, overview=overview)
        context = builder.build(command=GenerateReply(
            UUID("72000000-0000-0000-0000-000000000066"), SCOPE, BINDING,
            RewriteDraft("去年加班", include_relationship_context=True),
        ), verified_scope=VERIFIED)
        history = [item for item in context.evidence if item.kind == "confirmed_memory"]

        self.assertEqual([(item.evidence_id, item.text, item.revision, item.status) for item in history],
                         [(old.memory_id, "去年在合成公司加班", 2, "invalidated")])
        self.assertEqual(history[0].timing.current_status, "historical")
        self.assertIn("不得当作当前事实", history[0].selection_reason)
        builder.validate_current(context)
        store.delete(scope=SCOPE, memory_id=old.memory_id)
        with self.assertRaises(ReplyContextInvariantError):
            builder.validate_current(context)

    def test_contact_budget_exhaustion_does_not_spend_owner_budget_or_claim_empty(self):
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000077"), SCOPE,
            "周末徒步" * 160, MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                               adoption_method=AdoptionMethod.MANUAL)
        owner = OwnerMemory(memory_id=UUID("71000000-0000-0000-0000-000000000078"), owner_id=OWNER,
            text="我喜欢周末徒步", category=MemoryCategory.PREFERENCE, topic=MemoryTopic.TRAVEL,
            source_ids=(OWNER,), adoption_method=AdoptionMethod.MANUAL, status=ConfirmedMemoryStatus.ACTIVE)
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, 1), "manual_entry", ()),))
        overview.owner = RelationshipOverview(OWNER, "b" * 64, 1, NOW, (
            OverviewEntry(owner, OverviewMemoryIdentity(owner.memory_id, 1), "manual_entry", ()),))
        builder = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=store, owner_memories=(
            RetrievedOwnerMemory(owner.memory_id, OWNER, owner.text, "preference", "travel", (OWNER,), "manual", 1),
        )), skill_library_revision=0, overview=overview)
        context = builder.build(command=GenerateReply(
            UUID("72000000-0000-0000-0000-000000000077"), SCOPE, BINDING,
            RewriteDraft("周末徒步", include_relationship_context=True),
        ), verified_scope=VERIFIED)

        self.assertEqual([item.text for item in context.evidence if item.kind == "owner_memory"], ["我喜欢周末徒步"])
        self.assertFalse(any(item.kind == "confirmed_memory" for item in context.evidence))
        receipt = context.retrieval.to_payload()
        self.assertEqual(receipt["status"], "budget_exhausted")
        self.assertEqual(receipt["budgets"]["contact_memory"],
                         {"limit": 5, "char_limit": 600, "used_count": 0, "used_chars": 0, "exhausted": True})
        self.assertEqual(receipt["budgets"]["owner_memory"]["used_chars"], 7)
        self.assertEqual(receipt["queries"][0]["status"], "budget_exceeded")

    def test_unavailable_overview_preserves_generic_reply_and_unknown_result(self):
        class UnavailableContact(OverviewFixture):
            def read_contact(self, scope):
                raise OverviewUnavailable("合成概览不可用。")

        builder = RetrievalReplyContext(retrieval=InMemoryRetrieval(), skill_library_revision=0,
                                        overview=UnavailableContact())
        context = builder.build(command=GenerateReply(
            UUID("72000000-0000-0000-0000-000000000088"), SCOPE, BINDING,
            RewriteDraft("周末徒步", include_relationship_context=True),
        ), verified_scope=VERIFIED)
        builder.validate_current(context)

        self.assertEqual([item.kind for item in context.evidence], ["user_draft"])
        receipt = context.retrieval.to_payload()
        self.assertEqual(receipt["status"], "unavailable")
        self.assertIsNone(receipt["overview_revisions"]["contact"])
        self.assertEqual(receipt["queries"][0]["status"], "failed")
        self.assertEqual(receipt["queries"][0]["evidence_ids"], [])

    def test_valid_projection_scope_cannot_hide_another_contact_memory(self):
        other_scope = ContactScope(OWNER, UUID("70000000-0000-0000-0000-000000000099"))
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000099"), other_scope,
            "喜欢周末徒步", MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        memory = store.confirm(scope=other_scope, candidate_id=candidate.candidate_id,
                               adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, memory.revision), "manual_entry", ()),))
        context = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=store),
                                        skill_library_revision=0, overview=overview)

        with self.assertRaises(ReplyContextInvariantError):
            context.build(command=GenerateReply(
                UUID("72000000-0000-0000-0000-000000000099"), SCOPE, BINDING,
                RewriteDraft("周末徒步", include_relationship_context=True),
            ), verified_scope=VERIFIED)

    def test_reply_navigates_only_known_overview_basis_to_authoritative_memory(self):
        store = InMemoryMemoryStore()
        known = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000001"), SCOPE,
            "喜欢周末徒步", MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        unknown = store.create_candidate(MemoryCandidate(
            UUID("71000000-0000-0000-0000-000000000002"), SCOPE,
            "喜欢徒步但旧来源证明未知", MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        known_memory = store.confirm(scope=SCOPE, candidate_id=known.candidate_id,
                                     adoption_method=AdoptionMethod.MANUAL)
        unknown_memory = store.confirm(scope=SCOPE, candidate_id=unknown.candidate_id,
                                       adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((
            OverviewEntry(known_memory, OverviewMemoryIdentity(known_memory.memory_id, 1), "manual_entry", ()),
            OverviewEntry(unknown_memory, OverviewMemoryIdentity(unknown_memory.memory_id, 1), "unknown", ()),
        ))
        context = RetrievalReplyContext(
            retrieval=InMemoryRetrieval(memory_store=store),
            skill_library_revision=0, overview=overview,
        ).build(command=GenerateReply(
            UUID("72000000-0000-0000-0000-000000000001"), SCOPE, BINDING,
            RewriteDraft("周末徒步", include_relationship_context=True),
        ), verified_scope=VERIFIED)

        memories = [item for item in context.evidence if item.kind == "confirmed_memory"]
        self.assertEqual([(item.evidence_id, item.text, item.source_ids) for item in memories],
                         [(known_memory.memory_id, "喜欢周末徒步", (SOURCE,))])
        self.assertEqual(context.retrieval.to_payload()["overview_revisions"]["contact"],
                         {"projection_revision": "a" * 64, "memory_revision": 1})
