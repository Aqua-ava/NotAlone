"""正式任务评测桥的隔离PG与实际SDK控制，不访问真实模型。"""

from dataclasses import replace
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_formal_task import evaluate_task
from notalone.memory_extraction.evaluation_cases import EvaluationCase
from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.source_proof import bounded_source_occurred_at
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.tasks.models import ExtractionRuntimeMode
from tests.integration.memory_extraction import test_evaluation_wire_contract as wire_contract
from tests.integration.tasks import test_bounded_runtime_acceptance as acceptance
from tests.integration.tasks.test_bounded_runtime_acceptance import (
    completed_question_proposal, direct_proposal, label,
)
from tests.unit.memory_extraction import test_bounded_runtime_proof as sdk_fixture


class BoundedTaskEvaluationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        acceptance.BoundedRuntimeAcceptanceTest.setUpClass.__func__(cls)

    @classmethod
    def drop_database(cls):
        acceptance.BoundedRuntimeAcceptanceTest.drop_database.__func__(cls)

    def setUp(self):
        acceptance.BoundedRuntimeAcceptanceTest.setUp(self)

    def source(self, *, imported=False, texts=("我刚到家。",)):
        if imported:
            acceptance.BoundedRuntimeAcceptanceTest.import_source(self, ("你已到学校了吗？", "我已经到了。"), ("self", "contact"))
        else:
            acceptance.BoundedRuntimeAcceptanceTest.observe_source(self, texts)
        PostgresBackgroundTaskRepository(self.database_url).configure_extraction_runtime(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            task_id=self.task_id,
            config=runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1),
        )
        return ExtractionWindow(
            self.scope.owner_id, self.scope.contact_id,
            tuple(replace(row, occurred_at=bounded_source_occurred_at(row)) for row in self.messages),
            target_message_ids=tuple(row.message_id for row in self.messages),
        )

    def sdk(self, *, invalid_proof=False, empty=False, labels=None, proposal=None, before_verification=None):
        wire = wire_contract.EvaluationWireContractTest("runTest")
        wire.setUp()
        self.addCleanup(wire.doCleanups)
        model = sdk_fixture.BoundedRuntimeSdkTest.model(wire, tool_name="GroundedMemoryLabels", arguments={})
        self.requests = []

        def handle(request):
            body = json.loads(request.content)
            name = body["tools"][0]["function"]["name"]
            self.requests.append(name)
            if name == "GroundedMemoryLabels":
                payload = {"units": {key: {field: value for field, value in row.items() if field != "event"}
                    for key, row in (labels or {"0:0": label("not_memory" if empty else "event")}).items()}}
            else:
                if before_verification is not None:
                    before_verification()
                actual = json.loads(body["messages"][1]["content"])
                candidate, = actual["candidates"]
                proof = (proposal or direct_proposal("BR_AUTHOR_ARRIVAL_V1", "direct_quote", "我刚到家。"))(actual)
                if invalid_proof:
                    proof["version"] = True
                payload = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": message["message_id"], "quote": message["text"]}
                                 for message in actual["messages"] if message["message_id"] in candidate["source_message_ids"]],
                    "proof": proof}]}
            return httpx.Response(200, request=request, json={
                "id": "synthetic-task-evaluation", "object": "chat.completion", "created": 1,
                "model": "synthetic-model", "choices": [{"index": 0, "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": "", "tool_calls": [{
                        "id": "synthetic-call", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(payload, ensure_ascii=False)},
                    }]}}],
            })

        model.root_client._client._transport.handler = handle
        return GroundedV2ExtractionRuntime(model=model), LangChainSourceVerificationRuntime(model=model)

    def test_observed_task_scores_the_committed_trace_without_running_a_second_flow(self):
        window = self.source()
        runtime, verifier = self.sdk()
        case = EvaluationCase("正式任务到达", "subject", (("contact", "我刚到家。"),), (0,), "auto",
                              expect_subject="contact")
        evaluated = evaluate_task(case, window, runtime, database_url=self.database_url,
                                  task_id=self.task_id, verification_runtime=verifier)
        self.assertTrue(evaluated.result.passed)
        self.assertEqual(evaluated.window, window)
        self.assertEqual(evaluated.task.current_step.value, "index")
        self.assertEqual([row.step_name.value for row in evaluated.worker_results], ["extract_memory"])
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])
        item, = acceptance.BoundedRuntimeAcceptanceTest.pending(self)
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["dimension_evidence"]["version"], 4)
        self.assertTrue(item["dimension_evidence_source_current"])
        adoption, = [row["payload"] for row in evaluated.trace["events"]
                     if row["stage"] == "pragmatics" and row["payload"].get("phase") == "adoption"]
        self.assertEqual(evaluated.result.facts[0]["text"], adoption["input"]["text"])
        self.assertEqual(evaluated.result.facts[0]["risk_flags"], adoption["input"]["risk_flags"])
        self.assertEqual(len([row for row in evaluated.trace["events"] if row["stage"] == "model_request"]), 2)

    def test_evaluation_keeps_empty_release_when_external_environment_disables_dimension_gate(self):
        window = self.source()
        runtime, verifier = self.sdk()
        case = EvaluationCase("隔离任务空放行", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        with patch.dict(os.environ, {"NOTALONE_MEMORY_DIMENSION_GATE": "0"}):
            evaluated = evaluate_task(case, window, runtime, database_url=self.database_url,
                                      task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(evaluated.result.actual, "auto")  # 评测仍记录原三门的假想去向。
        item, = acceptance.BoundedRuntimeAcceptanceTest.pending(self)
        self.assertEqual(item["status"], "pending")
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_import_task_advances_parse_and_normalize_then_extracts_only_once(self):
        window = self.source(imported=True)
        runtime, verifier = self.sdk(labels={"0:0": label("question", "self"), "1:0": label("state", dependency="0:0")},
                                     proposal=completed_question_proposal)
        case = EvaluationCase("正式任务问答", "reference", (("self", "你已到学校了吗？"), ("contact", "我已经到了。")),
                              (0, 1), "auto", expect_subject="contact")
        evaluated = evaluate_task(case, window, runtime, database_url=self.database_url,
                                  task_id=self.task_id, verification_runtime=verifier)
        self.assertTrue(evaluated.result.passed)
        self.assertEqual([row.step_name.value for row in evaluated.worker_results], ["parse", "normalize", "extract_memory"])
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])
        self.assertEqual(evaluated.trace["status"], "succeeded")

    def test_legal_empty_extraction_returns_matcher_general_without_inventing_verification(self):
        window = self.source()
        runtime, verifier = self.sdk(empty=True)
        case = EvaluationCase("缺失到达", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        evaluated = evaluate_task(case, window, runtime, database_url=self.database_url,
                                  task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(evaluated.result.actual, "none")
        self.assertEqual(evaluated.result.facts, ())
        self.assertEqual(evaluated.result.error_kind, "general")
        self.assertEqual(self.requests, ["GroundedMemoryLabels"])
        self.assertEqual(acceptance.BoundedRuntimeAcceptanceTest.pending(self), [])

    def test_invalid_proof_stops_after_first_extract_attempt_and_preserves_failed_trace(self):
        window = self.source()
        runtime, verifier = self.sdk(invalid_proof=True)
        case = EvaluationCase("非法证明", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        with self.assertRaisesRegex(ValueError, "首次步骤失败"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        task = PostgresBackgroundTaskRepository(self.database_url).get_task(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, task_id=self.task_id)
        extraction, = [row for row in task.steps if row.name.value == "extract_memory"]
        self.assertEqual((extraction.attempt_count, extraction.status.value), (1, "retryable"))
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])
        self.assertEqual(acceptance.BoundedRuntimeAcceptanceTest.pending(self), [])
        from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
        traces = PostgresExtractionTraceStore(self.database_url)
        batch, = traces.list_batches(self.scope)
        self.assertEqual(traces.get_batch(self.scope, batch["trace_id"])["status"], "model_failed")
        with self.assertRaisesRegex(ValueError, "首次提取"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])

    def test_wrong_config_and_changed_frozen_window_reject_before_any_model_request(self):
        window = self.source()
        runtime, verifier = self.sdk()
        case = EvaluationCase("冻结输入", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        altered = replace(window, messages=(replace(window.messages[0], text="我刚刚到家。"),))
        with self.assertRaisesRegex(ValueError, "冻结输入"):
            evaluate_task(case, altered, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        import psycopg
        from psycopg.types.json import Jsonb
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task SET extraction_runtime_config=%s WHERE id=%s",
                               (Jsonb({"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": "f" * 64}), self.task_id))
        with self.assertRaisesRegex(ValueError, "当前有限配置"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(self.requests, [])

    def test_five_message_frozen_window_is_rejected_before_the_first_model_request(self):
        texts = ("背景甲。", "背景乙。", "背景丙。", "背景丁。", "我刚到家。")
        window = self.source(texts=texts)
        runtime, verifier = self.sdk()
        case = EvaluationCase("范围超限", "subject", tuple(("contact", text) for text in texts),
                              tuple(range(5)), "auto")
        with self.assertRaisesRegex(ValueError, "有限范围"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(self.requests, [])

    def test_missing_actual_draft_is_a_hard_failure_instead_of_a_reconstructed_matcher_result(self):
        window = self.source()

        def remove_draft():
            import psycopg
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.memory_extraction_trace_event SET payload=payload-'draft' "
                    "WHERE owner_id=%s AND contact_id=%s AND stage='grounded_draft'",
                    (self.scope.owner_id, self.scope.contact_id),
                )

        runtime, verifier = self.sdk(before_verification=remove_draft)
        case = EvaluationCase("追踪缺损", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        with self.assertRaisesRegex(ValueError, "草稿"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])

    def test_duplicate_actual_draft_is_not_selected_arbitrarily(self):
        window = self.source()

        def duplicate_draft():
            import psycopg
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "INSERT INTO public.memory_extraction_trace_event "
                    "(event_id,trace_id,owner_id,contact_id,position,stage,payload,candidate_trace_id,call_id) "
                    "SELECT %s,original.trace_id,original.owner_id,original.contact_id, "
                    "(SELECT max(position)+1 FROM public.memory_extraction_trace_event AS current "
                    " WHERE current.trace_id=original.trace_id),stage,payload,candidate_trace_id,call_id "
                    "FROM public.memory_extraction_trace_event AS original "
                    "WHERE owner_id=%s AND contact_id=%s AND stage='grounded_draft'",
                    (uuid4(), self.scope.owner_id, self.scope.contact_id),
                )

        runtime, verifier = self.sdk(before_verification=duplicate_draft)
        case = EvaluationCase("追踪重复", "subject", (("contact", "我刚到家。"),), (0,), "auto")
        with self.assertRaisesRegex(ValueError, "唯一必需阶段"):
            evaluate_task(case, window, runtime, database_url=self.database_url,
                          task_id=self.task_id, verification_runtime=verifier)
        self.assertEqual(self.requests, ["GroundedMemoryLabels", "SourceVerificationOutput"])


if __name__ == "__main__":
    unittest.main()
