"""正式回复运行时的预算纵切；保留真实图与守卫，只使用合成模型。"""

from __future__ import annotations

import copy
import json
import unittest
from dataclasses import replace
from uuid import UUID

from langchain_core.messages import AIMessage

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetDecision,
    InputBudgetRequest,
    InputBudgetUnavailableError,
    InputTokenMeasurement,
)
from notalone.reply.interface import GenerateReply, NoSkill, RewriteDraft
from notalone.scopes import ContactScope
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import ScriptedCoreModel
from tests.unit.reply.test_input_budget_middleware import (
    ControlledBudgetModel,
    SyntheticProtocolCounter,
    make_profile,
)
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


SCOPE = ContactScope(
    UUID("00000000-0000-0000-0000-000000000001"),
    UUID("00000000-0000-0000-0000-000000000002"),
)
BINDING_ID = UUID("00000000-0000-0000-0000-000000000003")
EVIDENCE_ID = UUID("00000000-0000-0000-0000-000000000004")
REQUEST_ID = UUID("00000000-0000-0000-0000-000000000005")
REQUEST_KEY = UUID("00000000-0000-0000-0000-000000000006")


def prepared_context() -> ReplyContext:
    draft = "合成原句：今晚不参加，祝活动顺利。"
    command = GenerateReply(
        idempotency_key=REQUEST_KEY,
        scope=SCOPE,
        conversation_binding_id=BINDING_ID,
        content=RewriteDraft(draft_text=draft),
        skill=NoSkill(),
    )
    return ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=SCOPE,
        current_text=draft,
        direction=None,
        evidence=(ContextEvidence(EVIDENCE_ID, "user_draft", draft, SCOPE),),
        skill_library_revision=0,
    )


def reply_output() -> AIMessage:
    return AIMessage(content="", tool_calls=[{
        "name": "ReplyRuntimeOutput",
        "args": {
            "candidates": [{
                "text": "合成候选：今晚不参加，祝活动顺利。",
                "basis": "保持用户原句立场。",
                "citation_ids": [str(EVIDENCE_ID)],
                "risk_notes": [],
            }],
            "used_skill_version_id": None,
        },
        "id": "synthetic-runtime-output",
    }])


class ConfiguredRuntimeCounter(SyntheticProtocolCounter):
    """计量绑定的合成模型构造参数与最终请求，沿用其已声明字符协议。

    profile 的精确计量只对 ControlledBudgetModel 的合成协议有效。
    默认参数来自同一实际对象；不能把此约定用于真实供应商模型。
    """

    def __init__(self, model: ControlledBudgetModel) -> None:
        super().__init__(model)
        self.model = model

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        if request.model_id != self.model.model_name:
            raise ValueError("合成模型与计量配置不一致。")
        settings = {
            "max_tokens": self.model.max_tokens,
            **copy.deepcopy(self.model.model_kwargs),
            **request.model_settings,
        }
        return super().measure(replace(request, model_settings=settings))


class InputBudgetRuntimeTest(unittest.TestCase):
    def test_default_unknown_capability_blocks_real_runtime_model_call(self):
        model = ControlledBudgetModel(responses=[reply_output()])
        runtime = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(SCOPE, 0),
        )

        with self.assertRaises(InputBudgetUnavailableError):
            runtime.generate(prepared_context())

        self.assertEqual(model.seen_calls, [])

    def test_existing_runtime_payload_and_bound_reserve_match_complete_counter(self):
        model = ControlledBudgetModel(
            responses=[reply_output()],
            model_kwargs={"synthetic_default_setting": "合成构造默认参数。"},
        )
        counter = ConfiguredRuntimeCounter(model)
        decisions: list[InputBudgetDecision] = []
        runtime = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(SCOPE, 0),
            input_budget_profile=make_profile(),
            input_token_counter=counter,
            on_input_budget=decisions.append,
        )

        result = runtime.generate(prepared_context())

        self.assertEqual(result.candidates[0].text, "合成候选：今晚不参加，祝活动顺利。")
        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(counter.seen_payloads, model.seen_calls)
        payload = model.seen_calls[0]
        self.assertEqual(payload["max_tokens"], 100)
        self.assertEqual(payload["synthetic_default_setting"], "合成构造默认参数。")
        system = payload["messages"][0]["content"]
        self.assertIn("当前联系人可用的回复策略", system)
        self.assertIn("改写附加要求不得偷换原句的立场", system)
        content = json.loads(payload["messages"][1]["content"])
        self.assertEqual(content["fidelity_contract"]["version"], "fidelity-v2")
        self.assertEqual(content["fidelity_contract"]["current_intent"], {
            "source": "draft_text", "text": "合成原句：今晚不参加，祝活动顺利。",
        })
        tool_names = {item["function"]["name"] for item in payload["tools"]}
        self.assertEqual(tool_names, {"read_file", "ReplyRuntimeOutput"})
        self.assertEqual(decisions[0].state, BudgetState.READY)

    def test_core_fixture_binds_complete_protocol_and_actual_output_reserve(self):
        model = ScriptedCoreModel()
        model.responses = [reply_output()]
        configuration = synthetic_budget_kwargs(model, output_reserve=100)
        runtime = LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(SCOPE, 0), **configuration,
        )

        result = runtime.generate(prepared_context())

        self.assertEqual(len(result.candidates), 1)
        counter = configuration["input_token_counter"]
        self.assertEqual(counter.seen_payloads, model.seen_model_payloads)
        self.assertEqual(model.seen_model_payloads[0]["max_tokens"], 100)


if __name__ == "__main__":
    unittest.main()
