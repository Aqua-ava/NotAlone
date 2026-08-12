"""微信单联系人 JSONL 的确定性校验。"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.models import ContactPreview


SUPPORTED_KINDS = frozenset(
    {"text", "quote", "image", "sticker", "transfer", "system"}
)
REQUIRED_FIELDS = frozenset(
    {
        "id",
        "create_time",
        "is_from_me",
        "kind",
        "sender",
        "text",
        "time",
        "time_iso",
    }
)
REQUIRED_ID_FIELDS = frozenset({"local_id", "server_id_str", "talker"})
OPTIONAL_PAYLOAD_TYPES = {
    "image": ("images", list),
    "quote": ("quote", dict),
    "transfer": ("transfer", dict),
}
POSTGRES_BIGINT_MIN = -(2**63)
POSTGRES_BIGINT_MAX = 2**63 - 1


def validate_records(
    records: tuple[dict[str, Any], ...],
) -> tuple[ContactPreview, tuple[tuple[str, int], ...]]:
    """校验所有记录并返回唯一联系人和消息类型统计。"""
    local_ids: set[int] = set()
    contact_names: list[tuple[int, int, str]] = []
    contact_ids: set[str] = set()
    owner_sender_ids: set[str] = set()
    talker_ids: set[str] = set()
    kind_counts: Counter[str] = Counter()

    for line_number, record in enumerate(records, start=1):
        _validate_record(record, line_number, local_ids)
        kind = record["kind"]
        kind_counts[kind] += 1
        talker_ids.add(record["id"]["talker"].strip())

        if kind != "system":
            sender_id = _non_empty_string(record.get("sender_wxid"))
            if sender_id is None:
                raise ImportPreviewError(
                    f"第 {line_number} 行缺少有效的 sender_wxid。"
                )
            if record["is_from_me"] is False:
                contact_ids.add(sender_id)
                contact_names.append(
                    (record["create_time"], line_number, record["sender"].strip())
                )
            else:
                owner_sender_ids.add(sender_id)

    if len(talker_ids) != 1:
        raise ImportPreviewError(
            f"文件包含 {len(talker_ids)} 个 id.talker，必须拆分后导入。"
        )
    if not contact_ids:
        raise ImportPreviewError("未找到可识别的联系人消息。")
    if len(contact_ids) != 1:
        raise ImportPreviewError(
            f"文件包含 {len(contact_ids)} 个联系人 sender_wxid，必须拆分后导入。"
        )

    contact_id = next(iter(contact_ids))
    talker_id = next(iter(talker_ids))
    if talker_id != contact_id:
        raise ImportPreviewError("id.talker 与联系人 sender_wxid 不一致。")
    if len(owner_sender_ids) > 1:
        raise ImportPreviewError(
            "本人发送消息包含多个 sender_wxid，无法确认单一账号范围。"
        )
    if contact_id in owner_sender_ids:
        raise ImportPreviewError("本人发送身份与联系人 sender_wxid 冲突。")

    display_name = max(contact_names)[2]
    display_name_variant_count = len({name for _, _, name in contact_names})

    return (
        ContactPreview(
            contact_id=contact_id,
            display_name=display_name,
            display_name_variant_count=display_name_variant_count,
        ),
        tuple(sorted(kind_counts.items())),
    )


def _validate_record(
    record: dict[str, Any], line_number: int, local_ids: set[int]
) -> None:
    missing = sorted(REQUIRED_FIELDS - record.keys())
    if missing:
        raise ImportPreviewError(
            f"第 {line_number} 行缺少字段：{', '.join(missing)}。"
        )

    message_id = record["id"]
    if not isinstance(message_id, dict):
        raise ImportPreviewError(f"第 {line_number} 行的 id 必须是对象。")
    missing_id = sorted(REQUIRED_ID_FIELDS - message_id.keys())
    if missing_id:
        raise ImportPreviewError(
            f"第 {line_number} 行的 id 缺少字段：{', '.join(missing_id)}。"
        )

    local_id = message_id["local_id"]
    if type(local_id) is not int:
        raise ImportPreviewError(f"第 {line_number} 行的 id.local_id 必须是整数。")
    _validate_postgres_bigint(local_id, "id.local_id", line_number)
    if local_id in local_ids:
        raise ImportPreviewError(f"第 {line_number} 行的 id.local_id 重复。")
    local_ids.add(local_id)

    for field in ("server_id_str", "talker"):
        if _non_empty_string(message_id[field]) is None:
            raise ImportPreviewError(
                f"第 {line_number} 行的 id.{field} 必须是非空字符串。"
            )

    if type(record["create_time"]) is not int:
        raise ImportPreviewError(f"第 {line_number} 行的 create_time 必须是整数。")
    _validate_postgres_bigint(record["create_time"], "create_time", line_number)
    if type(record["is_from_me"]) is not bool:
        raise ImportPreviewError(f"第 {line_number} 行的 is_from_me 必须是布尔值。")

    kind = _non_empty_string(record["kind"])
    if kind not in SUPPORTED_KINDS:
        raise ImportPreviewError(f"第 {line_number} 行的 kind 不受支持。")

    for field in ("sender", "text", "time", "time_iso"):
        if not isinstance(record[field], str):
            raise ImportPreviewError(f"第 {line_number} 行的 {field} 必须是字符串。")

    if not record["sender"].strip():
        raise ImportPreviewError(f"第 {line_number} 行的 sender 不能为空。")
    if not record["time"].strip():
        raise ImportPreviewError(f"第 {line_number} 行的 time 不能为空。")

    try:
        occurred_at = datetime.fromisoformat(record["time_iso"])
    except ValueError as error:
        raise ImportPreviewError(
            f"第 {line_number} 行的 time_iso 不是有效 ISO 时间。"
        ) from error
    if occurred_at.tzinfo is None:
        raise ImportPreviewError(f"第 {line_number} 行的 time_iso 必须包含时区。")
    if occurred_at.timestamp() != record["create_time"]:
        raise ImportPreviewError(
            f"第 {line_number} 行的 create_time 与 time_iso 不一致。"
        )

    optional_payload = OPTIONAL_PAYLOAD_TYPES.get(kind)
    if optional_payload is not None:
        field, expected_type = optional_payload
        if field not in record or not isinstance(record[field], expected_type):
            raise ImportPreviewError(
                f"第 {line_number} 行的 {kind} 消息必须包含 {field}。"
            )
    if kind == "image":
        images = record["images"]
        if not images:
            raise ImportPreviewError(f"第 {line_number} 行的 images 不能为空。")
        for image in images:
            if not isinstance(image, dict):
                raise ImportPreviewError(
                    f"第 {line_number} 行的 images 元素必须是对象。"
                )
            if "path" in image and not isinstance(image["path"], str):
                raise ImportPreviewError(
                    f"第 {line_number} 行的 images.path 必须是字符串。"
                )


def _non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _validate_postgres_bigint(value: int, field: str, line_number: int) -> None:
    if not POSTGRES_BIGINT_MIN <= value <= POSTGRES_BIGINT_MAX:
        raise ImportPreviewError(
            f"第 {line_number} 行的 {field} 超出 PostgreSQL bigint 范围。"
        )
