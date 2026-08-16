"""通过 public seam 验证 LangChain + SkillsMiddleware 正式 adapter。"""

from __future__ import annotations

import unittest
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any
from uuid import UUID

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import Runnable

from notalone.reply import (
    AutoSkill,
    ConfirmedDirection,
    ContextReceipt,
    DirectionSource,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    ReplyGenerator,
    ReplyToMessage,
)
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.contracts import (
    ContextEvidence,
    PreparedReply,
    PreviousUnsentCandidate,
    ValidatedReply,
)
from notalone.reply.errors import ReplyInvariantError
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillVersion


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-333333333333")
BINDING_ID = UUID("cccccccc-3333-3333-3333-333333333333")
MESSAGE_ID = UUID("dddddddd-4444-4444-4444-444444444444")
REQUEST_KEY = UUID("eeeeeeee-5555-5555-5555-555555555555")
REQUEST_ID = UUID("ffffffff-6666-6666-6666-666666666666")
SECOND_REQUEST_KEY = UUID("eeeeeeee-5555-5555-5555-666666666666")
SECOND_REQUEST_ID = UUID("ffffffff-6666-6666-6666-777777777777")
CANDIDATE_ID = UUID("11111111-7777-7777-7777-777777777777")
SKILL_ID = UUID("22222222-8888-8888-8888-888888888888")
VERSION_ID = UUID("33333333-9999-9999-9999-999999999999")
DIRECT_SKILL_ID = UUID("22222222-8888-8888-8888-999999999999")
DIRECT_VERSION_ID = UUID("33333333-9999-9999-9999-aaaaaaaaaaaa")
SKILL_PATH = "/notalone/reply-skills/warm-reply/SKILL.md"
DIRECT_SKILL_PATH = "/notalone/reply-skills/direct-reply/SKILL.md"


class ToolCallingFakeModel(FakeMessagesListChatModel):
    bound_tool_names: list[str] = []
    seen_calls: list[list[BaseMessage]] = []

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        del tool_choice, kwargs
        self.bound_tool_names = [
            getattr(item, "name", getattr(item, "__name__", ""))
            for item in tools
        ]
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        self.seen_calls.append(messages)
        return super()._generate(messages, stop, run_manager, **kwargs)


@dataclass
class InMemorySkillPort:
    scope: ContactScope
    catalog_value: SkillCatalog
    version: SkillVersion

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        if scope != self.scope:
            raise PermissionError("synthetic scope mismatch")
        return self.catalog_value

    def load_version(
        self,
        scope: ContactScope,
        version_id: UUID,
    ) -> SkillVersion:
        if scope != self.scope or version_id != self.version.version_id:
            raise PermissionError("synthetic version mismatch")
        return self.version


@dataclass
class MultiSkillPort:
    scope: ContactScope
    catalog_value: SkillCatalog
    versions: dict[UUID, SkillVersion]

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        if scope != self.scope:
            raise PermissionError("synthetic scope mismatch")
        return self.catalog_value

    def load_version(
        self,
        scope: ContactScope,
        version_id: UUID,
    ) -> SkillVersion:
        if scope != self.scope:
            raise PermissionError("synthetic scope mismatch")
        return self.versions[version_id]


@dataclass
class InMemoryReplyStore:
    prepared: PreparedReply
    saved: ValidatedReply | None = None

    def prepare(self, command: GenerateReply) -> PreparedReply:
        if command != self.prepared.command:
            raise AssertionError("unexpected synthetic command")
        return self.prepared

    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        self.saved = reply
        candidate = reply.candidates[0]
        return ReplyGenerated(
            reply_request_id=prepared.reply_request_id,
            candidates=(
                ReplyCandidate(
                    candidate_id=CANDIDATE_ID,
                    text=candidate.text,
                    basis=candidate.basis,
                    citation_ids=candidate.citation_ids,
                    risk_notes=candidate.risk_notes,
                ),
            ),
            context_receipt=ContextReceipt(
                evidence_ids=tuple(item.evidence_id for item in prepared.evidence),
            ),
            used_skill=reply.used_skill,
        )


