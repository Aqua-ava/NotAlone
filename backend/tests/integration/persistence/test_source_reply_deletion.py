"""历史导入来源遵循统一回复删除契约。"""

from uuid import uuid4

import psycopg

from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.source_deletion import SourceDeletionError
from notalone.scopes import ContactScope
from tests.integration.persistence import reply_deletion_contract as contract
from tests.integration.persistence import test_source_deletion as source_tests


TEST_DATABASE_URL = contract.TEST_DATABASE_URL


class SourceReplyDeletionTest(contract.ReplyDeletionContract):
    deletion_error = SourceDeletionError

    @classmethod
    def setUpClass(cls) -> None:
        source_tests.PostgresSourceDeletionRepositoryTest.setUpClass()

    def setUp(self) -> None:
        self.sources = source_tests.PostgresSourceDeletionRepositoryTest()
        self.sources.setUp()
        self.addCleanup(self.sources.tearDown)
        self.scope = ContactScope(self.sources.owner_id, self.sources.contact_id)
        self.binding_id = uuid4()
        self.imported = self.sources.ingest_repository.import_document(
            owner_id=self.scope.owner_id,
            document=self.sources.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.scope.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            self.message_id, self.message_text = connection.execute(
                """
                SELECT id, text_content FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                  AND length(btrim(text_content)) > 0
                ORDER BY id LIMIT 1
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()
        self.source_id = self.imported.source_document_id
        self.store = PostgresReplyStore(TEST_DATABASE_URL)

    def test_http_evidence_disappears_after_source_deletion(self) -> None:
        from notalone.server.app import create_app
        from notalone.server.testing import InProcessClient

        request, context, reply = self._prepare_reply()
        self.store.save(request, context, reply)
        client = InProcessClient(create_app(database_url=TEST_DATABASE_URL, owner_id=self.scope.owner_id, token="synthetic"))
        path = f"/api/contacts/{self.scope.contact_id}/replies/{request.request_id}/evidence"
        headers = {"Authorization": "Bearer synthetic"}
        before = client.get(path, headers=headers)
        self.assertEqual(before.status_code, 200)
        self.assertEqual(before.json()["evidence"][0]["text"], self.message_text)
        self._delete_source()
        self.assertEqual(client.get(path, headers=headers).status_code, 404)

    def _delete_source(self) -> None:
        result = self.sources.deletion_repository.delete_source(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            source_document_id=self.imported.source_document_id,
        )
        self.assertEqual(result.outcome, "deleted")
