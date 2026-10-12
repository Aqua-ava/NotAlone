"""ECNU 评测传输门，只使用公开合成载荷与精确 MockTransport。"""

from __future__ import annotations

import hashlib
import json
import asyncio
import importlib
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationAsyncTransport,
    EvaluationTransport,
)
from notalone.memory_extraction.evaluation_provider_contract import (
    ECNUEvaluationContract,
)
from notalone.memory_extraction.evaluation_records import (
    EvaluationRecordStore, canonical_sha256,
)


ENDPOINT = "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"
NOW = datetime(2026, 10, 12, 4, 0, tzinfo=timezone.utc)


def _payload() -> dict:
    return {
        "model": "ecnu-max", "temperature": 0.0, "stream": False,
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "system", "content": "合成提取规则"},
            {"role": "user", "content": "合成公开消息"},
        ],
        "tools": [{"type": "function", "function": {
            "name": "MemoryExtractionOutput", "description": "合成工具",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }}],
        "tool_choice": {
            "type": "function", "function": {"name": "MemoryExtractionOutput"},
        },
    }


def _completion(model: str | None = "synthetic-report-a") -> dict:
    value = {
        "id": "synthetic-completion", "object": "chat.completion", "created": 1,
        "choices": [{"index": 0, "message": {
            "role": "assistant", "content": "合成返回",
        }, "finish_reason": "stop"}],
    }
    if model is not None:
        value["model"] = model
    return value


class EvaluationProviderContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.guards = ExitStack()
        self.addCleanup(self.guards.close)
        self.guards.enter_context(patch.object(
            os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"},
        ))
        for owner, names in (
            (httpx, ("HTTPTransport", "AsyncHTTPTransport")),
            (httpx._client, ("HTTPTransport", "AsyncHTTPTransport")),
            (socket.socket, ("connect", "connect_ex")),
            (socket, ("getaddrinfo",)),
        ):
            for name in names:
                self.guards.enter_context(patch.object(
                    owner, name, side_effect=AssertionError("禁止真实网络"),
                ))
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.guards.enter_context(patch.object(Path, "home", return_value=self.root))
        self.source = self.root / "backend/src/notalone/public_fixture.py"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("# 合成公开源码\n", encoding="utf-8")
        self.source_hashes = {
            "backend/src/notalone/public_fixture.py": hashlib.sha256(
                self.source.read_bytes()
            ).hexdigest(),
        }
        self.now = [NOW]

    def _contract(self, *, deadline: datetime | None = None):
        return ECNUEvaluationContract(
            deadline=deadline or NOW + timedelta(minutes=10),
            repo_root=self.root, source_hashes=self.source_hashes,
            clock=lambda: self.now[0],
        )

    def _budget(self):
        output = self.root / "output"
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(
            run_id=uuid4(), output_directory=output, request_limit=3,
            allowed_endpoints=(ENDPOINT,), config_sha256="a" * 64,
        )

    def _recorded_budget(self, *, extra: dict | None = None):
        output = self.root / "output"
        output.mkdir(mode=0o700)
        plan = ({"case_position": 0, "case_name": "合成公开窗", "input_sha256": "b" * 64},)
        config = {"mode": "mock_ecnu_contract", "plan_sha256": canonical_sha256(plan)}
        config.update(extra or {})
        budget = EvaluationBudget.create(
            run_id=uuid4(), output_directory=output, request_limit=3,
            allowed_endpoints=(ENDPOINT,), config_sha256=canonical_sha256(config),
        )
        return budget, EvaluationRecordStore(
            budget=budget, frozen_config=config, plan=plan,
        )

    def test_expired_request_stops_before_reservation_or_dispatch(self):
        contract = self._contract()
        budget = self._budget()
        sent = []
        with httpx.Client(transport=EvaluationTransport(
            budget, contract=contract, synthetic_transport=httpx.MockTransport(
                lambda request: sent.append(request) or httpx.Response(200),
            ),
        ), trust_env=False) as client:
            with contract.expect_request(_payload()):
                self.now[0] = NOW + timedelta(minutes=10)
                with self.assertRaisesRegex(EvaluationBudgetAbort, "deadline"):
                    client.post(ENDPOINT, json=_payload())
        self.assertEqual(sent, [])
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)

    def test_request_without_bound_expectation_cannot_send(self):
        budget = self._budget()
        sent = []
        with httpx.Client(transport=EvaluationTransport(
            budget, contract=self._contract(),
            synthetic_transport=httpx.MockTransport(
                lambda request: sent.append(request) or httpx.Response(200),
            ),
        ), trust_env=False) as client:
            with self.assertRaisesRegex(EvaluationBudgetAbort, "unbound"):
                client.post(ENDPOINT, json=_payload())
        self.assertEqual(sent, [])
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)

    def test_changed_body_cannot_mutate_the_bound_expectation(self):
        contract = self._contract()
        budget = self._budget()
        expected = _payload()
        sent = []
        with httpx.Client(transport=EvaluationTransport(
            budget, contract=contract, synthetic_transport=httpx.MockTransport(
                lambda request: sent.append(request) or httpx.Response(200),
            ),
        ), trust_env=False) as client:
            with contract.expect_request(expected):
                expected["messages"][1]["content"] = "未冻结的替换正文"
                with self.assertRaisesRegex(EvaluationBudgetAbort, "body_changed"):
                    client.post(ENDPOINT, json=expected)
        self.assertEqual(sent, [])
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)

    def test_replaced_source_stops_before_dispatch(self):
        contract = self._contract()
        budget = self._budget()
        sent = []
        with httpx.Client(transport=EvaluationTransport(
            budget, contract=contract, synthetic_transport=httpx.MockTransport(
                lambda request: sent.append(request) or httpx.Response(200),
            ),
        ), trust_env=False) as client:
            with contract.expect_request(_payload()):
                self.source.write_text("# 替换源码\n", encoding="utf-8")
                with self.assertRaisesRegex(EvaluationBudgetAbort, "source"):
                    client.post(ENDPOINT, json=_payload())
        self.assertEqual(sent, [])
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)

    def test_source_escape_symlink_and_secret_path_are_rejected_at_construction(self):
        relative = "backend/src/notalone/public_fixture.py"
        original = self.source_hashes[relative]
        self.source.with_name("alias.py").symlink_to(self.source)
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "external.py"
            target.write_text("# 外部合成资料\n", encoding="utf-8")
            for frozen in (
                {"../external.py": original}, {str(target): original},
                {"backend/src/notalone/alias.py": original},
                {".env": "a" * 64},
            ):
                with self.subTest(paths=tuple(frozen)):
                    with self.assertRaisesRegex(EvaluationBudgetAbort, "source"):
                        ECNUEvaluationContract(
                            deadline=NOW + timedelta(minutes=10),
                            repo_root=self.root, source_hashes=frozen,
                            clock=lambda: NOW,
                        )

    def test_expected_payload_cannot_register_other_parameters_or_tools(self):
        for field, replacement in (
            ("model", "another-provider"), ("temperature", 1),
            ("stream", True), ("thinking", {"type": "disabled"}),
            ("extra_body", {}),
            ("tool_choice", "auto"),
            ("tools", [{"type": "function", "function": {"name": "send_chat"}}]),
        ):
            with self.subTest(field=field):
                value = _payload()
                value[field] = replacement
                with self.assertRaisesRegex(EvaluationBudgetAbort, "payload"):
                    with self._contract().expect_request(value):
                        self.fail("不应注册越出契约的预期正文")

    def test_endpoint_method_and_duplicate_json_keys_cannot_bypass_expectation(self):
        value = _payload()
        duplicated = json.dumps(value)[:-1] + ', "model": "ecnu-max"}'
        for request in (
            httpx.Request("GET", ENDPOINT, json=value),
            httpx.Request("POST", ENDPOINT + "?fallback=1", json=value),
            httpx.Request("POST", ENDPOINT.replace("chat.ecnu", "other.ecnu"), json=value),
            httpx.Request("POST", ENDPOINT, content=duplicated),
        ):
            with self.subTest(url=str(request.url), method=request.method):
                contract = self._contract()
                with contract.expect_request(value):
                    with self.assertRaises(EvaluationBudgetAbort):
                        contract.check_request(request)

    def test_deadline_and_clock_require_aware_datetime(self):
        for deadline, clock_value in (
            (NOW.replace(tzinfo=None) + timedelta(minutes=10), NOW),
            (NOW + timedelta(minutes=10), NOW.replace(tzinfo=None)),
        ):
            with self.subTest(deadline=deadline, clock=clock_value):
                with self.assertRaisesRegex(EvaluationBudgetAbort, "deadline"):
                    ECNUEvaluationContract(
                        deadline=deadline, repo_root=self.root,
                        source_hashes=self.source_hashes, clock=lambda: clock_value,
                    )

    def test_changed_identity_response_is_saved_before_stopping_later_requests(self):
        contract = self._contract()
        budget, records = self._recorded_budget()
        sent = []

        def handler(request):
            sent.append(request)
            return httpx.Response(200, json=_completion(
                "synthetic-report-a" if len(sent) == 1 else "synthetic-report-b",
            ))

        with records.stage(0, "extraction"), httpx.Client(
            transport=EvaluationTransport(
                budget, contract=contract, records=records,
                synthetic_transport=httpx.MockTransport(handler),
            ), trust_env=False,
        ) as client, contract.expect_request(_payload()):
            self.assertEqual(client.post(ENDPOINT, json=_payload()).status_code, 200)
            with self.assertRaisesRegex(EvaluationBudgetAbort, "identity_changed"):
                client.post(ENDPOINT, json=_payload())
            with self.assertRaises(EvaluationBudgetAbort):
                client.post(ENDPOINT, json=_payload())
        models = [
            event["payload"]["body"]["model"] for event in records.events()
            if event["kind"] == "provider_response"
        ]
        self.assertEqual(models, ["synthetic-report-a", "synthetic-report-b"])
        self.assertEqual(len(sent), 2)
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 2)

    def test_ecnu_freeze_metadata_and_attributed_audit_are_saved(self):
        _, records = self._recorded_budget(extra={
            "deadline_utc": (NOW + timedelta(minutes=10)).isoformat(),
            "source_hashes": self.source_hashes, "gold_sha256": "a" * 64,
            "stage": "P1", "response_identity_policy": "success_model_or_missing",
            "request_contract_version": 1,
            "tool_choice": ["MemoryExtractionOutput", "SourceVerificationOutput"],
            "fallback": False, "baseline_commit": "b" * 40,
        })
        with records.stage(0, "case"):
            records.record(kind="semantic_audit", payload={
                "case_position": 0, "decision": "safe",
                "reason_code": "supported", "criteria_sha256": "a" * 64,
            })
        event = records.events()[0]
        self.assertEqual(event["kind"], "semantic_audit")
        self.assertEqual(event["case_position"], 0)
        self.assertEqual(event["purpose"], "case")
        self.assertEqual(event["payload"]["decision"], "safe")

    def test_invalid_success_tool_structure_never_establishes_identity(self):
        value = _completion()
        value["choices"][0]["message"]["tool_calls"] = [{
            "id": "bad-structure", "type": "function", "function": 42,
        }]
        contract = self._contract()
        with self.assertRaisesRegex(EvaluationBudgetAbort, "completion_invalid"):
            contract.observe_response(httpx.Response(200, json=value))

    def test_missing_identity_is_an_observation_and_changes_still_stop(self):
        for first, second, allowed in (
            (None, None, True), (None, "synthetic-report-a", False),
            ("synthetic-report-a", None, False),
        ):
            with self.subTest(first=first, second=second):
                contract = self._contract()
                contract.observe_response(httpx.Response(200, json=_completion(first)))
                if allowed:
                    contract.observe_response(httpx.Response(200, json=_completion(second)))
                else:
                    with self.assertRaisesRegex(EvaluationBudgetAbort, "identity_changed"):
                        contract.observe_response(httpx.Response(200, json=_completion(second)))

    def test_sdk_rate_limit_response_does_not_establish_identity_or_disable_retry(self):
        sdk = importlib.import_module("openai")
        httpx2 = importlib.import_module("httpx2")
        for owner in (httpx2, importlib.import_module("httpx2._client")):
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.guards.enter_context(patch.object(
                    owner, name, side_effect=AssertionError("禁止真实网络"),
                ))
        contract = self._contract()
        budget, records = self._recorded_budget()
        attempts = []

        def handler(request):
            attempts.append(request)
            if len(attempts) == 1:
                return httpx.Response(429, json={
                    "model": "error-reported-model", "error": {"message": "合成限速"},
                }, headers={"retry-after-ms": "1"})
            return httpx.Response(200, json=_completion())

        http_client = httpx.Client(transport=EvaluationTransport(
            budget, contract=contract, records=records,
            synthetic_transport=httpx.MockTransport(handler),
        ), trust_env=False)
        self.addCleanup(http_client.close)
        client = sdk.OpenAI(
            api_key="synthetic-not-a-real-key", base_url=ENDPOINT.rsplit("/", 2)[0],
            http_client=http_client, max_retries=2,
        )
        self.addCleanup(client.close)
        value = _payload()
        with records.stage(0, "extraction"), contract.expect_request(value):
            result = client.chat.completions.create(
                **{key: item for key, item in value.items() if key != "thinking"},
                extra_body={"thinking": value["thinking"]},
            )
        self.assertEqual(result.model, "synthetic-report-a")
        self.assertEqual(len(attempts), 2)
        self.assertEqual(budget.snapshot()["reserved_requests"], 2)
        self.assertEqual([
            event["payload"]["status_code"] for event in records.events()
            if event["kind"] == "provider_response"
        ], [429, 200])
        budget.close()

    def test_async_request_uses_same_preflight_and_saved_identity_gate(self):
        contract = self._contract()
        budget, records = self._recorded_budget()
        sent = []

        def handler(request):
            sent.append(request)
            return httpx.Response(200, json=_completion(
                "synthetic-report-a" if len(sent) == 1 else "synthetic-report-b",
            ))

        with records.stage(0, "extraction"), contract.expect_request(_payload()):
            with httpx.Client(transport=EvaluationTransport(
                budget, records=records, contract=contract,
                synthetic_transport=httpx.MockTransport(handler),
            ), trust_env=False) as sync:
                sync.post(ENDPOINT, json=_payload())

            async def scenario():
                async with httpx.AsyncClient(transport=EvaluationAsyncTransport(
                    budget, records=records, contract=contract,
                    synthetic_transport=httpx.MockTransport(handler),
                ), trust_env=False) as client:
                    with self.assertRaisesRegex(EvaluationBudgetAbort, "identity_changed"):
                        await client.post(ENDPOINT, json=_payload())
                    with self.assertRaises(EvaluationBudgetAbort):
                        await client.post(ENDPOINT, json=_payload())

            asyncio.run(scenario())
        self.assertEqual(len(sent), 2)
        self.assertEqual([event["kind"] for event in records.events()], [
            "provider_request", "provider_response", "provider_request", "provider_response",
        ])
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 2)

    def test_async_body_drift_is_rejected_before_recording_or_reservation(self):
        contract = self._contract()
        budget, records = self._recorded_budget()
        sent = []

        async def scenario():
            async with httpx.AsyncClient(transport=EvaluationAsyncTransport(
                budget, records=records, contract=contract,
                synthetic_transport=httpx.MockTransport(
                    lambda request: sent.append(request) or httpx.Response(200),
                ),
            ), trust_env=False) as client:
                with records.stage(0, "extraction"), contract.expect_request(_payload()):
                    altered = _payload()
                    altered["messages"][1]["content"] = "漂移正文"
                    with self.assertRaisesRegex(EvaluationBudgetAbort, "body_changed"):
                        await client.post(ENDPOINT, json=altered)

        asyncio.run(scenario())
        self.assertEqual(sent, [])
        self.assertEqual(records.events(), ())
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)


if __name__ == "__main__":
    unittest.main()