class LangChainVerticalSliceTest(unittest.TestCase):
    def _two_skill_port(self, scope: ContactScope) -> MultiSkillPort:
        warm_entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "warm-reply",
            "温和回应",
            OWNER_ID,
            CONTACT_ID,
        )
        direct_entry = SkillCatalogEntry(
            DIRECT_SKILL_ID,
            DIRECT_VERSION_ID,
            "direct-reply",
            "直接回应",
            OWNER_ID,
            CONTACT_ID,
        )
        return MultiSkillPort(
            scope=scope,
            catalog_value=SkillCatalog(scope, 4, (warm_entry, direct_entry)),
            versions={
                VERSION_ID: SkillVersion(
                    OWNER_ID,
                    CONTACT_ID,
                    SKILL_ID,
                    VERSION_ID,
                    "warm-reply",
                    "温和回应",
                    "---\nname: warm-reply\n---\nWARM_SECRET_BODY",
                    True,
                ),
                DIRECT_VERSION_ID: SkillVersion(
                    OWNER_ID,
                    CONTACT_ID,
                    DIRECT_SKILL_ID,
                    DIRECT_VERSION_ID,
                    "direct-reply",
                    "直接回应",
                    "---\nname: direct-reply\n---\nDIRECT_SECOND_BODY",
                    True,
                ),
            },
        )

    def test_generates_with_one_scoped_skill_without_expanding_tools(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        direction = ConfirmedDirection(
            text="答应邀请，语气自然",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
            skill=AutoSkill(),
        )
        prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="明天一起吃饭吗？",
                    scope=scope,
                ),
            ),
            skill_library_revision=4,
        )
        catalog_entry = SkillCatalogEntry(
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            name="warm-reply",
            description="温和而明确地回应邀请",
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
        )
        skill_port = InMemorySkillPort(
            scope=scope,
            catalog_value=SkillCatalog(
                scope=scope,
                revision=4,
                entries=(catalog_entry,),
            ),
            version=SkillVersion(
                owner_id=OWNER_ID,
                contact_id=CONTACT_ID,
                skill_id=SKILL_ID,
                version_id=VERSION_ID,
                name="warm-reply",
                description="温和而明确地回应邀请",
                content=(
                    "---\nname: warm-reply\n"
                    "description: 温和而明确地回应邀请\n"
                    "allowed-tools: send_message shell\n---\n"
                    "先回应邀请，再给出明确但自然的答复。\n"
                ),
                enabled=True,
            ),
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {
                                "file_path": SKILL_PATH,
                                "offset": 0,
                                "limit": 1000,
                            },
                            "id": "read-skill-1",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "可以呀，明天见。",
                                        "basis": "回应邀请并保持自然",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": str(VERSION_ID),
                            },
                            "id": "return-candidate-1",
                        }
                    ],
                ),
            ]
        )
        store = InMemoryReplyStore(prepared)
        runtime = LangChainReplyRuntime(model=model, skill_port=skill_port)

        result = ReplyGenerator(store=store, runtime=runtime).generate(command)

        self.assertEqual(result.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(result.used_skill.version_id, VERSION_ID)
        self.assertEqual(
            set(model.bound_tool_names),
            {"read_file", "ReplyRuntimeOutput"},
        )
        self.assertNotIn("send_message", model.bound_tool_names)
        self.assertNotIn("shell", model.bound_tool_names)
        self.assertIsNotNone(store.saved)

    def test_rejects_skill_version_leaked_from_another_contact(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
            skill=AutoSkill(),
        )
        prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=4,
        )
        entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "warm-reply",
            "温和回应",
            OWNER_ID,
            CONTACT_ID,
        )
        leaky_port = InMemorySkillPort(
            scope=scope,
            catalog_value=SkillCatalog(scope, 4, (entry,)),
            version=SkillVersion(
                OWNER_ID,
                OTHER_CONTACT_ID,
                SKILL_ID,
                VERSION_ID,
                "warm-reply",
                "温和回应",
                "CROSS_CONTACT_SECRET",
                True,
            ),
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "read_file",
                        "args": {"file_path": SKILL_PATH},
                        "id": "read-leaked-skill",
                    }],
                ),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "ReplyRuntimeOutput",
                        "args": {
                            "candidates": [{
                                "text": "不应返回",
                                "basis": "越界 Skill",
                                "citation_ids": [str(MESSAGE_ID)],
                                "risk_notes": [],
                            }],
                            "used_skill_version_id": str(VERSION_ID),
                        },
                        "id": "leaked-result",
                    }],
                ),
            ]
        )
        store = InMemoryReplyStore(prepared)

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=LangChainReplyRuntime(model=model, skill_port=leaky_port),
            ).generate(command)

        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertNotIn("CROSS_CONTACT_SECRET", seen_context)
        self.assertIsNone(store.saved)

    def test_rejects_cross_contact_catalog_before_middleware_discovery(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
            skill=AutoSkill(),
        )
        prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=4,
        )
        private_entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "contact-b-private-plan",
            "另一联系人的私密目录元数据",
            OWNER_ID,
            OTHER_CONTACT_ID,
        )
        leaky_port = InMemorySkillPort(
            scope=scope,
            catalog_value=SkillCatalog(other_scope, 4, (private_entry,)),
            version=SkillVersion(
                OWNER_ID,
                OTHER_CONTACT_ID,
                SKILL_ID,
                VERSION_ID,
                "contact-b-private-plan",
                "另一联系人的私密目录元数据",
                "CROSS_CONTACT_SECRET",
                True,
            ),
        )
        model = ToolCallingFakeModel(
            responses=[AIMessage(content="不应调用模型")]
        )
        store = InMemoryReplyStore(prepared)

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=LangChainReplyRuntime(model=model, skill_port=leaky_port),
            ).generate(command)

        self.assertEqual(model.seen_calls, [])
        self.assertIsNone(store.saved)

    def test_rejects_attempt_to_read_a_second_skill(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
            skill=AutoSkill(),
        )
        prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "read_file",
                        "args": {"file_path": SKILL_PATH},
                        "id": "read-first-skill",
                    }],
                ),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "read_file",
                        "args": {"file_path": DIRECT_SKILL_PATH},
                        "id": "read-second-skill",
                    }],
                ),
            ]
        )
        store = InMemoryReplyStore(prepared)

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=LangChainReplyRuntime(
                    model=model,
                    skill_port=self._two_skill_port(scope),
                ),
            ).generate(command)

        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertIn("WARM_SECRET_BODY", seen_context)
        self.assertNotIn("DIRECT_SECOND_BODY", seen_context)
        self.assertIsNone(store.saved)

    def test_second_turn_gets_prior_candidate_without_prior_skill_trace(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        first_direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        first_command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, first_direction),
            skill=AutoSkill(),
        )
        first_prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=first_command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=first_direction,
            evidence=(
                ContextEvidence(MESSAGE_ID, "message", "明天一起吃饭吗？", scope),
            ),
            skill_library_revision=4,
        )
        warm_entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "warm-reply",
            "温和回应",
            OWNER_ID,
            CONTACT_ID,
        )
        direct_entry = SkillCatalogEntry(
            DIRECT_SKILL_ID,
            DIRECT_VERSION_ID,
            "direct-reply",
            "直接回应",
            OWNER_ID,
            CONTACT_ID,
        )
        skill_port = MultiSkillPort(
            scope=scope,
            catalog_value=SkillCatalog(scope, 4, (warm_entry, direct_entry)),
            versions={
                VERSION_ID: SkillVersion(
                    OWNER_ID,
                    CONTACT_ID,
                    SKILL_ID,
                    VERSION_ID,
                    "warm-reply",
                    "温和回应",
                    "---\nname: warm-reply\nallowed-tools: shell\n---\nWARM_SECRET_BODY",
                    True,
                ),
                DIRECT_VERSION_ID: SkillVersion(
                    OWNER_ID,
                    CONTACT_ID,
                    DIRECT_SKILL_ID,
                    DIRECT_VERSION_ID,
                    "direct-reply",
                    "直接回应",
                    "---\nname: direct-reply\n---\nDIRECT_SECOND_BODY",
                    True,
                ),
            },
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "read_file",
                        "args": {"file_path": SKILL_PATH},
                        "id": "read-warm",
                    }],
                ),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "ReplyRuntimeOutput",
                        "args": {
                            "candidates": [{
                                "text": "可以呀，明天见。",
                                "basis": "自然回应",
                                "citation_ids": [str(MESSAGE_ID)],
                                "risk_notes": [],
                            }],
                            "used_skill_version_id": str(VERSION_ID),
                        },
                        "id": "first-result",
                    }],
                ),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "read_file",
                        "args": {"file_path": DIRECT_SKILL_PATH},
                        "id": "read-direct",
                    }],
                ),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "ReplyRuntimeOutput",
                        "args": {
                            "candidates": [{
                                "text": "好，明天见。",
                                "basis": "按用户要求更直接",
                                "citation_ids": [str(MESSAGE_ID)],
                                "risk_notes": [],
                            }],
                            "used_skill_version_id": str(DIRECT_VERSION_ID),
                        },
                        "id": "second-result",
                    }],
                ),
            ]
        )
        store = InMemoryReplyStore(first_prepared)
        generator = ReplyGenerator(
            store=store,
            runtime=LangChainReplyRuntime(model=model, skill_port=skill_port),
        )

        first_result = generator.generate(first_command)
        second_direction = ConfirmedDirection(
            text="把上一条改得更直接",
            source=DirectionSource.DIRECT_INPUT,
        )
        second_command = replace(
            first_command,
            idempotency_key=SECOND_REQUEST_KEY,
            content=ReplyToMessage(MESSAGE_ID, second_direction),
        )
        store.prepared = PreparedReply(
            reply_request_id=SECOND_REQUEST_ID,
            command=second_command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=second_direction,
            evidence=first_prepared.evidence,
            skill_library_revision=4,
            previous_unsent_candidates=(
                PreviousUnsentCandidate(
                    candidate_id=first_result.candidates[0].candidate_id,
                    scope=scope,
                    conversation_binding_id=BINDING_ID,
                    text=first_result.candidates[0].text,
                ),
            ),
        )

        second_result = generator.generate(second_command)

        second_turn_context = "\n".join(
            str(message.content)
            for call in model.seen_calls[2:]
            for message in call
        )
        self.assertEqual(second_result.candidates[0].text, "好，明天见。")
        self.assertIn("可以呀，明天见。", second_turn_context)
        self.assertIn("DIRECT_SECOND_BODY", second_turn_context)
        self.assertNotIn("WARM_SECRET_BODY", second_turn_context)
        self.assertNotIn("allowed-tools", second_turn_context)


if __name__ == "__main__":
    unittest.main()
