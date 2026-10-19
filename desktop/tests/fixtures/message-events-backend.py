"""新消息页面验收：实际 PG 消息、生产 EventBus 与认证回环 SSE。

仅安排本轮固定合成资料和外部模型，不替换消息读取或 SSE 响应。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from fixture_cleanup import bind_prepared_database, cleanup_fixture, database_ownership_path

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


class EventReplyModel(rewrite.DesktopRewriteModel):
    """只按实际输入模式阻塞候选阶段，不将关键回答的探索当作候选进入。"""

    generation_entered: Any = None
    pause_generation_response: bool = False

    def __init__(self) -> None:
        super().__init__()
        self.generation_entered = threading.Event()

    def pause_next_generation_response(self) -> None:
        self.generation_entered.clear()
        self.pause_generation_response = True

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.pause_generation_response:
            payload = next(json.loads(message.content) for message in messages
                           if isinstance(message, rewrite.HumanMessage))
            if payload["input_mode"] in {"rewrite_draft", "reply_to_message", "initiate_conversation"}:
                self.pause_generation_response = False
                self.pause_next_response()
                self.generation_entered.set()
        return super()._generate(messages, stop, run_manager, **kwargs)


class ControlledEventBus(EventBus):
    """仅持有生产订阅供本轮断流安排，不改变事件帧或发布规则。"""

    def __init__(self) -> None:
        super().__init__()
        self.subscriptions = []

    def subscribe(self, **kwargs):
        subscription = super().subscribe(**kwargs)
        self.subscriptions.append(subscription)
        return subscription

    def disconnect_streams(self) -> None:
        for subscription in self.subscriptions:
            subscription.close()
        self.subscriptions.clear()


class MessageEventsFixture(rewrite.DesktopRewriteFixture):
    reply_model_factory = EventReplyModel

    def setUp(self) -> None:
        self.event_buses: dict[UUID, ControlledEventBus] = {}
        super().setUp()

    def _backend(self, owner_id: UUID):
        events = ControlledEventBus()
        self.event_buses[owner_id] = events
        create_app = rewrite.create_app

        def create_with_events(**kwargs):
            return create_app(**kwargs, events=events)

        # 保留现有生产装配，仅显式持有同一个总线供合成消息提交后发布。
        with patch.object(rewrite, "create_app", side_effect=create_with_events):
            return super()._backend(owner_id)

    def append_message(self, contact_id: str, *, owner_id: UUID | None = None,
                       text: str = "甲的新合成消息：时间安排更新。",
                       publish_event: bool = True,
                       occurred_at: datetime | None = None) -> dict[str, str]:
        owner_id = owner_id or self.owner_id
        message_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            source_id = connection.execute(
                "SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s",
                (owner_id, UUID(contact_id)),
            ).fetchone()[0]
            connection.execute(
                """INSERT INTO public.message (
                    id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                ) VALUES (%s,%s,%s,'contact','text',%s,COALESCE(%s,now()))""",
                (message_id, owner_id, UUID(contact_id), text, occurred_at),
            )
            connection.execute(
                """INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id, source_kind,
                    source_document_id, source_locator, raw_payload
                ) VALUES (%s,%s,%s,'source_document',%s,%s,'{}'::jsonb)""",
                (message_id, owner_id, UUID(contact_id), source_id, f"synthetic:{message_id}"),
            )
        # 两位合成 owner 的事件进同一总线，仍由生产订阅按认证 owner 筛选。
        if publish_event:
            self.event_buses[self.owner_id].publish(BackendEvent.message_created(
                scope=ContactScope(owner_id, UUID(contact_id)),
                occurred_at=datetime.now(timezone.utc), message_id=message_id,
            ))
        return {"message_id": str(message_id)}


def main() -> None:
    fixture = MessageEventsFixture()
    try:
        MessageEventsFixture._prepared_database_name = bind_prepared_database()
        MessageEventsFixture._database_ownership_path = database_ownership_path()
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
            **fixture.migration_receipt,
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "hold":
                fixture.reply_model.entered.clear()
                fixture.reply_model.pause_next_response()
                result = {}
            elif operation == "hold_generation":
                fixture.reply_model.pause_next_generation_response()
                result = {}
            elif operation == "release":
                fixture.reply_model.pause_generation_response = False
                fixture._release_response_gates()
                result = {}
            elif operation == "append_message":
                result = fixture.append_message(contact_ids[0])
            elif operation == "append_burst":
                result = {"messages": [fixture.append_message(
                    contact_ids[0], text=f"甲的新合成消息：第{index + 1}条近况更新。",
                ) for index in range(3)]}
            elif operation == "append_paged_burst":
                # 先提交全部消息，再逐条发布真实事件，稳定覆盖最新一页与原选择之间的缺口。
                # 固定在同一秒内递增，避免慢机运行速度掩盖 API 丢失亚秒精度的排序问题。
                second = datetime.now(timezone.utc).replace(microsecond=0)
                messages = [fixture.append_message(
                    contact_ids[0], text=f"甲的分页突发消息：第{index + 1:02d}条近况更新。",
                    publish_event=False,
                    occurred_at=second + timedelta(milliseconds=(index + 1) * 10),
                ) for index in range(25)]
                for message in messages:
                    fixture.event_buses[fixture.owner_id].publish(BackendEvent.message_created(
                        scope=ContactScope(fixture.owner_id, UUID(contact_ids[0])),
                        occurred_at=datetime.now(timezone.utc), message_id=UUID(message["message_id"]),
                    ))
                result = {"messages": messages}
            elif operation == "append_other_contact":
                result = fixture.append_message(contact_ids[1], text="乙的新合成消息：时间安排更新。")
            elif operation == "append_other_owner":
                result = fixture.append_message(other_contact_id, owner_id=fixture.other_owner_id,
                                                text="另一用户的新合成消息。")
            elif operation == "publish_foreign_id":
                with psycopg.connect(fixture.database_url) as connection:
                    message_id = connection.execute(
                        "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s LIMIT 1",
                        (fixture.other_owner_id, UUID(other_contact_id)),
                    ).fetchone()[0]
                fixture.event_buses[fixture.owner_id].publish(BackendEvent.message_created(
                    scope=ContactScope(fixture.owner_id, UUID(contact_ids[0])),
                    occurred_at=datetime.now(timezone.utc), message_id=message_id,
                ))
                result = {}
            elif operation == "disconnect_stream":
                fixture.event_buses[fixture.owner_id].disconnect_streams()
                result = {}
            elif operation == "observations":
                result = {"model_calls": len(fixture.reply_model.seen_calls),
                          "payloads": fixture.reply_model.payloads,
                          "model_entered": fixture.reply_model.entered.is_set(),
                          "generation_entered": fixture.reply_model.generation_entered.is_set()}
            elif operation == "exploration_identities":
                # 只观察本轮合成 owner 的实际身份，完成状态仍经公开 HTTP 复验。
                with psycopg.connect(fixture.database_url) as connection:
                    rows = connection.execute(
                        "SELECT id,session_id FROM public.reply_exploration WHERE owner_id=%s",
                        (fixture.owner_id,),
                    ).fetchall()
                result = {"items": [{"exploration_id": str(row[0]), "session_id": str(row[1])}
                                    for row in rows]}
            elif operation == "age_exploration":
                # 只推进本轮合成 owner 的根任务年龄，不替换生产 TTL 判断。
                with psycopg.connect(fixture.database_url) as connection:
                    connection.execute(
                        "UPDATE public.reply_exploration SET created_at=created_at-interval '901 seconds', "
                        "root_created_at=root_created_at-interval '901 seconds' WHERE owner_id=%s",
                        (fixture.owner_id,),
                    )
                result = {}
            elif operation == "restart":
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
                result = {}
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
