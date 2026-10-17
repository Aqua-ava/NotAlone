"""设置服务（首启向导）的单测；使用内存 fake，不触碰数据库。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

from notalone.application.setup_service import SetupService


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeOwnerDirectory:
    def __init__(self) -> None:
        self.owners: list[object] = []
        self.created: list[tuple[UUID, str]] = []

    def list_owners(self) -> tuple[object, ...]:
        return tuple(self.owners)

    def owner_exists(self, owner_id: UUID) -> bool:
        return any(getattr(owner, "id", None) == owner_id for owner in self.owners)

    def create_owner_if_empty(self, owner_id: UUID, display_name: str) -> object | None:
        return None if self.owners else self.create_owner(owner_id, display_name)

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
        # 既有 owner 也把 id 写入 .env：避免后端以未初始化模式重启循环。
        self.assertIn(
            f"NOTALONE_OWNER_ID={OWNER_ID}",
            self.env_path.read_text(encoding="utf-8"),
        )

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

    def reload_in_fresh_process(self, *keys: str) -> dict[str, str | None]:
        # 子进程只读本例临时文件，没有继承模型配置或共享 editable 路径。
        result = subprocess.run(
            [sys.executable, "-B", "-c", (
                "import json, os, sys; "
                "from notalone.runtime_config import load_project_env; "
                "load_project_env(); "
                "print(json.dumps({key: os.environ.get(key) for key in sys.argv[1:]}))"
            ), *keys],
            env={
                "NOTALONE_ENV_FILE": str(self.env_path),
                "PYTHONPATH": str(Path(__file__).resolve().parents[3] / "src"),
            },
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return json.loads(result.stdout)

    def test_official_defaults_replace_all_loadable_assignments_on_fresh_reload(self) -> None:
        preserved = (
            "# NOTALONE_DEEPSEEK_BASE_URL=保留的说明\n"
            "NOTALONE_SYNTHETIC_OTHER='保留其它设置'"
        )
        obsolete = (
            "export NOTALONE_DEEPSEEK_BASE_URL = 'https://synthetic-old.invalid/v1'\n"
            "NOTALONE_DEEPSEEK_BASE_URL=https://synthetic-duplicate.invalid\n"
            "  export NOTALONE_DEEPSEEK_MODEL=deepseek-chat\n"
            "NOTALONE_DEEPSEEK_MODEL = 'deepseek-reasoner'\n"
            "export NOTALONE_DEEPSEEK_API_KEY=synthetic-old-export\n"
            "NOTALONE_DEEPSEEK_API_KEY = synthetic-old-space\n"
            "NOTALONE_DEEPSEEK_API_KEY=synthetic-old-plain\n"
        )
        self.env_path.write_text(obsolete + preserved, encoding="utf-8")

        with patch.dict(os.environ, {}, clear=True):
            result = self.service.use_official_deepseek(api_key="synthetic-official-new")

        self.assertTrue(result["official_deepseek_defaults"])
        expected = {
            "NOTALONE_DEEPSEEK_API_KEY": "synthetic-official-new",
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-flash",
            "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
            "NOTALONE_SYNTHETIC_OTHER": "保留其它设置",
        }
        self.assertEqual(self.reload_in_fresh_process(*expected), expected)
        output = self.env_path.read_text(encoding="utf-8")
        self.assertIn(preserved + "\n", output)
        for line in obsolete.splitlines():
            self.assertNotIn(line, output)
        self.assertEqual(self.env_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.env_path.parent.iterdir()), [self.env_path])

    def test_credentials_replace_export_and_spaced_duplicates_on_fresh_reload(self) -> None:
        self.env_path.write_text(
            "export NOTALONE_DEEPSEEK_API_KEY='synthetic-old-export'\n"
            "NOTALONE_DEEPSEEK_API_KEY = synthetic-old-space\n"
            "NOTALONE_DEEPSEEK_API_KEY=synthetic-old-plain\n"
            "export NOTALONE_DEEPSEEK_BASE_URL=https://synthetic-custom.invalid/v1\n"
            "NOTALONE_DEEPSEEK_MODEL=synthetic-custom-model\n"
            "NOTALONE_SYNTHETIC_OTHER=preserved",
            encoding="utf-8",
        )

        with patch.dict(os.environ, {}, clear=True):
            self.service.write_credentials(api_key="synthetic-credentials-new")

        expected = {
            "NOTALONE_DEEPSEEK_API_KEY": "synthetic-credentials-new",
            "NOTALONE_DEEPSEEK_BASE_URL": "https://synthetic-custom.invalid/v1",
            "NOTALONE_DEEPSEEK_MODEL": "synthetic-custom-model",
            "NOTALONE_SYNTHETIC_OTHER": "preserved",
        }
        self.assertEqual(self.reload_in_fresh_process(*expected), expected)
        self.assertNotIn("synthetic-old-", self.env_path.read_text(encoding="utf-8"))

    def test_owner_write_replaces_export_and_spaced_duplicates_on_fresh_reload(self) -> None:
        self.directory.create_owner(OWNER_ID, "合成本人")
        self.env_path.write_text(
            "export NOTALONE_OWNER_ID=22222222-2222-2222-2222-222222222222\n"
            "NOTALONE_OWNER_ID = 33333333-3333-3333-3333-333333333333\n"
            "NOTALONE_SYNTHETIC_OTHER=preserved",
            encoding="utf-8",
        )

        self.service.initialize_owner(display_name="合成本人")

        expected = {
            "NOTALONE_OWNER_ID": str(OWNER_ID),
            "NOTALONE_SYNTHETIC_OTHER": "preserved",
        }
        self.assertEqual(self.reload_in_fresh_process(*expected), expected)

    def test_failed_atomic_save_keeps_existing_file_and_process_credentials(self) -> None:
        original = "export NOTALONE_DEEPSEEK_API_KEY=synthetic-existing\n"
        operations = (self.service.use_official_deepseek, self.service.write_credentials)
        for operation in operations:
            with self.subTest(operation=operation.__name__):
                self.env_path.write_text(original, encoding="utf-8")
                expected = {"NOTALONE_DEEPSEEK_API_KEY": "synthetic-existing"}
                with patch.dict(os.environ, expected, clear=True):
                    with patch(
                        "notalone.runtime_config.os.replace",
                        side_effect=OSError("synthetic_replace_failed"),
                    ):
                        with self.assertRaises(OSError):
                            operation(api_key="synthetic-new")
                    self.assertEqual(os.environ, expected)
                self.assertEqual(self.env_path.read_text(encoding="utf-8"), original)
                self.assertEqual(list(self.env_path.parent.iterdir()), [self.env_path])


if __name__ == "__main__":
    unittest.main()
