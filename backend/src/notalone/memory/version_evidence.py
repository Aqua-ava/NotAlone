"""不可回填的原始版本依据，只含定位与摘要。"""

from dataclasses import dataclass, field, replace
from datetime import datetime
import re
from uuid import UUID
from notalone.memory.dimension_evidence import EvidenceMessage


def _digest(value: object) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("版本依据摘要无效。")


def _identifier(value: object) -> None:
    if not isinstance(value, str):
        raise ValueError("版本依据标识无效。")
    UUID(value)


def _window(value: object) -> None:
    if value is None:
        return
    fields = {"version", "ordered_message_ids", "message_ids", "source_ids", "source_refs",
              "message_digests", "message_snapshots", "message_scopes"}
    if not isinstance(value, dict) or set(value) != fields or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("版本窗口结构无效。")
    for key in ("ordered_message_ids", "message_ids", "source_ids"):
        if not isinstance(value[key], list) or len(value[key]) > 1000 or len(set(value[key])) != len(value[key]):
            raise ValueError("版本窗口引用无效。")
        for item in value[key]:
            _identifier(item)
    identifiers = set(value["message_ids"])
    if not identifiers or set(value["ordered_message_ids"]) != identifiers:
        raise ValueError("版本窗口未记录实际有序消息。")
    for key in ("message_digests", "message_snapshots", "message_scopes"):
        if not isinstance(value[key], dict) or set(value[key]) != identifiers:
            raise ValueError("版本窗口缺少原始消息证明。")
    for identifier in identifiers:
        _digest(value["message_digests"][identifier])
        _identifier(value["message_scopes"][identifier])
        snapshot = value["message_snapshots"][identifier]
        if not isinstance(snapshot, dict) or set(snapshot) != {
            "message_id", "text_sha256", "text_length", "sender", "message_type", "occurred_at",
            "text_representation", "source_refs", "source_state_sha256",
        } or snapshot["message_id"] != identifier:
            raise ValueError("版本窗口消息快照无效。")
        _digest(snapshot["text_sha256"])
        _digest(snapshot["source_state_sha256"])
        EvidenceMessage.from_payload(snapshot)
        if type(snapshot["text_length"]) is not int or snapshot["text_length"] < 1:
            raise ValueError("版本窗口消息长度无效。")
        if not isinstance(snapshot["source_refs"], list) or not snapshot["source_refs"]:
            raise ValueError("版本窗口来源引用未知。")
        for item in snapshot["source_refs"]:
            if not isinstance(item, dict) or set(item) != {"ref_id", "source_id"}:
                raise ValueError("版本窗口来源引用无效。")
            _identifier(item["ref_id"])
            _identifier(item["source_id"])
    if not isinstance(value["source_refs"], list):
        raise ValueError("版本窗口引用世代无效。")
    for item in value["source_refs"]:
        if not isinstance(item, dict) or set(item) != {"message_id", "ref_id", "source_id", "digest"}:
            raise ValueError("版本窗口引用世代无效。")
        for key in ("message_id", "ref_id", "source_id"):
            _identifier(item[key])
        _digest(item["digest"])


@dataclass(frozen=True, slots=True)
class VersionEvidence:
    previous: dict
    current: dict
    previous_window: dict | None
    current_window: dict | None
    source_current: bool = field(default=False, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if set(self.previous) != {"memory_id", "revision", "adoption_method", "valid_at", "invalid_at", "record_sha256"}:
            raise ValueError("旧版本证明结构无效。")
        if set(self.current) != {"memory_id", "revision", "record_sha256"}:
            raise ValueError("新版本证明结构无效。")
        for item in (self.previous, self.current):
            _identifier(item["memory_id"])
            _digest(item["record_sha256"])
            if type(item["revision"]) is not int or item["revision"] < 1:
                raise ValueError("版本依据修订无效。")
        if self.previous["adoption_method"] not in {"auto", "manual"}:
            raise ValueError("旧版本采纳身份未知。")
        for key in ("valid_at", "invalid_at"):
            value = self.previous[key]
            if value is not None:
                if not isinstance(value, str) or datetime.fromisoformat(value).utcoffset() is None:
                    raise ValueError("旧版本有效期无效。")
        _window(self.previous_window)
        _window(self.current_window)

    def to_payload(self) -> dict:
        return {"version": 1, "previous": self.previous, "current": self.current,
                "previous_window": self.previous_window, "current_window": self.current_window}

    @classmethod
    def from_payload(cls, value: object) -> "VersionEvidence | None":
        if value is None:
            return None
        if (not isinstance(value, dict) or set(value) != {"version", "previous", "current", "previous_window", "current_window"}
                or type(value["version"]) is not int or value["version"] != 1
                or not isinstance(value["previous"], dict) or not isinstance(value["current"], dict)):
            raise ValueError("版本依据字段无效。")
        return cls(value["previous"], value["current"], value["previous_window"], value["current_window"])

    def with_current_sources(self, current: bool) -> "VersionEvidence":
        result = replace(self)
        object.__setattr__(result, "source_current", current)
        return result
