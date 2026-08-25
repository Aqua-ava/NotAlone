"""导入与任务进度 API 的进程内契约测试（fake 服务）。

钉住导入预览/提交与任务触发/进度的 JSON 契约、鉴权与失败关闭。
真实持久化与任务执行由既有 ingest/tasks 测试覆盖。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from uuid import UUID, uuid4

from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


class FakeImportService:
    """记录调用并返回合成结果的导入服务 fake。"""

    def __init__(self) -> None:
        self.preview_calls: list[str] = []
        self.commit_calls: list[tuple[str, object]] = []
        self.invalid_path = False

    def preview(self, *, path: str) -> dict[str, object]:
        self.preview_calls.append(path)
        if self.invalid_path:
            raise FileNotFoundError(path)
        return {
            "valid": True,
            "file_name": Path(path).name,
            "record_count": 5,
            "kind_counts": {"text": 4, "image": 1},
            "owner_channel_identity": {"external_id": "wxid_owner", "observed_name": "我自己"},
            "contact_channel_identity": {"external_id": "wxid_contact", "observed_name": "联系人甲"},
        }

    def commit(
        self,
        *,
        path: str,
        owner_id: UUID,
        selection: object,
    ) -> dict[str, object]:
        self.commit_calls.append((path, selection))
        return {
            "imported_count": 5,
            "skipped_duplicates": 0,
            "contact_id": str(CONTACT_ID),
        }


class FakeTaskService:
    """记录调用并返回合成结果的任务服务 fake。"""

    def __init__(self) -> None:
        self.run_calls: list[UUID] = []
        self.progress = {
            "task_id": str(uuid4()),
            "step": "extract_memory",
            "status": "running",
            "processed_count": 12,
            "attempt_count": 2,
            "retry_count": 1,
        }
        self.busy = False

    def start(self, *, owner_id: UUID, contact_id: UUID) -> dict[str, object]:
        self.run_calls.append(contact_id)
        if self.busy:
            return {"status": "busy"}
        return {"status": "started"}

    def current(self, *, owner_id: UUID, contact_id: UUID) -> dict[str, object]:
        if self.busy:
            return {"status": "idle", "progress": None}
        return {"status": "running", "progress": self.progress}


class ImportTaskApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.imports = FakeImportService()
        self.tasks = FakeTaskService()
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            import_service=self.imports,  # type: ignore[arg-type]
            task_host=self.tasks,  # type: ignore[arg-type]
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权
    # ------------------------------------------------------------------

    def test_import_and_task_endpoints_require_token(self) -> None:
        response = self.client.request("POST", "/api/imports/preview")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    def test_import_unavailable_without_service(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.request(
            "POST",
            "/api/imports/preview",
            headers={"Authorization": "Bearer test-token"},
            body=json.dumps({"path": "/tmp/x.jsonl"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"error": "import_task_unavailable"}
        )

    def test_task_unavailable_without_host(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.request(
            "POST",
            "/api/tasks/run",
            headers={"Authorization": "Bearer test-token"},
            body=json.dumps({"contact_id": str(CONTACT_ID)}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"error": "import_task_unavailable"}
        )

    # ------------------------------------------------------------------
    # 导入预览
    # ------------------------------------------------------------------

    def test_preview_returns_validation_summary(self) -> None:
        response = self.client.request(
            "POST",
            "/api/imports/preview",
            headers=self.headers,
            body=json.dumps({"path": "/tmp/chat.jsonl"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["valid"], True)
        self.assertEqual(payload["file_name"], "chat.jsonl")
        self.assertEqual(payload["record_count"], 5)
        self.assertEqual(payload["kind_counts"], {"text": 4, "image": 1})
        self.assertEqual(
            payload["owner_channel_identity"]["external_id"],
            "wxid_owner",
        )
        self.assertEqual(self.imports.preview_calls, ["/tmp/chat.jsonl"])

    def test_preview_rejects_invalid_body(self) -> None:
        for body in (b"not-json", b"{}", b'{"path": ""}'):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/imports/preview",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "import_request_invalid"}
                )

    def test_preview_missing_file_returns_classified_error(self) -> None:
        self.imports.invalid_path = True

        response = self.client.request(
            "POST",
            "/api/imports/preview",
            headers=self.headers,
            body=json.dumps({"path": "/tmp/missing.jsonl"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(
            response.json(),
            {"error": "import_preview_failed", "reason": "preview_failed"},
        )

    # ------------------------------------------------------------------
    # 导入提交
    # ------------------------------------------------------------------

    def test_commit_with_existing_contact(self) -> None:
        response = self.client.request(
            "POST",
            "/api/imports/commit",
            headers=self.headers,
            body=json.dumps(
                {"path": "/tmp/chat.jsonl", "contact_id": str(CONTACT_ID)}
            ).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["imported_count"], 5)
        self.assertEqual(payload["contact_id"], str(CONTACT_ID))

    def test_commit_rejects_conflicting_selection(self) -> None:
        for body in (
            json.dumps({"path": "/tmp/chat.jsonl"}).encode("utf-8"),
            json.dumps(
                {
                    "path": "/tmp/chat.jsonl",
                    "contact_id": str(CONTACT_ID),
                    "new_contact_name": "新联系人",
                }
            ).encode("utf-8"),
        ):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/imports/commit",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "import_request_invalid"}
                )

    # ------------------------------------------------------------------
    # 任务触发与进度
    # ------------------------------------------------------------------

    def test_task_run_without_preflight(self) -> None:
        response = self.client.request(
            "POST",
            "/api/tasks/run",
            headers=self.headers,
            body=json.dumps({"contact_id": str(CONTACT_ID)}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "started"})
        self.assertEqual(self.tasks.run_calls, [CONTACT_ID])

    def test_task_run_busy(self) -> None:
        self.tasks.busy = True

        response = self.client.request(
            "POST",
            "/api/tasks/run",
            headers=self.headers,
            body=json.dumps({"contact_id": str(CONTACT_ID)}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "busy"})

    def test_task_run_rejects_invalid_contact(self) -> None:
        response = self.client.request(
            "POST",
            "/api/tasks/run",
            headers=self.headers,
            body=json.dumps({"contact_id": "not-a-uuid"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "import_request_invalid"})

    def test_task_status_returns_progress(self) -> None:
        response = self.client.get(
            f"/api/tasks/status?contact_id={CONTACT_ID}",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "running")
        progress = payload["progress"]
        self.assertEqual(progress["step"], "extract_memory")
        self.assertEqual(progress["status"], "running")
        self.assertEqual(progress["processed_count"], 12)
        self.assertEqual(progress["attempt_count"], 2)
        self.assertEqual(progress["retry_count"], 1)


if __name__ == "__main__":
    unittest.main()