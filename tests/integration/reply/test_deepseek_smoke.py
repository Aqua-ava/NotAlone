"""DeepSeek 真实模型端到端冒烟：只在显式提供凭据时运行。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import (
    ContextReceipt,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    RewriteDraft,
)
from notalone.scopes import ContactScope, VerifiedConversationScope

from unit.reply.test_langchain_vertical_slice import (
    BINDING_ID,
    CONTACT_ID,
    EmptySkillPort,
    InMemoryReplyStore,
    MESSAGE_ID,
    OWNER_ID,
    REQUEST_ID,
    REQUEST_KEY,
    RecordingReplyContext,
    VERIFIED_SCOPE,
)

_SKILL_REVISION = 4


class AllCandidatesReplyStore(InMemoryReplyStore):
    """真实模型可能返回多条候选；持久化回包必须保留全部候选。"""

    def save(self, request, context, reply):  # noqa: ANN001
        return ReplyGenerated(
            reply_request_id=context.reply_request_id,
            candidates=tuple(
                ReplyCandidate(
                    candidate_id=uuid4(),
                    text=candidate.text,
                    basis=candidate.basis,
                    citation_ids=candidate.citation_ids,
                    risk_notes=candidate.risk_notes,
                )
                for candidate in reply.candidates
            ),
            context_receipt=ContextReceipt(
                evidence_ids=tuple(
                    evidence_id
                    for candidate in reply.candidates
                    for evidence_id in candidate.citation_ids
                ),
            ),
            used_skill=reply.used_skill,
        )


def _smoke_enabled() -> bool:
    key = os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "")
    return bool(key.strip())


class DeepSeekSmokeTest(unittest.TestCase):
    """用合成草稿做一次真实生成；不读取任何私人聊天资料。"""

    @classmethod
    def setUpClass(cls) -> None:
        if not _smoke_enabled():
            raise unittest.SkipTest(
                "未提供 NOTALONE_DEEPSEEK_API_KEY，跳过真实模型冒烟。"
            )

    def test_rewrite_draft_produces_valid_candidate_via_real_model(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(
            draft_text="我明天有空，晚点见",
            user_instruction="更自然一点",
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=content,
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text=content.draft_text,
            direction=None,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="user_draft",
                    text=content.draft_text,
                    scope=scope,
                ),
            ),
            skill_library_revision=_SKILL_REVISION,
        )

        result = ReplyGenerator(
            store=AllCandidatesReplyStore(prepared),
            runtime=LangChainReplyRuntime(
                model=build_deepseek_model(),
                skill_port=EmptySkillPort(
                    scope=scope, revision=_SKILL_REVISION
                ),
            ),
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertTrue(result.candidates)
        for candidate in result.candidates:
            self.assertTrue(candidate.text.strip())
            self.assertTrue(candidate.basis.strip())


if __name__ == "__main__":
    unittest.main()
