"""正式导入命令的边界测试。"""

from __future__ import annotations

import contextlib
import io
import os
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from notalone.ingest.import_command import import_file, main
from notalone.persistence.postgres_repository import ImportResult


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class FakeRepository:
    def __init__(self) -> None:
        self.import_count = 0

    def import_document(self, *, owner_id: object, document: object) -> ImportResult:
        self.import_count += 1
        return ImportResult(
            source_document_id=uuid4(),
            outcome="imported",
            message_count=document.record_count,
        )


class ImportFileTest(unittest.TestCase):
    def test_requires_exact_contact_confirmation_before_repository_write(self) -> None:
        repository = FakeRepository()

        with self.assertRaisesRegex(ValueError, "已确认联系人不一致"):
            import_file(
                path=FIXTURES_DIR / "valid_single_contact.jsonl",
                owner_id=uuid4(),
                confirmed_contact_id="wxid_other_contact",
                repository=repository,
            )

        self.assertEqual(repository.import_count, 0)

    def test_imports_when_contact_confirmation_matches(self) -> None:
        repository = FakeRepository()

        result = import_file(
            path=FIXTURES_DIR / "valid_single_contact.jsonl",
            owner_id=uuid4(),
            confirmed_contact_id="wxid_synthetic_contact",
            repository=repository,
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.message_count, 6)
        self.assertEqual(repository.import_count, 1)


class ImportCommandTest(unittest.TestCase):
    def test_invalid_owner_id_error_does_not_echo_input(self) -> None:
        stderr = io.StringIO()
        private_input = "private-owner-identifier"
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--owner-id",
            private_input,
            "--contact-id",
            "wxid_synthetic_contact",
        ]

        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                main(arguments)

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("必须是有效 UUID", stderr.getvalue())
        self.assertNotIn(private_input, stderr.getvalue())

    def test_missing_database_url_fails_without_showing_identifiers(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--owner-id",
            str(uuid4()),
            "--contact-id",
            "wxid_synthetic_contact",
        ]

        with patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())
        self.assertNotIn("wxid_synthetic_contact", stderr.getvalue())
        self.assertNotIn("valid_single_contact.jsonl", stderr.getvalue())
