"""联系人范围检索的公共接口。"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol
from uuid import UUID

from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.scopes import ContactScope


class RetrievalPort(Protocol):
    """只负责查询，不拥有消息或关系记忆的生命周期。"""

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        message_ids: tuple[UUID, ...] | None = None,
        query: str | None = None,
        limit: int = 50,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        """查询指定联系人范围内的消息；复验可用 ``message_ids`` 限定集合。"""

    def query_messages(
        self,
        *,
        scope: ContactScope,
        anchor_message_id: UUID | None = None,
        before: int = 3,
        after: int = 3,
        limit: int = 20,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        """按时间顺序读取当前联系人范围内的有限消息窗口。"""

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
        include_historical: bool = False,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        """本人记忆；历史读取只接受合法概览的有界 ``memory_ids``，仍核验来源。"""

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
        include_historical: bool = False,
    ) -> tuple[RetrievedMemory, ...]:
        """查询指定联系人范围内当前有效的已确认关系记忆。

        ``memory_ids`` 只接受来自 L2 目录的导航结果；返回值仍必须重新
        从 L1 权威存储读取并完成状态、来源和范围校验。
        ``include_historical`` 只用于合法概览导航及其复验，必须同时限定 ID；
        返回实际旧版本，不能解析成当前叶或把历史内容当作当前事实。
        """

    def search_pending_candidates(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 3,
        candidate_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        """查询指定联系人范围内仍待用户确认的记忆候选。

        这条轨只承载 ``pending`` 候选，独立于已确认记忆集合；结果只能
        作为带未确认标注的参考，不代表候选正文已经是事实。来源失效、
        状态变化或超出有效期的候选必须返回空。``candidate_ids`` 只用于
        复验快照中已注入的候选。
        """
