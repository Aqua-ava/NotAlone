"""导入预览错误。

单独定义异常类型后，命令行入口可以只捕获“预期内的导入错误”，而不会把编程错误也
伪装成普通文件错误。
"""

from __future__ import annotations


class ImportPreviewError(ValueError):
    """可安全展示、且不包含消息正文的导入错误。

    继承 ``ValueError`` 表示输入内容不符合约定。抛出这个异常时，消息只能包含行号、
    字段名和错误类别，不能拼接原始 JSON 或聊天正文。
    """


class ImportContentChangedError(ImportPreviewError):
    """本次重新读取的文件与用户核对的预览不一致。"""
