"""与输入格式和持久化实现解耦的导入数据结构。

这些类只描述“校验成功后得到了什么”，不负责读取文件、校验字段或写数据库。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID


# @dataclass 会根据下面声明的字段自动生成 __init__、__repr__ 和 __eq__。
# frozen=True 表示对象创建后不能重新给字段赋值，避免预览结果被后续代码悄悄修改。
# slots=True 表示对象只能拥有声明过的字段，同时减少内存占用和字段拼写错误。
@dataclass(frozen=True, slots=True, repr=False)
class ChannelIdentityCandidate:
    """从单联系人导出文件识别出的微信渠道身份候选。"""

    channel: Literal["wechat"]
    # 微信 JSONL 导入时来自对方消息的 sender_wxid。
    external_id: str
    # 按消息时间和行号选出的最新非空 sender，仅用于展示和人工核对。
    observed_name: str
    # 同一渠道身份在文件中出现过多少个不同的 sender 名称。
    observed_name_variant_count: int


@dataclass(frozen=True, slots=True, repr=False)
class OwnerChannelIdentityCandidate:
    """从本人消息识别出的 owner 微信渠道身份候选。"""

    channel: Literal["wechat"]
    external_id: str
    observed_name: str
    observed_name_variant_count: int


@dataclass(frozen=True, slots=True, repr=False)
class ExistingContactSelection:
    """用户为本次导入选择的既有 NotAlone 联系人。"""

    contact_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class NewContactSelection:
    """用户为本次导入创建的新 NotAlone 联系人。"""

    display_name: str


ContactSelection = ExistingContactSelection | NewContactSelection


@dataclass(frozen=True, slots=True, repr=False)
class ImportConfirmationRequest:
    """正式导入前由用户明确完成的联系人选择。"""

    selection: ContactSelection


@dataclass(frozen=True, slots=True, repr=False)
class ImportPreview:
    """完成整份文件校验后的只读预览结果。"""

    # 只保存文件的 basename，不把本机完整目录带入结果。
    file_name: str
    # 对原始文件字节计算的 SHA-256；预览默认不把具体值输出到终端。
    content_sha256: str
    # 从本人消息识别出的 owner 微信渠道身份，默认不在终端显示。
    owner_channel_identity: OwnerChannelIdentityCandidate
    # 已识别、仍需人工核对的微信渠道身份候选。
    channel_identity: ChannelIdentityCandidate
    # JSONL 中通过校验的物理记录行数。
    record_count: int
    # 形如 (("image", 9), ("text", 143)) 的不可变消息类型统计。
    kind_counts: tuple[tuple[str, int], ...]


@dataclass(frozen=True, slots=True, repr=False)
class WechatMessageMetadata:
    """微信消息的稳定身份与原始证据。

    身份字段随规范消息保存；``raw_payload_json`` 随来源引用
    （``message_source_ref``）保存，同一消息可由多个来源引用共同支持。
    导入来源始终提供 server_id 与 create_time；CLI 观察事件
    允许两者缺失，缺失时按稳定身份键的未知时间参与去重。
    """

    external_local_id: int
    external_server_id: str | None
    external_talker: str
    source_create_time: int | None
    raw_payload_json: str


@dataclass(frozen=True, slots=True, repr=False)
class NormalizedMessage:
    """一条与具体输入渠道解耦的规范消息。"""

    source_locator: str
    speaker: str
    message_type: str
    text_content: str
    media_placeholder: str | None
    occurred_at: datetime | None
    wechat_metadata: WechatMessageMetadata | None

    def __post_init__(self) -> None:
        if not self.source_locator.strip():
            raise ValueError("规范消息必须包含来源定位。")
        has_text = bool(self.text_content.strip())
        has_media_placeholder = bool(
            self.media_placeholder is not None
            and self.media_placeholder.strip()
        )
        if not has_text and not has_media_placeholder:
            raise ValueError("规范消息必须包含正文或媒体占位。")


@dataclass(frozen=True, slots=True, repr=False)
class ImportBatch:
    """一份单联系人 JSONL 完整校验后的规范化导入批次。"""

    file_name: str
    content_sha256: str
    owner_channel_identity: OwnerChannelIdentityCandidate
    channel_identity: ChannelIdentityCandidate
    messages: tuple[NormalizedMessage, ...]

    @property
    def record_count(self) -> int:
        """返回批次中的消息数量。"""

        return len(self.messages)
