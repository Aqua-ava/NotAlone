"""单次认证 HTTP 请求明确声明的手动输入范围；不会改变渠道验证。"""

from contextvars import ContextVar
from uuid import UUID

manual_input_contact: ContextVar[UUID | None] = ContextVar("manual_input_contact", default=None)
