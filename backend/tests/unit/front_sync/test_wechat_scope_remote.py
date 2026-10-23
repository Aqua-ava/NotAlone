"""迁移范围端口只使用合成 loopback 服务，不连接业务数据库。"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch
from uuid import UUID

from notalone.front_sync.wechat_scope_remote import RemoteWechatScope, RemoteHistoryAuthorization, WechatScopeOwnedByTypeScript
from notalone.front_sync.full_sync_engine import CliFullSyncEngine

OWNER = UUID("33333333-3333-3333-3333-333333333333")
SCOPE = dict(owner_id=OWNER, channel="wechat", account_scope="synthetic-account")


class RemoteWechatScopeTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        self.received = threading.Event()
        self.release = threading.Event()
        self.block_response = False
        self.payload = {"mode": "all_private", "granted_at": "2026-10-24T00:00:00Z"}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                outer.requests.append((self.path, self.headers.get("Authorization"),
                                       json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                outer.received.set()
                if outer.block_response:
                    outer.release.wait(3)
                self.send_response(outer.status)
                self.end_headers()
                try:
                    self.wfile.write(json.dumps(outer.payload).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.remote = RemoteWechatScope(url=f"http://127.0.0.1:{self.server.server_port}",
                                       token="synthetic-token", owner_id=OWNER,
                                       account_scope=SCOPE["account_scope"])

    def tearDown(self):
        self.release.set()
        self.remote.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def test_close_interrupts_inflight_discovery_without_waiting_for_response(self):
        self.block_response = True
        errors = []
        def run():
            try:
                self.remote.discover(**SCOPE)
            except RuntimeError as error:
                errors.append(str(error))
        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(self.received.wait(1))
        self.remote.close()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, ["wechat_scope_remote_unavailable"])

    def test_identity_and_authentication_are_bound_to_fixed_path(self):
        self.assertEqual(self.remote.read(**SCOPE).mode, "all_private")
        path, token, body = self.requests[0]
        self.assertEqual(path, "/api/runtime/wechat-scope/state")
        self.assertEqual(token, "Bearer synthetic-token")
        self.assertEqual(body, {**SCOPE, "owner_id": str(OWNER)})
        with self.assertRaisesRegex(ValueError, "identity_mismatch"):
            self.remote.read(**{**SCOPE, "account_scope": "other-account"})
        self.assertEqual(len(self.requests), 1)

    def test_revoke_preserves_business_status_and_exact_scope(self):
        for status in (200, 404, 409, 503):
            self.status = status
            self.payload = {"error": "synthetic"} if status != 200 else {"status": "revoked"}
            self.assertEqual(self.remote.revoke(contact_id=OWNER, binding_id=OWNER),
                             {"status": status, "body": self.payload})
        path, _, body = self.requests[-1]
        self.assertEqual(path, "/api/runtime/wechat-scope/revoke")
        self.assertEqual(body, {**SCOPE, "owner_id": str(OWNER),
                               "contact_id": str(OWNER), "binding_id": str(OWNER)})
        engine = object.__new__(CliFullSyncEngine)
        engine._scope_store = None
        with self.assertRaisesRegex(RuntimeError, "not_transferred"):
            engine.revoke_transferred_binding(contact_id=OWNER, binding_id=OWNER)
        engine._scope_store = self.remote
        self.assertEqual(engine.revoke_transferred_binding(contact_id=OWNER, binding_id=OWNER)["status"], 503)

    def test_history_binding_budget_supports_full_allowed_selection(self):
        identifiers = [str(UUID(int=index + 1)) for index in range(5000)]
        self.payload = {"binding_ids": identifiers}
        self.assertEqual(len(self.remote.authorized_binding_ids(**SCOPE)), 5000)
        self.payload = {"binding_ids": identifiers + [str(UUID(int=5001))]}
        with self.assertRaisesRegex(RuntimeError, "invalid_response"):
            self.remote.authorized_binding_ids(**SCOPE)
        self.payload = {"binding_ids": [], "oversized": "x" * 262144}
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.remote.authorized_binding_ids(**SCOPE)

    def test_history_status_does_not_grant_account_wide_execution(self):
        authorization = RemoteHistoryAuthorization(self.remote)
        self.payload = {"state": "accepted", "version": 1, "current_version": 1}
        self.assertTrue(authorization.read(**SCOPE).authorized)
        self.assertEqual(self.requests[0][0], "/api/runtime/wechat-scope/history-state")
        self.assertFalse(authorization.history_sync_authorized(**SCOPE))
        with self.assertRaises(WechatScopeOwnedByTypeScript):
            authorization.decide(**SCOPE, decision="accepted")
        for value in ({"state": "accepted", "version": True, "current_version": 1},
                      {"state": "invalid", "version": 1, "current_version": 1}):
            self.payload = value
            with self.assertRaisesRegex(RuntimeError, "invalid_response"):
                authorization.read(**SCOPE)

    def test_history_authorization_is_a_validated_binding_snapshot(self):
        self.payload = {"binding_ids": [str(OWNER)]}
        self.assertEqual(self.remote.authorized_binding_ids(**SCOPE), frozenset([OWNER]))
        self.assertEqual(self.requests[0][0], "/api/runtime/wechat-scope/history-bindings")
        self.payload = {"binding_ids": []}
        self.assertEqual(self.remote.authorized_binding_ids(**SCOPE), frozenset())
        for value in (None, True, "accepted", [True], ["invalid"], [str(OWNER)] * 2):
            self.payload = {"binding_ids": value}
            with self.assertRaisesRegex(RuntimeError, "invalid_response"):
                self.remote.authorized_binding_ids(**SCOPE)
        before = len(self.requests)
        with self.assertRaisesRegex(ValueError, "identity_mismatch"):
            self.remote.authorized_binding_ids(**{**SCOPE, "channel": "other"})
        self.assertEqual(len(self.requests), before)

    def test_discovery_returns_only_bounded_count(self):
        self.payload = {"created": 2}
        self.assertEqual(self.remote.discover(**SCOPE), 2)
        self.assertEqual(self.requests[0][0], "/api/runtime/wechat-scope/discover")
        for value in (True, -1, 251, "2"):
            self.payload = {"created": value}
            with self.assertRaisesRegex(RuntimeError, "invalid_response"):
                self.remote.discover(**SCOPE)

    def test_redirect_and_failures_never_fallback_or_expose_payload(self):
        self.status = 302
        self.payload = {"private": "do-not-expose"}
        with self.assertRaisesRegex(RuntimeError, "^wechat_scope_remote_unavailable$"):
            self.remote.read(**SCOPE)
        self.assertEqual(len(self.requests), 1)

    def test_response_limits_and_closed_port(self):
        self.payload = {"text": "x" * 65536}
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.remote.read(**SCOPE)
        self.remote.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            self.remote.read(**SCOPE)

    def test_rejects_non_loopback_and_partial_configuration(self):
        for url in ("https://127.0.0.1:80", "http://localhost:80", "http://127.0.0.1:80/",
                    "http://user@127.0.0.1:80", "http://127.0.0.1:80?x=y", "http://example.org:80"):
            with self.assertRaises(ValueError):
                RemoteWechatScope(url=url, token="synthetic", owner_id=OWNER, account_scope="synthetic")
        from notalone.front_sync.factory import build_cli_full_sync_engine
        with patch.dict("os.environ", {"NOTALONE_WECHAT_SCOPE_URL": "http://127.0.0.1:1234"}, clear=True):
            with self.assertRaisesRegex(ValueError, "incomplete"):
                build_cli_full_sync_engine(database_url="synthetic", owner_id=OWNER, account_scope="synthetic")

    def test_all_legacy_writers_are_gated_before_side_effects(self):
        engine = object.__new__(CliFullSyncEngine)
        engine._scope_store = self.remote
        for call in (lambda: engine.set_sync_scope("all_private"),
                     lambda: engine.set_history_authorization("accepted"),
                     lambda: engine.confirm_cli_bindings(()),
                     lambda: engine.revoke_cli_binding(contact_id=OWNER, binding_id=OWNER),
                     lambda: engine.confirm_binding(contact_id=OWNER, locator="synthetic"),
                     lambda: engine.confirm_pending_binding(contact_id=OWNER, locator="synthetic")):
            with self.assertRaises(WechatScopeOwnedByTypeScript):
                call()
        self.assertEqual(self.requests, [])

    def test_remote_discovery_never_reads_legacy_session_list(self):
        from datetime import datetime, timezone
        engine = object.__new__(CliFullSyncEngine)
        engine._scope_store = self.remote
        engine._owner_id = OWNER
        engine._channel = "wechat"
        engine._account_scope = SCOPE["account_scope"]
        engine._history_authorization_store = None
        engine._clock = lambda: datetime.now(timezone.utc)
        engine._scope_next_check = None
        engine._cli = Mock()
        engine._background = Mock()
        with patch.object(self.remote, "discover", return_value=1):
            engine._refresh_scope(enabled=True)
        engine._cli.sessions.assert_not_called()
        engine._background.request_backfill_check.assert_called_once()
