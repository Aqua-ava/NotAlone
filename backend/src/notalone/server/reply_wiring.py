"""候选回复服务的常驻后端装配（薄壳接线）。

只做适配器组装，不包含业务逻辑：会话验证用既有 PostgresConversationPort
（观察来自已确认绑定），回复生成用既有 ReplyGenerator（DeepSeek 运行时、
Postgres 技能库、Postgres 存储与出站台账）。
"""

from __future__ import annotations

import logging
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
from notalone.persistence.skill_directory import SkillDirectorySyncError
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


logger = logging.getLogger(__name__)


class RoundSkillSyncPort:
    """每轮生成/准备前显式同步一次 Skill 目录；读路径本身保持只读。

    同步失败按脱敏 warning 降级，沿用上次已同步的目录状态继续本轮，
    下一轮重试；不在失败时静默下架既有 Skill。
    """

    __slots__ = ("_port", "_synchronize")

    def __init__(self, port, *, synchronize: Callable[[UUID], int]):
        self._port, self._synchronize = port, synchronize

    def _synchronize_round(self, verified_scope) -> None:
        try:
            self._synchronize(verified_scope.owner_id)
        except (SkillDirectorySyncError, OSError):
            logger.warning("skill_directory_sync_failed")

    def prepare(self, command, *, verified_scope):
        self._synchronize_round(verified_scope)
        return self._port.prepare(command=command, verified_scope=verified_scope)

    def generate(self, command, *, verified_scope):
        self._synchronize_round(verified_scope)
        return self._port.generate(command=command, verified_scope=verified_scope)


class ExploredSkillSyncPort:
    """探索/审核读目录前显式同步一次；其余读方法保持只读。

    探索和审核不走生成端 RoundSkillSyncPort，但仍需在读到目录前推进同一份
    每轮同步入口，避免拿到上一轮已过期的 Skill 目录。
    """

    __slots__ = ("_port", "_synchronize")

    def __init__(self, port, *, synchronize: Callable[[UUID], int]):
        self._port, self._synchronize = port, synchronize

    def _sync(self, scope) -> None:
        try:
            self._synchronize(scope.owner_id)
        except (SkillDirectorySyncError, OSError):
            logger.warning("skill_directory_sync_failed")

    def catalog(self, scope):
        self._sync(scope)
        return self._port.catalog(scope)

    def load_version(self, scope, version_id):
        return self._port.load_version(scope, version_id)

    def load_resource(self, scope, version_id, relative_path):
        return self._port.load_resource(scope, version_id, relative_path)

    def for_scene(self, scene):
        return type(self)(self._port.for_scene(scene), synchronize=self._synchronize)


def build_reply_service(
    *, database_url: str, owner_id: UUID,
    model_priority: ModelPriorityControl | None = None,
    input_budget_profile: InputBudgetProfile | None = None,
    input_token_counter: InputTokenCounter | None = None,
    on_input_budget: Callable[[InputBudgetDecision], None] | None = None,
    layered_memory=None, layered_reply_budget=None, owner_layered_reply_budget=None,
    reply_thinking_effort: str | None = None,
) -> ReplyService | None:
    """有 active 绑定且模型凭据可用时装配回复服务；否则返回 None。

    回复端点不可用时返回 503 reply_unavailable。
    """

    if reply_thinking_effort not in (None, 'low', 'high', 'max'):
        raise ValueError('回复思考强度须为 low/high/max 或 None。')
    try:
        # 默认关闭思考；显式实验使用普通终止工具，保持正式核验和原超时。
        # 已批准ECNU配置沿既有协议构造，之后才给实际实例绑定计量器。
        ecnu = (os.environ.get('NOTALONE_DEEPSEEK_MODEL') == ECNU_MODEL
                and os.environ.get('NOTALONE_DEEPSEEK_BASE_URL', '').rstrip('/') == ECNU_BASE_URL)
        model = build_deepseek_model(max_retries=0,
            extra_body=None if ecnu else {'thinking': {'type': 'enabled' if reply_thinking_effort else 'disabled'}})
        if reply_thinking_effort is not None:
            from notalone.reply.adapters.deepseek_provider import is_official_deepseek_flash
            if not is_official_deepseek_flash(model):
                raise ValueError('回复思考试验仅支持已核实的官方 Flash。')
            model.reasoning_effort = reply_thinking_effort
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
    def synchronize_skill_round(target_owner_id: UUID) -> int:
        return _synchronize_skill_library(database_url, target_owner_id)

    try:
        skill_revision = _synchronize_skill_library(database_url, owner_id)
    except SkillDirectorySyncError:
        logger.warning("skill_directory_sync_failed")
        skill_revision = _read_skill_library_revision(database_url, owner_id)
    retrieval = PostgresRetrieval(
        database_url,
        owner_memory_store=PostgresOwnerMemoryStore(database_url),
    )
    context = RetrievalReplyContext(
        retrieval=retrieval,
        memory_index=PostgresContactMemoryIndexRepository(database_url),
        skill_library_revision=skill_revision,
        skill_revision_reader=lambda scope: _read_skill_library_revision(
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
            # 外壳按同一 prepared 同时复验租约与完整来源；每轮执行一次即可。
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
        skills=ExploredSkillSyncPort(
            PostgresSkillPort(database_url), synchronize=synchronize_skill_round,
        ),
        runtime=LangChainExplorationRuntime(
            model=model, ledger=PostgresOutboundLedger(database_url), priority=model_priority,
            input_budget_profile=input_budget_profile, input_token_counter=input_token_counter,
            on_input_budget=on_input_budget,
        ),
        generation=AssistantExplorationGeneration(lambda: AssistantSessionService(
            store=PostgresAssistantSessionStore(database_url), reply=reply_service,
        )),
    )
    round_reply = RoundSkillSyncPort(
        generator,
        synchronize=synchronize_skill_round,
    )
    reply_service = ReplyService(
        manual_scope_lookup=_manual_scope_lookup(database_url),
        binding_lookup=_active_binding_lookup(database_url),
        conversation_factory=lambda binding: PostgresConversationPort(
            database_url,
            owner_id=owner_id,
            observation=ConversationObservation.confirmed(binding.binding_id),
        ),
        reply=(PriorityReplyPort(round_reply, model_priority)
               if model_priority is not None else round_reply),
        exploration=exploration,
        skill_review=build_skill_review_service(database_url=database_url, model=model,
            context=ExpressionPreferenceContext(context, PostgresExpressionPreferenceStore(database_url)),
            model_priority=model_priority, input_budget_profile=input_budget_profile,
            input_token_counter=input_token_counter, on_input_budget=on_input_budget,
            skills=ExploredSkillSyncPort(
                PostgresSkillPort(database_url), synchronize=synchronize_skill_round,
            )),
    )
    return reply_service


def build_skill_review_service(*, database_url, model, context, model_priority,
                               input_budget_profile, input_token_counter, on_input_budget,
                               skills=None):
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
        binding_lookup=_active_binding_lookup(database_url),
        skills=skills or PostgresSkillPort(database_url),
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


def _read_skill_library_revision(database_url: str, owner_id: UUID) -> int:
    """只读当前已同步修订号；目录发现由每轮显式同步入口负责。"""
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT revision FROM public.skill_library WHERE owner_id = %s",
            (owner_id,),
        ).fetchone()
    return row[0] if row is not None else 0


def _synchronize_skill_library(database_url: str, owner_id: UUID) -> int:
    from notalone.persistence.skill_directory import synchronize_skill_library
    return synchronize_skill_library(database_url, owner_id)
