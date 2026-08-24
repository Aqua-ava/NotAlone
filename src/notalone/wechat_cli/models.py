"""本地微信 CLI 适配器的结构化结果。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ChatCandidate:
    """CLI 返回的一个会话候选，不等同于 NotAlone 联系人。"""

    username: str
    display_name: str
    match: str | None
    chat_type: str
    last_timestamp: int | None
    sort_timestamp: int | None
    source: str | None
    summary: str | None = None
    last_sender_display_name: str | None = None


@dataclass(frozen=True, slots=True)
class ChatResolution:
    """一次 display name/备注解析的候选集合。"""

    query: str
    candidates: tuple[ChatCandidate, ...]


@dataclass(frozen=True, slots=True)
class MessageIdentifier:
    """CLI 消息的外部稳定标识。"""

    local_id: int
    talker: str
    server_id_str: str | None = None


@dataclass(frozen=True, slots=True)
class CliMessageEvent:
    """通过 CLI tail 读取的一条 v1 文字消息事件。"""

    message_id: MessageIdentifier
    text: str
    kind: str
    sender: str | None
    sender_wxid: str | None
    is_from_me: bool
    create_time: int | None
    time: str | None
    time_iso: str | None


@dataclass(frozen=True, slots=True)
class TailResult:
    """一次性 tail 读取结果和下一次读取所需的 cursor。

    轮询没有新消息时返回空结果：``events`` 为空且 ``cursor`` 与
    ``last_local_id`` 均为 None，调用方保持既有水位不变。
    ``last_local_id`` 统计批次内全部事件（含被跳过的非文字事件），
    保证非文字消息也能前移增量水位。
    """

    events: tuple[CliMessageEvent, ...]
    cursor: str | None
    last_local_id: int | None = None


@dataclass(frozen=True, slots=True)
class TailFollowItem:
    """一次 ``tail --follow`` 输出的已校验增量事件。"""

    cursor: str
    local_id: int
    event: CliMessageEvent | None
