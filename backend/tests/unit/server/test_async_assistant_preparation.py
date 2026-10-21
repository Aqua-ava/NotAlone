"""通过正式认证 HTTP 分发验证无正文异步准备；外部准备边界使用可控屏障。"""

import json
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.assistant_session_service import AssistantSessionRejected
from notalone.application.assistant_preparation_rejection import AssistantNoGenerationProof, AssistantPreparationRejected
from notalone.application.manual_input_scope import manual_input_contact
from notalone.server.app import BackendApp
from notalone.server.event_bus import EventBus


class BlockingPreparation:
    def __init__(self):
        self.entered, self.release = threading.Event(), threading.Event()
        self.calls = 0
        self.manual = None
        self.error = None

    def prepare(self, *, owner_id, contact_id, session_id, request):
        self.calls += 1
        self.manual = manual_input_contact.get()
        self.entered.set()
        if not self.release.wait(15):
            raise TimeoutError("合成屏障未释放。")
        if self.error:
            raise self.error
        return AssistantGenerationReceipt(session_id, uuid4(), request.idempotency_key, uuid4(), "running")

    def prepare_replacement(self, *, running_request_key, **kwargs):
        return self.prepare(**kwargs)

    def prepare_interrupted(self, *, owner_id, contact_id, session_id, command):
        return self.prepare(owner_id=owner_id, contact_id=contact_id, session_id=session_id,
                            request=type("Request", (), {"idempotency_key": command.request_key})())


