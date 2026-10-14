"""零提炼记忆时，经生产回复入口补查原文并复验来源的合成回归。"""

from datetime import datetime, timedelta, timezone
import unittest
from typing import Any, cast
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.reply import ReplyGenerator
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext, ReplyContextInvariantError
from notalone.reply.interface import ConfirmedDirection, DirectionSource, GenerateReply, ReplyToMessage
from notalone.reply.store import InMemoryReplyStore
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.skills import SkillPort
from tests.input_budget_support import synthetic_budget_kwargs
from tests.unit.reply.test_history_tools import EmptySkillPort, HistoryToolFakeModel


class SourceChangingModel(HistoryToolFakeModel):
    """只在模型端口模拟最后一次响应前来源消失，不替换生产检索和复验。"""

    retrieval_to_change: Any = None

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.i == 2 and self.retrieval_to_change is not None:
            self.retrieval_to_change.messages = self.retrieval_to_change.messages[:1]
        return super()._generate(messages, stop, run_manager, **kwargs)


class OriginalMessageFallbackTest(unittest.TestCase):
    def _run(self, *, remove_source: bool = False):
        scope = ContactScope(uuid4(), uuid4())
        binding_id, source_id = uuid4(), uuid4()
        current_id, old_id, qualifier_id = uuid4(), uuid4(), uuid4()
        base = datetime(2026, 9, 1, tzinfo=timezone.utc)
        retrieval = InMemoryRetrieval(messages=(
            RetrievedMessage(current_id, scope, "之前的看展安排怎么说的？", (source_id,),
                             occurred_at=base + timedelta(days=20), role="contact"),
            RetrievedMessage(old_id, scope, "准备周末去看展。", (source_id,),
                             occurred_at=base, role="contact"),
            RetrievedMessage(qualifier_id, scope, "只是打算，还没定。", (source_id,),
                             occurred_at=base + timedelta(minutes=1), role="contact"),
            RetrievedMessage(uuid4(), ContactScope(scope.owner_id, uuid4()),
                             "别人的看展安排已经确定。", (uuid4(),),
                             occurred_at=base, role="contact"),
        ))
        command = GenerateReply(
            idempotency_key=uuid4(), scope=scope, conversation_binding_id=binding_id,
            content=ReplyToMessage(current_id, ConfirmedDirection(
                "核实之前的安排，不替对方确认", DirectionSource.DIRECT_INPUT,
            )),
        )
        verified = VerifiedConversationScope(scope.owner_id, scope.contact_id, binding_id)
        context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0, message_limit=1)
        initial = context.build(command=command, verified_scope=verified)
        self.assertEqual([item.evidence_id for item in initial.evidence], [current_id])
        self.assertEqual(retrieval.search_confirmed_memories(scope=scope), ())
        self.assertEqual(retrieval.search_pending_candidates(scope=scope), ())

        def response(name, args):
            return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": name}])

        model = SourceChangingModel(responses=[
            response("conversation_search", {"query": "看展", "top_k": 5}),
            response("conversation_query", {"session_id": str(binding_id),
                     "anchor_message_id": str(old_id), "before": 0, "after": 1}),
            response("ReplyRuntimeOutput", {"candidates": [{
                "text": "之前说只是打算去看展，还没定，现在想去吗？",
                "basis": "原文中的计划及未确定限定。", "citation_ids": [str(old_id), str(qualifier_id)],
                "risk_notes": [],
            }], "used_skill_version_id": None}),
        ], retrieval_to_change=retrieval if remove_source else None)
        store = InMemoryReplyStore()
        result = ReplyGenerator(
            context=context, store=store,
            runtime=LangChainReplyRuntime(model=model, skill_port=cast(SkillPort, EmptySkillPort()),
                                         retrieval=retrieval, **synthetic_budget_kwargs(model)),
        ).generate(command, verified_scope=verified)
        stored = store.read(result.reply_request_id, scope)
        self.assertEqual(result.candidates[0].citation_ids, (old_id, qualifier_id))
        self.assertEqual({item.evidence_id for item in stored.evidence}, {current_id, old_id, qualifier_id})
        self.assertTrue(all(item.kind == "message" for item in stored.evidence))
        self.assertIn("只是打算，还没定。", [item.text for item in stored.evidence])

    def test_missing_memory_is_recovered_from_old_messages_with_context_and_citations(self):
        self._run()

    def test_source_disappearing_before_model_returns_rejects_recovered_evidence(self):
        with self.assertRaises(ReplyContextInvariantError):
            self._run(remove_source=True)


if __name__ == "__main__":
    unittest.main()
