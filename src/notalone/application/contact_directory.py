"""联系人目录的共享应用层读取路径。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True, slots=True)
class ContactDataStatus:
    """联系人数据的非正文统计。"""

    message_count: int
    source_count: int


@dataclass(frozen=True, slots=True)
class ContactSummary:
    """联系人列表展示所需的最小数据。"""

    contact_id: UUID
    display_name: str
    data_status: ContactDataStatus


class ContactDirectoryError(RuntimeError):
    """不暴露 SQL、连接信息或联系人正文的目录读取错误。"""


class ContactDirectoryPort(Protocol):
    """联系人目录持久化端口。"""

    def list_contacts(self, owner_id: UUID) -> tuple[ContactSummary, ...]: ...


class ContactDirectory:
    """供 CLI 与本地后端共同使用的联系人目录应用服务。"""

    __slots__ = ("_port",)

    def __init__(self, port: ContactDirectoryPort) -> None:
        self._port = port

    def list_contacts(self, owner_id: UUID) -> tuple[ContactSummary, ...]:
        """返回指定 owner 的联系人目录。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        return self._port.list_contacts(owner_id)
