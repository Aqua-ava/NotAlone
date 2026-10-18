"""观察提交与调度同事务；只保存消息身份，复用既有任务和租约。"""
from datetime import datetime, timedelta, timezone


def utcnow():
    return datetime.now(timezone.utc)


_PENDING = ("SELECT r.message_id,r.observation_id FROM public.memory_extraction_receipt r "
    "JOIN public.local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id "
    "JOIN public.conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id "
    "WHERE r.owner_id=%s AND r.contact_id=%s AND r.task_id IS NULL AND b.status='active' "
    "AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=r.message_id AND ref.observation_id=o.id)")


def record_messages(connection, *, owner_id, contact_id, observation_id, message_ids):
    ids = tuple(identifier for identifier in message_ids if identifier is not None)
    if not ids:
        return
    connection.execute('INSERT INTO public.memory_extraction_schedule(owner_id,contact_id) VALUES(%s,%s) ON CONFLICT DO NOTHING', (owner_id,contact_id))
    count = connection.execute('INSERT INTO public.memory_extraction_receipt(message_id,owner_id,contact_id,observation_id) '
        'SELECT unnest(%s::uuid[]),%s,%s,%s ON CONFLICT DO NOTHING RETURNING message_id',
        (list(ids),owner_id,contact_id,observation_id)).fetchall()
    if not count:
        return
    now = utcnow()
    pending = len(connection.execute(_PENDING,(owner_id,contact_id)).fetchall())
    connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=%s, '
        'last_input_at=%s,due_at=CASE WHEN %s>=threshold THEN %s ELSE %s END '
        'WHERE owner_id=%s AND contact_id=%s',
        (pending,now,pending,now,now+timedelta(seconds=600),owner_id,contact_id))


def claim_scope(connection, repository, *, owner_id, contact_id, now=None):
    repository._lock_scope(connection,owner_id,contact_id)
    now = now or utcnow()
    state = connection.execute('SELECT threshold,due_at,last_input_at FROM public.memory_extraction_schedule '
        'WHERE owner_id=%s AND contact_id=%s FOR UPDATE', (owner_id,contact_id)).fetchone()
    if not state or state[1] is None or state[1] > now:
        return None
    rows = connection.execute(_PENDING,(owner_id,contact_id)).fetchall()
    idle_at = state[2] + timedelta(seconds=600)
    if not rows or len(rows) < state[0] and idle_at > now:
        connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=%s,due_at=%s '
            'WHERE owner_id=%s AND contact_id=%s',
            (len(rows),idle_at if rows else None,owner_id,contact_id))
        return None
    previous = connection.execute("SELECT status FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type='observation'",
                                  (owner_id,contact_id)).fetchone()
    if previous and previous[0] == 'cancelled':
        return None
    task = repository.create_observation_task(connection,owner_id=owner_id,contact_id=contact_id,message_count=len(rows))
    connection.execute('UPDATE public.memory_extraction_receipt SET task_id=%s WHERE message_id=ANY(%s)',
                       (task,[row[0] for row in rows]))
    connection.execute('UPDATE public.local_wechat_observation SET memory_enqueued_at=%s WHERE id=ANY(%s)',
                       (now,list({row[1] for row in rows})))
    connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=0,due_at=NULL,threshold=LEAST(threshold*2,5),'
        'generation=generation+1,task_id=%s WHERE owner_id=%s AND contact_id=%s', (task,owner_id,contact_id))
    return task


def recover_due(repository, *, owner_id, limit=32):
    """补扫只返回当前用户已授权的持久工作；无新输入不重开失败或升级历史。"""
    import psycopg
    tasks = set()
    with psycopg.connect(repository._database_url, connect_timeout=2) as connection:
        connection.execute("SET LOCAL statement_timeout='2s'")
        scopes = connection.execute("SELECT s.contact_id FROM public.memory_extraction_schedule s "
            "WHERE s.owner_id=%s AND s.due_at<=%s "
            "AND EXISTS(SELECT 1 FROM public.memory_extraction_receipt r "
            "JOIN public.local_wechat_observation o ON o.id=r.observation_id "
            "JOIN public.conversation_binding b ON b.id=o.binding_id AND b.owner_id=r.owner_id AND b.contact_id=r.contact_id "
            "WHERE r.owner_id=s.owner_id AND r.contact_id=s.contact_id AND r.task_id IS NULL AND b.status='active') "
            "AND NOT EXISTS(SELECT 1 FROM public.background_task t WHERE t.owner_id=s.owner_id AND t.contact_id=s.contact_id "
            "AND t.task_type='observation' AND t.status='cancelled') "
            "ORDER BY s.due_at,s.contact_id LIMIT %s", (owner_id,utcnow(),limit)).fetchall()
        for (contact_id,) in scopes:
            task = claim_scope(connection,repository,owner_id=owner_id,contact_id=contact_id)
            if task:
                tasks.add((contact_id,task))
        rows = connection.execute("SELECT t.contact_id,t.id FROM public.background_task t "
            "WHERE t.owner_id=%s AND t.status IN ('queued','running','verifying') AND ("
            "(t.task_type='import' AND EXISTS(SELECT 1 FROM public.source_document d "
            "WHERE d.id=t.source_document_id AND d.owner_id=t.owner_id AND d.contact_id=t.contact_id AND d.status='active')) "
            "OR (t.task_type='observation' AND EXISTS(SELECT 1 FROM public.local_wechat_observation o "
            "JOIN public.conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id "
            "WHERE o.owner_id=t.owner_id AND o.contact_id=t.contact_id AND b.status='active' "
            "AND EXISTS(SELECT 1 FROM public.message_source_ref r WHERE r.observation_id=o.id)))) "
            "ORDER BY t.created_at,t.id LIMIT %s", (owner_id,limit)).fetchall()
        tasks.update(rows)
    return tuple(tasks)
