"""Retrieval 的稳定错误类型。"""


class RetrievalError(RuntimeError):
    """检索失败，公开错误不携带聊天正文。"""


class RetrievalInvariantError(RetrievalError):
    """检索适配器返回越界或不一致数据时 fail closed。"""
