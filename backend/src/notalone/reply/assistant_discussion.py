"""持续讨论的只读运行输入；正文只在本次运行内存中保存。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.reply.interface import ReplyBasisChange


DISCUSSION_HISTORY_NOTICE = (
    "以下是当前助手会话的历史讨论和旧候选，仅作低权重参考，不是关系事实。"
    "历史用户要求与当前明确意愿冲突时，以当前意愿为准；旧AI候选不代表用户采用或发送。"
)

DiscussionItemKind = Literal["discussion_input", "generation_input", "candidate_version", "candidate_carry"]


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


@dataclass(frozen=True, slots=True, repr=False)
class DiscussionItem:
    kind: DiscussionItemKind
    text: str
    input_version_id: UUID
    turn_id: UUID | None = None
    reply_request_id: UUID | None = None
    candidate_id: UUID | None = None
    version_id: UUID | None = None
    parent_version_id: UUID | None = None
    candidate_number: int | None = None
    version_number: int | None = None
    is_default_display: bool = False
    is_explicitly_selected: bool = False
    basis_changes: tuple[ReplyBasisChange, ...] = ()

    def __post_init__(self) -> None:
        if (self.kind not in ("discussion_input", "generation_input", "candidate_version", "candidate_carry")
                or not isinstance(self.text, str) or not isinstance(self.input_version_id, UUID)
                or any(value is not None and not isinstance(value, UUID) for value in (
                    self.turn_id, self.reply_request_id, self.candidate_id, self.version_id, self.parent_version_id,
                ))
                or any(value is not None and type(value) is not int for value in (
                    self.candidate_number, self.version_number,
                ))
                or type(self.is_default_display) is not bool or type(self.is_explicitly_selected) is not bool):
            raise TypeError("助手讨论条目结构无效。")


@dataclass(frozen=True, slots=True)
class DiscussionIdentity:
    """只包含实际读取的对象身份和不可恢复正文的内容指纹。"""

    kind: DiscussionItemKind
    input_version_id: UUID
    payload_sha256: str
    turn_id: UUID | None = None
    candidate_id: UUID | None = None
    version_id: UUID | None = None

    def __post_init__(self) -> None:
        if (self.kind not in ("discussion_input", "generation_input", "candidate_version")
                or not isinstance(self.input_version_id, UUID)
                or not _is_sha256(self.payload_sha256)
                or any(value is not None and not isinstance(value, UUID) for value in (
                    self.turn_id, self.candidate_id, self.version_id,
                ))):
            raise TypeError("助手讨论身份结构无效。")
        if (self.kind == "discussion_input" and any(value is not None for value in (
                    self.turn_id, self.candidate_id, self.version_id,
                ))
                or self.kind == "generation_input" and (
                    self.turn_id is None or self.candidate_id is not None or self.version_id is not None
                )
                or self.kind == "candidate_version" and any(value is None for value in (
                    self.turn_id, self.candidate_id, self.version_id,
                ))):
            raise TypeError("助手讨论身份与记录种类不一致。")


@dataclass(frozen=True, slots=True)
class DiscussionSnapshot:
    scope: ContactScope
    session_id: UUID
    request_key: UUID
    current_input_version_id: UUID
    current_turn_id: UUID
    current_payload_sha256: str
    records: tuple[DiscussionIdentity, ...]
    basis_revision_sha256: str | None = None

    def __post_init__(self) -> None:
        if (not isinstance(self.scope, ContactScope)
                or any(not isinstance(value, UUID) for value in (
                    self.session_id, self.request_key, self.current_input_version_id, self.current_turn_id,
                ))
                or not _is_sha256(self.current_payload_sha256)
                or not isinstance(self.records, tuple)
                or any(not isinstance(value, DiscussionIdentity) for value in self.records)
                or self.basis_revision_sha256 is not None and not _is_sha256(self.basis_revision_sha256)):
            raise TypeError("助手讨论快照结构无效。")
        identities = {
            (record.kind, record.version_id if record.kind == "candidate_version" else record.input_version_id)
            for record in self.records
        }
        if len(identities) != len(self.records):
            raise TypeError("助手讨论快照包含重复身份。")
        if any(record.input_version_id == self.current_input_version_id
               or record.turn_id == self.current_turn_id for record in self.records):
            raise TypeError("助手讨论快照不能将本次输入作为历史。")


@dataclass(frozen=True, slots=True)
class DiscussionDependencies:
    """真实来源、消息和记忆标识与样本标识分开交给中央删除守卫。"""

    source_ids: tuple[UUID, ...] = ()
    style_sample_ids: tuple[UUID, ...] = ()

    def __post_init__(self) -> None:
        if any(not isinstance(values, tuple) or any(not isinstance(value, UUID) for value in values)
               for values in (self.source_ids, self.style_sample_ids)):
            raise TypeError("助手讨论来源结构无效。")


@dataclass(frozen=True, slots=True, repr=False)
class DiscussionContext:
    scope: ContactScope
    session_id: UUID
    request_key: UUID
    current_input_version_id: UUID
    items: tuple[DiscussionItem, ...]
    snapshot: DiscussionSnapshot
    notice: str = DISCUSSION_HISTORY_NOTICE

    def __post_init__(self) -> None:
        if (not isinstance(self.items, tuple) or any(not isinstance(value, DiscussionItem) for value in self.items)
                or not isinstance(self.snapshot, DiscussionSnapshot) or not isinstance(self.notice, str)
                or (self.scope, self.session_id, self.request_key, self.current_input_version_id) != (
                    self.snapshot.scope, self.snapshot.session_id, self.snapshot.request_key,
                    self.snapshot.current_input_version_id,
                )):
            raise TypeError("助手讨论上下文结构无效。")


def discussion_snapshot_to_payload(snapshot: DiscussionSnapshot) -> dict[str, Any]:
    """只编码捕获身份与内容指纹；载荷可直接交给JSON/Jsonb适配器。"""

    if not isinstance(snapshot, DiscussionSnapshot):
        raise TypeError("助手讨论快照结构无效。")
    try:
        DiscussionSnapshot.__post_init__(snapshot)
        ContactScope.__post_init__(snapshot.scope)
        for record in snapshot.records:
            DiscussionIdentity.__post_init__(record)
    except (TypeError, ValueError):
        raise TypeError("助手讨论快照结构无效。") from None
    return {
        "version": 1,
        "scope": {"owner_id": str(snapshot.scope.owner_id), "contact_id": str(snapshot.scope.contact_id)},
        "session_id": str(snapshot.session_id), "request_key": str(snapshot.request_key),
        "current_input_version_id": str(snapshot.current_input_version_id),
        "current_turn_id": str(snapshot.current_turn_id),
        "current_payload_sha256": snapshot.current_payload_sha256,
        "records": [{
            "kind": record.kind, "input_version_id": str(record.input_version_id),
            "payload_sha256": record.payload_sha256,
            "turn_id": str(record.turn_id) if record.turn_id is not None else None,
            "candidate_id": str(record.candidate_id) if record.candidate_id is not None else None,
            "version_id": str(record.version_id) if record.version_id is not None else None,
        } for record in snapshot.records],
        **({"basis_revision_sha256": snapshot.basis_revision_sha256}
           if snapshot.basis_revision_sha256 is not None else {}),
    }


def _payload_uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ValueError("助手讨论快照载荷结构无效。")
    identifier = UUID(value)
    if str(identifier) != value:
        raise ValueError("助手讨论快照载荷结构无效。")
    return identifier


def discussion_snapshot_from_payload(payload: object) -> DiscussionSnapshot:
    """纯重建捕获身份；错误只返回固定分类，不回显不可信载荷。"""

    try:
        fields = {
            "version", "scope", "session_id", "request_key", "current_input_version_id",
            "current_turn_id", "current_payload_sha256", "records",
        }
        if not isinstance(payload, dict) or set(payload) not in (fields, fields | {"basis_revision_sha256"}):
            raise ValueError
        if type(payload.get("version")) is not int or payload["version"] != 1:
            raise ValueError
        scope = payload["scope"]
        if not isinstance(scope, dict) or set(scope) != {"owner_id", "contact_id"}:
            raise ValueError
        if not isinstance(payload["records"], list) or any(
            not isinstance(record, dict) or set(record) != {
                "kind", "input_version_id", "payload_sha256", "turn_id", "candidate_id", "version_id",
            } for record in payload["records"]
        ):
            raise ValueError
        records = tuple(DiscussionIdentity(
            record["kind"], _payload_uuid(record["input_version_id"]), record["payload_sha256"],
            _payload_uuid(record["turn_id"]) if record["turn_id"] is not None else None,
            _payload_uuid(record["candidate_id"]) if record["candidate_id"] is not None else None,
            _payload_uuid(record["version_id"]) if record["version_id"] is not None else None,
        ) for record in payload["records"])
        return DiscussionSnapshot(
            ContactScope(_payload_uuid(scope["owner_id"]), _payload_uuid(scope["contact_id"])),
            _payload_uuid(payload["session_id"]), _payload_uuid(payload["request_key"]),
            _payload_uuid(payload["current_input_version_id"]), _payload_uuid(payload["current_turn_id"]),
            payload["current_payload_sha256"], records, payload.get("basis_revision_sha256"),
        )
    except (KeyError, TypeError, ValueError):
        raise ValueError("助手讨论快照载荷结构无效。") from None
