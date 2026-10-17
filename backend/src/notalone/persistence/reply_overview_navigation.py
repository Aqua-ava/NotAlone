"""候选 writer 的 owner 锁内复核概览导航，不另开连接或获取 contact 锁。"""

from typing import Any
from uuid import UUID

from notalone.scopes import ContactScope

from notalone.memory.overview import RelationshipOverview
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError


def require_current_overview_navigation(
    connection: Any, context: ReplyContext, overview: PostgresRelationshipOverviewStore,
) -> None:
    receipt = context.retrieval
    if receipt is None:
        return
    for scope_kind, expected in (("contact", receipt.contact_overview), ("owner", receipt.owner_overview)):
        if expected is None:
            continue
        try:
            current = (overview.read_contact_in_transaction(connection, context.scope) if scope_kind == "contact"
                       else overview.read_owner_in_transaction(connection, context.scope.owner_id))
        except Exception:
            raise ReplyStoreInvariantError("概览导航无法在当前提交事务中核验。") from None
        if (not isinstance(current, RelationshipOverview)
                or current.projection_revision != expected.projection_revision
                or current.memory_revision != expected.memory_revision):
            raise ReplyStoreInvariantError("概览导航在候选提交前已变化。")
        entries = {entry.memory.memory_id: entry for entry in current.entries}
        for item in context.evidence:
            navigation = item.navigation
            if navigation is None or navigation.scope_kind != scope_kind:
                continue
            entry = entries.get(navigation.memory_id)
            if (entry is None or entry.provenance_kind != navigation.provenance_kind
                    or entry.memory.revision != navigation.memory_revision
                    or set(entry.dependency_ids) != set(navigation.dependency_ids)
                    or set(navigation.source_message_ids) != {
                        ref.message_id for ref in entry.references
                        if scope_kind == "contact" and ref.message_id is not None
                        and ref.contact_id in (None, context.scope.contact_id)
                    }):
                raise ReplyStoreInvariantError("实际参与的概览底层依据已变化。")


def navigation_dependency_ids(context: ReplyContext) -> list[str]:
    """只保存实际选中导航的参与身份，不复制概览正文或未用条目。"""
    return sorted({str(identifier) for identifier in
                   ((*context.layered_context.snapshot.dependency_ids,
                     *(item.version_id for item in context.layered_context.snapshot.scenarios),
                     *((context.layered_context.snapshot.profile_version_id,)
                       if context.layered_context.snapshot.profile_version_id else ()))
                    if context.layered_context else ())} |
                  {str(identifier) for item in context.evidence if item.model_visible and item.navigation
                   for identifier in item.navigation.dependency_ids})


def registered_navigation_dependencies(connection: Any, scope: ContactScope) -> set[UUID]:
    """仅认本范围已保存导航中的删除身份，不把任意 UUID 当成资料依据。"""
    rows = connection.execute(
        "SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn "
        "CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, "
        "'$.context.evidence[*].fields.navigation.fields.dependency_ids[*].uuid') AS value "
        "WHERE turn.owner_id=%s AND turn.contact_id=%s AND turn.input_payload IS NOT NULL "
        "UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn "
        "CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, "
        "'$.context.layered_context.fields.snapshot.fields.dependency_ids[*].uuid') AS value "
        "WHERE turn.owner_id=%s AND turn.contact_id=%s AND turn.input_payload IS NOT NULL "
        "UNION SELECT value #>> '{}' AS id FROM public.reply_request AS request "
        "CROSS JOIN LATERAL jsonb_path_query(request.context_snapshot, "
        "'$.navigation_dependency_ids[*]') AS value "
        "WHERE request.owner_id=%s AND request.contact_id=%s",
        (scope.owner_id, scope.contact_id) * 3,
    ).fetchall()
    try:
        return {UUID(row["id"]) for row in rows}
    except (TypeError, ValueError):
        raise ReplyStoreInvariantError("已保存的概览删除身份无效。") from None
