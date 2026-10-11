"""携入的可信来历协议不接受正文或隐式选择。"""

from __future__ import annotations

import unittest
from uuid import uuid4


class CandidateCarryOriginContractTest(unittest.TestCase):
    def test_metadata_round_trip_preserves_only_exact_origin_and_dependency_ids(self) -> None:
        from notalone.application.assistant_candidate_carry import (
            CandidateCarryOrigin, carry_origin_from_payload, carry_origin_to_payload,
        )

        origin = CandidateCarryOrigin(
            origin_owner_id=uuid4(), origin_contact_id=uuid4(), origin_binding_id=uuid4(),
            origin_session_id=uuid4(), origin_input_version_id=uuid4(), origin_turn_id=uuid4(), origin_reply_request_id=uuid4(),
            origin_candidate_id=uuid4(), origin_version_id=uuid4(), origin_selection_id=uuid4(),
            payload_sha256="a" * 64, style_sample_ids=(uuid4(),),
        )

        payload = carry_origin_to_payload(origin)

        self.assertEqual(carry_origin_from_payload(payload), origin)
        self.assertEqual(payload["type"], "candidate_carry")
        self.assertNotIn("messages", payload)
        self.assertNotIn("requirements", payload)
        with self.assertRaisesRegex(ValueError, "携入来历记录无效"):
            carry_origin_from_payload({**payload, "text": "不得写入来历协议的合成正文"})

    def test_http_command_requires_an_explicit_selection_identity_and_accepts_no_text(self) -> None:
        import json

        from notalone.server.assistant_candidate_carry import parse_candidate_carry_request

        payload = {"expected_selection_id": str(uuid4()), "candidate_id": str(uuid4()),
                   "version_id": str(uuid4())}
        command = parse_candidate_carry_request(json.dumps(payload).encode())
        self.assertEqual(str(command.expected_selection_id), payload["expected_selection_id"])
        for forged in ({"candidate_id": payload["candidate_id"], "version_id": payload["version_id"]},
                       {**payload, "text": "合成当前编辑尚未保存"},
                       {**payload, "requirements": "合成临时要求"}):
            with self.subTest(keys=set(forged)), self.assertRaises(ValueError):
                parse_candidate_carry_request(json.dumps(forged).encode())
