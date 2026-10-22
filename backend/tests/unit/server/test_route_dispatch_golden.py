"""认证后路由分派的黄金测试；只锁行为，不连接数据库、不启动服务器。

覆盖 `BackendApp._handle_authenticated` 的整条分派顺序：

- 具名 `_handle_*` 处理器：断言「方法+路径 → 被调用的处理器与实参」，
  处理器替换为哨兵响应，因此真实服务不会被执行。
- 内联处理器（联系人增删改、凭据、表达偏好、Skill 整理、组织质量）：
  断言其对外可观察的响应与外部适配器调用。
- 前置守卫：鉴权 401、手动范围 400、runtime_stopping / owner_uninitialized 503。
- 未命中：既有 404。

行为完全由现有实现决定；重构前记录基线，重构后必须逐条保持通过。
"""

from __future__ import annotations

import json
import os
import unittest
from contextlib import ExitStack
from http import HTTPStatus
from unittest.mock import Mock, call, patch
from uuid import UUID

from notalone.application.contact_directory import (
    ContactDataStatus,
    ContactDirectoryError,
    ContactSummary,
)
from notalone.server.app import BackendApp, Response, create_app
from notalone.server.testing import InProcessClient

OWNER_ID = UUID("11111111-1111-4111-8111-111111111111")
CONTACT_ID = UUID("22222222-2222-4222-8222-222222222222")
OTHER_CONTACT_ID = UUID("33333333-3333-4333-8333-333333333333")
MEMORY_ID = UUID("44444444-4444-4444-8444-444444444444")
SOURCE_ID = UUID("55555555-5555-4555-8555-555555555555")
TOKEN = "synthetic-token"
AUTH = {"Authorization": "Bearer synthetic-token"}

# 处理器返回的哨兵响应；分派命中即得到它（个别路径会被 handle() 追加缓存头）。
SENTINEL = Response(HTTPStatus.OK, {"X-Route": "sentinel"}, b'{"sentinel": true}')

MEMORY_BODY = b'{"content": "synthetic-memory"}'
IMPORT_BODY = b'{"source": "synthetic"}'
REPLY_BODY = b'{"contact_id": "synthetic"}'
ASSISTANT_BODY = b'{"message": "synthetic"}'
SETUP_BODY = b'{"step": "synthetic"}'
SYNC_BODY = b'{"direction": "forward"}'

# 分派目标；异步准备默认返回 None，使助手会话继续进入 _handle_assistant_session。
_DISPATCH_HANDLERS = (
    "_handle_assistant_session",
    "_handle_async_preparation",
    "_handle_follow_smoke",
    "_handle_import_task",
    "_handle_ledger",
    "_handle_layered_memory",
    "_handle_memory",
    "_handle_memory_processing",
    "_handle_messages",
    "_handle_overview",
    "_handle_reply_evidence",
    "_handle_reply_explore",
    "_handle_reply_generate",
    "_handle_setup",
    "_handle_skill",
    "_handle_sources",
    "_handle_sync",
    "_handle_trace",
)

