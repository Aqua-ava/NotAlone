"""实际样本生成派生的053消息组版本沿唯一样本／原始来源删除链清理。"""

from __future__ import annotations

import time
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateVersionError, EditAssistantCandidate, PostgresAssistantCandidateVersions,
)
from notalone.reply.interface import CandidateMessage
from notalone.scopes import ContactScope
from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionCandidateVersionTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def test_deleted_style_sample_erases_actual_edited_group_and_selection_without_deleting_raw_source(self):
        self._exercise("sample")

    def test_deleted_raw_source_erases_actual_edited_group_and_selection_but_keeps_manual_sample(self):
        self._exercise("source")

    def _exercise(self, removal: str) -> None:
        contact, target, source = self.prepare_contact(self.owner_id)
        status, sample = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成旧表达：当然答应，明晚七点陪同。", "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, sample)
        sample_id = sample["sample"]["sample_id"]
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "reply_to_message", "target_message_id": target,
                            "direction": "当前拒绝，不新增约定。"}}
        self.reply_model.plans.append({"text": "这次不参加。\n\n谢谢你邀请。", "messages": ["这次不参加。", "谢谢你邀请。"],
                                       "basis": "只保留当前明确拒绝，样本仅供说法参考。"})
        status, generated = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["context_receipt"]["style_sample_ids"], [sample_id])
        candidate = generated["candidates"][0]
        scope = ContactScope(self.owner_id, UUID(contact))
        session_id, candidate_id = UUID(session["session_id"]), UUID(candidate["candidate_id"])
        versions_path = path + f"/candidates/{candidate_id}/versions"
        status, public_original = self.backend.request(versions_path)
        self.assertEqual(status, 200, public_original)
        self.assertEqual(public_original["candidate_id"], str(candidate_id))
        self.assertIsNone(public_original["selected_version_id"])
        adapter = PostgresAssistantCandidateVersions(self.database_url)
        original = adapter.read(scope, session_id, candidate_id)
        self.assertEqual(public_original["candidate_group_id"], str(original.candidate_group_id))
        self.assertIsNone(original.selected_version_id)
        self.assertEqual(len(original.versions), 1)
        self.assertEqual(public_original["versions"][0]["version_id"], str(original.versions[0].version_id))
        self.assertEqual([str(message.message_id) for message in original.versions[0].messages],
                         [message["message_id"] for message in candidate["messages"]])
        command = EditAssistantCandidate(edit_key=uuid4(), parent_version_id=original.versions[0].version_id,
            messages=tuple(CandidateMessage(message.message_id, text) for message, text in zip(
                original.versions[0].messages, ["这次不参加。", "谢谢。"], strict=True)), requirements="改成短句，仍然拒绝。")
        edit_body = {"edit_key": str(command.edit_key), "parent_version_id": str(command.parent_version_id),
                     "messages": [{"message_id": str(message.message_id), "text": message.text}
                                  for message in command.messages], "requirements": command.requirements}
        status, public_edited = self.backend.request(versions_path, edit_body)
        self.assertEqual(status, 200, public_edited)
        self.assertIsNone(public_edited["selected_version_id"])
        self.assertEqual(len(public_edited["versions"]), 2)
        edited = adapter.edit(scope, session_id, candidate_id, command)
        self.assertIsNone(edited.selected_version_id)
        self.assertEqual(len(edited.versions), 2)
        version = edited.versions[-1]
        self.assertEqual(version.messages, command.messages)
        self.assertEqual(version.requirements, command.requirements)
        self.assertEqual(public_edited["versions"][-1]["version_id"], str(version.version_id))
        self.assertEqual(public_edited["versions"][-1]["parent_version_id"], str(command.parent_version_id))
        self.assertEqual(public_edited["versions"][-1]["messages"], edit_body["messages"])
        self.assertEqual(public_edited["versions"][-1]["requirements"], command.requirements)
        selection_key = uuid4()
        selection_body = {"selection_key": str(selection_key), "candidate_id": str(candidate_id),
                          "version_id": public_edited["versions"][-1]["version_id"]}
        status, public_selected = self.backend.request(path + "/selections", selection_body)
        self.assertEqual(status, 200, public_selected)
        selected = adapter.select(scope, session_id, candidate_id, version.version_id, selection_key)
        self.assertEqual(public_selected["selection_id"], str(selected.selection_id))
        self.assertEqual(public_selected["selection_number"], selected.selection_number)
        self.assertEqual(public_selected["version_id"], str(selected.version_id))
        reopened = PostgresAssistantCandidateVersions(self.database_url)
        self.assertEqual(reopened.selected(scope, session_id), selected)
        self.assertEqual(reopened.edit(scope, session_id, candidate_id, command).versions, edited.versions)
        reopened_backend = self._backend(self.owner_id)
        status, public_reopened = reopened_backend.request(versions_path)
        self.assertEqual(status, 200, public_reopened)
        self.assertEqual(public_reopened["versions"], public_edited["versions"])
        self.assertEqual(public_reopened["selected_version_id"], str(version.version_id))
        status, public_replayed = reopened_backend.request(versions_path, edit_body)
        self.assertEqual(status, 200, public_replayed)
        self.assertEqual(public_replayed["versions"], public_edited["versions"])
        self.assertEqual(reopened_backend.request(path + "/selections", selection_body), (200, public_selected))
        self.assertEqual(len(self.reply_model.payloads), 1)
        status, derived = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": version.text, "origin": {"kind": "candidate", "id": str(candidate_id)},
        })
        self.assertEqual(status, 200, derived)
        self.assertIn(source, derived["sample"]["source_ids"])
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("""SELECT message_group,requirements FROM public.assistant_candidate_version
                WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND version_number>0""",
                (self.owner_id, contact, session_id)).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual([message["text"] for message in rows[0][0]], ["这次不参加。", "谢谢。"])
            self.assertEqual(rows[0][1], command.requirements)
            self.assertEqual(connection.execute("""SELECT count(*) FROM public.assistant_candidate_selection
                WHERE owner_id=%s AND contact_id=%s AND session_id=%s""", (self.owner_id, contact, session_id)).fetchone()[0], 1)

        if removal == "sample":
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
            raw = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"] if item["source_id"] == source)
            self.assertEqual(raw["status"], "active")
        else:
            status, receipt = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
            self.assertEqual(status, 202, receipt)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                raw = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"] if item["source_id"] == source)
                self.assertNotEqual(raw["task_status"], "failed", raw)
                if raw["status"] == "deleted" and raw["task_status"] == "succeeded":
                    break
                time.sleep(.02)
            else:
                self.fail("本轮合成原始来源删除尚未完成。")
            self.assertEqual(self._get(self.backend, f"/api/contacts/{contact}/style-samples/{sample_id}")["sample"], sample["sample"])
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{derived['sample']['sample_id']}")[0], 410)
        with psycopg.connect(self.database_url) as connection:
            for table in ("assistant_candidate_version", "assistant_candidate_selection"):
                self.assertEqual(connection.execute(f"SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s AND session_id=%s",
                    (self.owner_id, contact, session_id)).fetchone()[0], 0)
        for action in (lambda: reopened.read(scope, session_id, candidate_id),
                       lambda: reopened.edit(scope, session_id, candidate_id, command),
                       lambda: reopened.select(scope, session_id, candidate_id, version.version_id, selection_key)):
            with self.assertRaises(AssistantCandidateVersionError):
                action()
        self.assertIsNone(reopened.selected(scope, session_id))
        self.assertEqual(reopened_backend.request(versions_path)[0], 404)
        self.assertEqual(reopened_backend.request(versions_path, edit_body)[0], 404)
        self.assertEqual(reopened_backend.request(path + "/selections", selection_body)[0], 404)
        after = self._get(self._backend(self.owner_id), path)
        self.assertEqual(len(after["turns"]), 1)
        self.assertEqual(after["turns"][0]["state"], "redacted")
        self.assertIsNone(after["turns"][0]["input"])
        self.assertIsNone(after["turns"][0]["reply"])
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertNotEqual(self.backend.request(f"/api/contacts/{contact}/replies/{generated['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)


if __name__ == "__main__":
    unittest.main()
