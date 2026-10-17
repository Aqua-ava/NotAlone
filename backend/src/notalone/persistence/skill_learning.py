"""按联系人隔离的学习草稿权威存储。"""

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from uuid import UUID, uuid4

from notalone.persistence.locks import lock_owner_scope, lock_contact_scope
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository, _insert_task_steps
from notalone.persistence.skill_learning_materials import expand_learning_provenance, select_learning_batch
from notalone.skills.learning import SkillLearningInvalid, SkillLearningUnavailable, content_digest
from notalone.skills.draft_proposal import normalize_proposal
from notalone.tasks.models import SKILL_LEARNING_STEPS

from notalone.scopes import ContactScope


class SkillLearningNotFound(Exception):
    """目标不属于当前已验证范围。"""


class PostgresSkillLearningStore:
    def __init__(self, database_url: str):
        self.database_url = database_url

    def list(self, scope: ContactScope) -> dict[str, object]:
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            require_contact(connection, scope)
            self._clear_unavailable(connection, scope)
            rows = connection.execute(
                "SELECT id, revision, status, logical_skill_id, proposal_kind, strategy, "
                "private_evidence, target_versions FROM public.skill_draft "
                "WHERE owner_id=%s AND contact_id=%s AND status='pending' ORDER BY created_at,id LIMIT 100",
                (scope.owner_id, scope.contact_id),
            ).fetchall()
            setting = connection.execute('SELECT enabled,revision FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s',
                                         (scope.owner_id, scope.contact_id)).fetchone()
            task = connection.execute('SELECT id,status,last_error_code FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type=\'skill_learning\'',
                                      (scope.owner_id, scope.contact_id)).fetchone()
            outcomes = connection.execute('SELECT outcome FROM public.skill_learning_batch WHERE owner_id=%s AND contact_id=%s AND outcome<>\'invalidated\' ORDER BY created_at DESC LIMIT 5',
                                          (scope.owner_id, scope.contact_id)).fetchall()
        return {"drafts": [draft_payload(row) for row in rows], "enabled": bool(setting and setting[0]),
                "task": {"task_id": str(task[0]), "status": task[1], "error_code": task[2]} if task else None,
                "recent_outcomes": [row[0] for row in outcomes], "scope_revision": setting[1] if setting else 0}

    def read(self, scope: ContactScope, draft_id: UUID) -> dict[str, object]:
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            require_contact(connection, scope)
            self._clear_unavailable(connection, scope)
            row = connection.execute('SELECT id,revision,status,logical_skill_id,proposal_kind,strategy,private_evidence,target_versions FROM public.skill_draft WHERE owner_id=%s AND contact_id=%s AND id=%s',
                                     (scope.owner_id, scope.contact_id, draft_id)).fetchone()
            if not row:
                raise SkillLearningNotFound()
        if row[2] == 'invalidated':
            raise SkillLearningInvalid()
        return {'draft': draft_payload(row)}

    def configure(self, scope: ContactScope, *, enabled: bool, operation_key: UUID, expected_revision: int) -> None:
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            require_contact(connection, scope)
            previous = connection.execute('SELECT enabled,expected_revision FROM public.skill_learning_operation WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                                          (scope.owner_id, scope.contact_id, operation_key)).fetchone()
            if previous:
                if previous != (enabled, expected_revision):
                    raise SkillLearningInvalid()
                return  # 旧成功回执不重写后来关闭的决定。
            current = connection.execute('SELECT revision FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s',
                                         (scope.owner_id, scope.contact_id)).fetchone()
            if (current[0] if current else 0) != expected_revision:
                raise SkillLearningInvalid()
            if enabled and not authorized_contact(connection, scope):
                raise SkillLearningUnavailable()
            connection.execute('INSERT INTO public.skill_learning_scope(owner_id,contact_id,enabled,revision,confirmed_at) VALUES (%s,%s,%s,%s,now()) ON CONFLICT(owner_id,contact_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,confirmed_at=excluded.confirmed_at',
                               (scope.owner_id, scope.contact_id, enabled, expected_revision + 1))
            connection.execute('INSERT INTO public.skill_learning_operation(owner_id,contact_id,operation_key,enabled,expected_revision,result_revision) VALUES(%s,%s,%s,%s,%s,%s)',
                               (scope.owner_id, scope.contact_id, operation_key, enabled, expected_revision, expected_revision + 1))
            if not enabled:
                cancel_learning_tasks(connection, scope)

    def enqueue(self, scope: ContactScope, *, force_retry=False) -> UUID | None:
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            if not learning_allowed(connection, scope):
                return None
            row = connection.execute("SELECT id,status FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type='skill_learning' FOR UPDATE",
                                     (scope.owner_id, scope.contact_id)).fetchone()
            batch = select_learning_batch(connection, scope)
            if row and row[1] in ('queued', 'running', 'verifying'):
                if row[1] == 'queued' and batch.ready:
                    _mark_queued_attempt(connection, scope, row[0], batch.key)
                attempted = connection.execute('SELECT last_attempt_key FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s',
                                               (scope.owner_id, scope.contact_id)).fetchone()[0]
                if row[1] != 'queued' and batch.ready and attempted != batch.key:
                    connection.execute('UPDATE public.background_task SET observation_pending=true WHERE id=%s', (row[0],))
                return row[0]
            if row and row[1] == 'failed' and force_retry:
                if (_recover_committed_batch(connection, scope, row[0], observation_pending=batch.ready)
                        or _recover_empty_verification(connection, row[0], observation_pending=batch.ready)):
                    return row[0]
            if not batch.ready:
                return None
            if row is None:
                task_id = connection.execute("INSERT INTO public.background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES(%s,%s,'skill_learning','queued','propose_skill',%s) RETURNING id",
                                             (scope.owner_id, scope.contact_id, len(batch.materials))).fetchone()[0]
                _insert_task_steps(connection, task_id=task_id, steps=SKILL_LEARNING_STEPS, total_count=len(batch.materials))
                _mark_queued_attempt(connection, scope, task_id, batch.key)
                return task_id
            task_id, state = row
            if state in ('failed', 'cancelled', 'succeeded'):
                attempted = connection.execute('SELECT last_attempt_key FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s',
                                               (scope.owner_id, scope.contact_id)).fetchone()[0]
                if state == 'failed' and not force_retry and attempted == batch.key:
                    return None
                reset_learning_task(connection, task_id, len(batch.materials))
                _mark_queued_attempt(connection, scope, task_id, batch.key)
            return task_id

    def capture(self, scope: ContactScope):
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            if not learning_allowed(connection, scope):
                raise SkillLearningUnavailable()
            batch = select_learning_batch(connection, scope)
            if batch.ready:
                connection.execute('UPDATE public.skill_learning_scope SET last_attempt_key=%s WHERE owner_id=%s AND contact_id=%s',
                                   (batch.key, scope.owner_id, scope.contact_id))
            return batch

    def save(self, scope: ContactScope, claim, batch, proposal) -> int:
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            PostgresBackgroundTaskRepository._assert_valid_claim(connection, claim)
            if not learning_allowed(connection, scope):
                raise SkillLearningUnavailable()
            # 新到事件留给下一轮，已经参与的材料、目标版本和来源必须完全一致。
            ids = {UUID(item['material_id']) for item in batch.materials}
            current = select_learning_batch(connection, scope, material_ids=ids)
            if current.key != batch.key:
                raise SkillLearningInvalid()
            normalized, outcome = normalize_proposal(scope, batch, proposal)
            draft_id = None
            if normalized:
                if normalized['proposal_kind'] == 'create' and connection.execute(
                    "SELECT 1 FROM public.reply_skill WHERE owner_id=%s AND (contact_id IS NULL OR contact_id=%s) "
                    "AND status<>'deleted' AND name=%s LIMIT 1",
                    (scope.owner_id, scope.contact_id, normalized['strategy']['name']),
                ).fetchone():
                    raise SkillLearningInvalid()
                names = connection.execute('SELECT display_name FROM public.contact WHERE owner_id=%s AND id=%s', (scope.owner_id, scope.contact_id)).fetchall()
                if any(len(row[0]) >= 2 and row[0] in normalized['strategy']['document'] for row in names):
                    raise SkillLearningInvalid()
                draft_id = uuid4()
                connection.execute('INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,private_evidence,target_versions,dependency_ids,batch_key,source_generation) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                                   (draft_id, scope.owner_id, scope.contact_id, normalized['logical_skill_id'], normalized['proposal_kind'], Jsonb(normalized['strategy']),
                                    Jsonb({'materials': list(batch.materials), 'existing_skills': list(batch.targets),
                                           'source_dependencies': [str(identifier) for identifier in batch.dependency_ids]}),
                                    Jsonb(normalized['target_versions']), list(batch.dependency_ids), batch.key, Jsonb(batch.source_generation)))
                for method in normalized['strategy']['methods']:
                    connection.execute('INSERT INTO public.skill_method_identity(owner_id,logical_skill_id,method_id,semantic_key_sha256) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                                       (scope.owner_id, normalized['logical_skill_id'], UUID(method['method_id']), content_digest(method['key'])))
            batch_id = connection.execute('INSERT INTO public.skill_learning_batch(owner_id,contact_id,task_id,batch_key,outcome,draft_id,dependency_ids) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id',
                                          (scope.owner_id, scope.contact_id, claim.task_id, batch.key, outcome, draft_id, list(batch.dependency_ids))).fetchone()[0]
            for material in batch.materials:
                connection.execute('INSERT INTO public.skill_learning_receipt(owner_id,contact_id,material_id,digest,batch_id) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                                   (scope.owner_id, scope.contact_id, UUID(material['material_id']), material['digest'], batch_id))
            more = select_learning_batch(connection, scope)
            if more.ready:
                connection.execute('UPDATE public.background_task SET observation_pending=true WHERE id=%s', (claim.task_id,))
        return len(batch.materials)

    def validate(self, scope: ContactScope, claim, batch) -> None:
        """在取得模型许可后重取原有限材料，删除无需等待首份草稿落库。"""
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            PostgresBackgroundTaskRepository._assert_valid_claim(connection, claim)
            if not learning_allowed(connection, scope):
                raise SkillLearningUnavailable()
            current = select_learning_batch(connection, scope,
                material_ids={UUID(item['material_id']) for item in batch.materials})
            if current.key != batch.key:
                raise SkillLearningInvalid()

    def verify(self, scope: ContactScope) -> None:
        with psycopg.connect(self.database_url) as connection:
            lock_owner_scope(connection, owner_id=scope.owner_id)
            if not learning_allowed(connection, scope):
                raise SkillLearningUnavailable()
            self._clear_unavailable(connection, scope)

    def _clear_unavailable(self, connection, scope) -> None:
        from notalone.persistence.skill_learning_generation import generation_current
        rows = connection.execute("SELECT id,dependency_ids,source_generation FROM public.skill_draft WHERE owner_id=%s AND contact_id=%s AND status<>'invalidated'", (scope.owner_id, scope.contact_id)).fetchall()
        for draft_id, dependencies, generation in rows:
            if not dependencies_current(connection, scope, dependencies) or not generation_current(connection, scope, generation):
                invalidate_drafts(connection, scope.owner_id, [draft_id])


def require_contact(connection, scope: ContactScope) -> None:
    if not connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id),
    ).fetchone():
        raise SkillLearningNotFound()


