"""只分类 SDK 稳定元数据，不读取供应商响应正文或异常消息。"""

from openai import BadRequestError


def is_provider_context_limit(error: Exception) -> bool:
    """ECNU 未公开精确错误契约；这里只支持兼容 SDK 的明确错误码。"""

    return (
        isinstance(error, BadRequestError)
        and error.code == "context_length_exceeded"
    )
