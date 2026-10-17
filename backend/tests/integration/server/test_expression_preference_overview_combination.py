"""公开 HTTP 验证 07 合法历史与 08 偏好快照、独立样本删除共同生效。"""

import unittest
import json
import os
import hashlib
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.application.source_service import SourceService
from notalone.memory.models import FactSubject
from notalone.persistence.assistant_continuation import restore_prepared_reply_request
from notalone.reply.prepared_context_codec import decode_context, encode_context
from notalone.scopes import ContactScope

from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.errors import ReplyStoreInvariantError

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_overview_prepared_context import OverviewPreparedContextHttpTest
from tests.integration.server.test_overview_reply_budgets import OverviewReplyBudgetsHttpTest


class ExpressionPreferenceOverviewCombinationHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    # 复用07既有公开反例，仍仅使用本类调用方已登记的同一个库。
    saved_turn = OverviewPreparedContextHttpTest.saved_turn
    test_full_500_history_scope_is_not_widened_after_restart = OverviewPreparedContextHttpTest.test_prepared_source_window_and_tools_exclude_501st_and_later_message_ids_after_restart
    test_three_retrieval_budgets_remain_independent = OverviewReplyBudgetsHttpTest.test_contact_owner_and_unconfirmed_references_have_independent_final_input_budgets

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from notalone.database_migrations import migrate
        directory = Path(__file__).resolve().parents[3] / "database/migrations"
        official = sorted(item.name for item in directory.glob("*.sql"))
        with psycopg.connect(cls.database_url) as connection:
            cls.actual_database = connection.execute("SELECT current_database()").fetchone()[0]
            actual = [row[0] for row in connection.execute("SELECT name FROM public.notalone_schema_migration ORDER BY name")]
        if (cls.actual_database != os.environ["NOTALONE_EXPECTED_TEST_DATABASE"] or actual != official
                or len(actual) != 73 or actual[-1] != "073_layered_scenario_documents.sql"):
            raise RuntimeError("联合验收仅允许本轮精确001–073自有库。")
        if [int(item[:3]) for item in actual] != list(range(1, 74)) or migrate(cls.database_url, directory):
            raise RuntimeError("联合验收迁移须连续且重复0。")
        cls.migration_names = actual

    def setUp(self):
        super().setUp()
        self.observations = []

    def tearDown(self):
        directory = Path(os.environ["NOTALONE_08_COMBINATION_EVIDENCE"]).resolve()
        root = Path(__file__).resolve().parents[4]
        if not directory.is_dir() or directory.is_relative_to(root) or directory.stat().st_mode & 0o777 != 0o700:
            raise RuntimeError("联合验收证据须在仓库外700目录。")
        import sys
        modules = [{"module": name, "path": str(Path(module.__file__).resolve()),
                    "sha256": hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()}
                   for name, module in tuple(sys.modules.items())
                   if name.startswith(("notalone.", "tests.integration.")) and getattr(module, "__file__", None)]
        if any(not Path(item["path"]).is_relative_to(root / "backend") for item in modules):
            raise RuntimeError("联合验收加载了其他工作树模块。")
        proof = {"test_method": self._testMethodName, "pid": os.getpid(), "database_name": self.actual_database,
                 "migrations": self.migration_names, "migration_repeat": 0, "observations": self.observations,
                 "model_calls": len(self.reply_model.seen_calls) if hasattr(self, "reply_model") else 0,
                 "generation_model_calls": len(self.reply_model.payloads) if hasattr(self, "reply_model") else 0,
                 "review_model_calls": self.reply_model.review_calls if hasattr(self, "reply_model") else 0,
                 "loaded_modules": modules}
        descriptor = os.open(directory / f"{self._testMethodName}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(proof, output); output.flush(); os.fsync(output.fileno())

    def _preference(self, contact):
        body = {"operation_key": str(uuid4()), "text": "用户明确保存的联合合成表达要求。",
                "scope": {"contact_id": contact, "reply_mode": "rewrite_draft"},
                "origin": {"kind": "manual"}, "confirm_long_term": True}
        status, saved = self.backend.request(f"/api/expression-preferences?contact_id={contact}", body)
        self.assertEqual(status, 200, saved)
        return saved["preference"]

    def _dual_prepare(self):
        contact, _, _ = self.import_contact("当前联系人的合成热茶资料。")
        other, source, _ = self.import_contact("另一联系人的合成原话。", owner_text="本人喜欢合成热茶。")
        own = next(item for item in self._get(self.backend, f"/api/contacts/{other}/messages")["messages"] if item["speaker"] == "user")
        self.confirm(other, "本人喜欢合成热茶。", UUID(own["message_id"]), category="preference", subject=FactSubject.SELF)
        self.manual_contact(contact, "对方喜欢合成热茶。", category="preference")
        self.activate_replies(contact)
        preference = self._preference(contact)
        path, body = self.reply_path(contact), self.rewrite_body(contact, "本人和对方喜欢合成热茶，想聊热茶。")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self._assert_dual_snapshot(receipt)
        return contact, other, source, preference, path, body, receipt

    def _assert_dual_snapshot(self, receipt, *, has_preferences=True):
        row = self.saved_turn(receipt)
        payload = row["prepared_context"]
        self.assertEqual((payload["version"], payload["schema_revision"]), (2, 5))
        scope = ContactScope(self.owner_id, row["contact_id"])
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            request = restore_prepared_reply_request(connection, scope, row["session_id"],
                                                     row["idempotency_key"], row["input_payload"])
        command = request.build_command(owner_id=self.owner_id, contact_id=scope.contact_id, binding_id=row["conversation_binding_id"])
        decoded = decode_context(payload, command)
        self.assertEqual(bool(decoded.expression_preferences), has_preferences)
        self.assertIsNotNone(decoded.expression_preference_revision)
        self.assertIsNotNone(decoded.retrieval)
        navigation = [item.navigation for item in decoded.evidence if item.navigation is not None]
        self.assertTrue(navigation)
        self.assertEqual(encode_context(decoded), payload)
        self.observations.append({"schema_revision": 5, "preference_count": len(decoded.expression_preferences),
                                  "navigation_count": len(navigation), "codec_roundtrip": True,
                                  "history_id_count": len(decoded.history_message_ids or ())})
        return row

    def test_nonempty_dual_prepare_continuation_restart_and_schema_three_reprepare(self):
        contact, _, _, preference, path, body, receipt = self._dual_prepare()
        self.reply_model.plans.append({"text": "想聊聊合成热茶。", "basis": "本次明确输入与合法资料。", "cite_kinds": ["owner_memory"]})
        restarted = self._backend(self.owner_id)
        status, first = restarted.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        self.assertEqual(first["turn_id"], receipt["turn_id"])
        self.assertEqual(first["context_receipt"]["expression_preference_ids"], [preference["preference_id"]])
        self.assertEqual(restarted.request(path + "/replies", body), (200, first))
        self.assertEqual((len(self.reply_model.seen_calls), self.reply_model.review_calls), (2, 1))
        history = self._get(restarted, path + f"/candidates/{first['candidates'][0]['candidate_id']}/versions")
        command = {"idempotency_key": str(uuid4()), "expected_input_version_id": first["input_version_id"],
                   "instruction": "自然一点", "requirement_changes": [{"action": "add", "replacement": "保留原意"}],
                   "displayed_group": {"session_id": first["session_id"],
                   "candidate_group_id": first["reply_request_id"], "candidates": [{"number": history["candidate_number"],
                   "candidate_id": history["candidate_id"], "version_id": history["default_display_version_id"]}]}}
        status, prepared = restarted.request(path + "/continue/prepare", command)
        self.assertEqual(status, 200, prepared)
        self._assert_dual_snapshot(prepared, has_preferences=False)
        self.reply_model.plans.append({"text": "再自然地聊聊合成热茶。", "basis": "保留用户明确意图。"})
        status, continued = self._backend(self.owner_id).request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["turn_id"], prepared["turn_id"])
        self.assertEqual(continued["context_receipt"]["expression_preference_ids"], [])
        self.assertNotIn("expression_preferences", self.reply_model.payloads[-1])
        self.assertEqual(self._backend(self.owner_id).request(path + "/continue", command), (200, continued))
        self.assertEqual((len(self.reply_model.seen_calls), self.reply_model.review_calls), (4, 2))

        contact, _, _, _, path, body, receipt = self._dual_prepare()
        row = self.saved_turn(receipt); payload = row["prepared_context"]; payload["schema_revision"] = 3
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s WHERE id=%s", (Jsonb(payload), receipt["turn_id"]))
        before = len(self.reply_model.payloads)
        status, checked = self._backend(self.owner_id).request(path + "/preparation-format", {
            "request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]})
        self.assertEqual(status, 200, checked); self.assertEqual(checked["format_status"], "reprepare_required")
        self.assertEqual(self.saved_turn(receipt)["input_payload"], row["input_payload"])
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), before)
        fresh = {**body, "idempotency_key": str(uuid4()), "expected_input_version_id": receipt["input_version_id"]}
        status, prepared = self.backend.request(path + "/replies/prepare", fresh)
        self.assertEqual(status, 200, prepared); self._assert_dual_snapshot(prepared)
        self.reply_model.plans.append({"text": "保留原草稿聊合成热茶。", "basis": "显式重新准备。"})
        self.assertEqual(self._backend(self.owner_id).request(path + "/replies", fresh)[0], 200)

    def test_preference_or_other_contact_navigation_source_erases_dual_prepared_json_before_get(self):
        for kind in ("preference", "navigation_source"):
            with self.subTest(kind=kind):
                contact, other, source, preference, path, body, receipt = self._dual_prepare()
                with psycopg.connect(self.database_url) as connection:
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND idempotency_key=%s",
                        (self.owner_id, body["idempotency_key"])).fetchone()[0], 0)
                before = len(self.reply_model.payloads)
                if kind == "preference":
                    self.assertEqual(self.backend.request(f"/api/expression-preferences/{preference['preference_id']}?contact_id={contact}",
                        {"operation_key": str(uuid4()), "expected_revision": 1}, method="DELETE")[0], 200)
                else:
                    with patch.object(SourceService, "_start", return_value=None):
                        self.assertEqual(self.backend.request(f"/api/contacts/{other}/sources/{source}", method="DELETE")[0], 202)
                erased = self.saved_turn(receipt)
                self.assertEqual((erased["prepared_context"], erased["input_payload"], erased["dependency_ids"]), (None, None, []))
                self.assertNotEqual(self._backend(self.owner_id).request(path + "/replies", body)[0], 200)
                self.assertEqual(len(self.reply_model.payloads), before)
                self.observations.append({"erasure_kind": kind, "no_reply_request_before_delete": True,
                                          "prepared_json_erased_before_get": True, "late_reply_rejected": True})

    def test_old_legal_contact_and_owner_navigation_keep_preference_receipts_and_sample_erasure(self):
        for kind in ("confirmed_memory", "owner_memory"):
            with self.subTest(kind=kind):
                contact, _, message = self.import_contact("合成关系原话：喜欢热茶。")
                if kind == "confirmed_memory":
                    original = self.confirm(contact, "喜欢热茶。", message, category="preference")
                    correction_path = f"/api/contacts/{contact}/memories/{original['memory_id']}/correct"
                else:
                    original = self.manual_owner("本人喜欢热茶。", category="preference")
                    correction_path = f"/api/memories/owner/{original['memory_id']}/correct"
                status, corrected = self.backend.request(correction_path, {"text": "现在偏好安静散步。"})
                self.assertEqual(status, 200, corrected)
                self.activate_replies(contact)
                path = self.reply_path(contact)
                preference_body = {
                    "operation_key": str(uuid4()), "text": "长期保存的合成表达要求。",
                    "scope": {"contact_id": contact, "reply_mode": "rewrite_draft"},
                    "origin": {"kind": "manual"}, "confirm_long_term": True,
                }
                preference_path = f"/api/expression-preferences?contact_id={contact}"
                status, saved = self.backend.request(preference_path, preference_body)
                self.assertEqual(status, 200, saved)
                preference = saved["preference"]
                item = f"/api/expression-preferences/{preference['preference_id']}?contact_id={contact}"
                body = self.rewrite_body(contact, "之前喜欢热茶，现在想再核实。")
                self.reply_model.plans.append({
                    "text": "之前喜欢热茶，现在想再核实。", "basis": "历史资料须重新核实。",
                    "cite_kinds": [kind],
                })
                status, turn = self.backend.request(path + "/replies", body)
                self.assertEqual(status, 200, turn)
                receipt = turn["context_receipt"]
                self.assertEqual(receipt["expression_preferences"], [{
                    "preference_id": preference["preference_id"], "text": preference_body["text"],
                    "revision": 1, "scope": preference_body["scope"],
                }])
                evidence_path = self.evidence_path(contact, turn)
                evidence = self._get(self.backend, evidence_path)
                old = next(row for row in evidence["evidence"] if row["evidence_id"] == original["memory_id"])
                self.assertEqual(old["kind"], kind)
                self.assertEqual(old["text"], original["text"])
                self.assertEqual(old["snapshot_status"], "invalidated")
                self.assertEqual(old["timing"]["current_status"], "historical")
                self.assertEqual(old["navigation"]["memory_revision"], 2)
                self.assertEqual(old["navigation"]["scope_kind"], "contact" if kind == "confirmed_memory" else "owner")
                self.assertTrue(old["cited"])
                self.assertEqual(evidence["retrieval"]["retriever_version"], "lexical-v1")
                payload = self.reply_model.payloads[-1]
                self.assertIsNone(payload["user_instruction"])
                self.assertEqual(payload["fidelity_contract"]["priority"][:3], [
                    "current_explicit_intent", "expression_instruction", "long_term_expression_preference",
                ])
                self.assertEqual(payload["expression_preferences"][0]["text"], preference_body["text"])
                if kind == "owner_memory":
                    # 当前生成的默认来源门仍拒绝旧本人版本；样本另走显式历史保存。
                    with psycopg.connect(self.database_url) as connection:
                        lock_owner_scope(connection, owner_id=self.owner_id)
                        with self.assertRaises(ReplyStoreInvariantError):
                            require_reply_sources_current(connection, owner_id=self.owner_id,
                                request_id=UUID(turn["reply_request_id"]))
                update = {
                    "operation_key": str(uuid4()), "expected_revision": 1, "text": "用户后续修改的要求。",
                    "scope": preference_body["scope"], "confirm_long_term": True,
                }
                self.assertEqual(self.backend.request(item, update, method="PATCH")[0], 200)
                restarted = self._backend(self.owner_id)
                self.assertEqual(self._get(restarted, evidence_path), evidence)
                self.assertEqual(restarted.request(path + "/replies", body), (200, turn))

                samples = f"/api/contacts/{contact}/style-samples"
                sample_body = {"idempotency_key": str(uuid4()), "text": turn["candidates"][0]["text"],
                    "origin": {"kind": "candidate", "id": turn["candidates"][0]["candidate_id"]}}
                status, sample = restarted.request(samples, sample_body)
                self.assertEqual(status, 200, sample)
                self.assertEqual(restarted.request(path, {"confirmed": True}, method="DELETE")[0], 200)
                self.assertEqual(self._get(restarted, samples)["samples"], [sample["sample"]])
                deletion = {"operation_key": str(uuid4()), "expected_revision": 2}
                self.assertEqual(restarted.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
                self.assertEqual(restarted.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
                self.assertEqual(self._get(restarted, samples)["samples"], [])
                self.assertEqual(restarted.request(samples, sample_body), (410, {"error": "style_sample_deleted"}))
                self.assertEqual(restarted.request(evidence_path)[0], 404)
                self.assertEqual(restarted.request(preference_path, preference_body),
                                 (410, {"error": "expression_preference_deleted"}))
