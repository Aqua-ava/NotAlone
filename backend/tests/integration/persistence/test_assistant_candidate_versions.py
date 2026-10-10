"""独立版本适配器：真实迁移升级与公开存储合同，不补造共享HTTP接线。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence import assistant_candidate_versions as versions
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.interface import CandidateMessage, RewriteDraft
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ValidatedReply
from notalone.scopes import ContactScope, VerifiedConversationScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
ROOT = Path(__file__).resolve().parents[3]
VERSION_MIGRATION = "053_assistant_candidate_versions.sql"


class AssistantCandidateVersionMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本地隔离PG实例。")
        self.database_name = f"notalone_candidate_schema_{uuid4().hex}_test"
        self.database_url = make_conninfo(DATABASE_URL, dbname=self.database_name)
        self.admin = psycopg.connect(DATABASE_URL, dbname="postgres", autocommit=True)
        self.addCleanup(self.admin.close)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.database_name)))
        self.addCleanup(self._drop_database)

    def _drop_database(self) -> None:
        self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
            sql.Identifier(self.database_name)))
        remaining = self.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s",
                                       (self.database_name,)).fetchone()[0]
        self.assertEqual(remaining, 0)
        print(f"candidate_schema_cleanup: owned database remaining={remaining}", flush=True)

    def _migrate(self, directory: Path) -> list[str]:
        env = dict(os.environ, NOTALONE_DATABASE_URL=self.database_url,
                   NOTALONE_DISABLE_DOTENV="1", LANGSMITH_TRACING="false",
                   LANGCHAIN_TRACING_V2="false")
        result = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(directory)],
            cwd=ROOT, env=env, text=True, capture_output=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["applied"]

    def test_empty_database_installs_formal_001_to_053_once(self):
        applied = self._migrate(ROOT / "database/migrations")
        self.assertEqual(len(applied), 53)
        self.assertEqual(applied[-1], VERSION_MIGRATION)
        self.assertEqual(self._migrate(ROOT / "database/migrations"), [])
        print("candidate_schema_fresh: installed=001–053, repeated=[]", flush=True)

    def test_actual_formal_052_prefix_upgrades_to_053_once(self):
        with tempfile.TemporaryDirectory(prefix="notalone-candidate-052-") as directory:
            prefix = Path(directory)
            for path in (ROOT / "database/migrations").glob("*.sql"):
                if int(path.name[:3]) <= 52:
                    shutil.copyfile(path, prefix / path.name)
            installed = self._migrate(prefix)
            self.assertEqual(len(installed), 52)
            self.assertEqual(installed[-1], "052_reply_exploration.sql")
        self.assertEqual(self._migrate(ROOT / "database/migrations"), [VERSION_MIGRATION])
        self.assertEqual(self._migrate(ROOT / "database/migrations"), [])
        print("candidate_schema_upgrade: installed=001–052, applied=[053], repeated=[]", flush=True)


class AssistantCandidateVersionsStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供自有隔离测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("候选版本验收仅使用隔离_test库。")
        # 只消费正式扫描目录；不再拼接pending或补造缺失版本。
        migrations = ROOT / "database/migrations"
        if not (migrations / VERSION_MIGRATION).exists():
            raise RuntimeError("候选版本053正式迁移缺失。")
        env = dict(os.environ, NOTALONE_DATABASE_URL=DATABASE_URL,
                   NOTALONE_DISABLE_DOTENV="1", LANGSMITH_TRACING="false",
                   LANGCHAIN_TRACING_V2="false")
        command = [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(migrations)]
        upgraded = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
        if upgraded.returncode:
            raise RuntimeError("候选版本正式迁移失败。")
        repeated = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
        if repeated.returncode or json.loads(repeated.stdout)["applied"] != []:
            raise RuntimeError("候选版本正式迁移不能重复执行。")
        print("candidate_version_store: formal scan verified, repeated=[]", flush=True)

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        self.contact_id, self.other_contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成版本用户')",
                                   (owner_id,))
                connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,0)",
                                   (owner_id,))
            for contact_id in (self.contact_id, self.other_contact_id):
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'同名合成联系人')",
                                   (self.owner_id, contact_id))
        self.addCleanup(self._clean_owners)
        binding = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-candidate-versions",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        self.binding_id = binding.binding_id
        self.session_store = PostgresAssistantSessionStore(DATABASE_URL)
        self.reply_store = PostgresReplyStore(DATABASE_URL)
        self.session_id = self.session_store.default(self.scope)
        self.verified = VerifiedConversationScope(self.owner_id, self.contact_id, self.binding_id)
        self.source_ids = {}

    def _clean_owners(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=ANY(%s::uuid[])",
                               ([self.owner_id, self.other_owner_id],))

    def _source(self):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("""
                INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic-versions.jsonl',%s,1)
            """, (source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
            connection.execute("""
                INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content)
                VALUES (%s,%s,%s,'contact','text','合成来源原话。')
            """, (message_id, self.owner_id, self.contact_id))
            connection.execute("""
                INSERT INTO public.message_source_ref
                  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic:1','{}')
            """, (message_id, self.owner_id, self.contact_id, source_id))
        return source_id, message_id

    def _candidate(self, *, use_source=False, parts=("明天见。", "路上注意安全。")):
        request = ReplyServiceRequest(idempotency_key=uuid4(),
                                      content=RewriteDraft("明天见", include_relationship_context=use_source))
        turn_id = self.session_store.reserve(self.scope, self.session_id, request)
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                        binding_id=self.binding_id)
        started = self.reply_store.start(command, self.verified)
        draft_id = uuid4()
        evidence = (ContextEvidence(evidence_id=draft_id, kind="user_draft", text="明天见",
                                    scope=self.scope, selection_reason="本次合成草稿"),)
        if use_source:
            source_id, message_id = self._source()
            evidence += (ContextEvidence(evidence_id=message_id, kind="message", text="合成来源原话。",
                                         scope=self.scope, source_ids=(source_id,),
                                         selection_reason="本次实际合成资料"),)
        context = ReplyContext(
            reply_request_id=started.request.request_id, command=command, scope=self.scope,
            current_text="明天见", direction=None, skill_library_revision=0,
            evidence=evidence,
        )
        self.reply_store.prepare_context(started.request, context)
        result = self.reply_store.save(started.request, context, ValidatedReply(
            candidates=(RuntimeCandidate(text="\n\n".join(parts), messages=parts,
                                         basis="保留本次草稿原意。", citation_ids=(draft_id,), risk_notes=()),),
            used_skill=None,
        ))
        self.session_store.complete(self.scope, self.session_id, turn_id, result)
        if use_source:
            self.source_ids[result.candidates[0].candidate_id] = source_id
        return result.candidates[0], result.reply_request_id, turn_id

    def test_original_group_reopens_with_stable_identity_and_no_explicit_selection(self):
        candidate, request_id, turn_id = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        history = adapter.read(self.scope, self.session_id, candidate.candidate_id)
        self.assertEqual(history.candidate_group_id, request_id)
        self.assertEqual(history.turn_id, turn_id)
        self.assertEqual(history.candidate_number, 1)
        self.assertEqual(history.default_display_version_id, candidate.candidate_id)
        self.assertIsNone(history.selected_version_id)
        self.assertEqual(len(history.versions), 1)
        original = history.versions[0]
        self.assertEqual(original.version_id, candidate.candidate_id)
        self.assertEqual(original.version_number, 0)
        self.assertIsNone(original.parent_version_id)
        self.assertIsNone(original.requirements)
        self.assertEqual(original.messages, candidate.message_group)
        reopened = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        self.assertEqual(reopened.read(self.scope, self.session_id, candidate.candidate_id), history)
        self.assertIsNone(reopened.selected(self.scope, self.session_id))

    def test_whole_group_edit_keeps_parent_requirements_and_reopens_without_selection(self):
        candidate, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        original_ids = tuple(message.message_id for message in candidate.message_group)
        command = versions.EditAssistantCandidate(
            edit_key=uuid4(), parent_version_id=candidate.candidate_id,
            messages=(CandidateMessage(original_ids[0], "明天见呀。"),
                      CandidateMessage(original_ids[1], "慢慢来，不着急。")),
            requirements="说得随意一点。",
        )
        edited = adapter.edit(self.scope, self.session_id, candidate.candidate_id, command)
        newest = edited.versions[-1]
        self.assertEqual(newest.version_number, 1)
        self.assertNotEqual(newest.version_id, candidate.candidate_id)
        self.assertEqual(newest.parent_version_id, candidate.candidate_id)
        self.assertEqual(newest.messages, command.messages)
        self.assertEqual(newest.requirements, "说得随意一点。")
        self.assertEqual(newest.text, "明天见呀。\n\n慢慢来，不着急。")
        self.assertEqual(edited.default_display_version_id, newest.version_id)
        self.assertIsNone(edited.selected_version_id)
        reopened = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        self.assertEqual(reopened.read(self.scope, self.session_id, candidate.candidate_id), edited)
        self.assertEqual(reopened.edit(self.scope, self.session_id, candidate.candidate_id, command), edited)
        self.assertIsNone(reopened.selected(self.scope, self.session_id))

    def test_selecting_old_version_is_explicit_and_old_key_replay_keeps_new_choice(self):
        candidate, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        messages = candidate.message_group
        edited = adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                              versions.EditAssistantCandidate(
                                  uuid4(), candidate.candidate_id,
                                  (CandidateMessage(messages[0].message_id, "明天见呀。"),
                                   CandidateMessage(messages[1].message_id, "慢慢来。")),
                              ))
        newest = edited.versions[-1].version_id
        original_key, newest_key = uuid4(), uuid4()
        first = adapter.select(self.scope, self.session_id, candidate.candidate_id,
                               candidate.candidate_id, original_key)
        self.assertEqual(first.selection_number, 1)
        self.assertEqual(first.version_id, candidate.candidate_id)
        selected_old = adapter.read(self.scope, self.session_id, candidate.candidate_id)
        self.assertEqual(selected_old.default_display_version_id, newest)
        self.assertEqual(selected_old.selected_version_id, candidate.candidate_id)
        second = adapter.select(self.scope, self.session_id, candidate.candidate_id, newest, newest_key)
        self.assertEqual(second.selection_number, 2)
        self.assertNotEqual(second.selection_id, first.selection_id)
        self.assertEqual(adapter.select(self.scope, self.session_id, candidate.candidate_id,
                                        candidate.candidate_id, original_key), first)
        self.assertEqual(adapter.selected(self.scope, self.session_id), second)
        third = adapter.select(self.scope, self.session_id, candidate.candidate_id,
                               candidate.candidate_id, uuid4())
        self.assertEqual(third.selection_number, 3)
        self.assertEqual(adapter.selected(self.scope, self.session_id), third)
        reopened = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        self.assertEqual(reopened.selected(self.scope, self.session_id), third)

    def test_deleting_current_b_never_restores_historical_a_until_explicit_reselection(self):
        candidate_a, _, _ = self._candidate()
        candidate_b, _, _ = self._candidate(use_source=True)
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        a_key, b_key = uuid4(), uuid4()
        first = adapter.select(self.scope, self.session_id, candidate_a.candidate_id,
                               candidate_a.candidate_id, a_key)
        b_messages = candidate_b.message_group
        edited_b = adapter.edit(self.scope, self.session_id, candidate_b.candidate_id,
                                versions.EditAssistantCandidate(
                                    uuid4(), candidate_b.candidate_id,
                                    (CandidateMessage(b_messages[0].message_id, "合成修改第一条。"),
                                     CandidateMessage(b_messages[1].message_id, "合成修改第二条。")),
                                    "合成一次性修改要求。",
                                ))
        chosen_b = adapter.select(self.scope, self.session_id, candidate_b.candidate_id,
                                  edited_b.default_display_version_id, b_key)
        self.assertEqual(adapter.selected(self.scope, self.session_id), chosen_b)
        result = PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.owner_id, contact_id=self.contact_id,
            source_document_id=self.source_ids[candidate_b.candidate_id],
        )
        self.assertEqual(result.outcome, "deleted")
        reopened = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        self.assertIsNone(reopened.selected(self.scope, self.session_id))
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            reopened.read(self.scope, self.session_id, candidate_b.candidate_id)
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            reopened.select(self.scope, self.session_id, candidate_b.candidate_id,
                            chosen_b.version_id, b_key)
        historical_a = reopened.read(self.scope, self.session_id, candidate_a.candidate_id)
        self.assertEqual(historical_a.versions[0].messages, candidate_a.message_group)
        self.assertIsNone(historical_a.selected_version_id)
        self.assertEqual(reopened.select(self.scope, self.session_id, candidate_a.candidate_id,
                                         candidate_a.candidate_id, a_key), first)
        self.assertIsNone(reopened.selected(self.scope, self.session_id))
        explicitly_chosen = reopened.select(self.scope, self.session_id, candidate_a.candidate_id,
                                             candidate_a.candidate_id, uuid4())
        self.assertEqual(reopened.selected(self.scope, self.session_id), explicitly_chosen)

    def test_candidate_version_and_operation_key_cannot_cross_scope_or_group(self):
        candidate_a, _, _ = self._candidate()
        candidate_b, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        selection_key = uuid4()
        first = adapter.select(self.scope, self.session_id, candidate_a.candidate_id,
                               candidate_a.candidate_id, selection_key)
        with self.assertRaises(versions.AssistantCandidateVersionConflict) as conflict:
            adapter.select(self.scope, self.session_id, candidate_b.candidate_id,
                           candidate_b.candidate_id, selection_key)
        self.assertEqual(conflict.exception.reason, "selection_key_conflict")
        self.assertEqual(adapter.selected(self.scope, self.session_id), first)
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            adapter.select(self.scope, self.session_id, candidate_b.candidate_id,
                           candidate_a.candidate_id, uuid4())
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            adapter.edit(self.scope, self.session_id, candidate_b.candidate_id,
                         versions.EditAssistantCandidate(uuid4(), candidate_a.candidate_id,
                                                         candidate_b.message_group))
        other_session = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.assistant_session(id,owner_id,contact_id,is_default) VALUES (%s,%s,%s,FALSE)",
                               (other_session, self.owner_id, self.contact_id))
        for wrong_scope, wrong_session in (
            (ContactScope(self.other_owner_id, self.contact_id), self.session_id),
            (ContactScope(self.owner_id, self.other_contact_id), self.session_id),
            (self.scope, other_session),
        ):
            with self.subTest(scope=wrong_scope, session_id=wrong_session):
                with self.assertRaises(versions.AssistantCandidateVersionNotFound):
                    adapter.read(wrong_scope, wrong_session, candidate_a.candidate_id)
                with self.assertRaises(versions.AssistantCandidateVersionNotFound):
                    adapter.select(wrong_scope, wrong_session, candidate_a.candidate_id,
                                   candidate_a.candidate_id, selection_key)
        self.assertEqual(adapter.selected(self.scope, self.session_id), first)

    def test_pending_source_blocks_read_edit_selection_and_same_key_replay(self):
        independent, _, _ = self._candidate()
        candidate, _, _ = self._candidate(use_source=True)
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        key = uuid4()
        adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, key)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s AND owner_id=%s",
                               (self.source_ids[candidate.candidate_id], self.owner_id))
        operations = (
            lambda: adapter.read(self.scope, self.session_id, candidate.candidate_id),
            lambda: adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                                 versions.EditAssistantCandidate(uuid4(), candidate.candidate_id, candidate.message_group)),
            lambda: adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, uuid4()),
            lambda: adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, key),
            lambda: adapter.selected(self.scope, self.session_id),
        )
        for index, operation in enumerate(operations):
            with self.subTest(operation=index):
                with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
                    operation()
                self.assertEqual(failure.exception.reason, "source_unavailable")
        unrelated = adapter.read(self.scope, self.session_id, independent.candidate_id)
        self.assertEqual(unrelated.versions[0].messages, independent.message_group)
        self.assertIsNone(unrelated.selected_version_id)

    def test_missing_captured_snapshot_is_not_reconstructed_from_current_message_source(self):
        candidate, request_id, _ = self._candidate(use_source=True)
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        adapter.read(self.scope, self.session_id, candidate.candidate_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.reply_original_source_use WHERE owner_id=%s AND reply_request_id=%s",
                               (self.owner_id, request_id))
        for operation in (
            lambda: adapter.read(self.scope, self.session_id, candidate.candidate_id),
            lambda: adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                                 versions.EditAssistantCandidate(uuid4(), candidate.candidate_id, candidate.message_group)),
            lambda: adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, uuid4()),
        ):
            with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
                operation()
            self.assertEqual(failure.exception.reason, "source_unavailable")

    def test_failed_turn_or_invalidated_request_rejects_completed_reply_copy(self):
        candidate, request_id, turn_id = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        adapter.read(self.scope, self.session_id, candidate.candidate_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET state='failed' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, turn_id))
        with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
            adapter.read(self.scope, self.session_id, candidate.candidate_id)
        self.assertEqual(failure.exception.reason, "candidate_unavailable")
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET state='completed' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, turn_id))
            connection.execute("""
                INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
                SELECT owner_id,contact_id,idempotency_key FROM public.reply_request WHERE owner_id=%s AND id=%s
            """, (self.owner_id, request_id))
        with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
            adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, uuid4())
        self.assertEqual(failure.exception.reason, "request_invalidated")

    def test_editing_an_old_parent_keeps_all_versions_and_changed_edit_key_input_conflicts(self):
        candidate, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        message_ids = tuple(message.message_id for message in candidate.message_group)
        first_command = versions.EditAssistantCandidate(
            uuid4(), candidate.candidate_id,
            (CandidateMessage(message_ids[0], "合成修改第一版。"),
             CandidateMessage(message_ids[1], "合成修改后半句。")), "第一版要求。",
        )
        first = adapter.edit(self.scope, self.session_id, candidate.candidate_id, first_command)
        second_command = versions.EditAssistantCandidate(
            uuid4(), candidate.candidate_id,
            (CandidateMessage(message_ids[0], "合成修改另一版。"),
             CandidateMessage(message_ids[1], "第二版后半句。")), "从原版另改。",
        )
        second = adapter.edit(self.scope, self.session_id, candidate.candidate_id, second_command)
        self.assertEqual([version.version_number for version in second.versions], [0, 1, 2])
        self.assertEqual(second.versions[1], first.versions[1])
        self.assertEqual(second.versions[2].parent_version_id, candidate.candidate_id)
        self.assertEqual(adapter.edit(self.scope, self.session_id, candidate.candidate_id, first_command), second)
        conflicting = versions.EditAssistantCandidate(first_command.edit_key, candidate.candidate_id,
                                                      second_command.messages, first_command.requirements)
        with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
            adapter.edit(self.scope, self.session_id, candidate.candidate_id, conflicting)
        self.assertEqual(failure.exception.reason, "edit_key_conflict")
        self.assertEqual(adapter.read(self.scope, self.session_id, candidate.candidate_id), second)

    def test_edit_rejects_reordered_removed_duplicated_or_foreign_message_identity(self):
        candidate, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        before = adapter.read(self.scope, self.session_id, candidate.candidate_id)
        first, second = candidate.message_group
        for messages in (
            (second, first), (first,), (first, first),
            (CandidateMessage(uuid4(), "未知组内身份。"), second),
        ):
            with self.subTest(messages=len(messages)):
                with self.assertRaises(versions.AssistantCandidateVersionConflict) as failure:
                    adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                                 versions.EditAssistantCandidate(uuid4(), candidate.candidate_id, messages))
                self.assertEqual(failure.exception.reason, "message_group_mismatch")
        self.assertEqual(adapter.read(self.scope, self.session_id, candidate.candidate_id), before)

    def test_selection_insert_failure_rolls_back_current_choice_and_reports_no_body(self):
        candidate_a, _, _ = self._candidate()
        candidate_b, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        first = adapter.select(self.scope, self.session_id, candidate_a.candidate_id,
                               candidate_a.candidate_id, uuid4())
        rejected_key = uuid4()
        constraint = f"synthetic_selection_failure_{uuid4().hex}"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL("ALTER TABLE public.assistant_candidate_selection ADD CONSTRAINT {} CHECK (selection_key <> {})").format(
                sql.Identifier(constraint), sql.Literal(rejected_key)))
        self.addCleanup(self._drop_selection_constraint, constraint)
        with self.assertRaises(versions.AssistantCandidateVersionPersistenceError) as failure:
            adapter.select(self.scope, self.session_id, candidate_b.candidate_id,
                           candidate_b.candidate_id, rejected_key)
        self.assertNotIn("合成", str(failure.exception))
        self.assertNotIn("selection_key", str(failure.exception))
        self.assertEqual(adapter.selected(self.scope, self.session_id), first)
        self.assertIsNone(adapter.read(self.scope, self.session_id, candidate_b.candidate_id).selected_version_id)

    def test_concurrent_same_edit_key_creates_one_version_and_different_keys_keep_order(self):
        candidate, _, _ = self._candidate()
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        command = versions.EditAssistantCandidate(uuid4(), candidate.candidate_id, candidate.message_group,
                                                  "同一次合成修改。")
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: adapter.edit(self.scope, self.session_id, candidate.candidate_id, command), range(2)))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual([version.version_number for version in outcomes[0].versions], [0, 1])
        commands = [versions.EditAssistantCandidate(uuid4(), outcomes[0].versions[-1].version_id,
                                                     candidate.message_group, requirement)
                    for requirement in ("第二次合成修改。", "第三次合成修改。")]
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda item: adapter.edit(self.scope, self.session_id, candidate.candidate_id, item), commands))
        saved = adapter.read(self.scope, self.session_id, candidate.candidate_id)
        self.assertEqual([version.version_number for version in saved.versions], [0, 1, 2, 3])
        self.assertEqual({version.requirements for version in saved.versions[2:]},
                         {"第二次合成修改。", "第三次合成修改。"})

    def test_deleting_assistant_session_removes_versions_and_selection_without_deleting_raw_source(self):
        candidate, _, _ = self._candidate(use_source=True)
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        edited = adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                              versions.EditAssistantCandidate(uuid4(), candidate.candidate_id,
                                                              candidate.message_group, "合成会话内要求。"))
        key = uuid4()
        adapter.select(self.scope, self.session_id, candidate.candidate_id, edited.default_display_version_id, key)
        self.session_store.delete(self.scope, self.session_id)
        reopened = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            reopened.read(self.scope, self.session_id, candidate.candidate_id)
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            reopened.selected(self.scope, self.session_id)
        with self.assertRaises(versions.AssistantCandidateVersionNotFound):
            reopened.select(self.scope, self.session_id, candidate.candidate_id, edited.default_display_version_id, key)
        result = PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.owner_id, contact_id=self.contact_id,
            source_document_id=self.source_ids[candidate.candidate_id],
        )
        self.assertEqual(result.outcome, "deleted")

    def test_single_and_multi_message_size_limits_match_canonical_group_contract(self):
        single, _, _ = self._candidate(parts=("合成单句。",))
        adapter = versions.PostgresAssistantCandidateVersions(DATABASE_URL)
        message_id = single.message_group[0].message_id
        allowed = versions.EditAssistantCandidate(uuid4(), single.candidate_id,
                                                  (CandidateMessage(message_id, "字" * 65536),))
        saved = adapter.edit(self.scope, self.session_id, single.candidate_id, allowed)
        self.assertEqual(len(saved.versions[-1].text), 65536)
        with self.assertRaises(versions.AssistantCandidateVersionRequestInvalid):
            adapter.edit(self.scope, self.session_id, single.candidate_id,
                         versions.EditAssistantCandidate(uuid4(), single.candidate_id,
                                                         (CandidateMessage(message_id, "字" * 65537),)))
        multi, _, _ = self._candidate()
        messages = multi.message_group
        for invalid in (
            versions.EditAssistantCandidate(uuid4(), multi.candidate_id,
                                             (CandidateMessage(messages[0].message_id, "字" * 8193), messages[1])),
            versions.EditAssistantCandidate(uuid4(), multi.candidate_id,
                                             (CandidateMessage(messages[0].message_id, " "), messages[1])),
            versions.EditAssistantCandidate(uuid4(), multi.candidate_id, messages, "要求" * 2049),
        ):
            with self.assertRaises(versions.AssistantCandidateVersionRequestInvalid):
                adapter.edit(self.scope, self.session_id, multi.candidate_id, invalid)
        self.assertEqual(len(adapter.read(self.scope, self.session_id, multi.candidate_id).versions), 1)

    @staticmethod
    def _drop_selection_constraint(constraint):
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL("ALTER TABLE public.assistant_candidate_selection DROP CONSTRAINT {}").format(
                sql.Identifier(constraint)))


if __name__ == "__main__":
    unittest.main()
