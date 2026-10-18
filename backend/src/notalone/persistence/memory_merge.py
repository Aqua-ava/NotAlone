"""同一事务内确认合并候选及复验所有父版本，不改写旧正文。"""
from contextlib import nullcontext
from dataclasses import replace

from notalone.memory.models import AdoptionMethod, ConfirmedMemoryStatus, SourceDependencyMode
from notalone.memory.versions import MemoryVersionConflict, require_auto_previous, require_auto_update_previous
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.source_dependency import ensure_all_sources
from notalone.persistence.reply_layered_cleanup import erase_layered_reply_dependencies
from notalone.scopes import OwnerScope


def confirm_merge(store, *, scope, candidate_id, expected_parents, expected_dimension_evidence=None, owner=False):
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore, _OWNER_MEMORY_COLUMNS, _from_row, _timed_rows
    parents = tuple(expected_parents)
    ids = [item.memory_id for item in parents]
    if len(ids) < 2 or len(ids) > 100 or len(ids) != len(set(ids)):
        raise MemoryVersionConflict('合并须指定至少两个不同的父版本。')
    if any((item.owner_id != scope.owner_id if owner else item.scope != scope) for item in parents):
        raise PermissionError('合并父版本不属于当前范围。')
    table = 'owner_memory' if owner else 'confirmed_memory'
    with store._connect() as connection:
        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
        lock_owner_scope(connection, owner_id=scope.owner_id)
        factory = lambda: nullcontext(connection)
        candidate_store = PostgresMemoryStore(store._database_url, connection_factory=factory)
        candidate = candidate_store.get_candidate(scope=scope, candidate_id=candidate_id)
        if candidate is None:
            raise LookupError('合并候选不存在。')
        if expected_dimension_evidence is not None and candidate.dimension_evidence != expected_dimension_evidence:
            raise MemoryVersionConflict('合并候选核验依据已变化。')
        required = {source for parent in parents for source in parent.source_ids}
        if not required <= set(candidate.source_ids):
            raise MemoryVersionConflict('合并候选没有覆盖所有父版本来源。')
        ensure_all_sources(connection, owner_id=scope.owner_id, contact_id=scope.contact_id, source_ids=candidate.source_ids)
        receipt = connection.execute(f'SELECT id, merge_parent_ids, status, adoption_method, source_dependency_mode FROM public.{table} WHERE owner_id=%s AND source_candidate_id=%s',
                                     (scope.owner_id, candidate_id)).fetchone()
        if receipt and (set(receipt['merge_parent_ids']) != set(ids) or receipt['status'] != 'active'
                        or receipt['adoption_method'] != 'auto' or receipt['source_dependency_mode'] != 'all'):
            raise MemoryVersionConflict('合并重放的父版本或回执已变化。')
        for parent in sorted(parents, key=lambda item: str(item.memory_id)):
            if owner:
                row = connection.execute(f'SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id=%s AND id=%s FOR UPDATE',
                                         (scope.owner_id, parent.memory_id)).fetchone()
                actual = _from_row(_timed_rows(connection, [row])[0]) if row else None
            else:
                row = candidate_store._memory_for_update(connection, parent.memory_id, follow_current=False)
                actual = candidate_store._memory_from_row(candidate_store._timed_memories(connection, [row])[0]) if row else None
            if actual is None:
                raise MemoryVersionConflict('合并父版本已不存在。')
            (require_auto_update_previous if receipt else require_auto_previous)(actual, parent)
        if not receipt and connection.execute(f'SELECT 1 FROM public.{table} WHERE owner_id=%s AND status=\'active\' AND (supersedes_memory_id=ANY(%s) OR merge_parent_ids && %s::uuid[]) LIMIT 1',
                                               (scope.owner_id, ids, ids)).fetchone():
            raise MemoryVersionConflict('合并父版本已存在新版本。')
        if owner:
            result = PostgresOwnerMemoryStore(store._database_url, connection_factory=factory).confirm_candidate(
                candidate=candidate, adoption_method=AdoptionMethod.AUTO, expected_dimension_evidence=expected_dimension_evidence)
        else:
            result = candidate_store.confirm(scope=scope, candidate_id=candidate_id,
                adoption_method=AdoptionMethod.AUTO, expected_dimension_evidence=expected_dimension_evidence)
        if receipt:
            return result
        connection.execute(f'UPDATE public.{table} SET merge_parent_ids=%s, source_dependency_mode=\'all\' WHERE owner_id=%s AND id=%s',
                           (ids, scope.owner_id, result.memory_id))
        erase_layered_reply_dependencies(connection, OwnerScope(scope.owner_id) if owner else scope, tuple(ids))
        updated = connection.execute(f'UPDATE public.{table} SET status=\'invalidated\', revision=revision+1, updated_at=now() WHERE owner_id=%s AND id=ANY(%s) AND status=\'active\' AND adoption_method=\'auto\'',
                                     (scope.owner_id, ids)).rowcount
        if updated != len(ids):
            raise MemoryVersionConflict('合并父版本在写入前发生变化。')
        return replace(result, source_dependency_mode=SourceDependencyMode.ALL)
