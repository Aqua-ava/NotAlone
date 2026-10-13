"""候选维度依据的版本化值对象；不保存原文或模型正确性布尔标签。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import re
from typing import Any
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.memory.pragmatics import PragmaticSnapshot


class DimensionEvidenceChangedError(RuntimeError):
    """当前来源已无法复核；保留候选，禁止本次自动确认。"""


def evidence_timestamp(value: datetime | None) -> str | None:
    """依据摘要采用 UTC 瞬间；不改原窗口或原始载荷的时间表示。"""

    if value is None:
        return None
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None or value.utcoffset() is None
    ):
        raise ValueError("依据时间必须包含明确时区。")
    return value.astimezone(timezone.utc).isoformat()


def require_current_dimension_evidence(
    current: DimensionEvidence | None,
    expected: DimensionEvidence | None = None,
) -> None:
    """已有或调用方明确要求的依据不能在确认事务中失效或丢失。"""

    if expected is not None and not isinstance(expected, DimensionEvidence):
        raise TypeError("预期维度依据必须是 DimensionEvidence。")
    if current is None and expected is None:
        return
    if (
        current is None or not current.source_bound
        or (expected is not None and current.to_payload() != expected.to_payload())
    ):
        raise DimensionEvidenceChangedError("来源依据已变更，本次候选须重新确认。")


def _fields(value: object, names: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != names:
        raise ValueError("维度依据字段不符合版本契约。")
    return value


def _digest(value: object) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("维度依据摘要必须是 SHA-256。")


def _uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise ValueError("维度依据标识必须是 UUID 字符串。")
    return UUID(value)


def _array(value: object) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError("维度依据列表必须是数组。")
    return value


@dataclass(frozen=True, slots=True)
class TextSpan:
    """半开字符区间和该片段的摘要；不复制文字。"""

    start: int
    end: int
    sha256: str

    def __post_init__(self) -> None:
        if type(self.start) is not int or type(self.end) is not int:
            raise ValueError("依据字符区间必须使用整数。")
        if not 0 <= self.start < self.end:
            raise ValueError("依据字符区间无效。")
        _digest(self.sha256)

    def to_payload(self) -> dict[str, object]:
        return {"start": self.start, "end": self.end, "sha256": self.sha256}

    @classmethod
    def from_payload(cls, value: object) -> TextSpan:
        data = _fields(value, {"start", "end", "sha256"})
        return cls(**data)


@dataclass(frozen=True, slots=True)
class MessageSpan:
    """同窗口消息上的实际字符定位。"""

    message_id: UUID
    span: TextSpan

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID) or not isinstance(self.span, TextSpan):
            raise TypeError("来源片段定位无效。")

    def to_payload(self) -> dict[str, object]:
        return {"message_id": str(self.message_id), "span": self.span.to_payload()}

    @classmethod
    def from_payload(cls, value: object) -> MessageSpan:
        data = _fields(value, {"message_id", "span"})
        return cls(_uuid(data["message_id"]), TextSpan.from_payload(data["span"]))


@dataclass(frozen=True, slots=True)
class EvidenceMessage:
    """完整参与窗口的受控元数据及活动来源引用。"""

    message_id: UUID
    text_sha256: str
    text_length: int
    sender: str
    message_type: str
    occurred_at: datetime | None
    source_refs: tuple[tuple[UUID, UUID], ...]
    text_representation: str = "unknown"
    source_state_sha256: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID):
            raise TypeError("依据消息标识无效。")
        _digest(self.text_sha256)
        if self.source_state_sha256 is not None:
            _digest(self.source_state_sha256)
        if type(self.text_length) is not int or self.text_length <= 0:
            raise ValueError("依据消息长度无效。")
        if self.sender not in {"self", "contact"}:
            raise ValueError("依据消息说话人无效。")
        if not isinstance(self.message_type, str) or not self.message_type.strip():
            raise ValueError("依据消息类型不能为空。")
        if self.text_representation not in {
            "text", "processed_text", "placeholder", "unknown"
        }:
            raise ValueError("依据消息文字表示无效。")
        if self.occurred_at is not None and (
            not isinstance(self.occurred_at, datetime)
            or self.occurred_at.tzinfo is None
            or self.occurred_at.utcoffset() is None
        ):
            raise ValueError("依据消息时间必须带时区。")
        if not isinstance(self.source_refs, tuple) or any(
            not isinstance(pair, tuple) or len(pair) != 2
            or any(not isinstance(item, UUID) for item in pair)
            for pair in self.source_refs
        ):
            raise TypeError("依据来源引用无效。")
        if len({pair[0] for pair in self.source_refs}) != len(self.source_refs):
            raise ValueError("依据来源引用重复。")

    def to_payload(self) -> dict[str, object]:
        return {
            "message_id": str(self.message_id), "text_sha256": self.text_sha256,
            "text_length": self.text_length, "sender": self.sender,
            "message_type": self.message_type,
            "text_representation": self.text_representation,
            "source_state_sha256": self.source_state_sha256,
            "occurred_at": evidence_timestamp(self.occurred_at),
            "source_refs": [
                {"ref_id": str(ref), "source_id": str(source)}
                for ref, source in self.source_refs
            ],
        }

    @classmethod
    def from_payload(cls, value: object) -> EvidenceMessage:
        data = _fields(value, {
            "message_id", "text_sha256", "text_length", "sender",
            "message_type", "text_representation", "source_state_sha256",
            "occurred_at", "source_refs",
        })
        refs = []
        for item in _array(data["source_refs"]):
            ref = _fields(item, {"ref_id", "source_id"})
            refs.append((_uuid(ref["ref_id"]), _uuid(ref["source_id"])))
        timestamp = data["occurred_at"]
        if timestamp is not None and not isinstance(timestamp, str):
            raise ValueError("依据消息时间格式无效。")
        return cls(
            _uuid(data["message_id"]), data["text_sha256"], data["text_length"],
            data["sender"], data["message_type"],
            datetime.fromisoformat(timestamp) if timestamp is not None else None,
            tuple(refs), data["text_representation"], data["source_state_sha256"],
        )


@dataclass(frozen=True, slots=True)
class TextAlignment:
    """候选片段与来源片段的显式对应；完整性另由窗口校验。"""

    candidate: TextSpan
    source: MessageSpan

    def __post_init__(self) -> None:
        if (
            not isinstance(self.candidate, TextSpan)
            or not isinstance(self.source, MessageSpan)
        ):
            raise TypeError("保真对齐定位无效。")

    def to_payload(self) -> dict[str, object]:
        return {
            "candidate": self.candidate.to_payload(),
            "source": self.source.to_payload(),
        }

    @classmethod
    def from_payload(cls, value: object) -> TextAlignment:
        data = _fields(value, {"candidate", "source"})
        return cls(
            TextSpan.from_payload(data["candidate"]),
            MessageSpan.from_payload(data["source"]),
        )


@dataclass(frozen=True, slots=True)
class ReferenceAnchor:
    """指代提及和目标必须分别定位；未知主体不构成唯一消歧。"""

    mention: MessageSpan
    target: MessageSpan
    subject: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.mention, MessageSpan)
            or not isinstance(self.target, MessageSpan)
        ):
            raise TypeError("指代锚点无效。")
        if self.subject not in {"self", "contact", "shared", "unknown"}:
            raise ValueError("指代目标类型无效。")

    def to_payload(self) -> dict[str, object]:
        return {
            "mention": self.mention.to_payload(),
            "target": self.target.to_payload(), "subject": self.subject,
        }

    @classmethod
    def from_payload(cls, value: object) -> ReferenceAnchor:
        data = _fields(value, {"mention", "target", "subject"})
        return cls(
            MessageSpan.from_payload(data["mention"]),
            MessageSpan.from_payload(data["target"]), data["subject"],
        )


@dataclass(frozen=True, slots=True)
class MediaOrigin:
    """规范消息的实际类型与正文表示，不把媒体占位当作识别结果。"""

    message_id: UUID
    message_type: str
    representation: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.message_id, UUID)
            or not isinstance(self.message_type, str)
            or not self.message_type.strip()
        ):
            raise TypeError("媒体来源标识或类型无效。")
        if self.representation not in {
            "text", "processed_text", "placeholder", "unknown"
        }:
            raise ValueError("媒体文字表示无效。")

    def to_payload(self) -> dict[str, object]:
        return {
            "message_id": str(self.message_id),
            "message_type": self.message_type,
            "representation": self.representation,
        }

    @classmethod
    def from_payload(cls, value: object) -> MediaOrigin:
        data = _fields(value, {"message_id", "message_type", "representation"})
        return cls(
            _uuid(data["message_id"]), data["message_type"], data["representation"]
        )


@dataclass(frozen=True, slots=True)
class ReportedAttribution:
    """直接来源与被转述主体分别定位，关系缺失时保留未知。"""

    speaker: MessageSpan
    reported_subject: MessageSpan
    relationship: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.speaker, MessageSpan)
            or not isinstance(self.reported_subject, MessageSpan)
        ):
            raise TypeError("转述归属定位无效。")
        if self.relationship not in {"direct", "reported", "unknown"}:
            raise ValueError("转述来源关系无效。")

    def to_payload(self) -> dict[str, object]:
        return {
            "speaker": self.speaker.to_payload(),
            "reported_subject": self.reported_subject.to_payload(),
            "relationship": self.relationship,
        }

    @classmethod
    def from_payload(cls, value: object) -> ReportedAttribution:
        data = _fields(value, {"speaker", "reported_subject", "relationship"})
        return cls(
            MessageSpan.from_payload(data["speaker"]),
            MessageSpan.from_payload(data["reported_subject"]),
            data["relationship"],
        )


@dataclass(frozen=True, slots=True, repr=False)
class DimensionEvidence:
    """候选依据快照；NULL 是未知，存在快照也不代表已通过质量门。"""

    scope: ContactScope
    candidate_sha256: str
    window_sha256: str
    messages: tuple[EvidenceMessage, ...]
    pragmatics: PragmaticSnapshot | None = None
    paraphrase: tuple[TextAlignment, ...] | None = None
    reference: tuple[ReferenceAnchor, ...] | None = None
    media: tuple[MediaOrigin, ...] | None = None
    reported: tuple[ReportedAttribution, ...] | None = None
    version: int = 1
    # 仅实际来源校验设置；JSON 往返不带这一运行状态。
    source_bound: bool = field(default=False, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version != 1:
            raise ValueError("维度依据版本未受支持。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("维度依据必须带联系人范围。")
        _digest(self.candidate_sha256)
        _digest(self.window_sha256)
        if self.pragmatics is not None and not isinstance(
            self.pragmatics, PragmaticSnapshot
        ):
            raise TypeError("语用依据快照必须使用版本化受控字段。")
        if not isinstance(self.messages, tuple) or not self.messages or any(
            not isinstance(item, EvidenceMessage) for item in self.messages
        ):
            raise TypeError("维度依据必须包含完整窗口元数据。")
        if len({item.message_id for item in self.messages}) != len(self.messages):
            raise ValueError("维度依据窗口消息重复。")
        for value, expected in (
            (self.paraphrase, TextAlignment), (self.reference, ReferenceAnchor),
            (self.media, MediaOrigin), (self.reported, ReportedAttribution),
        ):
            if value is not None and (
                not isinstance(value, tuple)
                or any(not isinstance(item, expected) for item in value)
            ):
                raise TypeError("维度依据不能用模型布尔标签代替定位。")
        messages = {item.message_id: item for item in self.messages}
        for anchor in self.message_spans:
            message = messages.get(anchor.message_id)
            if message is None or anchor.span.end > message.text_length:
                raise ValueError("维度依据定位超出同一窗口。")
        for origin in self.media or ():
            message = messages.get(origin.message_id)
            if message is None or origin.message_type != message.message_type:
                raise ValueError("媒体依据不属于受控消息类型。")

    @property
    def message_spans(self) -> tuple[MessageSpan, ...]:
        return (
            *(item.source for item in self.paraphrase or ()),
            *(
                span for item in self.reference or ()
                for span in (item.mention, item.target)
            ),
            *(
                span for item in self.reported or ()
                for span in (item.speaker, item.reported_subject)
            ),
        )

    @property
    def dependency_ids(self) -> frozenset[UUID]:
        return frozenset(
            item for message in self.messages
            for item in (
                message.message_id, *(source for _, source in message.source_refs)
            )
        )

    def to_payload(self) -> dict[str, object]:
        def rows(value: tuple | None) -> object:
            return None if value is None else [item.to_payload() for item in value]

        return {
            "version": self.version,
            "scope": {
                "owner_id": str(self.scope.owner_id),
                "contact_id": str(self.scope.contact_id),
            },
            "candidate_sha256": self.candidate_sha256,
            "window_sha256": self.window_sha256,
            "pragmatics": (
                self.pragmatics.to_payload() if self.pragmatics is not None
                else None
            ),
            "messages": [item.to_payload() for item in self.messages],
            "paraphrase": rows(self.paraphrase), "reference": rows(self.reference),
            "media": rows(self.media), "reported": rows(self.reported),
        }

    @classmethod
    def from_payload(cls, value: object) -> DimensionEvidence:
        data = _fields(value, {
            "version", "scope", "candidate_sha256", "window_sha256", "messages",
            "pragmatics", "paraphrase", "reference", "media", "reported",
        })
        scope = _fields(data["scope"], {"owner_id", "contact_id"})
        kwargs: dict[str, Any] = {}
        for name, kind in (
            ("paraphrase", TextAlignment), ("reference", ReferenceAnchor),
            ("media", MediaOrigin), ("reported", ReportedAttribution),
        ):
            raw = data[name]
            kwargs[name] = None if raw is None else tuple(
                kind.from_payload(item) for item in _array(raw)
            )
        return cls(
            scope=ContactScope(_uuid(scope["owner_id"]), _uuid(scope["contact_id"])),
            candidate_sha256=data["candidate_sha256"],
            window_sha256=data["window_sha256"],
            pragmatics=(
                PragmaticSnapshot.from_payload(data["pragmatics"])
                if data["pragmatics"] is not None else None
            ),
            messages=tuple(
                EvidenceMessage.from_payload(item)
                for item in _array(data["messages"])
            ),
            version=data["version"], **kwargs,
        )
