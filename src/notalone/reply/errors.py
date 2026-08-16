"""候选回复公开错误。"""


class ReplyError(RuntimeError):
    """不携带私密正文或底层异常的候选回复错误。"""


class ReplyInvariantError(ReplyError):
    """内部 adapter 返回越界或不一致数据时 fail closed。"""


class ReplyRunError(ReplyError):
    """模型或 Tool 运行失败，公开文本不包含供应商响应。"""


class ReplyPersistenceError(ReplyError):
    """准备或持久化失败，调用者不能使用本次候选。"""
