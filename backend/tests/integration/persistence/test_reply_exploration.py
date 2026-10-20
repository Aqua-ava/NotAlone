"""B探索与A输入同事务的真实PG组件回归；公开HTTP另有验收。"""

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.reply_exploration import PostgresExplorationStore
from notalone.database_migrations import migrate
from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.exploration import ExplorationInput, ExplorationError, ExplorationStale
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.reply.exploration_skill import select_exploration_skill
from notalone.reply.exploration_task import ExplorationOpen, ExplorationReadPurpose
from notalone.reply.interface import DirectionSource
from notalone.scopes import ContactScope
from tests.integration.server import test_assistant_session_api as fixture
from tests.integration.persistence import test_assistant_session_input_upgrade as upgrade_fixture


def result(question=None):
    return {"understanding": "合成目的有两种可选意愿。", "ambiguities": [], "citation_ids": [],
            "options": [{"intent": "了解近况", "label": "了解近况", "reason": "适用于了解近况时。",
                         "citation_ids": [], "recommended": False, "pause": False},
                        {"intent": "暂不联系", "label": "暂不联系", "reason": "适用于暂不联系时。",
                         "citation_ids": [], "recommended": False, "pause": True}],
            "question": question, "current_step": "先明确意愿。", "tradeoffs": []}


class ReplyExplorationPersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.AssistantSessionHttpTest.setUpClass()

    def setUp(self):
        self.fixture = fixture.AssistantSessionHttpTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.scope = ContactScope(self.fixture.owner_id, self.fixture.contact_id)
        status, session = self.fixture._default()
        self.assertEqual(status, 200, session)
        self.session_id = UUID(session["session_id"])
        self.evidence = ExplorationEvidence(PostgresRetrieval(fixture.DATABASE_URL))
        self.skills = PostgresSkillPort(fixture.DATABASE_URL)
        self.store = PostgresExplorationStore(fixture.DATABASE_URL, evidence=self.evidence)
        self.inputs = PostgresAssistantSessionInputs(fixture.DATABASE_URL)
        self.request = ExplorationOpen(
            self.session_id, ExplorationInput("initiate_conversation", purpose_hint="想了解近况"), uuid4(),
        )

    def _begin(self, request=None, previous=None):
        request = request or self.request
        content = request.content
        snapshots = self.evidence.capture(self.scope, content)
        return self.store.begin(scope=self.scope, request=request, snapshots=snapshots,
                                skill=select_exploration_skill(skills=self.skills, scope=self.scope, content=content),
                                previous=previous)

    def _ready(self, request=None, previous=None, question=None):
        return self.store.complete(self._begin(request, previous), result(question))

    def _select(self, task, index=0):
        return self.store.select(self.scope, task.exploration_id, task.input_version_id,
                                 suggestion_id=UUID(task.result["options"][index]["suggestion_id"]), direct_intent=None)

    def _current(self):
        return self.fixture.backend.request(self.fixture._path(self.session_id))[1]["current_input_version_id"]

    def _pending_skill_choice(self):
        skill, version = uuid4(), uuid4()
        name = "synthetic-auto-pin-" + skill.hex[:8]
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.scope.owner_id,))
            connection.execute("INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description) "
                               "VALUES (%s,%s,%s,%s,'合成自动策略')", (skill, self.scope.owner_id, self.scope.contact_id, name))
            connection.execute("INSERT INTO public.reply_skill_version"
                "(id,skill_id,version_number,name,description,content,enabled,is_current,status) "
                "VALUES (%s,%s,1,%s,'合成自动策略','合成受控正文',true,true,'active')", (version, skill, name))
        task = self._begin()
        self.assertFalse(task.skill_selection_complete)
        return task, version

    def test_auto_none_choice_is_persisted_across_retry_and_cannot_select_again(self):
        task, version = self._pending_skill_choice()
        pinned = self.store.pin_skill(task, None)
        self.store.fail(pinned)
        restored = PostgresExplorationStore(fixture.DATABASE_URL, evidence=self.evidence)
        failed = restored.replay(self.scope, self.request)
        self.assertTrue(failed.skill_selection_complete)
        self.assertIsNone(failed.skill_version_id)
        running = restored.retry(failed)
        self.assertEqual(running.input_version_id, task.input_version_id)
        with self.assertRaises(ExplorationStale):
            restored.pin_skill(running, version)
        self.assertIsNone(restored.complete(running, result()).skill_version_id)

    def test_concurrent_auto_choice_pins_only_one_result(self):
        task, version = self._pending_skill_choice()

        def pin(selected):
            try:
                return PostgresExplorationStore(fixture.DATABASE_URL, evidence=self.evidence).pin_skill(task, selected)
            except ExplorationStale:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            attempts = list(pool.map(pin, (version, None)))
        self.assertEqual(sum(item is not None for item in attempts), 1)
        actual = self.store.read(self.scope, task.exploration_id)
        self.assertTrue(actual.skill_selection_complete)
        self.assertEqual(actual, next(item for item in attempts if item is not None))

    def test_auto_choice_checks_stop_expiry_and_library_revision_before_pinning(self):
        for mutation in ("stop", "expiry", "revision"):
            with self.subTest(mutation=mutation):
                self.request = replace(self.request, operation_key=uuid4())
                task, version = self._pending_skill_choice()
                if mutation == "stop":
                    self.store.stop(self.scope, task.exploration_id, task.input_version_id)
                else:
                    with psycopg.connect(fixture.DATABASE_URL) as connection:
                        if mutation == "expiry":
                            connection.execute("UPDATE public.reply_exploration SET root_created_at=clock_timestamp()-interval '16 minutes' WHERE id=%s",
                                               (task.exploration_id,))
                        else:
                            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.scope.owner_id,))
                with self.assertRaises(ExplorationStale):
                    self.store.pin_skill(task, version)

    def test_auto_choice_cannot_pin_a_version_outside_the_contact_catalog(self):
        task, _ = self._pending_skill_choice()
        with self.assertRaises(ExplorationStale):
            self.store.pin_skill(task, uuid4())
        self.assertFalse(self.store.read(self.scope, task.exploration_id).skill_selection_complete)

    def test_reassembled_store_replays_same_operation_before_advancing_a_input(self):
        task = self._ready()
        reopened = PostgresExplorationStore(fixture.DATABASE_URL, evidence=self.evidence)
        self.assertEqual(reopened.replay(self.scope, self.request), task)
        self.assertEqual(self._current(), str(task.input_version_id))
        with self.assertRaises(ExplorationStale):
            reopened.replay(self.scope, replace(self.request, content=replace(self.request.content, correction="另一输入")))
        self.assertEqual(len(self.fixture.backend.request(self.fixture._path(self.session_id))[1]["inputs"]), 1)

    def test_b_write_failure_rolls_back_a_input_and_current_pointer(self):
        first = self._ready()
        with patch("notalone.persistence.reply_exploration.uuid4", return_value=first.exploration_id):
            with self.assertRaises(ExplorationError):
                self._begin(replace(self.request, operation_key=uuid4(), expected_input_version_id=first.input_version_id))
        saved = self.fixture.backend.request(self.fixture._path(self.session_id))[1]
        self.assertEqual(saved["current_input_version_id"], str(first.input_version_id))
        self.assertEqual(len(saved["inputs"]), 1)

    def test_concurrent_same_operation_creates_only_one_a_input_and_b_call_slot(self):
        def begin():
            try:
                return self._begin()
            except ExplorationError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = list(pool.map(lambda _: begin(), range(2)))
        self.assertEqual(sum(task is not None for task in tasks), 1)
        task = next(task for task in tasks if task is not None)
        self.assertEqual(self._current(), str(task.input_version_id))
        self.assertEqual(len(self.fixture.backend.request(self.fixture._path(self.session_id))[1]["inputs"]), 1)
        with self.assertRaises(ExplorationError):
            self.store.replay(self.scope, self.request)

    def test_stopped_running_task_cannot_publish_late_model_result(self):
        task = self._begin()
        self.store.stop(self.scope, task.exploration_id, task.input_version_id)
        with self.assertRaises(ExplorationStale):
            self.store.complete(task, result())
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            row = connection.execute("SELECT state,result_payload FROM public.reply_exploration WHERE id=%s", (task.exploration_id,)).fetchone()
        self.assertEqual(row, ("paused", None))

    def test_finish_cannot_confirm_a_different_selection_from_the_captured_task(self):
        _, message_id = self.fixture._source("合成近况问题")
        task = self._select(self._ready())
        replacement = self.store.select(self.scope, task.exploration_id, task.input_version_id,
                                        suggestion_id=None, direct_intent="婉拒合成邀请")
        self.fixture.model.responses = [self.fixture._candidate(message_id)]
        status, generated = self.fixture.backend.request(self.fixture._path(self.session_id) + "/replies", {
            "contact_id": str(self.scope.contact_id), "idempotency_key": str(task.request_key),
            "expected_input_version_id": str(task.input_version_id), "skill_disabled": True,
            "content": {"type": "initiate_conversation", "purpose": replacement.selected_intent},
        })
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["state"], "completed")
        with self.assertRaises(ExplorationStale):
            self.store.finish(task)
        current = self.store.read(self.scope, task.exploration_id)
        self.assertEqual(current.selection_id, replacement.selection_id)
        self.assertEqual(current.state, "selected")
        self.store.finish(replacement)
        self.assertEqual(self.store.read(self.scope, task.exploration_id).state, "confirmed")

    def test_expiration_after_prune_is_rechecked_in_the_actual_authorization_transaction(self):
        task = self._ready()
        original = self.store._prune
        def expire_between_transactions(scope):
            original(scope)
            with psycopg.connect(fixture.DATABASE_URL) as connection:
                connection.execute("UPDATE public.reply_exploration SET root_created_at=clock_timestamp()-interval '16 minutes' WHERE id=%s",
                                   (task.exploration_id,))
        with patch.object(self.store, "_prune", side_effect=expire_between_transactions):
            with self.assertRaises(ExplorationStale):
                self.store.read(self.scope, task.exploration_id)
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            row = connection.execute("SELECT state,input_payload,result_payload FROM public.reply_exploration WHERE id=%s", (task.exploration_id,)).fetchone()
        self.assertEqual(row, ("expired", None, None))

    def test_auto_update_budget_and_root_expiry_do_not_reset_on_manual_refresh(self):
        task = self._ready()
        for count in range(1, 4):
            request = replace(self.request, operation_key=uuid4(), expected_input_version_id=task.input_version_id,
                              previous_id=task.exploration_id, automatic=True)
            task = self._ready(request, task)
            self.assertEqual(task.automatic_call_count, count)
        with self.assertRaises(ExplorationStale):
            self._begin(replace(self.request, operation_key=uuid4(), expected_input_version_id=task.input_version_id,
                                previous_id=task.exploration_id, automatic=True), task)
        manual = self._ready(replace(self.request, operation_key=uuid4(), expected_input_version_id=task.input_version_id,
                                     previous_id=task.exploration_id), task)
        self.assertEqual(manual.automatic_call_count, 3)
        self.assertEqual(manual.root_created_at, task.root_created_at)

    def test_answer_and_failed_retry_keep_actual_selection_and_same_a_version(self):
        parent = self._select(self._ready(question={"text": "要承诺见面吗？", "impact": "commitment"}))
        request = replace(self.request, operation_key=uuid4(), expected_input_version_id=parent.input_version_id,
                          previous_id=parent.exploration_id,
                          content=replace(self.request.content, confirmed_intent=parent.selected_intent, answer="不承诺见面"))
        failed = self._begin(request, parent)
        self.store.fail(failed)
        recovered = self.store.replay(self.scope, request)
        self.assertEqual(recovered.state, "failed")
        self.assertEqual(recovered.selection_id, parent.selection_id)
        retried = self.store.retry(recovered)
        self.assertEqual(retried.input_version_id, failed.input_version_id)
        self.assertEqual(retried.selected_intent, "了解近况")
        self.assertEqual(retried.selection_source, DirectionSource.CONFIRMED_SUGGESTION)
        self.assertEqual(len(self.fixture.backend.request(self.fixture._path(self.session_id))[1]["inputs"]), 2)

    def test_history_is_not_authority_for_old_intent_after_another_input(self):
        old = self._select(self._ready())
        new = self._ready(replace(self.request, operation_key=uuid4(), expected_input_version_id=old.input_version_id))
        historical = self.store.read(self.scope, old.exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        self.assertEqual(historical.selected_intent, "了解近况")
        with self.assertRaises(ExplorationStale):
            self.store.read(self.scope, old.exploration_id, purpose=ExplorationReadPurpose.CONTINUE)
        with self.assertRaises(ExplorationStale):
            self._begin(replace(self.request, operation_key=uuid4(), expected_input_version_id=new.input_version_id,
                                previous_id=old.exploration_id), old)
        self.assertEqual(self._current(), str(new.input_version_id))

    def test_source_deletion_erases_snapshots_selection_and_a_discussion(self):
        source_id, target_id = self.fixture._source("合成来源里的邀请")
        request = replace(self.request, content=ExplorationInput("reply_to_message", target_message_id=UUID(target_id)))
        task = self._select(self._ready(request))
        self.fixture._delete_source(source_id)
        with self.assertRaises(ExplorationStale):
            self.store.read(self.scope, task.exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        with psycopg.connect(fixture.DATABASE_URL, row_factory=dict_row) as connection:
            row = connection.execute("SELECT * FROM public.reply_exploration WHERE id=%s", (task.exploration_id,)).fetchone()
        self.assertEqual(row["state"], "redacted")
        self.assertIsNone(row["input_payload"])
        self.assertIsNone(row["result_payload"])
        self.assertIsNone(row["selected_intent"])
        self.assertEqual(row["snapshots"], [])
        self.assertEqual(row["intent_snapshots"], [])
        self.assertIsNone(row["selection_id"])
        self.assertEqual(row["source_ids"], [])
        saved = self.fixture.backend.request(self.fixture._path(self.session_id))[1]
        self.assertEqual(saved["inputs"][0]["state"], "redacted")

    def test_revision_change_discards_old_options_but_preserves_user_selection_for_explicit_refresh(self):
        task = self._select(self._ready())
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.scope.owner_id,))
        with self.assertRaises(ExplorationStale):
            self.store.read(self.scope, task.exploration_id)

        old = self.store.read(self.scope, task.exploration_id, purpose=ExplorationReadPurpose.CONTINUE)
        self.assertIsNone(old.result)
        self.assertEqual(old.selected_intent, "了解近况")
        fresh = self._ready(replace(self.request, operation_key=uuid4(), expected_input_version_id=old.input_version_id,
                                   previous_id=old.exploration_id,
                                   content=replace(self.request.content, skill_mode="disabled", confirmed_intent=old.selected_intent)), old)
        self.assertEqual(fresh.skill_library_revision, 1)
        self.assertIsNone(fresh.skill_version_id)
        self.assertEqual(fresh.selection_id, old.selection_id)

    def test_revision_change_erases_model_options_even_in_a_paused_task_without_resuming_it(self):
        paused = self._select(self._ready(), index=1)
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.scope.owner_id,))
        restored = self.store.read(self.scope, paused.exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        self.assertEqual(restored.state, "paused")
        self.assertEqual(restored.selected_intent, "暂不联系")
        self.assertIsNone(restored.result)

    def test_expired_read_commits_body_pruning_even_when_rejected(self):
        task = self._select(self._ready())
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.reply_exploration SET root_created_at=%s WHERE id=%s",
                               (datetime.now(timezone.utc)-timedelta(minutes=16), task.exploration_id))
        with self.assertRaises(ExplorationStale):
            self.store.read(self.scope, task.exploration_id)
        with psycopg.connect(fixture.DATABASE_URL, row_factory=dict_row) as connection:
            row = connection.execute("SELECT state,input_payload,result_payload,snapshots,selected_intent FROM public.reply_exploration WHERE id=%s",
                                     (task.exploration_id,)).fetchone()
        self.assertEqual(row, {"state": "expired", "input_payload": None, "result_payload": None,
                               "snapshots": [], "selected_intent": None})

    def test_cross_scope_and_binding_change_cannot_revive_the_exploration(self):
        task = self._ready()
        with self.assertRaises(ExplorationStale):
            self.store.read(ContactScope(self.scope.owner_id, self.fixture.other_contact_id), task.exploration_id)
        with psycopg.connect(fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.conversation_binding SET status='revoked',revoked_at=now() WHERE id=%s", (self.fixture.binding.binding_id,))
        self.fixture.bindings.create_binding(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                            channel="wechat", account_scope="synthetic-exploration-rebind",
                                            conversation_locator=f"synthetic-{uuid4()}")
        with self.assertRaises(ExplorationStale):
            self.store.read(self.scope, task.exploration_id)



class ReplyExplorationUpgradeTest(unittest.TestCase):
    def test_production_052_upgrades_a_051_candidate_and_repeats_without_new_identity(self):
        upstream = upgrade_fixture.AssistantSessionInputUpgradeTest()
        upstream.setUp()
        self.addCleanup(upstream.doCleanups)
        upstream._upgrade()
        request_id, candidate_id = uuid4(), uuid4()
        with psycopg.connect(upstream.database_url) as connection:
            connection.execute(
                "INSERT INTO public.reply_request "
                "(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at) "
                "VALUES (%s,%s,%s,%s,%s,'合成升级输入','running',1,now()+interval '1 minute')",
                (request_id, upstream.owner_id, upstream.contact_id, upstream.binding.binding_id, uuid4()),
            )
            connection.execute(
                "INSERT INTO public.reply_candidate "
                "(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes) "
                "VALUES (%s,%s,%s,%s,%s,0,'合成旧单句','合成依据','[]')",
                (candidate_id, request_id, upstream.owner_id, upstream.contact_id, upstream.binding.binding_id),
            )
        migration = Path(__file__).resolve().parents[3]/"database/migrations/052_reply_exploration.sql"
        shutil.copyfile(migration, upstream.migrations/migration.name)
        self.assertEqual(migrate(upstream.database_url, upstream.migrations), (migration.name,))
        self.assertEqual(migrate(upstream.database_url, upstream.migrations), ())
        with psycopg.connect(upstream.database_url) as connection:
            candidate = connection.execute("SELECT id,candidate_text,message_group FROM public.reply_candidate WHERE id=%s", (candidate_id,)).fetchone()
        self.assertEqual(candidate, (candidate_id, "合成旧单句", [{"message_id": str(candidate_id), "text": "合成旧单句"}]))
