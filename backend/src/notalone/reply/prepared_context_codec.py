"""固定上下文的版本化 JSON；只重建显式白名单中的值对象。"""
from dataclasses import fields, is_dataclass, replace
from datetime import datetime
from uuid import UUID
from typing import Any

from notalone.memory.timing import MemoryTiming
from notalone.reply.assistant_discussion import DiscussionContext, DiscussionItem, DiscussionSnapshot, DiscussionIdentity
from notalone.reply.context import ReplyContext, ContextEvidence, ToolCallTrace
from notalone.reply.interface import ConfirmedDirection, DirectionSource, SuggestionReference, GenerateReply
from notalone.reply.style_reference import StyleReference
from notalone.scopes import ContactScope

_TYPES = {cls.__name__: cls for cls in (MemoryTiming, DiscussionContext, DiscussionItem,
    DiscussionSnapshot, DiscussionIdentity, ContextEvidence, ToolCallTrace, ConfirmedDirection,
    SuggestionReference, StyleReference, ContactScope)}


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
    if value is None or type(value) in (str, int, bool, float):
        return value
    raise ValueError("固定上下文包含不支持的结构。")


def _decode(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(_decode(item) for item in value)
    if not isinstance(value, dict):
        return value
    if set(value) == {"uuid"}:
        return UUID(value["uuid"])
    if set(value) == {"datetime"}:
        return datetime.fromisoformat(value["datetime"])
    if set(value) == {"direction_source"}:
        return DirectionSource(value["direction_source"])
    cls = _TYPES.get(value.get("type"))
    if cls is None or set(value) != {"type", "fields"} or set(value["fields"]) != {f.name for f in fields(cls)}:
        raise ValueError("固定上下文结构无效。")
    return cls(**{key: _decode(item) for key, item in value["fields"].items()})


def encode_context(context: ReplyContext) -> dict[str, Any]:
    return {"version": 1, "context": {f.name: _encode(getattr(context, f.name))
        for f in fields(context) if f.name != "command"}}


def decode_context(payload: dict[str, Any], command: GenerateReply, request_id: UUID | None = None) -> ReplyContext:
    if set(payload) != {"version", "context"} or payload["version"] != 1:
        raise ValueError("固定上下文版本无效。")
    if set(payload["context"]) != {f.name for f in fields(ReplyContext) if f.name != "command"}:
        raise ValueError("固定上下文字段无效。")
    context = ReplyContext(command=command, **{key: _decode(value) for key, value in payload["context"].items()})
    return replace(context, reply_request_id=request_id) if request_id else context
