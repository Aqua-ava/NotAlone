"""明确范围停用的用户决定；不改写版本，也不把普通措辞变成长期政策。"""

from uuid import UUID, uuid5

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.skill_history import PostgresSkillHistory
from notalone.persistence.skill_learning import SkillLearningNotFound
from notalone.persistence.skill_version_lineage import capture_parent_publications
from notalone.scopes import ContactScope
from notalone.skills.learning import SkillLearningInvalid, content_digest


def policy_scope(value, contact_id):
    if not isinstance(value, dict) or set(value) != {'kind', 'contact_id', 'scene'}:
        raise ValueError()
    kind, contact, scene = value['kind'], value['contact_id'], value['scene']
    if contact is not None:
        if not isinstance(contact, str) or UUID(contact) != contact_id:
            raise ValueError()
    if (kind == 'owner' and contact is None and scene is None
            or kind == 'contact' and contact is not None and scene is None
            or kind == 'scene' and isinstance(scene, str) and scene == scene.strip() and 1 <= len(scene) <= 256):
        return {'kind': kind, 'contact_id': contact, 'scene': scene}
    raise ValueError()


def _require_policy_target(
    connection, scope: ContactScope, skill_id: UUID, version_id: UUID, method_id: UUID | None,
) -> None:
    """同事务核验目标身份与完整来源，不借用包含正文的历史展示载荷。"""
    skill = connection.execute(
        "SELECT id FROM public.reply_skill WHERE owner_id=%s AND id=%s AND status<>'deleted' "
        'AND (contact_id IS NULL OR contact_id=%s)',
        (scope.owner_id, skill_id, scope.contact_id),
    ).fetchone()
    if skill is None:
        raise SkillLearningNotFound()
    version = connection.execute(
        "SELECT id,is_current FROM public.reply_skill_version WHERE skill_id=%s AND id=%s "
        "AND status='active' AND content IS NOT NULL", (skill_id, version_id),
    ).fetchone()
    if version is None:
        raise SkillLearningInvalid()
    try:
        proofs, _ = capture_parent_publications(connection, scope, {version_id})
    except SkillLearningInvalid:
        if version['is_current']:
            raise SkillLearningNotFound() from None
        raise
    if not proofs:
        raise SkillLearningInvalid()
    if method_id is None:
        return
    method = connection.execute(
        'SELECT method_id FROM public.reply_skill_method '
        'WHERE version_id=%s AND method_id=%s AND title IS NOT NULL',
        (version_id, method_id),
    ).fetchone()
    if method is not None:
        return
    # 旧本地包只有在没有细分方法身份时，才使用既有的整个策略方法身份。
    if method_id == uuid5(skill_id, 'whole_strategy') and connection.execute(
        'SELECT 1 FROM public.reply_skill_method WHERE version_id=%s AND title IS NOT NULL LIMIT 1',
        (version_id,),
    ).fetchone() is None:
        return
    raise SkillLearningInvalid()


