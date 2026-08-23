"""本地微信 CLI 适配器的稳定错误。"""

from __future__ import annotations


class CliAdapterError(RuntimeError):
    """不泄露 CLI 输出、路径、会话标识或聊天正文的适配器错误。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class CliCommandError(CliAdapterError):
    """CLI 不存在、超时或以失败状态退出。"""


class CliOutputError(CliAdapterError):
    """CLI 输出不符合已支持的结构化契约。"""
