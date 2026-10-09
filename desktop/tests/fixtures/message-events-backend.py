"""新消息页面验收：实际 PG 消息、生产 EventBus 与认证回环 SSE。

仅安排本轮固定合成资料和外部模型，不替换消息读取或 SSE 响应。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from fixture_cleanup import cleanup_fixture

from notalone.scopes import ContactScope
from notalone.server.connection_info import write_backend_info
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent

spec = importlib.util.spec_from_file_location(
    "desktop_rewrite_fixture", Path(__file__).with_name("rewrite-backend.py"),
)
assert spec is not None and spec.loader is not None
rewrite = importlib.util.module_from_spec(spec)
# Pydantic 根据类所属模块解析延迟类型注解，必须先登记真实模块命名空间。
sys.modules[spec.name] = rewrite
spec.loader.exec_module(rewrite)


class MessageEventsFixture(rewrite.DesktopRewriteFixture):
    def setUp(self) -> None:
        self.event_buses: dict[UUID, EventBus] = {}
        super().setUp()

    def _backend(self, owner_id: UUID):
        events = EventBus()
        self.event_buses[owner_id] = events
        create_app = rewrite.create_app

        def create_with_events(**kwargs):
            return create_app(**kwargs, events=events)

        # 保留现有生产装配，仅显式持有同一个总线供合成消息提交后发布。
        with patch.object(rewrite, "create_app", side_effect=create_with_events):
            return super()._backend(owner_id)

    def append_message(self, contact_id: str) -> dict[str, str]:
        message_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            source_id = connection.execute(
                "SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, UUID(contact_id)),
            ).fetchone()[0]
            connection.execute(
                """INSERT INTO public.message (
                    id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                ) VALUES (%s,%s,%s,'contact','text',%s,now())""",
                (message_id, self.owner_id, UUID(contact_id), "甲的新合成消息：时间安排更新。"),
            )
            connection.execute(
                """INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id, source_kind,
                    source_document_id, source_locator, raw_payload
                ) VALUES (%s,%s,%s,'source_document',%s,%s,'{}'::jsonb)""",
                (message_id, self.owner_id, UUID(contact_id), source_id, f"synthetic:{message_id}"),
            )
        self.event_buses[self.owner_id].publish(BackendEvent.message_created(
            scope=ContactScope(self.owner_id, UUID(contact_id)),
            occurred_at=datetime.now(timezone.utc), message_id=message_id,
        ))
        return {"message_id": str(message_id)}


def main() -> None:
    fixture = MessageEventsFixture()
    try:
        MessageEventsFixture._database_ownership_path = Path(
            os.environ["NOTALONE_ENV_FILE"],
        ).with_name("message-events-database-ownership.json")
        MessageEventsFixture.setUpClass()
        fixture.setUp()
        contact_ids = [
            fixture.prepare_contact(fixture.owner_id, "合成联系人甲", "甲的原始合成消息。"),
            fixture.prepare_contact(fixture.owner_id, "合成联系人乙", "乙的原始合成消息。"),
        ]
        other_contact_id = fixture.prepare_contact(
            fixture.other_owner_id, "另一用户的联系人", "另一用户的合成消息。",
        )
        empty_contact_id = uuid4()
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,%s)",
                (fixture.owner_id, empty_contact_id, "无消息的合成联系人"),
            )
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {
            "database_url": fixture.database_url, "owner_id": str(fixture.owner_id),
            "contact_ids": contact_ids, "other_contact_id": other_contact_id,
            "empty_contact_id": str(empty_contact_id),
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "append_message":
                result = fixture.append_message(contact_ids[0])
            elif operation == "observations":
                result = {"model_calls": len(fixture.reply_model.seen_calls)}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("未知新消息夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        # 即使 ready 前失败，也保留本轮精确数据库名；不把退出码当作删除证据。
        ownership_path = Path(os.environ["NOTALONE_ENV_FILE"]).with_name("message-events-owned.json")
        ownership = {"child_pid": os.getpid(),
                     "database_name": getattr(type(fixture), "database_name", None),
                     "cleanup_confirmed": False}
        ownership_path.write_text(json.dumps(ownership), encoding="utf-8")
        ownership_path.chmod(0o600)
        cleanup_fixture(fixture)
        ownership["cleanup_confirmed"] = True
        ownership_path.write_text(json.dumps(ownership), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 通用夹具忽略 stderr；仅保存本轮合成进程异常，不输出握手或凭据。
        failure_path = Path(os.environ["NOTALONE_ENV_FILE"]).with_name("message-events-failure.txt")
        failure_path.write_text(traceback.format_exc(), encoding="utf-8")
        failure_path.chmod(0o600)
        raise
