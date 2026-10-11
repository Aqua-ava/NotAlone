"""既有会话 JSON 的有界传输；每次正文仍由原读取边界重新核验。"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import parse_qs
from uuid import UUID


READ_PART_BYTES = 256 * 1024


@dataclass(frozen=True, slots=True, repr=False)
class AssistantSessionReadPart:
    number: int
    expected_wire_sha256: str | None


class AssistantSessionReadChanged(Exception):
    """只标记本次传输变化，不作为来源或讨论有效性的权威。"""


def parse_assistant_session_read_query(query: str) -> AssistantSessionReadPart | None:
    if not query:
        return None
    parameters = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
    if (set(parameters) - {"read_part", "read_id"} or "read_part" not in parameters
            or any(len(values) != 1 for values in parameters.values())):
        raise ValueError
    number_text = parameters["read_part"][0]
    if re.fullmatch(r"0|[1-9][0-9]{0,15}", number_text) is None:
        raise ValueError
    number = int(number_text)
    wire_sha256 = parameters.get("read_id", [None])[0]
    if (number > 9007199254740991 or number > 0 and wire_sha256 is None
            or wire_sha256 is not None and re.fullmatch(r"[0-9a-f]{64}", wire_sha256) is None):
        raise ValueError
    return AssistantSessionReadPart(number, wire_sha256)


def assistant_session_read_fragment(
    wire: bytes, *, session_id: UUID, current_input_version_id: UUID | None,
    request: AssistantSessionReadPart,
) -> dict[str, object]:
    # 直接散列现行响应字节，不另建正文规范化或持久快照。
    wire_sha256 = hashlib.sha256(wire).hexdigest()
    if request.expected_wire_sha256 is not None and request.expected_wire_sha256 != wire_sha256:
        raise AssistantSessionReadChanged
    offsets = [0]
    while offsets[-1] < len(wire):
        end = min(offsets[-1] + READ_PART_BYTES, len(wire))
        while end < len(wire) and wire[end] & 0xC0 == 0x80:
            end -= 1
        offsets.append(end)
    part_count = len(offsets) - 1
    if request.number >= part_count:
        raise ValueError
    fragment = wire[offsets[request.number]:offsets[request.number + 1]].decode("utf-8")
    return {
        "session_id": str(session_id),
        "current_input_version_id": (str(current_input_version_id)
                                      if current_input_version_id is not None else None),
        "read_id": wire_sha256, "part_number": request.number, "part_count": part_count,
        "payload_bytes": len(wire), "payload_fragment": fragment,
        "next_part": request.number + 1 if request.number + 1 < part_count else None,
    }
