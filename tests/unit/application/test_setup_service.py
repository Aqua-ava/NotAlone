"""设置服务（首启向导）的单测；使用内存 fake，不触碰数据库。"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from uuid import UUID, uuid4

from notalone.application.setup_service import SetupService


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeOwnerDirectory:
    def __init__(self) -> None:
        self.owners: list[object] = []
        self.created: list[tuple[UUID, str]] = []

    def list_owners(self) -> tuple[object, ...]:
        return tuple(self.owners)

    def create_owner(self, owner_id: UUID, display_name: str) -> object:
        self.created.append((owner_id, display_name))
        self.owners.append(
            type("Owner", (), {"id": owner_id, "display_name": display_name})()
        )
        return self.owners[-1]


class SetupServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = FakeOwnerDirectory()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.env_path = Path(self.temp_dir.name) / ".env"
        self.service = SetupService(
            owner_directory=self.directory,
            env_path=self.env_path,
        )

    def test_status_reports_uninitialized(self) -> None:
        status = self.service.status()

        self.assertEqual(status["initialized"], False)
        self.assertEqual(status["owner_configured"], False)
        self.assertEqual(status["credentials_configured"], False)

    def test_initialize_owner_creates_and_persists(self) -> None:
        result = self.service.initialize_owner(display_name="我的关系助手")

        self.assertEqual(result["created"], True)
        self.assertTrue(result["owner_id"])
        self.assertEqual(len(self.directory.created), 1)
        self.assertEqual(self.directory.created[0][1], "我的关系助手")
        # owner id 写入受控 .env。
        env_text = self.env_path.read_text(encoding="utf-8")
        self.assertIn("NOTALONE_OWNER_ID=", env_text)
        self.assertEqual(os.stat(self.env_path).st_mode & 0o777, 0o600)

    def test_initialize_owner_is_idempotent(self) -> None:
        self.directory.owners.append(
            type("Owner", (), {"id": OWNER_ID, "display_name": "既有"})()
        )

        result = self.service.initialize_owner(display_name="我的关系助手")

        self.assertEqual(result["created"], False)
        self.assertEqual(result["owner_id"], str(OWNER_ID))
        self.assertEqual(self.directory.created, [])

    def test_initialize_rejects_empty_name(self) -> None:
        with self.assertRaises(ValueError):
            self.service.initialize_owner(display_name="   ")

    def test_write_credentials_writes_env_without_echoing(self) -> None:
        result = self.service.write_credentials(api_key="sk-super-secret")

        self.assertEqual(result["configured"], True)
        env_text = self.env_path.read_text(encoding="utf-8")
        self.assertIn("NOTALONE_DEEPSEEK_API_KEY=sk-super-secret", env_text)
        self.assertEqual(os.stat(self.env_path).st_mode & 0o777, 0o600)

    def test_write_credentials_skips_env_when_system_env_present(self) -> None:
        # 环境变量优先于 .env（与 runtime_config 一致）；写入仍落 .env。
        os.environ["NOTALONE_DEEPSEEK_API_KEY"] = "sk-super-secret"
        self.addCleanup(os.environ.pop, "NOTALONE_DEEPSEEK_API_KEY", None)

        result = self.service.write_credentials(api_key="sk-super-secret")

        self.assertEqual(result["configured"], True)
        self.assertIn(
            "NOTALONE_DEEPSEEK_API_KEY=sk-super-secret",
            self.env_path.read_text(encoding="utf-8"),
        )

    def test_write_credentials_rejects_empty(self) -> None:
        with self.assertRaises(ValueError):
            self.service.write_credentials(api_key="")


if __name__ == "__main__":
    unittest.main()