def draft_payload(row) -> dict[str, object]:
    return {"draft_id": str(row[0]), "revision": row[1], "status": row[2],
            "logical_skill_id": str(row[3]), "proposal_kind": row[4],
            "sanitized_strategy": row[5], "private_evidence": row[6],
            "target_versions": row[7]}


def authorized_contact(connection, scope) -> bool:
    return bool(connection.execute("SELECT 1 FROM public.conversation_binding WHERE owner_id=%s AND contact_id=%s AND status='active'", (scope.owner_id, scope.contact_id)).fetchone())


def learning_allowed(connection, scope) -> bool:
    return authorized_contact(connection, scope) and bool(connection.execute('SELECT 1 FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s AND enabled', (scope.owner_id, scope.contact_id)).fetchone())


def _mark_queued_attempt(connection, scope, task_id, key):
    # 捕获查询自身也可能失败，已选择批次须在首次认领前持久记为本轮尝试。
    connection.execute(
        'UPDATE public.skill_learning_scope AS setting SET last_attempt_key=%s '
        'WHERE setting.owner_id=%s AND setting.contact_id=%s AND EXISTS('
        'SELECT 1 FROM public.background_task AS task JOIN public.background_task_step AS step ON step.task_id=task.id '
        'WHERE task.id=%s AND task.owner_id=setting.owner_id AND task.contact_id=setting.contact_id '
        "AND task.task_type='skill_learning' AND task.status='queued' AND task.current_step='propose_skill' "
        "AND step.step_name='propose_skill' AND step.status='pending' AND step.attempt_count=0)",
        (key, scope.owner_id, scope.contact_id, task_id),
    )


