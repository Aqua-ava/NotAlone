"""字符范围合同只验证结构与来源许可，脚本标注不证明模型语义。"""
import copy
import unittest

from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers, review_target
from notalone.reply.errors import ReplyInvariantError, ReplyReviewInvalidError
from tests.reply_review_support import synthetic_review


class ReviewUnitRangesTest(unittest.TestCase):
    def payload(self, text, messages=()):
        candidate = {"candidate_number": 1, "text": text, "messages": list(messages),
                     "basis": "按本次明确方向。", "risk_notes": [], "citation_ids": []}
        candidate["review_target"] = review_target(candidate)
        return {"input_mode": "reply_to_pasted_text", "current_text": "合成来信。",
                "confirmed_direction": "简短自然接话。", "evidence": [], "candidates": [candidate]}

    def report(self, payload, ends=None):
        report = synthetic_review(payload)
        report["protocol_version"] = "reply-fidelity-units-v3"
        ends = ends or [len(payload["candidates"][0]["text"])]
        claims, start = [], 1
        for number, end in enumerate(ends, 1):
            claims.append({"claim_id": number, "start_unit_id": f"c1u{start}", "end_unit_id": f"c1u{end}",
                "actor": "owner", "kind": "speech_act", "time_scope": "current", "modality": "optional",
                "support": {"status": "not_required", "sources": []}})
            start = end + 1
        report["reviews"]["candidate_1"]["claims"] = claims
        return report

    def test_ranges_keep_every_transcription_sensitive_character(self):
        for text in ("谢谢你，方便时再聊。", "谢谢。\n\n回头聊。", "谢谢  你。",
                     "你好🙂e\u0301，回头聊。", "你好👩\u200d💻，回头聊。"):
            with self.subTest(text=text):
                payload = self.payload(text)
                self.assertEqual(payload["candidates"][0]["review_target"].get("units"),
                                 [[f"c1u{number}", char] for number, char in enumerate(text, 1)])
                self.assertEqual(accepted_candidate_numbers(self.report(payload), payload), frozenset({1}))

    def test_message_join_keeps_trusted_candidate_namespace(self):
        payload = self.payload("谢谢。\n\n回头聊。\n\n晚安。", ["谢谢。", "回头聊。", "晚安。"])
        target = payload["candidates"][0]["review_target"]
        self.assertEqual(target["units"][0][0], "c1u1")
        self.assertEqual(accepted_candidate_numbers(self.report(payload), payload), frozenset({1}))

    def test_every_codepoint_cut_and_cross_sentence_group_remain_expressible(self):
        text = "你好🙂e\u0301，回头聊。条件允许再定。"
        payload = self.payload(text)
        for cut in range(1, len(text)):
            with self.subTest(cut=cut):
                self.assertEqual(accepted_candidate_numbers(self.report(payload, [cut, len(text)]), payload),
                                 frozenset({1}))
        self.assertEqual(accepted_candidate_numbers(self.report(payload), payload), frozenset({1}))
        self.assertEqual(payload["candidates"][0]["text"], text)

    def test_invalid_or_noncanonical_range_ids_never_cover_the_target(self):
        payload = self.payload("谢谢，回头聊。")
        for fault in ("gap", "overlap", "reversed_order", "end_before_start", "out_of_bounds", "missing_tail",
                      "missing_head", "empty", "non_string", "zero", "padded", "unicode_digit",
                      "wrong_namespace", "leading_space", "trailing_space"):
            with self.subTest(fault=fault):
                report = self.report(payload, [3, 7])
                first, second = report["reviews"]["candidate_1"]["claims"]
                if fault == "gap": second["start_unit_id"] = "c1u5"
                elif fault == "overlap": second["start_unit_id"] = "c1u3"
                elif fault == "reversed_order": report["reviews"]["candidate_1"]["claims"].reverse()
                elif fault == "end_before_start": second["end_unit_id"] = "c1u3"
                elif fault == "out_of_bounds": second["end_unit_id"] = "c1u8"
                elif fault == "missing_tail": second["end_unit_id"] = "c1u6"
                elif fault == "missing_head": first["start_unit_id"] = "c1u2"
                elif fault == "empty": first["start_unit_id"] = ""
                elif fault == "non_string": first["start_unit_id"] = 1
                elif fault == "zero": first["start_unit_id"] = "c1u0"
                elif fault == "padded": first["start_unit_id"] = "c01u1"
                elif fault == "unicode_digit": first["start_unit_id"] = "c1u１"
                elif fault == "wrong_namespace": first["start_unit_id"] = "c2u1"
                elif fault == "leading_space": first["start_unit_id"] = " c1u1"
                elif fault == "trailing_space": first["start_unit_id"] = "c1u1 "
                with self.assertRaises(ReplyReviewInvalidError):
                    accepted_candidate_numbers(report, payload)

    def test_whitespace_is_preserved_but_cannot_form_a_claim_alone(self):
        payload = self.payload("谢谢。\n\n回头聊。", ["谢谢。", "回头聊。"])
        with self.assertRaises(ReplyReviewInvalidError):
            accepted_candidate_numbers(self.report(payload, [3, 5, 9]), payload)
        self.assertEqual(accepted_candidate_numbers(self.report(payload, [5, 9]), payload), frozenset({1}))
        self.assertEqual(accepted_candidate_numbers(self.report(payload, [3, 9]), payload), frozenset({1}))

    def test_existing_other_candidate_ids_cannot_authorize_this_candidate(self):
        payload = self.payload("谢谢，回头聊。")
        second = copy.deepcopy(payload["candidates"][0])
        second.pop("review_target")
        second["candidate_number"] = 2
        second["review_target"] = review_target(second)
        payload["candidates"].append(second)
        report = synthetic_review(payload)
        self.assertEqual(accepted_candidate_numbers(report, payload), frozenset({1, 2}))
        report["reviews"]["candidate_1"]["claims"][0].update(start_unit_id="c2u1", end_unit_id="c2u7")
        with self.assertRaises(ReplyReviewInvalidError):
            accepted_candidate_numbers(report, payload)

    def test_internal_table_and_namespace_drift_stay_hard(self):
        for fault in ("missing_target", "missing_units", "table_text", "characters", "namespace", "candidate_number", "boolean_number", "float_number"):
            with self.subTest(fault=fault):
                payload = self.payload("谢谢，回头聊。")
                report = self.report(payload)
                candidate = payload["candidates"][0]
                target = candidate["review_target"]
                if fault == "missing_target": candidate.pop("review_target")
                elif fault == "missing_units": target.pop("units")
                elif fault == "table_text": target["units"][0][1] = "换"
                elif fault == "characters": target["characters"] += 1
                elif fault == "namespace": target["units"][0][0] = "c2u1"
                elif fault in {"boolean_number", "float_number"}:
                    candidate["candidate_number"] = True if fault == "boolean_number" else 1.0
                elif fault == "candidate_number":
                    candidate.pop("review_target")
                    candidate["candidate_number"] = 2
                    candidate["review_target"] = review_target(candidate)
                with self.assertRaises(ReplyInvariantError):
                    accepted_candidate_numbers(report, payload)

    def test_old_text_protocol_and_legacy_fields_are_rejected(self):
        payload = self.payload("谢谢，回头聊。")
        for fault in ("old_version", "old_text", "extra_text"):
            with self.subTest(fault=fault):
                report = self.report(payload)
                claim = report["reviews"]["candidate_1"]["claims"][0]
                if fault == "old_version": report["protocol_version"] = "reply-fidelity-claims-v2"
                else:
                    claim["text"] = payload["candidates"][0]["text"]
                    if fault == "old_text":
                        claim.pop("start_unit_id")
                        claim.pop("end_unit_id")
                with self.assertRaises(ReplyReviewInvalidError):
                    accepted_candidate_numbers(report, payload)
