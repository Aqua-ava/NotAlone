"""导入 App 及 HTTP 验收共用的合成夹具，仅替换外部模型边界。

运行生产导入、任务及回复 builders、真实回环 HTTP 与随机测试 PG。
控制协议只存在于夹具 stdin，不成为产品 HTTP 或 renderer 能力。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import HumanMessage
from fixture_cleanup import cleanup_fixture

from notalone.application.model_priority import ModelPriorityControl
from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import create_app
from notalone.server.command import _build_import_service, _build_task_host
from notalone.server.connection_info import write_backend_info
from notalone.server.event_bus import EventBus
from notalone.server.reply_wiring import build_reply_service
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)
from tests.integration.server.test_import_auto_flow import AutoMemoryModel


class ImportReplyModel(ScriptedCoreModel):
    """从实际回复输入返回带草稿依据的合成候选，不访问网络。"""

    entered: object = None

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.entered.set()
        self.wait_for_response()
        payload = next(json.loads(message.content) for message in messages
                       if isinstance(message, HumanMessage))
        draft = next(item for item in payload["evidence"]
                     if item["kind"] == "user_draft")
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "我会晚一点回复你。", "basis": "只保留本次合成草稿。",
                "citation_ids": [draft["evidence_id"]], "risk_notes": [],
            }], "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class DesktopImportFixture(CoreBusinessFlowFixture, unittest.TestCase):
    extraction_model_factory = AutoMemoryModel
    reply_model_factory = ImportReplyModel

    def _backend(self, owner_id: UUID) -> HttpBackend:
        priority, events = ModelPriorityControl(), EventBus()
        extraction = patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                           return_value=self.extraction_model)
        extraction.start()
        self.addCleanup(extraction.stop)
        task_host = _build_task_host(self.database_url, events, model_priority=priority)
        with patch("notalone.server.reply_wiring.build_deepseek_model",
                   return_value=self.reply_model):
            reply = build_reply_service(database_url=self.database_url,
                                        owner_id=owner_id, model_priority=priority)

        def stop_runtime() -> None:
            priority.stop()
            task_host.stop(timeout=4)

        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-import-{owner_id}", events=events,
            import_service=_build_import_service(self.database_url),
            task_host=task_host, reply_service=reply,
            setup_service=SetupService(
                owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(os.environ["NOTALONE_ENV_FILE"]),
            ), runtime_shutdown=stop_runtime,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def setUp(self) -> None:
        super().setUp()
        self.addCleanup(self.release_extraction)
        self.contact_ids = [self.prepare_contact(self.owner_id, name)
                            for name in ("合成联系人甲", "合成联系人乙")]
        self.other_contact_id = self.prepare_contact(self.other_owner_id, "另一用户联系人")

    def prepare_contact(self, owner_id: UUID, name: str) -> str:
        contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s, %s, %s)",
                               (contact_id, owner_id, name))
        self.bindings.create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat",
            account_scope=f"synthetic-account-{owner_id}",
            conversation_locator=f"wxid_import_fixture_{contact_id}",
        )
        return str(contact_id)

    def release_extraction(self) -> None:
        for gate in self.extraction_model.gates.values():
            gate.release.set()

    def synthetic_file(self, name: str = "synthetic-import.jsonl") -> Path:
        file_path = Path(self.temporary.name) / name
        fixture_path = Path(__file__).resolve().parents[3] / "backend/tests/fixtures/valid_single_contact.jsonl"
        content = fixture_path.read_text(encoding="utf-8").replace(
            "wxid_synthetic_owner", f"wxid_import_owner_{self.owner_id}",
        ).replace("wxid_synthetic_contact", f"wxid_import_contact_{self.owner_id}")
        rows = [json.loads(line) for line in content.splitlines()]
        rows[0]["text"] = "我平时喜欢茉莉茶。"
        file_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
                             encoding="utf-8")
        return file_path


def main() -> None:
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1":
        raise RuntimeError("合成导入夹具须禁止默认 dotenv。")
    fixture = DesktopImportFixture()
    try:
        DesktopImportFixture.setUpClass()
        fixture.setUp()
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {
            "database_name": fixture.database_name, "database_url": fixture.database_url,
            "owner_id": str(fixture.owner_id), "contact_ids": fixture.contact_ids,
            "other_contact_id": fixture.other_contact_id,
            "file_path": str(fixture.synthetic_file()),
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "hold-extraction":
                fixture.extraction_model.block_call(len(fixture.extraction_model.seen_calls))
                result = {}
            elif operation == "release-extraction":
                fixture.release_extraction()
                result = {}
            elif operation == "fail-extraction":
                start = len(fixture.extraction_model.seen_calls)
                fixture.extraction_model.errors.update({
                    index: RuntimeError("本轮合成模型暂不可用，原始错误不得进入界面。")
                    for index in range(start, start + 3)
                })
                result = {}
            elif operation == "hold-reply":
                fixture.reply_model.pause_next_response()
                result = {}
            elif operation == "release-reply":
                fixture._release_response_gates()
                result = {}
            elif operation == "observations":
                result = {"extraction_calls": len(fixture.extraction_model.seen_calls),
                          "reply_calls": len(fixture.reply_model.seen_calls),
                          "extraction_entered": any(gate.entered.is_set() for gate in fixture.extraction_model.gates.values()),
                          "reply_entered": fixture.reply_model.entered.is_set(),
                          "reply_outbound": [str(message.content) for messages in fixture.reply_model.seen_calls for message in messages],
                          "tool_names": fixture.reply_model.bound_tool_names}
            elif operation == "restart":
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
                result = {}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("未知导入夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
