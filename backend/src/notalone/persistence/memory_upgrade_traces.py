"""升级工作与原完整追踪共用事务；正文清理覆盖每次真实尝试。"""

from contextlib import contextmanager
from uuid import UUID
from psycopg.rows import tuple_row

from notalone.persistence.extraction_trace import PostgresExtractionTraceStore, erase_trace_bodies
from notalone.memory_trace import TraceWriteError


@contextmanager
def _tuple_connection(connection):
    # 只在一次原追踪写调用内切换，结束后恢复升级事务的dict行协议。
    previous = connection.row_factory
    connection.row_factory = tuple_row
    try:
        yield connection
    finally:
        connection.row_factory = previous


def transaction_trace_store(connection, database_url):
    return PostgresExtractionTraceStore(database_url, connection_factory=lambda: _tuple_connection(connection))


def begin_upgrade_trace(connection, database_url, row, payload):
    from notalone.scopes import ContactScope
    from notalone.memory.upgrade_snapshot import upgrade_digest
    phase = payload['upgrade']['phase']
    tracer = transaction_trace_store(connection, database_url)
    trace_id = tracer.begin(ContactScope(row['owner_id'], row['contact_id']), run_id=row['id'],
        batch_key=upgrade_digest({'upgrade_batch': row['id'], 'phase': phase}), payload=payload)
    # 完整参与的原资料、人工决定及来源已由同事务_claimed复验；不只记录展示的8条。
    try:
        for identifier in set(row['dependency_ids']):
            connection.execute('INSERT INTO public.memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                               (trace_id, row['owner_id'], row['contact_id'], identifier))
        connection.execute('UPDATE public.memory_upgrade_batch SET trace_id=%s WHERE id=%s', (trace_id, row['id']))
    except Exception:
        raise TraceWriteError('upgrade_dependencies',trace_id) from None
    return trace_id


def erase_upgrade_traces(connection, owner_id, batch_ids):
    if not batch_ids:
        return
    rows = connection.execute('''SELECT trace.trace_id FROM public.memory_extraction_trace AS trace
        JOIN public.memory_upgrade_batch AS batch ON batch.id=trace.run_id
            AND batch.owner_id=trace.owner_id AND batch.contact_id=trace.contact_id
        WHERE batch.owner_id=%s AND batch.id=ANY(%s::uuid[])''',
                              (owner_id, list(batch_ids))).fetchall()
    identifiers = tuple(row['trace_id'] if isinstance(row, dict) else row[0] for row in rows)
    erase_trace_bodies(connection, owner_id=owner_id, trace_ids=identifiers, reason='manual')
