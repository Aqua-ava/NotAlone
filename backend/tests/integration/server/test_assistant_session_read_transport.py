"""完整保存历史通过真实认证 HTTP 与默认桌面 JsonClient 读取。"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server import test_assistant_input_budget as budget_fixture
from notalone.persistence.locks import release_global_worker_lock, try_acquire_global_worker_lock


class AssistantSessionReadTransportTest(FidelityHttpFixture, unittest.TestCase):
    """仅模型边界使用合成适配器，业务经生产装配与隔离 PG。"""

    reply_model_factory = budget_fixture.BudgetHttpModel

    @classmethod
    def setUpClass(cls) -> None:
        cls.database_url = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
        if not cls.database_url:
            raise unittest.SkipTest("必须显式指定隔离 PostgreSQL 测试库。")
        with psycopg.connect(cls.database_url) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("完整历史 HTTP 验收只允许隔离 _test 数据库。")

    def _budget_backend(self, owner_id, **options):
        return budget_fixture.AssistantInputBudgetHttpTest._budget_backend(self, owner_id, **options)

    def _backend(self, owner_id):
        return self._budget_backend(owner_id)[0]

    def _session(self, backend):
        return budget_fixture.AssistantInputBudgetHttpTest._session(self, backend)

    def _desktop_read(self, contact_id, path, *, backend=None, **options):
        backend = backend or self.backend
        desktop = Path(__file__).resolve().parents[4] / "desktop"
        # 父 runner 和这里的 Node 子进程复用同一追踪清理函数。
        launcher = (
            "import {spawnSync} from 'node:child_process';"
            "import {withoutExternalTracing} from './scripts/test-environment.mjs';"
            "const run=spawnSync(process.execPath,[process.argv[1]],"
            "{env:withoutExternalTracing({...process.env,NOTALONE_DISABLE_DOTENV:'1'}),stdio:'inherit'});"
            "process.exitCode=run.status??2;"
        )
        return subprocess.run(
            ["node", "--input-type=module", "-e", launcher,
             "tests/fixtures/assistant-session-read-http.mjs"],
            cwd=desktop, input=json.dumps({
                "port": urlsplit(backend.base_url).port, "token": backend.token,
                "contactId": contact_id, "sessionId": path.rsplit("/", 1)[-1], **options,
            }), text=True, capture_output=True, timeout=40,
        )

    def _raw_request(self, path, *, backend=None, body=None, method="GET", authorized=True):
        backend = backend or self.backend
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = f"Bearer {backend.token}"
        request = Request(backend.base_url + path, method=method, headers=headers,
                          data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"))
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            wire = response.read()
            return response.status, json.loads(wire), response.headers, wire

    def _bounded_wire(self, path, *, backend=None):
        fragments, sizes = [], []
        number, anchor = 0, ""
        while True:
            status, part, headers, wire = self._raw_request(
                path + f"?read_part={number}{anchor}", backend=backend,
            )
            self.assertEqual(status, 200)
            self.assertEqual(part["part_number"], number)
            self.assertLess(len(wire), 1_048_576)
            self.assertEqual(int(headers["Content-Length"]), len(wire))
            self.assertEqual(headers["Cache-Control"], "no-store")
            fragment = part["payload_fragment"].encode("utf-8")
            self.assertLessEqual(len(fragment), 256 * 1024)
            fragments.append(fragment)
            sizes.append(len(wire))
            anchor = "&read_id=" + part["read_id"]
            if part["next_part"] is None:
                complete = b"".join(fragments)
                self.assertEqual(part["payload_bytes"], len(complete))
                self.assertEqual(part["read_id"], hashlib.sha256(complete).hexdigest())
                return complete, sizes
            number += 1

    def _large_session(self, *, with_source=False):
        contact_id, target_id, source_id = self.prepare_contact(self.owner_id, history=with_source)
        status, session = self.backend.request(f"/api/contacts/{contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200)
        path = f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"
        texts, ids = [letter * 100_000 for letter in "甲乙丙丁"], []
        for text in texts:
            status, created = self.backend.request(path + "/inputs", {
                "content": {"type": "purpose_exploration", "purpose_hint": text},
            })
            self.assertEqual(status, 200)
            ids.append(created["input_version_id"])
        if with_source:
            status, dependent = self.backend.request(path + "/inputs", {
                "expected_input_version_id": ids[-1],
                "content": {"type": "response_exploration", "target_message_id": target_id,
                            "requirements": "本轮来源相关合成要求，删除后不能恢复。"},
            })
            self.assertEqual(status, 200)
            ids.append(dependent["input_version_id"])
        return contact_id, path, texts, ids, source_id

    def _finish_source_delete(self, contact_id, source_id):
        self.assertEqual(self.backend.request(f"/api/contacts/{contact_id}/sources/{source_id}", method="DELETE")[0], 202)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, sources = self.backend.request(f"/api/contacts/{contact_id}/sources")
            self.assertEqual(status, 200)
            source = next(item for item in sources["sources"] if item["source_id"] == source_id)
            self.assertNotEqual(source["task_status"], "failed")
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                return
            time.sleep(.02)
        self.fail("合成历史来源删除未在时限内完成。")

    def _guard_read(self, contact_id, path, ids, mode, **options):
        result = self._desktop_read(contact_id, path, expectedInputIds=ids, mode=mode, **options)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["triggered"])
        self.assertEqual(self.reply_model.seen_model_payloads, [])
        return json.loads(result.stdout)

    def test_complete_aggregate_over_one_mib_is_readable_through_public_rpc(self):
        contact_id, path = self._session(self.backend)
        texts = [letter * 100_000 for letter in "甲乙丙丁"]
        expected_ids = []
        for text in texts:
            status, created = self.backend.request(path + "/inputs", {
                "content": {"type": "purpose_exploration", "purpose_hint": text},
            })
            self.assertEqual(status, 200)
            expected_ids.append(created["input_version_id"])
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200)
        self.assertGreater(len(json.dumps(saved, ensure_ascii=False).encode("utf-8")), 1_048_576)

        result = self._desktop_read(contact_id, path, expectedTexts=texts, expectedInputIds=expected_ids)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["inputCount"], 4)
        self.assertEqual(self.reply_model.seen_model_payloads, [])

    def test_one_legal_saved_turn_over_one_mib_keeps_its_full_input_and_original_message(self):
        large, _ = self._budget_backend(self.owner_id, capacity=5_000_000)
        contact_id, path = self._session(large)
        draft = "合成完整原句：" + "甲" * 100_000
        candidate = "\x01" * 65_536
        self.reply_model.plans = [{"text": candidate, "basis": "合成完整原版，不代表发送。"}]
        status, completed = large.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": draft},
        })
        self.assertEqual(status, 200)
        status, saved, _, original_wire = self._raw_request(path, backend=large)
        self.assertEqual(status, 200)
        self.assertEqual(len(saved["turns"]), 1)
        self.assertGreater(len(json.dumps(saved["turns"][0], ensure_ascii=False).encode("utf-8")), 1_048_576)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"][0]["messages"][0]["text"], candidate)

        result = self._desktop_read(contact_id, path, backend=large,
                                    expectedInputIds=[completed["input_version_id"]],
                                    expectedDrafts=[draft], expectedCandidates=[candidate],
                                    expectedWireSha=hashlib.sha256(original_wire).hexdigest())

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["turnCount"], 1)
        bounded, sizes = self._bounded_wire(path, backend=large)
        self.assertEqual(bounded, original_wire)
        self.assertGreater(len(sizes), 1)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        print(f"saved_turn_transport: wire_bytes={len(original_wire)} max_response_bytes={max(sizes)} "
              f"parts={len(sizes)} model_delta=0", flush=True)

    def test_unicode_and_json_escapes_reassemble_exact_wire_under_default_cap(self):
        contact_id, path = self._session(self.backend)
        texts = ["\\\"" * 150_000, "\x01\b\f\n\r\t\\\"" * 40_000, "😀中𐍈" * 80_000]
        expected_ids = []
        for text in texts:
            body = {"content": {"type": "purpose_exploration", "purpose_hint": text}}
            self.assertLess(len(json.dumps(body, ensure_ascii=False).encode("utf-8")), 1_048_576)
            status, created, _, _ = self._raw_request(path + "/inputs", body=body, method="POST")
            self.assertEqual(status, 200)
            expected_ids.append(created["input_version_id"])
        status, _, _, original_wire = self._raw_request(path)
        self.assertEqual(status, 200)
        self.assertGreater(len(original_wire), 1_048_576)

        result = self._desktop_read(contact_id, path, expectedTexts=texts, expectedInputIds=expected_ids,
                                    expectedWireSha=hashlib.sha256(original_wire).hexdigest())

        self.assertEqual(result.returncode, 0, result.stderr)
        complete, sizes = self._bounded_wire(path)
        self.assertEqual(complete, original_wire)
        self.assertGreater(max(sizes), 500_000)
        self.assertEqual(self.reply_model.seen_model_payloads, [])
        print(f"saved_escape_transport: wire_bytes={len(original_wire)} max_response_bytes={max(sizes)} "
              f"parts={len(sizes)} model_delta=0", flush=True)

    def test_full_saved_history_still_exceeds_budget_while_public_blank_session_can_generate(self):
        counters = []
        limited, decisions = self._budget_backend(self.owner_id, capacity=100_000, counters=counters)
        contact_id, path = self._session(limited)
        texts = [letter * 100_000 for letter in "甲乙丙丁"]
        ids = []
        for text in texts:
            status, created = limited.request(path + "/inputs", {
                "content": {"type": "purpose_exploration", "purpose_hint": text},
            })
            self.assertEqual(status, 200)
            ids.append(created["input_version_id"])
        self.reply_model.plans = [{"text": "合成新开始的简短候选。", "basis": "仅依照新的用户原句。"}]

        status, blocked = limited.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "expected_input_version_id": ids[-1],
            "content": {"type": "rewrite_draft", "draft_text": "合成旧会话当前简短草稿。"},
        })

        self.assertEqual(status, 409)
        self.assertEqual(blocked["error"], "input_budget_exceeded")
        self.assertGreater(blocked["input_budget"]["total_tokens"], 100_000)
        self.assertEqual(self.reply_model.seen_model_payloads, [])
        self.assertEqual(len(decisions), 1)
        attempted = json.loads(next(message["content"] for message in counters[0].seen_payloads[0]["messages"]
                                    if message["role"] == "user"))
        self.assertEqual([json.loads(item["text"])["purpose_hint"]
                          for item in attempted["assistant_discussion"]["items"]], texts)
        status, saved = limited.request(path)
        self.assertEqual(status, 200)
        ids.append(saved["current_input_version_id"])
        self.assertEqual(saved["turns"][0]["state"], "failed")
        result = self._desktop_read(contact_id, path, backend=limited, expectedTexts=texts,
                                    expectedInputIds=ids, expectedDrafts=["合成旧会话当前简短草稿。"],
                                    expectedCandidates=[None], expectedStates=["failed"],
                                    newDraft="合成新开始的简短原句。")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        new_input = json.loads(next(message["content"] for message in self.reply_model.seen_model_payloads[0]["messages"]
                                   if message["role"] == "user"))
        self.assertEqual(new_input["assistant_discussion"]["items"], [])
        self.assertEqual(new_input["draft_text"], "合成新开始的简短原句。")
        self.assertEqual(len(decisions), 2)
        self.assertEqual(decisions[-1].state.value, "ready")
        self.assertEqual(limited.request(path), (200, saved))

    def test_source_deletion_during_parts_discards_partial_body_and_rebuild_keeps_only_unrelated_history(self):
        contact_id, path, texts, ids, source_id = self._large_session(with_source=True)

        self._guard_read(contact_id, path, ids, "source-deleted", sourceId=source_id)

        self._finish_source_delete(contact_id, source_id)
        result = self._desktop_read(contact_id, path, expectedTexts=texts, expectedInputIds=ids,
                                    expectedCurrentInputId=None, expectedRedactedId=ids[-1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.reply_model.seen_model_payloads, [])

    def test_pending_source_deletion_also_discards_partial_body_before_physical_cleanup(self):
        contact_id, path, _, ids, source_id = self._large_session(with_source=True)
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                self._guard_read(contact_id, path, ids, "source-pending", sourceId=source_id)
                status, saved = self.backend.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(saved["inputs"][-1]["state"], "unavailable")
                self.assertIsNone(saved["inputs"][-1]["content"])
            finally:
                release_global_worker_lock(gate)
        self._finish_source_delete(contact_id, source_id)
        self.assertEqual(self.reply_model.seen_model_payloads, [])

    def test_final_body_received_before_source_deletion_is_revalidated_before_publish(self):
        contact_id, path, _, ids, source_id = self._large_session(with_source=True)

        feedback = self._guard_read(contact_id, path, ids, "final-source-deleted", sourceId=source_id)

        self.assertEqual(feedback["phase"], "failed")
        self._finish_source_delete(contact_id, source_id)

    def test_session_deletion_during_parts_never_publishes_accumulated_body(self):
        contact_id, path, _, ids, _ = self._large_session()

        self._guard_read(contact_id, path, ids, "session-deleted")

        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))

    def test_current_input_change_during_parts_requires_a_fresh_complete_read(self):
        contact_id, path, _, ids, _ = self._large_session()

        self._guard_read(contact_id, path, ids, "current-changed")

        status, saved = self.backend.request(path)
        self.assertEqual(status, 200)
        self.assertNotEqual(saved["current_input_version_id"], ids[-1])
        self.assertEqual(saved["inputs"][-1]["content"]["purpose_hint"], "新的合成讨论，应覆盖迟到读取。")

    def test_late_body_does_not_overwrite_a_new_contact_current_or_connection(self):
        for mode in ("late-contact", "late-operation", "late-generation"):
            with self.subTest(mode=mode):
                contact_id, path, _, ids, _ = self._large_session()
                other_contact, _, _ = self.prepare_contact(self.owner_id, history=False)
                feedback = self._guard_read(contact_id, path, ids, mode, otherContactId=other_contact)
                self.assertEqual(feedback["phase"], "ready")

    def test_malformed_or_changed_fragment_metadata_never_becomes_a_partial_saved_view(self):
        contact_id, path, _, ids, _ = self._large_session()
        for mode in ("invalid-session", "invalid-current", "invalid-order", "invalid-count", "invalid-bytes",
                     "invalid-fragment", "invalid-id", "invalid-surrogate", "invalid-fields"):
            with self.subTest(mode=mode):
                self._guard_read(contact_id, path, ids, mode)

    def test_fragment_queries_are_strict_and_existing_authentication_scope_still_applies(self):
        contact_id, path, _, _, _ = self._large_session()
        status, first, _, _ = self._raw_request(path + "?read_part=0")
        self.assertEqual(status, 200)
        anchor = first["read_id"]
        for query in ("read_part=", "read_part=-1", "read_part=00", "read_part=%EF%BC%90", "read_part=1",
                      "read_part=0&read_part=0", "read_part=0&read_id=bad", "read_part=0&extra=1",
                      "read_part=9007199254740992", f"read_part=1000&read_id={anchor}", "read_id=" + anchor):
            with self.subTest(query=query):
                self.assertEqual(self.backend.request(path + "?" + query),
                                 (400, {"error": "assistant_session_request_invalid"}))
        read_path = path + "?read_part=1&read_id=" + anchor
        self.assertEqual(self._raw_request(read_path, authorized=False)[0], 401)
        self.assertEqual(self.other_backend.request(read_path), (404, {"error": "not_found"}))
        other_contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        self.assertEqual(self.backend.request(read_path.replace(contact_id, other_contact)), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(read_path.replace(path.rsplit("/", 1)[-1], str(uuid4()))),
                         (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(path + "?read_part=0&read_id=" + "0" * 64),
                         (409, {"error": "assistant_session_read_changed"}))
        self.assertEqual(self.reply_model.seen_model_payloads, [])

    def test_hard_rejected_large_history_still_allows_complete_edit_and_fresh_version_recovery(self):
        large, _ = self._budget_backend(self.owner_id, capacity=5_000_000)
        contact_id, path = self._session(large)
        draft, candidate, edit = "甲" * 100_000, "\x01" * 65_536, "乙" * 65_536
        self.reply_model.plans = [{"text": candidate, "basis": "合成完整候选及编辑范围。"}]
        status, generated = large.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": draft},
        })
        self.assertEqual(status, 200)
        limited, _ = self._budget_backend(self.owner_id, capacity=100_000)
        status, blocked = limited.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "expected_input_version_id": generated["input_version_id"],
            "content": {"type": "rewrite_draft", "draft_text": "合成超限后的简短原句。"},
        })
        self.assertEqual(status, 409)
        self.assertEqual(blocked["error"], "input_budget_exceeded")
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        status, saved, _, wire = self._raw_request(path, backend=limited)
        self.assertEqual(status, 200)
        self.assertGreater(len(wire), 1_048_576)
        options = {
            "expectedInputIds": [generated["input_version_id"], saved["current_input_version_id"]],
            "expectedDrafts": [draft, "合成超限后的简短原句。"],
            "expectedCandidates": [candidate, None], "expectedStates": ["completed", "failed"],
        }

        edited = self._desktop_read(contact_id, path, backend=limited, editText=edit, **options)
        rebuilt = self._desktop_read(contact_id, path, backend=limited,
                                     expectedVersionTexts=[candidate, edit], **options)

        self.assertEqual(edited.returncode, 0, edited.stderr)
        self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)

    def test_server_error_named_like_a_transport_limit_does_not_start_fragment_fallback(self):
        contact_id, path, _, ids, _ = self._large_session()

        self._guard_read(contact_id, path, ids, "misleading-oversize-code")

    def test_oversized_server_error_keeps_http_status_and_does_not_start_fragment_fallback(self):
        contact_id, path, _, ids, _ = self._large_session()

        self._guard_read(contact_id, path, ids, "oversized-server-error")


if __name__ == "__main__":
    unittest.main()
