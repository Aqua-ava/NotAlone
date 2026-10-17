"""单批应用与撤销的事务边界，复用正式采纳、版本和删除规则。"""

from contextlib import nullcontext
from dataclasses import replace
from uuid import UUID
from psycopg.types.json import Jsonb

from notalone.application.memory_upgrade import RecordedAdjudication
from notalone.application.memory_upgrade_preview import preview_upgrade
from notalone.memory.upgrade import UpgradeConflict
from notalone.memory.upgrade_snapshot import restore_outcome, comparison_payload, upgrade_digest
from notalone.memory_extraction.adoption import MemoryAdoption, _candidate_from_fact
from notalone.memory_trace.context import snapshot
from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.memory_upgrade_generation import generation_current, memory_generation
from notalone.scopes import ContactScope


def _ports(connection, database_url, result_ids=()):
    identifiers = iter(result_ids)
    factory = lambda: next(identifiers)
    return (PostgresMemoryStore(database_url, id_factory=factory, connection_factory=lambda: nullcontext(connection)),
            PostgresOwnerMemoryStore(database_url, id_factory=factory, connection_factory=lambda: nullcontext(connection)))


def apply_batch(connection, database_url, batch, dimension_release, *, validate_algorithm=None):
    scope = ContactScope(batch['owner_id'], batch['contact_id'])
    peers = _unchanged_approved_peers(connection, batch)
    outcome = restore_outcome(batch['extracted_outcome'])
    outcome = replace(outcome, accepted=tuple(replace(fact,
        dimension_evidence=bind_stored_dimension_evidence(connection,
            _candidate_from_fact(scope, fact, namespace=batch['id']), lock_sources=True)) for fact in outcome.accepted))
    memory, owner = _ports(connection, database_url)
    replay = RecordedAdjudication(records=batch['adjudications'])
    from notalone.application.memory_upgrade_trace import planned_upgrade_writes
    with planned_upgrade_writes():
        compared = preview_upgrade(scope, outcome, memory_port=memory,
            owner_memory_port=owner if batch['scope_kind'] == 'owner' else None,
            adjudication_runtime=replay, dimension_release=dimension_release,
            candidate_namespace=batch['id'], target_kind=batch['scope_kind'])
    replay.assert_consumed()
    proposed = comparison_payload(compared)
    if any(proposed[key] != batch['comparison'][key] for key in ('version', 'actions', 'stats')):
        raise UpgradeConflict('批准后的来源、人工决定或采纳门已经变化。')
    before = _identities(connection, scope, batch['scope_kind'])
    memory, owner = _ports(connection, database_url,
        tuple(action.result_memory_id for action in compared.actions if action.result_memory_id))
    replay = RecordedAdjudication(records=batch['adjudications'])
    if validate_algorithm is not None:
        validate_algorithm()
    stats = MemoryAdoption(memory_port=memory,
        owner_memory_port=owner if batch['scope_kind'] == 'owner' else None,
        adjudication_runtime=replay, dimension_release=dimension_release,
        candidate_namespace=batch['id']).adopt(scope, outcome)
    replay.assert_consumed()
    if validate_algorithm is not None:
        validate_algorithm()
    if stats != compared.stats:
        # 原采纳端可能因来源或用户状态变化而保守停下，本批原子回滚。
        raise UpgradeConflict('实际采纳结果与批准差异不一致。')
    records = []
    for table, identifier, body in _records(connection, scope, batch['scope_kind']):
        if str(identifier) not in before[table]:
            records.append({'table': table, 'id': str(identifier), 'revision': body.get('revision'),
                            'digest': upgrade_digest(body), 'supersedes': body.get('supersedes_memory_id')})
    action_order = {str(action.result_memory_id): index for index, action in enumerate(compared.actions) if action.result_memory_id}
    records.sort(key=lambda item: action_order.get(item['id'], len(action_order)))
    dependencies = set(batch['dependency_ids']) | {UUID(item['id']) for item in records}
    connection.execute("UPDATE public.memory_upgrade_batch SET state='applied',revision=revision+1,applied_records=%s,dependency_ids=%s,error_code=NULL WHERE id=%s",
                       (Jsonb(records), list(dependencies), batch['id']))
    connection.execute('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE id=%s', (batch['job_id'],))
    # 仅同一次已批准、且本次写入前仍与原世代完全一致的其他批次，
    # 承接这次确定性写入。原比较及模型决定不改，外部决定仍会触发冲突。
    for peer in peers:
        current = memory_generation(connection, ContactScope(batch['owner_id'], peer['contact_id']), batch['scope_kind'])
        dependencies = set(peer['dependency_ids']) | {UUID(item) for item in current['dependency_ids']}
        connection.execute('UPDATE public.memory_upgrade_batch SET memory_generation=%s,dependency_ids=%s,revision=revision+1 WHERE id=%s',
                           (Jsonb(current), list(dependencies), peer['id']))


def _unchanged_approved_peers(connection, batch):
    peers = connection.execute(
        "SELECT * FROM public.memory_upgrade_batch WHERE owner_id=%s AND job_id=%s "
        "AND id<>%s AND state='apply_queued' FOR UPDATE",
        (batch['owner_id'], batch['job_id'], batch['id']),
    ).fetchall()
    unchanged = []
    for peer in peers:
        try:
            generation_current(connection, ContactScope(batch['owner_id'], peer['contact_id']),
                               batch['scope_kind'], peer['memory_generation'])
        except UpgradeConflict:
            continue
        unchanged.append(peer)
    return unchanged


