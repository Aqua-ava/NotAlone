"""正式任务、预算记录和分阶段审核的同场控制；所有HTTP均为Mock。"""

from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_bounded_cases import (
    BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_REFERENCE_PATH,
)
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_offline import _run_evaluation_batch
from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.source_proof import bounded_source_occurred_at
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.tasks.models import ExtractionRuntimeMode
from tests.integration.tasks import test_bounded_runtime_acceptance as acceptance
from tests.unit.memory_extraction.test_evaluation_bounded_registration import bounded_config


class FormalEvaluationBatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        acceptance.BoundedRuntimeAcceptanceTest.setUpClass.__func__(cls)

    @classmethod
    def drop_database(cls):
        acceptance.BoundedRuntimeAcceptanceTest.drop_database.__func__(cls)

    def sources(self):
        windows, task_ids = [], []
        for source in BOUNDED_RUNTIME_INPUTS:
            acceptance.BoundedRuntimeAcceptanceTest.setUp(self)
            texts = tuple(row["text"] for row in source["messages"])
            senders = tuple(row["sender"] for row in source["messages"])
            if source["source_route"] == "jsonl":
                acceptance.BoundedRuntimeAcceptanceTest.import_source(self, texts, senders)
            else:
                acceptance.BoundedRuntimeAcceptanceTest.observe_source(self, texts, senders)
            PostgresBackgroundTaskRepository(self.database_url).configure_extraction_runtime(
                owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, task_id=self.task_id,
                config=runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1),
            )
            messages = tuple(replace(row, occurred_at=bounded_source_occurred_at(row)) for row in self.messages)
            windows.append(ExtractionWindow(self.scope.owner_id, self.scope.contact_id, messages,
                                           target_message_ids=tuple(messages[index].message_id for index in source["target_indices"])))
            task_ids.append(self.task_id)
        return tuple(windows), tuple(task_ids)

    def test_empty_first_positive_is_audited_and_closes_without_running_other_fourteen_tasks(self):
        self.run_first_case(empty=True)

    def test_actual_proof3_and_forced_verification_are_saved_before_unresolved_axis_stops(self):
        self.run_first_case(empty=False)

    def test_duplicate_raw_proof_key_is_saved_and_stops_without_retry_or_audit_credit(self):
        self.run_first_case(empty=False, malformed=True)

    def test_completed_first_case_is_retained_when_next_extraction_times_out(self):
        self.run_first_case(empty=False, next_timeout=True)

    def test_sealed_raw_safety_is_retained_when_full_review_fails_without_axis_credit(self):
        for safety in ("false_fact", "wrong_person"):
            with self.subTest(safety=safety):
                self.run_first_case(empty=False, raw_safety=safety)

    def run_first_case(self, *, empty, malformed=False, next_timeout=False, raw_safety=None):
        windows, task_ids = self.sources()
        root = Path(__file__).resolve().parents[4]
        reference = json.loads((root / BOUNDED_RUNTIME_REFERENCE_PATH).read_text())
        # 此副本只供机械协议测试；仓库中的真实Gold仍须另行独立审核。
        reference["status"] = "agent_reviewed_reference"
        reference["provenance"]["structured_review"] = {"status": "passed", "reviewer": "合成协议控制"}
        reference["provenance"]["independent_review"] = {"status": "passed", "reviewer": "合成协议控制"}
        seen = []

        def raw_reviewer(view):
            seen.append("raw")
            self.assertNotIn("verification_protocol", view)
            self.assertNotIn("formal_task_execution", view)
            self.assertEqual(len(view["extraction"]), 0 if empty else 1)
            return {"reviewer": "合成RAW控制", "case_id": view["case_id"],
                    "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
                    "e_rows": [{"raw_index": row["index"], "payload_sha256": row["payload_sha256"],
                                "fields": {field: "pass" for field in view["e_fields"]},
                                "meaning": "pass", "inclusion": "pass", "safety": raw_safety or "safe", "classification": "required",
                                "basis": "本合成到家输出完整保留作者、刚刚、已完成及原话。"} for row in view["extraction"]],
                    "claims": [{"claim_id": row["id"], "groups": [] if empty else [{
                        "raw_indices": [0], "variant_id": row["variants"][0]["id"],
                        **{key: "pass" for key in ("raw_meaning", "coherence", "branch", "source", "time")},
                    }]}
                                               for row in view["reference_case"]["claims"]],
                    "window_checks": {"inclusion": "fail" if empty else "pass", "forbidden_meanings": "pass"}}

        def full_reviewer(view):
            seen.append("full")
            if raw_safety:
                raise TimeoutError("合成FULL审核中断；已封存RAW安全事实必须保留")
            review = deepcopy(view["sealed_raw_review"])
            review.pop("raw_evidence_sha256")
            packet = view["packet"]
            for row in review["e_rows"]:
                row["lineage"] = {"v_input_indices": [0], "final_indices": [0], "status": "pass"}
            for claim in review["claims"]:
                for group in claim["groups"]:
                    group.update(final_indices=[0], lineage="pass", destination="pass")
            review.update(evidence_sha256=packet["evidence_sha256"], run_status="empty" if empty else "completed",
                          v_rows=[{"result_index": row["index"], "payload_sha256": row["payload_sha256"],
                                   "fields": {field: "pass" for field in ("candidate_index", "verdict", "issues", "evidence")},
                                   "semantic": "pass", "e_indices": [0], "lineage": "pass", "basis": "实际同一次V的到家证据。"}
                                  for row in packet["layers"]["verification"]],
                          axis_reviews={axis: {"status": "fail" if empty else "unresolved" if axis == "reference" and not next_timeout else "pass",
                                                "basis": f"{axis}按本窗独立判据记录，未知控制不签通过"}
                                        for axis in ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")})
            review["window_checks"]["lineage"] = "pass"
            return review

        audit = PhasedEvaluationAudit(
            reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=reference["annotation_sha256"], criteria_sha256="c" * 64,
            raw_reviewer=raw_reviewer, full_reviewer=full_reviewer, case_set="bounded15",
            verification_mode="nullable-proof-v3", verification_tool_choice="forced",
            extraction_tool_choice="omitted", extraction_mode="grounded-v2",
            reference_version="bounded-runtime15-v1", execution_plan="bounded-runtime15-v1",
        )

        requests = []

        def respond(request):
            requests.append(request)
            if next_timeout and len(requests) == 3:
                raise httpx.ReadTimeout("synthetic-next-case-timeout", request=request)
            body = json.loads(request.content)
            name = body["tools"][0]["function"]["name"]
            if name == "GroundedMemoryLabels":
                self.assertNotIn("tool_choice", body)
                self.assertEqual(body["thinking"], {"type": "enabled"})
                self.assertEqual(body["reasoning_effort"], "max")
                payload = {"units": {"0:0": acceptance.label("not_memory" if empty else "event")}}
            else:
                self.assertEqual(name, "SourceVerificationOutput")
                self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": name}})
                self.assertEqual(body["thinking"], {"type": "disabled"})
                self.assertEqual(body["reasoning_effort"], "none")
                actual = json.loads(body["messages"][1]["content"])
                proof = acceptance.direct_proposal("BR_AUTHOR_ARRIVAL_V1", "direct_quote", "我刚刚到家。")(actual)
                payload = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                                        "evidence": [{"message_id": row["message_id"], "quote": row["text"]}
                                                     for row in actual["messages"]], "proof": proof}]}
            arguments = json.dumps(payload)
            if malformed and name == "SourceVerificationOutput":
                arguments = arguments.replace('"version": 3', '"version": 3, "version": 3', 1)
            return httpx.Response(200, request=request, json={
                "id": "synthetic-empty", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": "",
                    "reasoning_content": "synthetic-private-reasoning",
                    "tool_calls": [{"id": "synthetic-e", "type": "function", "function": {
                        "name": name, "arguments": arguments}}]}}],
            })

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"
            output.mkdir(mode=0o700)
            config, plan, _ = bounded_config(windows=windows, task_ids=task_ids)
            config["gold_sha256"] = canonical_sha256(reference)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=30,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
            records = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan, actual_windows=windows)
            result = _run_evaluation_batch(
                cases=BOUNDED_RUNTIME_CASES, windows=windows, plan=plan, budget=budget, store=records,
                base_url="https://api.deepseek.com", request_model="deepseek-flash", api_key="synthetic-only",
                synthetic_transport=httpx.MockTransport(respond), provider="deepseek", request_timeout_seconds=300,
                max_retries=0, verification_mode="nullable-proof-v3", verification_tool_choice="forced",
                extraction_tool_choice="omitted", extraction_mode="grounded-v2", execution_plan="bounded-runtime15-v1",
                semantic_audit=audit, gold_reference={"criteria_sha256": "c" * 64},
                formal_task_ids=task_ids, database_url=self.database_url,
            )
            self.assertEqual(seen, [] if malformed else ["raw", "full"], {
                "stopped": result["stopped_code"], "cleanup": result["cleanup_error_codes"],
                "events": [(row["kind"], row["payload"].get("reason_code"),
                            row["payload"].get("task", {}).get("current_step")) for row in result["events"]],
                "failures": [(event["stage"], {key: event["payload"].get(key) for key in
                              ("error_code", "error_detail", "failure_kind", "reason", "response_status", "status")})
                             for row in result["events"] if row["kind"] == "case_failed"
                             for trace in row["payload"]["actual_traces"] for event in trace["events"]
                             if "failure" in event["stage"] or event["stage"] in {"batch_end", "verification_contract"}],
            })
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 3 if next_timeout else 1 if empty else 2)
            self.assertTrue(result["receipt"]["budget"]["closed"])
            self.assertEqual(result["summary"]["unrun"], 13 if next_timeout else 14)
            if raw_safety:
                self.assertEqual(result["stopped_code"], "offline_hard_stop")
                self.assertEqual(result["summary"]["dimensions"], [])
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(result["summary"]["semantic_audit"]["audited"], 0)
                self.assertEqual(result["summary"]["known_raw_safety"], {
                    "raw_reviewed_windows": 1, "raw_false_fact": int(raw_safety == "false_fact"),
                    "raw_wrong_person": int(raw_safety == "wrong_person"), "unsafe_windows": 1,
                    "without_final_review": 1,
                })
                phases = [row["payload"]["phase"] for row in result["events"]
                          if row["kind"] == "semantic_audit"]
                self.assertEqual(phases, ["raw"])
            elif next_timeout:
                self.assertEqual(result["stopped_code"], "offline_result_unknown")
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(result["summary"]["proof_delivery"]["delivered_positive_windows"], 1)
                self.assertEqual(len(result["summary"]["dimensions"]), 7)
                self.assertTrue(all(row["cases"] == 1 and row["passed"] == 1 and not row["meets_gate"]
                                    for row in result["summary"]["dimensions"]))
                self.assertEqual(sum(row["kind"] == "provider_failure" for row in result["events"]), 1)
            elif malformed:
                self.assertEqual(result["stopped_code"], "offline_result_unknown")
                self.assertEqual(result["summary"]["dimensions"], [])
                failed, = [row["payload"] for row in result["events"] if row["kind"] == "case_failed"]
                extraction, = [row for row in failed["task"]["steps"] if row["name"] == "extract_memory"]
                self.assertEqual(extraction["attempt_count"], 1)
                self.assertEqual(extraction["status"], "retryable")
                self.assertEqual(sum(row["kind"] == "provider_response" for row in result["events"]), 2)
                self.assertEqual(failed["actual_traces"][0]["status"], "model_failed")
            elif empty:
                self.assertEqual(result["stopped_code"], "bounded_runtime_positive_delivery_missing")
                self.assertEqual(len(result["summary"]["dimensions"]), 7)
                self.assertTrue(all(row["cases"] == 1 and row["general_errors"] == 1 and not row["meets_gate"]
                                    for row in result["summary"]["dimensions"]))
            else:
                self.assertEqual(result["stopped_code"], "case_semantic_audit_unknown")
                self.assertEqual(result["summary"]["dimensions"], [])
                execution, = [row["payload"] for row in result["events"] if row["kind"] == "formal_task_execution"]
                candidate, = execution["memory_api"]["body"]["candidates"]
                self.assertEqual(candidate["status"], "pending")
                self.assertEqual(candidate["dimension_evidence"]["semantic_basis"]["version"], 3)
                self.assertTrue(candidate["dimension_evidence_source_current"])
            self.assertEqual(sum(row["kind"] == "formal_task_execution" for row in result["events"]), 0 if malformed else 1)
            self.assertFalse(result["quality_certified"])
            self.assertFalse("synthetic-private-reasoning" in json.dumps(result, ensure_ascii=False, default=str),
                             "评测副本不能从PG原始HTTP编码视图带入思考字段")


if __name__ == "__main__":
    unittest.main()
