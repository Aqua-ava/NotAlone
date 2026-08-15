"""把通过校验的微信 JSONL 转换为持久化层可用的数据。"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from notalone.ingest.jsonl_reader import JsonlDocument
from notalone.ingest.models import (
    ImportBatch,
    NormalizedMessage,
    WechatMessageMetadata,
)
from notalone.ingest.validator import validate_records


def normalize_document(document: JsonlDocument) -> ImportBatch:
    """完整校验文档并返回单联系人规范化导入批次。"""

    channel_identity, _ = validate_records(document.records)
    messages = tuple(
        _normalize_record(record, line_number)
        for line_number, record in enumerate(document.records, start=1)
    )

    return ImportBatch(
        file_name=document.path.name,
        content_sha256=document.content_sha256,
        channel_identity=channel_identity,
        messages=messages,
    )


def _normalize_record(
    record: dict[str, Any], line_number: int
) -> NormalizedMessage:
    """转换一条已经通过 ``validate_records`` 校验的消息。"""

    message_id = record["id"]
    kind = record["kind"]
    if kind == "system":
        speaker = "system"
    elif record["is_from_me"]:
        speaker = "user"
    else:
        speaker = "contact"

    media_placeholder = record["text"] if kind in {"image", "sticker"} else None
    text_content = "" if media_placeholder is not None else record["text"]

    return NormalizedMessage(
        source_locator=f"jsonl:{line_number}",
        speaker=speaker,
        message_type=kind,
        text_content=text_content,
        media_placeholder=media_placeholder,
        occurred_at=datetime.fromisoformat(record["time_iso"]),
        wechat_metadata=WechatMessageMetadata(
            external_local_id=message_id["local_id"],
            external_server_id=message_id["server_id_str"].strip(),
            external_talker=message_id["talker"].strip(),
            source_create_time=record["create_time"],
            raw_payload_json=json.dumps(
                record,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
        ),
    )
