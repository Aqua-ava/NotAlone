"""非语义传输准备：公开合成 SDK Mock 不认证服务可用性或模型质量。"""

from __future__ import annotations

import importlib
import json
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.cases.types import EvaluationCase, ExpectedDestination
from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_offline import _frozen_config, _run_evaluation_batch
from notalone.memory_extraction.evaluation_provider_contract import EvaluationProviderProfile
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_reference import public_window_projection
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender


SOURCE_ID = UUID("00000000-0000-4000-8000-000000000071")
SOURCE_TEXT = "我已拼好木质模型。"


class CoreTransportContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # 替换整个环境对象；不读取或复制真实凭据、代理或追踪设置。
        self.stack.enter_context(patch.object(os, "environ", {}))
        for module_name in ("httpx", "httpx2", "httpx._client", "httpx2._client"):
            module = importlib.import_module(module_name)
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(patch.object(
                    module, name, side_effect=AssertionError("禁止构造真实网络 transport"),
                ))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            self.stack.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        self.fake_key = self.home / "synthetic.key"
        descriptor = os.open(self.fake_key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as target:
            target.write("synthetic-not-a-real-key")
        self.source = ExtractionWindow(
            owner_id=UUID("00000000-0000-4000-8000-000000000072"),
            contact_id=UUID("00000000-0000-4000-8000-000000000073"),
            messages=(MessageRef(SOURCE_ID, SOURCE_TEXT, MessageSender.CONTACT,
                                 datetime(2036, 8, 12, 10, tzinfo=timezone.utc)),),
            target_message_ids=(SOURCE_ID,),
        )

    def _control(self, timeout: int, *, failure_stage: str | None = None) -> tuple[dict[str, Any], list[httpx.Request]]:
        """只包裹既有内部接缝；本测试不新增或放宽任何公共 runner/profile。"""
        count = 2 if failure_stage else 1
        cases = tuple(EvaluationCase(
            name=f"公开合成传输控制{position}", dimension="transport",
            messages=(("contact", SOURCE_TEXT),), targets=(0,), expect=ExpectedDestination.AUTO,
        ) for position in range(count))
        windows = (self.source,) * count
        plan = tuple({
            "case_position": position, "case_name": case.name,
            "input_sha256": canonical_sha256(public_window_projection(self.source)),
        } for position, case in enumerate(cases))
        profile = EvaluationProviderProfile.DEEPSEEK_FLASH_MAX
        config = _frozen_config(plan, request_timeout_seconds=timeout, max_retries=0,
                                extraction_mode="grounded-v2", verification_mode="legacy-v4", windows=windows)
        config.update(base_url=profile.base_url, endpoint=profile.endpoint, request_model=profile.model,
                      reasoning_effort="max", tool_choice="omitted", fallback=False)
        config["omitted_parameters"] = [
            name for name in config["omitted_parameters"] if name != "reasoning_effort"
        ] + ["tool_choice"]
        output = self.home / f"output-{uuid4()}"
        output.mkdir(mode=0o700)
        budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=count * 2,
                                         allowed_endpoints=(profile.endpoint,), config_sha256=canonical_sha256(config))
        store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
        requests: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            body = json.loads(request.content)
            name = body["tools"][0]["function"]["name"]
            stage = "extraction" if name == "GroundedMemoryLabels" else "verification"
            if failure_stage == stage:
                raise httpx.ReadTimeout("公开合成读取超时", request=request)
            arguments = ({"units": {"0:0": {
                "kind": "event", "subject": "contact", "topic": "other", "dependency": None,
                "unresolved": False, "confidence": 0.9, "sensitivity": "none",
            }}} if stage == "extraction" else {"results": [{
                "candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": str(SOURCE_ID), "quote": SOURCE_TEXT}],
            }]})
            return httpx.Response(200, request=request, json={
                "id": "synthetic-completion", "object": "chat.completion", "created": 1,
                "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": None, "tool_calls": [{
                        "id": "synthetic-call", "type": "function", "function": {
                            "name": name, "arguments": json.dumps(arguments, ensure_ascii=False),
                        },
                    }]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            })

        result = _run_evaluation_batch(
            cases=cases, windows=windows, plan=plan, budget=budget, store=store,
            base_url=profile.base_url, request_model=profile.model, api_key="",
            credential_loader=lambda: self.fake_key.read_text(),
            synthetic_transport=httpx.MockTransport(respond), provider="DeepSeek",
            request_timeout_seconds=timeout, max_retries=0, reasoning_effort="max",
            extraction_mode="grounded-v2", verification_mode="legacy-v4",
            extraction_tool_choice="omitted", verification_tool_choice="omitted",
        )
        self.assertEqual(result["cleanup_error_codes"], ())
        self.assertIsNone(result["receipt_error_code"])
        self.assertIsNone(result["records_error_code"])
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertFalse(result["quality_certified"])
        self.assertFalse(result["receipt"]["quality_certified"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], len(requests))
        self.assertEqual(budget.closed_receipt()["reserved_requests"], len(requests))
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=UUID(budget.snapshot()["run_id"]))
        for request in requests:
            self.assertEqual(str(request.url), profile.endpoint)
            self.assertEqual(request.extensions["timeout"],
                             dict.fromkeys(("connect", "read", "write", "pool"), float(timeout)))
            body = json.loads(request.content)
            self.assertEqual((body["model"], body["reasoning_effort"], body["thinking"],
                              body["temperature"], body["stream"]),
                             ("deepseek-flash", "max", {"type": "enabled"}, 0.0, False))
            self.assertNotIn("tool_choice", body)
        return result, requests

    def test_300_and_600_change_only_sdk_transport_timeout(self) -> None:
        bodies = []
        for timeout in (300, 600):
            with self.subTest(timeout=timeout):
                result, requests = self._control(timeout)
                self.assertIsNone(result["stopped_code"])
                self.assertEqual(result["summary"]["completed"], 1)
                self.assertEqual(result["summary"]["unknown"], 0)
                self.assertEqual(result["summary"]["unrun"], 0)
                self.assertEqual([json.loads(request.content)["tools"][0]["function"]["name"]
                                  for request in requests], ["GroundedMemoryLabels", "SourceVerificationOutput"])
                bodies.append([request.content for request in requests])
        # 同一来源、给定标签与给定 V：连原始 JSON 请求字节也必须完全相同。
        self.assertEqual(bodies[0], bodies[1])

    def test_read_timeout_in_e_or_v_attempts_once_and_closes_without_next_window(self) -> None:
        for timeout in (300, 600):
            for stage in ("extraction", "verification"):
                with self.subTest(timeout=timeout, failure_stage=stage):
                    result, requests = self._control(timeout, failure_stage=stage)
                    self.assertEqual(len(requests), 1 if stage == "extraction" else 2)
                    self.assertEqual([item["status"] for item in result["outcomes"]], ["unknown", "unrun"])
                    self.assertEqual((result["summary"]["completed"], result["summary"]["unknown"],
                                      result["summary"]["unrun"]), (0, 1, 1))
                    failures = [event for event in result["events"] if event["kind"] == "provider_failure"]
                    self.assertEqual(len(failures), 1)
                    self.assertEqual((failures[0]["purpose"], failures[0]["payload"]["failure_kind"]),
                                     (stage, "read_timeout"))

    def test_public_entry_still_rejects_600_before_credentials_or_registry(self) -> None:
        with self.assertRaisesRegex(EvaluationBudgetAbort, "ecnu_invalid_request_limits"):
            run_ecnu_evaluation(
                output_directory=self.home, run_id=uuid4(), repo_root=self.home,
                deadline=datetime.now(timezone.utc) + timedelta(minutes=1), source_hashes={}, frozen_gold={},
                credential_loader=lambda: self.fail("公共 guard 之前不应读取任何凭据"),
                audit_case=lambda _: self.fail("公共 guard 之前不应审阅语义"),
                synthetic_transport=httpx.MockTransport(lambda _: self.fail("公共 guard 之前不应发送")),
                provider_profile="deepseek-flash-max", case_set="full140", request_timeout_seconds=600,
                max_retries=0, extraction_mode="grounded-v2", verification_mode="nullable-proof-v1",
                verification_tool_choice="omitted",
            )
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())


if __name__ == "__main__":
    unittest.main()
