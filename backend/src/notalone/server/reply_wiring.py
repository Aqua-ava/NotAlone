"""候选回复服务的常驻后端装配（薄壳接线）。

只做适配器组装，不包含业务逻辑：会话验证用既有 PostgresConversationPort
（观察来自已确认绑定），回复生成用既有 ReplyGenerator（DeepSeek 运行时、
Postgres 技能库、Postgres 存储与出站台账）。
"""

from __future__ import annotations

from typing import Callable
from uuid import UUID

import psycopg

from notalone.application.reply_service import ReplyService
from notalone.application.reply_exploration import ReplyExplorationService
from notalone.application.assistant_session_service import AssistantSessionService
from notalone.application.explored_reply_generation import AssistantExplorationGeneration
from notalone.application.model_priority import ModelPriorityControl, PriorityReplyPort
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
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.reply_exploration import PostgresExplorationStore
from notalone.persistence.explored_reply_context import ExploredReplyContext
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.persistence.style_sample_store import PostgresStyleSampleStore
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.input_budget import (
    InputBudgetDecision, InputBudgetProfile, InputTokenCounter,
)


def build_reply_service(
    *, database_url: str, owner_id: UUID,
    model_priority: ModelPriorityControl | None = None,
    input_budget_profile: InputBudgetProfile | None = None,
    input_token_counter: InputTokenCounter | None = None,
    on_input_budget: Callable[[InputBudgetDecision], None] | None = None,
) -> ReplyService | None:
    """有 active 绑定且模型凭据可用时装配回复服务；否则返回 None。

    回复端点不可用时返回 503 reply_unavailable。
    """

    try:
        model = build_deepseek_model()
    except (ValueError, OSError):
        return None
    skill_revision = _skill_library_revision(database_url, owner_id)
    retrieval = PostgresRetrieval(
        database_url,
        owner_memory_store=PostgresOwnerMemoryStore(database_url),
    )
    context = RetrievalReplyContext(
        retrieval=retrieval,
        memory_index=PostgresContactMemoryIndexRepository(database_url),
        skill_library_revision=skill_revision,
        style_references=PostgresStyleSampleStore(database_url),
        skill_revision_reader=lambda scope: _skill_library_revision(
            database_url,
            scope.owner_id,
        ),
    )
    evidence = ExplorationEvidence(retrieval)
    generator = ReplyGenerator(
        store=PostgresReplyStore(database_url),
        runtime=LangChainReplyRuntime(
            model=model,
            skill_port=PostgresSkillPort(database_url),
            retrieval=retrieval,
            input_budget_profile=input_budget_profile,
            input_token_counter=input_token_counter,
            on_input_budget=on_input_budget,
        ),
        context=ExploredReplyContext(context, database_url=database_url, evidence=evidence),
        ledger=PostgresOutboundLedger(database_url),
    )
    exploration = ReplyExplorationService(
        store=PostgresExplorationStore(database_url, evidence=evidence), evidence=evidence,
        skills=PostgresSkillPort(database_url),
        runtime=LangChainExplorationRuntime(
            model=model, ledger=PostgresOutboundLedger(database_url), priority=model_priority,
            input_budget_profile=input_budget_profile, input_token_counter=input_token_counter,
            on_input_budget=on_input_budget,
        ),
        generation=AssistantExplorationGeneration(lambda: AssistantSessionService(
            store=PostgresAssistantSessionStore(database_url), reply=reply_service,
        )),
    )
    reply_service = ReplyService(
        binding_lookup=_active_binding_lookup(database_url),
        conversation_factory=lambda binding: PostgresConversationPort(
            database_url,
            owner_id=owner_id,
            observation=ConversationObservation.confirmed(binding.binding_id),
        ),
        reply=(PriorityReplyPort(generator, model_priority) if model_priority is not None else generator),
        exploration=exploration,
    )
    return reply_service


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
