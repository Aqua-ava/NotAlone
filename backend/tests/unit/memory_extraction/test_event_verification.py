"""独立事件V的公开有界结果验证，不把正文支持或合法编号当语义证明。"""

from copy import deepcopy
from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded import compile_labels
from notalone.memory_extraction.verification import validate_source_verification
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.verification_helpers import verification_result


class EventVerificationContractTest(unittest.TestCase):
    def fixture(self):
        source = window("🙂明天去看展。")
        source = replace(source, messages=(replace(source.messages[0], text_representation="text"),))
        item = row("0:0", "plan", event={"stage": "planned", "occurrence": "0:0"})
        payloads = compile_labels(source, {"units": {"0:0": {key: value for key, value in item.items() if key != "unit"}}})
        facts = ExtractionFlow(runtime=RecordingRuntime(payloads)).run(source).accepted
        event = facts[0].event
        result = {**verification_result(evidence=((source.messages[0].message_id, source.messages[0].text),)),
                  "event_verification": {"stage_verdict": "supported", "occurrence_verdict": "uncertain",
                      "stage_evidence": [position.to_payload() for position in event.stage_evidence],
                      "occurrence_evidence": [position.to_payload() for position in event.occurrence_evidence]}}
        return source, facts, result

    def test_independent_stage_does_not_certify_occurrence_and_missing_slot_certifies_neither(self):
        source, facts, raw = self.fixture()
        checked = validate_source_verification((raw,), window=source, facts=facts)[0]
        self.assertTrue(checked.event.stage_verified)
        self.assertFalse(checked.event.occurrence_verified)
        raw.pop("event_verification")
        checked = validate_source_verification((raw,), window=source, facts=facts)[0]
        self.assertFalse(checked.event.stage_verified)
        self.assertFalse(checked.event.occurrence_verified)

    def test_independent_event_support_rejects_foreign_out_of_bounds_nontext_and_unknown_fields(self):
        source, facts, raw = self.fixture()
        for invalid in ({"message_id": str(uuid4()), "char_start": 0, "char_end": 7},
                        {"message_id": str(source.messages[0].message_id), "char_start": 0, "char_end": 8},
                        {"message_id": str(source.messages[0].message_id), "char_start": True, "char_end": 7}):
            changed = deepcopy(raw)
            changed["event_verification"]["stage_evidence"] = [invalid]
            with self.subTest(invalid=invalid), self.assertRaises(ExtractionInvalidOutputError):
                validate_source_verification((changed,), window=source, facts=facts)
        for representation in ("processed_text", "placeholder", "unknown"):
            changed_source = replace(source, messages=(replace(source.messages[0], text_representation=representation),))
            with self.subTest(representation=representation), self.assertRaises(ExtractionInvalidOutputError):
                validate_source_verification((raw,), window=changed_source, facts=facts)
        changed = deepcopy(raw)
        changed["event_verification"]["stage_verified"] = True
        with self.assertRaises(ExtractionInvalidOutputError):
            validate_source_verification((changed,), window=source, facts=facts)
