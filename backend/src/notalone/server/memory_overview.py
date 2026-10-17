"""概览 HTTP 投影沿用原记忆 DTO，不另存或改写底层正文。"""

from collections.abc import Callable
from datetime import timezone

from notalone.memory.models import ConfirmedMemory, OwnerMemory
from notalone.memory.overview import RelationshipOverview
from notalone.scopes import ContactScope


def overview_payload(
    overview: RelationshipOverview,
    memory_payload: Callable[[ConfirmedMemory | OwnerMemory], dict[str, object]],
) -> dict[str, object]:
    contact_scope = isinstance(overview.scope, ContactScope)
    entries = []
    for entry in overview.entries:
        memory = memory_payload(entry.memory)
        memory["source_candidate_id"] = (str(entry.memory.source_candidate_id)
                                         if entry.memory.source_candidate_id else None)
        entries.append({
            "memory": memory,
            "is_latest": entry.is_latest,
            "current_leaf": ({"memory_id": str(entry.current_leaf.memory_id),
                              "revision": entry.current_leaf.revision}
                             if entry.current_leaf else None),
            "provenance": {"kind": entry.provenance_kind, "references": [{
                "source_id": str(ref.source_id), "source_kind": ref.source_kind,
                "message_id": str(ref.message_id) if ref.message_id else None,
                "source_ref_id": str(ref.source_ref_id) if ref.source_ref_id else None,
                "locator": ref.locator,
                **({"contact_id": str(ref.contact_id) if ref.contact_id else None}
                   if not contact_scope else {}),
            } for ref in entry.references]},
        })
    return {"version": 1, "scope_kind": "contact" if contact_scope else "owner",
            "contact_id": str(overview.scope.contact_id) if contact_scope else None,
            "projection_revision": overview.projection_revision,
            "memory_revision": overview.memory_revision,
            "built_at": overview.built_at.astimezone(timezone.utc).isoformat(), "entries": entries}
