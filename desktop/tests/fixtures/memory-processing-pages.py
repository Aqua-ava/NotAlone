"""记忆进度页面验收：隔离 PG、真实任务和 HTTP，仅外部模型使用合成响应。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import psycopg

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))

from fixture_cleanup import (
    bind_prepared_database, cleanup_fixture, database_ownership_path,
    verify_full_migrations,
)
from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import create_app
from notalone.server.connection_info import write_backend_info
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, tool_response
from tests.integration.server.test_failed_task_recovery import FailedTaskRecoveryHttpTest


class ProcessingPages(FailedTaskRecoveryHttpTest):
    """复用完整建库/清理约定及公开导入、恢复测试的业务夹具。"""

    _prepared_database_name = None
    _database_ownership_path = None
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def _backend(self, owner_id):
        def desktop_app(**kwargs):
            # 本夹具没有微信读取资源；正式 shutdown_runtime 仍负责停止任务宿主。
            kwargs["runtime_shutdown"] = lambda: None
            kwargs["setup_service"] = SetupService(
                owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(self.temporary.name) / "synthetic-setup.env",
            )
            return create_app(**kwargs)

        with patch(
            "tests.integration.server.test_failed_task_recovery.create_app",
            side_effect=desktop_app,
        ):
            return super()._backend(owner_id)


def main() -> None:
    ProcessingPages._prepared_database_name = bind_prepared_database()
    ProcessingPages._database_ownership_path = database_ownership_path()
    fixture = ProcessingPages(methodName="runTest")
    try:
        ProcessingPages.setUpClass()
        os.environ.update({
            "NOTALONE_DATABASE_URL": fixture.database_url,
            "NOTALONE_TEST_DATABASE_URL": fixture.database_url,
        })
        receipt = verify_full_migrations(fixture.database_name, fixture.database_url)
        fixture.setUp()
        fixture.model.unavailable = False
        fixture.model.responses.extend([
            tool_response("MemoryExtractionOutput", {"facts": []}) for _ in range(20)
        ])
        imported = fixture._import(backend=fixture.queued_backend)
        other, empty = uuid4(), uuid4()
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute(
                "INSERT INTO contact(owner_id,id,display_name) VALUES (%s,%s,%s),(%s,%s,%s)",
                (fixture.owner_id, empty, "无任务的合成联系人",
                 fixture.other_owner_id, other, "其他用户的合成联系人"),
            )
        write_backend_info(
            address=fixture.backend.base_url.removeprefix("http://"),
            token=fixture.backend.token,
        )
        print(json.dumps({"ready": {
            "database_url": fixture.database_url,
            "owner_id": str(fixture.owner_id),
            "contact_ids": [imported["contact_id"]],
            "other_contact_id": str(other),
            "empty_contact_id": str(empty),
            **receipt,
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if operation != "processing_evidence":
                raise ValueError("进度页面夹具操作无效。")
            print(json.dumps({"id": command["id"], "result": {
                "model_calls": len(fixture.model.seen_calls),
                "task_id": imported["task_id"],
            }}), flush=True)
    finally:
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
