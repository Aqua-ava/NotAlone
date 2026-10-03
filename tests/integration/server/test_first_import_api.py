"""首启 owner 经真实 HTTP 确认首次导入的回归测试。

仅使用随机合成 owner 与渠道身份，不读取微信或调用模型；结果通过
联系人、来源和消息 API 验证，清理只删除本测试创建的 owner。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg

from notalone.application.import_service import ImportService
from notalone.ingest.import_command import import_file
from notalone.ingest.models import (
    ImportConfirmationRequest,
    NewContactSelection,
)
from notalone.persistence.postgres_repository import (
    OwnerChannelIdentityNotFoundError,
    PostgresIngestRepository,
)
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import BackendServer, create_app


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "fixtures" / "valid_single_contact.jsonl"
)


class FirstImportApiIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.directory = PostgresOwnerDirectory(TEST_DATABASE_URL)
        self.owner_id = uuid4()
        self.owner_ids = [self.owner_id]
        self.directory.create_owner(self.owner_id, "首启导入合成用户")
        self.owner_ids_before = {owner.id for owner in self.directory.list_owners()}
        self.external_id = f"wxid_first_import_{uuid4().hex}"
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "synthetic-chat.jsonl"
        fixture = FIXTURE_PATH.read_text(encoding="utf-8").replace(
            "wxid_synthetic_owner", self.external_id
        ).replace("wxid_synthetic_contact", f"wxid_contact_{uuid4().hex}")
        self.path.write_text(fixture, encoding="utf-8")
        self.server = BackendServer(
            create_app(
                database_url=TEST_DATABASE_URL,
                owner_id=self.owner_id,
                token="first-import-test-token",
                import_service=ImportService(
                    repository=PostgresIngestRepository(TEST_DATABASE_URL)
                ),
            )
        )
        host, port = self.server.start()
        self.base_url = f"http://{host}:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            for owner_id in self.owner_ids:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s", (owner_id,)
                )

    def _request(
        self, path: str, body: dict[str, object] | None = None
    ) -> tuple[int, dict[str, object]]:
        request = Request(
            self.base_url + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": "Bearer first-import-test-token",
                "Content-Type": "application/json",
            },
        )
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def _contacts(self) -> list[dict[str, object]]:
        status, payload = self._request("/api/contacts")
        self.assertEqual(status, 200)
        return payload["contacts"]

    def _insert_owner_identity(
        self,
        *,
        status: str = "active",
        owner_id: UUID | None = None,
        external_id: str | None = None,
    ) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.owner_channel_identity
                    (owner_id, channel, external_id, observed_name, status)
                VALUES (%s, 'wechat', %s, '合成用户', %s)
                """,
                (owner_id or self.owner_id, external_id or self.external_id, status),
            )

    def _new_contact_import(
        self, path: Path | None = None
    ) -> tuple[int, dict[str, object]]:
        return self._request(
            "/api/imports/commit",
            {"path": str(path or self.path), "new_contact_name": "合成联系人"},
        )

    def test_setup_owner_can_confirm_first_single_contact_import(self) -> None:
        status, preview = self._request(
            "/api/imports/preview", {"path": str(self.path)}
        )
        self.assertEqual(status, 200)
        self.assertEqual(preview["record_count"], 6)
        self.assertEqual(self._contacts(), [])

        status, result = self._request(
            "/api/imports/commit",
            {"path": str(self.path), "new_contact_name": "首次导入合成联系人"},
        )

        self.assertEqual(status, 200, result)
        contact_id = result["contact_id"]
        self.assertEqual(
            self._contacts(),
            [{
                "contact_id": contact_id,
                "display_name": "首次导入合成联系人",
                "data_status": {"message_count": 6, "source_count": 1},
            }],
        )
        status, messages = self._request(f"/api/contacts/{contact_id}/messages")
        self.assertEqual(status, 200)
        self.assertEqual(len(messages["messages"]), 6)
        status, sources = self._request(f"/api/contacts/{contact_id}/sources")
        self.assertEqual(status, 200)
        self.assertEqual(len(sources["sources"]), 1)
        self.assertEqual(
            {owner.id for owner in self.directory.list_owners()}, self.owner_ids_before
        )

    def test_repeated_import_reports_counts_without_duplicate_data(self) -> None:
        status, first = self._request(
            "/api/imports/commit",
            {"path": str(self.path), "new_contact_name": "重复导入合成联系人"},
        )
        self.assertEqual(status, 200, first)
        self.assertEqual(first["imported_count"], 6)
        self.assertEqual(first["skipped_duplicates"], 0)

        status, repeated = self._request(
            "/api/imports/commit",
            {"path": str(self.path), "contact_id": first["contact_id"]},
        )

        self.assertEqual(status, 200, repeated)
        self.assertEqual(
            repeated,
            {
                "contact_id": first["contact_id"],
                "task_id": first["task_id"],
                "imported_count": 0,
                "skipped_duplicates": 6,
            },
        )
        self.assertEqual(len(self._contacts()), 1)
        self.assertEqual(
            self._contacts()[0]["data_status"],
            {"message_count": 6, "source_count": 1},
        )
        self.assertEqual(
            {owner.id for owner in self.directory.list_owners()}, self.owner_ids_before
        )

    def test_active_owner_identity_conflict_rejects_without_import_data(self) -> None:
        self._insert_owner_identity(external_id=f"wxid_other_{uuid4().hex}")

        status, result = self._new_contact_import()

        self.assertEqual((status, result), (409, {"error": "import_commit_failed"}))
        self.assertEqual(self._contacts(), [])

    def test_command_import_still_requires_explicit_owner_initialization(self) -> None:
        with self.assertRaises(OwnerChannelIdentityNotFoundError):
            import_file(
                path=self.path,
                owner_id=self.owner_id,
                confirmation=ImportConfirmationRequest(
                    selection=NewContactSelection(display_name="命令导入合成联系人")
                ),
                repository=PostgresIngestRepository(TEST_DATABASE_URL),
            )
        self.assertEqual(self._contacts(), [])

        status, result = self._new_contact_import()

        self.assertEqual(status, 200, result)

    def test_identity_bound_to_other_owner_rejects_without_import_data(self) -> None:
        other_owner_id = uuid4()
        self.owner_ids.append(other_owner_id)
        self.directory.create_owner(other_owner_id, "另一个合成用户")
        self._insert_owner_identity(owner_id=other_owner_id)

        status, result = self._new_contact_import()

        self.assertEqual((status, result), (409, {"error": "import_commit_failed"}))
        self.assertEqual(self._contacts(), [])

    def test_revoked_identity_requires_explicit_rebinding_for_same_or_new_id(self) -> None:
        self._insert_owner_identity(status="revoked")
        changed = self.path.with_name("synthetic-other-owner.jsonl")
        changed.write_text(
            self.path.read_text(encoding="utf-8").replace(
                self.external_id, f"wxid_changed_{uuid4().hex}"
            ),
            encoding="utf-8",
        )
        for path in (self.path, changed):
            with self.subTest(path=path.name):
                status, result = self._new_contact_import(path)
                self.assertEqual(
                    (status, result), (409, {"error": "import_commit_failed"})
                )
                self.assertEqual(self._contacts(), [])

        restored = import_file(
            path=self.path,
            owner_id=self.owner_id,
            initialize_owner=True,
            confirmation=ImportConfirmationRequest(
                selection=NewContactSelection(display_name="显式恢复合成联系人")
            ),
            repository=PostgresIngestRepository(TEST_DATABASE_URL),
        )
        self.assertEqual(restored.owner_id, self.owner_id)
        self.assertEqual(restored.message_count, 6)
        status, repeated = self._request(
            "/api/imports/commit",
            {"path": str(self.path), "contact_id": str(restored.contact_id)},
        )
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated["skipped_duplicates"], 6)

    def test_failed_contact_confirmation_rolls_back_first_owner_identity(self) -> None:
        status, result = self._request(
            "/api/imports/commit",
            {"path": str(self.path), "contact_id": str(uuid4())},
        )
        self.assertEqual((status, result), (409, {"error": "import_commit_failed"}))
        self.assertEqual(self._contacts(), [])
        # 首次事务失败后换用另一份本人标识仍能首次绑定，证明未留下身份。
        self.path.write_text(
            self.path.read_text(encoding="utf-8").replace(
                self.external_id, f"wxid_retry_{uuid4().hex}"
            ),
            encoding="utf-8",
        )

        status, result = self._new_contact_import()

        self.assertEqual(status, 200, result)
        self.assertEqual(result["imported_count"], 6)

    def test_concurrent_first_imports_reuse_owner_identity_and_source(self) -> None:
        contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '并发合成联系人')",
                (self.owner_id, contact_id),
            )
        barrier = threading.Barrier(2)

        def commit() -> tuple[int, dict[str, object]]:
            barrier.wait(timeout=5)
            return self._request(
                "/api/imports/commit",
                {"path": str(self.path), "contact_id": str(contact_id)},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(commit) for _ in range(2)]
            responses = [future.result(timeout=10) for future in futures]

        self.assertEqual([status for status, _ in responses], [200, 200], responses)
        self.assertEqual(
            sorted(
                (item["imported_count"], item["skipped_duplicates"])
                for _, item in responses
            ),
            [(0, 6), (6, 0)],
        )
        self.assertEqual(
            self._contacts()[0]["data_status"],
            {"message_count": 6, "source_count": 1},
        )
        self.assertEqual(
            {owner.id for owner in self.directory.list_owners()}, self.owner_ids_before
        )


if __name__ == "__main__":
    unittest.main()
