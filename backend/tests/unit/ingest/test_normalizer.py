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
        self.assertEqual(
            batch.channel_identity.external_id,
            "wxid_synthetic_contact",
        )
        self.assertEqual(batch.channel_identity.observed_name, "合成联系人")
        self.assertEqual(
            batch.owner_channel_identity.external_id,
            "wxid_synthetic_owner",
        )
        self.assertEqual(batch.owner_channel_identity.observed_name, "合成用户")
        self.assertEqual(batch.record_count, 6)

    def test_maps_contact_user_and_system_speakers(self) -> None:
        batch = normalize_document(self.document)

        self.assertEqual(batch.messages[0].speaker, "contact")
        self.assertEqual(batch.messages[1].speaker, "user")
        self.assertEqual(batch.messages[5].speaker, "system")

    def test_maps_message_fields_and_preserves_raw_payload(self) -> None:
        batch = normalize_document(self.document)
        message = batch.messages[1]

        self.assertEqual(message.source_locator, "jsonl:2")
        self.assertEqual(message.message_type, "image")
        self.assertEqual(message.text_content, "")
        self.assertEqual(message.media_placeholder, "[图片]")
        self.assertEqual(message.occurred_at.isoformat(), "2026-08-12T10:01:00+08:00")
        metadata = message.wechat_metadata
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.external_local_id, 102)
        self.assertEqual(metadata.external_server_id, "server-102")
        self.assertEqual(metadata.external_talker, "wxid_synthetic_contact")
        self.assertEqual(metadata.source_create_time, 1786500060)
        self.assertEqual(
            json.loads(metadata.raw_payload_json),
            self.document.records[1],
        )

    def document_with_overrides(self, **overrides):
        import dataclasses

        record = {**self.document.records[0], **overrides}
        return dataclasses.replace(
            self.document, records=(record, self.document.records[1])
        )

    def test_media_kinds_map_to_placeholder(self) -> None:
        for kind, placeholder in (
            ("voice", "[语音] 5.2s"),
            ("voip", "[通话]"),
            ("video", "[视频]"),
            ("channel_video", "当前微信版本不支持展示该内容"),
            ("file", "王力.pdf"),
            ("link", "分享了一个位置链接"),
            ("location", "[位置] 上海市"),
            ("miniprogram", "[应用消息]"),
            ("card", "[名片] 徐"),
            ("red_packet", "恭喜发财"),
            ("forward_chat", "转发的聊天记录"),
            ("app", "一起买新鲜蔬果"),
        ):
            with self.subTest(kind=kind):
                document = self.document_with_overrides(
                    kind=kind, text=placeholder
                )
                batch = normalize_document(document)
                message = batch.messages[0]
                self.assertEqual(message.message_type, kind)
                self.assertEqual(message.media_placeholder, placeholder)
                self.assertEqual(message.text_content, "")

    def test_raw_payload_is_an_immutable_snapshot(self) -> None:
        batch = normalize_document(self.document)
        original_text = self.document.records[0]["text"]

        self.document.records[0]["text"] = "修改后的合成正文"

        metadata = batch.messages[0].wechat_metadata
        self.assertIsNotNone(metadata)
        self.assertEqual(
            json.loads(metadata.raw_payload_json)["text"],
            original_text,
        )

    def test_batch_repr_does_not_expose_private_payload(self) -> None:
        batch = normalize_document(self.document)

        representation = repr(batch)

        self.assertNotIn("匿名合成消息一", representation)
        self.assertNotIn("wxid_synthetic_contact", representation)


if __name__ == "__main__":
    unittest.main()
