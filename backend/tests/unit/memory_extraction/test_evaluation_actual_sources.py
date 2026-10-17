"""正式来源的审核映射使用实际UUID，保留旧公开窗口摘要。"""

import copy
from datetime import datetime
import unittest
from uuid import uuid4

from notalone.memory_extraction.evaluation_review import prepare_case_review, score_case_review
from tests.unit.memory_extraction.test_evaluation_review import _evidence, _reference, _review


class ActualSourceReviewTest(unittest.TestCase):
    def test_content_projection_preserves_actual_offset_and_full_target_positions(self):
        from notalone.memory_extraction.evaluation_reference import bounded_window_projection, public_window_projection
        from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender

        message = MessageRef(
            message_id=uuid4(), text="我已经到了学校。", sender=MessageSender.CONTACT,
            occurred_at=datetime.fromisoformat("2030-01-02T20:00:00+08:00"),
            message_type="text", text_representation="text",
        )
        window = ExtractionWindow(owner_id=uuid4(), contact_id=uuid4(), messages=(message,),
                                  target_message_ids=(message.message_id,))
        self.assertEqual(bounded_window_projection(window), {
            "messages": [{"sender": "contact", "text": "我已经到了学校。",
                          "occurred_at": "2030-01-02T20:00:00+08:00", "message_type": "text",
                          "text_representation": "text"}], "target_indices": [0],
        })
        with self.assertRaises(ValueError):
            public_window_projection(window)

    def test_actual_message_uuid_maps_gold_index_without_rewriting_evidence(self):
        reference = _reference()
        reference["provenance"]["reference_version"] = "bounded-runtime15-v1"
        evidence = _evidence()
        source = str(uuid4())
        for layer in ("extraction", "verification_inputs", "final_facts"):
            evidence[layer][0]["source_message_ids"] = [source]
        evidence["verification"][0]["evidence"][0]["message_id"] = source
        original = copy.deepcopy(evidence)
        packet = prepare_case_review(
            reference, "W1", evidence, actual_message_ids_by_index=(source,),
        )
        report = score_case_review(packet, _review(packet))
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 1, "full": 1})
        self.assertEqual(packet["evidence"], original)
        self.assertEqual(evidence, original)

    def test_legacy_packet_and_source_namespace_remain_unchanged(self):
        packet = prepare_case_review(_reference(), "W1", _evidence())
        self.assertNotIn("actual_message_ids_by_index", packet)
        self.assertEqual(score_case_review(packet, _review(packet))["required"]["full"], 1)
        with self.assertRaisesRegex(ValueError, "review_actual_sources_invalid"):
            prepare_case_review(_reference(), "W1", _evidence(), actual_message_ids_by_index=(str(uuid4()),))

    def test_actual_sources_are_canonical_unique_bounded_and_in_review_digest(self):
        reference = _reference()
        reference["provenance"]["reference_version"] = "bounded-runtime15-v1"
        for sources in ((), [str(uuid4())], ("unknown",), (str(uuid4()).upper(),),
                        ("11111111-1111-1111-1111-111111111111",) * 2,
                        tuple(str(uuid4()) for _ in range(5))):
            with self.subTest(sources=sources), self.assertRaisesRegex(ValueError, "review_actual_sources_invalid"):
                prepare_case_review(reference, "W1", _evidence(), actual_message_ids_by_index=sources)
        first = prepare_case_review(reference, "W1", _evidence(), actual_message_ids_by_index=(str(uuid4()),))
        second = prepare_case_review(reference, "W1", _evidence(), actual_message_ids_by_index=(str(uuid4()),))
        self.assertNotEqual(first["evidence_sha256"], second["evidence_sha256"])
        self.assertEqual(score_case_review(first, _review(first))["required"]["full"], 0)
        with self.assertRaisesRegex(ValueError, "review_binding_changed"):
            score_case_review(second, _review(first))

    def test_actual_mapping_cannot_be_changed_after_review_packet_is_sealed(self):
        reference = _reference()
        reference["provenance"]["reference_version"] = "bounded-runtime15-v1"
        packet = prepare_case_review(reference, "W1", _evidence(), actual_message_ids_by_index=(str(uuid4()),))
        review = _review(packet)
        packet["actual_message_ids_by_index"][0] = str(uuid4())
        with self.assertRaisesRegex(ValueError, "review_packet_bindings_changed"):
            score_case_review(packet, review)


if __name__ == "__main__":
    unittest.main()
