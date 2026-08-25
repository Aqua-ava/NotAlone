"""Skill 管理与设置 API 的进程内契约测试（fake 服务）。

钉住 skill 管理、台账概览端点的 JSON 契约、鉴权与失败关闭。
真实持久化由既有 skill 集成测试覆盖。
"""

from __future__ import annotations

import json
import unittest
from uuid import UUID, uuid4

from notalone.application.skill_service import SkillImportRejected
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeSkillService:
    """记录调用并返回合成结果的 skill 管理服务 fake。"""

    def __init__(self) -> None:
        self.import_calls: list[str] = []
        self.enable_calls: list[UUID] = []
        self.disable_calls: list[UUID] = []
        self.delete_calls: list[UUID] = []
        self.rollback_calls: list[tuple[UUID, UUID]] = []
        self.reject_import = False
        self.entries = [
            {
                "skill_id": str(UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")),
                "name": "warm-reply",
                "description": "温和而明确地回应当前消息",
                "status": "active",
                "contact_id": None,
                "current_version_id": str(UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")),
                "current_version_number": 2,
                "enabled": True,
            }
        ]
        self.preview_result = {
            "skill_id": str(UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")),
            "name": None,
            "description": "温和而明确地回应当前消息",
            "version_number": 2,
            "document": "先回应对方，再给出明确的答复。",
            "resources": ["assets/template.txt"],
        }

    def list(self, *, owner_id: UUID) -> dict[str, object]:
        return {"skills": self.entries}

    def import_skill(self, *, owner_id: UUID, package_path: str) -> dict[str, object]:
        self.import_calls.append(package_path)
        if self.reject_import:
            raise SkillImportRejected("package_invalid")
        return {
            "skill_id": str(UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")),
            "name": "warm-reply",
            "version_number": 1,
            "revision": 1,
            "warnings": [],
        }

    def enable(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        self.enable_calls.append(skill_id)
        return {"skill_id": str(skill_id), "status": "active"}

    def disable(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        self.disable_calls.append(skill_id)
        return {"skill_id": str(skill_id), "status": "disabled"}

    def delete(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        self.delete_calls.append(skill_id)
        return {"skill_id": str(skill_id), "deleted": True}

    def rollback(
        self,
        *,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> dict[str, object]:
        self.rollback_calls.append((skill_id, version_id))
        return {"skill_id": str(skill_id), "version_number": 1}

    def preview(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        return self.preview_result


class FakeLedger:
    """与 PostgresOutboundLedger 同形的最小 fake：只提供 list_by_owner。"""

    def list_by_owner(self, owner_id: UUID) -> tuple[object, ...]:
        from datetime import datetime, timezone

        from notalone.ledger.models import LedgerOutcome

        return (
            type(
                "Entry",
                (),
                {
                    "entry_id": uuid4(),
                    "owner_id": owner_id,
                    "contact_id": uuid4(),
                    "provider": "deepseek",
                    "model_name": "deepseek-chat",
                    "input_tokens": 400,
                    "output_tokens": 300,
                    "latency_ms": 1500,
                    "outcome": LedgerOutcome.SUCCEEDED,
                    "called_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
                },
            )(),
            type(
                "Entry",
                (),
                {
                    "entry_id": uuid4(),
                    "owner_id": owner_id,
                    "contact_id": uuid4(),
                    "provider": "deepseek",
                    "model_name": "deepseek-chat",
                    "input_tokens": 400,
                    "output_tokens": 300,
                    "latency_ms": 1500,
                    "outcome": LedgerOutcome.SUCCEEDED,
                    "called_at": datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                },
            )(),
            type(
                "Entry",
                (),
                {
                    "entry_id": uuid4(),
                    "owner_id": owner_id,
                    "contact_id": uuid4(),
                    "provider": "deepseek",
                    "model_name": "deepseek-chat",
                    "input_tokens": 400,
                    "output_tokens": 200,
                    "latency_ms": 1200,
                    "outcome": LedgerOutcome.RUN_FAILED,
                    "called_at": datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
                },
            )(),
        )


class SkillApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.skills = FakeSkillService()
        from notalone.application.skill_service import LedgerService

        self.ledger = LedgerService(ledger=FakeLedger())
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            skill_service=self.skills,  # type: ignore[arg-type]
            ledger_service=self.ledger,  # type: ignore[arg-type]
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权
    # ------------------------------------------------------------------

    def test_skill_endpoints_require_token(self) -> None:
        response = self.client.get("/api/skills")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    # ------------------------------------------------------------------
    # 列表与预览
    # ------------------------------------------------------------------

    def test_lists_skills(self) -> None:
        response = self.client.get("/api/skills", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["skills"]), 1)
        item = payload["skills"][0]
        self.assertEqual(item["name"], "warm-reply")
        self.assertEqual(item["status"], "active")
        self.assertEqual(item["current_version_number"], 2)
        self.assertEqual(item["enabled"], True)
        self.assertNotIn("document", item)

    def test_preview_skill_version(self) -> None:
        skill_id = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

        response = self.client.get(
            f"/api/skills/{skill_id}/preview",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["description"], "温和而明确地回应当前消息")
        self.assertEqual(payload["version_number"], 2)
        self.assertIn("document", payload)
        self.assertEqual(payload["resources"], ["assets/template.txt"])

    # ------------------------------------------------------------------
    # 导入与生命周期
    # ------------------------------------------------------------------

    def test_imports_skill(self) -> None:
        response = self.client.request(
            "POST",
            "/api/skills/import",
            headers=self.headers,
            body=json.dumps({"package_path": "/tmp/warm-reply"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["name"], "warm-reply")
        self.assertEqual(self.skills.import_calls, ["/tmp/warm-reply"])

    def test_import_rejection_returns_stable_reason(self) -> None:
        self.skills.reject_import = True

        response = self.client.request(
            "POST",
            "/api/skills/import",
            headers=self.headers,
            body=json.dumps({"package_path": "/tmp/bad-skill"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {"error": "skill_import_rejected", "reason": "package_invalid"},
        )

    def test_import_rejects_invalid_body(self) -> None:
        for body in (b"not-json", b"{}", b'{"package_path": ""}'):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/skills/import",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "skill_request_invalid"}
                )

    def test_enable_disable_delete_rollback(self) -> None:
        skill_id = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        version_id = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")

        enable = self.client.request(
            "POST",
            f"/api/skills/{skill_id}/enable",
            headers=self.headers,
        )
        self.assertEqual(enable.status_code, 200)
        self.assertEqual(enable.json()["status"], "active")

        disable = self.client.request(
            "POST",
            f"/api/skills/{skill_id}/disable",
            headers=self.headers,
        )
        self.assertEqual(disable.status_code, 200)
        self.assertEqual(disable.json()["status"], "disabled")

        rollback = self.client.request(
            "POST",
            f"/api/skills/{skill_id}/rollback",
            headers=self.headers,
            body=json.dumps({"version_id": str(version_id)}).encode("utf-8"),
        )
        self.assertEqual(rollback.status_code, 200)
        self.assertEqual(rollback.json()["version_number"], 1)
        self.assertEqual(self.skills.rollback_calls, [(skill_id, version_id)])

        delete = self.client.request(
            "POST",
            f"/api/skills/{skill_id}/delete",
            headers=self.headers,
        )
        self.assertEqual(delete.status_code, 200)
        self.assertEqual(delete.json()["deleted"], True)

    def test_lifecycle_rejects_invalid_skill_id(self) -> None:
        response = self.client.request(
            "POST",
            "/api/skills/not-a-uuid/enable",
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "skill_request_invalid"})

    # ------------------------------------------------------------------
    # 台账概览
    # ------------------------------------------------------------------

    def test_ledger_summary_contains_metadata_only(self) -> None:
        response = self.client.get("/api/ledger/summary", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total_calls"], 3)
        self.assertEqual(payload["provider_counts"], {"deepseek": 3})
        recent = payload["recent"][0]
        self.assertEqual(recent["provider"], "deepseek")
        self.assertIn("contact_id", recent)
        self.assertNotIn("text", recent)
        self.assertNotIn("content", str(payload))

    # ------------------------------------------------------------------
    # 设置：凭据状态
    # ------------------------------------------------------------------

    def test_credentials_status_never_exposes_key(self) -> None:
        response = self.client.get(
            "/api/settings/credentials",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["provider"], "deepseek")
        self.assertIsInstance(payload["configured"], bool)
        self.assertNotIn("key", str(payload))
        self.assertNotIn("api_key", str(payload))

    # ------------------------------------------------------------------
    # 服务不可用
    # ------------------------------------------------------------------

    def test_skill_unavailable_without_service(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.get("/api/skills", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "skill_unavailable"})

        response = client.get("/api/ledger/summary", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "ledger_unavailable"})


if __name__ == "__main__":
    unittest.main()