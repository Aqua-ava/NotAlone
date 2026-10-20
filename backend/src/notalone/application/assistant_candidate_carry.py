"""用户明确携候选新开的命令与无正文来历协议。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

@dataclass(frozen=True, slots=True, repr=False)
class CarryAssistantCandidate:
    expected_selection_id: UUID
    candidate_id: UUID
    version_id: UUID

    def __post_init__(self) -> None:
        if any(not isinstance(value, UUID) for value in (
            self.expected_selection_id, self.candidate_id, self.version_id,
        )):
            raise ValueError("携候选请求结构无效。")


@dataclass(frozen=True, slots=True)
class CarriedAssistantSession:
    session_id: UUID
    input_version_id: UUID


@dataclass(frozen=True, slots=True)
class CandidateCarryOrigin:
    """仅保存真实父身份与消息组指纹，不保存候选正文。"""

    origin_owner_id: UUID
    origin_contact_id: UUID
    origin_binding_id: UUID
    origin_session_id: UUID
    origin_input_version_id: UUID
    origin_turn_id: UUID
    origin_reply_request_id: UUID
    origin_candidate_id: UUID
    origin_version_id: UUID
    origin_selection_id: UUID
    payload_sha256: str

    def __post_init__(self) -> None:
        if (any(not isinstance(value, UUID) for value in (
                self.origin_owner_id, self.origin_contact_id, self.origin_binding_id,
                self.origin_session_id, self.origin_input_version_id, self.origin_turn_id, self.origin_reply_request_id,
                self.origin_candidate_id, self.origin_version_id, self.origin_selection_id,
            ))
                or not isinstance(self.payload_sha256, str) or len(self.payload_sha256) != 64
                or any(character not in "0123456789abcdef" for character in self.payload_sha256)):
            raise ValueError("携入来历记录无效。")


_ORIGIN_IDS = (
    "origin_owner_id", "origin_contact_id", "origin_binding_id", "origin_session_id",
    "origin_input_version_id", "origin_turn_id", "origin_reply_request_id", "origin_candidate_id",
    "origin_version_id", "origin_selection_id",
)


def carry_origin_to_payload(origin: CandidateCarryOrigin) -> dict[str, Any]:
    if not isinstance(origin, CandidateCarryOrigin):
        raise ValueError("携入来历记录无效。")
    CandidateCarryOrigin.__post_init__(origin)
    return {
        "type": "candidate_carry", "metadata_version": 2,
        **{field: str(getattr(origin, field)) for field in _ORIGIN_IDS},
        "payload_sha256": origin.payload_sha256,
    }


def _canonical_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise ValueError
    identifier = UUID(value)
    if str(identifier) != value:
        raise ValueError
    return identifier


def carry_origin_from_payload(payload: object) -> CandidateCarryOrigin:
    """严格重建可信来历；未知字段与正文注入都返回固定错误。"""

    try:
        # 旧版本仅在明确没有已退役依赖时可恢复；未知依赖不能按空集处理。
        if (isinstance(payload, dict) and type(payload.get("metadata_version")) is int
                and payload["metadata_version"] == 1 and payload.get("style_sample_ids") == []):
            payload = {key: value for key, value in payload.items() if key != "style_sample_ids"}
            payload["metadata_version"] = 2
        if (not isinstance(payload, dict)
                or set(payload) != {"type", "metadata_version", *_ORIGIN_IDS,
                                    "payload_sha256"}
                or payload["type"] != "candidate_carry"
                or type(payload["metadata_version"]) is not int or payload["metadata_version"] != 2):
            raise ValueError
        return CandidateCarryOrigin(
            **{field: _canonical_uuid(payload[field]) for field in _ORIGIN_IDS},
            payload_sha256=payload["payload_sha256"],
        )
    except (KeyError, TypeError, ValueError):
        raise ValueError("携入来历记录无效。") from None