def _recover_committed_batch(connection, scope, task_id, *, observation_pending) -> bool:
    """只恢复最后一次已提交结果的步骤回执，不重复提案或复活失效资料。"""
    from notalone.persistence.skill_learning_generation import generation_current
    row = connection.execute(
        'SELECT batch.id,batch.dependency_ids,batch.draft_id,draft.status,draft.source_generation '
        'FROM public.skill_learning_batch AS batch JOIN public.skill_learning_scope AS setting '
        'ON setting.owner_id=batch.owner_id AND setting.contact_id=batch.contact_id '
        'JOIN public.background_task_step AS proposed ON proposed.task_id=batch.task_id '
        "AND proposed.step_name='propose_skill' "
        'LEFT JOIN public.skill_draft AS draft ON draft.id=batch.draft_id '
        'AND draft.owner_id=batch.owner_id AND draft.contact_id=batch.contact_id '
        'WHERE batch.owner_id=%s AND batch.contact_id=%s AND batch.task_id=%s '
        'AND batch.created_at>=proposed.started_at '
        "AND batch.batch_key=setting.last_attempt_key AND batch.outcome<>'invalidated' FOR UPDATE OF batch",
        (scope.owner_id, scope.contact_id, task_id),
    ).fetchone()
    if row is None or not dependencies_current(connection, scope, row[1]):
        return False
    if row[2] is not None and (row[3] not in ('pending', 'rejected', 'published')
                               or not generation_current(connection, scope, row[4])):
        return False
    count, available = connection.execute(
        'SELECT count(*),count(digest) FROM public.skill_learning_receipt '
        'WHERE owner_id=%s AND contact_id=%s AND batch_id=%s',
        (scope.owner_id, scope.contact_id, row[0]),
    ).fetchone()
    if not 1 <= count <= 8 or available != count:
        return False
    connection.execute(
        "UPDATE public.background_task_step SET status='succeeded',processed_count=%s,total_count=%s,"
        'worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,'
        "finished_at=now(),updated_at=now() WHERE task_id=%s AND step_name='propose_skill'",
        (count, count, task_id),
    )
    _queue_verification(connection, task_id, observation_pending=observation_pending)
    return True


