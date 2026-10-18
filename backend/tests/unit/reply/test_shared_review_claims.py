"""共享覆盖与来源许可的确定性合同；脚本标注不证明语义模型已正确分类。"""
import copy
import unittest

from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers, review_source_roles, review_target
from notalone.reply.errors import ReplyInvariantError, ReplyReviewInvalidError
from tests.reply_review_support import synthetic_claim, synthetic_review


class SharedReviewClaimsTest(unittest.TestCase):
    def payload(self, text="记得一些。你最近怎么样？", direction="自然接话，不虚构本人经历。"):
        return {"input_mode": "reply_to_pasted_text", "current_text": "那会儿的事情还记得吗？",
                "confirmed_direction": direction, "user_instruction": None,
                "evidence": [{"kind": "user_current_chat", "text": "那会儿的事情还记得吗？"},
                             {"kind": "owner_memory", "text": "本人过去表示记得那段往事。"}],
                "layered_context": {"scope_kind": "contact", "profile_entries": [{"text": "联系人2018年毕业。"}]},
                "candidates": [{"candidate_number": 1, "text": text, "messages": [], "basis": "按本次输入。",
                                "risk_notes": [], "citation_ids": []}]}

    def certificate(self, payload, path="/confirmed_direction", quote="自然接话", state="记得一些。"):
        report = synthetic_review(payload)
        first = synthetic_claim(state, kind="state", modality="stated",
                                sources=[{"source_path": path, "source_quote": quote}])
        second = synthetic_claim(payload["candidates"][0]["text"][len(state):])
        second["claim_id"] = 2
        report["reviews"]["candidate_1"]["claims"] = [first, second]
        for name in ("facts", "commitments"):
            report["reviews"]["candidate_1"]["checks"][name]["claim_ids"] = [1, 2]
        return report

    def test_half_clause_omission_overlap_and_cross_check_bypass_are_invalid(self):
        for fault in ("missing_tail", "missing_head", "duplicate", "facts_skips_state", "commitments_skips_state"):
            with self.subTest(fault=fault):
                payload = self.payload()
                row = (report := self.certificate(payload))["reviews"]["candidate_1"]
                if fault == "missing_tail": row["claims"] = row["claims"][:1]
                elif fault == "missing_head": row["claims"][0]["text"] = ""
                elif fault == "duplicate": row["claims"][1]["text"] = row["claims"][0]["text"]
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