class AsyncAssistantPreparationTest(unittest.TestCase):
    def setUp(self):
        self.owner, self.contact, self.session, self.key = (uuid4() for _ in range(4))
        self.service = BlockingPreparation()
        self.app = BackendApp(contact_directory=object(), events=EventBus(), owner_id=self.owner,
                              token="synthetic-token", assistant_sessions=self.service)
        self.path = f"/api/contacts/{self.contact}/assistant-sessions/{self.session}/replies/prepare"
        self.headers = {"Authorization": "Bearer synthetic-token", "Prefer": "respond-async"}
        self.body = {"contact_id": str(self.contact), "idempotency_key": str(self.key),
                     "content": {"type": "rewrite_draft", "draft_text": "合成草稿", "user_instruction": "合成要求"}}
        self.addCleanup(self.app.shutdown_runtime)
        self.addCleanup(self.service.release.set)

    def request(self, method="POST", *, path=None, headers=None, body=None):
        return self.app.handle(method=method, path=path or self.path,
                               headers=self.headers if headers is None else headers,
                               body=json.dumps(self.body if body is None else body).encode())

    def terminal(self, path):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            response = self.request("GET", path=path)
            if response.status_code != 202:
                return response
            threading.Event().wait(.005)
        self.fail("合成准备未在有界时段内结算。")

    def start(self):
        response = self.request()
        self.assertEqual(response.status_code, 202, response.json())
        self.assertEqual(set(response.json()), {"preparation_id", "state"})
        self.assertEqual(response.json()["state"], "preparing")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertTrue(self.service.entered.wait(2))
        return self.path + "/status/" + response.json()["preparation_id"]

    def test_returns_immediately_queries_do_not_repeat_and_new_post_revalidates(self):
        status_path = self.start()
        same = self.request()
        self.assertEqual(same.json()["preparation_id"], status_path.rsplit("/", 1)[1])
        for _ in range(3):
            self.assertEqual(self.request("GET", path=status_path).status_code, 202)
        self.assertEqual(self.service.calls, 1)
        self.service.release.set()
        result = self.terminal(status_path)
        self.assertEqual(result.status_code, 200, result.json())
        self.assertEqual(set(result.json()), {"session_id", "turn_id", "request_key", "input_version_id", "state"})
        self.service.error = AssistantSessionRejected("source_unavailable")
        fresh = self.request()
        self.assertEqual(fresh.status_code, 202)
        self.assertNotEqual(fresh.json()["preparation_id"], status_path.rsplit("/", 1)[1])
        rejected = self.terminal(self.path + "/status/" + fresh.json()["preparation_id"])
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["reason"], "source_unavailable")
        self.assertEqual(self.service.calls, 2)

    def test_same_key_changed_input_conflicts_and_status_requires_original_scope(self):
        self.headers["X-NotAlone-Manual-Contact"] = str(self.contact)
        status_path = self.start()
        self.assertEqual(self.service.manual, self.contact)
        changed = {**self.body, "content": {**self.body["content"], "draft_text": "变化的合成草稿"}}
        self.assertEqual(self.request(body=changed).status_code, 409)
        self.assertEqual(self.request("GET", path=status_path, headers={}).status_code, 401)
        without_manual = {key: value for key, value in self.headers.items() if key != "X-NotAlone-Manual-Contact"}
        self.assertEqual(self.request("GET", path=status_path, headers=without_manual).status_code, 404)
        self.assertEqual(self.request("GET", path=status_path.replace("replies/prepare", "replace/prepare")).status_code, 404)
        self.assertEqual(self.request("GET", path=status_path.replace(str(self.session), str(uuid4()))).status_code, 404)

    def test_cancel_intent_prevents_late_success_and_new_instance_has_no_tasks(self):
        status_path = self.start()
        self.assertEqual(self.request("DELETE", path=status_path).status_code, 202)
        self.service.release.set()
        result = self.terminal(status_path)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json(), {"error": "assistant_preparation_cancelled"})
        other = BackendApp(contact_directory=object(), events=EventBus(), owner_id=self.owner,
                           token="synthetic-token", assistant_sessions=self.service)
        self.addCleanup(other.shutdown_runtime)
        self.assertEqual(other.handle(method="GET", path=status_path, headers=self.headers).status_code, 404)

    def test_replacement_and_interrupted_prepare_keep_original_contract(self):
        self.service.release.set()
        for action, payload in (
            ("replace", {"running_request_key": str(uuid4()), "replacement": self.body}),
            ("retry-interrupted", {"original_turn_id": str(uuid4()),
                                   "original_input_version_id": str(uuid4()), "request_key": str(uuid4())}),
        ):
            with self.subTest(action=action):
                path = self.path.replace("replies/prepare", action + "/prepare")
                response = self.request(path=path, body=payload)
                self.assertEqual(response.status_code, 202, response.json())
                result = self.terminal(path + "/status/" + response.json()["preparation_id"])
                self.assertEqual(result.status_code, 200, result.json())
                self.assertEqual(set(result.json()), {"session_id", "turn_id", "request_key", "input_version_id", "state"})

    def test_no_generation_proof_is_preserved_and_legacy_sync_still_works(self):
        proof = AssistantNoGenerationProof(self.contact, self.session, self.key)
        self.service.error = AssistantPreparationRejected(AssistantSessionRejected("source_unavailable"), proof)
        status_path = self.start()
        self.service.release.set()
        result = self.terminal(status_path)
        self.assertEqual(result.status_code, 409, result.json())
        self.assertEqual(result.json()["no_generation"], {
            "contact_id": str(self.contact), "session_id": str(self.session),
            "request_key": str(self.key), "state": "not_reserved",
        })
        self.service.error = None
        self.assertEqual(self.request(headers={"Authorization": "Bearer synthetic-token"}).status_code, 200)

    def test_deadline_capacity_expiry_and_shutdown_have_bounded_outcomes(self):
        with patch("notalone.server.assistant_preparation_jobs.PREPARATION_MAX_RUNNING", 1):
            status_path = self.start()
            different = {**self.body, "idempotency_key": str(uuid4())}
            self.assertEqual(self.request(body=different).json(), {"error": "assistant_preparation_busy"})
        self.service.release.set()
        self.assertEqual(self.terminal(status_path).status_code, 200)
        with patch("notalone.server.assistant_preparation_jobs.PREPARATION_RETENTION_SECONDS", -1):
            self.assertEqual(self.request("GET", path=status_path).status_code, 404)
        with patch("notalone.server.assistant_preparation_jobs.PREPARATION_BUDGET_SECONDS", -1):
            response = self.request()
            self.assertEqual(response.status_code, 202)
            timed_out = self.terminal(self.path + "/status/" + response.json()["preparation_id"])
            self.assertEqual(timed_out.status_code, 504)
            self.assertEqual(timed_out.json(), {"error": "assistant_preparation_timeout"})
        self.app.shutdown_runtime()
        self.assertEqual(self.request().json(), {"error": "runtime_stopping"})

    def test_preparation_longer_than_eight_seconds_keeps_waiting(self):
        status_path = self.start()
        # 真实经过旧八秒网络预算，准备线程仍只执行一次。
        self.assertFalse(self.service.release.wait(8.05))
        self.assertEqual(self.request("GET", path=status_path).status_code, 202)
        self.service.release.set()
        self.assertEqual(self.terminal(status_path).status_code, 200)
        self.assertEqual(self.service.calls, 1)

    def test_uuid_case_and_trailing_slashes_share_same_task_and_manual_scope(self):
        self.headers["X-NotAlone-Manual-Contact"] = str(self.contact)
        status_path = self.start()
        alias = self.path.replace(str(self.contact), str(self.contact).upper()).replace(
            str(self.session), str(self.session).upper()) + "///"
        body_alias = {**self.body, "contact_id": str(self.contact).upper(), "idempotency_key": str(self.key).upper()}
        reused = self.request(path=alias, body=body_alias)
        self.assertEqual(reused.status_code, 202, reused.json())
        self.assertEqual(reused.json()["preparation_id"], status_path.rsplit("/", 1)[1])
        status_alias = status_path.replace(str(self.contact), str(self.contact).upper()).replace(
            str(self.session), str(self.session).upper()) + "/"
        self.assertEqual(self.request("GET", path=status_alias).status_code, 202)
        self.assertEqual(self.service.calls, 1)

    def test_preparation_never_schedules_downstream_model_learning(self):
        calls = []
        learning = type("Learning", (), {"notify": lambda _, scope: calls.append(scope)})()
        app = BackendApp(contact_directory=object(), events=EventBus(), owner_id=self.owner,
                         token="synthetic-token", assistant_sessions=self.service, skill_learning=learning)
        self.addCleanup(app.shutdown_runtime)
        response = app.handle(method="POST", path=self.path, headers=self.headers,
                              body=json.dumps(self.body).encode())
        self.assertEqual(response.status_code, 202, response.json())
        self.assertEqual(calls, [])
        self.service.release.set()
        response = app.handle(method="POST", path=self.path, headers={"Authorization": "Bearer synthetic-token"},
                              body=json.dumps(self.body).encode())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, [])

    def test_adoption_same_parsed_request_with_different_submission_conflicts(self):
        message_id = uuid4()
        self.body = {"contact_id": str(self.contact), "idempotency_key": str(self.key),
                     "expected_input_version_id": str(uuid4()), "adopt_new_message_id": str(message_id),
                     "content": {"type": "reply_to_message", "target_message_id": str(message_id),
                                 "direction": "合成采用新消息"}}
        status_path = self.start()
        for changed in (
            {**self.body, "skill_version_id": None},
            {**self.body, "contact_id": str(self.contact).upper()},
        ):
            with self.subTest(submission=changed):
                response = self.request(body=changed)
                self.assertEqual(response.status_code, 409, response.json())
                self.assertEqual(response.json(), {"error": "assistant_session_input_conflict"})
        self.assertEqual(self.request().json()["preparation_id"], status_path.rsplit("/", 1)[1])
        self.assertEqual(self.service.calls, 1)

