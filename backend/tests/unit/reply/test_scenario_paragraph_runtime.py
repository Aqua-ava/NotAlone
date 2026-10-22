"""从公开回复运行时验证模型只能读取一段冻结场景正文。"""

import json
import unittest
from dataclasses import replace
from uuid import UUID

from langchain_core.messages import AIMessage

from notalone.memory.layered import LayeredMemorySnapshot, ScenarioDirectoryEntry
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget, select_material
from tests.unit.reply.test_input_budget_middleware import ControlledBudgetModel, make_profile
from tests.unit.reply.test_input_budget_runtime import ConfiguredRuntimeCounter, SCOPE, prepared_context, reply_output
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


SCENARIO_ID = UUID(int=71)
VERSION_ID = UUID(int=72)
MEMORY_ID = UUID(int=73)
PARAGRAPHS = [
    {"text": "过去曾共同参加课程；目前未核实。",
     "references": [{"memory_id": str(MEMORY_ID), "revision": 1}]},
    {"text": "只在周末安排合成课程。",
     "references": [{"memory_id": str(MEMORY_ID), "revision": 1}]},
]


class FrozenScenarioPort:
    """只替代资料读取边界，按冻结身份返回完整合成段落。"""

    def __init__(self, snapshot):
        self.snapshot = snapshot

    def read_scenario(self, snapshot, identifier, span):
        if snapshot != self.snapshot or identifier != SCENARIO_ID:
            raise PermissionError("合成读取必须使用原冻结身份。")
        return {"scenario_id": str(SCENARIO_ID), "version_id": str(VERSION_ID),
                "title": "合成课程", "hint": "课程与时间边界", "system_generated": True,
                "updated_at": "2026-10-22T00:00:00Z", "organization_generation": 4,
                "paragraph_range": list(span), "paragraphs": PARAGRAPHS[span[0]:span[1]]}


class ScenarioParagraphRuntimeTest(unittest.TestCase):
    def run_calls(self, arguments, *, characters=4000, calls=4):
        snapshot = LayeredMemorySnapshot(3, SCOPE, 2, 4,
            (ScenarioDirectoryEntry(SCENARIO_ID, VERSION_ID, "合成课程", "课程与时间边界", 2),),
            (MEMORY_ID,))
        prepared = prepared_context()
        prepared = replace(prepared, command=replace(prepared.command,
            content=replace(prepared.command.content, include_relationship_context=True)),
            layered_context=select_material(snapshot, LayeredReplyBudget(2, 2, 4000,
                scenario_read=ScenarioReadBudget(calls, 2, characters))), layered_status="loaded")
        responses = [AIMessage(content="", tool_calls=[{
            "id": f"synthetic-scenario-{index}", "name": "read_scenario", "args": args,
        }]) for index, args in enumerate(arguments)]
        model = ControlledBudgetModel(responses=[*responses, reply_output()])
        result = LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(SCOPE, 0),
            input_budget_profile=make_profile(100000), input_token_counter=ConfiguredRuntimeCounter(model),
            layered_memory=FrozenScenarioPort(snapshot)).generate(prepared)
        return result, model.seen_calls

    def test_model_reads_exactly_one_complete_indexed_paragraph(self):
        result, requests = self.run_calls([{"scenario_id": str(SCENARIO_ID), "paragraph_index": 1}])
        receipt, = result.layered_scenario_reads
        self.assertEqual(receipt["status"], "succeeded")
        self.assertEqual(receipt["paragraph_range"], [1, 2])
        self.assertEqual(receipt["document"]["paragraphs"], [PARAGRAPHS[1]])
        self.assertEqual(receipt["document"]["version_id"], str(VERSION_ID))
        schema = next(item["function"]["parameters"] for item in requests[0]["tools"]
                      if item["function"]["name"] == "read_scenario")
        self.assertEqual(set(schema["properties"]), {"scenario_id", "paragraph_index"})
        self.assertEqual(set(schema["required"]), {"scenario_id", "paragraph_index"})
        self.assertFalse(schema["additionalProperties"])
        sent = next(json.loads(message["content"]) for message in requests[1]["messages"]
                    if message.get("role") == "tool" and "paragraph_range" in message["content"])
        self.assertEqual(sent, receipt)

    def test_old_range_arguments_are_rejected_without_reading_a_partial_range(self):
        legacy = {"scenario_id": str(SCENARIO_ID), "paragraph_start": 0, "paragraph_end": 2}
        result, _ = self.run_calls([legacy, {**legacy, "paragraph_index": 0}])
        self.assertEqual([item["status"] for item in result.layered_scenario_reads],
                         ["invalid_arguments", "invalid_arguments"])
        self.assertTrue(all("document" not in item for item in result.layered_scenario_reads))
        self.assertEqual(result.layered_scenario_reads[-1]["budget"]["used_paragraphs"], 0)

    def test_raw_wrong_types_and_reserved_identity_arguments_are_not_silently_accepted(self):
        base = {"scenario_id": str(SCENARIO_ID), "paragraph_index": 0}
        arguments = [{**base, "paragraph_index": value} for value in (True, "0", None, -1, 2)]
        arguments.extend([{**base, "owner_id": str(SCOPE.owner_id)},
                          {**base, "runtime": {"scope": "other"}}])
        result, _ = self.run_calls(arguments, calls=8)
        self.assertEqual([item["status"] for item in result.layered_scenario_reads],
                         ["invalid_arguments"] * 3 + ["out_of_range"] * 2 + ["invalid_arguments"] * 2)
        self.assertTrue(all("document" not in item for item in result.layered_scenario_reads))
        self.assertEqual(result.layered_scenario_reads[-1]["budget"]["used_calls"], 7)

    def test_single_paragraph_still_obeys_duplicate_and_call_limits(self):
        argument = {"scenario_id": str(SCENARIO_ID), "paragraph_index": 0}
        result, _ = self.run_calls([argument, argument, argument], calls=2)
        self.assertEqual([item["status"] for item in result.layered_scenario_reads],
                         ["succeeded", "duplicate", "budget_exceeded"])
        self.assertEqual(result.layered_scenario_reads[-1]["budget"]["used_paragraphs"], 1)
        self.assertEqual(result.layered_scenario_reads[-1]["budget"]["used_calls"], 2)
        self.assertTrue(all("document" not in item for item in result.layered_scenario_reads[1:]))

    def test_single_paragraph_over_character_limit_is_rejected_without_truncation(self):
        result, _ = self.run_calls([{"scenario_id": str(SCENARIO_ID), "paragraph_index": 0}], characters=1)
        receipt, = result.layered_scenario_reads
        self.assertEqual(receipt["status"], "budget_exceeded")
        self.assertNotIn("document", receipt)
        self.assertEqual(receipt["budget"]["used_paragraphs"], 0)
        self.assertEqual(receipt["budget"]["used_characters"], 0)
