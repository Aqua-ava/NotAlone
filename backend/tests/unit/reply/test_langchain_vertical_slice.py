"""通过 public seam 验证 LangChain + SkillsMiddleware 正式 adapter。"""

from __future__ import annotations

import unittest
import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
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
    RewriteDraft,
)
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import (
    ContextEvidence,
    ReplyContext,
)
from notalone.reply.runtime import ReplyRuntimeResult
from notalone.reply.store import (
    ReplyRequest,
    ReplyRequestState,
    ReplyStart,
    ValidatedReply,
)
from notalone.reply.errors import ReplyInvariantError
from notalone.memory.timing import MemoryTiming
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillVersion


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-333333333333")
BINDING_ID = UUID("cccccccc-3333-3333-3333-333333333333")
VERIFIED_SCOPE = VerifiedConversationScope(
    OWNER_ID,
    CONTACT_ID,
    BINDING_ID,
)
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
    model_name: str = "fake-chat-model"

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

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        # 两种调用方式共享同一合成响应和调用记录。
        return await asyncio.to_thread(
            self._generate, messages, stop, run_manager, **kwargs,
        )


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
class EmptySkillPort:
    scope: ContactScope
    revision: int

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        if scope != self.scope:
            raise PermissionError("synthetic scope mismatch")
        return SkillCatalog(scope=scope, revision=self.revision, entries=())

    def load_version(self, scope: ContactScope, version_id: UUID) -> SkillVersion:
        del scope, version_id
        raise AssertionError("empty synthetic catalog cannot load a Skill")