# (用例名, 方法, 路径, 请求体, 期望处理器, 期望调用实参)
_DISPATCH_CASES: tuple[tuple[str, str, str, bytes, str, object], ...] = (
    (
        "messages_with_query",
        "GET",
        f"/api/contacts/{CONTACT_ID}/messages?limit=10&cursor=abc",
        b"",
        "_handle_messages",
        call(
            method="GET",
            path=f"/api/contacts/{CONTACT_ID}/messages",
            query="limit=10&cursor=abc",
        ),
    ),
    (
        "messages_post",
        "POST",
        f"/api/contacts/{CONTACT_ID}/messages",
        MEMORY_BODY,
        "_handle_messages",
        call(method="POST", path=f"/api/contacts/{CONTACT_ID}/messages", query=""),
    ),
    (
        "reply_evidence",
        "POST",
        f"/api/contacts/{CONTACT_ID}/replies/{MEMORY_ID}/evidence",
        b"",
        "_handle_reply_evidence",
        call("POST", f"/api/contacts/{CONTACT_ID}/replies/{MEMORY_ID}/evidence"),
    ),
    (
        "sources_delete",
        "DELETE",
        f"/api/contacts/{CONTACT_ID}/sources/{SOURCE_ID}",
        b"",
        "_handle_sources",
        call("DELETE", f"/api/contacts/{CONTACT_ID}/sources/{SOURCE_ID}"),
    ),
    (
        "memory_processing_contact",
        "GET",
        f"/api/contacts/{CONTACT_ID}/memory-processing",
        b"",
        "_handle_memory_processing",
        call("GET", f"/api/contacts/{CONTACT_ID}/memory-processing", b""),
    ),
    (
        "memory_processing_owner",
        "POST",
        f"/api/owner/{OWNER_ID}/memory-processing",
        MEMORY_BODY,
        "_handle_memory_processing",
        call("POST", f"/api/owner/{OWNER_ID}/memory-processing", MEMORY_BODY),
    ),
    (
        "trace_memory_with_query",
        "GET",
        f"/api/contacts/{CONTACT_ID}/memory-traces?tail=20",
        b"",
        "_handle_trace",
        call(
            method="GET",
            path=f"/api/contacts/{CONTACT_ID}/memory-traces",
            query="tail=20",
        ),
    ),
    (
        "trace_source",
        "GET",
        f"/api/contacts/{CONTACT_ID}/source-processing-traces",
        b"",
        "_handle_trace",
        call(
            method="GET",
            path=f"/api/contacts/{CONTACT_ID}/source-processing-traces",
            query="",
        ),
    ),
    (
        "layered_memory_contact_keeps_full_path",
        "GET",
        f"/api/contacts/{CONTACT_ID}/layered-memory?scope=all",
        b"",
        "_handle_layered_memory",
        call(
            method="GET",
            path=f"/api/contacts/{CONTACT_ID}/layered-memory?scope=all",
            body=b"",
        ),
    ),
    (
        "layered_memory_owner",
        "POST",
        "/api/memories/owner/layered-memory",
        MEMORY_BODY,
        "_handle_layered_memory",
        call(method="POST", path="/api/memories/owner/layered-memory", body=MEMORY_BODY),
    ),
    (
        "relationship_overview_contact",
        "GET",
        f"/api/contacts/{CONTACT_ID}/relationship-overview",
        b"",
        "_handle_overview",
        call(method="GET", path=f"/api/contacts/{CONTACT_ID}/relationship-overview"),
    ),
    (
        "relationship_overview_owner",
        "POST",
        "/api/memories/owner/overview",
        MEMORY_BODY,
        "_handle_overview",
        call(method="POST", path="/api/memories/owner/overview"),
    ),
    (
        "overview_precedes_memory_contains",
        "GET",
        f"/api/contacts/{CONTACT_ID}/relationship-overview/memories",
        b"",
        "_handle_overview",
        call(
            method="GET",
            path=f"/api/contacts/{CONTACT_ID}/relationship-overview/memories",
        ),
    ),
    (
        "reply_explore",
        "POST",
        "/api/reply/explore",
        REPLY_BODY,
        "_handle_reply_explore",
        call(method="POST", body=REPLY_BODY),
    ),
    (
        "reply_generate",
        "POST",
        "/api/reply/generate",
        REPLY_BODY,
        "_handle_reply_generate",
        call(method="POST", path="/api/reply/generate", body=REPLY_BODY),
    ),
    (
        "reply_generate_get_passes_method",
        "GET",
        "/api/reply/generate",
        b"",
        "_handle_reply_generate",
        call(method="GET", path="/api/reply/generate", body=b""),
    ),
    (
        "memories_collection",
        "GET",
        f"/api/memories/{MEMORY_ID}",
        b"",
        "_handle_memory",
        call(method="GET", path=f"/api/memories/{MEMORY_ID}", body=b""),
    ),
    (
        "memories_method_passthrough",
        "PATCH",
        f"/api/memories/{MEMORY_ID}",
        MEMORY_BODY,
        "_handle_memory",
        call(method="PATCH", path=f"/api/memories/{MEMORY_ID}", body=MEMORY_BODY),
    ),
    (
        "memory_candidates_contains",
        "GET",
        f"/api/contacts/{CONTACT_ID}/memory-candidates",
        b"",
        "_handle_memory",
        call(method="GET", path=f"/api/contacts/{CONTACT_ID}/memory-candidates", body=b""),
    ),
    (
        "owner_memories_contains",
        "POST",
        f"/api/contacts/{CONTACT_ID}/owner-memories",
        MEMORY_BODY,
        "_handle_memory",
        call(method="POST", path=f"/api/contacts/{CONTACT_ID}/owner-memories", body=MEMORY_BODY),
    ),
    (
        "memories_prefix_without_slash",
        "GET",
        "/api/memoriesXYZ",
        b"",
        "_handle_memory",
        call(method="GET", path="/api/memoriesXYZ", body=b""),
    ),
    (
        "imports_with_query",
        "GET",
        f"/api/imports/{MEMORY_ID}?wait=1",
        b"",
        "_handle_import_task",
        call(
            method="GET",
            path=f"/api/imports/{MEMORY_ID}",
            query="wait=1",
            body=b"",
        ),
    ),
    (
        "tasks_post",
        "POST",
        "/api/tasks",
        IMPORT_BODY,
        "_handle_import_task",
        call(method="POST", path="/api/tasks", query="", body=IMPORT_BODY),
    ),
    (
        "ledger_summary",
        "GET",
        "/api/ledger/summary",
        b"",
        "_handle_ledger",
        call(method="GET", path="/api/ledger/summary"),
    ),
    (
        "skills_item",
        "GET",
        f"/api/skills/{MEMORY_ID}",
        b"",
        "_handle_skill",
        call(method="GET", path=f"/api/skills/{MEMORY_ID}", body=b""),
    ),
    (
        "skills_prefix_without_slash",
        "GET",
        "/api/skillsXYZ",
        b"",
        "_handle_skill",
        call(method="GET", path="/api/skillsXYZ", body=b""),
    ),
    (
        "setup_status",
        "GET",
        "/api/setup/status",
        b"",
        "_handle_setup",
        call(method="GET", path="/api/setup/status", body=b""),
    ),
    (
        "setup_write",
        "POST",
        "/api/setup/wechat",
        SETUP_BODY,
        "_handle_setup",
        call(method="POST", path="/api/setup/wechat", body=SETUP_BODY),
    ),
    (
        "follow_smoke_precedes_sync",
        "GET",
        "/api/sync/follow-smoke/status",
        b"",
        "_handle_follow_smoke",
        call(method="GET", path="/api/sync/follow-smoke/status", body=b""),
    ),
    (
        "sync_status",
        "GET",
        "/api/sync/status",
        b"",
        "_handle_sync",
        call(method="GET", path="/api/sync/status", body=b""),
    ),
    (
        "sync_write",
        "POST",
        "/api/sync/start",
        SYNC_BODY,
        "_handle_sync",
        call(method="POST", path="/api/sync/start", body=SYNC_BODY),
    ),
    (
        "sync_prefix_without_slash",
        "GET",
        "/api/syncXYZ",
        b"",
        "_handle_sync",
        call(method="GET", path="/api/syncXYZ", body=b""),
    ),
)


