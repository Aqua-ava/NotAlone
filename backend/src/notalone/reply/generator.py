"""候选回复的确定性外壳。"""

from __future__ import annotations

import logging
import time
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.reply.context import (
    ContextEvidence,
    EVIDENCE_KINDS,
    ReplyContext,
    ReplyContextPort,
    ToolCallTrace,
    evidence_contract_is_valid,
)
from notalone.reply.runtime import (
    ReplyRuntime,
    ReplyRuntimeResult,
    RuntimeCandidate,
    RuntimeUsage,
)
from notalone.reply.store import (
    ReplyRequestState,
    ReplyStore,
    ReplyStart,
    ValidatedReply,
)
from notalone.reply.errors import (
    ReplyContextError,
    ReplyError,
    ReplyInProgressError,
    ReplyInvariantError,
    ReplyPersistenceError,
    ReplyRunError,
)
from notalone.reply.interface import (
    ContextReceipt,
    GenerateReply,
    InitiateConversation,
    ReplyCandidate,
    ReplyGenerated,
    ReplyOutcome,
    ReplyToMessage,
    RewriteDraft,
    SkillUse,
)
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.reply.input_budget_receipt import validate_input_budget_receipt
from notalone.reply.retrieval_receipt import append_runtime_receipt, require_receipt_evidence


logger = logging.getLogger(__name__)


