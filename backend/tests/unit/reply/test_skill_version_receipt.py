"""自动 Skill 通过实际读取回执提供版本身份的公开生成回归。"""

from __future__ import annotations

import json
import unittest
from typing import Any
from uuid import UUID

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from notalone.reply import (
    AutoSkill,
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyGenerator,
    ReplyToMessage,
)
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyInvariantError
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillVersion
from tests.input_budget_support import synthetic_budget_kwargs
from tests.unit.reply.test_langchain_vertical_slice import (
    BINDING_ID,
    CONTACT_ID,
    DIRECT_VERSION_ID,
    MESSAGE_ID,
    OWNER_ID,
    REQUEST_ID,
    REQUEST_KEY,
    SKILL_ID,
    SKILL_PATH,
    VERIFIED_SCOPE,
    VERSION_ID,
    InMemoryReplyStore,
    InMemorySkillPort,
    RecordingReplyContext,
    ToolCallingFakeModel,
)


SKILL_CONTENT = (
    "---\n"
    "name: warm-reply\n"
    "description: 合成邀请回复\n"
    "---\n"
    "\n"
    "第一步：回应邀请。\n"
    "  第二步：保留自然语气。\n"
    "\n"
    "示例：可以呀，明天见。\n"
)


def _receipt_and_body(message: ToolMessage) -> tuple[UUID, str]:
    """只解析正文前的服务端回执，不从 Skill 正文猜测版本。"""
    header, separator, body = str(message.content).partition("\n\n")
    if not separator:
        raise AssertionError("Skill 读取结果缺少版本回执。")
    for line in header.splitlines():
        if line.startswith("{"):
            receipt = json.loads(line)
            return UUID(receipt["used_skill_version_id"]), body
    raise AssertionError("Skill 读取结果缺少可复制的版本 UUID。")


def _skill_messages(messages: list[BaseMessage]) -> list[ToolMessage]:
    return [
        message
        for message in messages
        if isinstance(message, ToolMessage)
        and message.tool_call_id.startswith("read-skill-page-")
    ]


class ReceiptDrivenFakeModel(ToolCallingFakeModel):
    """候选版本只取自模型实际收到的 ToolMessage，夹具不预填 UUID。"""

    pages: tuple[tuple[int, int], ...] = ((0, 1000),)
    declared_version_override: str | None = None

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        skill_messages = _skill_messages(messages)
        if len(skill_messages) < len(self.pages):
            offset, limit = self.pages[len(skill_messages)]
            response = AIMessage(content="", tool_calls=[{
                "name": "read_file",
                "args": {
                    "file_path": SKILL_PATH,
                    "offset": offset,
                    "limit": limit,
                },
                "id": f"read-skill-page-{len(skill_messages)}",
            }])
        else:
            version_id, _ = _receipt_and_body(skill_messages[-1])
            response = AIMessage(content="", tool_calls=[{
                "name": "ReplyRuntimeOutput",
                "args": {
                    "candidates": [{
                        "text": "可以呀，明天见。",
                        "basis": "按已读取的邀请回复策略自然回应。",
                        "citation_ids": [str(MESSAGE_ID)],
                        "risk_notes": [],
                    }],
                    "used_skill_version_id": (
                        self.declared_version_override or str(version_id)
                    ),
                },
                "id": "return-receipt-based-candidate",
            }])
        self.responses = [response]
        return super()._generate(messages, stop, run_manager, **kwargs)


def _prepared_and_skill(
    version_id: UUID = VERSION_ID,
) -> tuple[ReplyContext, InMemorySkillPort]:
    scope = ContactScope(OWNER_ID, CONTACT_ID)
    direction = ConfirmedDirection("自然地答应邀请", DirectionSource.DIRECT_INPUT)
    command = GenerateReply(
        idempotency_key=REQUEST_KEY,
        scope=scope,
        conversation_binding_id=BINDING_ID,
        content=ReplyToMessage(MESSAGE_ID, direction),
        skill=AutoSkill(),
    )
    prepared = ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=scope,
        current_text="明天一起吃饭吗？",
        direction=direction,
        evidence=(
            ContextEvidence(MESSAGE_ID, "message", "明天一起吃饭吗？", scope),
        ),
        skill_library_revision=4,
    )
    entry = SkillCatalogEntry(
        SKILL_ID, version_id, "warm-reply", "合成邀请回复", OWNER_ID, CONTACT_ID,
    )
    skill_port = InMemorySkillPort(
        scope=scope,
        catalog_value=SkillCatalog(scope, 4, (entry,)),
        version=SkillVersion(
            OWNER_ID, CONTACT_ID, SKILL_ID, version_id,
            "warm-reply", "合成邀请回复", SKILL_CONTENT, True,
        ),
    )
    return prepared, skill_port


