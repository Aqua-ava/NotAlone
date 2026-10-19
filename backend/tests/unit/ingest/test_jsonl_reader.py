"""JSONL 文件读取边界测试。"""

from __future__ import annotations

import unittest
import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl


class ReadJsonlTest(unittest.TestCase):
    def test_accepts_exact_byte_limit_after_short_reads(self) -> None:
        content = b'{"text":"synthetic history"}\n'
        fdopen = os.fdopen

        @contextmanager
        def short_reads(descriptor: int, mode: str):
            with fdopen(descriptor, mode) as file:
                read = file.read
                with patch.object(
                    file, "read", side_effect=lambda size: read(min(size, 7))
                ):
                    yield file

        with TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_bytes(content)
            with (
                patch("notalone.ingest.jsonl_reader.MAX_JSONL_BYTES", len(content)),
                patch("notalone.ingest.jsonl_reader.os.fdopen", short_reads),
            ):
                document = read_jsonl(path, capture_processing=False)
        self.assertEqual(document.records, ({"text": "synthetic history"},))
        self.assertEqual(document.content_sha256, hashlib.sha256(content).hexdigest())

    def test_rejects_file_growing_past_limit_during_read(self) -> None:
        content = b'{"text":"synthetic history"}\n'
        fdopen = os.fdopen
        returned_bytes = 0

        with TemporaryDirectory() as directory:
            path = Path(directory) / "growing.jsonl"
            path.write_bytes(content)

            @contextmanager
            def growing_file(descriptor: int, mode: str):
                with fdopen(descriptor, mode) as file:
                    read = file.read

                    def read_then_grow(size: int) -> bytes:
                        nonlocal returned_bytes
                        chunk = read(min(size, 7))
                        if returned_bytes == 0:
                            with path.open("ab") as writer:
                                writer.write(b"synthetic appended content")
                        returned_bytes += len(chunk)
                        return chunk

                    with patch.object(file, "read", side_effect=read_then_grow):
                        yield file

            with (
                patch("notalone.ingest.jsonl_reader.MAX_JSONL_BYTES", len(content)),
                patch("notalone.ingest.jsonl_reader.os.fdopen", growing_file),
                self.assertRaises(ImportPreviewError) as raised,
            ):
                read_jsonl(path, capture_processing=False)

        self.assertEqual(raised.exception.details["error_code"], "file_size_limit")
        self.assertEqual(returned_bytes, len(content) + 1)
        self.assertIsNone(raised.exception.details["record_text"])
        self.assertIsNone(raised.exception.details["parsed"])

    def test_later_read_error_rejects_whole_document_with_safe_error(self) -> None:
        content = b'{"text":"synthetic history"}\n'
        fdopen = os.fdopen

        @contextmanager
        def failing_file(descriptor: int, mode: str):
            with fdopen(descriptor, mode) as file:
                read = file.read
                first_read = True

                def read_then_fail(size: int) -> bytes:
                    nonlocal first_read
                    if not first_read:
                        raise OSError("synthetic private path or content")
                    first_read = False
                    return read(min(size, 7))

                with patch.object(file, "read", side_effect=read_then_fail):
                    yield file

        with TemporaryDirectory() as directory:
            path = Path(directory) / "unavailable.jsonl"
            path.write_bytes(content)
            with (
                patch("notalone.ingest.jsonl_reader.os.fdopen", failing_file),
                self.assertRaises(ImportPreviewError) as raised,
            ):
                read_jsonl(path)

        error = raised.exception
        self.assertEqual(str(error), "无法读取指定文件。")
        self.assertEqual(error.details["error_code"], "file_unavailable")
        self.assertIsNone(error.details["record_text"])
        self.assertIsNone(error.details["parsed"])
        self.assertNotIn("synthetic private", json.dumps(error.details))

    def test_read_without_processing_preserves_bytes_digest_and_records(self) -> None:
        content = '{"text":"合成原话🌿\\n下一行","nested":{"value":1}}\r\n'
        with TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_bytes(content.encode("utf-8"))
            document = read_jsonl(path, capture_processing=False)
            captured = read_jsonl(path)
        self.assertEqual(document.records, (json.loads(content),))
        self.assertEqual(document.content_sha256, hashlib.sha256(content.encode("utf-8")).hexdigest())
        self.assertEqual(document.processing_records, ())
        self.assertEqual(captured.processing_records[0].payload()["record_text"], content)

    def test_rejects_file_larger_than_64_mib_before_reading_content(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "oversized.jsonl"
            path.write_bytes(b"12345")

            with patch("notalone.ingest.jsonl_reader.MAX_JSONL_BYTES", 4):
                with self.assertRaisesRegex(ImportPreviewError, "超过 64 MiB"):
                    read_jsonl(path)

    def test_rejects_more_than_500000_records(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "too-many-records.jsonl"
            path.write_bytes(b"{}\n{}\n")

            with patch("notalone.ingest.jsonl_reader.MAX_JSONL_RECORDS", 1):
                with self.assertRaisesRegex(
                    ImportPreviewError,
                    "消息记录超过 1 条",
                ):
                    read_jsonl(path)

    def test_rejects_non_regular_file(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ImportPreviewError, "必须是普通文件"):
                read_jsonl(Path(directory))


if __name__ == "__main__":
    unittest.main()
