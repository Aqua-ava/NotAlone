"""正式导入命令的边界测试。"""

from __future__ import annotations

import contextlib
import io
import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from notalone.ingest.import_command import import_file, main
from notalone.ingest.errors import ImportContentChangedError
from notalone.ingest.preview import build_preview
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
    NewContactSelection,
)
from notalone.persistence.postgres_repository import ImportResult


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class FakeRepository:
    def __init__(self) -> None:
        self.import_count = 0
        self.confirmation: object | None = None
        self.initialize_owner = False

    def import_document(
        self,
        *,
        owner_id: object,
        initialize_owner: bool = False,
        initialize_first_owner_identity: bool = False,
        document: object,
        confirmation: object,
    ) -> ImportResult:
        self.import_count += 1
        self.confirmation = confirmation
        self.initialize_owner = initialize_owner
        selected_contact_id = getattr(confirmation.selection, "contact_id", uuid4())
        confirmation_method = (
            "manual_select"
            if isinstance(confirmation.selection, ExistingContactSelection)
            else "manual_create"
        )
        return ImportResult(
            contact_id=selected_contact_id,
            channel_identity_id=uuid4(),
            source_document_id=uuid4(),
            confirmation_id=uuid4(),
            confirmation_method=confirmation_method,
            outcome="imported",
            message_count=document.record_count,
            task_id=uuid4(),
            owner_id=uuid4(),
        )


class ImportFileTest(unittest.TestCase):
    def test_commit_rechecks_file_bytes_after_preview_even_with_same_mtime(self) -> None:
        repository = FakeRepository()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_bytes((FIXTURES_DIR / "valid_single_contact.jsonl").read_bytes())
            preview = build_preview(path)
            metadata = path.stat()
            path.write_bytes(path.read_bytes().replace(b"server-101", b"server-999", 1))
            os.utime(path, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
            with self.assertRaises(ImportContentChangedError):
                import_file(
                    path=path, owner_id=uuid4(),
                    expected_content_sha256=preview.content_sha256,
                    confirmation=ImportConfirmationRequest(ExistingContactSelection(uuid4())),
                    repository=repository,
                )
            self.assertEqual(repository.import_count, 0)

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

    def test_imports_for_a_new_internal_contact(self) -> None:
        repository = FakeRepository()
        confirmation = ImportConfirmationRequest(
            selection=NewContactSelection(display_name="新建合成联系人")
        )

        result = import_file(
            path=FIXTURES_DIR / "valid_single_contact.jsonl",
            owner_id=uuid4(),
            confirmation=confirmation,
            repository=repository,
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.confirmation_method, "manual_create")
        self.assertIsInstance(result.contact_id, type(uuid4()))
        self.assertEqual(repository.import_count, 1)
        self.assertIs(repository.confirmation, confirmation)

    def test_initializes_owner_as_an_explicit_import_action(self) -> None:
        repository = FakeRepository()
        confirmation = ImportConfirmationRequest(
            selection=NewContactSelection(display_name="新建合成联系人")
        )

        result = import_file(
            path=FIXTURES_DIR / "valid_single_contact.jsonl",
            owner_id=None,
            initialize_owner=True,
            confirmation=confirmation,
            repository=repository,
        )

        self.assertTrue(repository.initialize_owner)
        self.assertIsNotNone(result.owner_id)


class ImportCommandTest(unittest.TestCase):
    def test_invalid_runtime_owner_id_error_does_not_echo_input(self) -> None:
        stderr = io.StringIO()
        private_input = "private-owner-identifier"
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--contact-id",
            str(uuid4()),
        ]

        with patch.dict(
            os.environ,
            {
                "NOTALONE_DATABASE_URL": "postgresql:///synthetic_test",
                "NOTALONE_OWNER_ID": private_input,
                "NOTALONE_DISABLE_DOTENV": "1",
            },
            clear=True,
        ):
            with contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        self.assertEqual(exit_code, 2)
        self.assertIn("NOTALONE_OWNER_ID", stderr.getvalue())
        self.assertNotIn(private_input, stderr.getvalue())

    def test_missing_database_url_fails_without_showing_identifiers(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--contact-id",
            str(uuid4()),
        ]

        with patch.dict(
            os.environ,
            {"NOTALONE_DISABLE_DOTENV": "1"},
            clear=True,
        ):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())
        self.assertNotIn("valid_single_contact.jsonl", stderr.getvalue())
