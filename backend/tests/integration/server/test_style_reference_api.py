"""有界表达参考通过正式 HTTP 生成链；只用合成样本与受控模型。"""

from __future__ import annotations

import unittest
import time
import json
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class StyleReferenceApiTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    def _save(self, contact: str, text: str, *, origin: dict | None = None) -> dict:
        status, result = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": text,
            "origin": origin or {"kind": "manual"},
        })
        self.assertEqual(status, 200, result)
        return result["sample"]

    def _body(self, contact: str) -> dict:
        return {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "initiate_conversation", "purpose": "明确拒绝本次聚会，不增加约定。"},
            "skill_disabled": True,
        }

    def test_bounded_scoped_expression_references_are_separate_from_facts_and_replayed(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        other_contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        samples = [self._save(contact, f"合成表达{i}：我总是答应，明晚七点陪你去合成海边。") for i in range(7)]
        self._save(contact, "合成过长参考" * 130)
        self._save(other_contact, "别的联系人专用表达，不能越权进入本次。")
        self.reply_model.plans.extend([
            {"text": "这次聚会我不参加。", "basis": "保留本次明确拒绝，不从旧说法增加约定。"},
            {"text": "可以啊，明晚七点我陪你去合成海边。", "basis": "沿用旧样本中的约定。"},
        ])
        body = self._body(contact)
        started = time.perf_counter()
        status, result = self.backend.request("/api/reply/generate", body)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertEqual(status, 200, result)
        payload = self.reply_model.payloads[-1]
        references = payload.get("style_references", [])
        self.assertEqual(len(references), 5)
        selected = {row["sample_id"] for row in references}
        self.assertLessEqual(selected, {sample["sample_id"] for sample in samples})
        self.assertLessEqual(sum(len(row["text"]) for row in references), 600)
        for row in references:
            self.assertEqual(row["factual_role"], "expression_reference")
            self.assertEqual(row["weight"], "low")
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], body["content"]["purpose"])
        self.assertEqual([item["kind"] for item in payload["evidence"]], ["user_purpose"])
        self.assertTrue(selected.isdisjoint(result["context_receipt"]["evidence_ids"]))
        self.assertEqual(set(result["context_receipt"]["style_sample_ids"]), selected)
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request("/api/reply/generate", body), (200, result))
        self.assertEqual(len(self.reply_model.payloads), 1)
        evidence_path = f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence"
        evidence_status, evidence = reopened.request(evidence_path)
        self.assertEqual(evidence_status, 200, evidence)
        self.assertEqual(evidence["style_references"], [
            {"sample_id": row["sample_id"], "text": row["text"]} for row in references
        ])
        self._save(contact, "生成之后保存的样本，不得补入历史参考。")
        self.assertEqual(reopened.request(evidence_path), (200, evidence))
        started = time.perf_counter()
        wrong_status, wrong = self.backend.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        wrong_elapsed_ms = (time.perf_counter() - started) * 1000
        # 合法结构/引用仍能承载语义错误，必须由独立逐例标注如实呈现。
        self.assertEqual(wrong_status, 200, wrong)
        self.assertEqual(wrong["candidates"][0]["text"], "可以啊，明晚七点我陪你去合成海边。")
        self.assertEqual(len(self.reply_model.payloads), 2)
        if path := os.environ.get("NOTALONE_STYLE_REFERENCE_CAPTURE"):
            rows = []
            for index, (case_id, output, elapsed) in enumerate((
                ("style-intent-preserve", result, elapsed_ms),
                ("style-unsupported-conflict", wrong, wrong_elapsed_ms),
            )):
                system = "\n".join(str(message.content) for message in self.reply_model.seen_calls[index] if message.type == "system")
                rows.append({"case_id": case_id, "owner_id": str(self.owner_id), "contact_id": contact,
                             "payload": self.reply_model.payloads[index], "system_prompt": system,
                             "output": output, "latency_ms": elapsed, "call_count": 1})
            Path(path).write_text(json.dumps({"data_kind": "synthetic", "data_version": "style-reference-http-v1",
                                             "entry_point": "http", "rows": rows}, ensure_ascii=False, indent=2) + "\n")

    def test_no_samples_preserves_normal_generation(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        self.reply_model.plans.append({"text": "这次我不参加。", "basis": "只保留本次明确意图。"})
        status, result = self.backend.request("/api/reply/generate", self._body(contact))
        self.assertEqual(status, 200, result)
        self.assertEqual(self.reply_model.payloads[-1].get("style_references", []), [])
        self.assertEqual(result["context_receipt"].get("style_sample_ids", []), [])
        evidence_status, evidence = self.backend.request(
            f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence")
        self.assertEqual(evidence_status, 200, evidence)
        self.assertEqual(evidence["style_references"], [])

    def test_legacy_style_snapshot_is_unknown_and_invalid_snapshot_is_not_exposed(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        self._save(contact, "合成表达参考。")
        self.reply_model.plans.append({"text": "这次我不参加。", "basis": "保留当前意图。"})
        status, result = self.backend.request("/api/reply/generate", self._body(contact))
        self.assertEqual(status, 200, result)
        path = f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence"
        # 构造旧版本持久快照，只通过正式 HTTP 判断兼容行为。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.reply_request SET context_snapshot=context_snapshot - 'style_references' WHERE id=%s",
                               (result["reply_request_id"],))
        legacy_status, legacy = self.backend.request(path)
        self.assertEqual(legacy_status, 200, legacy)
        self.assertIsNone(legacy["style_references"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.reply_request SET context_snapshot=jsonb_set(context_snapshot, '{style_references}', %s::jsonb) WHERE id=%s",
                               (json.dumps([{"text": "invalid"}]), result["reply_request_id"]))
        invalid_status, invalid = self.backend.request(path)
        self.assertNotEqual(invalid_status, 200)
        self.assertNotIn("style_references", invalid)

    def test_default_draft_does_not_read_saved_contact_samples(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        self._save(contact, "合成已保存说法，默认纯草稿不读取。")
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "只保留当前原句。"})
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "本次不参加。", "include_relationship_context": False}}
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.reply_model.payloads[-1]["style_references"], [])
        self.assertEqual(result["context_receipt"]["style_sample_ids"], [])

    def test_style_reference_id_cannot_be_cited_as_fact_evidence(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        sample = self._save(contact, "合成说法参考，不具有事实引用资格。")
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "保留本次明确意图。",
                                       "citation_ids": [sample["sample_id"]]})
        status, result = self.backend.request("/api/reply/generate", self._body(contact))
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("candidates", result)
        with psycopg.connect(self.database_url) as connection:
            remaining = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s",
                                           (self.owner_id,)).fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_delete_sample_during_model_refuses_commit_and_retry(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        sample = self._save(contact, "合成竞态表达，只参考说法。")
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "保留当前意图。"})
        body = self._body(contact)
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.backend.request, "/api/reply/generate", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, deleted = self.backend.request(f"/api/contacts/{contact}/style-samples/{sample['sample_id']}", method="DELETE")
                self.assertEqual(status, 200, deleted)
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("candidates", result)
        self.assertNotEqual(self.backend.request("/api/reply/generate", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)
        with psycopg.connect(self.database_url) as connection:
            remaining = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s",
                                           (self.owner_id,)).fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_delete_sample_erases_replay_and_dependent_saved_sample(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        base = self._save(contact, "合成原样本，我习惯简洁表达。")
        self.reply_model.plans.extend([
            {"text": "这次不参加。", "basis": "本次拒绝优先。"},
            {"text": "本次不参加，下次再聊。", "basis": "保留明确意图和条件说法。"},
        ])
        bodies, results = [], []
        for index in range(2):
            body = self._body(contact)
            status, result = self.backend.request("/api/reply/generate", body)
            self.assertEqual(status, 200, result)
            bodies.append(body); results.append(result)
            if index == 0:
                derived = self._save(contact, "候选衍生的合成最终表达。", origin={
                    "kind": "candidate", "id": result["candidates"][0]["candidate_id"],
                })
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{base['sample_id']}", method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{derived['sample_id']}")[0], 410)
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, f"/api/contacts/{contact}/style-samples")["samples"], [])
        for body, result in zip(bodies, results, strict=True):
            self.assertNotEqual(reopened.request("/api/reply/generate", body)[0], 200)
            self.assertNotEqual(reopened.request(f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_sample_original_source_erases_replay_when_not_fact_evidence(self):
        contact, _, source = self.prepare_contact(self.owner_id)
        with psycopg.connect(self.database_url) as connection:
            message_id = connection.execute("SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s ORDER BY occurred_at LIMIT 1",
                                            (self.owner_id, contact)).fetchone()[0]
            connection.execute("UPDATE public.message SET speaker='user' WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, contact, message_id))
        sample = self._save(contact, "合成本人说法，只参考表达。", origin={"kind": "message", "id": str(message_id)})
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "本次我不参加。", "include_relationship_context": True}}
        self.reply_model.plans.append({"text": "这次我不参加。", "basis": "本次原句优先，不增加约定。"})
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        self.assertEqual([item["kind"] for item in self.reply_model.payloads[-1]["evidence"]], ["user_draft"])
        self.assertEqual(result["context_receipt"]["style_sample_ids"], [sample["sample_id"]])
        status, deleted = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, deleted)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            sources = self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
            item = next(row for row in sources if row["source_id"] == source)
            self.assertNotEqual(item["task_status"], "failed", item)
            if item["status"] == "deleted" and item["task_status"] == "succeeded":
                break
            time.sleep(.02)
        else:
            self.fail("本轮合成来源删除未完成。")
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample['sample_id']}")[0], 410)
        self.assertEqual(self._get(self.backend, f"/api/contacts/{contact}/style-samples")["samples"], [])
        self.assertNotEqual(self.backend.request("/api/reply/generate", body)[0], 200)
        self.assertNotEqual(self.backend.request(f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)


if __name__ == "__main__":
    unittest.main()
