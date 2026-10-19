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
from tests.input_budget_support import synthetic_budget_kwargs


class FidelityInputTests(unittest.TestCase):
    def test_citation_policy_names_only_actual_evidence_and_excludes_source_reference_ids(self):
        _, payload, _, _, primary = self.run_content(RewriteDraft(
            draft_text="一起买点零食边吃边聊吧？", input_kind="current_chat",
            pasted_direction="确认对方现在的选择，不推断原因。", include_relationship_context=True))
        policy = payload["citation_policy"]
        self.assertIn(str(primary), policy["allowed_evidence_ids"])
        self.assertEqual(len(policy["allowed_evidence_ids"]), 2)
        self.assertEqual(policy["additional_evidence_ids"], "successful_history_tool_evidence_only")
        self.assertTrue(policy["references_are_not_citations"])

    def run_content(self, content, *, additional_evidence=()):
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
        ) + tuple(ContextEvidence(
            uuid4(), kind, body, scope,
            status="pending" if kind == "pending_candidate" else (
                "candidate" if kind == "continued_candidate" else "active"),
        ) for kind, body in additional_evidence)
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
        result = LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(scope, 0), **synthetic_budget_kwargs(model)).generate(prepared)
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

    def test_material_roles_do_not_upgrade_history_or_candidates_to_current_facts(self):
        _, payload, system, _, _ = self.run_content(RewriteDraft(
            draft_text="今晚不参加。", include_relationship_context=True,
        ), additional_evidence=(
            ("message", "合成旧聊天：我去年住在台北。"),
            ("owner_memory", "用户过去喜欢参加聚会。"),
            ("pending_candidate", "待确认：对方可能不高兴。"),
            ("continued_candidate", "旧助手候选：下次一定参加。"),
        ))
        roles = {item["kind"]: item["factual_role"] for item in payload["evidence"]}
        self.assertEqual(roles, {
            "user_draft": "current_user_statement", "message": "source_message_statement",
            "confirmed_memory": "sourced_contact_memory", "owner_memory": "sourced_owner_memory",
            "pending_candidate": "unconfirmed_reference", "continued_candidate": "previous_assistant_candidate",
        })
        self.assertEqual(payload["fidelity_contract"]["content_boundary"]["output_scope"],
                         ["candidate_text", "basis", "risk_notes"])
        self.assertIn("条件性建议", system)
        self.assertIn("未读到消息不证明多久没联系", system)

    def test_workspace_suggestion_returns_sentences_and_reasons_without_confirmed_intent(self):
        result, payload, system, _, _ = self.run_content(RewriteDraft(
            draft_text='', input_kind='workspace', workspace_action='suggest',
            context_text='对方：最近工作很累。', include_relationship_context=True))
        self.assertEqual(payload['input_mode'], 'workspace')
        self.assertEqual(payload['workspace_action'], 'suggest')
        self.assertEqual(payload['draft_text'], '')
        self.assertEqual(payload['fidelity_contract']['current_intent'], None)
        self.assertEqual(payload['fidelity_contract']['instruction_scope'], 'suggest_options_for_user_selection')
        self.assertNotIn('confirmed_direction', payload)
        self.assertIn('尚未选择', system)
        self.assertTrue(result.candidates[0].text)
        self.assertTrue(result.candidates[0].basis)

    def test_workspace_expression_preserves_user_idea_as_current_intent(self):
        _, payload, _, _, _ = self.run_content(RewriteDraft(
            draft_text='想婉拒，不作下次的承诺。', input_kind='workspace', workspace_action='express',
            include_relationship_context=True))
        self.assertEqual(payload['workspace_action'], 'express')
        self.assertEqual(payload['fidelity_contract']['current_intent'], {
            'source': 'draft_text', 'text': '想婉拒，不作下次的承诺。'})
        self.assertEqual(payload['fidelity_contract']['instruction_scope'], 'expression_only')

    def test_workspace_question_does_not_become_confirmed_stance(self):
        _, payload, _, _, _ = self.run_content(RewriteDraft(
            draft_text='不知道该不该问近况。', input_kind='workspace', workspace_action='suggest',
            include_relationship_context=True))
        self.assertEqual(payload['draft_text'], '不知道该不该问近况。')
        self.assertIsNone(payload['fidelity_contract']['current_intent'])


if __name__ == "__main__":
    unittest.main()
