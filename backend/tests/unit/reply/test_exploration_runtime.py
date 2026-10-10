"""有界探索的实际模型边界：不绑定业务工具，未调用时不记出站。"""

from contextlib import contextmanager
from collections.abc import Sequence
from dataclasses import replace
from typing import Any
from unittest import TestCase
from uuid import uuid4

from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.exploration import ExplorationContext, ExplorationError, ExplorationInput
from notalone.scopes import ContactScope
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
from tests.input_budget_support import synthetic_budget_kwargs


class RecordingLedger:
    def __init__(self) -> None:
        self.entries: list[LedgerEntry] = []

    def record(self, entry: LedgerEntry) -> None:
        self.entries.append(entry)


class StoppedPriority:
    @contextmanager
    def foreground(self):
        raise RuntimeError("合成宿主已停止。")
        yield


def context() -> ExplorationContext:
    return ExplorationContext(
        scope=ContactScope(uuid4(), uuid4()),
        input=ExplorationInput(scene="initiate_conversation", purpose_hint="想了解合成近况"),
        evidence=(),
    )


def output() -> dict:
    return {
        "understanding": "用户想了解近况，具体目的仍需选择。",
        "ambiguities": ["不了解当前是否方便。"],
        "citation_ids": [],
        "options": [
            {"intent": "询问近况", "label": "了解近况", "reason": "适用于希望了解当前情况时。",
             "citation_ids": [], "recommended": False, "pause": False},
            {"intent": "本次暂不联系", "label": "暂不联系", "reason": "适用于尚未决定是否开口时。",
             "citation_ids": [], "recommended": False, "pause": True},
        ],
        "question": None,
        "current_step": "先明确本次主动目的。",
        "tradeoffs": [],
    }


class ToolSchemaModel(ToolCallingFakeModel):
    bound_schemas: list[dict] = []

    def bind_tools(self, tools: Sequence[Any], *, tool_choice: str | None = None, **kwargs: Any) -> Runnable:
        self.bound_schemas = list(tools)
        return super().bind_tools(tools, tool_choice=tool_choice, **kwargs)


def model(value: dict) -> ToolSchemaModel:
    return ToolSchemaModel(responses=[AIMessage(content="", tool_calls=[{
        "name": "ExplorationOutput", "args": value, "id": "synthetic-exploration-output",
    }])])


def configured_runtime(fake: ToolSchemaModel, **kwargs) -> LangChainExplorationRuntime:
    return LangChainExplorationRuntime(model=fake, **synthetic_budget_kwargs(fake), **kwargs)


class ExplorationRuntimeTest(TestCase):
    def test_stopped_host_does_not_call_model_or_record_outbound(self) -> None:
        fake, ledger = model(output()), RecordingLedger()
        runtime = configured_runtime(fake, priority=StoppedPriority(), ledger=ledger)
        with self.assertRaises(ExplorationError):
            runtime.explore(context())
        self.assertEqual(fake.seen_calls, [])
        self.assertEqual(ledger.entries, [])

    def test_pause_is_an_unselected_option_and_only_output_tool_is_bound(self) -> None:
        fake, ledger = model(output()), RecordingLedger()
        result = configured_runtime(fake, ledger=ledger).explore(context())
        self.assertTrue(result["options"][1]["pause"])
        self.assertNotIn("selected_intent", result)
        self.assertEqual([schema["name"] for schema in fake.bound_schemas], ["ExplorationOutput"])
        self.assertEqual(len(fake.seen_calls), 1)
        self.assertEqual(len(ledger.entries), 1)
        self.assertIs(ledger.entries[0].outcome, LedgerOutcome.SUCCEEDED)

    def test_recommendation_without_evidence_is_rejected_after_one_call(self) -> None:
        value = output()
        value["options"][0]["recommended"] = True
        fake, ledger = model(value), RecordingLedger()
        with self.assertRaises(ExplorationError):
            configured_runtime(fake, ledger=ledger).explore(context())
        self.assertEqual(len(fake.seen_calls), 1)
        self.assertEqual(len(ledger.entries), 1)
        self.assertIs(ledger.entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION)

    def test_refresh_cannot_return_the_same_intent_group(self) -> None:
        value = output()
        previous = tuple(option["intent"] for option in value["options"])
        fake = model(value)
        with self.assertRaises(ExplorationError):
            configured_runtime(fake, ledger=RecordingLedger()).explore(replace(context(), previous_intents=previous))
        self.assertEqual(len(fake.seen_calls), 1)

    def test_refresh_cannot_hide_repeated_intents_with_surrounding_whitespace(self) -> None:
        value = output()
        previous = tuple("  " + option["intent"] + "\n" for option in value["options"])
        with self.assertRaises(ExplorationError):
            configured_runtime(model(value), ledger=RecordingLedger()).explore(
                replace(context(), previous_intents=previous))

    def test_outbound_ledger_is_required(self) -> None:
        fake = model(output())
        with self.assertRaises((TypeError, ValueError)):
            LangChainExplorationRuntime(model=fake)
        with self.assertRaises((TypeError, ValueError)):
            configured_runtime(fake, ledger=None)

    def test_unknown_evidence_does_not_become_a_recommendation(self) -> None:
        value = output()
        value["citation_ids"] = [str(uuid4())]
        with self.assertRaises(ExplorationError):
            configured_runtime(model(value), ledger=RecordingLedger()).explore(context())

    def test_key_question_is_a_distinct_result_without_candidate_text(self) -> None:
        value = output()
        value["options"] = []
        value["question"] = {"text": "你是否已经决定承担这项合成责任？", "impact": "commitment"}
        result = configured_runtime(model(value), ledger=RecordingLedger()).explore(context())
        self.assertEqual(result["options"], [])
        self.assertEqual(result["question"]["impact"], "commitment")
        self.assertNotIn("candidates", result)

    def test_questions_for_ordinary_details_are_not_a_valid_output_kind(self) -> None:
        value = output()
        value["question"] = {"text": "具体时间是什么？", "impact": "schedule"}
        with self.assertRaises(ExplorationError):
            configured_runtime(model(value), ledger=RecordingLedger()).explore(context())