def _recover_empty_verification(connection, task_id, *, observation_pending) -> bool:
    # 入队后材料消失时propose合法完成0项；已有成功回执足以恢复未完成核验。
    if not connection.execute(
        'SELECT 1 FROM public.background_task_step AS proposed '
        'JOIN public.background_task_step AS verification ON verification.task_id=proposed.task_id '
        "WHERE proposed.task_id=%s AND proposed.step_name='propose_skill' "
        "AND proposed.status='succeeded' AND proposed.processed_count=0 "
        "AND verification.step_name='verify_skill_drafts' AND verification.status<>'succeeded'",
        (task_id,),
    ).fetchone():
        return False
    _queue_verification(connection, task_id, observation_pending=observation_pending)
    return True


def _queue_verification(connection, task_id, *, observation_pending):
    connection.execute(
        "UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,"
        'lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,'
        "updated_at=now() WHERE task_id=%s AND step_name='verify_skill_drafts'",
        (task_id,),
    )
    connection.execute(
        "UPDATE public.background_task SET status='queued',current_step='verify_skill_drafts',"
        'observation_pending=%s,last_error_code=NULL,finished_at=NULL,updated_at=now() WHERE id=%s',
        (observation_pending, task_id),
    )


def reset_learning_task(connection, task_id, count) -> None:
    connection.execute("UPDATE public.background_task_step SET status='pending',attempt_count=0,processed_count=0,worker_id=NULL,lease_expires_at=NULL,last_error_code=NULL,started_at=NULL,finished_at=NULL WHERE task_id=%s", (task_id,))
    connection.execute("UPDATE public.background_task SET status='queued',current_step='propose_skill',message_count=%s,observation_pending=false,last_error_code=NULL,started_at=NULL,finished_at=NULL WHERE id=%s", (count, task_id))


