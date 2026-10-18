"""旧 C 继续入口在现有租约中捕获本次历史依据身份，不重写父请求。"""

from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from notalone.persistence.reply_basis_changes import (
    historical_basis_revision_sha256, read_reply_basis_changes, require_current_reply_memory,
    require_generation_memory_dependencies,
)
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.context import ContinuedReplyCandidate, ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.store import ReplyRequest
from notalone.scopes import ContactScope


_KEY = "continuation_basis"


def read_continuation_basis(
    connection: Any, scope: ContactScope, binding_id: UUID, candidate_id: UUID,
) -> ContinuedReplyCandidate:
    """调用方持有 owner 锁；HISTORY 仅放行合法旧资料，真实来源仍须可用。"""
    from notalone.persistence.assistant_session_store import _reply_dependencies

    row = connection.execute(
        "SELECT id,candidate_text,reply_request_id FROM public.reply_candidate "
        "WHERE id=%s AND owner_id=%s AND contact_id=%s AND conversation_binding_id=%s",
        (candidate_id, scope.owner_id, scope.contact_id, binding_id),
    ).fetchone()
    if row is None:
        raise ReplyStoreInvariantError("历史候选不属于当前已验证联系人会话。")
    require_reply_sources_current(connection, owner_id=scope.owner_id,
                                  request_id=row["reply_request_id"], historical=True)
    from notalone.persistence.skill_execution_view import require_saved_skill_policy
    require_saved_skill_policy(connection, scope, row['reply_request_id'])
    dependencies = tuple(sorted(_reply_dependencies(connection, scope, row["reply_request_id"])))
    require_generation_memory_dependencies(connection, scope, dependencies)
    return ContinuedReplyCandidate(
        candidate_id=row["id"], scope=scope, conversation_binding_id=binding_id,
        text=row["candidate_text"],
        basis_changes=read_reply_basis_changes(connection, scope, row["reply_request_id"]),
        basis_revision_sha256=historical_basis_revision_sha256(connection, scope, dependencies),
    )


def _payload(basis: ContinuedReplyCandidate) -> dict[str, Any]:
    return {"candidate_id": str(basis.candidate_id),
            "basis_revision_sha256": basis.basis_revision_sha256,
            "basis_changes": [item.to_payload() for item in basis.basis_changes]}


def capture_reply_continuation_basis(
    connection: Any, request: ReplyRequest, basis: ContinuedReplyCandidate | None,
) -> None:
    """新领取或重试的原 C 租约固定本次身份；重放和旧父快照不回填。"""
    if basis is None:
        return
    connection.execute(
        "UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s AND owner_id=%s AND contact_id=%s",
        (Jsonb({_KEY: _payload(basis)}), request.request_id, request.scope.owner_id, request.scope.contact_id),
    )


def require_reply_continuation_basis(
    connection: Any, request: ReplyRequest, context: ReplyContext,
) -> dict[str, Any]:
    """模型前及候选 INSERT 前在同一 writer 锁内复验，返回已捕获的无正文元数据。"""
    row = connection.execute(
        "SELECT context_snapshot FROM public.reply_request WHERE id=%s AND owner_id=%s AND contact_id=%s",
        (request.request_id, request.scope.owner_id, request.scope.contact_id),
    ).fetchone()
    snapshot = row["context_snapshot"] if row else None
    captured = snapshot.get(_KEY) if isinstance(snapshot, dict) else None
    if request.continued_from_candidate_id is None:
        if captured is not None or context.continuation_basis is not None:
            raise ReplyStoreInvariantError("历史候选必须由用户明确选择。")
        return {}
    current = read_continuation_basis(connection, request.scope, request.conversation_binding_id,
                                      request.continued_from_candidate_id)
    if captured != _payload(current):
        raise ReplyStoreInvariantError("本次继续使用的历史依据已变化，请重新生成。")
    basis = context.continuation_basis
    if basis is not None and (not isinstance(basis, ContinuedReplyCandidate)
                             or basis.scope != request.scope
                             or basis.conversation_binding_id != request.conversation_binding_id
                             or basis.text != current.text or _payload(basis) != captured):
        raise ReplyStoreInvariantError("继续依据与本次租约捕获记录不一致。")
    require_current_reply_memory(connection, request.scope, context.evidence)
    return {_KEY: captured}
