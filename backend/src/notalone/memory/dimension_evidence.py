"""候选维度依据的版本化值对象；不保存原文或模型正确性布尔标签。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import re
import json
import hashlib
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

    def to_payload(self, *, version: int = 1) -> dict[str, object]:
        return {
            "message_id": str(self.message_id), "text_sha256": self.text_sha256,
            "text_length": self.text_length, "sender": self.sender,
            "message_type": self.message_type,
            "text_representation": self.text_representation,
            "source_state_sha256": self.source_state_sha256,
            "occurred_at": (self.occurred_at.isoformat() if self.occurred_at is not None else None) if version == 4 else evidence_timestamp(self.occurred_at),
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


SEMANTIC_RULE_IDS = frozenset({
    "AUTHOR_ARRIVAL_H1", "KIN_LEND_BA_H1", "REQUEST_ROLE_H1",
    "SOURCE_IDENTITY_H1", "COND_PLAN_RUN_V1",
})
AUTHOR_QUOTE_CAPABILITIES = (
    "author_binding", "arrival_event_preservation", "author_self_reference",
    "direct_attribution", "recency_preservation",
)
_ROLE_KINDS = frozenset({
    "author", "elder_sister", "elder_brother", "colleague",
    "vehicle", "book", "umbrella",
})
_ROLE_SLOTS = frozenset({
    "agent", "recipient", "object", "property_owner", "beneficiary", "actor",
})
_ATOM_PHASES = {
    "arrive_home": "completed", "lend": "completed", "request": "historical",
    "receive_request": "historical", "cover_shift": "requested",
    "run": "planned", "clear_weather": "condition",
}


def _number(value: object, limit: int) -> int:
    if type(value) is not int or not 0 <= value < limit:
        raise ValueError("语义依据编号必须是范围内的整数。")
    return value


def _bounded_rows(value: object, limit: int) -> list[Any]:
    rows = _array(value)
    if len(rows) > limit:
        raise ValueError("语义依据条目超过有限合同。")
    return rows


def _source_and_candidate(row: dict[str, Any]) -> None:
    MessageSpan.from_payload(row["source"])
    TextSpan.from_payload(row["candidate"])


def _semantic_rules(
    value: object,
) -> None:
    rules = []
    for item in _bounded_rows(value, 8):
        row = _fields(item, {"rule_id", "rule_version"})
        if (
            row["rule_id"] not in SEMANTIC_RULE_IDS
            or type(row["rule_version"]) is not int or row["rule_version"] != 1
        ):
            raise ValueError("语义依据规则未受支持。")
        rules.append(row["rule_id"])
    if len(set(rules)) != len(rules):
        raise ValueError("语义依据规则重复。")


def _semantic_roles(
    value: object,
) -> dict[int, dict[str, Any]]:
    roles: dict[int, dict[str, Any]] = {}
    for item in _bounded_rows(value, 16):
        row = _fields(item, {"role_id", "kind", "sender", "source"})
        identifier = _number(row["role_id"], 16)
        if identifier in roles or row["kind"] not in _ROLE_KINDS:
            raise ValueError("语义依据角色重复或类型无效。")
        if (
            row["kind"] == "author" and row["sender"] not in {"self", "contact"}
            or row["kind"] != "author" and row["sender"] is not None
        ):
            raise ValueError("只有作者可绑定受控发送者。")
        MessageSpan.from_payload(row["source"])
        roles[identifier] = row
    return roles


def _semantic_atoms(
    value: object, roles: dict[int, dict[str, Any]],
) -> dict[int, dict[str, Any]]:
    atoms: dict[int, dict[str, Any]] = {}
    for item in _bounded_rows(value, 16):
        row = _fields(item, {"atom_id", "predicate", "phase", "roles", "source", "candidate"})
        identifier = _number(row["atom_id"], 16)
        if identifier in atoms or _ATOM_PHASES.get(row["predicate"]) != row["phase"]:
            raise ValueError("语义依据命题重复或阶段无效。")
        slots = _fields(row["roles"], set(_ROLE_SLOTS))
        for slot, role in slots.items():
            if role is None:
                continue
            role_id = _number(role, 16)
            if role_id not in roles:
                raise ValueError("命题引用了本图以外的角色。")
            is_object = roles[role_id]["kind"] in {"vehicle", "book", "umbrella"}
            if (slot == "object") != is_object:
                raise ValueError("命题角色槽与人物或物件类型不符。")
        _source_and_candidate(row)
        atoms[identifier] = row
    return atoms


def _semantic_qualifiers(
    value: object, atoms: dict[int, dict[str, Any]],
) -> None:
    qualifiers: dict[int, dict[str, Any]] = {}
    edges: set[tuple[object, ...]] = set()
    for item in _bounded_rows(value, 32):
        if not isinstance(item, dict):
            raise ValueError("限定条目必须是对象。")
        kind = item.get("kind")
        common = {"qualifier_id", "kind", "source", "candidate"}
        names = {
            "polarity": {"atom_id", "slot", "value_sha256"},
            "quantity": {"atom_id", "slot", "value_sha256"},
            "degree": {"quantity_qualifier_id", "modifier", "value_sha256"},
            "condition": {"condition_atom_id", "action_atom_id", "relation"},
            "time": {"atom_id", "slot", "value_sha256"},
        }
        if kind not in names:
            raise ValueError("限定类型未受支持。")
        row = _fields(item, common | names[kind])
        identifier = _number(row["qualifier_id"], 32)
        if identifier in qualifiers:
            raise ValueError("限定编号重复。")
        _source_and_candidate(row)
        if kind != "condition":
            _digest(row["value_sha256"])
        if kind in {"polarity", "quantity", "time"}:
            atom_id = _number(row["atom_id"], 16)
            atom = atoms.get(atom_id)
            if atom is None:
                raise ValueError("限定引用了本图以外的命题。")
            predicate = atom["predicate"]
            slot = row["slot"]
            if (
                kind == "polarity" and (predicate != "lend" or slot != "predicate")
                or kind == "quantity" and (predicate != "run" or slot != "distance")
                or kind == "time" and (
                    slot == "event_time" and predicate not in {"arrive_home", "lend", "run"}
                    or slot == "requested_time" and predicate != "cover_shift"
                    or slot not in {"event_time", "requested_time", "observation_time"}
                )
            ):
                raise ValueError("限定槽与命题类型不符。")
            edge = (kind, atom_id, slot)
        elif kind == "degree":
            quantity_id = _number(row["quantity_qualifier_id"], 32)
            if row["modifier"] not in {"only", "approx"}:
                raise ValueError("程度修饰未受支持。")
            edge = (kind, quantity_id, row["modifier"])
        else:
            condition_id = _number(row["condition_atom_id"], 16)
            action_id = _number(row["action_atom_id"], 16)
            condition, action = atoms.get(condition_id), atoms.get(action_id)
            if (
                row["relation"] != "requires" or condition_id == action_id
                or condition is None or condition["predicate"] != "clear_weather"
                or action is None or action["predicate"] != "run"
            ):
                raise ValueError("条件必须由本图计划行动指向天气条件。")
            edge = (kind, condition_id, action_id)
        if edge in edges:
            raise ValueError("限定关系重复。")
        edges.add(edge)
        qualifiers[identifier] = row
    for row in qualifiers.values():
        if row["kind"] == "degree":
            quantity = qualifiers.get(row["quantity_qualifier_id"])
            if quantity is None or quantity["kind"] != "quantity":
                raise ValueError("程度修饰必须指向本图距离数量。")


def _semantic_bindings(
    value: object, roles: dict[int, dict[str, Any]],
) -> None:
    bindings = set()
    for item in _bounded_rows(value, 8):
        row = _fields(item, {"role_id", "method", "mention", "target", "binding"})
        role_id = _number(row["role_id"], 16)
        role = roles.get(role_id)
        mention = MessageSpan.from_payload(row["mention"])
        target = MessageSpan.from_payload(row["target"])
        if role is None or role_id in bindings or mention.message_id != target.message_id:
            raise ValueError("指称必须绑定本图唯一角色和同消息三锚。")
        if row["method"] == "actual_sender":
            if role["kind"] != "author" or row["binding"] is not None or mention != target:
                raise ValueError("作者自指必须由受控发送者及同一我锚支持。")
        elif row["method"] == "source_identity":
            binding = MessageSpan.from_payload(row["binding"])
            if role["kind"] == "author" or binding.message_id != mention.message_id:
                raise ValueError("第三方指称必须带同消息的来源指称句。")
        else:
            raise ValueError("指称方法未受支持。")
        bindings.add(role_id)


def _semantic_unresolved(
    value: object, atoms: dict[int, dict[str, Any]],
) -> None:
    unresolved = set()
    for item in _bounded_rows(value, 32):
        row = _fields(item, {"atom_id", "slot", "source", "reason"})
        atom_id = _number(row["atom_id"], 16)
        if (
            atom_id not in atoms or row["slot"] not in _ROLE_SLOTS
            or atoms[atom_id]["roles"][row["slot"]] is not None
            or row["reason"] not in {
                "missing_source_identity", "ambiguous_source", "unsupported_grammar",
            }
            or (atom_id, row["slot"]) in unresolved
        ):
            raise ValueError("未解关系不属于本图的未解角色槽。")
        MessageSpan.from_payload(row["source"])
        unresolved.add((atom_id, row["slot"]))
    required_slots = {
        "arrive_home": {"actor"}, "lend": {"agent", "recipient", "object", "property_owner"},
        "request": {"agent", "recipient"}, "receive_request": {"agent", "recipient"},
        "cover_shift": {"actor", "beneficiary"}, "run": {"actor"}, "clear_weather": set(),
    }
    for atom_id, atom in atoms.items():
        for slot in required_slots[atom["predicate"]]:
            if atom["roles"][slot] is None and (atom_id, slot) not in unresolved:
                raise ValueError("应适用而未解的角色槽必须显式登记。")


def _validate_semantic_basis(value: object) -> dict[str, Any]:
    if isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 3:
        from .bounded_evidence import validate_basis
        return validate_basis(value)
    if isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 2:
        return _validate_author_quote_basis(value)
    data = _fields(value, {
        "version", "rule_set_sha256", "rules", "roles", "atoms", "qualifiers",
        "reference_bindings", "frame", "unresolved", "source_graph_sha256",
        "candidate_graph_sha256",
    })
    if type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("语义依据版本未受支持。")
    for name in ("rule_set_sha256", "source_graph_sha256", "candidate_graph_sha256"):
        _digest(data[name])
    if data["frame"] not in {"direct", "quoted_request_h", "received_request_h"}:
        raise ValueError("语义依据转述框架无效。")
    _semantic_rules(data["rules"])
    roles = _semantic_roles(data["roles"])
    atoms = _semantic_atoms(data["atoms"], roles)
    _semantic_qualifiers(data["qualifiers"], atoms)
    _semantic_bindings(data["reference_bindings"], roles)
    _semantic_unresolved(data["unresolved"], atoms)
    return data


def _validate_author_quote_basis(value: object) -> dict[str, Any]:
    data = _fields(value, {
        "version", "rule_set_sha256", "rules", "roles", "atoms", "qualifiers",
        "reference_bindings", "frame", "unresolved", "source_graph_sha256",
        "candidate_graph_sha256", "representation", "capabilities",
    })
    for name in ("rule_set_sha256", "source_graph_sha256", "candidate_graph_sha256"):
        _digest(data[name])
    rules = _bounded_rows(data["rules"], 1)
    if len(rules) != 1:
        raise ValueError("作者引句只支持单一到达规则。")
    rule = _fields(rules[0], {"rule_id", "rule_version"})
    if rule["rule_id"] != "AUTHOR_ARRIVAL_H1" or type(rule["rule_version"]) is not int or rule["rule_version"] != 2:
        raise ValueError("作者引句规则版本不匹配。")
    roles = _semantic_roles(data["roles"])
    atoms = _semantic_atoms(data["atoms"], roles)
    _semantic_qualifiers(data["qualifiers"], atoms)
    _semantic_bindings(data["reference_bindings"], roles)
    if (set(roles) != {0} or roles[0]["kind"] != "author" or set(atoms) != {0}
        or atoms[0]["predicate"] != "arrive_home" or data["frame"] != "direct"
        or data["unresolved"] != [] or data["capabilities"] != list(AUTHOR_QUOTE_CAPABILITIES)
        or data["source_graph_sha256"] != data["candidate_graph_sha256"]):
        raise ValueError("作者引句的完整事件或封闭能力不匹配。")
    atom = atoms[0]
    if any(value != (0 if name == "actor" else None) for name, value in atom["roles"].items()):
        raise ValueError("到达事件只能包含作者actor。")
    qualifiers = _bounded_rows(data["qualifiers"], 1)
    bindings = _bounded_rows(data["reference_bindings"], 1)
    if len(qualifiers) != 1 or len(bindings) != 1:
        raise ValueError("到达事件必须保留唯一recency与作者自指。")
    qualifier, binding = qualifiers[0], bindings[0]
    if (qualifier.get("qualifier_id") != 0 or qualifier.get("kind") != "time"
        or qualifier.get("atom_id") != 0 or qualifier.get("slot") != "event_time"
        or qualifier.get("value_sha256") != hashlib.sha256(b'{"event_time":"just"}').hexdigest()
        or binding["role_id"] != 0 or binding["method"] != "actual_sender"
        or binding["mention"] != roles[0]["source"] or binding["target"] != roles[0]["source"]):
        raise ValueError("到达事件的限定或自指不完整。")
    representation = _fields(data["representation"], {"version", "kind", "source", "candidate", "author", "inner"})
    if type(representation["version"]) is not int or representation["version"] != 1 or representation["kind"] != "author_quote_h1":
        raise ValueError("作者引句表示未受支持。")
    source = MessageSpan.from_payload(representation["source"])
    whole, author, inner = (TextSpan.from_payload(representation[name]) for name in ("candidate", "author", "inner"))
    event = MessageSpan.from_payload(atom["source"])
    source_author = MessageSpan.from_payload(roles[0]["source"])
    time_source = MessageSpan.from_payload(qualifier["source"])
    time_candidate = TextSpan.from_payload(qualifier["candidate"])
    author_width = 2 if roles[0]["sender"] == "self" else 3
    if (whole.start != author.start or author.end - author.start != author_width
        or inner.start != author.end + 4 or whole.end != inner.end + 1
        or inner.end - inner.start != source.span.end - source.span.start
        or inner.sha256 != source.span.sha256
        or atom["candidate"] != representation["candidate"]
        or any(span.message_id != source.message_id for span in (event, source_author, time_source))
        or event.span.start != source.span.start or source.span.end - event.span.end not in {0, 1}
        or source_author.span.start != source.span.start or source_author.span.end != source.span.start + 1
        or time_source.span.start != source_author.span.end or time_source.span.end - time_source.span.start not in {1, 2}
        or event.span.end != time_source.span.end + 2
        or time_candidate.start != inner.start + time_source.span.start - source.span.start
        or time_candidate.end != inner.start + time_source.span.end - source.span.start
        or time_candidate.sha256 != time_source.span.sha256):
        raise ValueError("作者引句必须完整覆盖原事件并映射实际坐标。")
    return data


@dataclass(frozen=True, slots=True, repr=False)
class SemanticBasis:
    """服务端规范关系的不可变无正文快照；结构合法不表示语义正确。"""

    _canonical_json: str

    def __post_init__(self) -> None:
        if not isinstance(self._canonical_json, str):
            raise TypeError("语义依据必须是受控版本化对象。")
        raw = json.loads(self._canonical_json)
        if isinstance(raw, dict) and raw.get("version") == 3:
            def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError("有限语义依据不能包含重复JSON键。")
                    result[key] = value
                return result
            raw = json.loads(self._canonical_json, object_pairs_hook=unique)
        _validate_semantic_basis(raw)

    @classmethod
    def from_payload(cls, value: object) -> SemanticBasis:
        _validate_semantic_basis(value)
        return cls(json.dumps(value, ensure_ascii=False, sort_keys=True,
                              separators=(",", ":"), allow_nan=False))

    def to_payload(self) -> dict[str, Any]:
        return json.loads(self._canonical_json)

    @property
    def message_spans(self) -> tuple[MessageSpan, ...]:
        data = self.to_payload()
        rows = [row["source"] for name in ("roles", "atoms", "qualifiers", "unresolved") for row in data[name]]
        for binding in data["reference_bindings"]:
            rows.extend((binding["mention"], binding["target"]))
            if binding["binding"] is not None:
                rows.append(binding["binding"])
        if data["version"] == 2:
            rows.append(data["representation"]["source"])
        if data["version"] == 3:
            rep = data["representation"]
            rows.extend((*rep["source_full"], *rep["quote_sources"], *(row["source"] for row in rep["contexts"])))
        return tuple(MessageSpan.from_payload(row) for row in rows)

    @property
    def candidate_spans(self) -> tuple[TextSpan, ...]:
        data = self.to_payload()
        rows = [row["candidate"] for name in ("atoms", "qualifiers") for row in data[name]]
        if data["version"] == 2:
            rows.extend(data["representation"][name] for name in ("candidate", "author", "inner"))
        if data["version"] == 3:
            rep = data["representation"]
            rows.extend(row["candidate"] for row in data["roles"])
            rows.extend(rep[name] for name in ("whole", "author", "quote"))
            if rep["observation"] is not None:
                rows.append(rep["observation"]["candidate"])
            rows.extend(row[name] for row in rep["contexts"] for name in ("whole", "author", "quote"))
        return tuple(TextSpan.from_payload(row) for row in rows)


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
    semantic_basis: SemanticBasis | None = None
    target_message_ids: tuple[UUID, ...] = ()
    # 仅实际来源校验设置；JSON 往返不带这一运行状态。
    source_bound: bool = field(default=False, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version not in {1, 2, 3, 4}:
            raise ValueError("维度依据版本未受支持。")
        if self.semantic_basis is not None and (
            self.version not in {2, 3, 4} or not isinstance(self.semantic_basis, SemanticBasis)
            or self.semantic_basis.to_payload()["version"] != self.version - 1
        ):
            raise TypeError("语义依据必须与外层版本精确配对。")
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
        if self.version == 4:
            identifiers = tuple(item.message_id for item in self.messages)
            if (len(self.messages) > 4 or any(item.text_length > 4096 or len(item.source_refs) > 64
                    or item.source_refs != tuple(sorted(item.source_refs, key=lambda row: str(row[0]))) for item in self.messages)
                    or not isinstance(self.target_message_ids, tuple) or not self.target_message_ids
                    or any(not isinstance(item, UUID) for item in self.target_message_ids)
                    or self.target_message_ids != tuple(item for item in identifiers if item in self.target_message_ids)
                    or self.reference is not None or self.reported is not None
                    or self.paraphrase is not None and len(self.paraphrase) > 16
                    or self.media is not None and (len(self.media) > 4
                        or tuple(item.message_id for item in self.media) != tuple(item for item in identifiers if item in {row.message_id for row in self.media}))):
                raise ValueError("版本四依据须保留有界完整窗口、原目标和新语义槽。")
            if self.semantic_basis is not None:
                rep = self.semantic_basis.to_payload()["representation"]
                if (self.pragmatics is None or rep["target_message_id"] not in {str(item) for item in self.target_message_ids}
                        or any(not item.source_refs or item.source_state_sha256 is None or item.message_type != "text"
                            or item.text_representation != "text" for item in self.messages)
                        or [(row["message_id"], row["span"]["start"], row["span"]["end"], row["span"]["sha256"]) for row in rep["source_full"]]
                        != [(str(item.message_id), 0, item.text_length, item.text_sha256) for item in self.messages]):
                    raise ValueError("版本四语义依据缺少完整窗口或原目标。")
        elif self.target_message_ids:
            raise ValueError("旧依据不能带版本四目标集合。")
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
        if self.version == 4 and any(item.candidate.end > 4096 for item in self.paraphrase or ()):
            raise ValueError("版本四候选对齐超出有界正文。")
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
            *(self.semantic_basis.message_spans if self.semantic_basis else ()),
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

        payload: dict[str, object] = {
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
            "messages": [item.to_payload(version=self.version) for item in self.messages],
            "paraphrase": rows(self.paraphrase), "reference": rows(self.reference),
            "media": rows(self.media), "reported": rows(self.reported),
        }
        if self.version == 4:
            payload["target_message_ids"] = [str(item) for item in self.target_message_ids]
        if self.version in {2, 3, 4}:
            payload["semantic_basis"] = (
                self.semantic_basis.to_payload()
                if self.semantic_basis is not None else None
            )
        return payload

    @classmethod
    def from_payload(cls, value: object) -> DimensionEvidence:
        names = {
            "version", "scope", "candidate_sha256", "window_sha256", "messages",
            "pragmatics", "paraphrase", "reference", "media", "reported",
        }
        if isinstance(value, dict) and type(value.get("version")) is int and value["version"] in {2, 3, 4}:
            names.add("semantic_basis")
        if isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 4:
            names.add("target_message_ids")
        data = _fields(value, names)
        if data["version"] == 4:
            def canonical_ids(raw: Any, key: str = "") -> None:
                if key in {"owner_id", "contact_id", "message_id", "target_message_id", "ref_id", "source_id"}:
                    if not isinstance(raw, str) or str(_uuid(raw)) != raw:
                        raise ValueError("版本四UUID必须使用规范表示。")
                elif key == "target_message_ids":
                    for item in _array(raw):
                        canonical_ids(item, "message_id")
                elif key == "occurred_at" and raw is not None:
                    if not isinstance(raw, str) or datetime.fromisoformat(raw).isoformat() != raw:
                        raise ValueError("版本四来源时间必须保留原ISO表示。")
                elif isinstance(raw, dict):
                    for name, item in raw.items():
                        canonical_ids(item, name)
                elif isinstance(raw, list):
                    for item in raw:
                        canonical_ids(item)
            canonical_ids(data)
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
            target_message_ids=tuple(_uuid(item) for item in _array(data["target_message_ids"])) if data["version"] == 4 else (),
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
            version=data["version"],
            semantic_basis=(
                SemanticBasis.from_payload(data["semantic_basis"])
                if data.get("semantic_basis") is not None else None
            ), **kwargs,
        )
