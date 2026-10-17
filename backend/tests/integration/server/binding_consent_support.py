"""真实命令、HTTP、随机测试库与合成 CLI 的授权验收夹具。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[4]
DATABASE_PATTERN = re.compile(r"notalone_binding_[0-9a-f]{32}_test")
ACCOUNT = "wxid_synthetic_owner"


def save_migration_output(marker: Path, label: str, result: subprocess.CompletedProcess) -> None:
    for stream in ("stdout", "stderr"):
        descriptor = os.open(marker.parent / f"migration-{label}.{stream}",
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(getattr(result, stream))
            output.flush()
            os.fsync(output.fileno())


def ownership_record(path: Path, name: str, phase: str, *, planned: bool = False) -> None:
    """本轮精确库名在 CREATE 前落盘；只更新本进程已有的私有记录。"""
    directory = path.parent.lstat()
    if (not path.is_absolute() or not stat.S_ISDIR(directory.st_mode)
            or directory.st_uid != os.getuid() or stat.S_IMODE(directory.st_mode) != 0o700
            or not name.isascii() or len(name) > 63 or not DATABASE_PATTERN.fullmatch(name)):
        raise RuntimeError("本轮绑定库须使用精确身份与自有0700目录。")
    flags = os.O_WRONLY | os.O_NOFOLLOW | (os.O_CREAT | os.O_EXCL if planned else os.O_TRUNC)
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as record:
        json.dump({"version": 1, "database_name": name, "pid": os.getpid(), "phase": phase}, record)
        record.flush()
        os.fsync(record.fileno())
    directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def create_database(mode: str = "ready", ownership_path: str | Path | None = None) -> dict:
    if ownership_path is None:
        raise RuntimeError("本轮绑定建库必须提供私有归属记录。")
    marker = Path(ownership_path)
    database_name = f"notalone_binding_{uuid4().hex}_test"
    database_url = f"host=/tmp dbname={database_name}"
    os.environ.update(NOTALONE_DISABLE_DOTENV="1", NOTALONE_DATABASE_URL=database_url,
                      NOTALONE_TEST_DATABASE_URL=database_url)
    ownership_record(marker, database_name, "planned", planned=True)
    # 产品导入发生在本轮精确双 URL 已绑定之后。
    from notalone.persistence.conversation_repository import PostgresConversationBindingRepository

    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
    try:
        ownership_record(marker, database_name, "created")
        with psycopg.connect(database_url) as connection:
            if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                raise RuntimeError("本轮绑定测试库身份不匹配。")
        env = dict(os.environ)
        migrated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(ROOT / "backend/database/migrations")],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        save_migration_output(marker, "initial", migrated)
        if migrated.returncode:
            raise RuntimeError("本轮绑定测试库正式迁移失败。")
        migrations = ROOT / "backend/database/migrations"
        expected = sorted(path.name for path in migrations.glob("*.sql"))
        with psycopg.connect(database_url) as connection:
            recorded = [row[0] for row in connection.execute(
                "SELECT name FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()]
        if (len(expected) != 70 or [name[:3] for name in expected] != [f"{n:03}" for n in range(1, 71)]
                or recorded != expected):
            raise RuntimeError("本轮绑定夹具只接受完整001–070迁移。")
        repeated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(migrations)],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        save_migration_output(marker, "repeat", repeated)
        if repeated.returncode != 0 or json.loads(repeated.stdout)["applied"] != []:
            raise RuntimeError("本轮绑定迁移重复执行必须为0。")
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
                "other_contact_id": str(other_contact), "foreign_bindings": foreign,
                "migration_count": len(recorded), "migration_repeat": 0}
    except BaseException as original_error:
        # 此闭包只在 CREATE 已明确返回成功后进入，不依赖随后可能写失败的 marker。
        try:
            _drop_confirmed_database(database_name)
        except BaseException as cleanup_error:
            original_error.add_note("本轮已确认创建的绑定库清理未确认，保留原始异常与现场。")
            raise original_error from cleanup_error
        raise


def drop_database(name: str, ownership_path: str | Path | None = None) -> None:
    if ownership_path is None or not name.isascii() or len(name) > 63 or not DATABASE_PATTERN.fullmatch(name):
        raise ValueError("只清理本轮已确认创建的精确绑定测试库。")
    marker = Path(ownership_path)
    metadata = marker.lstat()
    parent = marker.parent.lstat()
    if (not marker.is_absolute() or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700
            or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600):
        raise RuntimeError("本轮绑定清理归属记录不可核验。")
    record = json.loads(marker.read_bytes())
    if record.get("database_name") != name or record.get("phase") != "created" or record.get("version") != 1:
        raise RuntimeError("本轮绑定库未确认创建。")
    _drop_confirmed_database(name)


def _drop_confirmed_database(name: str) -> None:
    """调用方已持有 CREATE 成功事实或已核验的 created 记录后才可进入。"""
    if not name.isascii() or len(name) > 63 or not DATABASE_PATTERN.fullmatch(name):
        raise ValueError("本轮绑定清理只接受精确受控库名。")
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
        remaining = admin.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)", (name,)).fetchone()[0]
        if remaining is not False:
            raise RuntimeError("本轮精确绑定库清理未确认。")


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
        self.ownership_path = self.directory / "database-ownership.json"
        self.data = create_database(mode, self.ownership_path)
        self.process = None
        try:
            executable = prepare_cli(self.directory)
            env = dict(os.environ, NOTALONE_DISABLE_DOTENV="1", NOTALONE_ENV_FILE=str(self.directory / "synthetic.env"),
                       NOTALONE_BACKEND_INFO=str(self.directory / "backend.info"), NOTALONE_DATABASE_URL=self.data["database_url"],
                       NOTALONE_TEST_DATABASE_URL=self.data["database_url"],
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
        drop_database(self.data["database_name"], self.ownership_path)
        self.temporary.cleanup()


if __name__ == "__main__":
    if sys.argv[1] == "create":
        print(json.dumps(create_database(sys.argv[2] if len(sys.argv) > 2 else "ready",
                                         sys.argv[3] if len(sys.argv) > 3 else None)))
    elif sys.argv[1] == "drop":
        drop_database(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
