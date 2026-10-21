"""回复上下文的共享纯校验：generator 与两种 Store 只做薄包装。

规则只在这里维护一份；入口差异仅限各自持有的权威事实：
生成入口持有 command，持久化入口持有请求租约与候选回表回调。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import Callable
from uuid import UUID

from notalone.reply.assistant_discussion import DiscussionContext
from notalone.reply.context import (
    ContextEvidence,
    EVIDENCE_KINDS,
    ReplyContext,
    ToolCallTrace,
    evidence_contract_is_valid,
)
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import (
    GenerateReply,
    InitiateConversation,
    NoSkill,
    ReplyToMessage,
    RewriteDraft,
    UserSkillChoice,
)
from notalone.reply.retrieval_receipt import require_receipt_evidence
from notalone.scopes import ContactScope


class ReplyContextValidationError(ValueError):
    """共享校验失败的稳定原因；由各 adapter 映射为自己的领域错误。"""


@dataclass(frozen=True, slots=True)
class ReplyContextBinding:
    """持久化入口持有、必须与上下文逐项一致的请求事实。"""

    request_id: UUID
    scope: ContactScope
    normalized_input: str
    idempotency_key: UUID
    conversation_binding_id: UUID
    continued_from_candidate_id: UUID | None

    @classmethod
    def from_request(cls, request: object) -> "ReplyContextBinding":
        """从已领取的持久化请求投影校验所需的权威事实。"""

        try:
            return cls(
                request_id=request.request_id,
                scope=request.scope,
                normalized_input=request.normalized_input,
                idempotency_key=request.idempotency_key,
                conversation_binding_id=request.conversation_binding_id,
                continued_from_candidate_id=request.continued_from_candidate_id,
            )
        except AttributeError:
            raise TypeError("回复请求租约结构无效。") from None


def canonical_reply_input(command: GenerateReply) -> str:
    """会话投影与请求摘要共用同一用户输入表示。"""

    content = command.content
    if isinstance(content, ReplyToMessage):
        payload = {
            "mode": "reply_to_message",
            "target_message_id": str(content.target_message_id),
            "direction": content.direction.text.strip(),
            "direction_source": content.direction.source.value,
        }
    elif isinstance(content, InitiateConversation):
        payload = {
            "mode": "initiate_conversation", "purpose": content.purpose.text.strip(),
            "purpose_source": content.purpose.source.value,
        }
    elif isinstance(content, RewriteDraft):
        payload = {
            "mode": "rewrite_draft",
            "draft_text": content.draft_text.strip(),
            "user_instruction": (
                content.user_instruction.strip()
                if content.user_instruction is not None
                else None
            ),
            "include_relationship_context": content.include_relationship_context,
        }
        if content.input_kind == "workspace":
            payload.update(input_kind="workspace", workspace_action=content.workspace_action,
                           context_text=content.context_text,
                           excluded_message_ids=sorted(str(item) for item in set(content.excluded_message_ids)))
        if content.input_kind == "current_chat":
            payload["input_kind"] = "current_chat"
            payload["pasted_direction"] = content.pasted_direction.strip()
    else:
        raise ReplyStoreInvariantError("回复输入模式无效。")
    if isinstance(content, (ReplyToMessage, InitiateConversation)):
        direction = content.direction if isinstance(content, ReplyToMessage) else content.purpose
        if direction.suggestion is not None:
            reference = direction.suggestion
            payload["suggestion"] = {"task_id": str(reference.task_id),
                                     "input_version": str(reference.input_version)
                                     if isinstance(reference.input_version, UUID) else reference.input_version,
                                     "suggestion_id": str(reference.suggestion_id)}
        for name in ("understanding_correction", "user_instruction", "clarification_answer"):
            declaration = getattr(content, name)
            if declaration:
                payload[name] = declaration.strip()
    payload["continued_from_candidate_id"] = (
        str(command.continued_from_candidate_id)
        if command.continued_from_candidate_id is not None
        else None
    )
    # Skill 选择决定生成路径，属于请求输入的一部分；同一幂等键换用
    # 不同 Skill 必须冲突，不能静默重放旧选择生成的候选。
    payload["skill"] = (
        f"user_choice:{command.skill.version_id}"
        if isinstance(command.skill, UserSkillChoice)
        else "disabled" if isinstance(command.skill, NoSkill) else "auto"
    )
    if command.scene is not None:
        payload["scene"] = command.scene
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def normalize_reply_input(command: GenerateReply) -> str:
    """生成请求的持久化指纹；新建议协议只保存摘要。"""

    normalized = canonical_reply_input(command)
    # 新建议协议在来源核验前领取幂等键，只保存指纹，拒绝路径不留派生正文。
    # 成功快照与完整删除依赖由上下文保存；既有无建议请求保持原指纹兼容。
    content = command.content
    if (isinstance(content, ReplyToMessage) and content.direction.suggestion is not None
            or isinstance(content, InitiateConversation) and content.purpose.suggestion is not None):
        return "suggestion-sha256:" + sha256(normalized.encode("utf-8")).hexdigest()
    return normalized


def valid_tool_call_trace(trace: object) -> bool:
    """本轮 Tool 轨迹的最小结构合同；三处入口共用一份。"""

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


def validate_reply_context(
    context: object,
    *,
    command: GenerateReply | None = None,
    binding: ReplyContextBinding | None = None,
    continued_candidate_text: Callable[[UUID], str | None] | None = None,
) -> frozenset[UUID]:
    """校验上下文快照并返回证据标识集合。

    ``command`` 是生成入口的权威命令；``binding`` 是持久化入口的请求事实；
    ``continued_candidate_text`` 只在调用方持有候选权威（回表）时传入。
    """

    if command is None and binding is None:
        raise TypeError("回复上下文校验需要请求命令或已持久化请求事实。")
    if not isinstance(context, ReplyContext):
        raise ReplyContextValidationError("回复上下文快照结构无效。")
    _validate_structure(context)
    if command is not None:
        if context.command != command or context.scope != command.scope:
            raise ReplyContextValidationError("回复上下文不属于当前请求。")
    if binding is not None:
        _validate_binding(context, binding)
    evidence_ids = _validate_evidence(context)
    _validate_tool_calls(context, evidence_ids)
    _validate_discussion(context)
    _validate_continuation(context, continued_candidate_text)
    _validate_input_mode(context)
    return evidence_ids


def _validate_structure(context: ReplyContext) -> None:
    command = context.command
    content = command.content if isinstance(command, GenerateReply) else None
    if not isinstance(command, GenerateReply) or not isinstance(
        content, (ReplyToMessage, InitiateConversation, RewriteDraft)
    ):
        raise ReplyContextValidationError("回复输入模式无效。")
    if not (
        command.has_valid_content()
        and isinstance(context.reply_request_id, UUID)
        and isinstance(context.scope, ContactScope)
        and isinstance(context.current_text, str)
        and (
            bool(context.current_text.strip())
            or _empty_workspace_suggestion(content)
        )
        and isinstance(context.evidence, tuple)
        and context.evidence
        and isinstance(context.skill_library_revision, int)
        and context.skill_library_revision >= 0
        and isinstance(context.risk_notes, tuple)
        and all(
            isinstance(note, str) and note.strip()
            for note in context.risk_notes
        )
        and (
            context.memory_revision is None
            or isinstance(context.memory_revision, int)
            and context.memory_revision >= 0
        )
        and (
            context.index_revision is None
            or isinstance(context.index_revision, int)
            and context.index_revision >= 0
        )
        and isinstance(context.tool_calls, tuple)
        and type(context.layered_read_failed) is bool
        and type(context.owner_layered_read_failed) is bool
        and type(context.overview_read_failed) is bool
    ):
        raise ReplyContextValidationError("回复上下文快照结构无效。")


def _empty_workspace_suggestion(content: object) -> bool:
    return (
        isinstance(content, RewriteDraft)
        and content.input_kind == "workspace"
        and content.workspace_action == "suggest"
    )


def _validate_binding(
    context: ReplyContext,
    binding: ReplyContextBinding,
) -> None:
    command = context.command
    if not (
        isinstance(binding, ReplyContextBinding)
        and context.reply_request_id == binding.request_id
        and context.scope == binding.scope
        and command.scope == binding.scope
        and command.has_valid_content()
        and command.idempotency_key == binding.idempotency_key
        and command.conversation_binding_id == binding.conversation_binding_id
        and command.continued_from_candidate_id == binding.continued_from_candidate_id
        and normalize_reply_input(command) == binding.normalized_input
    ):
        raise ReplyContextValidationError("回复上下文不属于当前持久化请求。")


def _validate_evidence(context: ReplyContext) -> frozenset[UUID]:
    try:
        require_receipt_evidence(context.retrieval, context.evidence)
    except (AttributeError, TypeError, ValueError):
        raise ReplyContextValidationError("回复检索回执与实际依据不一致。") from None
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
            or not evidence_contract_is_valid(
                kind=item.kind,
                status=item.status,
                selection_reason=item.selection_reason,
            )
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
        ):
            raise ReplyContextValidationError("回复依据超出范围或结构无效。")
        evidence_ids.add(item.evidence_id)
    return frozenset(evidence_ids)


def _validate_tool_calls(context: ReplyContext, evidence_ids: frozenset[UUID]) -> None:
    for trace in context.tool_calls:
        if not valid_tool_call_trace(trace):
            raise ReplyContextValidationError("回复 Tool 轨迹结构无效。")
        if not set(trace.evidence_ids) <= evidence_ids:
            raise ReplyContextValidationError("回复 Tool 轨迹引用了未知证据。")


def _validate_discussion(context: ReplyContext) -> None:
    discussion = context.assistant_discussion
    if discussion is not None and (
        not isinstance(discussion, DiscussionContext)
        or discussion.scope != context.scope
        or discussion.request_key != context.command.idempotency_key
    ):
        raise ReplyContextValidationError("助手讨论不属于当前请求。")


def _validate_continuation(
    context: ReplyContext,
    continued_candidate_text: Callable[[UUID], str | None] | None,
) -> None:
    continuation_evidence = tuple(
        item for item in context.evidence if item.kind == "continued_candidate"
    )
    candidate_id = context.command.continued_from_candidate_id
    if candidate_id is None:
        if continuation_evidence:
            raise ReplyContextValidationError("历史候选必须由用户显式选择。")
        return
    if (
        len(continuation_evidence) != 1
        or continuation_evidence[0].evidence_id != candidate_id
    ):
        raise ReplyContextValidationError("显式继续候选与上下文快照不一致。")
    if continued_candidate_text is None:
        return
    expected_text = continued_candidate_text(candidate_id)
    if expected_text is None or continuation_evidence[0].text != expected_text:
        raise ReplyContextValidationError("继续候选快照与已保存候选不一致。")


def _validate_input_mode(context: ReplyContext) -> None:
    content = context.command.content
    if isinstance(content, ReplyToMessage):
        target_evidence = tuple(
            item for item in context.evidence
            if item.evidence_id == content.target_message_id
        )
        if (
            len(target_evidence) != 1
            or target_evidence[0].kind != "message"
            or target_evidence[0].text != context.current_text
            or context.direction != content.direction
        ):
            raise ReplyContextValidationError("待回复消息或表达方向与请求不一致。")
        return
    if isinstance(content, InitiateConversation):
        purpose_evidence = tuple(
            item for item in context.evidence if item.kind == "user_purpose"
        )
        if (
            context.direction != content.purpose
            or context.current_text != content.purpose.text
            or len(purpose_evidence) != 1
            or purpose_evidence[0].text != content.purpose.text
        ):
            raise ReplyContextValidationError("主动目的与回复上下文不一致。")
        return
    if isinstance(content, RewriteDraft):
        if context.has_unauthorized_history():
            raise ReplyContextValidationError("当前改写不能使用历史资料。")
        draft_evidence = tuple(
            item for item in context.evidence
            if item.kind == (
                "user_current_chat"
                if content.input_kind == "current_chat"
                else "user_draft"
            )
            and item.text == content.draft_text
        )
        if (
            context.direction is not None
            or context.current_text != content.draft_text
            or len(draft_evidence) != (
                0
                if content.input_kind == "workspace"
                and not content.draft_text.strip()
                else 1
            )
        ):
            raise ReplyContextValidationError("改写草稿与回复上下文不一致。")
        return
    raise ReplyContextValidationError("回复输入模式无效。")