def cancel_learning_tasks(connection, scope) -> None:
    connection.execute("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL WHERE task_id IN (SELECT id FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type='skill_learning') AND status<>'succeeded'", (scope.owner_id, scope.contact_id))
    connection.execute("UPDATE public.background_task SET status='cancelled',observation_pending=false WHERE owner_id=%s AND contact_id=%s AND task_type='skill_learning' AND status IN ('queued','running','verifying','failed')", (scope.owner_id, scope.contact_id))
    connection.execute('UPDATE public.skill_learning_scope SET last_attempt_key=NULL WHERE owner_id=%s AND contact_id=%s',
                       (scope.owner_id, scope.contact_id))


def invalidate_drafts(connection, owner_id, draft_ids) -> None:
    if not draft_ids:
        return
    connection.execute("UPDATE public.skill_draft SET status='invalidated',revision=revision+1,strategy=NULL,private_evidence=NULL,target_versions='[]',dependency_ids='{}',source_generation='{}',batch_key=id::text WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'invalidated'", (owner_id, draft_ids))
    from notalone.persistence.skill_review import erase_review_artifacts
    erase_review_artifacts(connection, owner_id, draft_ids)
    batches = connection.execute("UPDATE public.skill_learning_batch SET outcome='invalidated',dependency_ids='{}',batch_key=id::text WHERE owner_id=%s AND draft_id=ANY(%s::uuid[]) RETURNING id", (owner_id, draft_ids)).fetchall()
    _erase_receipt_digests(connection, owner_id, [_row_value(row, 'id') for row in batches])


def _row_value(row, key, index=0):
    return row[key] if isinstance(row, dict) else row[index]


def _erase_receipt_digests(connection, owner_id, batches) -> None:
    connection.execute('UPDATE public.skill_learning_receipt SET digest=NULL WHERE owner_id=%s AND batch_id=ANY(%s::uuid[])', (owner_id, batches))


