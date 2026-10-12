"""ECNU 评测入口的受守卫离线验收；只发送到 exact Mock。"""

from __future__ import annotations

import importlib
import hashlib
import json
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES


PLAN = tuple(case for case in CASES if case.dimension == "reference") + tuple(
    case for case in SEMANTIC_CASES if case.dimension == "reference"
) + tuple(case for case in SEMANTIC_CASES if case.name in {
    "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
})


class EvaluationECNUTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(os, "environ", {}))
        for module_name in ("httpx", "httpx2", "httpx._client", "httpx2._client"):
            module = importlib.import_module(module_name)
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(patch.object(
                    module, name,
                    side_effect=AssertionError("禁止真实 network transport"),
                ))
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(patch.object(
                socket.socket, name,
                side_effect=AssertionError("禁止真实 socket 连接"),
            ))
        self.stack.enter_context(patch.object(
            socket, "getaddrinfo", side_effect=AssertionError("禁止真实 DNS 查询"),
        ))
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        self.output = self.home / "output"
        self.output.mkdir(mode=0o700)
        self.repo = self.home / "repo"
        self.repo.mkdir()
        self.requests = []
        self.credentials = []
        self.audits = []

    def preparation(self):
        actual_repo = Path(__file__).resolve().parents[4]
        relatives = [str(path.relative_to(actual_repo)) for path in
                     (actual_repo / "backend/src/notalone/memory_extraction").rglob("*.py")]
        relatives += [
            "backend/pyproject.toml", "backend/src/notalone/__init__.py",
            "backend/src/notalone/scopes.py",
            *(f"backend/src/notalone/memory/{name}.py" for name in
              ("__init__", "adapters", "models", "ports", "timing")),
            *(f"backend/src/notalone/memory_trace/{name}.py" for name in
              ("__init__", "context", "ports", "transport")),
            *(f"backend/src/notalone/ledger/{name}.py" for name in
              ("__init__", "models", "ports")),
            ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md",
        ]
        hashes = {}
        for relative in relatives:
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("合成冻结资料。\n", encoding="utf-8")
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        criterion = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
        return hashes, {
            "status": "frozen_agent_review", "case_names": [case.name for case in PLAN],
            "criteria_sha256": hashes[criterion],
        }

    def credential(self):
        self.credentials.append("loaded")
        return "synthetic-not-a-real-key"

    def audit(self, bundle, decision="general_error", reason="coverage_miss"):
        self.audits.append(bundle)
        return {
            "case_position": bundle["case_position"], "decision": decision,
            "reason_code": reason,
            "criteria_sha256": bundle["gold_reference"]["criteria_sha256"],
        }

    def response(self, request, *, arguments=None, reported_model="synthetic-reported-model"):
        payload = json.loads(request.content)
        self.requests.append(payload)
        return httpx.Response(200, request=request, json={
            "id": "synthetic-completion", "object": "chat.completion", "created": 1,
            "model": reported_model,
            "choices": [{"index": 0, "message": {
                "role": "assistant", "content": None, "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": payload["tool_choice"]["function"]["name"],
                        "arguments": json.dumps({"facts": []} if arguments is None else arguments),
                    },
                }],
            }, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

    def run_ready(self, *, transport=None, audit=None, gold=None, hashes=None,
                  credential=None, run_id=None):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation

        if hashes is None or gold is None:
            prepared_hashes, prepared_gold = self.preparation()
            hashes = prepared_hashes if hashes is None else hashes
            gold = prepared_gold if gold is None else gold
        return run_ecnu_evaluation(
            output_directory=self.output, run_id=run_id or uuid4(),
            deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
            repo_root=self.repo, source_hashes=hashes, frozen_gold=gold,
            credential_loader=credential or self.credential, audit_case=audit or self.audit,
            synthetic_transport=transport or httpx.MockTransport(self.response),
        )

    def test_unfrozen_gold_is_rejected_before_credentials_or_dispatch(self) -> None:
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation

        calls = []
        with self.assertRaises(EvaluationBudgetAbort):
            run_ecnu_evaluation(
                output_directory=self.output, run_id=uuid4(),
                deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
                repo_root=self.home, source_hashes={},
                frozen_gold={"status": "pending"},
                credential_loader=lambda: calls.append("credential"),
                audit_case=lambda bundle: calls.append("audit"),
                synthetic_transport=httpx.MockTransport(
                    lambda request: calls.append("dispatch"),
                ),
            )
        self.assertEqual(calls, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_fixed_plan_runs_empty_extraction_with_durable_independent_audits(self):
        result = self.run_ready()
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(len(self.requests), 21)
        self.assertEqual(len(self.audits), 21)
        self.assertEqual([item["case_name"] for item in result["outcomes"]],
                         [case.name for case in PLAN])
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertEqual(result["summary"]["empty"], 21)
        self.assertEqual(result["summary"]["semantic_audit"]["general_error"], 21)
        self.assertFalse(result["quality_certified"])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 42)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 21)
        audits = [event for event in result["events"] if event["kind"] == "semantic_audit"]
        self.assertEqual(len(audits), 21)
        for bundle in self.audits:
            self.assertEqual(len(bundle["adapter_outputs"]), 1)
            self.assertEqual(bundle["adapter_outputs"][0]["tool_calls"][0]["args"],
                             {"facts": []})
            self.assertIn("original_result", bundle)
        for request in self.requests:
            self.assertEqual(set(request), {
                "model", "temperature", "stream", "thinking", "messages", "tools",
                "tool_choice",
            })
            self.assertEqual(request["model"], "ecnu-max")
            self.assertEqual(request["thinking"], {"type": "enabled"})

    def test_audit_cannot_reassign_current_position_by_mutating_its_bundle(self):
        def reassigned(bundle):
            bundle["case_position"] = 99
            return self.audit(bundle, decision="safe", reason="supported")

        result = self.run_ready(audit=reassigned)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["outcomes"][0]["status"], "unknown")
        self.assertEqual(result["summary"]["unrun"], 20)
        self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual([event for event in result["events"]
                          if event["kind"] == "semantic_audit"], [])

    def test_bad_output_permissions_rejects_before_credential_loader(self):
        self.output.chmod(0o755)
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready()
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_credential_failure_durably_closes_original_run_without_sends(self):
        run_id = uuid4()

        def unavailable():
            self.credentials.append("loaded")
            raise RuntimeError("合成凭据入口失败，不保存错误文字。")

        result = self.run_ready(credential=unavailable, run_id=run_id)
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(self.requests, [])
        self.assertTrue((self.output / "manifest.json").exists())
        self.assertEqual(result["stopped_code"], "ecnu_credential_unavailable")
        self.assertEqual(result["summary"]["unrun"], 21)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_credential_failure_cannot_reopen_run_even_when_close_storage_fails(self):
        run_id = uuid4()

        def unavailable():
            raise RuntimeError("合成凭据入口失败。")

        with patch.object(EvaluationBudget, "close", side_effect=EvaluationBudgetAbort(
            "synthetic_close_storage_failed",
        )):
            result = self.run_ready(credential=unavailable, run_id=run_id)
        self.assertEqual(self.requests, [])
        self.assertEqual(result["stopped_code"], "ecnu_credential_unavailable")
        self.assertIsNone(result["receipt"])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_underfrozen_sources_or_changed_gold_plan_never_load_credentials(self):
        for mutation in ("missing_source", "reordered_cases", "criterion_digest", "changed_file"):
            with self.subTest(mutation=mutation):
                hashes, gold = self.preparation()
                if mutation == "missing_source":
                    del hashes["backend/src/notalone/memory_extraction/verification_adapters.py"]
                elif mutation == "reordered_cases":
                    gold["case_names"].reverse()
                elif mutation == "criterion_digest":
                    gold["criteria_sha256"] = "f" * 64
                else:
                    (self.repo / "backend/src/notalone/memory_extraction/flow.py").write_text(
                        "合成冻结后文件变化。", encoding="utf-8",
                    )
                with self.assertRaises(EvaluationBudgetAbort):
                    self.run_ready(hashes=hashes, gold=gold)
                self.assertEqual(self.credentials, [])
                self.assertEqual(self.requests, [])

    def test_freeze_includes_dependencies_imported_by_memory_package_initializer(self):
        hashes, gold = self.preparation()
        del hashes["backend/src/notalone/memory/adapters.py"]
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready(hashes=hashes, gold=gold)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_semantic_safety_or_unknown_stops_before_next_case_and_preserves_denominator(self):
        for decision, reason in (("safety_error", "false_fact"), ("unknown", "audit_unresolved")):
            with self.subTest(decision=decision):
                self.output = self.home / decision
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                result = self.run_ready(audit=lambda bundle: self.audit(
                    bundle, decision=decision, reason=reason,
                ))
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["stopped_code"], "case_semantic_audit_" + decision)
                self.assertEqual(result["summary"]["planned"], 21)
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertFalse(result["receipt"]["plan_complete"])
                audit = next(event for event in result["events"]
                             if event["kind"] == "semantic_audit")
                self.assertEqual(audit["payload"]["decision"], decision)

    def test_response_identity_drift_is_stored_before_stopping_original_plan(self):
        def changed_model(request):
            model = "first-model" if not self.requests else "changed-model"
            return self.response(request, reported_model=model)

        result = self.run_ready(transport=httpx.MockTransport(changed_model))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["summary"]["empty"], 1)
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 19)
        responses = [event for event in result["events"] if event["kind"] == "provider_response"]
        self.assertEqual([event["payload"]["body"]["model"] for event in responses],
                         ["first-model", "changed-model"])
        self.assertEqual(len(self.audits), 1)

    def test_legacy_matcher_difference_is_retained_and_independent_safe_audit_can_continue(self):
        case = PLAN[5]
        window = build_window(case)
        sources = [str(message.message_id) for message in window.messages]
        shared = {
            "subject": "contact", "topic": "travel", "confidence": 0.99,
            "risk_flags": [], "speech_act": "assertion", "assertion_status": "asserted",
            "figurative_type": "literal", "alternatives": [],
            "interpretation_reason": "合成来源直接表达完成和等待状态。",
        }
        facts = [{**shared, "text": "联系人已经到机场。", "category": "common_fact",
                  "source_message_ids": sources, "valid_at": None, "invalid_at": None},
                 {**shared, "text": "2026-09-15来源时点联系人正在等行李。",
                  "category": "recent_state", "source_message_ids": [sources[1]],
                  "valid_at": "2026-09-15T00:01:00+00:00",
                  "invalid_at": "2026-09-16T00:00:00+00:00"}]

        def synthetic(request):
            body = json.loads(request.content)
            name = body["tool_choice"]["function"]["name"]
            if len(self.audits) != 5:
                return self.response(request)
            if name == "MemoryExtractionOutput":
                return self.response(request, arguments={"facts": facts})
            return self.response(request, arguments={"results": [{
                "candidate_index": index, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": sources[1], "quote": window.messages[1].text}],
            } for index in range(2)]})

        def audit(bundle):
            if bundle["case_position"] == 5:
                return self.audit(bundle, decision="safe", reason="supported")
            return self.audit(bundle)

        result = self.run_ready(transport=httpx.MockTransport(synthetic), audit=audit)
        self.assertEqual(len(self.requests), 22)
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertGreater(result["outcomes"][5]["result"]["false_fact_count"], 0)
        self.assertEqual(result["audits"][5]["decision"], "safe")
        self.assertEqual([request["tool_choice"]["function"]["name"]
                          for request in self.requests[5:7]],
                         ["MemoryExtractionOutput", "SourceVerificationOutput"])
        self.assertEqual(len(self.audits[5]["adapter_outputs"]), 2)
        self.assertFalse(result["quality_certified"])

    def test_sdk_retries_share_42_attempt_cap_and_cannot_fill_final_verification(self):
        attempts = {}

        def retry(request):
            body = json.loads(request.content)
            position = len(self.audits)
            attempts[position] = attempts.get(position, 0) + 1
            if attempts[position] == 1:
                self.requests.append(body)
                return httpx.Response(429, request=request,
                                      headers={"retry-after-ms": "1"},
                                      json={"error": {"message": "合成429错误"}})
            if position != 20:
                return self.response(request)
            window = build_window(PLAN[20])
            fact = {
                "text": "2026-09-15来源时点联系人不知道表弟当前做什么工作。",
                "category": "recent_state", "subject": "contact", "topic": "work",
                "source_message_ids": [str(window.target_message_ids[-1])],
                "confidence": 0.99, "risk_flags": [],
                "valid_at": "2026-09-15T00:02:00+00:00", "invalid_at": None,
                "speech_act": "assertion", "assertion_status": "asserted",
                "figurative_type": "literal", "alternatives": [],
                "interpretation_reason": "合成直接知识状态。",
            }
            return self.response(request, arguments={"facts": [fact]})

        result = self.run_ready(transport=httpx.MockTransport(retry))
        self.assertEqual(len(self.requests), 42)
        for position in range(21):
            self.assertEqual(self.requests[2 * position], self.requests[2 * position + 1])
        self.assertEqual(result["summary"]["completed"], 20)
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 0)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 42)
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertEqual(len(self.audits), 20)

    def test_duplicate_run_is_rejected_without_a_second_credential_read(self):
        run_id = uuid4()
        self.run_ready(run_id=run_id, audit=lambda bundle: self.audit(
            bundle, decision="unknown", reason="audit_unresolved",
        ))
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready(run_id=run_id)
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(len(self.requests), 1)

    def test_invalid_or_throwing_audit_is_not_silently_safe_or_saved_as_error_text(self):
        for mode in ("incomplete", "wrong_criterion", "throws"):
            with self.subTest(mode=mode):
                self.output = self.home / mode
                self.output.mkdir(mode=0o700)
                self.requests.clear()

                def invalid(bundle):
                    if mode == "incomplete":
                        return {"decision": "safe"}
                    if mode == "throws":
                        raise RuntimeError("synthetic-secret-never-record")
                    answer = self.audit(bundle)
                    answer["criteria_sha256"] = "f" * 64
                    return answer

                result = self.run_ready(audit=invalid)
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertEqual(result["audits"], ())
                self.assertNotIn("synthetic-secret-never-record", json.dumps(result))

    def test_in_memory_prompt_or_schema_drift_cannot_redefine_frozen_request(self):
        from notalone.memory_extraction import adapters

        for mutation in ("schema", "prompt"):
            with self.subTest(mutation=mutation):
                self.output = self.home / mutation
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                self.audits.clear()
                original_schema = deepcopy(adapters.EXTRACTION_SCHEMA)
                original_prompt = adapters.EXTRACTION_SYSTEM_PROMPT

                def changed(bundle):
                    if mutation == "schema":
                        adapters.EXTRACTION_SCHEMA["description"] = "合成内存契约漂移。"
                    else:
                        adapters.EXTRACTION_SYSTEM_PROMPT += "合成内存提示漂移。"
                    return self.audit(bundle)

                try:
                    result = self.run_ready(audit=changed)
                finally:
                    adapters.EXTRACTION_SCHEMA.clear()
                    adapters.EXTRACTION_SCHEMA.update(original_schema)
                    adapters.EXTRACTION_SYSTEM_PROMPT = original_prompt
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["outcomes"][0]["status"], "empty")
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(len(result["audits"]), 1)

    def test_audit_receives_saved_requests_for_actual_verification_input(self):
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "未知第三人不是仓库管理员，在采购部。",
            "category": "relationship_note", "subject": "contact", "topic": "work",
            "source_message_ids": [source], "confidence": 0.9,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "report", "assertion_status": "reported",
            "figurative_type": "literal", "alternatives": ["第三人身份未知。"],
            "interpretation_reason": "合成第三人原话。",
        }

        def response(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            arguments = {"facts": [fact]} if name == "MemoryExtractionOutput" else {
                "results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                             "evidence": [{"message_id": source,
                                           "quote": window.messages[0].text}]}],
            }
            return self.response(request, arguments=arguments)

        result = self.run_ready(
            transport=httpx.MockTransport(response),
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(len(self.audits), 1)
        requests = self.audits[0]["provider_requests"]
        saved = tuple(event["payload"] for event in result["events"]
                      if event["kind"] == "provider_request")
        self.assertEqual(requests, saved)
        self.assertEqual(len(requests), 2)
        self.assertNotIn("authorization", json.dumps(requests).lower())
        self.assertNotIn("synthetic-not-a-real-key", json.dumps(requests))
        self.assertIn("candidate_index", json.dumps(requests))

    def test_confidence_boolean_or_string_is_saved_then_rejected_before_verification(self):
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        for confidence in (True, "0.99"):
            with self.subTest(confidence=confidence):
                self.output = self.home / f"confidence-{type(confidence).__name__}"
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                self.audits.clear()
                fact = {
                    "text": "未知第三人不是仓库管理员，在采购部。",
                    "category": "relationship_note", "subject": "contact", "topic": "work",
                    "source_message_ids": [source], "confidence": confidence,
                    "risk_flags": [], "valid_at": None, "invalid_at": None,
                    "speech_act": "report", "assertion_status": "reported",
                    "figurative_type": "literal", "alternatives": [],
                    "interpretation_reason": "合成第三人原话。",
                }

                def invalid_number(request):
                    name = json.loads(request.content)["tool_choice"]["function"]["name"]
                    arguments = {"facts": [fact]} if name == "MemoryExtractionOutput" else {
                        "results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                                     "evidence": [{"message_id": source,
                                                   "quote": window.messages[0].text}]}],
                    }
                    return self.response(request, arguments=arguments)

                result = self.run_ready(transport=httpx.MockTransport(invalid_number))
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["outcomes"][0]["status"], "failed")
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertEqual(result["audits"], ())
                adapter = next(event for event in result["events"]
                               if event["kind"] == "adapter_output")
                self.assertEqual(adapter["payload"]["tool_calls"][0]["args"]["facts"][0]
                                 ["confidence"], confidence)


if __name__ == "__main__":
    unittest.main()
