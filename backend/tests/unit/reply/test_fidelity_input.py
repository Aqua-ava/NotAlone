"""真实 LangChain seam 捕获输入优先级；合成输出不证明模型语义服从。"""

from __future__ import annotations

import json
import unittest
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.reply.fidelity_evaluation import deterministic_contract
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.interface import (
    ConfirmedDirection, DirectionSource, GenerateReply, InitiateConversation,
    NoSkill, ReplyToMessage, RewriteDraft,
)
from notalone.scopes import ContactScope
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort, ToolCallingFakeModel


class FidelityInputTests(unittest.TestCase):
    def run_content(self, content):
        scope = ContactScope(uuid4(), uuid4())
        primary_id = uuid4()
        rewrite = isinstance(content, RewriteDraft)
        proactive = isinstance(content, InitiateConversation)
        text = content.draft_text if rewrite else (
            content.purpose.text if proactive else "合成对方问：今晚参加吗？"
        )
        evidence = (
            ContextEvidence(primary_id, "user_draft" if rewrite else (
                "user_purpose" if proactive else "message"), text, scope),
            ContextEvidence(uuid4(), "confirmed_memory", "合成旧习惯：用户过去经常答应参加。", scope),
        )
        output = {"candidates": [{"text": "好，我参加。", "basis": "沿用过去常答应的表达。",
                                  "citation_ids": [str(primary_id)], "risk_notes": []}],
                  "used_skill_version_id": None}
        model = ToolCallingFakeModel(responses=[AIMessage(content="", tool_calls=[{
            "name": "ReplyRuntimeOutput", "args": output, "id": "synthetic-fidelity-output",
        }])])
        command = GenerateReply(idempotency_key=uuid4(), scope=scope,
                                conversation_binding_id=uuid4(), content=content, skill=NoSkill())
        prepared = ReplyContext(reply_request_id=uuid4(), command=command, scope=scope,
                                current_text=text, direction=None if rewrite else (
                                    content.purpose if proactive else content.direction),
                                evidence=evidence, skill_library_revision=0)
        result = LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(scope, 0)).generate(prepared)
        payload = next(json.loads(message.content) for message in model.seen_calls[0] if message.type == "human")
        system = "\n".join(str(message.content) for message in model.seen_calls[0] if message.type == "system")
        return result, payload, system, output, primary_id

    def test_rewrite_original_stance_wins_over_conflicting_instruction_and_history(self):
        result, payload, system, output, primary = self.run_content(RewriteDraft(
            draft_text="今晚不参加。", user_instruction="说得讨喜一点，最好改成答应。",
            include_relationship_context=True,
        ))
        contract = payload["fidelity_contract"]
        self.assertEqual(contract["version"], "fidelity-v1")
        self.assertEqual(contract["current_intent"], {"source": "draft_text", "text": "今晚不参加。"})
        self.assertEqual(contract["instruction_scope"], "expression_only")
        self.assertEqual(contract["priority"][0], "current_explicit_intent")
        self.assertIn("改写附加要求不得偷换原句的立场", system)
        self.assertEqual(result.candidates[0].text, "好，我参加。")
        # 合法引用不能发现这种“未加事实却改变立场”的错误，必须进入逐例审阅。
        self.assertEqual(deterministic_contract(output, allowed_citations=[str(primary)])["status"], "pass")

    def test_confirmed_direction_is_current_intent_in_reply_mode(self):
        _, payload, system, _, _ = self.run_content(ReplyToMessage(
            target_message_id=uuid4(), direction=ConfirmedDirection(
                text="明确拒绝本次邀请，保持友好。", source=DirectionSource.DIRECT_INPUT,
            ),
        ))
        self.assertEqual(payload["fidelity_contract"]["current_intent"], {
            "source": "confirmed_direction", "text": "明确拒绝本次邀请，保持友好。",
        })
        self.assertIn("历史习惯、旧记忆、Skill", system)
        self.assertNotIn("expectation", payload)

    def test_confirmed_purpose_is_current_intent_without_fabricated_message(self):
        _, payload, system, _, _ = self.run_content(InitiateConversation(
            purpose=ConfirmedDirection(text="只问近况，不承诺见面。", source=DirectionSource.DIRECT_INPUT),
        ))
        self.assertEqual(payload["fidelity_contract"]["current_intent"], {
            "source": "confirmed_purpose", "text": "只问近况，不承诺见面。",
        })
        self.assertEqual(payload["skill_selection"], {"mode": "disabled"})
        self.assertNotIn("current_text", payload)
        self.assertNotIn("target_message_id", payload)
        self.assertEqual(payload["evidence"][0]["kind"], "user_purpose")
        self.assertIn("不能改变本次立场", system)


if __name__ == "__main__":
    unittest.main()
