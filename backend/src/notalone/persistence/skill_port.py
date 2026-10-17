"""按已验证联系人与显式场景只读不可变回复策略。"""

from uuid import UUID

import psycopg
from psycopg.rows import dict_row, tuple_row

from notalone.scopes import ContactScope
from notalone.skills.models import SkillCatalog, SkillCatalogEntry, SkillResource, SkillVersion, validate_resource_relative_path
from notalone.persistence.skill_execution_view import project_skill_metadata, project_skill_version


class SkillPortPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或策略正文的读取失败。"""


class _TupleReads:
    """复用同一事务的来源核验，隔离调用方的行投影形式。"""
    def __init__(self, connection):
        self.connection = connection

    def execute(self, query, params=None):
        return self.connection.cursor(row_factory=tuple_row).execute(query, params)

    def cursor(self, **kwargs):
        return self.connection.cursor(**kwargs)


def require_review_publication(connection, scope, row, scene):
    """审核来源标记缺少元数据时拒绝；广范围策略仍复验原联系人来源。"""
    if not row['review_origin']:
        return
    connection = _TupleReads(connection)
    from notalone.persistence.skill_review_navigation import review_sources_current
    if (row['publication_deleted'] is not False or row['publication_owner_id'] != scope.owner_id
            or row['scope_kind'] == 'contact' and row['scope_contact_id'] != scope.contact_id
            or row['scope_kind'] == 'scene' and row['scene'] != scene
            or row['scope_kind'] not in ('owner', 'contact', 'scene')):
        raise PermissionError('Skill 当前范围不可用。')
    origin = ContactScope(scope.owner_id, row['origin_contact_id'])
    if not review_sources_current(connection, origin, row['dependency_ids'], row['source_generation'].get('sources', {})):
        raise PermissionError('Skill 来源已变化。')


_VERSION_COLUMNS = """
SELECT skill.id AS skill_id,skill.owner_id AS skill_owner_id,
       skill.contact_id AS skill_contact_id,skill.name AS skill_name,
       skill.description AS skill_description,version.id AS version_id,
       version.name AS version_name,version.description AS version_description,
       version.version_number,version.enabled AS version_enabled,
       version.review_origin,publication.owner_id AS publication_owner_id,
       publication.origin_contact_id,publication.scope_kind,publication.scope_contact_id,
       publication.scene,publication.dependency_ids,publication.source_generation,
       publication.deleted AS publication_deleted
"""
_VERSION_SCOPE = """
FROM public.reply_skill AS skill
JOIN public.reply_skill_version AS version ON version.skill_id=skill.id
LEFT JOIN public.reply_skill_publication AS publication ON publication.version_id=version.id
WHERE skill.owner_id=%s AND (skill.contact_id IS NULL OR skill.contact_id=%s)
  AND skill.status='active' AND version.status='active' AND version.enabled AND version.is_current
  AND version.content IS NOT NULL AND length(btrim(version.content))>0 AND version.name=skill.name
  AND (NOT version.review_origin OR (publication.owner_id=skill.owner_id AND NOT publication.deleted
       AND (publication.scope_kind='owner'
            OR publication.scope_kind='contact' AND publication.scope_contact_id=%s
            OR publication.scope_kind='scene' AND publication.scene=%s)))
