"""观察提交与调度同事务；只保存消息身份，复用既有任务和租约。"""
from datetime import datetime, timedelta, timezone


def utcnow():
    return datetime.now(timezone.utc)


# 单次认领沿用既有批量汇总，但给历史积压一个上限：一次事务最多登记
# 2000 条回执，余量由调度器下一轮继续，避免在联系人锁内大块写入。
_MAX_RECEIPTS_PER_CLAIM = 2000

_PENDING_SOURCE = ("FROM public.memory_extraction_receipt r "
    "JOIN public.local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id "
    "JOIN public.conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id "
    "WHERE r.owner_id=%s AND r.contact_id=%s AND r.task_id IS NULL AND b.status='active' "
    "AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=r.message_id AND ref.observation_id=o.id)")
_PENDING = "SELECT r.message_id,r.observation_id " + _PENDING_SOURCE
_PENDING_COUNT = "SELECT count(*) " + _PENDING_SOURCE
_PENDING_CLAIM = (_PENDING
    + " ORDER BY o.created_at,o.id,r.message_id LIMIT %s")


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
    previous = connection.execute(
        "SELECT id,status FROM public.background_task WHERE owner_id=%s AND contact_id=%s "
        "AND task_type='observation' FOR UPDATE", (owner_id, contact_id),
    ).fetchone()
    if previous is not None and previous[1] == 'cancelled':
        # 新观察只重开新目标；取消前尚未领取的回执也不能随新输入重新排队。
        connection.execute(
            'UPDATE public.memory_extraction_receipt SET task_id=%s '
            'WHERE owner_id=%s AND contact_id=%s AND task_id IS NULL '
            'AND NOT (message_id=ANY(%s::uuid[]))',
            (previous[0], owner_id, contact_id, [row[0] for row in count]),
        )
        connection.execute('DELETE FROM public.memory_processing_plan WHERE task_id=%s', (previous[0],))
        connection.execute(
            'UPDATE public.memory_extraction_schedule SET threshold=1,task_id=NULL '
            'WHERE owner_id=%s AND contact_id=%s', (owner_id, contact_id),
        )
    now = utcnow()
    pending = connection.execute(_PENDING_COUNT,(owner_id,contact_id)).fetchone()[0]
    connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=%s, '
        'last_input_at=%s,due_at=CASE WHEN %s>=threshold THEN %s ELSE %s END '
        'WHERE owner_id=%s AND contact_id=%s',
        (pending,now,pending,now,now+timedelta(seconds=600),owner_id,contact_id))


def claim_scope(connection, repository, *, owner_id, contact_id, now=None):
    repository._lock_scope(connection,owner_id,contact_id)
    now = now or utcnow()
    state = connection.execute('SELECT threshold,due_at,last_input_at,task_id,pending_count FROM public.memory_extraction_schedule '
        'WHERE owner_id=%s AND contact_id=%s FOR UPDATE', (owner_id,contact_id)).fetchone()
    if not state or state[1] is None or state[1] > now:
        return None
    previous = connection.execute("SELECT status FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type='observation'",
                                  (owner_id,contact_id)).fetchone()
    if previous and previous[0] == 'cancelled' and state[3] is not None:
        return None
    active = connection.execute(
        "SELECT t.id,(SELECT count(*) FROM public.memory_processing_target x "
        "WHERE x.task_id=t.id AND x.completed_at IS NULL) FROM public.background_task t "
        "WHERE t.owner_id=%s AND t.contact_id=%s AND t.task_type='observation' "
        "AND t.status IN ('queued','running','verifying') "
        "ORDER BY t.created_at,t.id LIMIT 1", (owner_id,contact_id)).fetchone()
    if active is not None and active[1] >= _MAX_RECEIPTS_PER_CLAIM:
        # 已排队的提取工作足够多时先不追加；任务执行期间继续读取不受影响。
        # 不在这里重扫回执，避免每轮调度重复历史规模的查询。
        connection.execute('UPDATE public.memory_extraction_schedule SET due_at=%s '
            'WHERE owner_id=%s AND contact_id=%s', (now,owner_id,contact_id))
        return None
    rows = connection.execute(_PENDING_CLAIM,(owner_id,contact_id,_MAX_RECEIPTS_PER_CLAIM)).fetchall()
    idle_at = state[2] + timedelta(seconds=600)
    if not rows or len(rows) < state[0] and idle_at > now:
        pending = connection.execute(_PENDING_COUNT,(owner_id,contact_id)).fetchone()[0]
        connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=%s,due_at=%s '
            'WHERE owner_id=%s AND contact_id=%s',
            (pending,idle_at if pending else None,owner_id,contact_id))
        return None
    task = repository.create_observation_task(connection,owner_id=owner_id,contact_id=contact_id,message_count=len(rows))
    from notalone.persistence.memory_processing import enroll_observation_targets
    legacy_pending = previous is not None and previous[0] not in {'succeeded', 'cancelled'}
    observation_ids = sorted({row[1] for row in rows})
    for observation_id in observation_ids:
        enroll_observation_targets(
            connection, owner_id=owner_id, contact_id=contact_id, task_id=task,
            observation_id=observation_id, include_legacy_pending=legacy_pending,
        )
    # 目标按整个来源批次登记；同一批次余下的回执也随本次认领，
    # 避免下一轮为已登记的目标重复建任务。
    connection.execute('UPDATE public.memory_extraction_receipt SET task_id=%s '
                       'WHERE owner_id=%s AND contact_id=%s AND task_id IS NULL '
                       'AND observation_id=ANY(%s)',
                       (task,owner_id,contact_id,observation_ids))
    connection.execute('UPDATE public.local_wechat_observation SET memory_enqueued_at=%s WHERE id=ANY(%s)',
                       (now,observation_ids))
    remaining = connection.execute(_PENDING_COUNT,(owner_id,contact_id)).fetchone()[0]
    connection.execute('UPDATE public.memory_extraction_schedule SET pending_count=%s,'
        'due_at=CASE WHEN %s>0 THEN %s ELSE NULL END,threshold=LEAST(threshold*2,5),'
        'generation=generation+1,task_id=%s WHERE owner_id=%s AND contact_id=%s',
        (remaining,remaining,now,task,owner_id,contact_id))
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
            "AND t.task_type='observation' AND t.status='cancelled' AND s.task_id IS NOT NULL) "
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
