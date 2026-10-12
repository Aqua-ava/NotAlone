"""评测 P0 的完整离线退场协议；不证明供应商或模型准确率。"""

from __future__ import annotations

import importlib
import json
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget,
    EvaluationBudgetAbort,
)
from notalone.memory_extraction.evaluation_offline import run_offline_evaluation


class EvaluationOfflineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(os, "environ", {}))
        for module_name in ("httpx", "httpx2", "httpx._client", "httpx2._client"):
            module = importlib.import_module(module_name)
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(patch.object(
                    module, name,
                    side_effect=AssertionError("禁止构造真实网络 transport"),
                ))
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(patch.object(
                socket.socket, name,
                side_effect=AssertionError("禁止真实 socket 连接"),
            ))
        self.stack.enter_context(patch.object(
            socket, "getaddrinfo",
            side_effect=AssertionError("禁止真实 DNS 查询"),
        ))
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        self.output = self.home / "output"
        self.output.mkdir(mode=0o700)
        self.run_id = uuid4()
        self.requests: list[dict] = []
        self.none_case = next(case for case in CASES
                              if case.name == "复核：机构提及不等于身份")

    def response(self, request, *, arguments=None, tool_name=None, status=200):
        payload = json.loads(request.content)
        self.requests.append(payload)
        return httpx.Response(status, request=request, json={
            "id": "synthetic-completion", "object": "chat.completion", "created": 1,
            "model": "synthetic-response-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "synthetic-call", "type": "function",
                    "function": {
                        "name": tool_name or payload["tool_choice"]["function"]["name"],
                        "arguments": json.dumps(
                            {"facts": []} if arguments is None else arguments,
                        ),
                    },
                }]},
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

    def run_cases(self, cases, transport, *, limit=4):
        return run_offline_evaluation(
            cases=tuple(cases), output_directory=self.output, run_id=self.run_id,
            request_limit=limit, synthetic_transport=transport,
        )

    def fact(self, case, *, text, subject="contact"):
        return {
            "text": text, "category": "preference", "subject": subject,
            "topic": "other",
            "source_message_ids": [str(build_window(case).target_message_ids[0])],
            "confidence": 0.99, "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted",
            "figurative_type": "literal", "alternatives": [],
            "interpretation_reason": "合成测试来源直接陈述。",
        }

    def verification(self, case):
        window = build_window(case)
        return {"results": [{
            "candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{
                "message_id": str(window.target_message_ids[0]),
                "quote": window.messages[case.targets[0]].text,
            }],
        }]}

    def test_empty_extraction_completes_closes_and_never_invokes_verification(self):
        result = self.run_cases((self.none_case,), httpx.MockTransport(self.response))
        self.assertTrue(result["synthetic_only"])
        self.assertFalse(result["quality_certified"])
        self.assertEqual(result["summary"]["planned"], 1)
        self.assertEqual(result["summary"]["completed"], 1)
        self.assertEqual(result["summary"]["empty"], 1)
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertEqual(result["outcomes"][0]["status"], "empty")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0]["tool_choice"]["function"]["name"],
                         "MemoryExtractionOutput")
        self.assertIsNotNone(result["receipt"])
        self.assertIsNone(result["receipt_error_code"])
        kinds = [event["kind"] for event in result["events"]]
        self.assertLess(kinds.index("provider_response"), kinds.index("adapter_output"))
        self.assertLess(kinds.index("adapter_output"), kinds.index("case_result"))
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=self.run_id)

    def test_nonempty_extraction_runs_verification_and_keeps_raw_and_original_score(self):
        case = next(case for case in CASES if case.name == "否定事实")
        fact = self.fact(case, text="联系人不喝酒。")

        def synthetic(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            arguments = ({"facts": [fact]} if name == "MemoryExtractionOutput"
                         else self.verification(case))
            return self.response(request, arguments=arguments)

        result = self.run_cases((case,), httpx.MockTransport(synthetic))
        self.assertEqual(result["outcomes"][0]["status"], "completed")
        self.assertTrue(result["outcomes"][0]["result"]["passed"])
        self.assertEqual(result["summary"]["empty"], 0)
        self.assertEqual([request["tool_choice"]["function"]["name"]
                          for request in self.requests],
                         ["MemoryExtractionOutput", "SourceVerificationOutput"])
        provider = [event for event in result["events"]
                    if event["kind"] == "provider_response"]
        adapters = [event for event in result["events"]
                    if event["kind"] == "adapter_output"]
        self.assertEqual([event["purpose"] for event in provider],
                         ["extraction", "verification"])
        self.assertEqual(provider[0]["payload"]["body"]["model"],
                         "synthetic-response-model")
        self.assertEqual(adapters[0]["payload"]["tool_calls"][0]["args"]["facts"], [fact])

    def test_timeout_retry_exhausts_budget_and_preserves_unknown_and_unrun(self):
        case = next(case for case in CASES if case.name == "主体：联系人自述状态")

        def timeout(request):
            self.requests.append(json.loads(request.content))
            raise httpx.ReadTimeout("synthetic timeout")

        result = self.run_cases((case, self.none_case), httpx.MockTransport(timeout), limit=2)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual([item["status"] for item in result["outcomes"]],
                         ["unknown", "unrun"])
        self.assertEqual(result["summary"]["completed"], 0)
        self.assertFalse(result["summary"]["plan_complete"])
        self.assertIsNotNone(result["receipt"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        failures = [event for event in result["events"]
                    if event["kind"] == "provider_failure"]
        self.assertEqual([event["request_sequence"] for event in failures], [1, 2])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=self.run_id)

    def test_first_wrong_subject_saves_safety_result_and_does_not_fill_later_positions(self):
        case = next(case for case in CASES if case.name == "主体：联系人自述状态")
        fact = self.fact(case, text="用户最近搬到杭州了。", subject="self")

        def synthetic(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            return self.response(request, arguments=(
                {"facts": [fact]} if name == "MemoryExtractionOutput"
                else self.verification(case)
            ))

        result = self.run_cases((case, self.none_case), httpx.MockTransport(synthetic))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_safety_error")
        self.assertEqual([item["status"] for item in result["outcomes"]],
                         ["completed", "unrun"])
        self.assertEqual(result["outcomes"][0]["result"]["wrong_subject_count"], 1)
        self.assertEqual(result["summary"]["completed"], 1)
        self.assertEqual(result["summary"]["unrun"], 1)
        self.assertFalse(result["summary"]["plan_complete"])
        self.assertFalse(result["receipt"]["plan_complete"])

    def test_extra_extraction_tool_call_is_saved_before_structure_failure_and_stop(self):
        later = next(case for case in CASES if case.name == "主体：联系人自述状态")

        def extra_call(request):
            response = self.response(request)
            body = response.json()
            calls = body["choices"][0]["message"]["tool_calls"]
            calls.append({
                "id": "synthetic-extra-call", "type": "function",
                "function": {
                    "name": "MemoryExtractionOutput",
                    "arguments": json.dumps({"facts": [self.fact(
                        self.none_case, text="额外合成候选。", subject="self",
                    )]}),
                },
            })
            return httpx.Response(200, request=request, json=body)

        result = self.run_cases((self.none_case, later), httpx.MockTransport(extra_call))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual([item["status"] for item in result["outcomes"]],
                         ["failed", "unrun"])
        adapter = next(event for event in result["events"]
                       if event["kind"] == "adapter_output")
        provider = next(event for event in result["events"]
                        if event["kind"] == "provider_response")
        self.assertEqual(len(adapter["payload"]["tool_calls"]), 2)
        self.assertEqual(len(provider["payload"]["body"]["choices"][0]
                             ["message"]["tool_calls"]), 2)
        self.assertIsNotNone(result["receipt"])

    def test_legal_empty_miss_is_scored_without_retry_and_does_not_become_a_run_failure(self):
        missing = next(case for case in CASES if case.name == "主体：联系人自述状态")
        result = self.run_cases((missing, self.none_case), httpx.MockTransport(self.response))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual([item["status"] for item in result["outcomes"]], ["empty", "empty"])
        self.assertFalse(result["outcomes"][0]["result"]["passed"])
        self.assertEqual(result["outcomes"][0]["result"]["error_kind"], "general")
        self.assertTrue(result["outcomes"][1]["result"]["passed"])
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertEqual(result["summary"]["failed"], 0)
        self.assertEqual(result["summary"]["unknown"], 0)
        self.assertFalse(result["receipt"]["quality_certified"])

    def test_output_directory_replacement_stops_before_next_dispatch_without_receipt(self):
        later = next(case for case in CASES if case.name == "主体：联系人自述状态")

        def replace_output(request):
            self.output.rename(self.home / "replaced-output")
            self.output.mkdir(mode=0o700)
            return self.response(request)

        result = self.run_cases((self.none_case, later), httpx.MockTransport(replace_output))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual([item["status"] for item in result["outcomes"]], ["unknown", "unrun"])
        self.assertIsNone(result["receipt"])
        self.assertEqual(result["receipt_error_code"], "offline_completion_receipt_unavailable")
        self.assertEqual(result["records_error_code"], "offline_records_unavailable")
        self.assertFalse((self.output / "completion.json").exists())
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=self.run_id)

    def test_close_storage_fault_keeps_original_safety_stop_and_refuses_completion(self):
        case = next(case for case in CASES if case.name == "主体：联系人自述状态")
        fact = self.fact(case, text="用户最近搬到杭州了。", subject="self")

        def synthetic(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            return self.response(request, arguments=(
                {"facts": [fact]} if name == "MemoryExtractionOutput"
                else self.verification(case)
            ))

        real_open = os.open

        def fail_close(filename, *args, **kwargs):
            if Path(filename).name == "closed":
                raise OSError("synthetic close storage fault")
            return real_open(filename, *args, **kwargs)

        with patch.object(os, "open", side_effect=fail_close):
            result = self.run_cases((case, self.none_case), httpx.MockTransport(synthetic))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_safety_error")
        self.assertEqual([item["status"] for item in result["outcomes"]], ["completed", "unrun"])
        self.assertIsNone(result["receipt"])
        self.assertFalse((self.output / "completion.json").exists())
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=self.run_id)

    def test_ambient_langsmith_tracing_is_disabled_and_original_context_is_restored(self):
        from langsmith import Client, tracing_context
        from langsmith.utils import tracing_is_enabled

        os.environ["LANGSMITH_TRACING"] = "true"
        os.environ["LANGSMITH_API_KEY"] = "synthetic-not-a-real-tracing-key"

        def synthetic(request):
            self.assertFalse(tracing_is_enabled())
            return self.response(request)

        with tracing_context(enabled=True, parent=False), patch.object(
            Client, "__init__", side_effect=AssertionError("禁止构造追踪网络客户端"),
        ):
            result = self.run_cases((self.none_case,), httpx.MockTransport(synthetic))
            self.assertTrue(tracing_is_enabled())
        self.assertEqual(len(self.requests), 1)
        self.assertIsNotNone(result["receipt"])

    def test_first_false_fact_stops_even_when_synthetic_verifier_reports_supported(self):
        later = next(case for case in CASES if case.name == "主体：联系人自述状态")
        invented = self.fact(self.none_case, text="用户是这所学校的学生。", subject="self")

        def synthetic(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            return self.response(request, arguments=(
                {"facts": [invented]} if name == "MemoryExtractionOutput"
                else self.verification(self.none_case)
            ))

        result = self.run_cases((self.none_case, later), httpx.MockTransport(synthetic))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_safety_error")
        self.assertEqual(result["outcomes"][0]["result"]["false_fact_count"], 1)
        self.assertEqual(result["outcomes"][1]["status"], "unrun")
        self.assertFalse(result["summary"]["plan_complete"])
        self.assertFalse(result["quality_certified"])

    def test_both_client_cleanup_faults_preserve_original_stop_without_completion(self):
        case = next(case for case in CASES if case.name == "主体：联系人自述状态")
        fact = self.fact(case, text="用户最近搬到杭州了。", subject="self")
        for mode, stop_code, expected_dispatches in (
            ("safety", "case_safety_error", 2),
            ("runtime", "case_contract_or_runtime_failed", 1),
        ):
            with self.subTest(mode=mode):
                self.output = self.home / f"cleanup-{mode}"
                self.output.mkdir(mode=0o700)
                self.run_id = uuid4()
                self.requests.clear()
                cleanup_attempts = []

                def synthetic(request):
                    if mode == "runtime":
                        return self.response(request, status=400)
                    name = json.loads(request.content)["tool_choice"]["function"]["name"]
                    return self.response(request, arguments=(
                        {"facts": [fact]} if name == "MemoryExtractionOutput"
                        else self.verification(case)
                    ))

                def close_failed(transport):
                    cleanup_attempts.append("sync")
                    raise RuntimeError("synthetic sync cleanup fault")

                async def async_close_failed(transport):
                    cleanup_attempts.append("async")
                    raise RuntimeError("synthetic async cleanup fault")

                with patch.object(httpx.MockTransport, "close", new=close_failed), \
                        patch.object(httpx.MockTransport, "aclose", new=async_close_failed):
                    result = self.run_cases((case, self.none_case), httpx.MockTransport(synthetic))
                self.assertEqual(cleanup_attempts, ["sync", "async"])
                self.assertEqual(len(self.requests), expected_dispatches)
                self.assertEqual(result["stopped_code"], stop_code)
                self.assertEqual(result["outcomes"][1]["status"], "unrun")
                self.assertEqual(result["cleanup_error_codes"], (
                    "offline_sync_client_close_failed", "offline_async_client_close_failed",
                ))
                self.assertIsNone(result["receipt"])
                self.assertFalse((self.output / "completion.json").exists())
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=self.run_id)


if __name__ == "__main__":
    unittest.main()
