"""固定上下文的版本化 JSON；只重建显式白名单中的值对象。"""
from dataclasses import fields, is_dataclass, replace
from datetime import datetime
from uuid import UUID
from types import UnionType
from typing import Any, Literal, Union, get_args, get_origin, get_type_hints

from notalone.memory.layered import LayeredMemorySnapshot, ScenarioDirectoryEntry
from notalone.reply.layered_context import LayeredReplyMaterial
from notalone.memory.timing import MemoryTiming
from notalone.reply.expression_preference_models import ExpressionPreferenceScope, ExpressionPreference
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.expression_preferences import expression_reply_mode, require_preference_contract
from notalone.reply.retrieval_receipt import (MemoryNavigation, OverviewRevision, ReplyRetrievalReceipt,
    RetrievalQuery, RetrievalBudget, SourceMessageBudget, require_receipt_evidence)
from notalone.reply.assistant_discussion import DiscussionContext, DiscussionItem, DiscussionSnapshot, DiscussionIdentity
from notalone.reply.context import ReplyContext, ContextEvidence, ToolCallTrace, ContinuedReplyCandidate, allows_history
from notalone.reply.interface import ConfirmedDirection, DirectionSource, SuggestionReference, GenerateReply, ReplyBasisChange
from notalone.reply.style_reference import StyleReference
from notalone.reply.assistant_continuation_reference import ContinuationGenerateReply
from notalone.scopes import ContactScope, OwnerScope

_TYPES = {cls.__name__: cls for cls in (LayeredMemorySnapshot, ScenarioDirectoryEntry, LayeredReplyMaterial, MemoryTiming, DiscussionContext, DiscussionItem,
    DiscussionSnapshot, DiscussionIdentity, ContextEvidence, ToolCallTrace, ConfirmedDirection,
    SuggestionReference, StyleReference, ContactScope, OwnerScope, ContinuedReplyCandidate, ReplyBasisChange,
    ExpressionPreferenceScope, ExpressionPreference, MemoryNavigation, OverviewRevision,
    ReplyRetrievalReceipt, RetrievalQuery, RetrievalBudget, SourceMessageBudget)}

CONTEXT_VERSION = 2
# 结构字段每次演进必须提升修订；不为旧快照静默补字段。
CONTEXT_SCHEMA_REVISION = 8


class PreparedContextFormatError(ValueError):
    """旧版、未知修订或损坏快照必须重新准备。"""


def _matches(value: Any, annotation: Any) -> bool:
    # command 由外部已验证的请求重建，持续要求使用既有受控子类型，不从 JSON 实例化。
    if annotation is GenerateReply:
        return type(value) in (GenerateReply, ContinuationGenerateReply)
    origin, args = get_origin(annotation), get_args(annotation)
    if origin in (Union, UnionType):
        return any(_matches(value, option) for option in args)
    if origin is Literal:
        return any(type(value) is type(option) and value == option for option in args)
    if origin is tuple:
        return (isinstance(value, tuple) and len(args) == 2 and args[1] is Ellipsis
                and all(_matches(item, args[0]) for item in value))
    return annotation is Any or type(value) is annotation


def _construct(cls: type, values: dict[str, Any]) -> Any:
    if set(values) != {field.name for field in fields(cls)}:
        raise PreparedContextFormatError("固定上下文字段无效，请重新准备。")
    hints = get_type_hints(cls)
    if any(not _matches(value, hints[name]) for name, value in values.items()):
        raise PreparedContextFormatError("固定上下文值无效，请重新准备。")
    return cls(**values)


def _encode(value: Any) -> Any:
    if isinstance(value, UUID):
        return {"uuid": str(value)}
    if isinstance(value, datetime):
        return {"datetime": value.isoformat()}
    if isinstance(value, DirectionSource):
        return {"direction_source": value.value}
    if isinstance(value, tuple):
        return [_encode(item) for item in value]
    if is_dataclass(value) and type(value).__name__ in _TYPES:
        return {"type": type(value).__name__, "fields": {f.name: _encode(getattr(value, f.name)) for f in fields(value)}}
    if type(value) is dict:
        return {"mapping": {key: _encode(item) for key, item in value.items()}}
    if type(value) is list:
        return {"list": [_encode(item) for item in value]}
    if value is None or type(value) in (str, int, bool, float):
        return value
    raise ValueError("固定上下文包含不支持的结构。")


def _decode(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(_decode(item) for item in value)
    if not isinstance(value, dict):
        return value
    if set(value) == {"mapping"}:
        return {key: _decode(item) for key, item in value["mapping"].items()}
    if set(value) == {"list"}:
        return [_decode(item) for item in value["list"]]
    if set(value) == {"uuid"}:
        return UUID(value["uuid"])
    if set(value) == {"datetime"}:
        return datetime.fromisoformat(value["datetime"])
    if set(value) == {"direction_source"}:
        return DirectionSource(value["direction_source"])
    cls = _TYPES.get(value.get("type"))
    if cls is None or set(value) != {"type", "fields"} or not isinstance(value["fields"], dict):
        raise ValueError("固定上下文结构无效。")
    return _construct(cls, {key: _decode(item) for key, item in value["fields"].items()})


def encode_context(context: ReplyContext) -> dict[str, Any]:
    return {"version": CONTEXT_VERSION, "schema_revision": CONTEXT_SCHEMA_REVISION,
        "context": {f.name: _encode(getattr(context, f.name))
        for f in fields(context) if f.name != "command"}}


def decode_context(payload: dict[str, Any], command: GenerateReply, request_id: UUID | None = None) -> ReplyContext:
    try:
        if (not isinstance(payload, dict) or set(payload) != {"version", "schema_revision", "context"}
                or type(payload["version"]) is not int or payload["version"] != CONTEXT_VERSION
                or type(payload["schema_revision"]) is not int
                or payload["schema_revision"] != CONTEXT_SCHEMA_REVISION
                or not isinstance(payload["context"], dict)):
            raise PreparedContextFormatError("固定上下文版本无效，请重新准备。")
        context = _construct(ReplyContext, {"command": command,
            **{key: _decode(value) for key, value in payload["context"].items()}})
        if context.scope != command.scope or any(item.scope != command.scope for item in context.evidence):
            raise PreparedContextFormatError("固定上下文范围无效，请重新准备。")
        require_preference_contract(context.scope, expression_reply_mode(command),
                                    context.expression_preferences, context.expression_preference_revision)
        if allows_history(command) and context.history_message_ids is None:
            raise PreparedContextFormatError("固定历史范围缺少证明，请重新准备。")
        require_receipt_evidence(context.retrieval, context.evidence)
        basis = context.continuation_basis
        if (basis is None) != (command.continued_from_candidate_id is None):
            raise PreparedContextFormatError("固定继续依据不完整，请重新准备。")
        if basis is not None and (basis.scope != command.scope
                or basis.conversation_binding_id != command.conversation_binding_id
                or basis.candidate_id != command.continued_from_candidate_id):
            raise PreparedContextFormatError("固定继续依据身份无效，请重新准备。")
        discussion = context.assistant_discussion
        if discussion is not None and (discussion.scope != command.scope
                or discussion.request_key != command.idempotency_key
                or discussion.snapshot.scope != command.scope
                or discussion.snapshot.request_key != command.idempotency_key):
            raise PreparedContextFormatError("固定讨论身份无效，请重新准备。")
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, ReplyContextInvariantError):
        raise PreparedContextFormatError("固定上下文格式已变化或损坏，请重新准备。") from None
    return replace(context, reply_request_id=request_id) if request_id else context