"""
_VERSION_QUERY = _VERSION_COLUMNS + _VERSION_SCOPE
_VERSION_CONTENT_QUERY = _VERSION_COLUMNS + ',version.content AS version_content\n' + _VERSION_SCOPE


def _selected_projection(connection, scope, row, scene):
    """来源许可已通过后，仅为实际选中版本读取必要正文并构造执行视图。"""
    metadata = project_skill_metadata(connection, scope, row, scene)
    if not metadata['_policy_filtered']:
        with connection.cursor(row_factory=dict_row) as cursor:
            body = cursor.execute('SELECT content FROM public.reply_skill_version WHERE id=%s',
                                  (row['version_id'],)).fetchone()
        if body is None:
            raise PermissionError('Skill 正文不可用。')
        row = {**row, 'version_content': body['content']}
    return project_skill_version(connection, scope, row, scene)


def require_reply_skill_current(connection, context, skill):
    """最终候选事务内复验实际版本、范围、来源和目录修订，阻止迟到提交。"""
    if skill is None:
        return
    from notalone.reply.errors import ReplyInputInvalidatedError
    scope = context.scope
    with connection.cursor(row_factory=dict_row) as cursor:
        revision = cursor.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s', (scope.owner_id,)).fetchone()
        row = cursor.execute(_VERSION_QUERY + ' AND version.id=%s',
            (scope.owner_id, scope.contact_id, scope.contact_id, context.command.scene, skill.version_id)).fetchone()
    if (revision is None or revision['revision'] != context.skill_library_revision or row is None
            or row['skill_id'] != skill.skill_id or row['version_name'] != skill.name):
        raise ReplyInputInvalidatedError('实际Skill版本或范围已变化，请保留编辑并重新生成。')
    try:
        require_review_publication(connection, scope, row, context.command.scene)
        projected = _selected_projection(connection, scope, row, context.command.scene)
        current = projected['_execution_view']
        if ((skill.execution_view is not None or current.policy_revision > 0)
                and skill.execution_view != current):
            raise PermissionError('Skill执行视图已改变。')
    except PermissionError:
        raise ReplyInputInvalidatedError('实际Skill来源或范围已变化，请保留编辑并重新生成。') from None


class PostgresSkillPort:
    """每次目录、正文与资源读取都执行相同范围门禁；不修改业务状态。"""

    def __init__(self, database_url: str, *, scene: str | None = None):
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError('database_url 不能为空。')
        if scene is not None and (not isinstance(scene, str) or not scene.strip()
                                  or len(scene) > 256 or scene != scene.strip()):
            raise ValueError('显式场景无效。')
        self._database_url, self._scene = database_url, scene

    def for_scene(self, scene):
        return PostgresSkillPort(self._database_url, scene=scene)

    def catalog(self, scope):
        self._validate_scope(scope)
        try:
            with self._connect() as connection:
                connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                revision = connection.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s', (scope.owner_id,)).fetchone()
                with connection.cursor(row_factory=dict_row) as cursor:
                    rows = cursor.execute(_VERSION_QUERY + ' ORDER BY skill.contact_id NULLS FIRST,version.name,version.id',
                                          self._params(scope)).fetchall()
                entries = []
                for row in rows:
                    try:
                        require_review_publication(connection, scope, row, self._scene)
                        row = project_skill_metadata(connection, scope, row, self._scene)
                    except PermissionError:
                        continue
                    entries.append(self._entry(row))
                return SkillCatalog(scope, revision[0] if revision else 0, tuple(entries))
        except psycopg.Error:
            raise SkillPortPersistenceError('Skill 目录读取失败。') from None
        except (TypeError, ValueError):
            raise SkillPortPersistenceError('Skill 目录读取失败。') from None

    def load_version(self, scope, version_id):
        self._validate_scope(scope)
        if not isinstance(version_id, UUID):
            raise TypeError('version_id 必须是 UUID。')
        try:
            with self._connect() as connection:
                connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                row = self._version(connection, scope, version_id, include_content=True)
                paths = () if row['_policy_filtered'] else self._resource_paths(connection, version_id)
                return SkillVersion(owner_id=scope.owner_id, contact_id=self._contact(row),
                    skill_id=row['skill_id'], version_id=version_id, name=row['version_name'],
                    description=row['version_description'], content=row['version_content'], enabled=True,
                    resource_paths=paths, version_number=row['version_number'],
                    scope_kind=row['scope_kind'] or ('contact' if row['skill_contact_id'] else 'owner'),
                    scope_scene=row['scene'], execution_view=row['_execution_view'])
        except psycopg.Error:
            raise SkillPortPersistenceError('Skill 正文读取失败。') from None

    def load_resource(self, scope, version_id, relative_path):
        self._validate_scope(scope)
        if not isinstance(version_id, UUID):
            raise TypeError('version_id 必须是 UUID。')
        try:
            validate_resource_relative_path(relative_path)
        except (TypeError, ValueError):
            raise PermissionError('Skill 资源不可用。') from None
        try:
            with self._connect() as connection:
                connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                version = self._version(connection, scope, version_id)
                if version['_policy_filtered']:
                    raise PermissionError('筛选后的执行视图不允许重读未分离资源。')
                with connection.cursor(row_factory=dict_row) as cursor:
                    row = cursor.execute(
                        "SELECT resource_kind,media_type,content_sha256,content FROM public.reply_skill_resource "
                        "WHERE skill_version_id=%s AND relative_path=%s AND resource_kind IN ('reference','asset') AND content IS NOT NULL",
                        (version_id, relative_path)).fetchone()
                if row is None:
                    raise PermissionError('Skill 资源不可用。')
                return SkillResource(owner_id=scope.owner_id, contact_id=self._contact(version),
                    skill_id=version['skill_id'], version_id=version_id, relative_path=relative_path,
                    resource_kind=row['resource_kind'], media_type=row['media_type'], content=bytes(row['content']),
                    content_sha256=row['content_sha256'])
        except PermissionError:
            raise PermissionError('Skill 资源不可用。') from None
        except psycopg.Error:
            raise SkillPortPersistenceError('Skill 资源读取失败。') from None

    def _version(self, connection, scope, version_id, *, include_content=False):
        with connection.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(_VERSION_QUERY + ' AND version.id=%s', (*self._params(scope), version_id)).fetchone()
        if row is None:
            raise PermissionError('Skill 不可用。')
        require_review_publication(connection, scope, row, self._scene)
        if not include_content:
            return project_skill_metadata(connection, scope, row, self._scene)
        return _selected_projection(connection, scope, row, self._scene)

    def _params(self, scope):
        return scope.owner_id, scope.contact_id, scope.contact_id, self._scene

    @staticmethod
    def _contact(row):
        return row['scope_contact_id'] if row['review_origin'] else row['skill_contact_id']

    @classmethod
    def _entry(cls, row):
        if row['skill_name'] != row['version_name'] or row['skill_description'] != row['version_description']:
            raise ValueError('Skill 目录元数据不一致。')
        return SkillCatalogEntry(skill_id=row['skill_id'], version_id=row['version_id'],
            name=row['version_name'], description=row['version_description'], owner_id=row['skill_owner_id'],
            contact_id=cls._contact(row), version_number=row['version_number'],
            applicable_scenes=(row['scene'],) if row['scene'] else ())

    @staticmethod
    def _resource_paths(connection, version_id):
        return tuple(row[0] for row in connection.execute(
            "SELECT relative_path FROM public.reply_skill_resource WHERE skill_version_id=%s "
            "AND resource_kind IN ('reference','asset') AND content IS NOT NULL ORDER BY relative_path", (version_id,)).fetchall())

    def _connect(self):
        return psycopg.connect(self._database_url)

    @staticmethod
    def _validate_scope(scope):
        if not isinstance(scope, ContactScope):
            raise TypeError('scope 必须是 ContactScope。')
