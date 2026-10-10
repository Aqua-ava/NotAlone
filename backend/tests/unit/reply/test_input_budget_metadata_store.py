"""生成器与实际内存存储保留可信回执；重放不重新调用模型。"""

from __future__ import annotations

import unittest

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.store import InMemoryReplyStore
from notalone.retrieval import InMemoryRetrieval
from notalone.scopes import VerifiedConversationScope
from tests.integration.server.core_business_flow_support import ScriptedCoreModel
from tests.unit.reply.test_input_budget_runtime import (
    BINDING_ID,
    EVIDENCE_ID,
    SCOPE,
    prepared_context,
)
from tests.unit.reply.test_input_budget_runtime_limits import runtime_fixture
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


class InputBudgetMetadataStoreTest(unittest.TestCase):
    def test_generator_and_store_replay_the_receipt_under_unknown_new_configuration(self):
        store = InMemoryReplyStore()
        context = RetrievalReplyContext(
            retrieval=InMemoryRetrieval(), skill_library_revision=0,
            id_factory=lambda: EVIDENCE_ID,
        )
        command = prepared_context().command
        scope = VerifiedConversationScope(SCOPE.owner_id, SCOPE.contact_id, BINDING_ID)
        runtime, model, _, decisions = runtime_fixture()
        generator = ReplyGenerator(store=store, runtime=runtime, context=context)

        generated = generator.generate(command, verified_scope=scope)

        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(generated.input_budget, decisions[-1])
        unknown_model = ScriptedCoreModel()
        unknown_runtime = LangChainReplyRuntime(
            model=unknown_model, skill_port=EmptySkillPort(SCOPE, 0),
        )
        rebuilt = ReplyGenerator(store=store, runtime=unknown_runtime, context=context)

        replayed = rebuilt.generate(command, verified_scope=scope)

        self.assertEqual(replayed, generated)
        self.assertEqual(unknown_model.seen_calls, [])
        self.assertEqual(unknown_model.seen_model_payloads, [])


if __name__ == "__main__":
    unittest.main()
