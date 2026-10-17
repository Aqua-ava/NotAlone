"""升级沿完整原资料与人工决定冻结；不把当前证明倒填到旧记录。"""

from uuid import UUID
from notalone.memory.upgrade import UpgradeConflict
from notalone.memory.upgrade_snapshot import upgrade_digest
from notalone.persistence.correction_evidence import capture_message_snapshot, validate_frozen_snapshot
from notalone.memory.correction import MemoryCorrectionConflictError


def memory_generation(connection, scope, kind):
    """完整参与集合只持久保存身份和摘要，旧证明仍由原记录负责。"""
    rows = connection.execute(
        'SELECT id,to_jsonb(m) AS body FROM public.memory_candidate AS m WHERE owner_id=%s AND contact_id=%s '
        'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.confirmed_memory AS m WHERE owner_id=%s AND contact_id=%s '
        'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.owner_memory AS m WHERE owner_id=%s AND %s '
        'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.memory_correction_decision AS m '
        'WHERE owner_id=%s AND (contact_id=%s OR (%s AND contact_id IS NULL)) ORDER BY id',
        (scope.owner_id, scope.contact_id, scope.owner_id, scope.contact_id, scope.owner_id, kind == 'owner',
         scope.owner_id, scope.contact_id, kind == 'owner'),
    ).fetchall()
    rows, dependencies = _original_records(connection, scope, kind, rows)
    # 追踪中独有的参与来源也绑定当前状态，不能只作为删除命中键。
    source_ids, message_ids = set(dependencies), set()
    records = []
    for row in rows:
        body = row['body']
        records.append({'id': str(row['id']), 'digest': upgrade_digest(body)})
        source_ids.update(UUID(item) for item in body.get('source_ids', []))
        for proof in (body.get('dimension_evidence'), body.get('version_evidence'), body.get('evidence'), body.get('correction_evidence')):
            _proof_ids(proof, message_ids, source_ids)
    # source_ids 只按显式 UUID 找到规范消息；绝不把一个来源扩大为全历史。
    selected = connection.execute('SELECT id FROM public.message WHERE owner_id=%s AND id=ANY(%s::uuid[]) '
        'AND (%s OR contact_id=%s)', (scope.owner_id, list(source_ids | message_ids), kind == 'owner', scope.contact_id)).fetchall()
    snapshot = capture_message_snapshot(connection, owner_id=scope.owner_id,
        contact_id=None if kind == 'owner' else scope.contact_id, message_ids={row['id'] for row in selected})
    sources = connection.execute('SELECT id,status,content_sha256 FROM public.source_document '
        'WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND (%s OR contact_id=%s) ORDER BY id',
        (scope.owner_id, list(source_ids), kind == 'owner', scope.contact_id)).fetchall()
    dependencies.update(source_ids | message_ids | {UUID(item) for item in snapshot['source_ids']})
    return {'version': 1, 'records': records, 'source_snapshot': snapshot,
            'source_states': [{**row, 'id': str(row['id'])} for row in sources],
            'dependency_ids': sorted(str(item) for item in dependencies)}


def _proof_ids(value, messages, sources):
    if isinstance(value, list):
        for item in value:
            _proof_ids(item, messages, sources)
        return
    if not isinstance(value, dict):
        return
    for key in ('source_ids', 'message_ids', 'canonical_ids', 'window_message_ids'):
        for item in value.get(key, []) or []:
            try:
                (messages if 'message' in key or key == 'canonical_ids' else sources).add(UUID(str(item)))
            except (ValueError, TypeError):
                pass
    for key in ('message_id', 'source_id', 'ref_id', 'source_ref_id'):
        if value.get(key):
            (messages if key == 'message_id' else sources).add(UUID(str(value[key])))
    for key in ('window', 'evidence', 'context', 'frozen_window',
                'previous_window', 'current_window', 'messages', 'source_refs'):
        _proof_ids(value.get(key), messages, sources)


def _original_records(connection, scope, kind, rows):
    """只沿已保存身份扩展原候选、版本及追踪；不扫描其他联系人的历史。"""
    records = {row['id']: row for row in rows}
    dependencies = set(records)
    pending = rows
    for _ in range(100):
        if not pending:
            return sorted(records.values(), key=lambda row: row['id']), dependencies
        for row in pending:
            body = row['body']
            dependencies.update(UUID(body[key]) for key in ('source_candidate_id', 'supersedes_memory_id')
                                if body.get(key))
            messages, sources = set(), set()
            for key in ('dimension_evidence', 'version_evidence', 'evidence', 'correction_evidence'):
                _proof_ids(body.get(key), messages, sources)
            dependencies.update(messages | sources)
        traces = connection.execute(
            "SELECT DISTINCT dependency.trace_id,dependency.source_id "
            "FROM public.memory_extraction_trace_dependency AS dependency "
            "JOIN public.memory_extraction_trace_link AS link "
            "ON link.owner_id=dependency.owner_id AND link.trace_id=dependency.trace_id "
            "WHERE link.owner_id=%s AND link.record_id=ANY(%s::uuid[]) "
            "AND link.record_kind IN ('candidate','contact_memory','owner_memory')",
            (scope.owner_id, [row['id'] for row in pending]),
        ).fetchall()
        for trace in traces:
            dependencies.update((trace['trace_id'], trace['source_id']))
        identifiers = list(dependencies - records.keys())
        pending = connection.execute(
            'SELECT id,to_jsonb(m) AS body FROM public.memory_candidate m '
            'WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND (%s OR contact_id=%s) '
            'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.confirmed_memory m '
            'WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND (%s OR contact_id=%s) '
            'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.owner_memory m '
            'WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND %s '
            'UNION ALL SELECT id,to_jsonb(m) AS body FROM public.memory_correction_decision m '
            'WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND (%s OR contact_id=%s)',
            (scope.owner_id, identifiers, kind == 'owner', scope.contact_id,
             scope.owner_id, identifiers, kind == 'owner', scope.contact_id,
             scope.owner_id, identifiers, kind == 'owner',
             scope.owner_id, identifiers, kind == 'owner', scope.contact_id),
        ).fetchall()
        records.update((row['id'], row) for row in pending)
    raise UpgradeConflict('原资料依赖链超出核对范围。')


def source_current(connection, owner_id, evidence):
    try:
        validate_frozen_snapshot(connection, owner_id=owner_id, evidence=evidence)
    except (MemoryCorrectionConflictError, ValueError, KeyError, TypeError):
        raise UpgradeConflict('本批来源已变化。') from None


def generation_current(connection, scope, kind, expected):
    if expected is None or memory_generation(connection, scope, kind) != expected:
        raise UpgradeConflict('原资料或人工决定已变化，请重新比较。')
    generation_sources_current(connection, scope.owner_id, expected)


def generation_sources_current(connection, owner_id, expected):
    source_current(connection, owner_id, expected['source_snapshot'])
    identifiers = [UUID(item['id']) for item in expected['source_states']]
    current = connection.execute('SELECT id,status,content_sha256 FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) ORDER BY id', (owner_id, identifiers)).fetchall()
    if [{**row, 'id': str(row['id'])} for row in current] != expected['source_states']:
        raise UpgradeConflict('原资料的来源状态已变化。')
