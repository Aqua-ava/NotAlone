"""本地受控运行配置测试。"""

from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from notalone.runtime_config import load_project_env, persist_owner_id


class RuntimeConfigTest(unittest.TestCase):
    def test_load_project_env_does_not_override_process_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "NOTALONE_DATABASE_URL='postgresql:///from-file'\n"
                "NOTALONE_OWNER_ID=22222222-2222-2222-2222-222222222222\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "NOTALONE_ENV_FILE": str(env_path),
                    "NOTALONE_DATABASE_URL": "postgresql:///from-process",
                },
                clear=True,
            ):
                loaded = load_project_env()

                self.assertEqual(loaded, env_path)
                self.assertEqual(
                    os.environ["NOTALONE_DATABASE_URL"],
                    "postgresql:///from-process",
                )
                self.assertEqual(
                    os.environ["NOTALONE_OWNER_ID"],
                    "22222222-2222-2222-2222-222222222222",
                )

    def test_persist_owner_id_replaces_existing_value_and_keeps_private_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "NOTALONE_DATABASE_URL=postgresql:///synthetic\n"
                "NOTALONE_OWNER_ID=11111111-1111-1111-1111-111111111111\n",
                encoding="utf-8",
            )

            persist_owner_id(
                UUID("33333333-3333-3333-3333-333333333333"), env_path
            )

            self.assertEqual(
                env_path.read_text(encoding="utf-8").count("NOTALONE_OWNER_ID="),
                1,
            )
            self.assertIn(
                "NOTALONE_OWNER_ID=33333333-3333-3333-3333-333333333333",
                env_path.read_text(encoding="utf-8"),
            )
            self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
