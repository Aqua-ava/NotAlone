"""概览与显式准备的组合反例：固定身份、合法来源和删除优先。"""

import json
import unittest
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.source_service import SourceService
from notalone.memory.models import FactSubject
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_historical_reply_basis import CommitBoundaryReplyStore


class OverviewPreparedContextHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def saved_turn(self, receipt):
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            return connection.execute(
                "SELECT * FROM public.assistant_session_turn WHERE owner_id=%s AND id=%s",
                (self.owner_id, receipt["turn_id"]),
            ).fetchone()

    def test_schema_two_is_sealed_on_original_identity_and_keeps_input_without_model(self):
        contact, _, _ = self.import_contact("合成旧格式输入。")
        self.manual_contact(contact, "对方喜欢合成热茶。", category="preference")
        self.activate_replies(contact)
        path, body = self.reply_path(contact), self.rewrite_body(contact, "保留合成草稿编辑。")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        payload = self.saved_turn(receipt)["prepared_context"]
        payload["schema_revision"] = 2
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s WHERE id=%s",
                               (Jsonb(payload), receipt["turn_id"]))
        status, checked = self._backend(self.owner_id).request(path + "/preparation-format", {
            "request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"],
        })
        self.assertEqual(status, 200, checked)
        self.assertEqual(checked["format_status"], "reprepare_required")
        self.assertEqual((checked["turn_id"], checked["request_key"], checked["input_version_id"]),
                         (receipt["turn_id"], receipt["request_key"], receipt["input_version_id"]))
        self.assertIn("保留合成草稿编辑。", str(self.saved_turn(receipt)["input_payload"]))
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 0)

    def test_prepared_ref_or_decision_generation_changes_reject_before_model_and_at_actual_writer(self):
        for phase in ("ref_before_model", "ref_before_writer", "decision_before_model"):
            with self.subTest(phase=phase):
                contact, _, message = self.import_contact("对方喜欢合成热茶。")
                if phase.startswith("decision"):
                    memory = self.manual_contact(contact, "对方喜欢合成热茶。", category="preference")
                    status, corrected = self.backend.request(
                        f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct",
                        {"text": "对方喜欢合成温茶。"})
                    self.assertEqual(status, 200, corrected)
                else:
                    self.confirm(contact, "对方喜欢合成热茶。", message, category="preference")
                store = CommitBoundaryReplyStore(self.database_url)
                with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
                    self.activate_replies(contact)
                path, body = self.reply_path(contact), self.rewrite_body(contact, "对方喜欢合成热茶，想聊热茶。")
                status, receipt = self.backend.request(path + "/replies/prepare", body)
                self.assertEqual(status, 200, receipt)
                before = len(self.reply_model.payloads)

                def change_original_generation():
                    with psycopg.connect(self.database_url) as connection:
                        if phase.startswith("decision"):
                            connection.execute("UPDATE public.memory_correction_decision SET evidence=evidence || %s "
                                "WHERE owner_id=%s AND contact_id=%s",
                                (Jsonb({"synthetic_generation": 2}), self.owner_id, contact))
                        else:
                            connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload || %s "
                                "WHERE owner_id=%s AND contact_id=%s AND message_id=%s",
                                (Jsonb({"synthetic_generation": 2}), self.owner_id, contact, message))

                if phase.endswith("writer"):
                    self.reply_model.plans.append({"text": "合成晚候选。", "basis": "生成时合法资料。"})
                    store.hold_before_commit = True
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pending = pool.submit(self.backend.request, path + "/replies", body)
                        try:
                            self.assertTrue(store.entered.wait(5))
                            change_original_generation()
                        finally:
                            store.release.set()
                        self.assertNotEqual(pending.result(timeout=10)[0], 200)
                    self.assertEqual(len(self.reply_model.payloads), before + 1)
                else:
                    change_original_generation()
                    self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
                    self.assertEqual(len(self.reply_model.payloads), before)

    def test_owner_other_contact_navigation_is_frozen_without_reading_other_raw_messages(self):
        contact, _, _ = self.import_contact("当前关系不包含本人合成偏好。")
        other, _, _ = self.import_contact("另一关系私密合成原话。", owner_text="本人喜欢合成热茶。")
        own = next(item for item in self._get(self.backend, f"/api/contacts/{other}/messages")["messages"]
                   if item["speaker"] == "user")
        memory = self.confirm(other, "本人喜欢合成热茶。", UUID(own["message_id"]),
                              category="preference", subject=FactSubject.SELF)
        self.activate_replies(contact)
        path, body = self.reply_path(contact), self.rewrite_body(contact, "本人喜欢合成热茶，想聊热茶。")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        frozen = self.saved_turn(receipt)["prepared_context"]
        self.assertEqual((frozen["version"], frozen["schema_revision"]), (2, 13))
        self.assertNotIn("另一关系私密合成原话", str(frozen))
        self.assertEqual(frozen["context"]["retrieval"]["fields"]["source_messages"]["fields"]["used_calls"], 0)
        self.reply_model.plans.append({"text": "我喜欢热茶，想听听你的偏好。", "basis": "已保存的本人资料。",
                                       "cite_kinds": ["owner_memory"]})
        status, turn = self._backend(self.owner_id).request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        self.assertEqual(turn["turn_id"], receipt["turn_id"])
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual([item["evidence_id"] for item in evidence["evidence"] if item["kind"] == "owner_memory"],
                         [memory["memory_id"]])
        self.assertFalse(any(item["kind"] == "message" for item in evidence["evidence"]))
        self.assertNotIn("另一关系私密合成原话", str(self.reply_model.payloads))

    def test_corrected_navigation_requires_complete_window_and_active_sources_without_kind_discriminator(self):
        for variant in ("complete", "erased_guard", "missing_window", "missing_source"):
            with self.subTest(variant=variant):
                contact, _, message = self.import_contact("对方喜欢合成热茶。")
                original = self.manual_contact(contact, "对方喜欢合成热茶。", category="preference")
                status, corrected = self.backend.request(
                    f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
                    {"text": "对方喜欢合成温茶。"})
                self.assertEqual(status, 200, corrected)
                self.activate_replies(contact)
                path, body = self.reply_path(contact), self.rewrite_body(contact, "合成温茶。")
                status, receipt = self.backend.request(path + "/replies/prepare", body)
                self.assertEqual(status, 200, receipt)
                frozen = self.saved_turn(receipt)
                self.assertIn(corrected["memory"]["memory_id"], str(frozen["prepared_context"]))
                with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                    decision = connection.execute(
                        "SELECT id,evidence FROM public.memory_correction_decision WHERE owner_id=%s "
                        "AND replacement_memory_id=%s",
                        (self.owner_id, corrected["memory"]["memory_id"]),
                    ).fetchone()
                    self.assertNotIn("kind", decision["evidence"])
                    if variant == "erased_guard":
                        connection.execute("UPDATE public.memory_correction_decision SET decision='rejected', "
                            "rejected_text=NULL,corrected_text=NULL,replacement_memory_id=NULL,evidence=%s WHERE id=%s",
                            (Jsonb({"version": 1, "kind": "erased_guard", "canonical_ids": [str(message)]}), decision["id"]))
                    elif variant == "missing_window":
                        connection.execute("UPDATE public.memory_correction_decision "
                            "SET evidence=evidence-'message_snapshots' WHERE id=%s", (decision["id"],))
                    elif variant == "missing_source":
                        connection.execute("DELETE FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                                           (self.owner_id, decision["evidence"]["source_ids"]))
                self.reply_model.plans.append({"text": "想聊合成温茶。", "basis": "只使用仍合法的修正版。",
                                               "cite_kinds": ["confirmed_memory"]})
                status, result = self._backend(self.owner_id).request(path + "/replies", body)
                if variant == "complete":
                    self.assertEqual(status, 200, result)
                    evidence = self._get(self.backend, self.evidence_path(contact, result))
                    self.assertIn(corrected["memory"]["memory_id"], [item["evidence_id"] for item in evidence["evidence"]])
                else:
                    self.assertNotEqual(status, 200, result)
                    self.assertIsNone(self.saved_turn(receipt)["reply_request_id"])

    def test_prepare_without_reply_request_registers_complete_other_contact_navigation_then_delete_erases_sql(self):
        contact, _, _ = self.import_contact("当前关系只有独立草稿。")
        other, source, _ = self.import_contact("另一关系的合成原话。", owner_text="本人喜欢合成热茶。")
        own = next(item for item in self._get(self.backend, f"/api/contacts/{other}/messages")["messages"]
                   if item["speaker"] == "user")
        self.confirm(other, "本人喜欢合成热茶。", UUID(own["message_id"]),
                     category="preference", subject=FactSubject.SELF)
        self.activate_replies(contact)
        path, body = self.reply_path(contact), self.rewrite_body(contact, "本人喜欢合成热茶，想聊热茶。")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        row = self.saved_turn(receipt)
        self.assertIsNone(row["reply_request_id"])
        navigation = next(item["fields"]["navigation"]["fields"]
                          for item in row["prepared_context"]["context"]["evidence"]
                          if item["fields"]["kind"] == "owner_memory")
        dependencies = {UUID(item["uuid"]) for item in navigation["dependency_ids"]}
        self.assertIn(UUID(source), dependencies)
        self.assertTrue(dependencies <= set(row["dependency_ids"]))
        with patch.object(SourceService, "_start", return_value=None):
            status, queued = self.backend.request(f"/api/contacts/{other}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, queued)
        # 不先 GET：真实删除事务已清除固定正文、输入及其恢复依赖。
        erased = self.saved_turn(receipt)
        self.assertEqual((erased["prepared_context"], erased["input_payload"], erased["dependency_ids"]),
                         (None, None, []))
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT content,dependency_ids FROM public.assistant_session_input WHERE id=%s",
                (receipt["input_version_id"],),
            ).fetchone(), (None, []))
        self.assertNotEqual(self._backend(self.owner_id).request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 0)

    def test_foreign_or_wrong_type_navigation_dependency_is_rejected_before_model(self):
        for variant in ("foreign", "wrong_type", "anchor"):
            with self.subTest(variant=variant):
                contact, _, message = self.import_contact("对方喜欢合成热茶。")
                self.confirm(contact, "对方喜欢合成热茶。", message, category="preference")
                self.activate_replies(contact)
                path, body = self.reply_path(contact), self.rewrite_body(contact, "对方喜欢合成热茶，想聊热茶。")
                status, receipt = self.backend.request(path + "/replies/prepare", body)
                self.assertEqual(status, 200, receipt)
                payload = self.saved_turn(receipt)["prepared_context"]
                nav = next(item["fields"]["navigation"]["fields"] for item in payload["context"]["evidence"]
                           if item["fields"]["navigation"] is not None)
                if variant == "foreign":
                    foreign_owner = uuid4()
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'另一合成用户')", (foreign_owner,))
                    self.addCleanup(self.remove_foreign_owner, foreign_owner)
                    nav["dependency_ids"].append({"uuid": str(foreign_owner)})
                elif variant == "anchor":
                    nav["source_message_ids"] = [{"uuid": str(uuid4())}]
                else:
                    nav["dependency_ids"].append({"uuid": str(self.owner_id)})
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s WHERE id=%s",
                                       (Jsonb(payload), receipt["turn_id"]))
                self.assertNotEqual(self._backend(self.owner_id).request(path + "/replies", body)[0], 200)
                self.assertEqual(len(self.reply_model.payloads), 0)

    def remove_foreign_owner(self, owner_id):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=%s", (owner_id,))

    def test_prepared_source_window_and_tools_exclude_501st_and_later_message_ids_after_restart(self):
        contact, _, anchor = self.import_contact("很早的合成热茶锚点。")
        self.confirm(contact, "合成热茶经历。", anchor)
        locator = self.contact_locators[contact]
        start = datetime(2024, 2, 1, tzinfo=timezone.utc)
        records = []
        for number in range(501):
            when = start + timedelta(seconds=number)
            records.append({"id": {"local_id": number + 1, "server_id_str": uuid4().hex, "talker": locator},
                "create_time": int(when.timestamp()), "is_from_me": number == 0, "kind": "text",
                "sender": "合成用户" if number == 0 else "合成联系人",
                "sender_wxid": f"wxid_overview_owner_{self.owner_id.hex}" if number == 0 else locator, "text": f"合成热茶历史{number}。",
                "time_iso": when.isoformat(), "time": when.strftime("%Y-%m-%d %H:%M:%S")})
        file = self.temporary.name + "/bounded-history.jsonl"
        with open(file, "w", encoding="utf-8") as stream:
            stream.write("\n".join(json.dumps(item, ensure_ascii=False) for item in records))
        status, preview = self.backend.request("/api/imports/preview", {"path": file, "contact_id": contact})
        self.assertEqual(status, 200, preview)
        self.assertTrue(preview["valid"], preview)
        status, imported = self.backend.request("/api/imports/commit", {"path": file, "contact_id": contact,
            "expected_content_sha256": preview["content_sha256"]})
        self.assertEqual(status, 200, imported)
        self.activate_replies(contact)
        path, body = self.reply_path(contact), self.rewrite_body(contact, "合成热茶，想聊热茶。")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        payload = self.saved_turn(receipt)["prepared_context"]["context"]
        frozen_ids = {item["uuid"] for item in payload["history_message_ids"]}
        self.assertEqual(len(frozen_ids), 500)
        self.assertNotIn(str(anchor), frozen_ids)
        self.assertFalse(any(item["fields"]["kind"] == "message" for item in payload["evidence"]))
        _, _, tail = self.import_contact("合成热茶新增尾部。", contact_id=contact,
                                         when=datetime(2026, 1, 1, tzinfo=timezone.utc))
        for number, record in enumerate(records[:2]):
            when = datetime(2023, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=number)
            record.update({"id": {"local_id": number + 1, "server_id_str": uuid4().hex, "talker": locator},
                "create_time": int(when.timestamp()), "text": "本人合成回填。" if number == 0 else "合成热茶新增旧时间。",
                "time_iso": when.isoformat(), "time": when.strftime("%Y-%m-%d %H:%M:%S")})
        with open(file, "w", encoding="utf-8") as stream:
            stream.write("\n".join(json.dumps(item, ensure_ascii=False) for item in records[:2]))
        status, preview = self.backend.request("/api/imports/preview", {"path": file, "contact_id": contact})
        self.assertEqual(status, 200, preview)
        status, imported = self.backend.request("/api/imports/commit", {"path": file, "contact_id": contact,
            "expected_content_sha256": preview["content_sha256"]})
        self.assertEqual(status, 200, imported)
        # 只读取本轮已导入合成行的身份，正文检索结果仍经公开回复 HTTP 验证。
        with psycopg.connect(self.database_url) as connection:
            backfill = connection.execute(
                "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s AND text_content=%s",
                (self.owner_id, contact, "合成热茶新增旧时间。"),
            ).fetchone()[0]
        self.reply_model.plans.extend([
            {"history": {"name": "conversation_search", "args": {"query": "合成热茶", "top_k": 8}}},
            {"history": {"name": "conversation_query", "args": {"session_id": str(self.saved_turn(receipt)["conversation_binding_id"]),
                "anchor_message_id": None, "before": 0, "after": 2}}},
            {"text": "想聊聊茶。", "basis": "使用已冻结的有限历史。"},
        ])
        status, completed = self._backend(self.owner_id).request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        evidence = self._get(self.backend, self.evidence_path(contact, completed))
        actual = {item["evidence_id"] for item in evidence["evidence"] if item["kind"] == "message"}
        self.assertTrue(actual)
        self.assertTrue(actual <= frozen_ids)
        self.assertFalse(actual & {str(anchor), str(tail), str(backfill)})
        self.assertEqual(self.saved_turn(receipt)["prepared_context"]["context"]["history_message_ids"], payload["history_message_ids"])
