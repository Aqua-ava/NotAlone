"""候选回复服务的常驻后端装配（薄壳接线）。

只做适配器组装，不包含业务逻辑：会话验证用既有 PostgresConversationPort
（观察来自已确认绑定），回复生成用既有 ReplyGenerator（DeepSeek 运行时、
Postgres 技能库、Postgres 存储与出站台账）。
"""

from __future__ import annotations

from uuid import UUID

import psycopg

from notalone.application.reply_service import ReplyService
from notalone.conversation.models import (
    ConversationBinding,
    ConversationObservation,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator


def build_reply_service(*, database_url: str, owner_id: UUID) -> ReplyService | None:
    """有 active 绑定且模型凭据可用时装配回复服务；否则返回 None。

    回复端点不可用时返回 503 reply_unavailable。
    """

    try:
        model = build_deepseek_model()
    except (ValueError, OSError):
        return None
    skill_revision = _skill_library_revision(database_url, owner_id)
    retrieval = PostgresRetrieval(database_url)
    context = RetrievalReplyContext(
        retrieval=retrieval,
        memory_index=PostgresContactMemoryIndexRepository(database_url),
        skill_library_revision=skill_revision,
    )
    generator = ReplyGenerator(
        store=PostgresReplyStore(database_url),
        runtime=LangChainReplyRuntime(
            model=model,
            skill_port=PostgresSkillPort(database_url),
        ),
        context=context,
        ledger=PostgresOutboundLedger(database_url),
    )
    return ReplyService(
        binding_lookup=_active_binding_lookup(database_url),
        conversation_factory=lambda binding: PostgresConversationPort(
            database_url,
            owner_id=owner_id,
            observation=ConversationObservation.confirmed(binding.binding_id),
        ),
        reply=generator,
    )


def _active_binding_lookup(database_url: str):
    repository = PostgresConversationBindingRepository(database_url)

    def lookup(owner_id: UUID, contact_id: UUID) -> ConversationBinding | None:
        bindings = repository.list_active_bindings(owner_id=owner_id)
        return next(
            (
                binding.as_domain()
                for binding in bindings
                if binding.scope.contact_id == contact_id
            ),
            None,
        )

    return lookup


def _skill_library_revision(database_url: str, owner_id: UUID) -> int:
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT revision
            FROM public.skill_library
            WHERE owner_id = %s
            """,
            (owner_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO public.skill_library (owner_id, revision) "
                "VALUES (%s, 0)",
                (owner_id,),
            )
            return 0
        return row[0]
