"""真实命令、HTTP、随机测试库与合成 CLI 的授权验收夹具。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.persistence.conversation_repository import PostgresConversationBindingRepository


ROOT = Path(__file__).resolve().parents[4]
DATABASE_PATTERN = re.compile(r"notalone_binding_[0-9a-f]{32}_test")
ACCOUNT = "wxid_synthetic_owner"


def create_database(mode: str = "ready") -> dict:
    database_name = f"notalone_binding_{uuid4().hex}_test"
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
    try:
        database_url = f"host=/tmp dbname={database_name}"
        env = dict(os.environ, NOTALONE_DISABLE_DOTENV="1", NOTALONE_DATABASE_URL=database_url)
        migrated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(ROOT / "backend/database/migrations")],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        if migrated.returncode:
            raise RuntimeError("本轮绑定测试库正式迁移失败。")
        owner, other_owner, contact_a, contact_b, other_contact = [uuid4() for _ in range(5)]
        with psycopg.connect(database_url) as connection:
            for identity, name in ((owner, "合成用户"), (other_owner, "另一合成用户")):
                connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, %s)", (identity, name))
            if mode != "no-channel":
                # 夹具显式建立合成渠道身份，不冒充首份导入的用户闭环。
                connection.execute("INSERT INTO public.owner_channel_identity (owner_id, channel, external_id, observed_name) VALUES (%s, 'wechat', %s, '合成本人')", (owner, ACCOUNT))
            for identity, parent, name in ((contact_a, owner, "同名联系人"), (contact_b, owner, "同名联系人"), (other_contact, other_owner, "另一用户联系人")):
                connection.execute("INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s, %s, %s)", (identity, parent, name))
        repository = PostgresConversationBindingRepository(database_url)
        foreign = []
        for parent, contact, channel, account, locator in (
            (other_owner, other_contact, "wechat", "other-owner-account", "outside-owner"),
            (owner, contact_a, "wechat", "other-account", "outside-account"),
        ):
            if mode == "single-account" and parent == owner:
                continue
            binding = repository.create_binding(owner_id=parent, contact_id=contact, channel=channel, account_scope=account, conversation_locator=locator, display_name="范围外绑定")
            foreign.append({"binding_id": str(binding.binding_id), "contact_id": str(contact)})
        return {"database_name": database_name, "database_url": database_url, "owner_id": str(owner),
                "other_owner_id": str(other_owner), "contact_ids": [str(contact_a), str(contact_b)],
                "other_contact_id": str(other_contact), "foreign_bindings": foreign}
    except BaseException:
        drop_database(database_name)
        raise


def drop_database(name: str) -> None:
    if not DATABASE_PATTERN.fullmatch(name):
        raise ValueError("只清理本轮随机绑定测试库。")
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


def cli_state() -> dict:
    return {"sessions": [{"username": locator, "display_name": "同名会话", "chat_type": "private", "last_timestamp": 1_700_000_000}
                         for locator in ("wxid_synthetic_a", "wxid_synthetic_b")], "messages": {}}


def prepare_cli(directory: Path) -> Path:
    executable = directory / "controlled-cli"
    executable.write_text(f"#!{sys.executable}\n" + (ROOT / "backend/tests/fixtures/binding_cli.py").read_text())
    executable.chmod(0o700)
    (directory / "cli-state.json").write_text(json.dumps(cli_state()))
    return executable


class BindingBackend:
    def __init__(self, mode: str = "ready") -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="notalone-binding-")
        self.directory = Path(self.temporary.name)
        self.data = create_database(mode)
        self.process = None
        try:
            executable = prepare_cli(self.directory)
            env = dict(os.environ, NOTALONE_DISABLE_DOTENV="1", NOTALONE_ENV_FILE=str(self.directory / "synthetic.env"),
                       NOTALONE_BACKEND_INFO=str(self.directory / "backend.info"), NOTALONE_DATABASE_URL=self.data["database_url"],
                       NOTALONE_OWNER_ID=self.data["owner_id"], NOTALONE_DEEPSEEK_API_KEY="", DEEPSEEK_API_KEY="",
                       NOTALONE_DEEPSEEK_BASE_URL="http://127.0.0.1:1", NOTALONE_WECHAT_CLI=str(executable),
                       NOTALONE_SYNC_PROBE=str(self.directory / "unavailable-probe"), NOTALONE_TEST_BINDING_DIRECTORY=str(self.directory),
                       PYTHONPATH=str(ROOT / "backend/src"), PYTHONNOUSERSITE="1")
            self.process = subprocess.Popen([sys.executable, "-m", "notalone.server.command", "--sync-interval", "60"],
                                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(150):
                if self.process.poll() is not None:
                    raise RuntimeError("本轮合成绑定后端启动失败。")
                try:
                    if self.request("/api/runtime/status")[1]["state"] == "running":
                        break
                except (OSError, ValueError, KeyError):
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("本轮合成绑定后端启动超时。")
        except BaseException:
            self.close()
            raise

    def request(self, endpoint: str, body: dict | None = None, *, token: str | None = None, method: str | None = None) -> tuple[int, dict]:
        fields = dict(line.split("=", 1) for line in (self.directory / "backend.info").read_text().splitlines())
        request = Request(f"http://{fields['address']}{endpoint}", data=None if body is None else json.dumps(body).encode(),
                          method=method, headers={"Authorization": f"Bearer {fields['token'] if token is None else token}", "Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=12)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def set_cli(self, state: dict) -> None:
        (self.directory / "cli-state.json").write_text(json.dumps(state))

    def tails(self) -> list[str]:
        log = self.directory / "tail-calls.jsonl"
        return [json.loads(line)["locator"] for line in log.read_text().splitlines()] if log.exists() else []

    def close(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        drop_database(self.data["database_name"])
        self.temporary.cleanup()


if __name__ == "__main__":
    if sys.argv[1] == "create":
        print(json.dumps(create_database(sys.argv[2] if len(sys.argv) > 2 else "ready")))
    elif sys.argv[1] == "drop":
        drop_database(sys.argv[2])
