"""组合验收的合成探针/CLI 输入；同步和绑定判断复用生产引擎。"""

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import psycopg

from notalone.front_sync.factory import build_cli_full_sync_engine
from notalone.server.sync_host import SyncHost
from tests.integration.server.binding_consent_support import prepare_cli


def build_sync(fixture, owner_id):
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    cli = prepare_cli(directory)
    probe = directory / "synthetic-probe"
    probe.write_text(f"#!{sys.executable}\n" + Path(__file__).with_name("foreground-probe-verified.py").read_text())
    probe.chmod(0o700)
    with patch.dict(os.environ, {"NOTALONE_WECHAT_CLI": str(cli), "NOTALONE_SYNC_PROBE": str(probe)}):
        engine = build_cli_full_sync_engine(database_url=fixture.database_url, owner_id=owner_id,
                                           account_scope=f"synthetic-account-{owner_id}")
    host = SyncHost(engine=engine, interval=60)
    fixture.addCleanup(host.stop)
    return host


def prepare_inputs(fixture, contacts):
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    names = ["组合合成会话甲", "组合合成会话乙"]
    with psycopg.connect(fixture.database_url) as connection:
        for contact, name in zip(contacts, names):
            connection.execute("UPDATE public.conversation_binding SET display_name=%s WHERE owner_id=%s AND contact_id=%s",
                               (name, fixture.owner_id, contact))
    (directory / "cli-state.json").write_text(json.dumps({"sessions": [
        {"username": f"wxid_synthetic_{contact}", "display_name": name,
         "chat_type": "private", "last_timestamp": 1700000000} for contact, name in zip(contacts, names)
    ], "messages": {}}))


def observe(index):
    if index not in (0, 1):
        raise ValueError("仅允许两个合成测试联系人。")
    name = ["组合合成会话甲", "组合合成会话乙"][index]
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    (directory / "probe-state.json").write_text(json.dumps({"display_name": name, "selected_row_name": name}))
