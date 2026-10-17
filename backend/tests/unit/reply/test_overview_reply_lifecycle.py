"""新候选提交前复验概览，失败重试沿原请求重新读取。"""

from dataclasses import replace
import unittest
from uuid import UUID

from notalone.memory import AdoptionMethod, InMemoryMemoryStore, MemoryCandidate, MemoryCategory
from notalone.memory.overview import OverviewEntry, OverviewMemoryIdentity
from notalone.reply.context import ReplyContextInvariantError, RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.runtime import ReplyRuntimeResult, RuntimeCandidate
from notalone.reply.store import InMemoryReplyStore, ReplyAttemptState
from notalone.retrieval import InMemoryRetrieval
from tests.unit.reply.test_overview_navigation import (
    BINDING, SOURCE, SCOPE, VERIFIED, OverviewFixture,
)


class ControlledRuntime:
    def __init__(self, after_read=None):
        self.after_read = after_read

    def generate(self, context):
        if self.after_read:
            self.after_read()
        return ReplyRuntimeResult((RuntimeCandidate(
            "周末一起徒步怎么样？", "沿用户草稿及合法依据改写。",
            (context.evidence[0].evidence_id,), (),
        ),), None)


class OverviewReplyLifecycleTest(unittest.TestCase):
    def test_changed_overview_during_generation_rejects_result_and_same_request_can_retry(self):
        memories = InMemoryMemoryStore()
        candidate = memories.create_candidate(MemoryCandidate(
            UUID("73000000-0000-0000-0000-000000000001"), SCOPE,
            "喜欢周末徒步", MemoryCategory.PREFERENCE, (SOURCE,),
        ))
        memory = memories.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                                  adoption_method=AdoptionMethod.MANUAL)
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, memory.revision), "manual_entry", ()),))
        context = RetrievalReplyContext(retrieval=InMemoryRetrieval(memory_store=memories),
                                        skill_library_revision=0, overview=overview)
        store = InMemoryReplyStore()
        command = GenerateReply(UUID("74000000-0000-0000-0000-000000000001"), SCOPE, BINDING,
                                RewriteDraft("周末徒步", include_relationship_context=True))
        runtime = ControlledRuntime(lambda: setattr(overview, "contact",
            replace(overview.contact, projection_revision="c" * 64, memory_revision=2)))
        generator = ReplyGenerator(store=store, runtime=runtime, context=context)

        with self.assertRaises(ReplyContextInvariantError):
            generator.generate(command, verified_scope=VERIFIED)
        started = store.start(command, VERIFIED)
        failed_request_id = started.request.request_id
        self.assertEqual(started.request.attempt, 2)
        store.fail(started.request, reason="synthetic_retry_preparation")
        runtime.after_read = None
        result = generator.generate(command, verified_scope=VERIFIED)
        self.assertEqual(result.reply_request_id, failed_request_id)
        self.assertEqual(store.read(result.reply_request_id, SCOPE).state, ReplyAttemptState.COMPLETED)
        self.assertEqual(generator.generate(command, verified_scope=VERIFIED), result)
