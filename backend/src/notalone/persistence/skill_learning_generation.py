"""学习资料的无正文世代证明；复用纠错窗口的冻结消息契约。"""

from uuid import UUID

from psycopg.rows import dict_row

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import capture_message_snapshot, validate_frozen_snapshot
from notalone.scopes import ContactScope
from notalone.skills.learning import content_digest


def capture_generation(connection, scope: ContactScope, dependencies) -> dict:
    identifiers = list(dependencies)
    messages = {row[0] for row in connection.execute(
        'SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[])',
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall()}
    with connection.cursor(row_factory=dict_row) as cursor:
        snapshot = capture_message_snapshot(cursor, owner_id=scope.owner_id,
                                            contact_id=scope.contact_id, message_ids=messages)
    rows = connection.execute(
        "SELECT id,content_sha256,status FROM public.source_document "
        "WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall()
    observations = connection.execute(
        'SELECT id,to_jsonb(observation) FROM public.local_wechat_observation AS observation '
        'WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[])',
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall()
    memories = connection.execute(
        'SELECT id,to_jsonb(memory) FROM public.confirmed_memory AS memory '
        'WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) '
        'UNION ALL SELECT id,to_jsonb(memory) FROM public.owner_memory AS memory '
        'WHERE owner_id=%s AND id=ANY(%s::uuid[])',
        (scope.owner_id, scope.contact_id, identifiers, scope.owner_id, identifiers),
    ).fetchall()
    styles = connection.execute(
        'SELECT id,to_jsonb(sample) FROM public.style_sample AS sample '
        'WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[])',
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall()
    preferences = connection.execute(
        'SELECT id,to_jsonb(preference) FROM public.expression_preference AS preference '
        'WHERE owner_id=%s AND (contact_id IS NULL OR contact_id=%s) AND id=ANY(%s::uuid[])',
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall()
    return {'version': 1, 'dependencies': sorted(str(value) for value in identifiers),
            'messages': snapshot, 'sources': {str(row[0]): content_digest(row[1:]) for row in rows},
            'observations': {str(row[0]): content_digest(row[1:]) for row in observations},
            'memories': {str(row[0]): content_digest(row[1]) for row in memories},
            'styles': {str(row[0]): content_digest(row[1]) for row in styles},
            'preferences': {str(row[0]): content_digest(row[1]) for row in preferences}}


def generation_current(connection, scope: ContactScope, frozen: dict) -> bool:
    if frozen.get('version') != 1:
        return False
    try:
        with connection.cursor(row_factory=dict_row) as cursor:
            validate_frozen_snapshot(cursor, owner_id=scope.owner_id, evidence=frozen['messages'])
        current = capture_generation(connection, scope, [UUID(value) for value in frozen['dependencies']])
        return current == frozen
    except (KeyError, TypeError, ValueError, MemoryCorrectionConflictError):
        return False
