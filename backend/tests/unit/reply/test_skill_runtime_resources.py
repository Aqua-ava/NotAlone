"""Reply Runtime 渐进式加载 Skill 辅助资源的公共 seam 测试。

只使用合成 Owner、Contact、Reply Task 和 Skill；不断言私有函数或框架内部状态。
"""

from __future__ import annotations

import hashlib
import asyncio
import unittest
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
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
    UserSkillChoice,
)
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.store import (
    ReplyRequest,
    ReplyRequestState,
    ReplyStart,
    ValidatedReply,
)
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillResource, SkillVersion
from tests.input_budget_support import SyntheticBudgetModel, synthetic_budget_kwargs


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
CANDIDATE_ID = UUID("11111111-7777-7777-7777-777777777777")
SKILL_ID = UUID("22222222-8888-8888-8888-888888888888")
VERSION_ID = UUID("33333333-9999-9999-9999-999999999999")
OTHER_SKILL_ID = UUID("22222222-8888-8888-8888-999999999999")
OTHER_VERSION_ID = UUID("33333333-9999-9999-9999-aaaaaaaaaaaa")
WARM_PATH = "/notalone/reply-skills/warm-reply/SKILL.md"
WARM_CASE_PATH = "/notalone/reply-skills/warm-reply/references/cases.md"
DIRECT_PATH = "/notalone/reply-skills/direct-reply/SKILL.md"
DIRECT_TEMPLATE_PATH = "/notalone/reply-skills/direct-reply/assets/template.txt"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ToolCallingFakeModel(SyntheticBudgetModel):
    bound_tool_names: list[str] = []
    seen_calls: list[list[BaseMessage]] = []
    model_name: str = "fake-chat-model"

    def bind_tools(
        self,
        tools: list[Any] | None,
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        self.bound_tool_names = [
            getattr(item, "name", getattr(item, "__name__", ""))
            for item in (tools or [])
        ]
        return super().bind_tools(tools or [], tool_choice=tool_choice, **kwargs)

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
        # 异步模型调用仍经过同一合成行为，保留来源变更等测试注入。
        return await asyncio.to_thread(
            self._generate, messages, stop, run_manager, **kwargs,
        )


class ResourceRetryModel(ToolCallingFakeModel):
    """非法资源读取后重试；收到终止提示才输出候选。"""

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        del stop, run_manager
        self.record_model_payload(messages, kwargs)
        self.seen_calls.append(messages)
        last = messages[-1] if messages else None
        last_content = str(last.content) if isinstance(last, ToolMessage) else ""
        if "停止读取" in last_content:
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "ReplyRuntimeOutput",
                                    "args": {
                                        "candidates": [
                                            {
                                                "text": "先这样回复。",
                                                "basis": "资源不可用，使用当前输入生成。",
                                                "citation_ids": [str(MESSAGE_ID)],
                                                "risk_notes": [],
                                            }
                                        ],
                                        "used_skill_version_id": None,
                                    },
                                    "id": f"result-{len(self.seen_calls)}",
                                }
                            ],
                        )
                    )
                ]
            )
        if not any(
            isinstance(message, ToolMessage) for message in messages
        ):
            file_path = WARM_PATH
        else:
            file_path = (
                "/notalone/reply-skills/warm-reply/references/"
                f"missing-{len(self.seen_calls)}.md"
            )
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "read_file",
                                "args": {"file_path": file_path},
                                "id": f"read-{len(self.seen_calls)}",
                            }
                        ],
                    )
                )
            ]
        )


@dataclass
class InMemorySkillPort:
    scope: ContactScope
    catalog_value: SkillCatalog
    version: SkillVersion
    resources: dict[str, SkillResource] = field(default_factory=dict)

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

    def load_resource(
        self,
        scope: ContactScope,
        version_id: UUID,
        relative_path: str,
    ) -> SkillResource:
        if scope != self.scope or version_id != self.version.version_id:
            raise PermissionError("synthetic resource mismatch")
        resource = self.resources.get(relative_path)
        if resource is None:
            raise PermissionError("synthetic resource missing")
        return resource


@dataclass
class MultiSkillPort:
    scope: ContactScope
    catalog_value: SkillCatalog
    versions: dict[UUID, SkillVersion]
    resources: dict[tuple[UUID, str], SkillResource] = field(default_factory=dict)

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

    def load_resource(
        self,
        scope: ContactScope,
        version_id: UUID,
        relative_path: str,
    ) -> SkillResource:
        if scope != self.scope:
            raise PermissionError("synthetic scope mismatch")
        resource = self.resources.get((version_id, relative_path))
        if resource is None:
            raise PermissionError("synthetic resource missing")
        return resource


