"""微信单联系人 JSONL 导入预览测试。"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.preview import build_preview, format_preview, main


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class ImportPreviewTest(unittest.TestCase):
    def test_valid_single_contact_preview(self) -> None:
        preview = build_preview(FIXTURES_DIR / "valid_single_contact.jsonl")

        self.assertEqual(preview.contact.contact_id, "wxid_synthetic_contact")
        self.assertEqual(preview.contact.display_name, "合成联系人")
        self.assertEqual(preview.contact.display_name_variant_count, 2)
        self.assertEqual(preview.record_count, 6)
        self.assertEqual(
            preview.kind_counts,
            (
                ("image", 1),
                ("quote", 1),
                ("sticker", 1),
                ("system", 1),
                ("text", 1),
                ("transfer", 1),
            ),
        )
        self.assertEqual(len(preview.content_sha256), 64)

    def test_formatted_preview_has_no_message_text(self) -> None:
        preview = build_preview(FIXTURES_DIR / "valid_single_contact.jsonl")

        output = format_preview(preview)

        self.assertIn("数据库写入：未执行", output)
        self.assertIn("owner: 不来自导出文件", output)
        self.assertNotIn("匿名合成消息一", output)
        self.assertNotIn("匿名系统事件", output)
        self.assertNotIn(preview.file_name, output)
        self.assertNotIn(preview.content_sha256, output)
        self.assertNotIn(preview.contact.contact_id, output)
        self.assertNotIn(preview.contact.display_name, output)

    def test_identifiers_require_explicit_output_flag(self) -> None:
        preview = build_preview(FIXTURES_DIR / "valid_single_contact.jsonl")

        output = format_preview(preview, show_identifiers=True)

        self.assertIn(preview.file_name, output)
        self.assertIn(preview.contact.contact_id, output)
        self.assertIn(preview.contact.display_name, output)
        self.assertNotIn(preview.content_sha256, output)
        self.assertNotIn("匿名合成消息一", output)

    def test_cli_success_does_not_write_or_show_message_text(self) -> None:
        stdout = io.StringIO()

        with contextlib.redirect_stdout(stdout):
            exit_code = main([str(FIXTURES_DIR / "valid_single_contact.jsonl")])

        self.assertEqual(exit_code, 0)
        self.assertIn("校验结果：通过", stdout.getvalue())
        self.assertIn("数据库写入：未执行", stdout.getvalue())
        self.assertNotIn("valid_single_contact.jsonl", stdout.getvalue())
        self.assertNotIn("wxid_synthetic_contact", stdout.getvalue())
        self.assertNotIn("合成联系人", stdout.getvalue())
        self.assertNotIn("匿名合成消息一", stdout.getvalue())

    def test_invalid_json_reports_line_without_content(self) -> None:
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            exit_code = main([str(FIXTURES_DIR / "invalid_json.jsonl")])

        self.assertEqual(exit_code, 1)
        self.assertIn("第 2 行不是有效 JSON", stderr.getvalue())
        self.assertNotIn("敏感合成正文", stderr.getvalue())

    def test_mixed_contacts_are_rejected(self) -> None:
        with self.assertRaisesRegex(ImportPreviewError, "包含 2 个 id.talker"):
            build_preview(FIXTURES_DIR / "mixed_contacts.jsonl")

    def test_duplicate_local_id_is_rejected(self) -> None:
        records = self._valid_records()
        records[1]["id"]["local_id"] = records[0]["id"]["local_id"]
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "id.local_id 重复"):
            build_preview(path)

    def test_talker_mismatch_is_rejected(self) -> None:
        records = self._valid_records()
        records[1]["id"]["talker"] = "wxid_other_contact"
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "id.talker"):
            build_preview(path)

    def test_image_without_images_payload_is_rejected(self) -> None:
        records = self._valid_records()
        del records[1]["images"]
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "必须包含 images"):
            build_preview(path)

    def test_multiple_owner_sender_ids_are_rejected(self) -> None:
        records = self._valid_records()
        records.append(
            {
                "id": {
                    "local_id": 107,
                    "server_id_str": "server-107",
                    "talker": "wxid_synthetic_contact",
                },
                "create_time": 1786500360,
                "is_from_me": True,
                "kind": "text",
                "sender": "合成用户",
                "sender_wxid": "wxid_other_owner",
                "text": "匿名合成消息二",
                "time": "2026-08-12 10:06:00",
                "time_iso": "2026-08-12T10:06:00+08:00",
            }
        )
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "多个 sender_wxid"):
            build_preview(path)

    def test_naive_time_is_rejected(self) -> None:
        records = self._valid_records()
        records[0]["time_iso"] = "2026-08-12T10:00:00"
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "必须包含时区"):
            build_preview(path)

    def test_create_time_mismatch_is_rejected(self) -> None:
        records = self._valid_records()
        records[0]["create_time"] = 1
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "create_time 与 time_iso 不一致"):
            build_preview(path)

    def test_local_id_outside_bigint_is_rejected(self) -> None:
        records = self._valid_records()
        records[0]["id"]["local_id"] = 2**63
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "超出 PostgreSQL bigint"):
            build_preview(path)

    def test_empty_images_payload_is_rejected(self) -> None:
        records = self._valid_records()
        records[1]["images"] = []
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "images 不能为空"):
            build_preview(path)

    def test_quote_payload_must_be_object(self) -> None:
        records = self._valid_records()
        records[3]["quote"] = "不应输出的合成引用"
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "必须包含 quote"):
            build_preview(path)

    def test_transfer_payload_must_be_object(self) -> None:
        records = self._valid_records()
        records[4]["transfer"] = "不应输出的合成转账"
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "必须包含 transfer"):
            build_preview(path)

    def test_only_outbound_messages_are_rejected(self) -> None:
        records = [
            record
            for record in self._valid_records()
            if record["kind"] != "system"
        ]
        for record in records:
            record["is_from_me"] = True
            record["sender"] = "合成用户"
            record["sender_wxid"] = "wxid_synthetic_owner"
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "未找到可识别的联系人"):
            build_preview(path)

    def test_only_system_messages_are_rejected(self) -> None:
        records = [
            record for record in self._valid_records() if record["kind"] == "system"
        ]
        path = self._write_records(records)

        with self.assertRaisesRegex(ImportPreviewError, "未找到可识别的联系人"):
            build_preview(path)

    def _valid_records(self) -> list[dict[str, object]]:
        return [
            json.loads(line)
            for line in (FIXTURES_DIR / "valid_single_contact.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]

    def _write_records(self, records: list[dict[str, object]]) -> Path:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        path = Path(temporary_directory.name) / "synthetic.jsonl"
        path.write_text(
            "\n".join(json.dumps(record, ensure_ascii=False) for record in records)
            + "\n",
            encoding="utf-8",
        )
        return path


if __name__ == "__main__":
    unittest.main()
