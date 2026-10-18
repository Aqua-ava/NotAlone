"""读取已完成回复的上下文快照，不重新检索或调用模型。"""

from uuid import UUID

from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.store import ReplyAttemptState, ReplyStore
from notalone.reply.retrieval_receipt import require_receipt_evidence
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
        try:
            require_receipt_evidence(stored.retrieval, stored.evidence)
        except (TypeError, ValueError):
            raise ReplyStoreInvariantError("回复检索回执与保存依据不一致。") from None
        return {
            "reply_request_id": str(request_id),
            # 与生成回执独立读取同一持久结果，供逐条审阅绑定真实候选。
            "candidate_output": [{"candidate_id": str(item.candidate_id), "text": item.text,
                "basis": item.basis, "citation_ids": [str(value) for value in item.citation_ids],
                "risk_notes": list(item.risk_notes), "messages": [
                    {"message_id": str(message.message_id), "text": message.text}
                    for message in item.message_group]} for item in stored.result.candidates],
            "layered_context": stored.layered_context,
            "layered_status": stored.layered_status,
            "owner_layered_context": stored.owner_layered_context,
            "owner_layered_status": stored.owner_layered_status,
            "owner_layered_scenario_reads": list(stored.owner_layered_scenario_reads),
            "layered_scenario_reads": list(stored.layered_scenario_reads),
            **({"retrieval": stored.retrieval.to_payload()} if stored.retrieval else {}),
            **({"basis_changes": [change.to_payload() for change in stored.result.basis_changes]}
               if stored.result.basis_changes else {}),
            "evidence": [
                {
                    "evidence_id": str(entry.evidence_id),
                    "kind": entry.kind,
                    "text": entry.text,
                    "selection_reason": entry.selection_reason,
                    "snapshot_status": entry.status,
                    "cited": entry.evidence_id in cited_ids,
                    **({"navigation": entry.navigation.to_payload()} if entry.navigation else {}),
                    "timing": entry.timing.to_payload(),
                    "valid_at": entry.valid_at.isoformat() if entry.valid_at else None,
                    "invalid_at": entry.invalid_at.isoformat() if entry.invalid_at else None,
                }
                for entry in stored.evidence if entry.model_visible
            ],
        }