class PostgresSkillPolicies:
    def __init__(self, database_url):
        self.database_url = database_url

    def read(self, scope):
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            PostgresSkillHistory._require_scope(connection, scope)
            return self._read(connection, scope)

    def undo(self, scope, *, policy_id, expected_revision, operation_key):
        command = {'policy_id': str(policy_id), 'revision': expected_revision, 'action': 'undo'}
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            PostgresSkillHistory._require_scope(connection, scope)
            current = self._read(connection, scope)
            previous = connection.execute('SELECT * FROM public.skill_policy_operation '
                'WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                (scope.owner_id, scope.contact_id, operation_key)).fetchone()
            if previous:
                if (previous['request_fingerprint'] != content_digest(command)
                        or previous['result_revision'] != current['revision']):
                    raise SkillLearningInvalid()
                return current
            if current['revision'] != expected_revision:
                raise SkillLearningInvalid()
            if not any(item['policy_id'] == str(policy_id) for item in current['policies']):
                raise SkillLearningNotFound()
            connection.execute('DELETE FROM public.skill_scope_policy WHERE owner_id=%s AND id=%s',
                               (scope.owner_id, policy_id))
            revision = current['revision'] + 1
            connection.execute('UPDATE public.skill_policy_state SET revision=%s WHERE owner_id=%s', (revision, scope.owner_id))
            connection.execute('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=%s', (scope.owner_id,))
            connection.execute('INSERT INTO public.skill_policy_operation(owner_id,contact_id,operation_key,request_fingerprint,result_revision) '
                'VALUES(%s,%s,%s,%s,%s)', (scope.owner_id, scope.contact_id, operation_key, content_digest(command), revision))
            return self._read(connection, scope)

    @staticmethod
    def _read(connection, scope):
        state = connection.execute('SELECT revision FROM public.skill_policy_state WHERE owner_id=%s',
                                   (scope.owner_id,)).fetchone()
        rows = connection.execute('SELECT policy.*,skill.name FROM public.skill_scope_policy AS policy '
            'JOIN public.reply_skill AS skill ON skill.id=policy.skill_id WHERE policy.owner_id=%s '
            'AND (policy.contact_id IS NULL OR policy.contact_id=%s) ORDER BY policy.id',
            (scope.owner_id, scope.contact_id)).fetchall()
        return {'revision': state['revision'] if state else 0, 'policies': [
            {'policy_id': str(row['id']), 'skill_id': str(row['skill_id']), 'name': row['name'],
             'method_id': str(row['method_id']) if row['method_id'] else None,
             'scope': {'kind': row['scope_kind'], 'contact_id': str(row['contact_id']) if row['contact_id'] else None,
                       'scene': row['scene']}, 'revision': row['revision']} for row in rows]}

    def change(self, scope, *, skill_id, version_id, method_id, scope_confirmation,
               disabled, expected_revision, operation_key):
        command = {'skill': str(skill_id), 'version': str(version_id), 'method': str(method_id) if method_id else None,
                   'scope': scope_confirmation, 'disabled': disabled, 'revision': expected_revision}
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            PostgresSkillHistory._require_scope(connection, scope)
            _require_policy_target(connection, scope, skill_id, version_id, method_id)
            current = self._read(connection, scope)
            previous = connection.execute('SELECT * FROM public.skill_policy_operation '
                'WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                (scope.owner_id, scope.contact_id, operation_key)).fetchone()
            if previous:
                if (previous['request_fingerprint'] != content_digest(command)
                        or previous['result_revision'] != current['revision']):
                    raise SkillLearningInvalid()
                return current
            if current['revision'] != expected_revision:
                raise SkillLearningInvalid()
            identity = {key: command[key] for key in ('skill', 'method', 'scope')}
            policy_id = uuid5(scope.owner_id, 'skill-policy:' + content_digest(identity))
            existing = connection.execute('SELECT 1 FROM public.skill_scope_policy WHERE owner_id=%s AND id=%s',
                                          (scope.owner_id, policy_id)).fetchone()
            changed = bool(existing) != disabled
            if changed:
                revision = current['revision'] + 1
                connection.execute('INSERT INTO public.skill_policy_state(owner_id,revision) VALUES(%s,%s) '
                    'ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision', (scope.owner_id, revision))
                if disabled:
                    connection.execute('INSERT INTO public.skill_scope_policy(id,owner_id,skill_id,method_id,scope_kind,contact_id,scene,revision) '
                        'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)', (policy_id, scope.owner_id, skill_id, method_id,
                        scope_confirmation['kind'], UUID(scope_confirmation['contact_id']) if scope_confirmation['contact_id'] else None,
                        scope_confirmation['scene'], revision))
                else:
                    connection.execute('DELETE FROM public.skill_scope_policy WHERE owner_id=%s AND id=%s',
                                       (scope.owner_id, policy_id))
                connection.execute('INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,1) '
                    'ON CONFLICT(owner_id) DO UPDATE SET revision=public.skill_library.revision+1', (scope.owner_id,))
            connection.execute('INSERT INTO public.skill_policy_operation(owner_id,contact_id,operation_key,request_fingerprint,result_revision) '
                'VALUES(%s,%s,%s,%s,%s)', (scope.owner_id, scope.contact_id, operation_key, content_digest(command),
                current['revision'] + int(changed)))
            return self._read(connection, scope)
