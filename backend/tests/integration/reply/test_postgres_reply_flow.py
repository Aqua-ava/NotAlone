"""验证已确认会话到 PostgreSQL 候选回复的端到端边界。"""

from __future__ import annotations

import os
import asyncio
import unittest
from collections.abc import Sequence
from dataclasses import replace
from typing import Any
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import Runnable

from notalone.application import CandidateReplyFlow
from notalone.conversation import (
    ConversationObservation,
    ConversationObservationState,
    ConversationResolutionState,
    VerificationReason,
)
from notalone.memory import (
    AdoptionMethod,
    FactSubject,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.persistence.skill_directory import synchronize_skill_library
from notalone.reply import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyIdempotencyConflictError,
    ReplyGenerator,
    ReplyRunError,
    ReplyToMessage,
    RetrievalReplyContext,
    RewriteDraft,
)
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.retrieval import (
    InMemoryRetrieval,
    RetrievedMessage,
    RetrievedOwnerMemory,
)
from notalone.scopes import ContactScope
from tests.input_budget_support import SyntheticBudgetModel, synthetic_budget_kwargs


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ToolCallingFakeModel(SyntheticBudgetModel):
    """只模拟读取 Skill 和返回结构化候选，不连接外部模型。"""

    bound_tool_names: list[str] = []
    seen_calls: list[list[BaseMessage]] = []

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.bound_tool_names = []
        self.seen_calls = []

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        self.bound_tool_names = [
            getattr(item, "name", getattr(item, "__name__", ""))
            for item in tools
        ]
        return super().bind_tools(tools, tool_choice=tool_choice, **kwargs)

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


