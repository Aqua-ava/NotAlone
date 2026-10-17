"""正式 HTTP、隔离 PG 与默认桌面 JsonClient 的长版本传输回归。"""

from __future__ import annotations

import json
import subprocess
import unittest
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.locks import release_global_worker_lock, try_acquire_global_worker_lock
from notalone.persistence.assistant_candidate_versions import read_candidate_version_page
from notalone.scopes import ContactScope

from tests.integration.server import test_assistant_candidate_versions as candidate_support


class AssistantCandidateVersionTransportTest(candidate_support.CandidateVersionHttpFixture, unittest.TestCase):
    def _desktop_rpc(self, contact_id, session_path, candidate_id, **options):
        desktop = Path(__file__).resolve().parents[4] / "desktop"
        return subprocess.run(
            ["node", "tests/fixtures/assistant-candidate-version-http.mjs"],
            cwd=desktop, input=json.dumps({
                "port": urlsplit(self.backend.base_url).port, "token": self.backend.token,
                "contactId": str(contact_id), "sessionId": session_path.rsplit("/", 1)[-1],
                "candidateId": candidate_id, "publicRpc": True, **options,
            }), text=True, capture_output=True, timeout=30,
        )

    def test_three_long_edits_can_save_reread_and_select_original_via_default_json_client(self):
        contact_id, session_path, generated = self._generated()
        candidate_id = generated["candidates"][0]["candidate_id"]
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, candidate_id)
        status, authoritative, headers = self._raw_request(
            session_path + f"/candidates/{candidate_id}/versions",
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)
        self.assertEqual(result.returncode, 0,
                         f"{result.stderr}; 权威HTTP版本数={len(authoritative['versions'])}; "
                         f"真实响应字节={headers['Content-Length']}; "
                         f"聚合正文UTF8字节={sum(len(version['text'].encode()) for version in authoritative['versions'])}")
        self.assertEqual(json.loads(result.stdout)["versionCount"], 4)
        self.assertEqual(json.loads(result.stdout)["totalCharacters"], 196608)
        self.assertEqual(len(authoritative["versions"]), 4)

    def test_maximum_complete_eight_message_group_is_readable_under_one_mib(self):
        self.reply_model.message_texts = tuple(f"合成原消息{number}" for number in range(8))
        contact_id, session_path, generated = self._generated()
        candidate_id = generated["candidates"][0]["candidate_id"]
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, candidate_id, mode="max-group")
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        path = session_path + f"/candidates/{candidate_id}/versions?page=1&through={receipt['defaultVersionId']}"
        status, page, headers = self._raw_request(path)
        self.assertEqual(status, 200)
        self.assertLess(int(headers["Content-Length"]), 1_048_576)
        self.assertGreater(int(headers["Content-Length"]), 810_000)
        self.assertEqual(headers["Cache-Control"], "no-store")
        version = page["versions"][0]
        self.assertEqual([message["message_id"] for message in version["messages"]],
                         [message["message_id"] for message in generated["candidates"][0]["messages"]])
        self.assertEqual([len(message["text"]) for message in version["messages"]], [8192] * 7 + [8178])
        self.assertEqual(len(version["text"]), 65536)
        self.assertEqual(version["requirements"], "\x01" * 4096)
        self.assertEqual(page["version_count"], 2)
        self.assertIsNone(page["next_page"])
        status, rejected = self.backend.request(session_path + f"/candidates/{candidate_id}/versions?receipt=1", {
            "edit_key": str(uuid4()), "parent_version_id": receipt["defaultVersionId"],
            "messages": [{"message_id": message["message_id"], "text": "\x01" * 8192}
                         for message in version["messages"]],
        })
        # 八条各自达上限时，加上消息分隔符已超整组上限，不能当成合法单版证明。
        self.assertEqual((status, rejected), (400, {"error": "assistant_candidate_version_request_invalid"}))
        self.assertEqual(self._get(self.backend, session_path + f"/candidates/{candidate_id}/versions?page=0")["version_count"], 2)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)
        print(f"candidate_max_group: response_bytes={headers['Content-Length']} messages=8 model_delta=0", flush=True)

    def test_legal_full_unicode_version_is_readable_without_utf16_count_truncation(self):
        contact_id, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        path = session_path + f"/candidates/{candidate['candidate_id']}/versions?receipt=1"
        text = "😀" * 65536
        status, receipt = self.backend.request(path, {
            "edit_key": str(uuid4()), "parent_version_id": candidate["candidate_id"],
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": text}],
        })
        self.assertEqual(status, 200)
        result = self._desktop_rpc(contact_id, session_path, candidate["candidate_id"],
                                   mode="read-existing", expectedText=text, expectedVersionCount=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["versionCount"], 2)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def _source_middle_page(self, mode):
        self.reply_model.message_texts = ("独立合成讨论候选。",)
        contact_id, session_path, independent = self._generated()
        source_id, message_id = self._source_message(contact_id)
        self.reply_model.message_texts = ("来自待删来源的候选。",)
        _, _, dependent = self._generated(contact_id=contact_id, content={
            "type": "reply_to_message", "target_message_id": str(message_id),
            "direction": "按本次合成消息自然回应。",
        })
        model_calls = len(self.reply_model.seen_calls)
        gate_context = (psycopg.connect(self.database_url, autocommit=True)
                        if mode == "source-pending" else nullcontext())
        with gate_context as gate:
            if gate is not None:
                self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                result = self._desktop_rpc(contact_id, session_path, dependent["candidates"][0]["candidate_id"],
                                           mode=mode, sourceId=str(source_id),
                                           independentCandidateId=independent["candidates"][0]["candidate_id"])
                self.assertEqual(result.returncode, 0, result.stderr)
            finally:
                if gate is not None:
                    release_global_worker_lock(gate)
        self._finish_source_delete(contact_id, source_id)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)
        self.assertEqual(self.backend.request(session_path + f"/candidates/{dependent['candidates'][0]['candidate_id']}/versions?page=0")[0], 404)
        self.assertEqual(self.backend.request(session_path + f"/candidates/{independent['candidates'][0]['candidate_id']}/versions?page=0")[0], 200)

    def test_middle_page_404_discards_accumulated_body_and_main_keeps_independent_discussion(self):
        self._source_middle_page("source-deleted")

    def test_pending_source_delete_discards_accumulated_body_and_keeps_independent_discussion(self):
        self._source_middle_page("source-pending")

    def test_middle_page_unknown_transport_failure_allows_exact_scope_public_retry(self):
        contact_id, session_path, generated = self._generated()
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, generated["candidates"][0]["candidate_id"], mode="unknown-retry")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["versionCount"], 4)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)

    def test_middle_page_late_scope_cannot_publish_old_body_into_new_contact(self):
        contact_id, session_path, generated = self._generated()
        other_contact, _, _ = self._generated()
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, generated["candidates"][0]["candidate_id"],
                                   mode="late-scope", otherContactId=str(other_contact))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)

    def test_middle_page_late_operation_keeps_new_read_actual_selection_and_user_show_old(self):
        contact_id, session_path, generated = self._generated()
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, generated["candidates"][0]["candidate_id"], mode="late-operation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)

    def test_middle_page_late_connection_generation_cannot_republish_old_projection(self):
        contact_id, session_path, generated = self._generated()
        model_calls = len(self.reply_model.seen_calls)
        result = self._desktop_rpc(contact_id, session_path, generated["candidates"][0]["candidate_id"], mode="late-generation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.reply_model.seen_calls), model_calls)

    def test_pages_are_read_only_and_anchor_survives_newer_edit_without_losing_full_reread(self):
        contact_id, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        # 在只读事务也必须能读取原版，不能靠 GET 隐式创建原版引用。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("SET TRANSACTION READ ONLY")
            original = read_candidate_version_page(
                connection, ContactScope(self.owner_id, contact_id), UUID(session_path.rsplit("/", 1)[-1]),
                UUID(candidate_id), 0,
            )
            self.assertEqual(original.history.versions[0].messages[0].text, "明天见。")
        command = {"edit_key": str(uuid4()), "parent_version_id": candidate_id,
                   "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "合成旧锚点正文"}],
                   "requirements": "合成旧锚点要求"}
        status, first_receipt, headers = self._raw_request(path + "?receipt=1", method="POST", body=json.dumps(command).encode())
        self.assertEqual(status, 200)
        self.assertLess(int(headers["Content-Length"]), 1024)
        self.assertEqual(set(first_receipt), {"session_id", "candidate_id", "version_id", "version_number", "edit_key", "parent_version_id"})
        page = self._get(self.backend, path + "?page=0")
        self.assertEqual(page["version_count"], 2)
        anchor = page["default_display_version_id"]
        newer = {**command, "edit_key": str(uuid4()), "parent_version_id": anchor,
                 "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "合成新增正文"}]}
        status, second = self.backend.request(path + "?receipt=1", newer)
        self.assertEqual(status, 200)
        old_page = self._get(self.backend, path + f"?page=1&through={anchor}")
        self.assertEqual(old_page["version_count"], 2)
        self.assertEqual(old_page["default_display_version_id"], anchor)
        self.assertIsNone(old_page["next_page"])
        self.assertEqual(old_page["versions"][0]["text"], "合成旧锚点正文")
        latest = self._get(self.backend, path + "?page=0")
        self.assertEqual(latest["version_count"], 3)
        self.assertEqual(latest["default_display_version_id"], second["version_id"])
        self.assertEqual(self.backend.request(path + "?receipt=1", command), (200, first_receipt))
        self.assertEqual(self._get(self.backend, path + "?page=0"), latest)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_new_page_and_receipt_routes_reject_foreign_scope_and_invalid_queries(self):
        contact_id, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        path = session_path + f"/candidates/{candidate['candidate_id']}/versions"
        invalid = (400, {"error": "assistant_candidate_version_request_invalid"})
        for query in ["page=", "page=-1", "page=one", "page=1", "page=0&page=0", "page=0&through=bad", "page=0&other=1", "receipt=1"]:
            self.assertEqual(self.backend.request(path + "?" + query), invalid)
        command = {"edit_key": str(uuid4()), "parent_version_id": candidate["candidate_id"],
                   "messages": candidate["messages"], "requirements": None}
        for query in ["receipt=0", "receipt=1&page=0", "page=0"]:
            self.assertEqual(self.backend.request(path + "?" + query, command), invalid)
        self.assertEqual(self.other_backend.request(path + "?page=0"), (404, {"error": "not_found"}))
        self.assertEqual(self.other_backend.request(path + "?receipt=1", command), (404, {"error": "not_found"}))
        foreign_contact = self._contact()
        self.assertEqual(self.backend.request(path.replace(str(contact_id), str(foreign_contact)) + "?page=0"), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(path + f"?page=0&through={uuid4()}"), (404, {"error": "not_found"}))
        self.assertEqual(self._get(self.backend, path + "?page=0")["version_count"], 1)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
