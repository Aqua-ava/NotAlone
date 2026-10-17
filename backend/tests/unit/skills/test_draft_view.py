"""隔离审核视图在只读SkillPort边界验证范围、来源与版本身份。"""

import unittest
from uuid import uuid4

from notalone.scopes import ContactScope
from notalone.skills.draft_view import ReadOnlyDraftSkillPort
from notalone.skills.learning import SkillLearningInvalid


class DraftViewTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.deleted = False
        self.comparison = {'id': uuid4(), 'library_revision': 4, 'input': {'scene': '核对安排'}}
        self.draft = {'logical_skill_id': str(uuid4()), 'sanitized_strategy': {
            'name': 'clarify-first', 'description': '核对含义后作答', 'document': '先区分已知与推测。'}}
        def check_sources():
            if self.deleted:
                raise SkillLearningInvalid()
        self.port = ReadOnlyDraftSkillPort(scope=self.scope, draft=self.draft,
                                          comparison=self.comparison, validate=check_sources)

    def test_draft_has_only_an_isolated_version_and_cannot_load_other_content(self):
        catalog = self.port.catalog(self.scope)
        self.assertEqual([entry.name for entry in catalog.entries], ['clarify-first'])
        version = self.port.load_version(self.scope, catalog.entries[0].version_id)
        self.assertEqual(version.content, '先区分已知与推测。')
        self.assertEqual(version.resource_paths, ())
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, uuid4())
        with self.assertRaises(PermissionError):
            self.port.load_resource(self.scope, version.version_id, 'references/private.txt')
        with self.assertRaises(PermissionError):
            self.port.catalog(ContactScope(self.scope.owner_id, uuid4()))

    def test_deleted_source_blocks_catalog_and_late_document_load(self):
        version_id = self.port.catalog(self.scope).entries[0].version_id
        self.deleted = True
        with self.assertRaises(SkillLearningInvalid):
            self.port.catalog(self.scope)
        with self.assertRaises(SkillLearningInvalid):
            self.port.load_version(self.scope, version_id)
