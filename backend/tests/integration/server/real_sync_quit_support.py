"""最终包真实 CLI 生命周期验收：只创建本轮单绑定测试库。"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import importlib.util
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.observation_store import PostgresObservationStore

ROOT = Path(__file__).resolve().parents[4]
PATTERN = re.compile(r"notalone_real_sync_[0-9a-f]{32}_test")
ACCOUNT = "synthetic-real-sync-owner"


def drop(name: str, marker: Path) -> None:
    ownership = json.loads(marker.read_text())
    if not PATTERN.fullmatch(name) or ownership.get("database_name") != name:
        raise ValueError("本轮测试库归属不匹配。")
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
    marker.write_text(json.dumps({"database_name": name, "phase": "removed"}))


def create(marker: Path) -> dict:
    scope = json.loads(Path(os.environ["NOTALONE_REAL_SYNC_SCOPE"]).read_text())
    display_name = "已确认测试联系人"
    if os.environ.get("NOTALONE_REAL_FOREGROUND_MODE") == "1":
        spec = importlib.util.spec_from_file_location(
            "real_foreground_scope", ROOT / "desktop/tests/fixtures/real-sync-python.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        target = module.load_foreground_target()
        if target is None:
            raise ValueError("本轮前台目标凭据缺失。")
        display_name = target["displayName"]
    name = f"notalone_real_sync_{uuid4().hex}_test"
    marker.write_text(json.dumps({"database_name": name, "phase": "reserved"}))
    marker.chmod(0o600)
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
    marker.write_text(json.dumps({"database_name": name, "phase": "created"}))
    try:
        url = f"host=/tmp dbname={name}"
        env = dict(os.environ, NOTALONE_DISABLE_DOTENV="1", NOTALONE_DATABASE_URL=url)
        migrated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(ROOT / "backend/database/migrations")],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        if migrated.returncode:
            raise RuntimeError("本轮测试库迁移失败。")
        owner, contact = uuid4(), uuid4()
        with psycopg.connect(url) as connection:
            connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '同步验收用户')", (owner,))
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '已确认测试联系人')", (owner, contact))
            connection.execute("INSERT INTO public.owner_channel_identity (owner_id, channel, external_id, observed_name) VALUES (%s, 'wechat', %s, '合成本人')", (owner, ACCOUNT))
        binding = PostgresConversationBindingRepository(url).create_binding(
            owner_id=owner, contact_id=contact, channel="wechat", account_scope=ACCOUNT,
            conversation_locator=scope["locator"], display_name=display_name,
        )
        # CLI 的 since-time 仅精确到秒；向前取整，避免回读验收窗口之前正文。
        baseline = datetime.fromtimestamp(math.ceil(scope["not_before"]), tz=timezone.utc)
        PostgresObservationStore(url).ensure_baseline(
            owner_id=owner, contact_id=contact, binding_id=binding.binding_id,
            conversation_locator=scope["locator"], baseline_at=baseline,
        )
        return {"database_name": name, "database_url": url, "owner_id": str(owner),
                "other_owner_id": str(uuid4()), "contact_ids": [str(contact)],
                "other_contact_id": str(uuid4()), "foreign_bindings": []}
    except BaseException:
        drop(name, marker)
        raise


if __name__ == "__main__":
    marker_path = Path(sys.argv[2])
    if sys.argv[1] == "create":
        print(json.dumps(create(marker_path)))
    elif sys.argv[1] == "drop":
        drop(sys.argv[3], marker_path)
    else:
        raise ValueError("未知验收动作。")
