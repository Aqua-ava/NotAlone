"""合成输入上的记忆方法复刻运行时公开边界测试。"""

from __future__ import annotations

import json
import traceback
import unittest
from dataclasses import replace
from datetime import datetime
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.errors import ExtractionInvalidOutputError, ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.scopes import ContactScope
from notalone.memory_extraction.replica_adapters import (
    NarrativeExtractionRuntime,
    TemporalRefinementRuntime,
)
from tests.unit.memory_extraction.test_adapters import _structured_response
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


def _response(name: str, args: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=[{
        "name": name, "args": args, "id": "synthetic-replica-call",
    }])


def _narrative(message_id, *, text="联系人不喝酒。", quote="不喝酒") -> dict:
    return {
        "text": text,
        "source_message_ids": [str(message_id)],
        "evidence": [{"message_id": str(message_id), "quote": quote}],
    }


def _time_result(message_id, **changes) -> dict:
    result = {
        "candidate_index": 0, "status": "explicit",
        "valid_at": "2026-10-05T00:00:00+08:00", "invalid_at": None,
        "evidence": [{"message_id": str(message_id), "quote": "合成消息"}],
    }
    result.update(changes)
    return result


class ReplicaAdapterTest(unittest.TestCase):
    def test_narrative_extraction_keeps_original_source_for_final_candidates(self):
        target = uuid4()
        original = _window((target,))
        window = replace(original, messages=(
            replace(original.messages[0], text="我不喝酒。"),
        ))
        payload = _payload(target, text="联系人不喝酒。")
        model = ToolCallingFakeModel(responses=[
            _response("MemoryNarrativeOutput", {
                "narratives": [_narrative(target)],
            }),
            _structured_response((payload,)),
        ])

        output = NarrativeExtractionRuntime(model=model).extract(window)

        self.assertEqual(output, (payload,))
        final_input = model.seen_calls[-1][1].content
        self.assertIn("我不喝酒。", final_input)
        self.assertIn(str(target), final_input)
        self.assertIn("不可信", final_input)

    def test_narrative_without_real_target_evidence_stops_before_extraction(self):
        context, target = uuid4(), uuid4()
        original = _window((context, target))
        window = replace(
            original,
            messages=(
                replace(original.messages[0], text="我不喝酒。"),
                replace(original.messages[1], text="这周去打球。"),
            ), target_message_ids=(target,),
        )
        invalid_units = (
            _narrative(target, quote="输入中不存在的原话"),
            _narrative(uuid4(), quote="不喝酒"),
            _narrative(context, quote="不喝酒"),
        )
        for unit in invalid_units:
            with self.subTest(unit=unit):
                model = ToolCallingFakeModel(responses=[
                    _response("MemoryNarrativeOutput", {"narratives": [unit]}),
                    _structured_response((_payload(target),)),
                ])

                with self.assertRaises(ExtractionInvalidOutputError):
                    NarrativeExtractionRuntime(model=model).extract(window)

                self.assertEqual(len(model.seen_calls), 1)

    def test_time_refinement_repairs_fields_without_rewriting_the_claim(self):
        target = uuid4()
        original = _window((target,))
        window = replace(original, messages=(replace(
            original.messages[0], text="我下周一到周三在北京出差。",
            occurred_at=datetime.fromisoformat("2026-10-02T09:00:00+08:00"),
        ),))
        payload = _payload(target, text="联系人下周一到周三在北京出差。")
        payload["risk_flags"] = ["synthetic:existing"]
        model = ToolCallingFakeModel(responses=[_response("MemoryTemporalOutput", {
            "results": [{
                "candidate_index": 0, "status": "explicit",
                "valid_at": "2026-10-05T00:00:00+08:00",
                "invalid_at": "2026-10-08T00:00:00+08:00",
                "evidence": [{"message_id": str(target), "quote": "下周一到周三"}],
            }],
        })])

        output = TemporalRefinementRuntime(
            runtime=RecordingRuntime((payload,)), model=model,
        ).extract(window)

        self.assertEqual(output[0]["valid_at"], "2026-10-05T00:00:00+08:00")
        self.assertEqual(output[0]["invalid_at"], "2026-10-08T00:00:00+08:00")
        self.assertEqual(
            {key: value for key, value in output[0].items()
             if key not in {"valid_at", "invalid_at"}},
            {key: value for key, value in payload.items()
             if key not in {"valid_at", "invalid_at"}},
        )
        self.assertIsNone(payload["valid_at"])
        request = json.loads(model.seen_calls[0][1].content)
        self.assertEqual(request["candidates"][0]["messages"][0]["occurred_at"],
                         "2026-10-02T09:00:00+08:00")

    def test_time_refinement_requires_exact_candidate_coverage(self):
        target = uuid4()
        result = _time_result(target)
        bad_batches = (
            [], [result, result],
            [{**result, "candidate_index": 1}],
            [{**result, "candidate_index": True}],
        )
        for batch in bad_batches:
            with self.subTest(batch=batch):
                model = ToolCallingFakeModel(responses=[_response(
                    "MemoryTemporalOutput", {"results": batch},
                )])
                runtime = TemporalRefinementRuntime(
                    runtime=RecordingRuntime((_payload(target),)), model=model,
                )

                with self.assertRaises(ExtractionInvalidOutputError):
                    runtime.extract(_window((target,)))

    def test_time_refinement_rejects_unsupported_or_invalid_time_fields(self):
        target = uuid4()
        bad_results = (
            _time_result(target, valid_at="2026-10-05T00:00:00"),
            _time_result(target, valid_at="not-a-date"),
            _time_result(target, invalid_at="2026-10-04T00:00:00+08:00"),
            _time_result(target, valid_at=None),
            _time_result(target, status="unknown"),
            _time_result(target, status="anything"),
            _time_result(target, evidence=[]),
            _time_result(target, evidence=[{"message_id": str(target), "quote": "假片段"}]),
            _time_result(target, evidence=[{"message_id": str(uuid4()), "quote": "合成消息"}]),
        )
        for result in bad_results:
            with self.subTest(result=result):
                model = ToolCallingFakeModel(responses=[_response(
                    "MemoryTemporalOutput", {"results": [result]},
                )])

                with self.assertRaises(ExtractionInvalidOutputError):
                    TemporalRefinementRuntime(
                        runtime=RecordingRuntime((_payload(target),)), model=model,
                    ).extract(_window((target,)))

    def test_unknown_and_conflict_clear_dates_with_conflict_safely_downgraded(self):
        first, second = uuid4(), uuid4()
        payloads = (
            _payload(first, valid_at="2026-10-05T00:00:00+08:00"),
            _payload(second, risk_flags=["synthetic:existing"],
                     invalid_at="2026-10-08T00:00:00+08:00"),
        )
        model = ToolCallingFakeModel(responses=[_response("MemoryTemporalOutput", {
            "results": [
                _time_result(second, candidate_index=1, status="conflict", valid_at=None),
                _time_result(first, status="unknown", valid_at=None, evidence=[]),
            ],
        })])

        output = TemporalRefinementRuntime(
            runtime=RecordingRuntime(payloads), model=model,
        ).extract(_window((first, second)))

        self.assertIsNone(output[0]["valid_at"])
        self.assertEqual(output[0]["risk_flags"], [])
        self.assertIsNone(output[1]["invalid_at"])
        self.assertEqual(output[1]["risk_flags"], ["synthetic:existing", "semantic:time"])
        self.assertEqual(payloads[1]["risk_flags"], ["synthetic:existing"])
        request = json.loads(model.seen_calls[0][1].content)
        self.assertEqual([item["message_id"] for item in request["candidates"][0]["messages"]],
                         [str(first)])
        self.assertEqual([item["message_id"] for item in request["candidates"][1]["messages"]],
                         [str(second)])

    def test_model_failures_are_visible_without_leaking_exception_text(self):
        class RaisingModel:
            def bind_tools(self, tools):
                raise RuntimeError("供应商异常回显原始聊天内容")

        target = uuid4()
        window = _window((target,))
        runtimes = (
            NarrativeExtractionRuntime(model=RaisingModel()),
            TemporalRefinementRuntime(runtime=RecordingRuntime((_payload(target),)),
                                      model=RaisingModel()),
        )
        for runtime in runtimes:
            with self.subTest(runtime=type(runtime).__name__):
                with self.assertRaises(ExtractionRuntimeError) as caught:
                    runtime.extract(window)
                self.assertNotIn("原始聊天", "".join(traceback.format_exception(caught.exception)))
                outcome = ExtractionFlow(runtime=runtime).run(window)
                self.assertEqual(outcome.failure_kind.value, "unavailable")
                self.assertEqual(outcome.accepted, ())

    def test_empty_narratives_and_empty_candidates_remain_valid(self):
        target = uuid4()
        model = ToolCallingFakeModel(responses=[
            _response("MemoryNarrativeOutput", {"narratives": []}),
            _structured_response(()),
        ])
        self.assertEqual(NarrativeExtractionRuntime(model=model).extract(_window((target,))), ())
        unused_model = ToolCallingFakeModel(responses=[])
        self.assertEqual(TemporalRefinementRuntime(
            runtime=RecordingRuntime(()), model=unused_model,
        ).extract(_window((target,))), ())
        self.assertEqual(unused_model.seen_calls, [])

    def test_over_budget_stage_output_and_input_fail_without_truncation(self):
        target = uuid4()
        window = replace(_window((target,)), messages=(replace(
            _window((target,)).messages[0], text="我不喝酒。",
        ),))
        model = ToolCallingFakeModel(responses=[_response("MemoryNarrativeOutput", {
            "narratives": [_narrative(target)] * 61,
        })])
        with self.assertRaises(ExtractionInvalidOutputError):
            NarrativeExtractionRuntime(model=model).extract(window)
        unused_model = ToolCallingFakeModel(responses=[])
        with self.assertRaises(ExtractionInvalidOutputError):
            TemporalRefinementRuntime(runtime=RecordingRuntime((_payload(target),) * 61),
                                      model=unused_model).extract(window)
        self.assertEqual(unused_model.seen_calls, [])

    def test_time_refinement_does_not_expand_source_scope_to_unrelated_messages(self):
        context, target = uuid4(), uuid4()
        result = _time_result(context)
        model = ToolCallingFakeModel(responses=[_response("MemoryTemporalOutput", {
            "results": [result],
        })])
        with self.assertRaises(ExtractionInvalidOutputError):
            TemporalRefinementRuntime(runtime=RecordingRuntime((_payload(target),)),
                                      model=model).extract(_window((context, target)))

    def test_conflict_stays_pending_through_existing_source_and_adoption_gates(self):
        target = uuid4()
        window = _window((target,))
        model = ToolCallingFakeModel(responses=[_response("MemoryTemporalOutput", {
            "results": [_time_result(target, status="conflict", valid_at=None)],
        })])
        outcome = ExtractionFlow(
            runtime=TemporalRefinementRuntime(
                runtime=RecordingRuntime((_payload(target),)), model=model,
            ), verification_runtime=SyntheticSupportingVerifier(),
        ).run(window)

        self.assertIsNone(outcome.failure_reason)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)
        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertIn("semantic:time", store.list_pending_candidates(scope)[0].risk_flags)


if __name__ == "__main__":
    unittest.main()