class ReplyGenerator:
    """通过一个深 Interface 隐藏范围、运行时和持久化细节。"""

    __slots__ = ("_context", "_runtime", "_store", "_ledger")

    def __init__(
        self,
        *,
        store: ReplyStore,
        runtime: ReplyRuntime,
        context: ReplyContextPort,
        ledger: OutboundLedgerPort | None = None,
    ) -> None:
        if context is None:
            raise TypeError("ReplyGenerator 必须显式注入 ReplyContext。")
        self._store = store
        self._runtime = runtime
        self._context = context
        self._ledger = ledger

    def prepare(self, command: GenerateReply, *, verified_scope: VerifiedConversationScope) -> None:
        self._context.prepare(command=command, verified_scope=verified_scope,
                              validate=self._runtime.validate_prepared)

    def generate(
        self,
        command: GenerateReply,
        *,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome:
        """在外层已验证范围内生成候选；持久化成功前不返回。"""

        if not (
            isinstance(command, GenerateReply)
            and isinstance(verified_scope, VerifiedConversationScope)
            and command.has_valid_content()
            and command.matches_verified_scope(verified_scope)
        ):
            raise ReplyInvariantError("回复范围未通过会话验证。")

        try:
            started = self._store.start(command, verified_scope)
        except ReplyError:
            raise
        except Exception:
            raise ReplyPersistenceError("回复请求状态读取失败。") from None
        if not isinstance(started, ReplyStart):
            raise ReplyInvariantError("回复请求状态决定结构无效。")
        if started.state is ReplyRequestState.REPLAYED:
            if started.result is None:
                raise ReplyInvariantError("已完成回复缺少可重放结果。")
            return started.result
        if started.state is ReplyRequestState.IN_PROGRESS:
            raise ReplyInProgressError("相同回复请求正在处理中。")
        if started.state is not ReplyRequestState.STARTED:
            raise ReplyInvariantError("回复请求状态决定无效。")

        request = started.request
        try:
            context = self._context.build(
                command=command,
                verified_scope=verified_scope,
                reply_request_id=request.request_id,
                continued_candidate=started.continued_candidate,
            )
        except ReplyError:
            self._mark_failed(request, "context_failed")
            raise
        except Exception:
            self._mark_failed(request, "context_failed")
            raise ReplyContextError("候选回复上下文准备失败。") from None
        try:
            self._validate_context(command, context)
            self._validate_current_context(context)
            self._store.prepare_context(request, context)
        except ReplyError:
            self._mark_failed(request, "context_invariant_failed")
            raise
        except Exception:
            self._mark_failed(request, "context_invariant_failed")
            raise ReplyInvariantError("回复准备结果结构无效。") from None
        started_ns = time.perf_counter()
        called_at = datetime.now(timezone.utc)
        try:
            runtime_result = self._runtime.generate(context)
        except ReplyRunError:
            self._mark_failed(request, "runtime_failed")
            self._record_failure_ledger(
                command, LedgerOutcome.RUN_FAILED, None, started_ns, called_at
            )
            raise
        except ReplyError:
            # 运行时内部的结构化输出或不变量失败：外部调用已尝试但输出被拒。
            self._mark_failed(request, "runtime_failed")
            self._record_failure_ledger(
                command,
                LedgerOutcome.REJECTED_BY_VALIDATION,
                None,
                started_ns,
                called_at,
            )
            raise
        except Exception:
            self._mark_failed(request, "runtime_failed")
            self._record_failure_ledger(
                command, LedgerOutcome.RUN_FAILED, None, started_ns, called_at
            )
            raise ReplyRunError("候选回复运行失败。") from None
        runtime_latency_ms = int((time.perf_counter() - started_ns) * 1000)
        runtime_usage = (
            runtime_result.usage
            if isinstance(runtime_result, ReplyRuntimeResult)
            else None
        )
        try:
            self._validate_runtime_result(runtime_result)
            runtime_context = self._merge_runtime_context(
                context,
                runtime_result,
            )
            self._validate_context(command, runtime_context)
            self._validate_current_context(runtime_context)
        except ReplyError:
            self._mark_failed(request, "runtime_failed")
            self._record_failure_ledger(
                command,
                LedgerOutcome.REJECTED_BY_VALIDATION,
                runtime_usage,
                started_ns,
                called_at,
                runtime_latency_ms,
            )
            raise
        except Exception:
            self._mark_failed(request, "runtime_failed")
            self._record_failure_ledger(
                command,
                LedgerOutcome.REJECTED_BY_VALIDATION,
                runtime_usage,
                started_ns,
                called_at,
                runtime_latency_ms,
            )
            raise ReplyInvariantError("候选回复校验失败。") from None
        evidence_ids = {item.evidence_id for item in runtime_context.evidence}
        if any(
            not set(candidate.citation_ids) <= evidence_ids
            for candidate in runtime_result.candidates
        ):
            self._mark_failed(request, "citation_invariant_failed")
            self._record_failure_ledger(
                command,
                LedgerOutcome.REJECTED_BY_VALIDATION,
                runtime_usage,
                started_ns,
                called_at,
                runtime_latency_ms,
            )
            raise ReplyInvariantError("候选引用不属于本次上下文快照。")
        validated = ValidatedReply(
            candidates=runtime_result.candidates,
            used_skill=runtime_result.used_skill,
            input_budget=runtime_result.input_budget,
        )
        try:
            persisted = self._store.save(request, runtime_context, validated)
        except ReplyError:
            self._mark_failed(request, "persistence_failed")
            # 外部调用本身已完成且通过校验；候选落库失败不改变调用结果。
            self._record_failure_ledger(
                command,
                LedgerOutcome.SUCCEEDED,
                runtime_usage,
                started_ns,
                called_at,
                runtime_latency_ms,
            )
            raise
        except Exception:
            self._mark_failed(request, "persistence_failed")
            self._record_failure_ledger(
                command,
                LedgerOutcome.SUCCEEDED,
                runtime_usage,
                started_ns,
                called_at,
                runtime_latency_ms,
            )
            raise ReplyPersistenceError("候选回复持久化失败。") from None
        self._validate_persisted(runtime_context, validated, persisted)
        self._record_ledger(
            command,
            LedgerOutcome.SUCCEEDED,
            runtime_usage,
            started_ns,
            called_at,
            runtime_latency_ms,
        )
        return persisted

    def _record_ledger(
        self,
        command: GenerateReply,
        outcome: LedgerOutcome,
        usage: RuntimeUsage | None,
        started_ns: float,
        called_at: datetime,
        latency_ms: int | None = None,
    ) -> None:
        """外部调用的最小操作记录；台账不可用时调用按失败处理。"""

        if self._ledger is None:
            return
        if latency_ms is None:
            latency_ms = int((time.perf_counter() - started_ns) * 1000)
        entry = LedgerEntry(
            entry_id=uuid4(),
            owner_id=command.scope.owner_id,
            contact_id=command.scope.contact_id,
            provider=usage.provider if usage is not None else "unreported",
            model_name=usage.model_name if usage is not None else "unreported",
            input_tokens=usage.input_tokens if usage is not None else None,
            output_tokens=usage.output_tokens if usage is not None else None,
            latency_ms=latency_ms,
            outcome=outcome,
            called_at=called_at,
        )
        try:
            self._ledger.record(entry)
        except Exception:
            raise ReplyRunError("出站台账记录失败。") from None

    def _record_failure_ledger(
        self,
        command: GenerateReply,
        outcome: LedgerOutcome,
        usage: RuntimeUsage | None,
        started_ns: float,
        called_at: datetime,
        latency_ms: int | None = None,
    ) -> None:
        """失败路径的台账记录：尽力而为，不替换原始错误。

        失败路径已经 `_mark_failed` 并带着原始领域异常向上抛；台账
        只是审计旁路，写入失败时吞掉，避免把 `ReplyPersistenceError`
        等真实失败原因改写成 `ReplyRunError`，丢失错误分类。
        """

        try:
            self._record_ledger(
                command,
                outcome,
                usage,
                started_ns,
                called_at,
                latency_ms,
            )
        except Exception:
            pass

    def _mark_failed(self, request: object, reason: str) -> None:
        try:
            if hasattr(request, "request_id"):
                self._store.fail(request, reason=reason)
        except Exception:
            # 标记失败本身不能改变请求结果；但不能静默吞掉，
            # 否则请求会停到租约过期，且没有任何可观测线索。
            logger.warning(
                "回复请求标记失败时存储调用出错", exc_info=True,
            )

    @staticmethod
    def _validate_context(command: GenerateReply, context: object) -> None:
        if not isinstance(context, ReplyContext):
            raise ReplyInvariantError(
                "回复上下文 adapter 返回了无效结果。"
            )
        try:
            require_receipt_evidence(context.retrieval, context.evidence)
        except ValueError:
            raise ReplyInvariantError("回复检索回执与实际依据不一致。") from None
        if context.scope != command.scope or context.command != command:
            raise ReplyInvariantError(
                "回复上下文结果超出本次联系人范围。"
            )
        if (
            not isinstance(context.reply_request_id, UUID)
            or not isinstance(context.current_text, str)
            or not context.current_text.strip()
            or not isinstance(context.evidence, tuple)
            or not context.evidence
            or not isinstance(context.skill_library_revision, int)
            or context.skill_library_revision < 0
            or not isinstance(context.risk_notes, tuple)
            or any(
                not isinstance(note, str) or not note.strip()
                for note in context.risk_notes
            )
            or (
                context.memory_revision is not None
                and (
                    not isinstance(context.memory_revision, int)
                    or context.memory_revision < 0
                )
            )
            or (
                context.index_revision is not None
                and (
                    not isinstance(context.index_revision, int)
                    or context.index_revision < 0
                )
            )
            or not isinstance(context.tool_calls, tuple)
        ):
            raise ReplyInvariantError("回复上下文快照结构无效。")

        evidence_ids: set[UUID] = set()
        for item in context.evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.scope != context.scope
                or not isinstance(item.evidence_id, UUID)
                or item.evidence_id in evidence_ids
                or item.kind not in EVIDENCE_KINDS
                or not isinstance(item.text, str)
                or not item.text.strip()
                or not isinstance(item.source_ids, tuple)
                or any(
                    not isinstance(source_id, UUID)
                    for source_id in item.source_ids
                )
                or not isinstance(item.selection_reason, str)
                or not isinstance(item.status, str)
                or not item.status.strip()
                or (
                    item.valid_at is not None
                    and not isinstance(item.valid_at, datetime)
                )
                or (
                    item.invalid_at is not None
                    and not isinstance(item.invalid_at, datetime)
                )
                or (
                    item.valid_at is not None
                    and item.invalid_at is not None
                    and item.invalid_at < item.valid_at
                )
                or (
                    item.revision is not None
                    and (
                        not isinstance(item.revision, int)
                        or item.revision < 1
                    )
                )
                or not evidence_contract_is_valid(
                    kind=item.kind,
                    status=item.status,
                    selection_reason=item.selection_reason,
                )
            ):
                raise ReplyInvariantError("回复依据超出范围或结构无效。")
            evidence_ids.add(item.evidence_id)

        for trace in context.tool_calls:
            if not ReplyGenerator._valid_tool_trace(trace):
                raise ReplyInvariantError("回复 Tool 轨迹结构无效。")
            if not set(trace.evidence_ids) <= evidence_ids:
                raise ReplyInvariantError("回复 Tool 轨迹引用了未知证据。")

        continuation_evidence = tuple(
            item for item in context.evidence if item.kind == "continued_candidate"
        )
        if command.continued_from_candidate_id is None:
            if continuation_evidence:
                raise ReplyInvariantError("历史候选必须由用户显式选择。")
        elif (
            len(continuation_evidence) != 1
            or continuation_evidence[0].evidence_id
            != command.continued_from_candidate_id
        ):
            raise ReplyInvariantError(
                "显式继续候选与上下文快照不一致。"
            )

        if isinstance(command.content, ReplyToMessage):
            target_evidence = tuple(
                item
                for item in context.evidence
                if item.evidence_id == command.content.target_message_id
            )
            if (
                len(target_evidence) != 1
                or target_evidence[0].kind != "message"
                or target_evidence[0].text != context.current_text
                or context.direction != command.content.direction
            ):
                raise ReplyInvariantError(
                    "待回复消息或表达方向与请求不一致。"
                )
            return

        if isinstance(command.content, InitiateConversation):
            purpose_evidence = tuple(item for item in context.evidence if item.kind == "user_purpose")
            if (context.direction != command.content.purpose
                or context.current_text != command.content.purpose.text
                or len(purpose_evidence) != 1
                or purpose_evidence[0].text != command.content.purpose.text):
                raise ReplyInvariantError("主动目的与回复上下文不一致。")
            return

        if isinstance(command.content, RewriteDraft):
            if context.has_unauthorized_history():
                raise ReplyInvariantError(
                    "当前改写不能使用历史资料。"
                )
            draft_evidence = tuple(
                item
                for item in context.evidence
                if item.kind == ("user_current_chat" if command.content.input_kind == "current_chat" else "user_draft")
                and item.text == command.content.draft_text
            )
            if (
                context.direction is not None
                or context.current_text != command.content.draft_text
                or len(draft_evidence) != 1
            ):
                raise ReplyInvariantError("改写草稿与回复上下文不一致。")
            return

        raise ReplyInvariantError("回复输入模式无效。")

    def _validate_current_context(self, context: ReplyContext) -> None:
        """在模型调用前后重新验证快照中的 live 依据。"""

        validator = getattr(self._context, "validate_current", None)
        if not callable(validator):
            return
        try:
            validator(context)
        except ReplyError:
            raise
        except Exception:
            raise ReplyContextError("回复依据重新验证失败。") from None

    @staticmethod
    def _merge_runtime_context(
        context: ReplyContext,
        result: ReplyRuntimeResult,
    ) -> ReplyContext:
        if not isinstance(result.additional_evidence, tuple):
            raise ReplyInvariantError("运行时附加证据结构无效。")
        evidence_ids = {item.evidence_id for item in context.evidence}
        additions: list[ContextEvidence] = []
        for item in result.additional_evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.kind != "message"
                or item.scope != context.scope
                or item.evidence_id in evidence_ids
            ):
                raise ReplyInvariantError("运行时附加证据超出本次范围。")
            evidence_ids.add(item.evidence_id)
            additions.append(item)
        if not isinstance(result.tool_calls, tuple):
            raise ReplyInvariantError("运行时 Tool 轨迹结构无效。")
        for trace in result.tool_calls:
            if not ReplyGenerator._valid_tool_trace(trace):
                raise ReplyInvariantError("运行时 Tool 轨迹结构无效。")
            if not set(trace.evidence_ids) <= evidence_ids:
                raise ReplyInvariantError("运行时 Tool 轨迹引用了未知证据。")
        return replace(
            context,
            evidence=context.evidence + tuple(additions),
            tool_calls=context.tool_calls + result.tool_calls,
            retrieval=append_runtime_receipt(context.retrieval, context.evidence, tuple(additions), result.tool_calls),
        )

    @staticmethod
    def _valid_tool_trace(trace: object) -> bool:
        return (
            isinstance(trace, ToolCallTrace)
            and isinstance(trace.tool_name, str)
            and bool(trace.tool_name.strip())
            and len(trace.tool_name) <= 64
            and trace.status
            in (
                "succeeded",
                "empty",
                "failed",
                "timeout",
                "budget_exceeded",
            )
            and isinstance(trace.evidence_ids, tuple)
            and len(trace.evidence_ids) == len(set(trace.evidence_ids))
            and all(isinstance(item, UUID) for item in trace.evidence_ids)
            and (
                trace.latency_ms is None
                or (
                    isinstance(trace.latency_ms, int)
                    and trace.latency_ms >= 0
                )
            )
        )

    @staticmethod
    def _validate_runtime_result(result: ReplyRuntimeResult) -> None:
        if not isinstance(result, ReplyRuntimeResult) or not isinstance(
            result.candidates,
            tuple,
        ):
            raise ReplyInvariantError("模型返回了无效结果。")
        try:
            validate_input_budget_receipt(result.input_budget)
        except ValueError:
            raise ReplyInvariantError("运行结果的预算回执结构无效。") from None
        if result.usage is not None and not ReplyGenerator._valid_usage(
            result.usage
        ):
            raise ReplyInvariantError("模型用量记录结构无效。")
        if not isinstance(result.additional_evidence, tuple) or not isinstance(
            result.tool_calls,
            tuple,
        ):
            raise ReplyInvariantError("模型返回了无效 Tool 结果。")
        for item in result.additional_evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.kind != "message"
                or not isinstance(item.scope, ContactScope)
                or not isinstance(item.evidence_id, UUID)
                or not isinstance(item.text, str)
                or not item.text.strip()
                or not isinstance(item.source_ids, tuple)
                or not item.source_ids
                or any(
                    not isinstance(source_id, UUID)
                    for source_id in item.source_ids
                )
            ):
                raise ReplyInvariantError("模型返回了无效 Tool 证据。")
        for trace in result.tool_calls:
            if not ReplyGenerator._valid_tool_trace(trace):
                raise ReplyInvariantError("模型返回了无效 Tool 轨迹。")
        if not 1 <= len(result.candidates) <= 3:
            raise ReplyInvariantError("一次回复必须生成 1 到 3 条候选。")
        for candidate in result.candidates:
            if (
                not isinstance(candidate, RuntimeCandidate)
                or not isinstance(candidate.text, str)
                or not candidate.text.strip()
                or not candidate.has_valid_message_group()
                or not isinstance(candidate.basis, str)
                or not candidate.basis.strip()
                or not isinstance(candidate.citation_ids, tuple)
                or not candidate.citation_ids
                or any(
                    not isinstance(evidence_id, UUID)
                    for evidence_id in candidate.citation_ids
                )
                or not isinstance(candidate.risk_notes, tuple)
                or any(
                    not isinstance(note, str) or not note.strip()
                    for note in candidate.risk_notes
                )
            ):
                raise ReplyInvariantError("模型返回了无效候选。")
        if result.used_skill is not None and (
            not isinstance(result.used_skill, SkillUse)
            or not isinstance(result.used_skill.skill_id, UUID)
            or not isinstance(result.used_skill.version_id, UUID)
            or not isinstance(result.used_skill.name, str)
            or not result.used_skill.name.strip()
            or result.used_skill.selection_method not in ("auto", "user")
            or not isinstance(result.used_skill.selection_reason, str)
            or not result.used_skill.selection_reason.strip()
            or not isinstance(result.used_skill.resource_paths, tuple)
            or any(
                not isinstance(path, str) or not path.strip()
                for path in result.used_skill.resource_paths
            )
            or len(result.used_skill.resource_paths)
            != len(set(result.used_skill.resource_paths))
            or result.used_skill.load_state not in ("loaded", "resource_failed")
        ):
            raise ReplyInvariantError("模型返回了无效 Skill 记录。")

    @staticmethod
    def _valid_usage(usage: object) -> bool:
        return (
            isinstance(usage, RuntimeUsage)
            and isinstance(usage.provider, str)
            and bool(usage.provider.strip())
            and isinstance(usage.model_name, str)
            and bool(usage.model_name.strip())
            and all(
                value is None
                or (
                    isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= 0
                )
                for value in (usage.input_tokens, usage.output_tokens)
            )
        )

    @staticmethod
    def _validate_persisted(
        context: object,
        validated: ValidatedReply,
        persisted: object,
    ) -> None:
        if (
            not isinstance(context, ReplyContext)
            or not isinstance(persisted, ReplyGenerated)
            or persisted.reply_request_id != context.reply_request_id
            or persisted.used_skill != validated.used_skill
            or persisted.input_budget != validated.input_budget
            or not isinstance(persisted.candidates, tuple)
            or len(persisted.candidates) != len(validated.candidates)
            or not isinstance(persisted.context_receipt, ContextReceipt)
            or not isinstance(persisted.context_receipt.evidence_ids, tuple)
        ):
            raise ReplyInvariantError("持久化 adapter 返回了不一致结果。")

        candidate_ids: set[UUID] = set()
        cited_ids: set[UUID] = set()
        for saved, expected in zip(
            persisted.candidates,
            validated.candidates,
            strict=True,
        ):
            if (
                not isinstance(saved, ReplyCandidate)
                or not isinstance(saved.candidate_id, UUID)
                or saved.candidate_id in candidate_ids
                or saved.text != expected.text
                or saved.basis != expected.basis
                or saved.citation_ids != expected.citation_ids
                or saved.risk_notes != expected.risk_notes
                or tuple(message.text for message in saved.message_group) != expected.message_texts
                or len({message.message_id for message in saved.message_group}) != len(saved.message_group)
            ):
                raise ReplyInvariantError(
                    "持久化候选与已校验结果不一致。"
                )
            candidate_ids.add(saved.candidate_id)
            cited_ids.update(saved.citation_ids)

        if (
            any(
                not isinstance(evidence_id, UUID)
                for evidence_id in persisted.context_receipt.evidence_ids
            )
            or set(persisted.context_receipt.evidence_ids) != cited_ids
        ):
            raise ReplyInvariantError("持久化依据记录与候选引用不一致。")
