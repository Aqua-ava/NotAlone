"""已确认联系人中的版本查看与显式回滚；权威状态和无正文回执同事务。"""

from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.skill_learning import authorized_contact, SkillLearningNotFound
from notalone.persistence.skill_library import PostgresSkillLibrary, SkillVersionNotFoundError, SkillDeletedError
from notalone.persistence.skill_version_lineage import capture_parent_publications
from notalone.skills.learning import SkillLearningInvalid, content_digest


class PostgresSkillHistory:
    def __init__(self, database_url):
        self.database_url = database_url

    def read(self, scope, skill_id=None):
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            self._require_scope(connection, scope)
            if skill_id is not None:
                return self._history(connection, scope, skill_id)
            rows = connection.execute(
                "SELECT id FROM public.reply_skill WHERE owner_id=%s AND status<>'deleted' "
                'AND (contact_id IS NULL OR contact_id=%s) ORDER BY name,id', (scope.owner_id, scope.contact_id)).fetchall()
            skills = []
            for row in rows:
                try:
                    skills.append(self._history(connection, scope, row['id']))
                except SkillLearningNotFound:
                    continue
            return {'skills': skills}

    def rollback(self, scope, *, skill_id, version_id, expected_revision, expected_current_version_id, operation_key):
        command = {'skill_id': str(skill_id), 'version_id': str(version_id), 'revision': expected_revision,
                   'current': str(expected_current_version_id) if expected_current_version_id else None}
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            self._require_scope(connection, scope)
            history = self._history(connection, scope, skill_id)
            if not any(item['version_id'] == str(version_id) for item in history['versions']):
                raise SkillLearningInvalid()
            previous = connection.execute(
                'SELECT * FROM public.skill_history_operation WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                (scope.owner_id, scope.contact_id, operation_key)).fetchone()
            if previous is not None:
                if (previous['request_fingerprint'] != content_digest(command)
                        or previous['result_revision'] != history['revision']
                        or history['current_version_id'] != str(previous['version_id'])):
                    raise SkillLearningInvalid()
                return history
            if history['revision'] != expected_revision or history['current_version_id'] != command['current']:
                raise SkillLearningInvalid()
            try:
                result = PostgresSkillLibrary(self.database_url).rollback_locked(
                    connection, scope.owner_id, skill_id, version_id, scope=scope)
            except (SkillVersionNotFoundError, SkillDeletedError):
                raise SkillLearningInvalid() from None
            connection.execute(
                'INSERT INTO public.skill_history_operation(owner_id,contact_id,operation_key,skill_id,version_id,request_fingerprint,result_revision) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (scope.owner_id, scope.contact_id, operation_key, skill_id, version_id, content_digest(command), result.revision))
            return self._history(connection, scope, skill_id)

    @staticmethod
    def _require_scope(connection, scope):
        if not authorized_contact(connection, scope):
            raise SkillLearningNotFound()

    @staticmethod
    def _history(connection, scope, skill_id):
        skill = connection.execute(
            "SELECT id,name,status FROM public.reply_skill WHERE owner_id=%s AND id=%s AND status<>'deleted' "
            'AND (contact_id IS NULL OR contact_id=%s)', (scope.owner_id, skill_id, scope.contact_id)).fetchone()
        if skill is None:
            raise SkillLearningNotFound()
        rows = connection.execute(
            'SELECT version.id,version.version_number,version.is_current,version.enabled,'
            'version.review_origin,publication.scope_kind,publication.scope_contact_id,publication.scene '
            'FROM public.reply_skill_version AS version LEFT JOIN public.reply_skill_publication AS publication '
            'ON publication.version_id=version.id WHERE version.skill_id=%s AND version.status=\'active\' '
            'AND version.content IS NOT NULL ORDER BY version.version_number DESC', (skill_id,)).fetchall()
        versions, current = [], None
        for row in rows:
            try:
                proofs, dependencies = capture_parent_publications(connection, scope, {row['id']})
                if not proofs:
                    continue
            except SkillLearningInvalid:
                if row['is_current']:
                    raise SkillLearningNotFound() from None
                continue
            # 完整范围与来源核验通过后，才读取该合法历史版本的正文。
            body = connection.execute(
                'SELECT content FROM public.reply_skill_version WHERE id=%s AND skill_id=%s '
                "AND status='active' AND content IS NOT NULL", (row['id'], skill_id)).fetchone()
            if body is None:
                if row['is_current']:
                    raise SkillLearningNotFound()
                continue
            methods = connection.execute(
                'SELECT method_id,title,instruction,replaces_method_ids,mapping_state FROM public.reply_skill_method '
                'WHERE version_id=%s AND title IS NOT NULL ORDER BY ordinal', (row['id'],)).fetchall()
            versions.append({'version_id': str(row['id']), 'version_number': row['version_number'],
                'document': body['content'], 'is_current': row['is_current'], 'enabled': row['enabled'],
                'scope': {'kind': row['scope_kind'] or 'owner',
                          'contact_id': str(row['scope_contact_id']) if row['scope_contact_id'] else None, 'scene': row['scene']},
                'methods': [{'method_id': str(item['method_id']), 'title': item['title'], 'instruction': item['instruction'],
                             'replaces_method_ids': [str(value) for value in item['replaces_method_ids']],
                             'mapping_state': item['mapping_state']} for item in methods],
                'source_dependency_count': len(dependencies)})
            if row['is_current']:
                current = str(row['id'])
        if not versions:
            raise SkillLearningNotFound()
        revision = connection.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s', (scope.owner_id,)).fetchone()
        return {'skill_id': str(skill_id), 'name': skill['name'], 'status': skill['status'],
                'revision': revision['revision'] if revision else 0, 'current_version_id': current, 'versions': versions}