class RouteDispatchGoldenTest(unittest.TestCase):
    """方法+路径 → 处理器与实参的黄金快照。"""

    def setUp(self) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=OWNER_ID,
            token=TOKEN,
        )
        # handle() 里助手提交后的 Skill 整理调度不属于路由分派，测试里关掉以免触库。
        self.app._skill_learning = None
        self.client = InProcessClient(self.app)

    def _run_patched(
        self,
        *,
        method: str,
        path: str,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
        async_response: Response | None = None,
        app: BackendApp | None = None,
    ) -> tuple[Response, dict[str, Mock]]:
        """替换所有具名处理器后调用应用，返回响应与各处理器替身。"""

        calls: dict[str, Mock] = {}
        with ExitStack() as stack:
            for name in _DISPATCH_HANDLERS:
                value = async_response if name == "_handle_async_preparation" else SENTINEL
                calls[name] = stack.enter_context(
                    patch.object(BackendApp, name, return_value=value)
                )
            response = (app or self.app).handle(
                method=method,
                path=path,
                headers=AUTH if headers is None else headers,
                body=body,
            )
        return response, calls

    def _assert_no_handler_called(self, calls: dict[str, Mock]) -> None:
        called = [name for name, mock in calls.items() if mock.call_count]
        self.assertEqual(called, [], f"不应命中具名处理器：{called}")

    def test_dispatch_table(self) -> None:
        for label, method, path, body, handler, expected_call in _DISPATCH_CASES:
            with self.subTest(case=label):
                response, calls = self._run_patched(method=method, path=path, body=body)
                self.assertEqual(response.status_code, SENTINEL.status_code)
                self.assertEqual(response.body, SENTINEL.body)
                self.assertEqual(calls[handler].call_args, expected_call)
                self._assert_no_handler_called(
                    {name: mock for name, mock in calls.items() if name != handler}
                )

    def test_assistant_session_flow(self) -> None:
        path = f"/api/contacts/{CONTACT_ID}/assistant-session?mode=discuss"
        response, calls = self._run_patched(
            method="POST", path=path, body=ASSISTANT_BODY
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(response.body, SENTINEL.body)
        self.assertEqual(
            calls["_handle_async_preparation"].call_args,
            call(
                "POST",
                f"/api/contacts/{CONTACT_ID}/assistant-session",
                AUTH,
                ASSISTANT_BODY,
            ),
        )
        self.assertEqual(
            calls["_handle_assistant_session"].call_args,
            call(
                "POST",
                f"/api/contacts/{CONTACT_ID}/assistant-session",
                ASSISTANT_BODY,
                "mode=discuss",
            ),
        )
        for name, mock in calls.items():
            if name in {"_handle_async_preparation", "_handle_assistant_session"}:
                continue
            self.assertEqual(mock.call_count, 0, f"不应调用 {name}")

    def test_assistant_session_paths_with_plural_segment(self) -> None:
        path = f"/api/contacts/{CONTACT_ID}/assistant-sessions/generate"
        response, calls = self._run_patched(method="POST", path=path, body=ASSISTANT_BODY)
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(response.body, SENTINEL.body)
        self.assertEqual(
            calls["_handle_assistant_session"].call_args,
            call("POST", path, ASSISTANT_BODY, ""),
        )

    def test_assistant_preparation_short_circuits_session(self) -> None:
        path = f"/api/contacts/{CONTACT_ID}/assistant-session"
        response, calls = self._run_patched(
            method="POST", path=path, body=ASSISTANT_BODY, async_response=SENTINEL
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(response.body, SENTINEL.body)
        self.assertEqual(calls["_handle_assistant_session"].call_count, 0)

    def test_layered_memory_quality_adapter(self) -> None:
        path = f"/api/layered-memory/quality-inputs/{MEMORY_ID}"
        with patch(
            "notalone.server.organization_quality.handle_quality",
            return_value=SENTINEL,
        ) as adapter:
            response, calls = self._run_patched(method="GET", path=path)
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(response.body, SENTINEL.body)
        self.assertEqual(
            adapter.call_args,
            call(self.app._layered_memory, OWNER_ID, "GET", path, b""),
        )
        self._assert_no_handler_called(calls)

    def test_expression_preferences_adapter(self) -> None:
        path = "/api/expression-preferences?contact_id=synthetic"
        with patch(
            "notalone.server.app.handle_expression_preferences",
            return_value=(HTTPStatus.OK, {"route": "expression-preferences"}),
        ) as adapter:
            response, calls = self._run_patched(method="GET", path=path)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(response.json(), {"route": "expression-preferences"})
        self.assertEqual(
            adapter.call_args,
            call(
                self.app._expression_preferences,
                owner_id=OWNER_ID,
                method="GET",
                path="/api/expression-preferences",
                body=b"",
                query="contact_id=synthetic",
            ),
        )
        self._assert_no_handler_called(calls)

    def test_expression_preferences_unavailable(self) -> None:
        self.app._expression_preferences = None
        with patch(
            "notalone.server.app.handle_expression_preferences"
        ) as adapter:
            response, _ = self._run_patched(
                method="GET", path="/api/expression-preferences"
            )
        self.assertEqual(response.status_code, HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"error": "expression_preference_unavailable"})
        adapter.assert_not_called()

    def test_skill_learning_adapter(self) -> None:
        path = f"/api/contacts/{CONTACT_ID}/skill-learning/pending"
        with patch(
            "notalone.server.app.handle_skill_learning",
            return_value=(HTTPStatus.OK, {"route": "skill-learning"}),
        ) as adapter:
            response, calls = self._run_patched(method="GET", path=path)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(response.json(), {"route": "skill-learning"})
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(
            adapter.call_args,
            call(
                self.app._skill_learning,
                owner_id=OWNER_ID,
                method="GET",
                path=path,
                body=b"",
            ),
        )
        self._assert_no_handler_called(calls)


class InlineRouteGoldenTest(unittest.TestCase):
    """内联路由（联系人、凭据）的响应与外部调用快照。"""

    def setUp(self) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=OWNER_ID,
            token=TOKEN,
        )
        self.app._skill_learning = None
        self.client = InProcessClient(self.app)

    def _fake_directory(self) -> Mock:
        directory = Mock()
        directory.list_contacts.return_value = (
            ContactSummary(CONTACT_ID, "合成联系人甲", ContactDataStatus(2, 1)),
        )
        directory.create_contact.return_value = ContactSummary(
            CONTACT_ID, "合成联系人甲", ContactDataStatus(0, 0),
        )
        self.app._contact_directory = directory
        return directory

    def test_contacts_list(self) -> None:
        directory = self._fake_directory()
        response = self.client.request("GET", "/api/contacts", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(
            response.json(),
            {
                "contacts": [
                    {
                        "contact_id": str(CONTACT_ID),
                        "display_name": "合成联系人甲",
                        "data_status": {"message_count": 2, "source_count": 1},
                    }
                ]
            },
        )
        directory.list_contacts.assert_called_once_with(OWNER_ID)

    def test_contacts_list_failure_maps_to_stable_500(self) -> None:
        directory = self._fake_directory()
        directory.list_contacts.side_effect = ContactDirectoryError("synthetic")
        with self.assertLogs("notalone.server.app", level="ERROR"):
            response = self.client.request("GET", "/api/contacts", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(response.json(), {"error": "contact_list_unavailable"})

    def test_contacts_create(self) -> None:
        directory = self._fake_directory()
        request_id = UUID("66666666-6666-4666-8666-666666666666")
        body = json.dumps(
            {"request_id": str(request_id), "display_name": "合成联系人甲"}
        ).encode("utf-8")
        response = self.client.request("POST", "/api/contacts", headers=AUTH, body=body)
        self.assertEqual(response.status_code, HTTPStatus.CREATED)
        self.assertEqual(
            response.json(),
            {
                "contact": {
                    "contact_id": str(CONTACT_ID),
                    "display_name": "合成联系人甲",
                    "data_status": {"message_count": 0, "source_count": 0},
                }
            },
        )
        directory.create_contact.assert_called_once_with(OWNER_ID, request_id, "合成联系人甲")

    def test_contacts_create_rejects_malformed_body(self) -> None:
        directory = self._fake_directory()
        for body in (
            b"not-json",
            b'{"request_id": "synthetic"}',
            json.dumps({"request_id": str(OWNER_ID), "display_name": "x", "extra": 1}).encode(),
        ):
            response = self.client.request(
                "POST", "/api/contacts", headers=AUTH, body=body
            )
            self.assertEqual(response.status_code, HTTPStatus.BAD_REQUEST)
            self.assertEqual(response.json(), {"error": "contact_input_invalid"})
        directory.create_contact.assert_not_called()

    def test_contacts_create_conflict(self) -> None:
        directory = self._fake_directory()
        directory.create_contact.side_effect = ContactDirectoryError("synthetic")
        body = json.dumps(
            {
                "request_id": str(UUID("66666666-6666-4666-8666-666666666666")),
                "display_name": "合成联系人甲",
            }
        ).encode("utf-8")
        response = self.client.request("POST", "/api/contacts", headers=AUTH, body=body)
        self.assertEqual(response.status_code, HTTPStatus.CONFLICT)
        self.assertEqual(response.json(), {"error": "contact_operation_unavailable"})

    def test_manual_confirmation(self) -> None:
        directory = self._fake_directory()
        path = f"/api/contacts/{CONTACT_ID}/manual-confirmation"
        response = self.client.request("POST", path, headers=AUTH, body=b"{}")
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(response.json(), {"confirmed": True})
        directory.confirm_manual.assert_called_once_with(OWNER_ID, CONTACT_ID)

    def test_manual_confirmation_rejects_wrong_shapes(self) -> None:
        directory = self._fake_directory()
        for path, body in (
            (f"/api/contacts/{CONTACT_ID}/manual-confirmation", b'{"extra": 1}'),
            ("/api/contacts/manual-confirmation", b"{}"),
            ("/api/manual-confirmation", b"{}"),
            (f"/api/contacts/{CONTACT_ID}/manual-confirmation", b"not-json"),
        ):
            response = self.client.request("POST", path, headers=AUTH, body=body)
            self.assertEqual(response.status_code, HTTPStatus.BAD_REQUEST)
            self.assertEqual(response.json(), {"error": "contact_input_invalid"})
        directory.confirm_manual.assert_not_called()

    def test_credentials_read(self) -> None:
        with patch.dict(
            os.environ, {"NOTALONE_DEEPSEEK_API_KEY": " synthetic-key "}
        ):
            response = self.client.request("GET", "/api/settings/credentials", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(
            response.json(), {"provider": "deepseek", "configured": True}
        )

    def test_credentials_missing(self) -> None:
        with patch.dict(os.environ, {"NOTALONE_DEEPSEEK_API_KEY": "   "}):
            response = self.client.request("GET", "/api/settings/credentials", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(
            response.json(), {"provider": "deepseek", "configured": False}
        )

    def test_credentials_rejects_other_methods(self) -> None:
        for method in ("POST", "PATCH", "DELETE"):
            response = self.client.request(
                method, "/api/settings/credentials", headers=AUTH
            )
            self.assertEqual(response.status_code, HTTPStatus.NOT_FOUND)
            self.assertEqual(response.json(), {"error": "not_found"})


class GuardAndFallbackGoldenTest(unittest.TestCase):
    """前置守卫、运行期生命周期端点与未命中 404 的顺序快照。"""

    def setUp(self) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=OWNER_ID,
            token=TOKEN,
        )
        self.app._skill_learning = None
        self.client = InProcessClient(self.app)

    def _unowned_app(self) -> BackendApp:
        app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=None,
            token=TOKEN,
        )
        app._skill_learning = None
        return app

    def test_authentication_required(self) -> None:
        self.assertEqual(
            self.client.request("GET", "/api/runtime/status").status_code,
            HTTPStatus.UNAUTHORIZED,
        )
        self.assertEqual(
            self.client.request(
                "GET",
                "/api/runtime/status",
                headers={"Authorization": "Bearer wrong-token"},
            ).json(),
            {"error": "unauthorized"},
        )

    def test_manual_scope_header_guard(self) -> None:
        manual_headers = {
            **AUTH,
            "X-NotAlone-Manual-Contact": str(CONTACT_ID),
        }
        for path, headers in (
            (
                f"/api/contacts/{CONTACT_ID}/memories",
                {**AUTH, "X-NotAlone-Manual-Contact": "not-a-uuid"},
            ),
            (f"/api/contacts/{CONTACT_ID}/memories", manual_headers),
            (
                f"/api/contacts/{OTHER_CONTACT_ID}/assistant-session",
                manual_headers,
            ),
        ):
            response = self.client.request("GET", path, headers=headers)
            self.assertEqual(response.status_code, HTTPStatus.BAD_REQUEST)
            self.assertEqual(response.json(), {"error": "manual_scope_invalid"})

    def test_manual_scope_header_allows_matching_assistant_session(self) -> None:
        headers = {**AUTH, "X-NotAlone-Manual-Contact": str(CONTACT_ID)}
        path = f"/api/contacts/{CONTACT_ID}/assistant-session"
        response, calls = _run_with_patched_handlers(
            self.app, method="POST", path=path, headers=headers
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(response.body, SENTINEL.body)
        self.assertEqual(
            calls["_handle_assistant_session"].call_args,
            call("POST", path, b"", ""),
        )

    def test_runtime_status_and_method_differences(self) -> None:
        self.assertEqual(
            self.client.request("GET", "/api/runtime/status", headers=AUTH).json(),
            {"state": "running"},
        )
        self.app._runtime_stopping.set()
        self.assertEqual(
            self.client.request("GET", "/api/runtime/status", headers=AUTH).json(),
            {"state": "stopping"},
        )
        self.app._runtime_stopping.clear()
        self.app._runtime_stopped.set()
        self.assertEqual(
            self.client.request("GET", "/api/runtime/status", headers=AUTH).json(),
            {"state": "stopped"},
        )
        for method, path in (
            ("POST", "/api/runtime/status"),
            ("GET", "/api/runtime/shutdown"),
        ):
            response = self.client.request(method, path, headers=AUTH)
            self.assertEqual(response.status_code, HTTPStatus.NOT_FOUND)
            self.assertEqual(response.json(), {"error": "not_found"})

    def test_runtime_shutdown_unavailable_and_available(self) -> None:
        response = self.client.request("POST", "/api/runtime/shutdown", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"error": "runtime_unavailable"})

        stopped: list[str] = []
        app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=OWNER_ID,
            token=TOKEN,
            runtime_shutdown=lambda: stopped.append("stopped"),
        )
        client = InProcessClient(app)
        response = client.request("POST", "/api/runtime/shutdown", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(response.json(), {"state": "stopped"})
        self.assertEqual(stopped, ["stopped"])

    def test_runtime_stopping_guard_exemptions(self) -> None:
        self.app._runtime_stopping.set()
        response, calls = _run_with_patched_handlers(
            self.app, method="GET", path="/api/sync/status"
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(calls["_handle_sync"].call_args, call(
            method="GET", path="/api/sync/status", body=b""
        ))

        response, calls = _run_with_patched_handlers(
            self.app, method="GET", path="/api/setup/status"
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(calls["_handle_setup"].call_args, call(
            method="GET", path="/api/setup/status", body=b""
        ))

        response = self.client.request(
            "POST", "/api/reply/generate", headers=AUTH
        )
        self.assertEqual(response.status_code, HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"error": "runtime_stopping"})

    def test_owner_uninitialized_guard(self) -> None:
        app = self._unowned_app()
        client = InProcessClient(app)
        self.assertEqual(
            client.request("GET", "/api/runtime/status", headers=AUTH).json(),
            {"state": "running"},
        )
        response, calls = _run_with_patched_handlers(
            app, method="GET", path="/api/setup/status"
        )
        self.assertEqual(response.status_code, SENTINEL.status_code)
        self.assertEqual(calls["_handle_setup"].call_count, 1)

        with patch.dict(os.environ, {"NOTALONE_DEEPSEEK_API_KEY": "   "}):
            response = client.request("GET", "/api/settings/credentials", headers=AUTH)
        self.assertEqual(response.status_code, HTTPStatus.OK)
        self.assertEqual(response.json(), {"provider": "deepseek", "configured": False})

        for path in ("/api/sync/status", "/api/contacts"):
            response = client.request("GET", path, headers=AUTH)
            self.assertEqual(response.status_code, HTTPStatus.SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"error": "owner_uninitialized"})

    def test_unmatched_paths_fall_through_to_existing_404(self) -> None:
        for method, path in (
            ("GET", "/api/unknown"),
            ("GET", f"/api/contacts/{CONTACT_ID}"),
            ("POST", f"/api/contacts/{CONTACT_ID}/messages/extra"),
            ("GET", f"/api/contacts/{CONTACT_ID}/evidence/extra"),
            ("GET", "/api/ledger/summary/extra"),
            ("GET", "/api/importXYZ"),
        ):
            response = self.client.request(method, path, headers=AUTH)
            self.assertEqual(response.status_code, HTTPStatus.NOT_FOUND)
            self.assertEqual(response.json(), {"error": "not_found"})


def _run_with_patched_handlers(
    app: BackendApp,
    *,
    method: str,
    path: str,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
) -> tuple[Response, dict[str, Mock]]:
    """模块级替身安装器；供不继承 RouteDispatchGoldenTest 的守卫用例使用。"""

    calls: dict[str, Mock] = {}
    with ExitStack() as stack:
        for name in _DISPATCH_HANDLERS:
            value = None if name == "_handle_async_preparation" else SENTINEL
            calls[name] = stack.enter_context(
                patch.object(BackendApp, name, return_value=value)
            )
        response = app.handle(
            method=method,
            path=path,
            headers=AUTH if headers is None else headers,
            body=body,
        )
    return response, calls


if __name__ == "__main__":
    unittest.main()
