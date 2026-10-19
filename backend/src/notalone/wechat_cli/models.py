"""本地微信 CLI 适配器的结构化结果。"""

from __future__ import annotations

from dataclasses import dataclass

from notalone.source_processing.models import ProcessingRecord


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


@dataclass(frozen=True, slots=True, repr=False)
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
    processing_record: ProcessingRecord | None = None


@dataclass(frozen=True, slots=True, repr=False)
class TailResult:
    """一次性 tail 读取结果和下一次读取所需的 cursor。

    轮询没有新消息时返回空结果：``events`` 为空且 ``cursor`` 与
    ``last_local_id`` 均为 None，调用方保持既有水位不变。
    ``last_local_id`` 对应实时页最后的排序位置（含非文字事件），
    不是批次内最大的编号；后续读取使用不透明的 ``cursor``。
    """

    events: tuple[CliMessageEvent, ...]
    cursor: str | None
    last_local_id: int | None = None
    # 适配器保留所有已读事件的计数；``events`` 只包含可以规范化为
    # 消息的文字事件，避免把媒体等非文字事件伪造成正文。
    event_count: int | None = None
    non_text_count: int = 0
    # 只证明本页来自可验证的实时读取；是否追平还须检查 has_more。
    # 没有完整水位的空输出无法证明来源，后台补齐将其标记为 incomplete。
    freshness_confirmed: bool = False
    filtered_records: tuple[ProcessingRecord, ...] = ()
    # 本页来源可信不等于已追平；有后续页时由调用方继续有界调度。
    has_more: bool = False
    # 元数据确认的本地历史不可读原因；不是读取故障，也不证明覆盖完整。
    local_history_state: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class TailFollowItem:
    """一次 ``tail --follow`` 输出的已校验增量事件。"""

    cursor: str
    local_id: int
    event: CliMessageEvent | None
    processing_record: ProcessingRecord | None = None


@dataclass(frozen=True, slots=True)
class CliSessionEvent:
    """全局 sessions 事件的最小投影。

    全局流只用于通知哪个外部会话定位标识发生变化，不携带会话标题、预览
    或消息正文；正文必须由已确认绑定再调用一次性 ``tail`` 读取。
    """

    cursor: str
    conversation_locator: str
