"""同 owner 锁下的未领取证明，复用既有无正文失效键。"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from notalone.application.assistant_preparation_rejection import (
    AssistantNoGenerationProof, AssistantPreparationRejected,
)
from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionError, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.scopes import ContactScope


def has_generation_key(connection: Any, scope: ContactScope, request_key: UUID) -> bool:
    return connection.execute(
        "SELECT 1 FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s "
        "UNION ALL SELECT 1 FROM public.reply_request WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
        (scope.owner_id, scope.contact_id, request_key, scope.owner_id, scope.contact_id, request_key),
    ).fetchone() is not None


def prepare_generation_in_transaction(
    connection: Any, scope: ContactScope, session_id: UUID, request_key: UUID,
    reserve: Callable[[], AssistantGenerationReceipt],
) -> AssistantGenerationReceipt | AssistantPreparationRejected:
    try:
        # 局部失败先回滚，外层 owner 锁继续保护证明及无正文失效键提交。
        with connection.transaction():
            return reserve()
    except (AssistantSessionNotFound, AssistantSessionConflict, AssistantSessionRejected) as failure:
        rejected = prove_preparation_rejected(connection, scope, session_id, request_key, failure)
        if rejected is None:
            raise
        return rejected


def prove_preparation_rejected(
    connection: Any, scope: ContactScope, session_id: UUID, request_key: UUID,
    failure: AssistantSessionError,
) -> AssistantPreparationRejected | None:
    """调用者先回滚局部领取；证明必须等外层 owner 事务提交后才能返回。"""

    if not isinstance(failure, (AssistantSessionNotFound, AssistantSessionConflict, AssistantSessionRejected)):
        return None
    if not connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id),
    ).fetchone():
        return None
    if has_generation_key(connection, scope, request_key):
        return None
    # 同键排队请求稍后拿到同一 owner 锁时，也必须被既有 A/C 门禁挡住。
    connection.execute(
        "INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES (%s,%s,%s) "
        "ON CONFLICT (owner_id,contact_id,idempotency_key) DO NOTHING",
        (scope.owner_id, scope.contact_id, request_key),
    )
    return AssistantPreparationRejected(failure, AssistantNoGenerationProof(scope.contact_id, session_id, request_key))
