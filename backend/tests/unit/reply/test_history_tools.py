"""验证候选回复的 L0 历史 Tool 隔离、预算和同轮证据。"""

from __future__ import annotations

import json
import asyncio
import unittest
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import Runnable

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ContextEvidence, ReplyContext, ReplyContextInvariantError
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.reply.tools import HistoryToolAccess
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("33333333-3333-3333-3333-333333333333")
BINDING_ID = UUID("44444444-4444-4444-4444-444444444444")
SOURCE_ID = UUID("55555555-5555-5555-5555-555555555555")
MESSAGE_IDS = tuple(
    UUID(f"66666666-6666-6666-6666-{index:012d}")
    for index in range(1, 6)
)


class EmptySkillPort:
    def catalog(self, scope: ContactScope) -> SkillCatalog:
        return SkillCatalog(scope, 0, ())

    def load_version(self, scope: ContactScope, version_id: UUID) -> object:
        del scope, version_id
        raise PermissionError("synthetic empty skill catalog")

    def load_resource(
        self,
        scope: ContactScope,
        version_id: UUID,
        relative_path: str,
    ) -> object:
        del scope, version_id, relative_path
        raise PermissionError("synthetic empty skill catalog")


class HistoryToolFakeModel(FakeMessagesListChatModel):
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

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        # 异步模型调用仍经过同一合成行为，保留来源变更等测试注入。
        return await asyncio.to_thread(
            self._generate, messages, stop, run_manager, **kwargs,
        )


class HistoryToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        base = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
        self.retrieval = InMemoryRetrieval(
            messages=tuple(
                RetrievedMessage(
                    message_id=message_id,
                    scope=self.scope,
                    text=text,
                    source_ids=(SOURCE_ID,),
                    occurred_at=base + timedelta(minutes=index),
                    role="contact" if index % 2 == 0 else "owner",
                )
                for index, (message_id, text) in enumerate(
                    zip(
                        MESSAGE_IDS,
                        (
                            "很久以前我们讨论过旅行计划",
                            "后来把出发时间改到周六",
                            "当前消息没有历史事实",
                            "又确认了住宿地点",
                            "最近在整理行程",
                        ),
                        strict=True,
                    )
                )
            )
        )

    def _access(self, *, max_calls: int = 3) -> HistoryToolAccess:
        return HistoryToolAccess(
            retrieval=self.retrieval,
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            max_calls=max_calls,
        )

    def test_search_returns_restricted_raw_evidence_metadata(self) -> None:
        access = self._access()

        payload = json.loads(
            access.search(query="旅行计划", top_k=2, timeout_ms=500)
        )

        self.assertEqual(payload["status"], "ok")
        self.assertFalse(payload["executable"])
        self.assertTrue(payload["not_found_is_not_evidence"])
        self.assertEqual(len(payload["messages"]), 1)
        message = payload["messages"][0]
        self.assertEqual(message["message_id"], str(MESSAGE_IDS[0]))
        self.assertEqual(message["role"], "contact")
        self.assertEqual(message["session_id"], str(BINDING_ID))
        self.assertEqual(message["source_ids"], [str(SOURCE_ID)])
        self.assertEqual(message["occurred_at"], "2026-09-01T12:00:00+00:00")
        self.assertEqual(
            access.evidence[0].timing.source_started_at,
            datetime(2026, 9, 1, 12, tzinfo=timezone.utc),
        )
        self.assertTrue(access.evidence[0].timing.source_time_complete)
        self.assertIsNone(access.evidence[0].timing.recorded_at)
        self.assertEqual(
            tuple(item.evidence_id for item in access.evidence),
            (MESSAGE_IDS[0],),
        )
        self.assertEqual(access.tool_calls[0].status, "succeeded")

    def test_query_requires_session_and_reads_only_after_search_anchor(self) -> None:
        access = self._access()
        access.search(query="旅行计划")

        payload = json.loads(
            access.query(
                session_id=str(BINDING_ID),
                anchor_message_id=str(MESSAGE_IDS[0]),
                before=0,
                after=2,
            )
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(
            [item["message_id"] for item in payload["messages"]],
            [str(MESSAGE_IDS[index]) for index in range(3)],
        )
        self.assertEqual(
            [item.evidence_id for item in access.evidence],
            list(MESSAGE_IDS[:3]),
        )

    def test_wrong_session_is_rejected_before_history_query(self) -> None:
        access = self._access()

        with self.assertRaises(ReplyContextInvariantError):
            access.query(
                session_id=str(UUID("99999999-9999-9999-9999-999999999999")),
            )

        self.assertEqual(access.tool_calls, ())

    def test_total_tool_calls_are_capped_and_failure_is_non_factual(self) -> None:
        access = self._access()
        for _ in range(3):
            access.search(query="旅行计划")

        payload = json.loads(access.search(query="旅行计划"))

        self.assertEqual(payload["status"], "budget_exceeded")
        self.assertEqual(payload["messages"], [])
        self.assertTrue(payload["not_found_is_not_evidence"])
        # 预算耗尽的返回必须带可操作的停止指令，否则模型会继续重试
        # 历史检索并耗尽运行步骤上限（issue 02）。
        self.assertIn("禁止再调用任何历史工具", payload["guidance"])
        self.assertEqual(len(access.tool_calls), 4)
        self.assertEqual(access.tool_calls[-1].status, "budget_exceeded")

    def test_history_evidence_count_is_capped_independently_from_tokens(self) -> None:
        base = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
        messages = tuple(
            RetrievedMessage(
                message_id=uuid4(),
                scope=self.scope,
                text=f"{group} {index}",
                source_ids=(SOURCE_ID,),
                occurred_at=base + timedelta(minutes=offset),
                role="contact",
            )
            for offset, (group, index) in enumerate(
                (group, index)
                for group in ("甲组", "乙组", "丙组")
                for index in range(8)
            )
        )
        access = HistoryToolAccess(
            retrieval=InMemoryRetrieval(messages=messages),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
        )

        first = json.loads(access.search(query="甲组", top_k=8))
        second = json.loads(access.search(query="乙组", top_k=8))
        third = json.loads(access.search(query="丙组", top_k=8))

        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "ok")
        self.assertEqual(third["status"], "budget_exceeded")
        self.assertEqual(len(access.evidence), 16)

    def test_empty_search_returns_actionable_guidance(self) -> None:
        access = self._access()

        payload = json.loads(access.search(query="不存在的合成关键词"))

        self.assertEqual(payload["status"], "empty")
        self.assertEqual(payload["messages"], [])
        self.assertIn("不是继续搜索的理由", payload["guidance"])

    def test_retrieval_failure_returns_safe_status_without_evidence(self) -> None:
        class BrokenRetrieval(InMemoryRetrieval):
            def search_messages(self, **kwargs: object) -> tuple[RetrievedMessage, ...]:
                del kwargs
                raise RuntimeError("synthetic retrieval outage")

        access = HistoryToolAccess(
            retrieval=BrokenRetrieval(messages=self.retrieval.messages),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
        )

        payload = json.loads(access.search(query="旅行计划"))

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["messages"], [])
        self.assertEqual(access.evidence, ())
        self.assertEqual(access.tool_calls[0].status, "failed")

    def test_langchain_runtime_keeps_tool_result_in_same_turn_evidence(self) -> None:
        current_id, historical_id = MESSAGE_IDS[:2]
        command = GenerateReply(
            idempotency_key=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(
                current_id,
                ConfirmedDirection("自然回复", DirectionSource.DIRECT_INPUT),
            ),
        )
        prepared = ReplyContext(
            reply_request_id=UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
            command=command,
            scope=self.scope,
            current_text="当前消息",
            direction=command.content.direction,
            evidence=(
                ContextEvidence(
                    current_id,
                    "message",
                    "当前消息",
                    self.scope,
                    (SOURCE_ID,),
                    "待回复消息。",
                ),
            ),
            skill_library_revision=0,
        )
        model = HistoryToolFakeModel(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "conversation_search",
                            "args": {"query": "旅行计划", "top_k": 2},
                            "id": "history-search",
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
                                        "text": "记得那次旅行，我们再确认一下。",
                                        "basis": "本轮历史搜索证据",
                                        "citation_ids": [str(historical_id)],
                                        "risk_notes": [],
                                    }
                                ],
                                "used_skill_version_id": None,
                            },
                            "id": "history-result",
                        }
                    ],
                ),
            ]
        )
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    current_id,
                    self.scope,
                    "当前消息",
                    (SOURCE_ID,),
                    role="contact",
                ),
                RetrievedMessage(
                    historical_id,
                    self.scope,
                    "旧日旅行计划",
                    (SOURCE_ID,),
                    role="owner",
                ),
            )
        )

        result = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(),
            retrieval=retrieval,
        ).generate(prepared)

        self.assertIn("conversation_search", model.bound_tool_names)
        self.assertIn("conversation_query", model.bound_tool_names)
        self.assertEqual(result.candidates[0].citation_ids, (historical_id,))
        self.assertEqual(
            tuple(item.evidence_id for item in result.additional_evidence),
            (historical_id,),
        )
        self.assertEqual(result.tool_calls[0].status, "succeeded")
        self.assertIn("旧日旅行计划", "\n".join(
            str(message.content)
            for call in model.seen_calls
            for message in call
        ))


if __name__ == "__main__":
    unittest.main()
