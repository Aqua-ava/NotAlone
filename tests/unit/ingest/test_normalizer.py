"""微信 JSONL 规范化测试。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.normalizer import normalize_document


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class NormalizeDocumentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.document = read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")

    def test_normalizes_document_metadata_and_contact(self) -> None:
        batch = normalize_document(self.document)

        self.assertEqual(batch.file_name, "valid_single_contact.jsonl")
        self.assertEqual(batch.content_sha256, self.document.content_sha256)
        self.assertEqual(batch.contact.contact_id, "wxid_synthetic_contact")
        self.assertEqual(batch.contact.display_name, "合成联系人")
        self.assertEqual(batch.record_count, 6)

    def test_maps_contact_user_and_system_speakers(self) -> None:
        batch = normalize_document(self.document)

        self.assertEqual(batch.messages[0].speaker, "contact")
        self.assertEqual(batch.messages[1].speaker, "user")
        self.assertEqual(batch.messages[5].speaker, "system")

    def test_maps_message_fields_and_preserves_raw_payload(self) -> None:
        batch = normalize_document(self.document)
        message = batch.messages[1]

        self.assertEqual(message.external_local_id, 102)
        self.assertEqual(message.external_server_id, "server-102")
        self.assertEqual(message.external_talker, "wxid_synthetic_contact")
        self.assertEqual(message.message_type, "image")
        self.assertEqual(message.text_content, "[图片]")
        self.assertEqual(message.occurred_at.isoformat(), "2026-08-12T10:01:00+08:00")
        self.assertEqual(message.source_create_time, 1786500060)
        self.assertEqual(
            json.loads(message.raw_payload_json),
            self.document.records[1],
        )

    def test_raw_payload_is_an_immutable_snapshot(self) -> None:
        batch = normalize_document(self.document)
        original_text = self.document.records[0]["text"]

        self.document.records[0]["text"] = "修改后的合成正文"

        self.assertEqual(
            json.loads(batch.messages[0].raw_payload_json)["text"],
            original_text,
        )


if __name__ == "__main__":
    unittest.main()
