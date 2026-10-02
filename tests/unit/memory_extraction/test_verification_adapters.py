"""来源核验 adapter 的真实模型输入与无正文台账测试。"""

from __future__ import annotations

import json
import unittest
import traceback
from dataclasses import fields, replace
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.verification_adapters import (
    LangChainSourceVerificationRuntime,
)
from tests.unit.memory_extraction.test_adapters import ExplicitToolChoiceModel
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import verification_result
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


def structured_verification(results: tuple[dict, ...]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{
            "name": "SourceVerificationOutput", "args": {"results": list(results)},
            "id": "verification-1",
        }],
        usage_metadata={"input_tokens": 30, "output_tokens": 12, "total_tokens": 42},
        response_metadata={"model_name": "synthetic-actual-model"},
    )


class SourceVerificationAdapterTest(unittest.TestCase):
    """只在模型 I/O 边界使用 fake，不调用外部服务。"""

    def test_explicit_result_tool_returns_verdict_when_auto_would_return_only_text(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        result = verification_result(evidence=((message_id, window.messages[0].text),))
        model = ExplicitToolChoiceModel(
            responses=[structured_verification((result,))],
            required_tool_name="SourceVerificationOutput",
        )

        output = LangChainSourceVerificationRuntime(model=model).verify(
            window=window, facts=facts,
        )

        self.assertEqual(output, (result,))

    def test_verification_uses_same_bounded_window_and_records_actual_usage(self):
        target, context = uuid4(), uuid4()
        original = _window((context, target))
        window = replace(
            original,
            messages=(
                replace(original.messages[0], text="周末打球。", occurred_at=None),
                replace(original.messages[1], text="我不喝酒。"),
            ),
            target_message_ids=(target,),
        )
        facts = ExtractionFlow(runtime=RecordingRuntime((
            _payload(target, text="联系人不喝酒"),
        ))).run(window).accepted
        result = verification_result(evidence=((target, "不喝酒"),))
        model = ToolCallingFakeModel(responses=[structured_verification((result,))])
        ledger = InMemoryOutboundLedger()

        output = LangChainSourceVerificationRuntime(
            model=model, ledger=ledger, provider="synthetic-provider",
        ).verify(window=window, facts=facts)

        self.assertEqual(output, (result,))
        request = json.loads(model.seen_calls[0][1].content)
        self.assertEqual(len(request["messages"]), 2)
        self.assertEqual(request["messages"][0]["role"], "context")
        self.assertEqual(request["messages"][0]["occurred_at"], "unknown")
        self.assertEqual(request["messages"][1]["role"], "target")
        self.assertEqual(request["candidates"][0]["candidate_index"], 0)
        self.assertEqual(request["candidates"][0]["text"], "联系人不喝酒")
        self.assertEqual(request["candidates"][0]["source_message_ids"], [str(target)])
        entry = ledger.list_by_owner(window.owner_id)[0]
        self.assertEqual(entry.contact_id, window.contact_id)
        self.assertEqual(entry.provider, "synthetic-provider")
        self.assertEqual(entry.model_name, "synthetic-actual-model")
        self.assertEqual(entry.input_tokens, 30)
        self.assertEqual(entry.output_tokens, 12)
        self.assertEqual(entry.outcome, LedgerOutcome.SUCCEEDED)
        self.assertNotIn("text", {field.name for field in fields(entry)})
        self.assertNotIn("不喝酒", repr(entry))

    def test_candidate_self_assessment_is_not_exposed_as_source_evidence(self):
        message_id = uuid4()
        window = _window((message_id,))
        base = ExtractionFlow(runtime=RecordingRuntime((_payload(message_id),))).run(window).accepted[0]
        facts = (replace(
            base, confidence=0.99, risk_flags=("low",),
            alternatives=("模型自述的备选解释",),
            interpretation_reason="模型自述保证正确的理由",
        ),)
        result = verification_result(evidence=((message_id, window.messages[0].text),))
        model = ToolCallingFakeModel(responses=[structured_verification((result,))])

        output = LangChainSourceVerificationRuntime(model=model).verify(window=window, facts=facts)

        self.assertEqual(output, (result,))
        request = json.loads(model.seen_calls[0][1].content)
        candidate = request["candidates"][0]
        for field in ("confidence", "risk_flags", "alternatives", "interpretation_reason"):
            self.assertNotIn(field, candidate)
        self.assertEqual(candidate["subject"], base.subject.value)
        self.assertEqual(candidate["speech_act"], base.speech_act.value)
        self.assertEqual(candidate["source_message_ids"], [str(message_id)])

    def test_uncertain_and_unsupported_can_return_empty_evidence(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        for verdict in ("uncertain", "unsupported"):
            with self.subTest(verdict=verdict):
                result = verification_result(
                    verdict=verdict, issues=("meaning",), evidence=(),
                )
                model = ExplicitToolChoiceModel(
                    responses=[structured_verification((result,))],
                    required_tool_name="SourceVerificationOutput",
                )

                output = LangChainSourceVerificationRuntime(model=model).verify(
                    window=window, facts=facts,
                )

                self.assertEqual(output, (result,))

    def test_window_context_cannot_be_evidence_outside_candidate_sources(self):
        target, context = uuid4(), uuid4()
        window = replace(_window((context, target)), target_message_ids=(target,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(target),)),
        ).run(window).accepted
        result = verification_result(
            verdict="uncertain", issues=("meaning",),
            evidence=((context, window.messages[0].text),),
        )
        model = ExplicitToolChoiceModel(
            responses=[structured_verification((result,))],
            required_tool_name="SourceVerificationOutput",
        )

        with self.assertRaises(ExtractionInvalidOutputError):
            LangChainSourceVerificationRuntime(model=model).verify(
                window=window, facts=facts,
            )

    def test_unavailable_model_records_failure_without_private_exception(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        ledger = InMemoryOutboundLedger()

        class RaisingModel:
            model_name = "synthetic-unavailable-model"

            def bind_tools(self, tools, **kwargs):
                raise RuntimeError("私人聊天正文可能在供应商异常中回显")

        runtime = LangChainSourceVerificationRuntime(model=RaisingModel(), ledger=ledger)

        with self.assertRaises(ExtractionRuntimeError) as caught:
            runtime.verify(window=window, facts=facts)

        rendered = "".join(traceback.format_exception(caught.exception))
        self.assertNotIn("私人聊天正文", rendered)
        entries = ledger.list_by_owner(window.owner_id)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].outcome, LedgerOutcome.RUN_FAILED)
        self.assertEqual(entries[0].model_name, "synthetic-unavailable-model")
        self.assertIsNone(entries[0].input_tokens)

    def test_invalid_structured_output_records_validation_failure_with_usage(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        response = structured_verification((verification_result(
            evidence=((message_id, "供应商虚构的私人原文片段"),),
        ),))
        model = ToolCallingFakeModel(responses=[response])
        ledger = InMemoryOutboundLedger()
        runtime = LangChainSourceVerificationRuntime(model=model, ledger=ledger)

        with self.assertRaises(ExtractionInvalidOutputError) as caught:
            runtime.verify(window=window, facts=facts)

        self.assertNotIn("私人原文", str(caught.exception))
        entries = ledger.list_by_owner(window.owner_id)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION)
        self.assertEqual(entries[0].input_tokens, 30)
        self.assertEqual(entries[0].output_tokens, 12)

    def test_empty_or_over_budget_input_does_not_call_model_or_create_call_ledger(self):
        message_id = uuid4()
        window = _window((message_id,))
        fact = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted[0]
        for count in (0, 61):
            with self.subTest(count=count):
                model = ToolCallingFakeModel(responses=[structured_verification(())])
                ledger = InMemoryOutboundLedger()
                runtime = LangChainSourceVerificationRuntime(model=model, ledger=ledger)
                if count:
                    with self.assertRaises(ExtractionInvalidOutputError):
                        runtime.verify(window=window, facts=(fact,) * count)
                else:
                    self.assertEqual(runtime.verify(window=window, facts=()), ())
                self.assertEqual(model.seen_calls, [])
                self.assertEqual(ledger.list_by_owner(window.owner_id), ())

    def test_missing_wrong_or_multiple_tool_results_are_classified_as_invalid(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        valid_call = {
            "name": "SourceVerificationOutput", "args": {"results": []},
            "id": "verification-1",
        }
        responses = (
            AIMessage(content="模型正文不应复制到错误或台账"),
            AIMessage(content="", tool_calls=[{**valid_call, "name": "OtherOutput"}]),
            AIMessage(content="", tool_calls=[{**valid_call, "args": {"results": "bad"}}]),
            AIMessage(content="", tool_calls=[{**valid_call, "args": {"results": ["bad"]}}]),
            AIMessage(content="", tool_calls=[valid_call, {**valid_call, "id": "verification-2"}]),
        )
        for response in responses:
            with self.subTest(response_kind=response.tool_calls):
                ledger = InMemoryOutboundLedger()
                runtime = LangChainSourceVerificationRuntime(
                    model=ToolCallingFakeModel(responses=[response]), ledger=ledger,
                )

                with self.assertRaises(ExtractionInvalidOutputError):
                    runtime.verify(window=window, facts=facts)

                entries = ledger.list_by_owner(window.owner_id)
                self.assertEqual(len(entries), 1)
                self.assertEqual(entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION)


if __name__ == "__main__":
    unittest.main()
