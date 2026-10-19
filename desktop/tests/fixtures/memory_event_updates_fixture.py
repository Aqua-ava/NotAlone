"""生产资料控制器的合成 HTTP 夹具；不启动浏览器或原生 App。"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))

from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server.test_memory_event_updates import (
    MemoryEventHistoricalReviewHttpTest, MemoryEventUpdatesHttpTest,
)


class _DesktopEventSetupMixin:
    """为真实业务夹具装配正式 setup，身份状态从当前测试库查询。"""

    def _backend(self, owner_id: UUID) -> HttpBackend:
        def desktop_app(**kwargs):
            # 基础 HTTP 夹具已提供 setup；本入口只替换为自有桌面配置路径。
            kwargs["setup_service"] = SetupService(
                owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(self.temporary.name) / "synthetic-setup.env",
            )
            return create_app(**kwargs)

        with patch("tests.integration.server.core_business_flow_support.create_app",
                   side_effect=desktop_app):
            return super()._backend(owner_id)


class _DesktopAutoEventFixture(_DesktopEventSetupMixin, MemoryEventUpdatesHttpTest):
    pass


class _DesktopManualEventFixture(_DesktopEventSetupMixin, MemoryEventHistoricalReviewHttpTest):
    pass


def main(*, mode: str | None = None, page_protocol: bool = False) -> None:
    if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone" or not os.environ.get("CONDA_PREFIX"):
        raise RuntimeError("事件 HTTP 夹具须先激活 Conda NotAlone。")
    os.environ.update({
        "NOTALONE_DISABLE_DOTENV": "1", "PYTHON_DOTENV_DISABLED": "1",
        "LANGCHAIN_TRACING_V2": "false", "LANGCHAIN_TRACING": "false", "LANGSMITH_TRACING": "false",
    })
    owner_entry = mode == "owner" or "--owner-entry" in sys.argv
    manual = mode == "manual" or "--default" in sys.argv or owner_entry
    fixture_type = _DesktopManualEventFixture if manual else _DesktopAutoEventFixture
    if page_protocol:
        fixture_type._database_ownership_path = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    fixture = fixture_type(methodName="runTest")
    try:
        fixture_type.setUpClass()
        os.environ.update({"NOTALONE_DATABASE_URL": fixture.database_url,
                           "NOTALONE_TEST_DATABASE_URL": fixture.database_url})
        fixture.setUp()
        if owner_entry:
            status, result = fixture.backend.request("/api/memories/manual-owner", {
                "text": "我计划参加这次读书会。", "category": "relationship_note",
            })
            fixture.assertEqual(status, 200, result)
            old = result["memory"]
            first = fixture.import_event(
                original="合成本人新依据：我在2026年8月2日09:00到10:00参加完之前计划的那次读书会。",
                claim="我已参加完这次读书会。", when="2026-08-02T10:00:00+08:00", subject="self",
                event_spec={"stage": "occurred", "occurrence_start": "2026-08-02T09:00:00+08:00",
                            "occurrence_end": "2026-08-02T10:00:00+08:00"},
                event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
            )
            path = "/api/memories/owner"
            source_to_delete = first["source"]["source_id"]
        else:
            first = fixture.import_event(
                original="合成计划：准备在2026年8月5日09:00到11:00参加这次读书会。" if manual else "合成活动：读书会在一号会议室举行。",
                claim="计划参加这次读书会。" if manual else "读书会在一号会议室举行。",
                when="2026-08-01T10:00:00+08:00",
                **({"fact_overrides": {"speech_act": "plan"},
                    "event_spec": {"stage": "planned", "occurrence_start": "2026-08-05T09:00:00+08:00",
                                   "occurrence_end": "2026-08-05T11:00:00+08:00"},
                    "event_verification": {"stage_verdict": "supported", "occurrence_verdict": "supported"}}
                   if manual else {}),
            )
            path = f"/api/contacts/{first['contact_id']}/memories"
            if manual:
                candidate = fixture._get(fixture.backend, f"/api/contacts/{first['contact_id']}/memory-candidates")["candidates"][0]
                status, result = fixture.backend.request(f"/api/contacts/{first['contact_id']}/memory-candidates/{candidate['candidate_id']}/confirm", {})
                fixture.assertEqual(status, 200, result)
            old = fixture._get(fixture.backend, path)["memories"][0]
            second = fixture.import_event(
                original="合成新依据：已在2026年8月5日09:00到11:00参加完之前计划的那次读书会。" if manual else "合成活动：刚才那场读书会改到二号会议室举行。",
                claim="已参加完这次读书会。" if manual else "读书会改到二号会议室举行。",
                when="2026-08-05T12:00:00+08:00" if manual else "2026-08-01T11:00:00+08:00",
                contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
                **({"event_spec": {"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00",
                                   "occurrence_end": "2026-08-05T11:00:00+08:00"},
                    "event_verification": {"stage_verdict": "supported", "occurrence_verdict": "supported"}}
                   if manual else {}),
            )
            source_to_delete = (second if manual else first)["source"]["source_id"]
        current = fixture._get(fixture.backend, path)["memories"][0]
        pending = fixture._get(fixture.backend, f"/api/contacts/{first['contact_id']}/memory-candidates")["candidates"]
        prepared = {"contactId": first["contact_id"], "old": old, "current": current,
                    "pending": pending, "sourceToDelete": source_to_delete}
        if page_protocol:
            from notalone.server.connection_info import write_backend_info
            empty_contact_id, other_contact_id = uuid4(), uuid4()
            with psycopg.connect(fixture.database_url) as connection:
                for owner_id, contact_id, name in (
                    (fixture.owner_id, empty_contact_id, "无消息的合成联系人"),
                    (fixture.other_owner_id, other_contact_id, "另一用户的合成联系人"),
                ):
                    connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,%s)",
                                       (owner_id, contact_id, name))
            write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
            print(json.dumps({"ready": {"database_url": fixture.database_url,
                                        "owner_id": str(fixture.owner_id),
                                        "contact_ids": [first["contact_id"]],
                                        "other_contact_id": str(other_contact_id),
                                        "empty_contact_id": str(empty_contact_id)}}), flush=True)
        else:
            print(json.dumps({"url": fixture.backend.base_url, "token": fixture.backend.token,
                              "databaseName": fixture.database_name, **prepared}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            if command["operation"] == "stop":
                if page_protocol:
                    print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if page_protocol and command["operation"] == "memory_event_updates":
                print(json.dumps({"id": command["id"], "result": prepared}), flush=True)
                continue
            raise ValueError("合成事件夹具操作无效。")
    finally:
        if page_protocol:
            from fixture_cleanup import cleanup_fixture
            cleanup_fixture(fixture)
        else:
            instance_ok = fixture.doCleanups()
            fixture_type.doClassCleanups()
            if not instance_ok or fixture_type.tearDown_exceptions:
                raise RuntimeError("本轮事件夹具或隔离测试库清理未确认。")
            if not re.fullmatch(r"notalone_core_flow_[0-9a-f]{32}_test", fixture.database_name):
                raise RuntimeError("事件夹具的自有随机库名不可核对。")
            with psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as admin:
                remaining = admin.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)",
                                          (fixture.database_name,)).fetchone()[0]
            if remaining:
                raise RuntimeError("事件夹具自有测试库仍有残留。")
            print(json.dumps({"cleanupConfirmed": True}), flush=True)


if __name__ == "__main__":
    main()
