"""概览的真实 HTTP 夹具：正式初始化与导入，仅使用合成资料。"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import psycopg

from notalone.application.import_service import ImportService
from notalone.application.memory_service import MemoryService
from notalone.application.setup_service import SetupService
from notalone.memory.models import MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend


class MemoryOverviewHttpFixture:
    """依赖显式隔离库；不使用默认库，不调用模型或原生能力。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.database_url = os.environ["NOTALONE_TEST_DATABASE_URL"]
        if cls.database_url != os.environ["NOTALONE_DATABASE_URL"]:
            raise RuntimeError("概览测试必须使用同一显式隔离库。")
        with psycopg.connect(cls.database_url) as connection:
            if (not connection.info.dbname.endswith("_test")
                    or connection.execute("SELECT current_database()").fetchone()[0]
                    != os.environ["NOTALONE_EXPECTED_TEST_DATABASE"]):
                raise RuntimeError("概览测试只允许专用测试库。")

    def setUp(self) -> None:
        self.contact_locators: dict[str, str] = {}
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.setup = SetupService(
            owner_directory=PostgresOwnerDirectory(self.database_url),
            env_path=Path(self.temporary.name) / "synthetic.env",
        )
        bootstrap = self._backend(None)
        status, initialized = bootstrap.request("/api/setup/initialize", {
            "display_name": "概览合成用户",
        })
        self.assertEqual(status, 200, initialized)
        self.assertTrue(initialized["created"], "概览夹具须从空的自有测试库初始化本人。")
        self.owner_id = UUID(initialized["owner_id"])
        self.addCleanup(self._remove_owner)
        self.backend = self._backend(self.owner_id)
        self.assertTrue(self.backend.request("/api/setup/status")[1]["runtime_owner_configured"])

    def _remove_owner(self) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=%s", (self.owner_id,))

    def _backend(self, owner_id: UUID | None, *, overview_service=None,
                 task_host=None, runtime_shutdown=None) -> HttpBackend:
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token="synthetic-overview-token",
            setup_service=self.setup,
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
            **({"overview_service": overview_service} if overview_service is not None else {}), task_host=task_host,
            runtime_shutdown=runtime_shutdown,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _get(self, backend: HttpBackend, path: str) -> dict:
        status, result = backend.request(path)
        self.assertEqual(status, 200, result)
        return result

    def activate_event_worker(self) -> None:
        """沿生产 Worker 装配只替换外部模型，默认空放行表保持。"""
        from unittest.mock import patch
        from notalone.application.model_priority import ModelPriorityControl
        from notalone.server.command import _build_task_host
        from notalone.server.event_bus import EventBus
        from tests.integration.server.grounded_event_support import GroundedEventModel

        self.extraction_model = GroundedEventModel()
        model_patch = patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                            return_value=self.extraction_model)
        model_patch.start()
        self.addCleanup(model_patch.stop)
        priority = ModelPriorityControl()
        task_host = _build_task_host(self.database_url, EventBus(), model_priority=priority,
                                     dimension_release=None)
        self.backend = self._backend(self.owner_id, task_host=task_host, runtime_shutdown=priority.stop)
        self.addCleanup(lambda: [gate.set() for gate in self.extraction_model.response_gates.values()])

    def import_event(self, *, original: str, claim: str, when: str,
                     event_spec: dict, contact_id: str | None = None,
                     event_verification: dict | None = None, **options) -> dict:
        """沿实际导入与生产 Worker，只向模型边界提供受控原文标签。"""
        del claim, options  # 原句由生产编译器生成；不使用旧协议的自由主张或日期。
        from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture

        self.extraction_model.proposals[original] = {
            "kind": "plan" if event_spec["stage"] == "planned" else "event",
            "stage": event_spec["stage"], "period": bool(event_spec.get("occurrence_start")),
        }
        self.extraction_model.verify_events = event_verification is not None
        self.extraction_model.verify_occurrence = bool(event_verification
            and event_verification.get("occurrence_verdict") == "supported")
        timestamp = datetime.fromisoformat(when)
        locator = self.contact_locators.get(contact_id) or f"wxid_overview_contact_{uuid4().hex}"
        records = [{
            "id": {"local_id": number, "server_id_str": uuid4().hex, "talker": locator},
            "create_time": int(timestamp.timestamp()), "is_from_me": from_me, "kind": "text",
            "sender": "合成用户" if from_me else "合成事件联系人",
            "sender_wxid": f"wxid_overview_owner_{self.owner_id.hex}" if from_me else locator,
            "text": text, "time": timestamp.strftime("%Y-%m-%d %H:%M:%S"), "time_iso": when,
        } for number, from_me, text in ((1, False, original), (2, True, "合成记录：已收到。"))]
        source_path = Path(self.temporary.name) / f"grounded-overview-{uuid4().hex}.jsonl"
        source_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records), encoding="utf-8")
        status, imported = self.backend.request("/api/imports/commit", {
            "path": str(source_path), **({"contact_id": contact_id} if contact_id else
                                        {"new_contact_name": "合成事件联系人"}),
        })
        self.assertEqual(status, 200, imported)
        contact_id = imported["contact_id"]
        self.contact_locators[contact_id] = locator
        CoreBusinessFlowFixture._wait_finished(self, self.backend, contact_id)
        message = next(item for item in self._get(self.backend, f"/api/contacts/{contact_id}/messages")["messages"]
                       if item["text"] == original)
        source = next(item for item in self._get(self.backend, f"/api/contacts/{contact_id}/sources")["sources"]
                      if item["file_name"] == source_path.name)
        return {**imported, "message": message, "source": source, "records": records}

    def import_contact(self, text: str, *, when: datetime | None = None,
                       contact_id: str | None = None, locator: str | None = None,
                       owner_text: str | None = None) -> tuple[str, str, UUID]:
        source_path = Path(self.temporary.name) / f"synthetic-{uuid4().hex}.jsonl"
        locator = locator or self.contact_locators.get(contact_id) or f"wxid_overview_contact_{uuid4().hex}"
        when = when or datetime(2024, 1, 1, tzinfo=timezone.utc)
        records = [{
            "id": {"local_id": number, "server_id_str": f"synthetic-{uuid4().hex}",
                   "talker": locator},
            "create_time": int(when.timestamp()) + number,
            "is_from_me": from_me, "kind": "text",
            "sender": "合成用户" if from_me else "合成联系人",
            "sender_wxid": f"wxid_overview_owner_{self.owner_id.hex}" if from_me else locator,
            "text": value, "time": (when + timedelta(seconds=number)).strftime("%Y-%m-%d %H:%M:%S"),
            "time_iso": (when + timedelta(seconds=number)).isoformat(),
        } for number, from_me, value in ((1, False, text), (2, True, owner_text or "好的，合成资料已核对。"))]
        source_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                               encoding="utf-8")
        status, preview = self.backend.request("/api/imports/preview", {
            "path": str(source_path), **({"contact_id": contact_id} if contact_id else {}),
        })
        self.assertEqual(status, 200, preview)
        self.assertTrue(preview["valid"])
        selection = {"contact_id": contact_id} if contact_id else {"new_contact_name": "合成概览联系人"}
        status, imported = self.backend.request("/api/imports/commit", {
            "path": str(source_path), "expected_content_sha256": preview["content_sha256"], **selection,
        })
        self.assertEqual(status, 200, imported)
        contact_id = imported["contact_id"]
        self.contact_locators[contact_id] = locator
        self.assertEqual(imported["imported_count"], 2)
        status, messages = self.backend.request(f"/api/contacts/{contact_id}/messages")
        self.assertEqual(status, 200, messages)
        message = next(item for item in messages["messages"] if item["text"] == text)
        status, sources = self.backend.request(f"/api/contacts/{contact_id}/sources")
        self.assertEqual(status, 200, sources)
        source = next(item for item in sources["sources"] if item["file_name"] == source_path.name)
        self.assertEqual(source["status"], "active")
        return contact_id, source["source_id"], UUID(message["message_id"])

    def confirm(self, contact_id: str, text: str, message_id: UUID,
                *, category: str = "common_fact", **fields) -> dict:
        candidate = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=ContactScope(self.owner_id, UUID(contact_id)),
            text=text, category=MemoryCategory(category), source_ids=(message_id,), **fields,
        ))
        status, confirmed = self.backend.request(
            f"/api/contacts/{contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual(status, 200, confirmed)
        return confirmed["memory"]

    def overview(self, contact_id: str, *, backend: HttpBackend | None = None) -> dict:
        status, result = (backend or self.backend).request(
            f"/api/contacts/{contact_id}/relationship-overview",
        )
        self.assertEqual(status, 200, result)
        return result["overview"]

    def delete_source(self, contact_id: str, source_id: str) -> dict:
        path = f"/api/contacts/{contact_id}/sources/{source_id}"
        deadline = time.monotonic() + 8
        while True:
            status, result = self.backend.request(path, method="DELETE")
            self.assertEqual(status, 202, result)
            if result["status"] == "succeeded":
                return result
            self.assertNotEqual(result["status"], "failed", result)
            self.assertLess(time.monotonic(), deadline, result)
            time.sleep(0.01)
