"""会话验证的可替换边界。"""

from __future__ import annotations

from typing import Protocol

from notalone.conversation.models import ConversationResolution


class ConversationPort(Protocol):
    """验证当前前台会话是否仍属于已确认联系人。"""

    def verify_current(self) -> ConversationResolution:
        """返回不包含聊天正文的稳定验证结果。"""
