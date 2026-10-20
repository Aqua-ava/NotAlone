"""候选回复服务的常驻后端装配（薄壳接线）。

只做适配器组装，不包含业务逻辑：会话验证用既有 PostgresConversationPort
（观察来自已确认绑定），回复生成用既有 ReplyGenerator（DeepSeek 运行时、
Postgres 技能库、Postgres 存储与出站台账）。
"""

from __future__ import annotations

import os
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
from notalone.persistence.explored_generation import explored_skill_selection_method
from notalone.persistence.assistant_discussion_reply_context import PostgresAssistantDiscussionContext
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.persistence.expression_preferences import PostgresExpressionPreferenceStore
from notalone.application.expression_preference_context import ExpressionPreferenceContext
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
from notalone.reply.adapters.ecnu_input_budget import build_ecnu_input_budget, ECNU_BASE_URL, ECNU_MODEL
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.input_budget import (
    InputBudgetDecision, InputBudgetProfile, InputTokenCounter,
)
from notalone.scopes import VerifiedConversationScope


def build_reply_service(
    *, database_url: str, owner_id: UUID,
    model_priority: ModelPriorityControl | None = None,
    input_budget_profile: InputBudgetProfile | None = None,
    input_token_counter: InputTokenCounter | None = None,
    on_input_budget: Callable[[InputBudgetDecision], None] | None = None,
    layered_memory=None, layered_reply_budget=None, owner_layered_reply_budget=None,
) -> ReplyService | None:
    """有 active 绑定且模型凭据可用时装配回复服务；否则返回 None。

    回复端点不可用时返回 503 reply_unavailable。
    """

    try:
        # Reply/审核的ToolStrategy会强制required；DeepSeek须关闭thinking。
        # 已批准ECNU配置沿既有协议构造，之后才给实际实例绑定计量器。
        ecnu = (os.environ.get('NOTALONE_DEEPSEEK_MODEL') == ECNU_MODEL
                and os.environ.get('NOTALONE_DEEPSEEK_BASE_URL', '').rstrip('/') == ECNU_BASE_URL)
        model = build_deepseek_model(max_retries=0,
            extra_body=None if ecnu else {'thinking': {'type': 'disabled'}})
    except (ValueError, OSError):
        return None
    if input_budget_profile is None and input_token_counter is None:
        budget = build_deepseek_input_budget(model) or build_ecnu_input_budget(model)
        if budget is not None:
            input_budget_profile, input_token_counter = budget
    if layered_memory is not None:
        default_budgets = getattr(layered_memory, 'default_reply_budgets', None)
        defaults = default_budgets() if default_budgets is not None else None
        if defaults is not None:
            layered_reply_budget = layered_reply_budget or defaults[0]
            owner_layered_reply_budget = owner_layered_reply_budget or defaults[1]
    configured = getattr(layered_memory, 'reply_configuration', None)
    if configured is not None:
        from notalone.reply.quality import build_reply_contract
        try:
            contract = build_reply_contract(model, input_budget_profile,
                configured.contact_budget, configured.owner_budget)
            layered_memory.configure_reply(contract, configured.source)
            layered_reply_budget, owner_layered_reply_budget = configured.contact_budget, configured.owner_budget
        except (ValueError, TypeError, AttributeError):
            # 未核实配置继续L1，不能用未标定默认值放开新层。
            layered_reply_budget, owner_layered_reply_budget = None, None
    skill_revision = _skill_library_revision(database_url, owner_id)
    retrieval = PostgresRetrieval(
        database_url,
        owner_memory_store=PostgresOwnerMemoryStore(database_url),
    )
    context = RetrievalReplyContext(
        retrieval=retrieval,
        memory_index=PostgresContactMemoryIndexRepository(database_url),
        skill_library_revision=skill_revision,
        skill_revision_reader=lambda scope: _skill_library_revision(
            database_url,
            scope.owner_id,
        ),
        overview=PostgresRelationshipOverviewStore(database_url),
        layered_memory=layered_memory, layered_budget=layered_reply_budget, owner_layered_budget=owner_layered_reply_budget,
    )
    evidence = ExplorationEvidence(retrieval)
    from notalone.persistence.assistant_prepared_context import PreparedAssistantContext
    reply_context = PreparedAssistantContext(PostgresAssistantDiscussionContext(
        ExploredReplyContext(ExpressionPreferenceContext(context, PostgresExpressionPreferenceStore(database_url)),
                             database_url=database_url, evidence=evidence),
        database_url=database_url,
    ), database_url, layered_memory=layered_memory, layered_budget=layered_reply_budget, owner_layered_budget=owner_layered_reply_budget)
    from langchain_core.globals import get_llm_cache
    from langchain_deepseek import ChatDeepSeek
    from notalone.reply.adapters.model_call_ledger import ModelCallLedger
    ledger = PostgresOutboundLedger(database_url)

    def call_ledger(prepared):
        from notalone.reply.runtime import current_model_request_validator
        validate_request = current_model_request_validator()

        def validate():
            if validate_request is None:
                raise ValueError('实际模型调用缺少确定性外壳的运行租约。')
            validate_request()
            if (model.rate_limiter is not None or model.cache is not False
                    and (model.cache is not None or get_llm_cache() is not None)):
                raise ValueError("逐次台账不接受缓存或本地限流模型。")
            if isinstance(model, ChatDeepSeek) and any(value != 0 for value in (
                model.max_retries, model.root_client.max_retries, model.root_async_client.max_retries)):
                raise ValueError("逐次台账不接受隐藏的供应商自动重试。")
            if layered_memory is not None:
                layered_memory.validate_reply_model(prepared, model, input_budget_profile,
                    layered_reply_budget, owner_layered_reply_budget)
            reply_context.validate_current(prepared)
            if model_priority is not None:
                model_priority.check_running()
        return ModelCallLedger(scope=prepared.scope, ledger=ledger,
            model_name=getattr(model, 'model_name', None) or 'unreported',
            validate=validate, record_call=lambda identifier: None)

    generator = ReplyGenerator(
        store=PostgresReplyStore(database_url, layered_memory=layered_memory, layered_budget=layered_reply_budget, owner_layered_budget=owner_layered_reply_budget),
        runtime=LangChainReplyRuntime(
            model=model, layered_memory=layered_memory,
            on_model_response=layered_memory.check_reply_response if layered_memory is not None else None,
            skill_port=PostgresSkillPort(database_url),
            retrieval=retrieval,
            input_budget_profile=input_budget_profile,
            input_token_counter=input_token_counter,
            on_input_budget=on_input_budget,
            model_callback_factory=call_ledger,
            skill_selection_method=lambda prepared: explored_skill_selection_method(database_url, prepared),
            # 候选经确定性来源与结构检查后交用户选择，不追加模型复核（ADR-068）。
        ),
        context=reply_context,
        # 实际模型轮已分别记账，外层不能再写一条汇总而重复计算。
        ledger=None,
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
        manual_scope_lookup=_manual_scope_lookup(database_url),
        binding_lookup=_active_binding_lookup(database_url),
        conversation_factory=lambda binding: PostgresConversationPort(
            database_url,
            owner_id=owner_id,
            observation=ConversationObservation.confirmed(binding.binding_id),
        ),
        reply=(PriorityReplyPort(generator, model_priority) if model_priority is not None else generator),
        exploration=exploration,
        skill_review=build_skill_review_service(database_url=database_url, model=model,
            context=ExpressionPreferenceContext(context, PostgresExpressionPreferenceStore(database_url)),
            model_priority=model_priority, input_budget_profile=input_budget_profile,
            input_token_counter=input_token_counter, on_input_budget=on_input_budget),
    )
    return reply_service