def _records(connection, scope, kind):
    tables = ('memory_candidate','owner_memory') if kind == 'owner' else ('memory_candidate','confirmed_memory')
    for table in tables:
        # 表名来自封闭元组，不接收用户 SQL。
        rows = connection.execute(f'SELECT id,to_jsonb(m) AS body FROM public.{table} m WHERE owner_id=%s '
            + ('' if table == 'owner_memory' else 'AND contact_id=%s '),
            (scope.owner_id,) if table == 'owner_memory' else (scope.owner_id, scope.contact_id)).fetchall()
        for row in rows:
            yield table, row['id'], row['body']


def _identities(connection, scope, kind):
    result = {name: set() for name in ('memory_candidate','confirmed_memory','owner_memory')}
    for table, identifier, body in _records(connection, scope, kind):
        result[table].add(str(identifier))
    return result


def undo_batch(connection, database_url, batch, kind):
    scope = ContactScope(batch['owner_id'], batch['contact_id'])
    records = batch['applied_records']
    if not isinstance(records, list):
        raise UpgradeConflict('批次没有可核验的应用回执。')
    current = {(table, str(identifier)): body for table, identifier, body in _records(connection, scope, kind)}
    for record in records:
        body = current.get((record['table'], record['id']))
        if body is None or upgrade_digest(body) != record['digest']:
            raise UpgradeConflict('应用后的资料已改变，不能撤销用户后续决定。')
    memory, owner = _ports(connection, database_url)
    restored_revisions = {}
    # 先撤销新自动事实，再清理本批未被人工处理的独立待确认候选。
    for record in reversed([item for item in records if item['table'] != 'memory_candidate']):
        identifier = UUID(record['id'])
        body = current[(record['table'], record['id'])]
        if body.get('adoption_method') != 'auto':
            raise UpgradeConflict('人工决定不能被批次撤销。')
        expected_revision = restored_revisions.get((record['table'], record['id']), record['revision'])
        restored = None
        if record['table'] == 'owner_memory':
            if record['supersedes']:
                restored = owner.revert_auto_update(owner_id=scope.owner_id, memory_id=identifier, expected_revision=expected_revision)
            else:
                _detach_deleted_batch_children(connection, scope, records, record)
                owner.delete(scope.owner_id, identifier)
        else:
            if record['supersedes']:
                restored = memory.revert_auto_update(scope=scope, memory_id=identifier, expected_revision=expected_revision)
            else:
                _detach_deleted_batch_children(connection, scope, records, record)
                memory.delete(scope=scope, memory_id=identifier)
        if restored is not None:
            # 只接受原撤销端口刚返回的修订，不刷新或接受用户后来修改的资料。
            restored_revisions[(record['table'], str(restored.memory_id))] = restored.revision
    for record in records:
        if record['table'] != 'memory_candidate':
            continue
        identifier = UUID(record['id'])
        # 正式记忆删除已沿原规则擦除候选；仅额外去掉未采纳的本批候选。
        body = current[('memory_candidate', record['id'])]
        if body['status'] == 'pending':
            from notalone.persistence.reply_cleanup import delete_source_replies
            delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                                  removed_ids={identifier}, revoke_running_scope=False)
            connection.execute('DELETE FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s AND id=%s',
                               (scope.owner_id, scope.contact_id, identifier))
    from notalone.persistence.memory_upgrade_traces import erase_upgrade_traces
    erase_upgrade_traces(connection, scope.owner_id, [batch['id']])
    connection.execute("UPDATE public.memory_upgrade_batch SET state='undone',revision=revision+1,message_ids='{}',source_generation='{}',memory_generation=NULL,extracted_outcome=NULL,comparison=NULL,adjudications=NULL,applied_records=NULL,dependency_ids='{}',trace_id=NULL,error_code=NULL WHERE id=%s", (batch['id'],))


def _detach_deleted_batch_children(connection, scope, records, root):
    """只脱离同批已完整撤销的自动后代，沿用原公开叶子删除门。"""
    table = root['table']
    if table not in ('confirmed_memory', 'owner_memory'):
        raise UpgradeConflict('本批资料类型无效。')
    children = [UUID(item['id']) for item in records
                if item['table'] == table and item['supersedes'] == root['id']]
    if not children:
        return
    contact = ' AND contact_id=%s' if table == 'confirmed_memory' else ''
    params = (scope.owner_id, children, UUID(root['id']))
    if contact:
        params += (scope.contact_id,)
    # 表名来自封闭集合；身份已在本事务写入前按整批完整摘要核验。
    changed = connection.execute(
        f'UPDATE public.{table} SET supersedes_memory_id=NULL,revision=revision+1,updated_at=now() '
        "WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND supersedes_memory_id=%s AND status='deleted' "
        "AND adoption_method='auto'" + contact,
        params,
    ).rowcount
    if changed != len(children):
        raise UpgradeConflict('本批后代尚未完整撤销，不能删除原新增资料。')
