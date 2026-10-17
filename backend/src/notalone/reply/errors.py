"""候选回复公开错误。"""


class ReplyError(RuntimeError):
    """不携带私密正文或底层异常的候选回复错误。"""


class ReplyCandidatesRejectedError(ReplyError):
    """有效复核没有可交付候选；保留用户输入，不自动重生成。"""


class ReplyInvariantError(ReplyError):
    """内部 adapter 返回越界或不一致数据时 fail closed。"""


class ReplyContextError(ReplyError):
    """Context 无法形成可信的联系人范围上下文。"""


class ReplyContextInvariantError(ReplyContextError):
    """Context 输入或 Retrieval 结果越界时 fail closed。"""


class ReplyRunError(ReplyError):
    """模型或 Tool 运行失败，公开文本不包含供应商响应。"""


class ReplyProviderContextLimitError(ReplyRunError):
    """供应商稳定错误码确认超长，不伪造本机计量回执。"""

    def __init__(self) -> None:
        super().__init__("模型提示这次内容过长，请新开助手会话。")


class ReplyTimeoutError(ReplyRunError):
    """本次模型运行超过总时限，候选不可保存。"""


class ReplyBudgetError(ReplyRunError):
    """模型循环超过步骤预算，候选不可保存。"""


class ReplyPersistenceError(ReplyError):
    """请求状态或候选持久化失败，调用者不能使用本次候选。"""


class ReplyIdempotencyConflictError(ReplyPersistenceError):
    """同一联系人范围的幂等键对应了不同请求输入。"""


class ReplyInProgressError(ReplyPersistenceError):
    """相同回复请求仍在有效租约内运行。"""


class ReplyContinuationError(ReplyPersistenceError):
    """用户选择的历史候选不属于当前已验证联系人会话。"""


class ReplyStoreInvariantError(ReplyPersistenceError):
    """ReplyStore 收到越界或不一致的持久化数据。"""


class ReplyInputInvalidatedError(ReplyStoreInvariantError):
    """已删除依赖的旧请求键只能以新用户输入重新发起。"""


class ReplyExpressionPreferencesChangedError(ReplyContextInvariantError):
    """模型前后或提交时长期表达要求已变化，旧结果不能生效。"""