def build_skill_review_service(*, database_url, model, context, model_priority,
                               input_budget_profile, input_token_counter, on_input_budget):
    from langchain_core.globals import get_llm_cache
    from langchain_deepseek import ChatDeepSeek
    from notalone.application.skill_review import SkillReviewService
    from notalone.persistence.skill_review import PostgresSkillReviewStore
    from notalone.skills.learning import SkillLearningUnavailable

    def require_uncached_model():
        # 不突变普通回复共用的模型或破坏预算计量器的实际模型绑定。
        if (model.rate_limiter is not None or model.cache is not False
                and (model.cache is not None or get_llm_cache() is not None)):
            raise SkillLearningUnavailable()
        if isinstance(model, ChatDeepSeek) and any(value != 0 for value in (
            model.max_retries, model.root_client.max_retries, model.root_async_client.max_retries)):
            raise SkillLearningUnavailable()

    try:
        require_uncached_model()
    except SkillLearningUnavailable:
        return None

    def review_runtime(port, accounting):
        require_uncached_model()
        accounting.model_guard = require_uncached_model
        return LangChainReplyRuntime(model=model, skill_port=port,
            input_budget_profile=input_budget_profile, input_token_counter=input_token_counter,
            on_input_budget=on_input_budget, model_callbacks=(accounting,))

    return SkillReviewService(store=PostgresSkillReviewStore(database_url), context=context,
        binding_lookup=_active_binding_lookup(database_url), skills=PostgresSkillPort(database_url),
        runtime_factory=review_runtime,
        ledger=PostgresOutboundLedger(database_url), model_name=getattr(model, 'model_name', None) or 'unreported',
        priority=model_priority)


def _manual_scope_lookup(database_url: str):
    def lookup(owner_id: UUID, contact_id: UUID) -> VerifiedConversationScope | None:
        from notalone.application.manual_input_scope import manual_input_contact
        if manual_input_contact.get() != contact_id:
            return None
        with psycopg.connect(database_url) as connection:
            row = connection.execute(
                "SELECT id FROM public.manual_contact_confirmation WHERE owner_id=%s AND contact_id=%s",
                (owner_id, contact_id),
            ).fetchone()
        return VerifiedConversationScope(owner_id, contact_id, row[0]) if row else None
    return lookup


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
