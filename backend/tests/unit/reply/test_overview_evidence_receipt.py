"""回复依据读取保存生成时检索回执，旧记录不从当前概览补造。"""

import unittest
from uuid import UUID

from notalone.application.reply_evidence import ReplyEvidenceService
from notalone.memory import AdoptionMethod, InMemoryMemoryStore, MemoryCandidate, MemoryCategory
from notalone.memory.overview import OverviewEntry, OverviewMemoryIdentity
from notalone.reply.context import ContextEvidence, RetrievalReplyContext, ToolCallTrace
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.store import InMemoryReplyStore
from notalone.reply.runtime import ReplyRuntimeResult, RuntimeCandidate
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from tests.unit.reply.test_overview_navigation import BINDING, SOURCE, SCOPE, VERIFIED, OverviewFixture
from tests.unit.reply.test_overview_reply_lifecycle import ControlledRuntime


class OverviewEvidenceReceiptTest(unittest.TestCase):
    def test_final_receipt_includes_actual_model_tool_evidence_and_estimated_budget(self):
        message = RetrievedMessage(UUID("79000000-0000-0000-0000-000000000001"), SCOPE,
                                   "合成原话", (SOURCE,))
        class RuntimeWithHistory:
            def generate(self, context):
                evidence = ContextEvidence(message.message_id, "message", message.text, SCOPE, (SOURCE,))
                return ReplyRuntimeResult((RuntimeCandidate("合成回复", "本次补查原话。", (message.message_id,), ()),),
                    None, additional_evidence=(evidence,), tool_calls=(
                        ToolCallTrace("conversation_search", "succeeded", (message.message_id,)),))
        store = InMemoryReplyStore()
        generated = ReplyGenerator(store=store, runtime=RuntimeWithHistory(), context=RetrievalReplyContext(
            retrieval=InMemoryRetrieval(messages=(message,)), skill_library_revision=0, overview=OverviewFixture(),
        )).generate(GenerateReply(UUID("78000000-0000-0000-0000-000000000002"), SCOPE, BINDING,
            RewriteDraft("合成问候", include_relationship_context=True)), verified_scope=VERIFIED)

        result = ReplyEvidenceService(store).read(generated.reply_request_id, SCOPE)
        budget = result["retrieval"]["budgets"]["source_messages"]
        self.assertEqual((budget["used_calls"], budget["used_count"], budget["used_tokens"]), (1, 1, 1))
        self.assertEqual(result["retrieval"]["status"], "succeeded")
        self.assertEqual(result["retrieval"]["queries"][-1]["evidence_ids"], [str(message.message_id)])

    def test_completed_reply_preserves_its_navigation_and_retrieval_receipt(self):
        memories = InMemoryMemoryStore()
        candidate = memories.create_candidate(MemoryCandidate(
            UUID("77000000-0000-0000-0000-000000000001"), SCOPE,
            "喜欢周末徒步", MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        memory = memories.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                                  adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, 1), "manual_entry", ()),))
        store = InMemoryReplyStore()
        context = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=memories),
                                        skill_library_revision=0, overview=overview)
        generated = ReplyGenerator(store=store, runtime=ControlledRuntime(), context=context).generate(
            GenerateReply(UUID("78000000-0000-0000-0000-000000000001"), SCOPE, BINDING,
                          RewriteDraft("周末徒步", include_relationship_context=True)), verified_scope=VERIFIED)

        result = ReplyEvidenceService(store).read(generated.reply_request_id, SCOPE)
        self.assertEqual(result["retrieval"]["overview_revisions"]["contact"],
                         {"projection_revision": "a" * 64, "memory_revision": 1})
        saved = next(item for item in result["evidence"] if item["kind"] == "confirmed_memory")
        self.assertEqual(saved["text"], "喜欢周末徒步")
        self.assertFalse(saved["cited"])
        self.assertEqual(saved["navigation"], {"scope_kind": "contact", "projection_revision": "a" * 64,
            "memory_id": str(memory.memory_id), "memory_revision": 1, "provenance_kind": "manual_entry"})
