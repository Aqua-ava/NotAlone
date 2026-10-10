"""生成领取前核验实际探索选择及来源，复用A同事务当前输入。"""

from dataclasses import replace
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.application.assistant_session_service import AssistantSessionRejected
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.exploration import ExplorationInput
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import ConfirmedDirection, DirectionSource, InitiateConversation, ReplyToMessage, SuggestionReference
from notalone.scopes import VerifiedConversationScope
from tests.integration.persistence import test_reply_exploration as component


class ExploredGenerationPersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        component.ReplyExplorationPersistenceTest.setUpClass()

    def setUp(self):
        self.component = component.ReplyExplorationPersistenceTest()
        self.component.setUp()
        self.addCleanup(self.component.doCleanups)
        self.fixture = self.component.fixture
        self.scope, self.session_id = self.component.scope, self.component.session_id
        self.a_store = PostgresAssistantSessionStore(component.fixture.DATABASE_URL)

    def _selected(self, scene="reply_to_message", *, declarations=None):
        source, message = self.fixture._source("合成邀请：想谈谈近况。")
        content = ExplorationInput(scene, target_message_id=UUID(message) if scene == "reply_to_message" else None,
                                   purpose_hint="想了解近况" if scene == "initiate_conversation" else "",
                                   correction="只谈合成近况。", requirements="保持简短。", skill_mode="disabled")
        if declarations:
            content = replace(content, **declarations)
        current = self.component._current()
        task = self.component._select(self.component._ready(replace(
            self.component.request, content=content, operation_key=uuid4(),
            expected_input_version_id=UUID(current) if current else None,
        )))
        intent = ConfirmedDirection(task.selected_intent, task.selection_source)
        declarations = {"understanding_correction": content.correction, "user_instruction": content.requirements,
                        "clarification_answer": content.answer or None}
        selected = (ReplyToMessage(content.target_message_id, intent, **declarations)
                    if scene == "reply_to_message" else InitiateConversation(intent, **declarations))
        request = ReplyServiceRequest(task.request_key, selected, skill_disabled=True,
                                      suggestion=SuggestionReference(task.exploration_id, task.input_version_id, task.selection_id),
                                      expected_input_version_id=task.input_version_id)
        return task, request, UUID(source), UUID(message)

    def _turn(self, turn_id):
        with psycopg.connect(component.fixture.DATABASE_URL) as connection:
            return connection.execute(
                "SELECT input_version_id,input_payload,dependency_ids,state FROM public.assistant_session_turn WHERE id=%s",
                (turn_id,),
            ).fetchone()

    def _generation_count(self):
        with psycopg.connect(component.fixture.DATABASE_URL) as connection:
            return connection.execute(
                "SELECT count(*) FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s",
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()[0]

    def test_both_scenes_reserve_uuid_reference_once_with_canonical_projection_and_root_dependencies(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                task, request, source, message = self._selected(scene)
                turn_id = self.a_store.reserve(self.scope, self.session_id, request)
                version, payload, dependencies, _ = self._turn(turn_id)
                self.assertNotEqual(version, task.input_version_id)
                self.assertTrue({source, message} <= set(dependencies))
                self.assertEqual(payload["content"]["suggestion"]["input_version"], str(task.input_version_id))
                self.assertEqual(payload["content"]["understanding_correction"], task.content.correction)
                self.assertEqual(payload["content"]["user_instruction"], task.content.requirements)
                self.assertEqual(self.a_store.reserve(self.scope, self.session_id, request), turn_id)
                self.assertEqual(self.component._current(), str(version))
                self.assertEqual(self._generation_count(), 1 if scene == "reply_to_message" else 2)

    def test_deleted_root_is_rejected_before_any_generation_input_or_derived_body_is_saved(self):
        task, request, source, _ = self._selected()
        self.fixture._delete_source(str(source))
        with self.assertRaises(AssistantSessionRejected):
            self.a_store.reserve(self.scope, self.session_id, request)
        self.assertEqual(self._generation_count(), 0)
        with psycopg.connect(component.fixture.DATABASE_URL) as connection:
            row = connection.execute("SELECT state,input_payload,selected_intent FROM public.reply_exploration WHERE id=%s",
                                     (task.exploration_id,)).fetchone()
        self.assertEqual(row, ("redacted", None, None))

    def test_expired_reserve_rejects_and_commits_exploration_body_erasure_after_a_transaction_exits(self):
        task, request, _, _ = self._selected()
        with psycopg.connect(component.fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.reply_exploration SET root_created_at=clock_timestamp()-interval '16 minutes' WHERE id=%s",
                               (task.exploration_id,))
        with self.assertRaises(AssistantSessionRejected):
            self.a_store.reserve(self.scope, self.session_id, request)
        self.assertEqual(self._generation_count(), 0)
        with psycopg.connect(component.fixture.DATABASE_URL) as connection:
            row = connection.execute("SELECT state,input_payload,result_payload,selected_intent FROM public.reply_exploration WHERE id=%s",
                                     (task.exploration_id,)).fetchone()
        self.assertEqual(row, ("expired", None, None, None))

    def test_changed_selection_or_user_fields_or_skill_cannot_create_a_generation_turn(self):
        task, request, _, _ = self._selected()
        alternatives = [
            replace(request, content=replace(request.content, direction=ConfirmedDirection("替换意愿", request.content.direction.source))),
            replace(request, content=replace(request.content, understanding_correction="另一纠正")),
            replace(request, content=replace(request.content, user_instruction="另一要求")),
            replace(request, content=replace(request.content, clarification_answer="伪造答案")),
            replace(request, suggestion=replace(request.suggestion, suggestion_id=uuid4())),
            replace(request, skill_disabled=False),
        ]
        for changed in alternatives:
            with self.subTest(content=type(changed.content).__name__):
                with self.assertRaises(AssistantSessionRejected):
                    self.a_store.reserve(self.scope, self.session_id, changed)
        self.assertEqual(self._generation_count(), 0)
        self.assertEqual(self.component._current(), str(task.input_version_id))

    def test_captured_root_deletion_after_reserve_erases_running_a_generation(self):
        task, request, source, _ = self._selected("initiate_conversation")
        turn_id = self.a_store.reserve(self.scope, self.session_id, request)
        self.fixture._delete_source(str(source))
        _, payload, dependencies, state = self._turn(turn_id)
        self.assertEqual((payload, dependencies, state), (None, [], "redacted"))
        with self.assertRaises(AssistantSessionRejected):
            self.a_store.reserve(self.scope, self.session_id, request)

    def test_old_generation_retry_never_advances_or_restores_intent_after_new_discussion_input(self):
        task, request, _, _ = self._selected()
        turn_id = self.a_store.reserve(self.scope, self.session_id, request)
        version = self._turn(turn_id)[0]
        newer = self.component.inputs.record_discussion_input(
            self.scope, self.session_id, {"type": "purpose_exploration", "purpose_hint": "新任务意愿"}, version,
        )
        with self.assertRaises(AssistantSessionRejected):
            self.a_store.reserve(self.scope, self.session_id, request)
        self.assertEqual(self.component._current(), str(newer))
        self.assertEqual(self._generation_count(), 1)

    def test_once_only_declarations_use_consistent_whitespace_normalization(self):
        _, request, _, _ = self._selected(declarations={
            "correction": " 合成纠正 ", "requirements": " 合成要求 ", "answer": " 合成答案 ",
        })
        turn = self._turn(self.a_store.reserve(self.scope, self.session_id, request))
        self.assertEqual(turn[1]["content"]["understanding_correction"], "合成纠正")
        self.assertEqual(turn[1]["content"]["user_instruction"], "合成要求")
        self.assertEqual(turn[1]["content"]["clarification_answer"], "合成答案")

    def test_completed_candidate_replay_keeps_history_after_new_input_expiry_and_skill_change(self):
        task, request, _, message = self._selected()
        turn_id = self.a_store.reserve(self.scope, self.session_id, request)
        self.fixture.model.responses = [self.fixture._candidate(str(message))]
        database_url = component.fixture.DATABASE_URL
        retrieval = PostgresRetrieval(database_url)
        generator = ReplyGenerator(store=PostgresReplyStore(database_url),
                                   context=RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0),
                                   runtime=LangChainReplyRuntime(model=self.fixture.model, retrieval=retrieval,
                                                                skill_port=PostgresSkillPort(database_url)))
        command = request.build_command(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                        binding_id=self.fixture.binding.binding_id)
        reply = generator.generate(command, verified_scope=VerifiedConversationScope(
            self.scope.owner_id, self.scope.contact_id, self.fixture.binding.binding_id,
        ))
        completed = self.a_store.complete(self.scope, self.session_id, turn_id, reply)
        self.assertEqual(completed.state, "completed")
        newer = self.component.inputs.record_discussion_input(
            self.scope, self.session_id, {"type": "purpose_exploration", "purpose_hint": "新任务意愿"},
            completed.input_version_id,
        )
        with psycopg.connect(database_url) as connection:
            connection.execute("UPDATE public.reply_exploration SET root_created_at=clock_timestamp()-interval '16 minutes' WHERE id=%s",
                               (task.exploration_id,))
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.scope.owner_id,))
        self.assertEqual(self.a_store.reserve(self.scope, self.session_id, request), turn_id)
        self.assertEqual(self.component._current(), str(newer))
        self.assertEqual(self._generation_count(), 1)
        self.assertEqual(len(self.fixture.model.seen_calls), 1)