@dataclass
class CountingSkillPort(InMemorySkillPort):
    catalog_calls: int = 0

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        self.catalog_calls += 1
        return super().catalog(scope)


@dataclass
class InMemoryReplyStore:
    def prepare_context(self, request: ReplyRequest, context: ReplyContext) -> None:
        if request.request_id != context.reply_request_id:
            raise AssertionError("合成上下文范围不一致。")

    prepared: ReplyContext

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
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
            ),
        )

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
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
            input_budget=reply.input_budget,
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


class SkillRuntimeResourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.direction = ConfirmedDirection(
            text="温和地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        self.command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, self.direction),
            skill=AutoSkill(),
        )
        self.prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=self.command,
            scope=self.scope,
            current_text="明天一起吃饭吗？",
            direction=self.direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="明天一起吃饭吗？",
                    scope=self.scope,
                ),
            ),
            skill_library_revision=4,
        )

    @staticmethod
    def _warm_entry() -> SkillCatalogEntry:
        return SkillCatalogEntry(
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            name="warm-reply",
            description="温和而明确地回应",
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
        )

    @staticmethod
    def _warm_version() -> SkillVersion:
        return SkillVersion(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            name="warm-reply",
            description="温和而明确地回应",
            content=(
                "---\nname: warm-reply\n---\nWARM_SECRET_BODY\n"
                "需要时读取 references/cases.md。\n"
            ),
            enabled=True,
            resource_paths=("references/cases.md",),
        )

    @staticmethod
    def _warm_case() -> SkillResource:
        content = "长案例：先确认再给边界。\n".encode("utf-8")
        return SkillResource(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            relative_path="references/cases.md",
            resource_kind="reference",
            media_type="text/markdown",
            content=content,
            content_sha256=_sha256(content),
        )

    def _generate(
        self,
        port: InMemorySkillPort | MultiSkillPort,
        model: ToolCallingFakeModel,
    ) -> ReplyGenerated:
        store = InMemoryReplyStore(self.prepared)
        generator = ReplyGenerator(
            store=store,
            runtime=LangChainReplyRuntime(model=model, skill_port=port, **synthetic_budget_kwargs(model)),
            context=RecordingReplyContext(prepared=self.prepared),
        )
        return generator.generate(self.command, verified_scope=VERIFIED_SCOPE)

    @staticmethod
    def _seen_context(model: ToolCallingFakeModel) -> str:
        return "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )

    def test_loads_skilled_resource_on_demand_and_records_path(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry,),
            ),
            version=self._warm_version(),
            resources={"references/cases.md": self._warm_case()},
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_PATH, "limit": 1000},
                            "id": "read-skill-md",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_CASE_PATH, "limit": 1000},
                            "id": "read-resource",
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
                                        "basis": "结合长案例温和回应",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": str(VERSION_ID),
                            },
                            "id": "result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertEqual(result.candidates[0].text, "可以呀，明天见。")
        self.assertIsNotNone(result.used_skill)
        self.assertEqual(result.used_skill.version_id, VERSION_ID)
        self.assertEqual(result.used_skill.selection_method, "auto")
        self.assertTrue(result.used_skill.selection_reason)
        self.assertEqual(
            result.used_skill.resource_paths,
            ("references/cases.md",),
        )
        self.assertEqual(result.used_skill.load_state, "loaded")
        seen = self._seen_context(model)
        self.assertIn("长案例：先确认再给边界。", seen)
        self.assertNotIn("send_message", model.bound_tool_names)

    def test_invalid_resource_feedback_stops_model_retry_loop(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(self.scope, 4, (warm_entry,)),
            version=self._warm_version(),
            resources={},
        )
        model = ResourceRetryModel(responses=[])

        result = self._generate(port, model)

        self.assertEqual(result.candidates[0].text, "先这样回复。")
        self.assertIsNone(result.used_skill)
        self.assertLessEqual(len(model.seen_calls), 3)

    def test_loaded_skill_version_is_inferred_when_provider_returns_null(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(self.scope, 4, (warm_entry,)),
            version=self._warm_version(),
            resources={},
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_PATH},
                            "id": "read-skill-before-null-version",
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
                                        "basis": "结合已读取的回复策略",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": "null",
                            },
                            "id": "null-version-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertIsNotNone(result.used_skill)
        self.assertEqual(result.used_skill.version_id, VERSION_ID)
        self.assertEqual(result.used_skill.load_state, "loaded")

    def test_user_skill_choice_is_recorded_as_user_selection(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(self.scope, 4, (warm_entry,)),
            version=self._warm_version(),
            resources={},
        )
        command = replace(
            self.command,
            skill=UserSkillChoice(version_id=VERSION_ID),
        )
        prepared = replace(self.prepared, command=command)
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_PATH},
                            "id": "read-user-selected-skill",
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
                                        "basis": "用户选择的回复策略",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": str(VERSION_ID),
                            },
                            "id": "user-selected-result",
                        }
                    ],
                ),
            ]
        )
        result = ReplyGenerator(
            store=InMemoryReplyStore(prepared),
            runtime=LangChainReplyRuntime(model=model, skill_port=port, **synthetic_budget_kwargs(model)),
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertIsNotNone(result.used_skill)
        self.assertEqual(result.used_skill.selection_method, "user")
        self.assertIn("用户明确选择", result.used_skill.selection_reason)

    def test_resource_before_skill_load_falls_back_to_no_skill(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry,),
            ),
            version=self._warm_version(),
            resources={"references/cases.md": self._warm_case()},
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_CASE_PATH, "limit": 1000},
                            "id": "read-resource-first",
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
                                        "basis": "直接回复",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "no-skill-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertIsNone(result.used_skill)
        self.assertNotIn("长案例", self._seen_context(model))

    def test_cross_contact_resource_never_reaches_model(self) -> None:
        warm_entry = self._warm_entry()
        leaked_case = SkillResource(
            owner_id=OWNER_ID,
            contact_id=OTHER_CONTACT_ID,
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            relative_path="references/cases.md",
            resource_kind="reference",
            media_type="text/markdown",
            content="LEAKED_RESOURCE_SECRET".encode("utf-8"),
            content_sha256=_sha256("LEAKED_RESOURCE_SECRET".encode("utf-8")),
        )
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry,),
            ),
            version=SkillVersion(
                OWNER_ID,
                CONTACT_ID,
                SKILL_ID,
                VERSION_ID,
                "warm-reply",
                "温和而明确地回应",
                "---\nname: warm-reply\n---\nWARM_SECRET_BODY\n",
                True,
                ("references/cases.md",),
            ),
            resources={"references/cases.md": leaked_case},
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_PATH, "limit": 1000},
                            "id": "read-md",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_CASE_PATH, "limit": 1000},
                            "id": "read-leaked-resource",
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
                                        "basis": "结合当前联系人回复",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": str(VERSION_ID),
                            },
                            "id": "fallback-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        seen = self._seen_context(model)
        self.assertIsNone(result.used_skill)
        self.assertNotIn("LEAKED_RESOURCE_SECRET", seen)

    def test_resource_of_a_second_skill_is_rejected(self) -> None:
        direct_entry = SkillCatalogEntry(
            skill_id=OTHER_SKILL_ID,
            version_id=OTHER_VERSION_ID,
            name="direct-reply",
            description="直接回应",
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
        )
        warm_entry = self._warm_entry()
        direct_version = SkillVersion(
            OWNER_ID,
            CONTACT_ID,
            OTHER_SKILL_ID,
            OTHER_VERSION_ID,
            "direct-reply",
            "直接回应",
            "---\nname: direct-reply\n---\nDIRECT_SECOND_BODY\n",
            True,
            ("assets/template.txt",),
        )
        template = SkillResource(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            skill_id=OTHER_SKILL_ID,
            version_id=OTHER_VERSION_ID,
            relative_path="assets/template.txt",
            resource_kind="asset",
            media_type="text/plain",
            content="DIRECT_TEMPLATE_SECRET".encode("utf-8"),
            content_sha256=_sha256("DIRECT_TEMPLATE_SECRET".encode("utf-8")),
        )
        port = MultiSkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry, direct_entry),
            ),
            versions={
                VERSION_ID: self._warm_version(),
                OTHER_VERSION_ID: direct_version,
            },
            resources={
                (OTHER_VERSION_ID, "assets/template.txt"): template,
            },
        )
        store = InMemoryReplyStore(self.prepared)
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": WARM_PATH, "limit": 1000},
                            "id": "read-warm",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {
                                "file_path": DIRECT_TEMPLATE_PATH,
                                "limit": 1000,
                            },
                            "id": "read-second-resource",
                        }
                    ],
                ),
            ]
        )

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=LangChainReplyRuntime(model=model, skill_port=port, **synthetic_budget_kwargs(model)),
                context=RecordingReplyContext(prepared=self.prepared),
            ).generate(self.command, verified_scope=VERIFIED_SCOPE)

        seen = self._seen_context(model)
        self.assertIn("WARM_SECRET_BODY", seen)
        self.assertNotIn("DIRECT_TEMPLATE_SECRET", seen)
        self.assertNotIn("DIRECT_SECOND_BODY", seen)

    def test_arbitrary_server_path_or_external_url_is_rejected(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry,),
            ),
            version=self._warm_version(),
            resources={"references/cases.md": self._warm_case()},
        )
        model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {
                                "file_path": "/etc/passwd",
                                "limit": 1000,
                            },
                            "id": "read-etc",
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
                                        "basis": "直接回复",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "no-skill-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertIsNone(result.used_skill)
        seen = self._seen_context(model)
        self.assertNotIn("root:", seen)
        self.assertNotIn("/etc/passwd", result.candidates[0].text)

    def test_revision_mismatch_falls_back_to_no_skill(self) -> None:
        warm_entry = self._warm_entry()
        port = InMemorySkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                99,
                (warm_entry,),
            ),
            version=self._warm_version(),
            resources={"references/cases.md": self._warm_case()},
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
                                        "text": "可以呀，明天见。",
                                        "basis": "目录过期，未使用 Skill",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "expired-catalog-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertIsNone(result.used_skill)
        seen = self._seen_context(model)
        self.assertNotIn("WARM_SECRET_BODY", seen)
        self.assertNotIn("长案例", seen)
        self.assertNotIn("warm-reply", " ".join(model.bound_tool_names))

    def test_catalog_fetch_failure_falls_back_to_no_skill(self) -> None:
        warm_entry = self._warm_entry()

        class BrokenCatalogPort(InMemorySkillPort):
            def catalog(self, scope: ContactScope) -> SkillCatalog:
                del scope
                raise RuntimeError("synthetic catalog outage")

        port = BrokenCatalogPort(
            scope=self.scope,
            catalog_value=SkillCatalog(
                self.scope,
                4,
                (warm_entry,),
            ),
            version=self._warm_version(),
            resources={"references/cases.md": self._warm_case()},
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
                                        "text": "可以呀，明天见。",
                                        "basis": "目录读取失败，未使用 Skill",
                                        "citation_ids": [str(MESSAGE_ID)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "outage-result",
                        }
                    ],
                ),
            ]
        )

        result = self._generate(port, model)

        self.assertIsNone(result.used_skill)
        self.assertEqual(result.candidates[0].text, "可以呀，明天见。")

    def test_catalog_cache_reuses_only_the_same_scope_and_revision(self) -> None:
        warm_entry = self._warm_entry()
        port = CountingSkillPort(
            scope=self.scope,
            catalog_value=SkillCatalog(self.scope, 4, (warm_entry,)),
            version=self._warm_version(),
        )

        def result_message(identifier: str) -> AIMessage:
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "ReplyRuntimeOutput",
                        "args": {
                            "candidates": [
                                {
                                    "text": "可以呀，明天见。",
                                    "basis": "默认策略",
                                    "citation_ids": [str(MESSAGE_ID)],
                                    "risk_notes": [],
                                }
                            ],
                            "used_skill_version_id": None,
                        },
                        "id": identifier,
                    }
                ],
            )

        model = ToolCallingFakeModel(
            responses=[
                result_message("cached-result-1"),
                result_message("cached-result-2"),
                result_message("revision-result"),
            ]
        )
        runtime = LangChainReplyRuntime(model=model, skill_port=port, **synthetic_budget_kwargs(model))

        runtime.generate(self.prepared)
        runtime.generate(self.prepared)
        self.assertEqual(port.catalog_calls, 1)

        port.catalog_value = SkillCatalog(self.scope, 5, (warm_entry,))
        runtime.generate(replace(self.prepared, skill_library_revision=5))
        self.assertEqual(port.catalog_calls, 2)


if __name__ == "__main__":
    unittest.main()
