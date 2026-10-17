"""生产读取尚缺唯一关联及副作用证据，禁止打开路径、BLOB 或 CLI。"""

from dataclasses import dataclass
from typing import BinaryIO, Protocol

from notalone.media.models import MediaAuthorization, MediaError


@dataclass(frozen=True, slots=True, repr=False)
class MediaLocation:
    """Reader 核验过的具体定位；字段不构成上游已有协议的声明。"""

    authorization: MediaAuthorization
    dataset_id: str
    message_shard: str
    message_table: str
    message_row: str
    resource_shard: str
    resource_table: str
    resource_row: str
    association_version: str
    variant: str


class MediaReader(Protocol):
    """locate 只定位同授权消息；open 只读该唯一资源且无 ASR/辅助写入。"""

    def locate(
        self, authorization: MediaAuthorization, target: str,
    ) -> tuple[MediaLocation, ...]: ...

    def open(self, location: MediaLocation) -> BinaryIO: ...


class UnverifiedMediaReader:
    def locate(
        self, authorization: MediaAuthorization, target: str,
    ) -> tuple[MediaLocation, ...]:
        raise MediaError("upstream_unverified")

    def open(self, location: MediaLocation) -> BinaryIO:
        raise MediaError("upstream_unverified")