class PostgresReplyFlowTest(unittest.TestCase):
    """只使用随机 owner/contact 和匿名合成消息、记忆、Skill。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                required_tables = connection.execute(
                    """
                    SELECT count(*)
                    FROM pg_class
                    WHERE relnamespace = 'public'::regnamespace
                      AND relname = ANY(%s)
                    """,
                    ([
                        "conversation_binding",
                        "reply_request",
                        "reply_skill",
                        "reply_skill_version",
                    ],),
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error

        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if required_tables != 4:
            raise unittest.SkipTest("测试库尚未应用 006-008 迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.binding_id = uuid4()
        self.target_message_id = uuid4()
        self.recent_message_id = uuid4()
        self.source_id = uuid4()
        self.memory_candidate_id = uuid4()
        self.owner_memory_id = uuid4()
        self.draft_evidence_id = uuid4()
        self.skill_id = uuid4()
        self.skill_version_id = uuid4()
        self.request_key = uuid4()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (self.owner_id, "合成端到端用户"),
                )
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成端到端联系人"),
                        (self.owner_id, self.other_contact_id, "另一合成联系人"),
                    ),
                )
                cursor.execute(
                    "INSERT INTO public.skill_library (owner_id, revision) "
                    "VALUES (%s, %s)",
                    (self.owner_id, 7),
                )
                cursor.execute(
                    """
                    INSERT INTO public.reply_skill (
                        id, owner_id, contact_id, name, description, status
                    )
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    """,
                    (
                        self.skill_id,
                        self.owner_id,
                        self.contact_id,
                        "warm-reply",
                        "温和而明确地回应当前消息",
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO public.reply_skill_version (
                        id, skill_id, version_number, name, description,
                        content, enabled, is_current, status
                    )
                    VALUES (%s, %s, 1, %s, %s, %s, TRUE, TRUE, 'active')
                    """,
                    (
                        self.skill_version_id,
                        self.skill_id,
                        "warm-reply",
                        "温和而明确地回应当前消息",
                        "先回应对方，再给出明确且自然的答复。",
                    ),
                )
                # 内存检索仍使用同一合成资料；持久化守卫需核实实际原始来源和消息引用。
                cursor.execute(
                    "INSERT INTO public.source_document "
                    "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                    "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-reply-flow.jsonl',%s,2)",
                    (self.source_id, self.owner_id, self.contact_id, self.source_id.hex * 2),
                )
                cursor.executemany(
                    "INSERT INTO public.message "
                    "(id,owner_id,contact_id,speaker,message_type,text_content) "
                    "VALUES (%s,%s,%s,'contact','text',%s)",
                    (
                        (self.target_message_id, self.owner_id, self.contact_id, "明天一起吃饭吗？"),
                        (self.recent_message_id, self.owner_id, self.contact_id, "上次说过想找时间见面。"),
                    ),
                )
                cursor.executemany(
                    "INSERT INTO public.message_source_ref "
                    "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,'source_document',%s,%s,'{}')",
                    (
                        (message_id, self.owner_id, self.contact_id, self.source_id, f"synthetic-{index}")
                        for index, message_id in enumerate((self.target_message_id, self.recent_message_id), 1)
                    ),
                )

        # 旧库正文迁移由显式同步入口完成；SkillPort 读取本身不再迁移或写文件。
        synchronize_skill_library(TEST_DATABASE_URL, self.owner_id)

        self.binding_repository = PostgresConversationBindingRepository(
            TEST_DATABASE_URL
        )
        binding = self.binding_repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator=f"synthetic-conversation-{self.binding_id}",
            binding_id=self.binding_id,
        )
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        self.memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=self.memory_candidate_id,
                scope=self.scope,
                text="对方喜欢提前约吃饭。",
                category=MemoryCategory.PREFERENCE,
                source_ids=(self.source_id,),
            )
        )
        self.memory = self.memory_store.confirm(
            scope=self.scope,
            candidate_id=self.memory_candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        owner_candidate = self.memory_store.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text="我明天有空。",
            category=MemoryCategory.RECENT_STATE, subject=FactSubject.SELF,
            source_ids=(self.source_id,),
        ))
        owner_memory = PostgresOwnerMemoryStore(TEST_DATABASE_URL).confirm_candidate(candidate=owner_candidate)
        self.owner_memory_id = owner_memory.memory_id
        self.retrieval = InMemoryRetrieval(
            owner_memories=(
                RetrievedOwnerMemory(
                    memory_id=self.owner_memory_id,
                    owner_id=self.owner_id,
                    text="我明天有空。",
                    category="recent_state",
                    topic="other",
                    source_ids=owner_memory.source_ids,
                    adoption_method="manual",
                    revision=1,
                    valid_at=owner_memory.valid_at,
                    invalid_at=owner_memory.invalid_at,
                    timing=owner_memory.timing,
                ),
            ),
            messages=(
                RetrievedMessage(
                    message_id=self.target_message_id,
                    scope=self.scope,
                    text="明天一起吃饭吗？",
                    source_ids=(self.source_id,),
                ),
                RetrievedMessage(
                    message_id=self.recent_message_id,
                    scope=self.scope,
                    text="上次说过想找时间见面。",
                    source_ids=(self.source_id,),
                ),
            ),
            memory_store=self.memory_store,
        )
        self.context = RetrievalReplyContext(
            retrieval=self.retrieval,
            skill_library_revision=7,
            id_factory=lambda: self.draft_evidence_id,
        )
        self.model = ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {
                                "file_path": (
                                    "/notalone/reply-skills/"
                                    "warm-reply/SKILL.md"
                                ),
                                "offset": 0,
                                "limit": 1000,
                            },
                            "id": "read-synthetic-skill",
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
                                        "basis": "回应当前消息并保持自然",
                                        "citation_ids": [
                                            str(self.target_message_id)
                                        ],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": str(
                                    self.skill_version_id
                                ),
                            },
                            "id": "return-synthetic-candidate",
                        }
                    ],
                ),
            ]
        )
        self.store = PostgresReplyStore(TEST_DATABASE_URL)
        self.generator = self._generator(self.model, self.store)
        self.flow = CandidateReplyFlow(
            conversation=PostgresConversationPort(
                TEST_DATABASE_URL,
                owner_id=self.owner_id,
                observation=ConversationObservation.confirmed(binding.binding_id),
            )
        )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _command(self) -> GenerateReply:
        return GenerateReply(
            idempotency_key=self.request_key,
            scope=self.scope,
            conversation_binding_id=self.binding_id,
            content=ReplyToMessage(
                target_message_id=self.target_message_id,
                direction=ConfirmedDirection(
                    text="自然地答应，并保持轻松",
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
        )

    def _generator(
        self,
        model: ToolCallingFakeModel,
        store: PostgresReplyStore,
    ) -> ReplyGenerator:
        return ReplyGenerator(
            store=store,
            runtime=LangChainReplyRuntime(
                model=model,
                skill_port=PostgresSkillPort(TEST_DATABASE_URL),
                **synthetic_budget_kwargs(model),
            ),
            context=self.context,
        )

    def test_confirmed_message_reply_is_saved_before_flow_returns(self) -> None:
        result = self.flow.execute(
            reply=self.generator,
            command=self._command(),
        )

        self.assertEqual(result.verification.reason.value, "active_binding")
        self.assertIsNotNone(result.reply)
        assert result.reply is not None
        self.assertEqual(result.reply.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(result.reply.used_skill.version_id, self.skill_version_id)
        self.assertEqual(
            set(self.model.bound_tool_names),
            {"read_file", "ReplyRuntimeOutput"},
        )
        self.assertNotIn("send_message", self.model.bound_tool_names)

        stored = self.store.read(result.reply.reply_request_id, self.scope)
        self.assertEqual(stored.result, result.reply)
        self.assertEqual(stored.evidence[0].evidence_id, self.target_message_id)
        self.assertIn(
            self.memory.memory_id,
            {item.evidence_id for item in stored.evidence},
        )
        owner_evidence = {
            item.evidence_id: item.kind
            for item in stored.evidence
        }
        self.assertEqual(
            owner_evidence.get(self.owner_memory_id),
            "owner_memory",
        )

        calls_before_replay = len(self.model.seen_calls)
        replayed = self.flow.execute(
            reply=self.generator,
            command=self._command(),
        )
        self.assertEqual(replayed.reply, result.reply)
        self.assertEqual(len(self.model.seen_calls), calls_before_replay)

        conflicting_command = replace(
            self._command(),
            content=ReplyToMessage(
                target_message_id=self.target_message_id,
                direction=ConfirmedDirection(
                    text="拒绝邀请，但保持礼貌",
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
        )
        with self.assertRaises(ReplyIdempotencyConflictError):
            self.flow.execute(
                reply=self.generator,
                command=conflicting_command,
            )

    def _pending_candidate(self, text: str) -> MemoryCandidate:
        return self.memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=self.scope,
                text=text,
                category=MemoryCategory.RECENT_STATE,
                source_ids=(self.source_id,),
            )
        )

    def _reply_model_citing(self, *citation_ids: UUID) -> ToolCallingFakeModel:
        return ToolCallingFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ReplyRuntimeOutput",
                            "args": {
                                "candidates": [
                                    {
                                        "text": "听说你明天可能没空，那改天一起吃饭？",
                                        "basis": "对未确认候选只做确认式提问",
                                        "citation_ids": [
                                            str(citation_id)
                                            for citation_id in citation_ids
                                        ],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "return-pending-aware-candidate",
                        }
                    ],
                ),
            ]
        )

    def _model_evidence(self, model: ToolCallingFakeModel) -> list[dict[str, Any]]:
        import json

        return next(
            json.loads(message.content)["evidence"]
            for call in model.seen_calls
            for message in call
            if message.type == "human"
        )

    def test_pending_candidate_reaches_model_as_unconfirmed_and_persists(self) -> None:
        pending = self._pending_candidate("对方说明天可能没空一起吃饭。")
        model = self._reply_model_citing(self.target_message_id, pending.candidate_id)

        result = self.flow.execute(
            reply=self._generator(model, self.store),
            command=self._command(),
        )

        assert result.reply is not None
        evidence = self._model_evidence(model)
        pending_payload = next(
            item for item in evidence if item["kind"] == "pending_candidate"
        )
        self.assertEqual(pending_payload["status"], "pending")
        self.assertIn("未确认", pending_payload["selection_reason"])
        self.assertIn("不得当作事实", pending_payload["selection_reason"])

        stored = self.store.read(result.reply.reply_request_id, self.scope)
        pending_evidence = next(
            item for item in stored.evidence if item.kind == "pending_candidate"
        )
        self.assertEqual(pending_evidence.evidence_id, pending.candidate_id)
        self.assertEqual(pending_evidence.status, "pending")
        self.assertIn(pending.candidate_id, result.reply.candidates[0].citation_ids)

    def test_rejected_candidate_never_reaches_model_input(self) -> None:
        pending = self._pending_candidate("对方说明天可能没空一起吃饭。")
        self.memory_store.reject_candidate(
            scope=self.scope,
            candidate_id=pending.candidate_id,
        )
        model = self._reply_model_citing(self.target_message_id)

        result = self.flow.execute(
            reply=self._generator(model, self.store),
            command=self._command(),
        )

        assert result.reply is not None
        self.assertNotIn(
            "pending_candidate",
            {item["kind"] for item in self._model_evidence(model)},
        )
        stored = self.store.read(result.reply.reply_request_id, self.scope)
        self.assertNotIn(
            "pending_candidate",
            {item.kind for item in stored.evidence},
        )

    def test_unverified_or_cross_contact_scope_stops_before_reply_runtime(self) -> None:
        for state, reason in (
            (
                ConversationObservationState.AMBIGUOUS,
                VerificationReason.AMBIGUOUS_MATCH,
            ),
            (
                ConversationObservationState.LOW_CONFIDENCE,
                VerificationReason.LOW_CONFIDENCE,
            ),
        ):
            with self.subTest(state=state):
                model = ToolCallingFakeModel(responses=[])
                flow = CandidateReplyFlow(
                    conversation=PostgresConversationPort(
                        TEST_DATABASE_URL,
                        owner_id=self.owner_id,
                        observation=ConversationObservation(
                            state=state,
                            binding_id=None,
                        ),
                    )
                )
                result = flow.execute(
                    reply=self._generator(
                        model,
                        PostgresReplyStore(TEST_DATABASE_URL),
                    ),
                    command=self._command(),
                )

                self.assertEqual(
                    result.verification.state,
                    ConversationResolutionState.NEEDS_USER_CONFIRMATION,
                )
                self.assertEqual(result.verification.reason, reason)
                self.assertIsNone(result.reply)
                self.assertEqual(model.seen_calls, [])

        cross_contact_command = replace(
            self._command(),
            scope=ContactScope(self.owner_id, self.other_contact_id),
        )
        cross_contact_model = ToolCallingFakeModel(responses=[])
        cross_contact_result = self.flow.execute(
            reply=self._generator(
                cross_contact_model,
                PostgresReplyStore(TEST_DATABASE_URL),
            ),
            command=cross_contact_command,
        )
        self.assertEqual(
            cross_contact_result.verification.reason,
            VerificationReason.SCOPE_MISMATCH,
        )
        self.assertIsNone(cross_contact_result.reply)
        self.assertEqual(cross_contact_model.seen_calls, [])

        self.binding_repository.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
        )
        revoked_model = ToolCallingFakeModel(responses=[])
        revoked_result = self.flow.execute(
            reply=self._generator(
                revoked_model,
                PostgresReplyStore(TEST_DATABASE_URL),
            ),
            command=self._command(),
        )
        self.assertEqual(
            revoked_result.verification.reason,
            VerificationReason.BINDING_REVOKED,
        )
        self.assertIsNone(revoked_result.reply)
        self.assertEqual(revoked_model.seen_calls, [])

    def test_failed_runtime_can_retry_same_request_and_persist_result(self) -> None:
        class FailingModel(ToolCallingFakeModel):
            def _generate(
                self,
                messages: list[BaseMessage],
                stop: list[str] | None = None,
                run_manager: Any = None,
                **kwargs: Any,
            ) -> Any:
                del stop, run_manager
                self.record_model_payload(messages, kwargs)
                raise RuntimeError("synthetic model failure")

        failing_generator = self._generator(
            FailingModel(responses=[]),
            PostgresReplyStore(TEST_DATABASE_URL),
        )
        with self.assertRaises(ReplyRunError):
            self.flow.execute(
                reply=failing_generator,
                command=self._command(),
            )

        retry_model = ToolCallingFakeModel(
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
                                        "basis": "重试后回应当前消息",
                                        "citation_ids": [
                                            str(self.target_message_id)
                                        ],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "return-retry-candidate",
                        }
                    ],
                )
            ]
        )
        retry_store = PostgresReplyStore(TEST_DATABASE_URL)
        retry_result = self.flow.execute(
            reply=self._generator(retry_model, retry_store),
            command=self._command(),
        )

        self.assertIsNotNone(retry_result.reply)
        assert retry_result.reply is not None
        stored = retry_store.read(retry_result.reply.reply_request_id, self.scope)
        self.assertEqual(
            tuple(attempt.state.value for attempt in stored.attempts),
            ("failed", "completed"),
        )

    def test_explicit_candidate_continuation_stays_in_same_scope(self) -> None:
        first_result = self.flow.execute(
            reply=self.generator,
            command=self._command(),
        )
        assert first_result.reply is not None
        candidate_id = first_result.reply.candidates[0].candidate_id
        continuation_key = uuid4()
        continuation_command = GenerateReply(
            idempotency_key=continuation_key,
            scope=self.scope,
            conversation_binding_id=self.binding_id,
            content=ReplyToMessage(
                target_message_id=self.target_message_id,
                direction=ConfirmedDirection(
                    text="把上一条改得更直接",
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
            continued_from_candidate_id=candidate_id,
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
                                        "text": "好，明天见。",
                                        "basis": "在用户选中的候选上继续改写",
                                        "citation_ids": [str(candidate_id)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "return-continuation-candidate",
                        }
                    ],
                )
            ]
        )
        store = PostgresReplyStore(TEST_DATABASE_URL)

        result = self.flow.execute(
            reply=self._generator(model, store),
            command=continuation_command,
        )

        self.assertIsNotNone(result.reply)
        assert result.reply is not None
        self.assertEqual(result.reply.candidates[0].text, "好，明天见。")
        stored = store.read(result.reply.reply_request_id, self.scope)
        self.assertIn(
            candidate_id,
            {item.evidence_id for item in stored.evidence},
        )

    def test_continuation_timeout_is_recorded_and_same_request_can_retry(self):
        from notalone.ledger.adapters import InMemoryOutboundLedger
        from notalone.reply.errors import ReplyTimeoutError
        from tests.unit.reply.test_runtime_limits import SlowModel

        first = self.flow.execute(reply=self.generator, command=self._command())
        command = replace(
            self._command(), idempotency_key=uuid4(),
            continued_from_candidate_id=first.reply.candidates[0].candidate_id,
        )
        model = SlowModel(responses=[AIMessage(content="合成迟到结果")])
        ledger = InMemoryOutboundLedger()
        generator = ReplyGenerator(
            store=self.store, context=self.context, ledger=ledger,
            runtime=LangChainReplyRuntime(
                model=model, skill_port=PostgresSkillPort(TEST_DATABASE_URL),
                timeout_seconds=0.05,
                **synthetic_budget_kwargs(model),
            ),
        )
        with self.assertRaises(ReplyTimeoutError):
            self.flow.execute(reply=generator, command=command)
        self.assertTrue(model.cancelled)
        self.assertEqual(
            [entry.outcome.value for entry in ledger.list_by_owner(self.owner_id)],
            ["run_failed"],
        )
        # 同一个幂等请求立即可重试，证明超时已退出 running；旧候选仍可继续。
        retried = self.flow.execute(reply=self.generator, command=command)
        stored = self.store.read(retried.reply.reply_request_id, self.scope)
        self.assertEqual(
            tuple(attempt.state.value for attempt in stored.attempts),
            ("failed", "completed"),
        )
        self.assertEqual(len(stored.result.candidates), 1)

    def test_rewrite_draft_uses_same_flow_without_long_term_memory(self) -> None:
        request_key = uuid4()
        command = GenerateReply(
            idempotency_key=request_key,
            scope=self.scope,
            conversation_binding_id=self.binding_id,
            content=RewriteDraft(
                draft_text="我明天有空，晚点见",
                user_instruction="更自然一点",
            ),
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
                                        "citation_ids": [str(self.draft_evidence_id)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "return-rewrite-candidate",
                        }
                    ],
                )
            ]
        )
        store = PostgresReplyStore(TEST_DATABASE_URL)
        generator = self._generator(model, store)

        result = self.flow.execute(reply=generator, command=command)

        self.assertIsNotNone(result.reply)
        assert result.reply is not None
        self.assertEqual(result.reply.candidates[0].text, "我明天有空，晚点见。")
        self.assertIsNone(result.reply.used_skill)
        stored = store.read(result.reply.reply_request_id, self.scope)
        self.assertEqual(
            tuple(item.kind for item in stored.evidence),
            ("user_draft",),
        )
        seen_context = "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        )
        self.assertIn('"input_mode": "rewrite_draft"', seen_context)
        self.assertIn('"user_instruction": "更自然一点"', seen_context)
        self.assertNotIn("对方喜欢提前约时间", seen_context)


if __name__ == "__main__":
    unittest.main()
