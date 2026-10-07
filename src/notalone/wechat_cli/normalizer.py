"""把 CLI 文字事件规范化为与历史导入共享的规范消息。

v1 只接受文字事件；媒体、群聊和未知类型在适配器层已明确跳过。
规范化是纯函数：不读取时间、不猜测说话人、不携带联系人范围；
``owner_id + contact_id`` 由写入路径在写入前确定，CLI 参数不能覆盖。
"""

from __future__ import annotations

import json
from dataclasses import asdict, replace
from datetime import datetime, timezone
from typing import Iterable

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.source_processing.models import (
    ProcessingRecord,
    execution,
    message_snapshot,
)
from notalone.wechat_cli.models import CliMessageEvent


class CliNormalizationError(RuntimeError):
    """CLI 事件无法规范化为稳定消息时的失败关闭错误。"""


def normalize_cli_events(
    events: Iterable[CliMessageEvent],
    *,
    processing_receipts: list[ProcessingRecord] | None = None,
) -> tuple[NormalizedMessage, ...]:
    """把一次 tail 读取的文字事件转换为规范消息。

    非文字事件与空白正文明确跳过；说话人、身份或时间损坏时失败关闭。
    同一批次必须属于同一会话（talker 一致），否则拒绝整批。
    """

    normalized: list[NormalizedMessage] = []
    expected_talker: str | None = None
    for event in events:
        started_at = datetime.now(timezone.utc)
        if (
            expected_talker is not None
            and event.message_id.talker != expected_talker
        ):
            raise CliNormalizationError("一次观察批次只能包含同一会话的消息。")
        expected_talker = event.message_id.talker
        if event.kind != "text":
            # 媒体、未知类型在 v1 明确跳过，不冒充文字消息。
            if processing_receipts is not None:
                processing_receipts.append(
                    ProcessingRecord.capture(
                        f"cli:{event.message_id.local_id}",
                        {
                            "capture_layer": "metadata_only",
                            "record_text": None,
                            "parsed": {
                                "id": asdict(event.message_id),
                                "kind": event.kind,
                            },
                            "outcome": "non_text_filtered",
                            "normalize": execution(
                                started_at, __file__, status="filtered"
                            ),
                            "filter_rule": "text_only",
                        },
                    )
                )
            continue
        if not event.text.strip():
            if processing_receipts is not None:
                record = event.processing_record or ProcessingRecord.capture(
                    f"cli:{event.message_id.local_id}",
                    {
                        "capture_layer": "parsed_only",
                        "record_text": None,
                        "parsed": _event_projection(event),
                        "parse": {"status": "not_observed"},
                    },
                )
                processing_receipts.append(
                    record.with_fields(
                        outcome="empty_text_filtered",
                        normalize=execution(
                            started_at, __file__, status="filtered"
                        ),
                        filter_rule="nonblank_text",
                    )
                )
            continue
        if isinstance(event.message_id.local_id, bool) or (
            not isinstance(event.message_id.local_id, int)
            or event.message_id.local_id <= 0
        ):
            raise CliNormalizationError("CLI 消息缺少稳定的本地 ID。")
        if not isinstance(event.is_from_me, bool):
            # 说话人标记缺失或类型错误时失败关闭，不猜测发送方。
            raise CliNormalizationError("CLI 消息说话人标记无效。")
        message = _normalize_event(event)
        record = event.processing_record or ProcessingRecord.capture(
            message.source_locator,
            {
                "capture_layer": "parsed_only",
                "record_text": None,
                "parsed": _event_projection(event),
                "parse": {
                    "status": "not_observed",
                    "started_at": None,
                    "finished_at": None,
                    "rule_version": None,
                },
            },
        )
        record = record.with_fields(
            converted=message_snapshot(message),
            normalize=execution(started_at, __file__),
            outcome="normalized",
            transformations={
                "speaker": {
                    "rule": "is_from_me",
                    "input": event.is_from_me,
                    "output": message.speaker,
                },
                "time": {
                    "rule": (
                        "epoch_to_utc"
                        if event.create_time is not None
                        else (
                            "time_iso_assume_utc_if_naive"
                            if event.time_iso is not None
                            else "missing_preserved"
                        )
                    ),
                    "input": {
                        "create_time": event.create_time,
                        "time_iso": event.time_iso,
                    },
                    "output": (
                        message.occurred_at.isoformat()
                        if message.occurred_at
                        else None
                    ),
                },
                "body": {
                    "rule": "unchanged_text",
                    "output_field": "text_content",
                },
            },
        )
        normalized.append(replace(message, processing_record=record))
        if processing_receipts is not None:
            processing_receipts.append(record)
    return tuple(normalized)


def _normalize_event(event: CliMessageEvent) -> NormalizedMessage:
    """转换一条文字事件：缺失原始时间保留未知，不以读取时间冒充。"""

    local_id = event.message_id.local_id
    return NormalizedMessage(
        source_locator=f"cli:{local_id}",
        speaker="user" if event.is_from_me else "contact",
        message_type="text",
        text_content=event.text,
        media_placeholder=None,
        occurred_at=_occurred_at(event),
        wechat_metadata=WechatMessageMetadata(
            external_local_id=local_id,
            external_server_id=event.message_id.server_id_str,
            external_talker=event.message_id.talker.strip(),
            source_create_time=event.create_time,
            raw_payload_json=json.dumps(
                _event_projection(event),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
        ),
    )


def _event_projection(event: CliMessageEvent) -> dict:
    return {
        key: value
        for key, value in asdict(event).items()
        if key != "processing_record"
    }


def _occurred_at(event: CliMessageEvent) -> datetime | None:
    """优先使用原始 epoch 时间；只有 time_iso 时按其解析；缺失保留未知。"""

    if event.create_time is not None:
        try:
            return datetime.fromtimestamp(event.create_time, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise CliNormalizationError(
                "CLI 消息原始时间无法解析。"
            ) from error
    if event.time_iso is not None:
        try:
            parsed = datetime.fromisoformat(event.time_iso)
        except ValueError as error:
            raise CliNormalizationError(
                "CLI 消息原始时间无法解析。"
            ) from error
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    return None
