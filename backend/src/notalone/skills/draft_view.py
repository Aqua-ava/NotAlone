"""审核隔离的只读 SkillPort；草稿从不进入已发布目录。"""

from uuid import UUID

from notalone.skills.models import SkillCatalog, SkillCatalogEntry, SkillVersion


class ReadOnlyDraftSkillPort:
    def __init__(self, *, scope, draft, comparison, validate, execution=None):
        self.scope, self.draft, self.comparison, self.validate = scope, draft, comparison, validate
        self.execution = execution

    def catalog(self, scope):
        self._require_scope(scope)
        strategy = self.draft['sanitized_strategy']
        return SkillCatalog(scope=scope, revision=self.comparison['library_revision'], entries=(
            SkillCatalogEntry(skill_id=UUID(self.draft['logical_skill_id']), version_id=self.comparison['id'],
                name=strategy['name'], description=self._value('version_description', 'description'), owner_id=scope.owner_id,
                contact_id=scope.contact_id, applicable_scenes=(self.comparison['input']['scene'],)),))

    def load_version(self, scope, version_id):
        self._require_scope(scope)
        if version_id != self.comparison['id']:
            raise PermissionError('审核版本不可用。')
        strategy = self.draft['sanitized_strategy']
        return SkillVersion(owner_id=scope.owner_id, contact_id=scope.contact_id,
            skill_id=UUID(self.draft['logical_skill_id']), version_id=version_id,
            name=strategy['name'], description=self._value('version_description', 'description'),
            content=self._value('version_content', 'document'), enabled=True,
            execution_view=self.execution['_execution_view'] if self.execution else None)

    def _value(self, projected, original):
        return self.execution[projected] if self.execution else self.draft['sanitized_strategy'][original]

    def load_resource(self, scope, version_id, relative_path):
        self._require_scope(scope)
        raise PermissionError('草稿没有获准的辅助资源。')

    def _require_scope(self, scope):
        if scope != self.scope:
            raise PermissionError('审核范围不匹配。')
        self.validate()
