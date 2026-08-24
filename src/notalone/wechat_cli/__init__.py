"""本地微信 CLI 只读适配器。"""

from notalone.wechat_cli.adapter import LocalWechatCli, TailFollowStream
from notalone.wechat_cli.errors import CliAdapterError, CliCommandError, CliOutputError
from notalone.wechat_cli.models import (
    ChatCandidate,
    ChatResolution,
    CliMessageEvent,
    MessageIdentifier,
    TailFollowItem,
    TailResult,
)

__all__ = [
    "ChatCandidate",
    "ChatResolution",
    "CliAdapterError",
    "CliCommandError",
    "CliMessageEvent",
    "LocalWechatCli",
    "CliOutputError",
    "MessageIdentifier",
    "TailFollowItem",
    "TailFollowStream",
    "TailResult",
]