class SkillVersionReceiptTest(unittest.TestCase):
    def test_auto_skill_version_is_copied_from_tool_receipt_and_saved(self) -> None:
        for version_id in (VERSION_ID, DIRECT_VERSION_ID):
            with self.subTest(version_id=version_id):
                prepared, skill_port = _prepared_and_skill(version_id)
                model = ReceiptDrivenFakeModel(responses=[])
                store = InMemoryReplyStore(prepared)

                result = ReplyGenerator(
                    store=store,
                    runtime=LangChainReplyRuntime(
                        model=model, skill_port=skill_port,
                        **synthetic_budget_kwargs(model),
                    ),
                    context=RecordingReplyContext(prepared),
                ).generate(prepared.command, verified_scope=VERIFIED_SCOPE)

                self.assertNotIn(str(version_id), SKILL_CONTENT)
                self.assertNotIn(
                    str(version_id),
                    "\n".join(str(message.content) for message in model.seen_calls[0]),
                )
                receipt_id, body = _receipt_and_body(
                    _skill_messages(model.seen_calls[-1])[0],
                )
                self.assertEqual(receipt_id, version_id)
                self.assertEqual(body, SKILL_CONTENT.rstrip("\n"))
                self.assertEqual(result.candidates[0].text, "可以呀，明天见。")
                self.assertEqual(result.used_skill.version_id, version_id)
                self.assertEqual(result.used_skill.selection_method, "auto")
                self.assertIsNotNone(store.saved)
                self.assertEqual(store.saved.used_skill.version_id, version_id)

    def test_each_page_has_version_receipt_and_preserves_selected_body_lines(self) -> None:
        prepared, skill_port = _prepared_and_skill()
        model = ReceiptDrivenFakeModel(
            responses=[], pages=((0, 3), (3, 3), (6, 2), (8, 1000), (9, 1000)),
        )
        runtime = LangChainReplyRuntime(
            model=model, skill_port=skill_port, **synthetic_budget_kwargs(model),
        )

        result = runtime.generate(prepared)

        skill_messages = _skill_messages(model.seen_calls[-1])
        self.assertEqual(len(skill_messages), 5)
        expected_bodies = (
            "---\nname: warm-reply\ndescription: 合成邀请回复",
            "---\n\n第一步：回应邀请。",
            "  第二步：保留自然语气。\n",
            "示例：可以呀，明天见。",
            "",
        )
        for message, expected_body in zip(skill_messages, expected_bodies, strict=True):
            with self.subTest(tool_call_id=message.tool_call_id):
                receipt_id, body = _receipt_and_body(message)
                self.assertEqual(receipt_id, VERSION_ID)
                self.assertEqual(body, expected_body)
        self.assertEqual(result.used_skill.version_id, VERSION_ID)

    def test_a_different_version_claim_is_rejected_after_valid_receipt(self) -> None:
        prepared, skill_port = _prepared_and_skill()
        model = ReceiptDrivenFakeModel(
            responses=[], declared_version_override=str(DIRECT_VERSION_ID),
        )
        store = InMemoryReplyStore(prepared)

        with self.assertRaisesRegex(ReplyInvariantError, "实际读取版本不一致"):
            ReplyGenerator(
                store=store,
                runtime=LangChainReplyRuntime(
                    model=model, skill_port=skill_port,
                    **synthetic_budget_kwargs(model),
                ),
                context=RecordingReplyContext(prepared),
            ).generate(prepared.command, verified_scope=VERIFIED_SCOPE)

        receipt_id, _ = _receipt_and_body(_skill_messages(model.seen_calls[-1])[0])
        self.assertEqual(receipt_id, VERSION_ID)
        self.assertIsNone(store.saved)


if __name__ == "__main__":
    unittest.main()
