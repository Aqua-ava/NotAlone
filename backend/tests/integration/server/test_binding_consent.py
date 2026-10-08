"""在真实 HTTP、正式迁移测试库与合成 CLI 上验收授权管理。"""

import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from tests.integration.server.binding_consent_support import BindingBackend, cli_state


class BindingConsentApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = BindingBackend()
        self.addCleanup(self.backend.close)

    def test_directory_includes_missing_active_locator_and_filters_runtime_scope(self) -> None:
        backend = self.backend
        self.assertEqual(backend.request("/api/sync/cli-sessions")[0], 200)
        self.assertEqual(backend.tails(), [])

        selected = [{"locator": locator, "contact_id": contact} for locator, contact in zip(
            ("wxid_synthetic_a", "wxid_synthetic_b"), backend.data["contact_ids"])]
        self.assertEqual(backend.request("/api/sync/cli-bindings/confirm", {"selections": selected})[0], 200)
        state = cli_state()
        state["sessions"] = state["sessions"][1:]
        backend.set_cli(state)
        status, directory = backend.request("/api/sync/cli-bindings")
        self.assertEqual(status, 200)
        self.assertEqual({binding["conversation_locator"] for binding in directory["bindings"]}, {"wxid_synthetic_a", "wxid_synthetic_b"})
        for binding in directory["bindings"]:
            self.assertEqual(set(binding), {"binding_id", "contact_id", "conversation_locator", "display_name", "status"})
            self.assertEqual(binding["status"], "active")
        self.assertEqual(backend.request("/api/sync/cli-bindings", token="wrong-token")[0], 401)
        self.assertEqual(backend.tails(), [])

    def test_revoke_is_scoped_idempotent_stops_new_tail_and_retains_history(self) -> None:
        backend = self.backend
        contact_id = backend.data["contact_ids"][0]
        self.assertEqual(backend.request("/api/sync/cli-bindings/confirm", {"selections": [
            {"locator": "wxid_synthetic_a", "contact_id": contact_id}]} )[0], 200)
        state = cli_state()
        state["messages"] = {"wxid_synthetic_a": [{"local_id": 1, "text": "已授权合成消息", "create_time": int(time.time()) + 10}]}
        backend.set_cli(state)
        self.assertEqual(backend.request("/api/sync/enable", {})[0], 200)
        status, bindings = backend.request("/api/sync/cli-bindings")
        self.assertEqual(status, 200)
        active = bindings["bindings"][0]
        selection = {"contact_id": active["contact_id"], "binding_id": active["binding_id"]}
        for foreign in backend.data["foreign_bindings"] + [dict(selection, contact_id=backend.data["contact_ids"][1]), dict(selection, binding_id=str(uuid4()))]:
            self.assertEqual(backend.request("/api/sync/cli-bindings/revoke", foreign)[0], 404)
        self.assertEqual(backend.request("/api/sync/cli-bindings/revoke", {"contact_id": "invalid", "binding_id": active["binding_id"]})[0], 400)
        self.assertEqual(backend.request("/api/sync/cli-bindings/revoke", dict(selection, owner_id=backend.data["owner_id"]))[0], 400)
        for _ in range(2):
            code, result = backend.request("/api/sync/cli-bindings/revoke", selection)
            self.assertEqual(code, 200)
            self.assertEqual(result["status"], "revoked")
            self.assertEqual(result["binding_id"], active["binding_id"])
        reads = backend.tails()
        self.assertEqual(reads, ["wxid_synthetic_a"])
        self.assertEqual(backend.request("/api/sync/check", {})[0], 200)
        self.assertEqual(backend.tails(), reads)
        self.assertEqual(backend.request("/api/sync/cli-bindings")[1], {"bindings": []})
        history = backend.request(f"/api/contacts/{contact_id}/messages")[1]
        self.assertIn("已授权合成消息", str(history))

    def test_final_confirmation_rechecks_observed_name_without_changing_custom_display_name_contract(self) -> None:
        state = cli_state()
        state["sessions"][0]["display_name"] = "最新会话名"
        self.backend.set_cli(state)
        selection = {"locator": "wxid_synthetic_a", "contact_id": self.backend.data["contact_ids"][0],
                     "display_name": "用户自定展示名", "observed_display_name": "同名会话"}
        contacts = self.backend.request("/api/contacts")[1]
        valid_new_contact = {
            "locator": "wxid_synthetic_b", "observed_display_name": "同名会话",
        }
        result = self.backend.request("/api/sync/cli-bindings/confirm", {
            "selections": [valid_new_contact, selection],
        })
        self.assertEqual(result, (409, {"error": "cli_binding_rejected", "reason": "selection_stale"}))
        self.assertEqual(self.backend.request("/api/sync/cli-bindings")[1], {"bindings": []})
        self.assertEqual(self.backend.request("/api/contacts")[1], contacts)
        selection["observed_display_name"] = "最新会话名"
        self.assertEqual(self.backend.request("/api/sync/cli-bindings/confirm", {"selections": [selection]})[0], 200)
        bindings = self.backend.request("/api/sync/cli-bindings")[1]["bindings"]
        self.assertEqual(bindings[0]["display_name"], "用户自定展示名")
        self.assertEqual(self.backend.tails(), [])

    def block_authorized_cycle(self, pool):
        backend = self.backend
        self.assertEqual(backend.request("/api/sync/cli-bindings/confirm", {"selections": [
            {"locator": "wxid_synthetic_a", "contact_id": backend.data["contact_ids"][0]}]})[0], 200)
        self.assertEqual(backend.request("/api/sync/enable", {})[0], 200)
        binding = backend.request("/api/sync/cli-bindings")[1]["bindings"][0]
        gate = backend.directory / "hold-tail-wxid_synthetic_a"
        gate.touch()
        self.addCleanup(lambda: gate.unlink(missing_ok=True))
        reads = len(backend.tails())
        cycle = pool.submit(backend.request, "/api/sync/check", {})
        deadline = time.monotonic() + 5
        while len(backend.tails()) == reads and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(backend.tails()), reads + 1)
        return gate, cycle, {"contact_id": binding["contact_id"], "binding_id": binding["binding_id"]}

    def test_revoke_waits_for_current_tail_and_prevents_all_later_reads(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            gate, cycle, selection = self.block_authorized_cycle(pool)
            revoked = pool.submit(self.backend.request, "/api/sync/cli-bindings/revoke", selection)
            time.sleep(0.2)
            self.assertFalse(revoked.done())
            gate.unlink()
            self.assertEqual(cycle.result()[0], 200)
            self.assertEqual(revoked.result()[1]["status"], "revoked")
        reads = self.backend.tails()
        for _ in range(3):
            self.assertEqual(self.backend.request("/api/sync/check", {})[0], 200)
        self.assertEqual(self.backend.tails(), reads)

    def test_busy_timeout_retains_authorization_and_requires_explicit_retry(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            gate, cycle, selection = self.block_authorized_cycle(pool)
            started = time.monotonic()
            try:
                code, result = self.backend.request("/api/sync/cli-bindings/revoke", selection)
                self.assertEqual((code, result), (409, {"error": "cli_binding_revoke_busy"}))
                self.assertLess(time.monotonic() - started, 6)
            finally:
                gate.unlink(missing_ok=True)
            self.assertEqual(cycle.result()[0], 200)
        self.assertEqual(len(self.backend.request("/api/sync/cli-bindings")[1]["bindings"]), 1)
        self.assertEqual(self.backend.request("/api/sync/cli-bindings/revoke", selection)[1]["status"], "revoked")



if __name__ == "__main__":
    unittest.main()