@dataclass
class InMemoryReplyStore:
    prepared: ReplyContext
    saved: ValidatedReply | None = None

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        if command != self.prepared.command:
            raise AssertionError("unexpected synthetic command")
        return ReplyStart(
            state=ReplyRequestState.STARTED,
            request=ReplyRequest(
                request_id=self.prepared.reply_request_id,
                idempotency_key=command.idempotency_key,
                normalized_input="synthetic-input",
                scope=self.prepared.scope,
                conversation_binding_id=verified_scope.conversation_binding_id,
                attempt=1,
                lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
                continued_from_candidate_id=command.continued_from_candidate_id,
            ),
        )

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        if request.request_id != context.reply_request_id:
            raise AssertionError("unexpected synthetic request")
        self.saved = reply
        return ReplyGenerated(
            reply_request_id=context.reply_request_id,
            candidates=(
                ReplyCandidate(
                    candidate_id=CANDIDATE_ID,
                    text=reply.candidates[0].text,
                    basis=reply.candidates[0].basis,
                    citation_ids=reply.candidates[0].citation_ids,
                    risk_notes=reply.candidates[0].risk_notes,
                ),
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

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        del request, reason


@dataclass
class RecordingReplyContext:
    prepared: ReplyContext

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: object | None = None,
    ) -> ReplyContext:
        del command, verified_scope, reply_request_id, continued_candidate
        return self.prepared


class LangChainVerticalSliceTest(unittest.TestCase):
    def test_memory_validity_reaches_the_actual_model_input(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(
            draft_text="说说之前的旅行",
            include_relationship_context=True,
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
                    kind="confirmed_memory",
                    text="双方曾一起去北区旅行。",
                    scope=scope,
                    source_ids=(REQUEST_KEY,),
                    valid_at=datetime(2025, 4, 1, tzinfo=timezone.utc),
                    revision=1,
                    timing=MemoryTiming(
                        recorded_at=datetime(2026, 9, 5, tzinfo=timezone.utc),
                        source_started_at=datetime(2025, 4, 2, tzinfo=timezone.utc),
                        source_ended_at=datetime(2025, 4, 4, tzinfo=timezone.utc),
                        source_time_complete=True,
                    ),
                ),
                ContextEvidence(
                    evidence_id=SECOND_REQUEST_ID,
                    kind="owner_memory",
                    text="用户喜欢徒步。",
                    scope=scope,
                    source_ids=(REQUEST_KEY,),
                    revision=1,
                ),
            ),
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(responses=[AIMessage(
            content="",
            tool_calls=[{
                "name": "ReplyRuntimeOutput",
                "args": {
                    "candidates": [{
                        "text": "上次一起去北区旅行挺开心的。",
                        "basis": "已发生的旅行经历",
                        "citation_ids": [str(MESSAGE_ID)],
                        "risk_notes": [],
                    }],
                    "used_skill_version_id": None,
                },
                "id": "memory-time-result",
            }],
        )])

        LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(scope=scope, revision=4),
        ).generate(prepared)

        payload = next(
            json.loads(message.content)
            for call in model.seen_calls
            for message in call
            if message.type == "human"
        )
        self.assertEqual(
            payload["evidence"][0]["valid_at"],
            "2025-04-01T00:00:00+00:00",
        )
        self.assertIsNone(payload["evidence"][0]["invalid_at"])
        self.assertEqual(payload["evidence"][0]["timing"], {
            "recorded_at": "2026-09-05T00:00:00+00:00",
            "source_started_at": "2025-04-02T00:00:00+00:00",
            "source_ended_at": "2025-04-04T00:00:00+00:00",
            "source_time_complete": True,
        })
        self.assertEqual(payload["evidence"][1]["timing"], {
            "recorded_at": None,
            "source_started_at": None,
            "source_ended_at": None,
            "source_time_complete": False,
        })
        self.assertIsNone(payload["evidence"][1]["valid_at"])
        self.assertIsNone(payload["evidence"][1]["invalid_at"])
        system_text = "\n".join(
            str(message.content) for call in model.seen_calls for message in call
            if message.type == "system"
        )
        self.assertIn("不等于事件发生时间", system_text)
        self.assertIn("当前有效不证明", system_text)

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

    def test_runtime_reports_usage_metadata_as_runtime_usage(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(draft_text="我明天有空，晚点见")
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
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "我明天有空，晚点见。",
                                        "basis": "保留原意润色",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "usage-result",
                        },
                    ],
                    usage_metadata={
                        "input_tokens": 130,
                        "output_tokens": 26,
                        "total_tokens": 156,
                    },
                ),
            ],
        )

        result = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(scope=scope, revision=4),
        ).generate(prepared)

        self.assertIsNotNone(result.usage)
        self.assertEqual(result.usage.provider, "deepseek")
        self.assertEqual(result.usage.model_name, "fake-chat-model")
        self.assertEqual(result.usage.input_tokens, 130)
        self.assertEqual(result.usage.output_tokens, 26)

    def test_runtime_accepts_string_null_for_unused_skill(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = ReplyToMessage(
            target_message_id=MESSAGE_ID,
            direction=ConfirmedDirection(
                text="自然地回应，保持简短友好",
                source=DirectionSource.DIRECT_INPUT,
            ),
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
            current_text="你好",
            direction=content.direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="你好",
                    scope=scope,
                    source_ids=(MESSAGE_ID,),
                ),
            ),
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "你好呀，最近怎么样？",
                                        "basis": "回应当前消息",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    },
                                ],
                                "used_skill_version_id": "null",
                            },
                            "id": "string-null-skill-result",
                        },
                    ],
                ),
            ],
        )

        result = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(scope=scope, revision=4),
        ).generate(prepared)

        self.assertIsNone(result.used_skill)
        self.assertEqual(result.candidates[0].text, "你好呀，最近怎么样？")

    def test_rewrite_draft_reaches_runtime_as_one_time_input(self) -> None:
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
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "我明天有空，晚点见。",
                                        "basis": "保留原意并做基础润色",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    },
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "rewrite-result",
                        },
                    ],
                ),
            ],
        )

        result = ReplyGenerator(
            store=InMemoryReplyStore(prepared),
            runtime=LangChainReplyRuntime(
                model=model,
                skill_port=EmptySkillPort(scope=scope, revision=4),
            ),
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertEqual(result.candidates[0].text, "我明天有空，晚点见。")
        self.assertIsNone(result.used_skill)
        self.assertIn('"input_mode": "rewrite_draft"', seen_context)
        self.assertIn(content.draft_text, seen_context)
        self.assertIn(content.user_instruction, seen_context)
        self.assertNotIn("send_message", model.bound_tool_names)

    def test_default_rewrite_prompt_preserves_intent_and_only_polishes(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(draft_text="我明天有空，晚点见")
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
            skill_library_revision=4,
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "我明天有空，晚点见。",
                                        "basis": "基础润色",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    },
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "rewrite-basic-polish-result",
                        },
                    ],
                ),
            ],
        )

        ReplyGenerator(
            store=InMemoryReplyStore(prepared),
            runtime=LangChainReplyRuntime(
                model=model,
                skill_port=EmptySkillPort(scope=scope, revision=4),
            ),
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertIn("只做基础润色", seen_context)
        self.assertIn("保留用户原意", seen_context)
        self.assertIn('"user_instruction": null', seen_context)

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
        prepared = ReplyContext(
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

        result = ReplyGenerator(
            store=store,
            runtime=runtime,
            context=RecordingReplyContext(prepared=prepared),
        ).generate(
            command,
            verified_scope=VERIFIED_SCOPE,
        )

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
        prepared = ReplyContext(
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
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

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
        prepared = ReplyContext(
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
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

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
        prepared = ReplyContext(
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
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertIn("WARM_SECRET_BODY", seen_context)
        self.assertNotIn("DIRECT_SECOND_BODY", seen_context)
        self.assertIsNone(store.saved)

    def test_second_turn_uses_only_explicitly_continued_candidate(self) -> None:
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
        first_prepared = ReplyContext(
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
        context = RecordingReplyContext(prepared=first_prepared)
        generator = ReplyGenerator(
            store=store,
            runtime=LangChainReplyRuntime(model=model, skill_port=skill_port),
            context=context,
        )

        first_result = generator.generate(
            first_command,
            verified_scope=VERIFIED_SCOPE,
        )
        second_direction = ConfirmedDirection(
            text="把上一条改得更直接",
            source=DirectionSource.DIRECT_INPUT,
        )
        second_command = replace(
            first_command,
            idempotency_key=SECOND_REQUEST_KEY,
            content=ReplyToMessage(MESSAGE_ID, second_direction),
            continued_from_candidate_id=first_result.candidates[0].candidate_id,
        )
        store.prepared = ReplyContext(
            reply_request_id=SECOND_REQUEST_ID,
            command=second_command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=second_direction,
            evidence=first_prepared.evidence
            + (
                ContextEvidence(
                    first_result.candidates[0].candidate_id,
                    "continued_candidate",
                    first_result.candidates[0].text,
                    scope,
                ),
            ),
            skill_library_revision=4,
        )
        context.prepared = store.prepared

        second_result = generator.generate(
            second_command,
            verified_scope=VERIFIED_SCOPE,
        )

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
