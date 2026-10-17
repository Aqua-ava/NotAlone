"""沿真实历史发布继承完整来源；版本切换和合并停用不改写来历。"""

from contextvars import ContextVar
from uuid import UUID

from psycopg.rows import dict_row

from notalone.scopes import ContactScope
from notalone.skills.learning import SkillLearningInvalid, content_digest


_checking_versions = ContextVar('checking_skill_version_lineage', default=frozenset())
_validated_versions = ContextVar('validated_skill_version_lineage', default=None)


def capture_parent_publications(connection, scope, identifiers):
    """只读取已存在的同Owner版本；坏映射或循环来源一律拒绝。"""
    token = _validated_versions.set(set()) if _validated_versions.get() is None else None
    try:
        return _capture_parent_publications(connection, scope, identifiers)
    finally:
        if token is not None:
            _validated_versions.reset(token)


def _capture_parent_publications(connection, scope, identifiers):
    raw = getattr(connection, 'connection', connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            'SELECT version.id,version.skill_id,version.content_sha256,version.review_origin,'
            'skill.contact_id,publication.origin_contact_id,publication.scope_kind,publication.scope_contact_id,'
            'publication.scene,publication.dependency_ids,publication.source_generation,publication.deleted '
            'FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill ON skill.id=version.skill_id '
            'LEFT JOIN public.reply_skill_publication AS publication ON publication.version_id=version.id '
            "WHERE skill.owner_id=%s AND skill.status<>'deleted' AND version.status='active' "
            'AND version.content IS NOT NULL AND version.id=ANY(%s::uuid[]) ORDER BY version.id',
            (scope.owner_id, list(identifiers))).fetchall()
    proofs, inherited, private_ancestors = [], set(), set()
    for row in rows:
        if (row['contact_id'] not in (None, scope.contact_id)
                or row['review_origin'] and row['scope_kind'] == 'contact'
                and row['scope_contact_id'] != scope.contact_id):
            private_ancestors.add(row['id'])
            continue
        dependencies = {row['id'], row['skill_id']}
        if row['review_origin']:
            if (row['deleted'] is not False or row['scope_kind'] not in ('contact', 'scene', 'owner')
                    or row['scope_kind'] == 'contact' and row['scope_contact_id'] != scope.contact_id
                    or row['id'] in _checking_versions.get()):
                raise SkillLearningInvalid()
            # 缓存仅活在这次同一事务的遍历，避免合并DAG重复核验共同前代。
            key = (id(raw), scope, row['id'], content_digest(row))
            if key not in _validated_versions.get():
                token = _checking_versions.set(_checking_versions.get() | {row['id']})
                try:
                    from notalone.persistence.skill_review_navigation import review_sources_current
                    from notalone.persistence.skill_learning import authorized_contact
                    from notalone.persistence.skill_port import _TupleReads
                    origin = ContactScope(scope.owner_id, row['origin_contact_id'])
                    if (not authorized_contact(raw, origin)
                            or not review_sources_current(_TupleReads(raw), origin, row['dependency_ids'],
                                                          row['source_generation'].get('sources', {}))):
                        raise SkillLearningInvalid()
                    _validated_versions.get().add(key)
                finally:
                    _checking_versions.reset(token)
            dependencies.update(row['dependency_ids'])
        publication_scope = {'kind': row['scope_kind'] or ('contact' if row['contact_id'] else 'owner'),
            'contact_id': str(row['scope_contact_id'] or row['contact_id']) if row['scope_contact_id'] or row['contact_id'] else None,
            'scene': row['scene']}
        proofs.append({'skill_id': str(row['skill_id']), 'version_id': str(row['id']),
                       'sha256': content_digest(row), 'scope': publication_scope,
                       'dependencies': sorted(str(value) for value in dependencies)})
        inherited.update(dependencies)
    # 扩大范围的新版已在原取材范围递归核验祖先；祖先不会因此成为当前联系人的目标。
    if private_ancestors - inherited:
        raise SkillLearningInvalid()
    return proofs, inherited
