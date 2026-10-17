"""同句不同前文的真实探索／生成捕获，只以独立合成标注报告质量未知。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import UUID, uuid4

import psycopg

from notalone.reply.fidelity_evaluation import require_unlabelled_input
from tests.fidelity_capture import capture_report
from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


CONTEXTS = {
    "resolved": [
        ("user", "修好了，刚发给你，你试试。"),
        ("contact", "打开了，数据也都在。"),
    ],
    "missed": [
        ("contact", "已经八点了，你在哪？"),
        ("user", "忘了告诉你，我跟别人吃饭去了，今晚不来了。"),
    ],
    "unknown": [],
}
PLANS = [
    ("same-quote-resolved", "resolved", "刚确认表格已打开，可能是在认可帮助；具体语气仍未知。",
     "只确认问题已解决，不扩大为长期承诺。", "打开就好，下午交表顺利。"),
    ("same-quote-missed", "missed", "前文是失约及事后告知，对方可能表示不满；动机和后续意愿未知。",
     "只为本次失约道歉，不作补偿或长期保证。", "这次没及时告诉你，是我处理得不好，对不起。"),
    ("same-quote-missed-promise-error", "missed", "前文仍是本次失约，不能由这句话推断对方原谅或邀约。",
     "只为本次失约道歉，不作补偿或长期保证。", "我这就过去，以后每次都准时到。"),
    ("same-quote-no-context", "unknown", "只有你可真行，无法判断指哪件事或褒贬语气。",
     "先确认说哪件事，不猜夸奖、责备或未来安排。", "你是说哪件事呀？"),
]


class StrategyContextReviewHttpTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ExplorationControlledModel

    def test_same_quote_contexts_capture_actual_inputs_and_keep_failure_unknown_visible(self):
        rows, explorations = [], []
        for case_id, context_kind, understanding, intent, text in PLANS:
            contact, target = self._history(context_kind)
            status, session = self.backend.request(
                f"/api/contacts/{contact}/assistant-session/default", {}, method="POST")
            self.assertEqual(status, 200, session)
            path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
            body = {"operation_key": str(uuid4()), "content": {
                "type": "response_exploration", "target_message_id": target, "skill_mode": "disabled",
            }}
            self.reply_model.plans.extend([
                {"explore": {"understanding": understanding,
                    "ambiguities": [],
                    "options": [
                        {"intent": intent, "label": "明确本次方向", "reason": "用户希望表达这个立场时适用。",
                         "citation_ids": [], "recommended": False, "pause": False},
                        {"intent": "暂不回应本次消息。", "label": "暂不回应", "reason": "尚未决定立场时可以暂停。",
                         "citation_ids": [], "recommended": False, "pause": True},
                    ]}},
                {"text": text, "basis": "以用户明确选择的本次意愿组织表达，引用不证明语义蕴含。"},
            ])
            before = len(self.reply_model.seen_calls)
            start = time.perf_counter()
            status, explored = self.backend.request(path + "/explorations", body)
            self.assertEqual(status, 200, explored)
            self.assertIsNone(explored["confirmed_intent"])
            self.assertEqual(len(self.backend.request(path)[1]["turns"]), 0)
            self.assertEqual(len(self.reply_model.seen_calls) - before, 1)
            choice = {"generate": True, "input_version_id": explored["input_version_id"],
                      "suggestion_id": explored["options"][0]["suggestion_id"]}
            endpoint = path + f"/explorations/{explored['exploration_id']}/confirm"
            status, generated = self.backend.request(endpoint, choice)
            elapsed_ms = (time.perf_counter() - start) * 1000
            self.assertEqual(status, 200, generated)
            self.assertEqual(generated["kind"], "generated")
            turn = generated["turn"]
            self.assertEqual(turn["state"], "completed")
            self.assertEqual([candidate["text"] for candidate in turn["candidates"]], [text])
            inputs = self.reply_model.payloads[-2:]
            self.assertEqual(inputs[0]["input_mode"], "direction_exploration")
            self.assertEqual(inputs[1]["input_mode"], "reply_to_message")
            self.assertEqual(inputs[0]["target_message_id"], target)
            self.assertIn("你可真行", [item["text"] for item in inputs[0]["evidence"]])
            self.assertEqual(inputs[1]["current_text"], "你可真行")
            self.assertEqual(inputs[1]["fidelity_contract"]["current_intent"]["text"], intent)
            for payload in inputs:
                require_unlabelled_input(payload)
                visible = "\n".join(item.get("text", "") for item in payload["evidence"])
                for _, previous in CONTEXTS[context_kind]:
                    self.assertIn(previous, visible)
            self.assertEqual(len(self.reply_model.seen_calls) - before, 2)
            self.assertEqual(self.backend.request(endpoint, choice), (200, generated))
            self.assertEqual(len(self.reply_model.seen_calls) - before, 2)
            saved = self.backend.request(path)[1]
            self.assertEqual(saved["current_input_version_id"], turn["input_version_id"])
            self.assertEqual(len(saved["turns"]), 1)
            self.assertEqual(self.other_backend.request(endpoint, choice)[0], 409)
            rows.append({"case_id": case_id, "owner_id": str(self.owner_id), "contact_id": contact,
                         "payload": inputs[-1], "model_inputs": inputs,
                         "system_prompt": str(self.reply_model.seen_calls[-1][0].content),
                         "output": {"candidates": turn["candidates"]},
                         "latency_ms": elapsed_ms, "call_count": 2})
            explorations.append({"case_id": case_id, "actual_result": explored,
                                 "actual_request": body, "actual_confirm": choice})

        specification_path = Path(__file__).parents[2] / "fixtures/fidelity/strategy-context-http-review.json"
        report = capture_report({"data_kind": "synthetic", "data_version": "strategy-context-http-v1",
                                 "entry_point": "http", "rows": rows,
                                 "coverage": "四个实际探索→明确确认→生成HTTP链；同句不同前文，仅合成模型。"},
                                json.loads(specification_path.read_text()))
        report["strategy_exploration_observations"] = explorations
        self.assertEqual(report["summary"]["denominator"], 4)
        self.assertEqual(report["summary"]["contract_failed"], 0)
        self.assertEqual(report["summary"]["fidelity_failed"], 1)
        self.assertEqual(report["summary"]["unreviewed"], 1)
        self.assertEqual(report["summary"]["total_call_count"], 8)
        self.assertEqual(report["summary"]["human_fidelity_pass"], 0)
        self.assertFalse(report["summary"]["quality_verified"])
        if output := os.environ.get("NOTALONE_STRATEGY_CONTEXT_REPORT"):
            Path(output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    def _history(self, context_kind: str) -> tuple[str, str]:
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        source = uuid4()
        target = None
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.source_document
                (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic-context-review.jsonl',%s,%s)""",
                (source, self.owner_id, UUID(contact), uuid4().hex * 2, len(CONTEXTS[context_kind]) + 1))
            for index, (speaker, text) in enumerate([*CONTEXTS[context_kind], ("contact", "你可真行")]):
                target = uuid4()
                connection.execute("""INSERT INTO public.message
                    (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                    VALUES (%s,%s,%s,%s,'text',%s,now()-(%s*interval '1 second'))""",
                    (target, self.owner_id, UUID(contact), speaker, text, 4 - index))
                connection.execute("""INSERT INTO public.message_source_ref
                    (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                    VALUES (%s,%s,%s,'source_document',%s,%s,'{}'::jsonb)""",
                    (target, self.owner_id, UUID(contact), source, f"synthetic:context:{index}"))
        return contact, str(target)
