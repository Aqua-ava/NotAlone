"""读取已完成回复的上下文快照，不重新检索或调用模型。"""

from uuid import UUID

from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.store import ReplyAttemptState, ReplyStore
from notalone.scopes import ContactScope


class ReplyEvidenceIncomplete(Exception):
    """回复尚未完成，没有可展示的最终快照。"""


class ReplyEvidenceService:
    def __init__(self, store: ReplyStore) -> None:
        self._store = store

    def read(self, request_id: UUID, scope: ContactScope) -> dict[str, object]:
        stored = self._store.read(request_id, scope)
        if stored.request.scope != scope or any(
            entry.scope != scope for entry in stored.evidence
        ):
            raise ReplyStoreInvariantError("回复依据不属于当前联系人。")
        if stored.state != ReplyAttemptState.COMPLETED or stored.result is None:
            raise ReplyEvidenceIncomplete()
        cited_ids = set(stored.result.context_receipt.evidence_ids)
        return {
            "reply_request_id": str(request_id),
            "evidence": [
                {
                    "evidence_id": str(entry.evidence_id),
                    "kind": entry.kind,
                    "text": entry.text,
                    "selection_reason": entry.selection_reason,
                    "snapshot_status": entry.status,
                    "cited": entry.evidence_id in cited_ids,
                }
                for entry in stored.evidence
            ],
        }
