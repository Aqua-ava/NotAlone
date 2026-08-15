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
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
)
from notalone.persistence.postgres_repository import ImportResult


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class FakeRepository:
    def __init__(self) -> None:
        self.import_count = 0
        self.confirmation: object | None = None

    def import_document(
        self,
        *,
        owner_id: object,
        document: object,
        confirmation: object,
    ) -> ImportResult:
        self.import_count += 1
        self.confirmation = confirmation
        return ImportResult(
            contact_id=confirmation.selection.contact_id,
            channel_identity_id=uuid4(),
            source_document_id=uuid4(),
            confirmation_id=uuid4(),
            confirmation_method="manual_select",
            outcome="imported",
            message_count=document.record_count,
        )


class ImportFileTest(unittest.TestCase):
    def test_imports_for_an_existing_internal_contact(self) -> None:
        repository = FakeRepository()
        contact_id = uuid4()
        confirmation = ImportConfirmationRequest(
            selection=ExistingContactSelection(contact_id=contact_id)
        )

        result = import_file(
            path=FIXTURES_DIR / "valid_single_contact.jsonl",
            owner_id=uuid4(),
            confirmation=confirmation,
            repository=repository,
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.contact_id, contact_id)
        self.assertEqual(result.message_count, 6)
        self.assertEqual(repository.import_count, 1)
        self.assertIs(repository.confirmation, confirmation)


class ImportCommandTest(unittest.TestCase):
    def test_invalid_owner_id_error_does_not_echo_input(self) -> None:
        stderr = io.StringIO()
        private_input = "private-owner-identifier"
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--owner-id",
            private_input,
            "--contact-id",
            str(uuid4()),
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
            str(uuid4()),
        ]

        with patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())
        self.assertNotIn("valid_single_contact.jsonl", stderr.getvalue())
