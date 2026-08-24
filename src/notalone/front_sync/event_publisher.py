"""前台同步向事件通道发布消息事件的纯端口。

本模块不依赖后端服务壳层：``MessageEventPublisher`` 是生命周期
依赖的发布端口，``NullMessageEventPublisher`` 是显式空适配器；
把事件适配到具体通道（如内存事件总线）的实现放在服务壳层
``notalone.server.event_publisher``，由组合方注入。
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope


class MessageEventPublisher(Protocol):
    """已入库消息事件的最小发布端口。"""

    def publish_message_created(
        self,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        message_id: UUID,
    ) -> None:
        """发布一条不含消息正文的消息创建事件。"""


class NullMessageEventPublisher:
    """没有界面订阅方时的显式空适配器。"""

    def publish_message_created(
        self,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        message_id: UUID,
    ) -> None:
        del scope, occurred_at, message_id