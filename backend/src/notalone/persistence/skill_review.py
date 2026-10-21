"""草稿审核的事务、冻结输入和无正文幂等回执。"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.skill_learning import (
    PostgresSkillLearningStore, SkillLearningNotFound, authorized_contact,
    draft_payload, require_contact,
)
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.persistence.skill_review_navigation import capture_review_sources, review_sources_current
from notalone.skills.learning import SkillLearningInvalid, content_digest
from notalone.skills.review import edited_strategy


logger = logging.getLogger(__name__)


def review_now():
    return datetime.now(timezone.utc)


class PostgresSkillReviewStore:
    """模型只读试用与用户发布之间的持久边界。"""

    def __init__(self, database_url: str, *, clock=None):
        self.database_url, self.clock = database_url, clock or (lambda: review_now())

    def read(self, scope, draft_id):
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_draft(connection, scope, draft_id)
            return self._payload(connection, scope, draft)

    def record_call(self, scope, comparison_id, side, entry_id):
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                'INSERT INTO public.skill_review_call(comparison_id,owner_id,contact_id,side,ledger_entry_id) '
                'SELECT id,owner_id,contact_id,%s,%s FROM public.skill_review_comparison '
                'WHERE id=%s AND owner_id=%s AND contact_id=%s',
                (side, entry_id, comparison_id, scope.owner_id, scope.contact_id))

    def change(self, scope, *, draft_id, expected_revision, operation_key,
               strategy=None, decision=None):
        action = 'edit' if strategy is not None else 'decision'
        command = {'revision': expected_revision, 'strategy': strategy, 'decision': decision}
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_draft(connection, scope, draft_id)
            if self._operation(connection, scope, draft_id, operation_key, action, command):
                return self._payload(connection, scope, draft)
            self._require_pending(draft, expected_revision)
            if strategy is not None:
                strategy = edited_strategy(scope, draft, strategy)
                self._require_sanitized(connection, scope, strategy)
                for method in strategy['methods']:
                    connection.execute(
                        'INSERT INTO public.skill_method_identity(owner_id,logical_skill_id,method_id,semantic_key_sha256) '
                        'VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                        (scope.owner_id, UUID(draft['logical_skill_id']), UUID(method['method_id']), content_digest(method['key'])))
            invalidate_comparisons(connection, scope.owner_id, [draft_id])
            connection.execute(
                'UPDATE public.skill_draft SET revision=revision+1,strategy=coalesce(%s,strategy),'
                'status=%s,last_decision=%s,current_comparison_id=NULL WHERE id=%s',
                (Jsonb(strategy) if strategy else None, 'rejected' if decision == 'reject' else 'pending', decision, draft_id))
            self._record_operation(connection, scope, draft_id, operation_key, action, command)
        return self.read(scope, draft_id)

    def begin_comparison(self, scope, *, draft_id, expected_revision, operation_key,
                         input, scope_confirmation, context_fingerprint, context_dependencies,
                         context_revisions, navigation=()):
        command = {'revision': expected_revision, 'input': input, 'scope': scope_confirmation}
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_draft(connection, scope, draft_id)
            previous = self._operation(connection, scope, draft_id, operation_key, 'compare', command)
            if previous:
                comparison = self._comparison(connection, scope, previous['comparison_id'])
                self._require_comparison(connection, scope, draft, comparison, context_fingerprint)
                if comparison['state'] == 'completed':
                    return draft, comparison, True
                if comparison['state'] == 'running' and comparison['lease_expires_at'] > self.clock():
                    raise SkillLearningInvalid()
                comparison_id, input_version = comparison['id'], comparison['input_version']
            else:
                self._require_pending(draft, expected_revision)
                comparison_id, input_version = uuid4(), uuid4()
            self._require_sanitized(connection, scope, draft['sanitized_strategy'])
            if not authorized_contact(connection, scope):
                raise SkillLearningInvalid()
            self._require_targets(connection, scope, draft['target_versions'])
            dependencies, sources = capture_review_sources(connection, scope,
                {UUID(value) for value in draft['dependency_ids']}, context_dependencies, navigation, draft['target_versions'])
            frozen = {'sources': sources,
                      'revisions': context_revisions}
            self._require_revisions(connection, scope, context_revisions)
            token = uuid4()
            if not previous:
                invalidate_comparisons(connection, scope.owner_id, [draft_id])
                connection.execute(
                    'INSERT INTO public.skill_review_comparison(id,owner_id,contact_id,draft_id,draft_revision,'
                    'input_version,input,confirmed_scope,context_fingerprint,library_revision,dependency_ids,'
                    'source_generation,target_versions,state) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,\'failed\')',
                    (comparison_id, scope.owner_id, scope.contact_id, draft_id, expected_revision, input_version,
                     Jsonb(input), Jsonb(scope_confirmation), context_fingerprint, context_revisions['library'],
                     list(dependencies), Jsonb(frozen), Jsonb(draft['target_versions'])))
                connection.execute('UPDATE public.skill_draft SET current_comparison_id=%s WHERE id=%s', (comparison_id, draft_id))
                self._record_operation(connection, scope, draft_id, operation_key, 'compare', command,
                                       comparison_id=comparison_id)
            connection.execute(
                "UPDATE public.skill_review_comparison SET state='running',run_token=%s,lease_expires_at=%s WHERE id=%s",
                (token, self.clock() + timedelta(minutes=2), comparison_id))
            return draft, self._comparison(connection, scope, comparison_id), False

    def validate_comparison(self, scope, comparison_id, run_token, context_fingerprint, *, with_execution_view=False):
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_running_comparison(connection, scope, comparison_id, run_token, context_fingerprint)
            if with_execution_view:
                comparison = self._comparison(connection, scope, comparison_id)
                from notalone.persistence.skill_execution_view import project_skill_version
                strategy = draft['sanitized_strategy']
                methods = [{**item, 'method_id': UUID(item['method_id']), 'mapping_state': item['mapping_status'],
                    'replaces_method_ids': [UUID(value) for value in item['replaces_method_ids']]}
                    for item in strategy['methods']]
                try:
                    return project_skill_version(connection, scope, {
                        'skill_id': UUID(draft['logical_skill_id']), 'version_id': comparison_id,
                        'review_origin': True, 'version_name': strategy['name'], 'skill_name': strategy['name'],
                        'version_description': strategy['description'], 'skill_description': strategy['description'],
                        'version_content': strategy['document'],
                    }, comparison['input']['scene'], proposed_methods=methods)
                except PermissionError:
                    raise SkillLearningInvalid() from None

    def _locked_running_comparison(self, connection, scope, comparison_id, run_token, context_fingerprint):
        comparison = self._comparison(connection, scope, comparison_id)
        draft = self._locked_draft(connection, scope, comparison['draft_id'])
        comparison = self._comparison(connection, scope, comparison_id)
        self._require_comparison(connection, scope, draft, comparison, context_fingerprint)
        if (comparison['state'] != 'running' or comparison['run_token'] != run_token
                or comparison['lease_expires_at'] is None or comparison['lease_expires_at'] <= self.clock()):
            raise SkillLearningInvalid()
        return draft

    def finish_comparison(self, scope, comparison_id, run_token, context_fingerprint, result):
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_running_comparison(connection, scope, comparison_id, run_token, context_fingerprint)
            connection.execute(
                "UPDATE public.skill_review_comparison SET state='completed',result=%s,run_token=NULL,lease_expires_at=NULL WHERE id=%s",
                (Jsonb(result), comparison_id))
            return self._payload(connection, scope, draft)

    def fail_comparison(self, scope, comparison_id, run_token):
        with psycopg.connect(self.database_url) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            connection.execute(
                "UPDATE public.skill_review_comparison SET state='failed',run_token=NULL,lease_expires_at=NULL "
                "WHERE id=%s AND owner_id=%s AND contact_id=%s AND state='running' AND run_token=%s",
                (comparison_id, scope.owner_id, scope.contact_id, run_token))

    def approve(self, scope, *, draft_id, expected_revision, operation_key, comparison_id,
                scope_confirmation):
        command = {'revision': expected_revision, 'comparison_id': str(comparison_id), 'scope': scope_confirmation}
        with psycopg.connect(self.database_url) as connection:
            draft = self._locked_draft(connection, scope, draft_id)
            previous = self._operation(connection, scope, draft_id, operation_key, 'approve', command)
            if previous:
                payload = self._payload(connection, scope, draft)
            else:
                self._require_pending(draft, expected_revision)
                comparison = self._comparison(connection, scope, comparison_id)
                self._require_sanitized(connection, scope, draft['sanitized_strategy'])
                self._require_comparison(connection, scope, draft, comparison)
                if (comparison['state'] != 'completed' or comparison['confirmed_scope'] != scope_confirmation
                        or not comparison['result'] or comparison['result']['after']['load_state'] != 'loaded'):
                    raise SkillLearningInvalid()
                with connection.cursor(row_factory=dict_row) as cursor:
                    published = PostgresSkillLibrary(self.database_url).publish_reviewed(
                        cursor, scope=scope, draft=draft, confirmed_scope=scope_confirmation,
                        dependency_ids=comparison['dependency_ids'], source_generation=comparison['source_generation'])
                connection.execute(
                    "UPDATE public.skill_draft SET status='published',revision=revision+1,last_decision='approve',published_version_id=%s WHERE id=%s",
                    (UUID(published['version_id']), draft_id))
                self._record_operation(connection, scope, draft_id, operation_key, 'approve', command,
                                       comparison_id=comparison_id, published_version_id=UUID(published['version_id']))
                updated = self._read_draft(connection, scope, draft_id)
                payload = self._payload(connection, scope, updated)
        # 发布只提交元数据与不可变快照；工作副本由显式同步入口消费，读路径不再补齐。
        self._synchronize_files(scope.owner_id)
        return payload

    def _synchronize_files(self, owner_id) -> None:
        """显式同步工作副本；失败保留任务并在下一轮入口重试，不回滚已提交审核。"""
        from notalone.persistence.skill_directory import SkillDirectorySyncError, synchronize_skill_library
        try:
            synchronize_skill_library(self.database_url, owner_id, migrate_legacy=False)
        except SkillDirectorySyncError:
            logger.warning("skill_directory_sync_failed")

    def _locked_draft(self, connection, scope, draft_id):
        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
        lock_owner_scope(connection, owner_id=scope.owner_id)
        require_contact(connection, scope)
        PostgresSkillLearningStore(self.database_url)._clear_unavailable(connection, scope)
        return self._read_draft(connection, scope, draft_id)

    @staticmethod
    def _read_draft(connection, scope, draft_id):
        row = connection.execute(
            'SELECT id,revision,status,logical_skill_id,proposal_kind,strategy,private_evidence,target_versions,'
            'dependency_ids,current_comparison_id,last_decision,published_version_id FROM public.skill_draft '
            'WHERE owner_id=%s AND contact_id=%s AND id=%s FOR UPDATE',
            (scope.owner_id, scope.contact_id, draft_id)).fetchone()
        if row is None:
            raise SkillLearningNotFound()
        if row[2] == 'invalidated':
            raise SkillLearningInvalid()
        return {**draft_payload(row), 'dependency_ids': [str(value) for value in row[8]],
                'current_comparison_id': row[9], 'last_decision': row[10], 'published_version_id': row[11]}

    @staticmethod
    def _require_pending(draft, revision):
        if draft['status'] != 'pending' or draft['revision'] != revision:
            raise SkillLearningInvalid()

    @staticmethod
    def _require_sanitized(connection, scope, strategy):
        names = connection.execute('SELECT display_name FROM public.contact WHERE owner_id=%s AND id=%s',
                                   (scope.owner_id, scope.contact_id)).fetchall()
        if any(len(row[0]) >= 2 and row[0] in strategy['document'] for row in names):
            raise SkillLearningInvalid()

    @staticmethod
    def _comparison(connection, scope, identifier):
        with connection.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(
                'SELECT * FROM public.skill_review_comparison WHERE id=%s AND owner_id=%s AND contact_id=%s',
                (identifier, scope.owner_id, scope.contact_id)).fetchone()
        if row is None:
            raise SkillLearningNotFound()
        return row

    def _require_comparison(self, connection, scope, draft, comparison, fingerprint=None):
        if (comparison['state'] == 'invalidated' or draft['status'] != 'pending'
                or comparison['draft_id'] != UUID(draft['draft_id'])
                or comparison['draft_revision'] != draft['revision']
                or comparison['id'] != draft['current_comparison_id']
                or fingerprint is not None and fingerprint != comparison['context_fingerprint']
                or not authorized_contact(connection, scope)):
            raise SkillLearningInvalid()
        frozen = comparison['source_generation']
        if not review_sources_current(connection, scope, comparison['dependency_ids'], frozen['sources']):
            raise SkillLearningInvalid()
        self._require_revisions(connection, scope, frozen['revisions'])
        self._require_targets(connection, scope, comparison['target_versions'])

    @staticmethod
    def _require_revisions(connection, scope, expected):
        if not connection.execute(
            "SELECT 1 FROM public.conversation_binding WHERE owner_id=%s AND contact_id=%s AND id=%s AND status='active'",
            (scope.owner_id, scope.contact_id, UUID(expected['binding_id']))).fetchone():
            raise SkillLearningInvalid()
        row = connection.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s', (scope.owner_id,)).fetchone()
        if (row[0] if row else 0) != expected['library']:
            raise SkillLearningInvalid()
        row = connection.execute(
            'SELECT state.memory_revision,index.built_from_memory_revision FROM public.contact_memory_state AS state '
            'LEFT JOIN public.contact_memory_index AS index ON index.owner_id=state.owner_id AND index.contact_id=state.contact_id '
            'WHERE state.owner_id=%s AND state.contact_id=%s', (scope.owner_id, scope.contact_id)).fetchone()
        memory, index = row if row else (0, None)
        if (expected['memory'] is not None and expected['memory'] != memory
                or expected['index'] is not None and expected['index'] != index):
            raise SkillLearningInvalid()
        if expected.get('preferences') is not None:
            row = connection.execute('SELECT revision FROM public.expression_preference_state WHERE owner_id=%s', (scope.owner_id,)).fetchone()
            if (row[0] if row else 0) != expected['preferences']:
                raise SkillLearningInvalid()

    @staticmethod
    def _require_targets(connection, scope, targets):
        for target in targets:
            row = connection.execute(
                "SELECT version.id FROM public.reply_skill AS skill JOIN public.reply_skill_version AS version ON version.skill_id=skill.id "
                "WHERE skill.owner_id=%s AND skill.id=%s AND (skill.contact_id IS NULL OR skill.contact_id=%s) "
                "AND skill.status='active' AND version.id=%s AND version.version_number=%s AND version.is_current "
                "AND version.enabled AND version.status='active' AND version.content_path IS NOT NULL AND version.directory_available",
                (scope.owner_id, UUID(target['skill_id']), scope.contact_id, UUID(target['version_id']), target['version_number'])).fetchone()
            from notalone.persistence.skill_files import version_content_available
            if row is None or not version_content_available(connection, UUID(target['version_id'])):
                raise SkillLearningInvalid()
        if len(targets) > 1:
            from notalone.persistence.skill_version_lineage import capture_parent_publications
            parents, _ = capture_parent_publications(connection, scope, [UUID(item['version_id']) for item in targets])
            if len(parents) != len(targets) or len({content_digest(item['scope']) for item in parents}) != 1:
                raise SkillLearningInvalid()

    @staticmethod
    def _operation(connection, scope, draft_id, operation_key, action, command):
        with connection.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(
                'SELECT * FROM public.skill_review_operation WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                (scope.owner_id, scope.contact_id, operation_key)).fetchone()
        if row is not None and (row['draft_id'] != draft_id or row['action'] != action
                                or row['request_fingerprint'] != content_digest(command)):
            raise SkillLearningInvalid()
        return row

    @staticmethod
    def _record_operation(connection, scope, draft_id, key, action, command,
                          *, comparison_id=None, published_version_id=None):
        connection.execute(
            'INSERT INTO public.skill_review_operation(owner_id,contact_id,draft_id,operation_key,action,request_fingerprint,comparison_id,published_version_id) '
            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
            (scope.owner_id, scope.contact_id, draft_id, key, action, content_digest(command), comparison_id, published_version_id))

    def _payload(self, connection, scope, draft):
        result = {key: value for key, value in draft.items() if key not in (
            'dependency_ids', 'current_comparison_id', 'published_version_id')}
        result['comparison'] = None
        if draft['current_comparison_id'] and draft['status'] == 'pending':
            comparison = self._comparison(connection, scope, draft['current_comparison_id'])
            try:
                self._require_comparison(connection, scope, draft, comparison)
                if comparison['state'] == 'completed':
                    result['comparison'] = comparison_payload(comparison)
            except SkillLearningInvalid:
                invalidate_comparisons(connection, scope.owner_id, [UUID(draft['draft_id'])])
        response = {'draft': result}
        if draft['status'] == 'published':
            with connection.cursor(row_factory=dict_row) as cursor:
                row = cursor.execute(
                    'SELECT version.skill_id,version.id AS version_id,version.name,version.version_number,'
                    'publication.scope_kind,publication.scope_contact_id,publication.scene,library.revision '
                    'FROM public.reply_skill_version AS version JOIN public.reply_skill_publication AS publication ON publication.version_id=version.id '
                    'JOIN public.skill_library AS library ON library.owner_id=publication.owner_id '
                    "WHERE version.id=%s AND version.status='active' AND NOT publication.deleted",
                    (draft['published_version_id'],)).fetchone()
            if row is None:
                raise SkillLearningInvalid()
            response['published'] = {key: str(row[key]) if key in ('skill_id', 'version_id') else row[key]
                                     for key in ('skill_id', 'version_id', 'name', 'version_number', 'revision')}
            response['published']['scope'] = {'kind': row['scope_kind'],
                'contact_id': str(row['scope_contact_id']) if row['scope_contact_id'] else None, 'scene': row['scene']}
        return response


def comparison_payload(row):
    return {'comparison_id': str(row['id']), 'draft_revision': row['draft_revision'],
            'input_version': str(row['input_version']), 'input': row['input'],
            'scope': row['confirmed_scope'], **row['result'], 'valid': True}


def invalidate_comparisons(connection, owner_id, draft_ids):
    connection.execute(
        "UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,"
        "context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',"
        'result=NULL,run_token=NULL,lease_expires_at=NULL WHERE owner_id=%s AND draft_id=ANY(%s::uuid[])',
        (owner_id, draft_ids))
    connection.execute(
        "UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=%s AND draft_id=ANY(%s::uuid[]) AND action='compare'",
        (owner_id, draft_ids))


def erase_review_artifacts(connection, owner_id, draft_ids):
    """与来源清理同事务先禁用再擦正文；独立导入版本没有该依赖。"""
    relation = connection.execute("SELECT to_regclass('public.skill_review_comparison')").fetchone()
    if not (relation['to_regclass'] if isinstance(relation, dict) else relation[0]):
        return
    invalidate_comparisons(connection, owner_id, draft_ids)
    rows = connection.execute(
        'SELECT publication.version_id,version.skill_id,version.is_current FROM public.reply_skill_publication AS publication '
        'JOIN public.reply_skill_version AS version ON version.id=publication.version_id '
        'WHERE publication.owner_id=%s AND publication.draft_id=ANY(%s::uuid[]) '
        'AND version.review_origin AND NOT publication.deleted',
        (owner_id, draft_ids)).fetchall()
    def field(row, key, index):
        return row[key] if isinstance(row, dict) else row[index]
    versions = [field(row, 'version_id', 0) for row in rows]
    current_skills = [field(row, 'skill_id', 1) for row in rows if field(row, 'is_current', 2)]
    connection.execute(
        "UPDATE public.reply_skill_publication SET deleted=true,dependency_ids='{}',source_generation='{}',"
        "scope_kind='owner',scope_contact_id=NULL,scene=NULL WHERE owner_id=%s AND draft_id=ANY(%s::uuid[])",
        (owner_id, draft_ids))
    connection.execute(
        "UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=%s AND draft_id=ANY(%s::uuid[])",
        (owner_id, draft_ids))
    connection.execute(
        'UPDATE public.skill_draft SET current_comparison_id=NULL WHERE owner_id=%s AND id=ANY(%s::uuid[])',
        (owner_id, draft_ids))
    if not versions:
        return
    from notalone.persistence.skill_files import queue_skill_file_cleanup
    skill_ids = {field(row, 'skill_id', 1) for row in rows}
    for skill_id in skill_ids:
        queue_skill_file_cleanup(connection, skill_id=skill_id, version_ids={
            field(row, 'version_id', 0) for row in rows if field(row, 'skill_id', 1) == skill_id})
    connection.execute(
        "UPDATE public.reply_skill_version SET description='来源已删除',content=NULL,content_path=NULL,document_sha256=NULL,"
        "method_manifest_path=NULL,method_manifest_sha256=NULL,content_sha256=NULL,source_locator=NULL,validation_warnings='[]',"
        "enabled=false,is_current=false,status='deleted',deleted_at=now() WHERE id=ANY(%s::uuid[])", (versions,))
    connection.execute('DELETE FROM public.reply_skill_resource WHERE skill_version_id=ANY(%s::uuid[])', (versions,))
    connection.execute('UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id=ANY(%s::uuid[])', (versions,))
    connection.execute(
        "UPDATE public.reply_skill SET description='来源已删除',status='disabled',updated_at=now() "
        "WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'deleted'",
        (owner_id, current_skills))
    connection.execute('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=%s', (owner_id,))
    # 包括在其他联系人下实际使用广范围策略的历史回复与衍生工作副本。
    from notalone.persistence.reply_cleanup import delete_source_replies
    delete_source_replies(connection, owner_id=owner_id, contact_id=None,
                          removed_ids=set(versions), revoke_running_scope=False)
