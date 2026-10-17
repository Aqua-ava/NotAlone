"""任务模式入口：提交配置先于唤醒，未知或歧义输入不触发执行。"""

from contextlib import ExitStack
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.background_tasks import BackgroundTaskStateError
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class RuntimeTaskService:
    def __init__(self, events):
        self.events = events
        self.conflict = False

    def status(self, **scope):
        self.events.append(("status", scope))
        return {"status": "queued"}

    def configure_runtime(self, **scope):
        self.events.append(("configure", scope))
        if self.conflict:
            raise BackgroundTaskStateError("合成配置冲突")
        return {"mode": scope["mode"].value}

    def retry(self, **scope):
        self.events.append(("retry", scope))
        return {"status": "queued"}


class RuntimeTaskHost:
    def __init__(self, events):
        self.events = events

    def start(self, **scope):
        self.events.append(("start", scope))
        return {"status": "started"}


class TaskRuntimeConfigApiTest(unittest.TestCase):
    def setUp(self):
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("本入口控制禁止网络或数据库")))
        self.events = []
        self.service = RuntimeTaskService(self.events)
        self.owner_id, self.contact_id, self.task_id = uuid4(), uuid4(), uuid4()
        self.client = InProcessClient(create_app(
            database_url="postgresql:///notalone_test", owner_id=self.owner_id, token="synthetic-token",
            task_host=RuntimeTaskHost(self.events), task_service=self.service,
        ))
        self.scope = {"contact_id": str(self.contact_id), "task_id": str(self.task_id)}

    def request(self, payload, *, path="/api/tasks/run", raw=None):
        return self.client.request("POST", path,
            headers={"Authorization": "Bearer synthetic-token"},
            body=raw if raw is not None else json.dumps(payload).encode())

    def test_explicit_modes_are_configured_before_start_without_forwarding_free_config(self):
        for mode in ("legacy", "bounded-runtime-v1"):
            with self.subTest(mode=mode):
                self.events.clear()
                response = self.request({**self.scope, "extraction_runtime_mode": mode})
                self.assertEqual(response.status_code, 200)
                names = [name for name, _ in self.events]
                self.assertIn("configure", names)
                self.assertLess(names.index("configure"), names.index("start"))
                selected = next(args for name, args in self.events if name == "configure")
                self.assertEqual(selected["mode"].value, mode)
                self.assertEqual(selected["task_id"], self.task_id)
                started = next(args for name, args in self.events if name == "start")
                self.assertEqual(started, {"owner_id": self.owner_id, "contact_id": self.contact_id, "task_id": self.task_id})

    def test_absent_mode_keeps_existing_start_contract(self):
        response = self.request(self.scope)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("configure", [name for name, _ in self.events])
        self.assertEqual([name for name, _ in self.events], ["status", "start"])

    def test_mode_requires_task_id_and_closed_string(self):
        controls = [
            {"contact_id": str(self.contact_id), "extraction_runtime_mode": "bounded-runtime-v1"},
            *({**self.scope, "extraction_runtime_mode": value} for value in (None, False, 1, {}, "", "other")),
        ]
        for payload in controls:
            with self.subTest(payload=payload):
                self.events.clear()
                self.assertEqual(self.request(payload).status_code, 400)
                self.assertEqual(self.events, [])

    def test_unknown_config_hash_proof_and_model_fields_are_rejected(self):
        for key in ("extraction_runtime_config", "rule_set_sha256", "proof", "model", "reasoning_effort"):
            for mode in (None, "bounded-runtime-v1"):
                with self.subTest(key=key, mode=mode):
                    self.events.clear()
                    payload = {**self.scope, key: "synthetic-untrusted-value"}
                    if mode is not None:
                        payload["extraction_runtime_mode"] = mode
                    self.assertEqual(self.request(payload).status_code, 400)
                    self.assertEqual(self.events, [])

    def test_retry_rejects_runtime_mode_and_free_configuration(self):
        for key in ("extraction_runtime_mode", "extraction_runtime_config", "rule_set_sha256"):
            with self.subTest(key=key):
                self.events.clear()
                self.assertEqual(self.request({**self.scope, key: "legacy"}, path="/api/tasks/retry").status_code, 400)
                self.assertEqual(self.events, [])

    def test_duplicate_keys_and_nonfinite_json_are_rejected_before_status_or_start(self):
        original = json.dumps({**self.scope, "extraction_runtime_mode": "legacy"})
        controls = [
            original[:-1] + ',"extraction_runtime_mode":"bounded-runtime-v1"}',
            original[:-1] + ',"task_id":"' + str(uuid4()) + '"}',
            json.dumps(self.scope)[:-1] + ',"extraction_runtime_mode":NaN}',
        ]
        for raw in controls:
            with self.subTest(raw=raw):
                self.events.clear()
                self.assertEqual(self.request(None, raw=raw.encode()).status_code, 400)
                self.assertEqual(self.events, [])

    def test_configuration_conflict_does_not_queue_task(self):
        self.service.conflict = True
        response = self.request({**self.scope, "extraction_runtime_mode": "bounded-runtime-v1"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"error": "task_runtime_config_conflict"})
        self.assertNotIn("start", [name for name, _ in self.events])
