"""审核导航沿真实记忆锚点核验；不放宽普通学习来源门。"""

from uuid import UUID

from psycopg.rows import dict_row

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.memory_correction import available_correction_memories
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.memory_store import PostgresMemoryStore, _MEMORY_COLUMNS
from notalone.persistence.owner_memory_store import _OWNER_MEMORY_COLUMNS, _ensure_memory_sources
from notalone.persistence.skill_learning import dependencies_current
from notalone.persistence.skill_learning_generation import capture_generation, generation_current
from notalone.skills.learning import SkillLearningInvalid, content_digest


def capture_navigation(connection, scope, navigation):
    """只重验本次实际选中的联系人或本人记忆，不把普通材料当作导航。"""
    result = []
    raw = getattr(connection, 'connection', connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        for item in navigation:
            kind = item['scope_kind']
            identifier = UUID(item['memory_id'])
            if kind == 'contact':
                row = cursor.execute(f'SELECT {_MEMORY_COLUMNS} FROM public.confirmed_memory '
                    'WHERE owner_id=%s AND contact_id=%s AND id=%s',
                    (scope.owner_id, scope.contact_id, identifier)).fetchone()
                record_kind, origin = 'contact_memory', scope
            elif kind == 'owner':
                row = cursor.execute(f'SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory '
                    'WHERE owner_id=%s AND id=%s', (scope.owner_id, identifier)).fetchone()
                record_kind, origin = 'owner_memory', scope.owner_id
            else:
                raise SkillLearningInvalid()
            if (row is None or row['memory_status' if kind == 'contact' else 'status'] not in ('active', 'invalidated')
                    or row['revision'] != item['memory_revision']
                    or not available_correction_memories(cursor, owner_id=scope.owner_id,
                        record_kind=record_kind, rows=[row])):
                raise SkillLearningInvalid()
            if kind == 'contact':
                PostgresMemoryStore._ensure_active_sources(cursor, scope, tuple(row['memory_source_ids']))
            else:
                _ensure_memory_sources(cursor, owner_id=scope.owner_id, row=row)
            lineage = PostgresRelationshipOverviewStore._lineage(cursor, origin,
                {**row, 'memory_source_ids': row['memory_source_ids'] if kind == 'contact' else row['source_ids']})
            if set(lineage['source_ids']) != set(item['dependency_ids']):
                raise SkillLearningInvalid()
            result.append({'identity': item, 'record_sha256': content_digest(row),
                           'generation_sha256': lineage['generation_sha256']})
    return result


def navigation_ids(proof):
    return {UUID(value) for item in proof
            for value in [item['identity']['memory_id'], *item['identity']['dependency_ids']]}


def capture_review_sources(connection, scope, draft_dependencies, context_dependencies, navigation, targets=()):
    from notalone.persistence.skill_version_lineage import capture_parent_publications
    target_ids = {UUID(item['version_id']) for item in targets}
    parents, inherited = capture_parent_publications(connection, scope,
        set(draft_dependencies) | set(context_dependencies) | target_ids)
    if not target_ids.issubset({UUID(item['version_id']) for item in parents}):
        raise SkillLearningInvalid()
    if parents:
        dependencies, base = capture_review_sources(connection, scope,
            set(draft_dependencies) - inherited, set(context_dependencies) - inherited, navigation)
        return dependencies | inherited, {'version': 3, 'base': base, 'parents': parents}
    try:
        proof = capture_navigation(connection, scope, navigation)
    except (PermissionError, MemoryCorrectionConflictError):
        raise SkillLearningInvalid() from None
    inherited = navigation_ids(proof)
    from notalone.persistence.skill_learning_materials import expand_learning_provenance
    ordinary = expand_learning_provenance(connection, scope,
        set(draft_dependencies) | (set(context_dependencies) - inherited))
    if ordinary is None or not dependencies_current(connection, scope, ordinary):
        raise SkillLearningInvalid()
    return ordinary | inherited, {'version': 2, 'ordinary': capture_generation(connection, scope, ordinary),
                                   'navigation': proof}


def review_sources_current(connection, scope, dependencies, frozen):
    if frozen.get('version') == 3:
        try:
            from notalone.persistence.skill_version_lineage import capture_parent_publications
            parents, inherited = capture_parent_publications(connection, scope,
                [UUID(item['version_id']) for item in frozen['parents']])
            base = frozen['base']
            ordinary = {UUID(value) for value in base['ordinary']['dependencies']} | navigation_ids(base['navigation'])
            return (parents == frozen['parents'] and set(dependencies) == ordinary | inherited
                    and review_sources_current(connection, scope, ordinary, base))
        except (SkillLearningInvalid, KeyError, TypeError, ValueError):
            return False
    if frozen.get('version') != 2:
        return generation_current(connection, scope, frozen) and dependencies_current(connection, scope, dependencies)
    try:
        proof = frozen['navigation']
        current = capture_navigation(connection, scope, [item['identity'] for item in proof])
        ordinary = {UUID(value) for value in frozen['ordinary']['dependencies']}
        return (current == proof and set(dependencies) == ordinary | navigation_ids(current)
                and generation_current(connection, scope, frozen['ordinary'])
                and dependencies_current(connection, scope, ordinary))
    except (SkillLearningInvalid, PermissionError, MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
        return False