def erase_skill_learning(connection, *, owner_id, removed_ids) -> None:
    # 旧测试/旧库未安装该前向迁移时不改变其他领域删除行为。
    if not _row_value(connection.execute("SELECT to_regclass('public.skill_draft') AS relation").fetchone(), 'relation'):
        return
    if _row_value(connection.execute("SELECT to_regclass('public.skill_review_comparison') AS relation").fetchone(), 'relation'):
        from notalone.persistence.skill_review import invalidate_comparisons
        comparisons = connection.execute(
            "SELECT DISTINCT draft_id FROM public.skill_review_comparison WHERE owner_id=%s AND dependency_ids && %s::uuid[] AND state<>'invalidated'",
            (owner_id, list(removed_ids))).fetchall()
        affected = [_row_value(row, 'draft_id') for row in comparisons]
        invalidate_comparisons(connection, owner_id, affected)
        connection.execute('UPDATE public.skill_draft SET current_comparison_id=NULL WHERE owner_id=%s AND id=ANY(%s::uuid[])', (owner_id, affected))
        published = connection.execute(
            'SELECT draft_id FROM public.reply_skill_publication WHERE owner_id=%s AND NOT deleted AND '
            '(dependency_ids && %s::uuid[] OR version_id=ANY(%s::uuid[]) OR logical_skill_id=ANY(%s::uuid[]))',
            (owner_id, list(removed_ids), list(removed_ids), list(removed_ids))).fetchall()
        invalidate_drafts(connection, owner_id, [_row_value(row, 'draft_id') for row in published])
    rows = connection.execute("SELECT id,contact_id FROM public.skill_draft WHERE owner_id=%s AND dependency_ids && %s::uuid[] AND status<>'invalidated'", (owner_id, list(removed_ids))).fetchall()
    invalidate_drafts(connection, owner_id, [row[0] if not isinstance(row, dict) else row['id'] for row in rows])
    batches = connection.execute("UPDATE public.skill_learning_batch SET outcome='invalidated',dependency_ids='{}',batch_key=id::text WHERE owner_id=%s AND dependency_ids && %s::uuid[] RETURNING id,contact_id", (owner_id, list(removed_ids))).fetchall()
    _erase_receipt_digests(connection, owner_id, [_row_value(row, 'id') for row in batches])
    contacts = {row[1] if not isinstance(row, dict) else row['contact_id'] for row in rows}
    contacts.update(_row_value(row, 'contact_id', 1) for row in batches)
    for contact in contacts:
        cancel_learning_tasks(connection, ContactScope(owner_id, contact))


def dependencies_current(connection, scope, dependencies) -> bool:
    dependencies = expand_learning_provenance(connection, scope, dependencies)
    return dependencies is not None and _dependencies_available_for_learning(connection, scope, dependencies)


def _dependencies_available_for_learning(connection, scope, dependencies) -> bool:
    from notalone.persistence.assistant_session_store import _dependencies_available
    from notalone.persistence.skill_version_lineage import capture_parent_publications
    try:
        _, inherited = capture_parent_publications(connection, scope, dependencies)
    except SkillLearningInvalid:
        return False
    identifiers = list(dependencies)
    known = set(inherited)
    for table, predicate in (('assistant_session', ''), ('assistant_session_input', "AND state='active'"),
                             ('assistant_session_turn', "AND state='completed'"), ('assistant_candidate_version', ''),
                             ('assistant_candidate_selection', ''), ('reply_request', "AND state='completed'"), ('reply_candidate', ''),
                             ('reply_skill', "AND status<>'deleted'")):
        if table == 'reply_skill':
            statement = 'SELECT id FROM public.reply_skill WHERE owner_id=%s AND (contact_id IS NULL OR contact_id=%s) AND id=ANY(%s::uuid[]) ' + predicate
        else:
            statement = 'SELECT id FROM public.' + table + ' WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) ' + predicate
        known.update(row[0] for row in connection.execute(statement, (scope.owner_id, scope.contact_id, identifiers)).fetchall())
    known.update(row[0] for row in connection.execute("SELECT version.id FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill ON skill.id=version.skill_id WHERE skill.owner_id=%s AND (skill.contact_id IS NULL OR skill.contact_id=%s) AND skill.status<>'deleted' AND version.content IS NOT NULL AND version.id=ANY(%s::uuid[])", (scope.owner_id, scope.contact_id, identifiers)).fetchall())
    known.update(row[0] for row in connection.execute(
        "SELECT id FROM public.expression_preference WHERE owner_id=%s "
        "AND (contact_id IS NULL OR contact_id=%s) AND status='active' AND id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, identifiers),
    ).fetchall())
    with connection.cursor(row_factory=dict_row) as cursor:
        # 已发生的合法使用可形成草稿；当前生成写口仍使用原严格默认门。
        return _dependencies_available(cursor, scope, set(dependencies) - known, historical=True)
