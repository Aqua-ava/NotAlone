"""共享覆盖与来源许可的确定性合同；脚本标注不证明语义模型已正确分类。"""
import copy
import unittest

from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers, review_source_roles, review_target
from notalone.reply.errors import ReplyInvariantError, ReplyReviewInvalidError
from notalone.memory.timing import MemoryTiming
from notalone.reply.fidelity import factual_role
from tests.reply_review_support import synthetic_claim, synthetic_review


class SharedReviewClaimsTest(unittest.TestCase):
    def payload(self, text="记得一些。你最近怎么样？", direction="自然接话，不虚构本人经历。"):
        value = {"input_mode": "reply_to_pasted_text", "current_text": "那会儿的事情还记得吗？",
                "confirmed_direction": direction, "user_instruction": None,
                "evidence": [{"kind": "user_current_chat", "text": "那会儿的事情还记得吗？"},
                             {"kind": "owner_memory", "text": "本人过去表示记得那段往事。"}],
                "layered_context": {"scope_kind": "contact", "profile_entries": [{"text": "联系人2018年毕业。"}]},
                "candidates": [{"candidate_number": 1, "text": text, "messages": [], "basis": "按本次输入。",
                                "risk_notes": [], "citation_ids": []}]}
        value["candidates"][0]["review_target"] = review_target(value["candidates"][0])
        return value

    def certificate(self, payload, path="/confirmed_direction", quote="自然接话", state="记得一些。"):
        report = synthetic_review(payload)
        first = synthetic_claim(state, kind="state", modality="stated",
                                sources=[{"source_path": path, "source_quote": quote}])
        second = synthetic_claim(payload["candidates"][0]["text"][len(state):], start=len(state) + 1)
        second["claim_id"] = 2
        report["reviews"]["candidate_1"]["claims"] = [first, second]
        return report

    def test_new_version_without_redundant_check_ids_accepts_complete_claims(self):
        payload = self.payload("那段往事我还有印象。你最近怎么样？", "告诉对方我记得这段往事，继续问他的近况。")
        report = self.certificate(payload, quote="我记得这段往事", state="那段往事我还有印象。")
        report["protocol_version"] = "reply-fidelity-units-v3"
        for check in report["reviews"]["candidate_1"]["checks"].values():
            check.pop("claim_ids", None)
        self.assertEqual(accepted_candidate_numbers(report, payload), frozenset({1}))

    def test_old_protocol_arrays_and_subset_scope_fields_are_rejected(self):
        payload = self.payload("谢谢你。")
        for fault in ("missing_version", "old_version", "old_complete_ids", "subset_ids", "subset_scope"):
            with self.subTest(fault=fault):
                report = synthetic_review(payload)
                if fault == "missing_version": report.pop("protocol_version")
                elif fault == "old_version": report["protocol_version"] = "reply-fidelity-claims-v1"
                else:
                    field = "scope" if fault == "subset_scope" else "claim_ids"
                    report["reviews"]["candidate_1"]["checks"]["facts"][field] = [1] if fault == "old_complete_ids" else []
                with self.assertRaises(ReplyReviewInvalidError): accepted_candidate_numbers(report, payload)

    def test_complete_claim_support_and_each_independent_check_are_conjoined(self):
        payload = self.payload("那段往事我还有印象。你最近怎么样？", "告诉对方我记得这段往事，继续问他的近况。")
        for index in (0, 1):
            with self.subTest(unknown_claim=index):
                report = self.certificate(payload, quote="我记得这段往事", state="那段往事我还有印象。")
                report["reviews"]["candidate_1"]["claims"][index]["support"]["status"] = "unknown"
                self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())
        categories = {"intent": "changed_intent", "instruction": "unmet_instruction", "facts": "unsupported_fact",
                      "commitments": "added_obligation", "explanation": "inaccurate_explanation"}
        for name, category in categories.items():
            for status in ("unknown", "violation"):
                with self.subTest(check=name, status=status):
                    report = self.certificate(payload, quote="我记得这段往事", state="那段往事我还有印象。")
                    result = {"status": status}
                    if status == "violation":
                        result["violation"] = {"category": category,
                            "candidate_path": "/basis" if name == "explanation" else "/text",
                            "candidate_quote": "按本次输入" if name == "explanation" else "那段往事我还有印象",
                            "source_path": "/confirmed_direction", "source_quote": "我记得这段往事"}
                    report["reviews"]["candidate_1"]["checks"][name]["result"] = result
                    self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())

    def test_rejection_does_not_skip_later_claim_check_or_candidate_validation(self):
        for fault in ("later_claim", "later_check", "later_candidate"):
            with self.subTest(fault=fault):
                payload = self.payload()
                report = self.certificate(payload)
                row = report["reviews"]["candidate_1"]
                row["claims"][0]["support"]["status"] = "unknown"
                if fault == "later_claim": row["claims"][1]["extra"] = True
                elif fault == "later_check":
                    row["checks"]["intent"]["result"]["status"] = "unknown"
                    row["checks"]["explanation"].pop("reason")
                else:
                    second = {**payload["candidates"][0], "candidate_number": 2}
                    second.pop("review_target")
                    second["review_target"] = review_target(second)
                    payload["candidates"].append(second)
                    report["reviews"]["candidate_2"] = {**copy.deepcopy(row), "candidate_number": 2}
                    for claim in report["reviews"]["candidate_2"]["claims"]:
                        for key in ("start_unit_id", "end_unit_id"): claim[key] = claim[key].replace("c1u", "c2u")
                    report["reviews"]["candidate_2"]["claims"][1]["extra"] = True
                with self.assertRaises(ReplyReviewInvalidError): accepted_candidate_numbers(report, payload)

    def test_half_clause_omission_overlap_and_cross_check_bypass_are_invalid(self):
        for fault in ("missing_tail", "missing_head", "duplicate", "facts_skips_state", "commitments_skips_state"):
            with self.subTest(fault=fault):
                payload = self.payload()
                row = (report := self.certificate(payload))["reviews"]["candidate_1"]
                if fault == "missing_tail": row["claims"] = row["claims"][:1]
                elif fault == "missing_head": row["claims"][0]["start_unit_id"] = "c1u0"
                elif fault == "duplicate": row["claims"][1]["start_unit_id"] = "c1u1"
                else: row["checks"]["facts" if fault.startswith("facts") else "commitments"]["claim_ids"] = [2]
                with self.assertRaises(ReplyReviewInvalidError): accepted_candidate_numbers(report, payload)

    def test_contact_incoming_and_old_owner_state_cannot_authorize_current_owner_state(self):
        payload = self.payload()
        for path, quote in (("/current_text", "还记得吗"), ("/evidence/0/text", "还记得吗"),
                            ("/evidence/1/text", "记得那段往事"),
                            ("/layered_context/profile_entries/0/text", "2018年毕业")):
            with self.subTest(path=path):
                report = self.certificate(payload, path, quote)
                report["reviews"]["candidate_1"]["claims"][0]["modality"] = "optional"
                self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())

    def test_actual_message_source_can_support_past_owner_state_or_commitment(self):
        for kind, statement in (("state", "当时我还有印象。"), ("commitment", "去年我答应过帮忙。")):
            with self.subTest(kind=kind):
                payload = self.payload(statement + "你最近怎么样？")
                payload["evidence"].append({"kind": "message", "factual_role": factual_role("message"),
                    "text": statement, "status": "active", "timing": MemoryTiming().to_payload()})
                path = "/evidence/2/text"
                self.assertEqual(review_source_roles(payload)[path]["role"], "history_message")
                report = self.certificate(payload, path, statement, state=statement)
                report["reviews"]["candidate_1"]["claims"][0].update(kind=kind, time_scope="historical")
                self.assertEqual(accepted_candidate_numbers(report, payload), frozenset({1}))

    def test_past_message_cannot_authorize_current_state_or_new_owner_commitment(self):
        for kind, time_scope, statement in (("state", "current", "我现在还记得。"),
                ("commitment", "current", "我现在答应帮忙。"),
                ("commitment", "unspecified", "我答应帮忙。")):
            with self.subTest(kind=kind, time_scope=time_scope):
                payload = self.payload(statement + "你最近怎么样？")
                payload["evidence"].append({"kind": "message", "factual_role": factual_role("message"),
                    "text": "去年我说：我还记得，也答应过帮忙。", "status": "active",
                    "timing": MemoryTiming().to_payload()})
                report = self.certificate(payload, "/evidence/2/text", "我还记得，也答应过帮忙", state=statement)
                report["reviews"]["candidate_1"]["claims"][0].update(kind=kind, time_scope=time_scope)
                self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())

    def test_current_direction_authorizes_legal_paraphrase_without_literal_copy(self):
        payload = self.payload("那段往事我还有印象。你最近怎么样？", "告诉对方我记得这段往事，继续问他的近况。")
        report = self.certificate(payload, quote="我记得这段往事", state="那段往事我还有印象。")
        self.assertEqual(accepted_candidate_numbers(report, payload), frozenset({1}))

    def test_politeness_and_optional_speech_need_no_invented_fact_source(self):
        payload = self.payload("谢谢你提起这些。你最近怎么样？")
        self.assertEqual(accepted_candidate_numbers(synthetic_review(payload), payload), frozenset({1}))
        text = "想聊的话我今晚有空，不用急着回，看你的时间。"
        payload = self.payload(text, direction=text)
        report = self.certificate(payload, quote="我今晚有空", state="想聊的话我今晚有空，")
        self.assertEqual(accepted_candidate_numbers(report, payload), frozenset({1}))

    def test_source_role_is_derived_and_provider_cannot_self_report_it(self):
        payload = self.payload()
        self.assertEqual(review_source_roles(payload)["/current_text"]["role"], "contact_input")
        report = self.certificate(payload)
        report["reviews"]["candidate_1"]["claims"][0]["support"]["sources"][0]["role"] = "current_user_input"
        with self.assertRaises(ReplyReviewInvalidError): accepted_candidate_numbers(report, payload)
        payload["review_sources"] = copy.deepcopy(review_source_roles(payload))
        payload["review_sources"]["/current_text"]["role"] = "current_user_input"
        with self.assertRaises(ReplyInvariantError): accepted_candidate_numbers(report, payload)

    def test_canonical_messages_are_covered_once_with_unicode_and_newlines(self):
        payload = self.payload("你好🙂。\n\n谢谢你！")
        payload["candidates"][0]["messages"] = ["你好🙂。", "谢谢你！"]
        payload["candidates"][0].pop("review_target")
        payload["candidates"][0]["review_target"] = review_target(payload["candidates"][0])
        target = review_target(payload["candidates"][0])
        self.assertEqual(target["characters"], len(payload["candidates"][0]["text"]))
        self.assertEqual(len(target["message_ranges"]), 2)
        self.assertEqual(accepted_candidate_numbers(synthetic_review(payload), payload), frozenset({1}))
        payload["candidates"][0]["messages"] = ["另一条消息"]
        with self.assertRaises(ReplyInvariantError): accepted_candidate_numbers({}, payload)

    def test_unknown_and_claim_or_source_overflow_stay_closed(self):
        payload = self.payload()
        for fault in ("unknown", "thirteen_claims", "three_sources"):
            report = self.certificate(payload)
            first = report["reviews"]["candidate_1"]["claims"][0]
            if fault == "unknown":
                first["support"]["status"] = "unknown"
                self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())
            else:
                if fault == "thirteen_claims": report["reviews"]["candidate_1"]["claims"] *= 7
                else: first["support"]["sources"] *= 3
                with self.assertRaises(ReplyReviewInvalidError): accepted_candidate_numbers(report, payload)
