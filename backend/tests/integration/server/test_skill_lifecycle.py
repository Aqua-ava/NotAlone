"""公开审核更新、合并和合法历史回滚；仅使用合成模型与独立数据库。"""

import time
import json
import os
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4, uuid5

import psycopg
from langchain_core.messages import HumanMessage

from tests.integration.server import test_skill_review as review, test_skill_learning as learning
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, tool_response
from tests.integration.persistence.concurrency import wait_for_blocked_operations


class SkillLifecycleHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = learning.ControlledLearningModel
    reply_model_factory = review.SkillReviewModel
    _bind = learning.SkillLearningHttpTest._bind
    _configure = learning.SkillLearningHttpTest._configure
    _discussion = learning.SkillLearningHttpTest._discussion
    _wait_learning = learning.SkillLearningHttpTest._wait_learning
    _delete_source = learning.SkillLearningHttpTest._delete_source
    _source_message = review.SkillReviewHttpTest._source_message
    _draft_for_review = review.SkillReviewHttpTest._draft_for_review
    _compare = review.SkillReviewHttpTest._compare
    _extra_review_memory = review.SkillReviewHttpTest._extra_review_memory
    _approve = review.SkillReviewHttpTest._approve
    _assert_physical_review_erasure = review.SkillReviewHttpTest._assert_physical_review_erasure

    def setUp(self):
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id, self.second_contact_id):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成版本联系人')",
                                   (identifier, self.owner_id))
        self.path = f'/api/contacts/{self.contact_id}/skill-learning'

    def _next_draft(self, targets, methods, *, kind='update', target_message=None):
        seen = {draft['draft_id'] for draft in self._get(self.backend, self.path)['drafts']}
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',
            learning.synthetic_proposal(kind=kind, targets=targets, replaces=methods)))
        _, material = self._discussion(correction='合成更新纠正：先说明边界，再核对含义。', target=target_message)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            state = self._get(self.backend, self.path)
            for draft in state['drafts']:
                if draft['draft_id'] not in seen and any(item['material_id'] == material
                        for item in draft['private_evidence']['materials']):
                    return self.path + '/drafts/' + draft['draft_id'], draft
            time.sleep(.02)
        self.fail('明确更新材料未形成对应新草稿。')

    def _import(self, name='careful-response'):
        package = Path(self.temporary.name) / name
        package.mkdir(exist_ok=True)
        (package / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: 合成原有教学策略\n---\n\n合成旧方法：先问清楚再回应。\n')
        return self._get_import(package)

    def _get_import(self, package):
        status, result = self.backend.request('/api/skills/import', {'package_path': str(package)})
        self.assertEqual(status, 200, result)
        return result['skill_id']

    def test_file_backed_history_remains_readable_without_database_document(self):
        self._bind(self.contact_id)
        skill = self._import()
        # 迁移后的数据库只保留版本身份；历史查看必须读取已发布文件。
        with psycopg.connect(self.database_url) as connection:
            connection.execute('UPDATE public.reply_skill_version SET content=NULL WHERE skill_id=%s', (UUID(skill),))
        history = self._get(self.backend, self.path + '/skills/' + skill)
        self.assertEqual(len(history['versions']), 1)
        self.assertIn('合成旧方法：先问清楚再回应。', history['versions'][0]['document'])
        self.assertEqual(self.other_backend.request(self.path + '/skills/' + skill)[0], 404)

    def test_source_deletion_removes_published_working_directory_and_version_files_before_discovery(self):
        root = Path(self.temporary.name) / 'published-skills'
        with patch.dict(os.environ, {'NOTALONE_SKILLS_DIR': str(root)}):
            path, draft, _, source = self._draft_for_review(with_source=True)
            compared, _ = self._compare(path, draft, kind='owner')
            published, _ = self._approve(path, compared)
            skill = published['published']['skill_id']
            self._get(self.backend, '/api/skills')
            working = root / str(self.owner_id) / 'careful-response'
            snapshots = root / '.versions' / str(self.owner_id) / skill
            self.assertTrue((working / 'SKILL.md').is_file())
            self.assertTrue(list(snapshots.rglob('SKILL.md')))
            self._delete_source(source)
            self.assertFalse(working.exists(), '删除完成前必须清理可扫描工作目录。')
            self.assertEqual(list(snapshots.rglob('SKILL.md')), [], '不可变历史也属于删除闭包。')
            self.assertEqual(self.backend.request(path)[0], 409)
            # 自动扫描不会将来源删除的目录重新启用。
            catalog = self._get(self.backend, '/api/skills')['skills']
            self.assertFalse(any(item['skill_id'] == skill and item['status'] == 'active' for item in catalog))

    def test_memory_deletion_erases_dependent_skill_files_before_returning(self):
        root = Path(self.temporary.name) / 'memory-dependent-skills'
        with patch.dict(os.environ, {'NOTALONE_SKILLS_DIR': str(root)}):
            path, draft, _, _ = self._draft_for_review()
            _, _, memory = self._extra_review_memory('对方偏好先说明自己的想法。合成 Skill 审核背景。')
            compared, _ = self._compare(path, draft, kind='owner')
            published, _ = self._approve(path, compared)
            skill = published['published']['skill_id']
            self._get(self.backend, '/api/skills')
            working = root / str(self.owner_id) / 'careful-response'
            snapshots = root / '.versions' / str(self.owner_id) / skill
            self.assertTrue((working / 'SKILL.md').is_file())
            self.assertTrue(list(snapshots.rglob('SKILL.md')))
            status, result = self.backend.request(
                f'/api/contacts/{self.contact_id}/memories/{memory}/delete', {})
            self.assertEqual(status, 200, result)
            self.assertFalse(working.exists(), '记忆删除返回前必须擦除派生 Skill 的工作目录。')
            self.assertEqual(list(snapshots.rglob('SKILL.md')), [], '记忆删除不能留下可恢复的策略历史。')

    def test_shared_memory_transaction_rollback_preserves_published_skill_files(self):
        from contextlib import nullcontext
        from psycopg.rows import dict_row
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope

        root = Path(self.temporary.name) / 'shared-memory-skills'
        with patch.dict(os.environ, {'NOTALONE_SKILLS_DIR': str(root)}):
            path, draft, _, _ = self._draft_for_review()
            _, _, memory = self._extra_review_memory('对方偏好先说明自己的想法。合成共享事务背景。')
            compared, _ = self._compare(path, draft, kind='owner')
            published, _ = self._approve(path, compared)
            self._get(self.backend, '/api/skills')
            working = root / str(self.owner_id) / 'careful-response' / 'SKILL.md'
            snapshots = root / '.versions' / str(self.owner_id) / published['published']['skill_id']
            self.assertTrue(working.is_file())
            with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                shared = PostgresMemoryStore(self.database_url, connection_factory=lambda: nullcontext(connection))
                shared.delete(scope=ContactScope(self.owner_id, self.contact_id), memory_id=UUID(memory))
                self.assertTrue(working.is_file(), '共享事务尚未提交时只能登记清理。')
                connection.rollback()
            self.assertTrue(working.is_file())
            self.assertTrue(list(snapshots.rglob('SKILL.md')))
            history = self._get(self.backend, self.path + '/skills/' + published['published']['skill_id'])
            self.assertEqual(history['current_version_id'], published['published']['version_id'])

    def test_update_history_rollback_is_scoped_idempotent_and_cannot_enable_disabled_skill(self):
        self._bind(self.contact_id)
        skill = self._import()
        self.assertEqual(self._configure()[0][0], 200)
        path, draft = self._next_draft([skill], [str(uuid5(UUID(skill), 'whole_strategy'))])
        compared, _ = self._compare(path, draft)
        published, _ = self._approve(path, compared)
        history_path = self.path + '/skills/' + skill
        history = self._get(self.backend, history_path)
        self.assertEqual([item['version_number'] for item in history['versions']], [2, 1])
        self.assertIn('合成旧方法', history['versions'][1]['document'])
        self.assertEqual(history['versions'][0]['scope']['kind'], 'contact')
        command = {'version_id': history['versions'][1]['version_id'], 'expected_revision': history['revision'],
                   'expected_current_version_id': published['published']['version_id'], 'operation_key': str(uuid4())}
        status, result = self.backend.request(history_path + '/rollback', command)
        self.assertEqual(status, 200, result)
        self.assertTrue(result['versions'][1]['is_current'])
        self.assertEqual(self.backend.request(history_path + '/rollback', command), (200, result))
        self.assertEqual(self._get(self._production_backend(self.owner_id), history_path), result)
        self.assertEqual(self.backend.request(f'/api/skills/{skill}/disable', {})[0], 200)
        self.assertEqual(self.backend.request(history_path + '/rollback', command)[0], 409)
        # 原管理入口也不能通过回滚撤销停用；只有明确enable才能恢复。
        status, _ = self.backend.request(f'/api/skills/{skill}/rollback', {'version_id': published['published']['version_id']})
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in self._get(self.backend, '/api/skills')['skills']
                              if item['skill_id'] == skill)['status'], 'disabled')

    def test_update_inherits_target_extra_review_sources_before_any_read(self):
        path, draft, _, _ = self._draft_for_review()
        old_text = '对方偏好先说明自己的想法。合成旧版审核额外背景。'
        source, message, memory_id = self._extra_review_memory(old_text)
        compared, _ = self._compare(path, draft, kind='owner')
        payload = json.loads(next(item.content for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage)))
        self.assertIn(memory_id, [item['evidence_id'] for item in payload['evidence']
                                 if item['kind'] == 'confirmed_memory'])
        first, _ = self._approve(path, compared)
        skill = first['published']['skill_id']
        updated_path, updated = self._next_draft([skill], [str(uuid5(UUID(skill), 'method:clarify'))])
        newer_ids = {
            self._extra_review_memory(
                f'对方偏好说明自己的想法，合成审核情境：怎样说明自己的想法？说明想法，不作额外承诺，核对安排。合成新版背景{index}。'
            )[2] for index in range(5)
        }
        # 更相关的五条记忆占满检索预算；新版只能经目标发布来历继承旧版来源。
        compared, _ = self._compare(updated_path, updated, kind='owner')
        payload = json.loads(next(item.content for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage)))
        self.assertEqual(newer_ids, {item['evidence_id'] for item in payload['evidence']
                                    if item['kind'] == 'confirmed_memory'})
        for old_value in (old_text, str(source), str(message), memory_id):
            self.assertNotIn(old_value, str(payload))
        second, _ = self._approve(updated_path, compared)
        from notalone.application.source_service import SourceService
        with patch.object(SourceService, '_start', return_value=None):
            status, queued = self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')
            self.assertEqual((status, queued['status']), (202, 'queued'))
        status, reply = self.backend.request('/api/reply/generate', {
            'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成继承来源的新版实际使用'},
            'skill_version_id': second['published']['version_id']})
        self.assertEqual(status, 200, reply)
        self.assertIsNone(reply['used_skill'], '旧版额外来源已排队删除，新版不能通过换版本继续加载。')
        self.assertEqual(self.backend.request(f'/api/skills/{skill}/preview')[0], 404)
        self._delete_source(source)
        self._assert_physical_review_erasure(updated['draft_id'], second['published']['version_id'])

    def test_owner_parent_can_be_merged_from_another_contact_without_reading_origin_materials(self):
        self._wide_parent_update('owner')

    def test_scene_parent_can_be_updated_from_another_contact_without_reading_origin_materials(self):
        self._wide_parent_update('scene')

    def test_explicitly_widened_parent_keeps_private_ancestor_scoped_while_allowing_another_contact_merge(self):
        self._wide_parent_update('owner', narrow_ancestor=True)

    def _wide_parent_update(self, kind, *, narrow_ancestor=False):
        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft, kind='contact' if narrow_ancestor else kind)
        first, _ = self._approve(path, compared)
        skill, version = first['published']['skill_id'], first['published']['version_id']
        if narrow_ancestor:
            path, draft = self._next_draft([skill], [str(uuid5(UUID(skill), 'method:clarify'))])
            compared, _ = self._compare(path, draft, kind=kind)
            first, _ = self._approve(path, compared)
            version = first['published']['version_id']
        origin_contact, origin_path = self.contact_id, self.path
        self.contact_id, self.path = self.second_contact_id, f'/api/contacts/{self.second_contact_id}/skill-learning'
        self._bind(self.contact_id)
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        session_path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        status, reply = self.backend.request(session_path + '/replies', {
            'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()), 'scene': '核对安排',
            'content': {'type': 'rewrite_draft', 'draft_text': '合成另一联系人的表达'},
            'skill_version_id': version})
        self.assertEqual(status, 200, reply)
        self.assertIsNotNone(reply['used_skill'])
        targets, methods = [skill], [str(uuid5(UUID(skill), 'method:clarify'))]
        if kind == 'owner':
            secondary = self._import('calm-response')
            targets.append(secondary)
            methods.append(str(uuid5(UUID(secondary), 'whole_strategy')))
        self.assertEqual(self._configure()[0][0], 200)
        updated_path, updated = self._next_draft(targets, methods, kind='merge' if kind == 'owner' else 'update')
        payload = json.loads(next(item.content for item in self.extraction_model.seen_calls[-1]
                                  if isinstance(item, HumanMessage)))
        self.assertEqual(next(item for item in payload['existing_skills'] if item['skill_id'] == skill)['scope']['kind'], kind)
        materials = json.dumps(payload['materials'], ensure_ascii=False)
        self.assertNotIn('合成私密来话', materials)
        self.assertNotIn(str(source), materials)
        self.assertNotIn(str(origin_contact), materials)
        self.assertTrue(any(version in item['dependency_ids'] for item in payload['materials']),
                        '另一联系人实际使用的历史版本须能成为学习依据。')
        compared, _ = self._compare(updated_path, updated, kind=kind)
        second, _ = self._approve(updated_path, compared)
        self.contact_id, self.path = origin_contact, origin_path
        self._delete_source(source)
        self._assert_physical_review_erasure(updated['draft_id'], second['published']['version_id'])
        restored = self._production_backend(self.owner_id)
        self.assertNotIn(second['published']['version_id'], json.dumps(
            self._get(restored, f'/api/contacts/{self.second_contact_id}/skill-learning')))

    def test_merge_preserves_exact_targets_mapping_and_rollback_does_not_enable_other_target(self):
        self._bind(self.contact_id)
        targets = [self._import(name) for name in ('careful-response', 'calm-response')]
        self.assertEqual(self._configure()[0][0], 200)
        source, message = self._source_message()
        methods = [str(uuid5(UUID(item), 'whole_strategy')) for item in targets]
        path, draft = self._next_draft(targets, methods, kind='merge', target_message=message)
        self.assertTrue(all(len(self._get(self.backend, f'/api/skills/{item}/versions')['versions']) == 1 for item in targets))
        compared, _ = self._compare(path, draft, kind='owner')
        published, approve = self._approve(path, compared)
        self.assertEqual(self.backend.request(path + '/approve', approve), (200, published))
        history_path = self.path + '/skills/' + targets[0]
        history = self._get(self._production_backend(self.owner_id), history_path)
        self.assertEqual(set(history['versions'][0]['methods'][0]['replaces_method_ids']), set(methods))
        self.assertEqual(history['versions'][0]['methods'][0]['mapping_state'], 'confirmed')
        old = history['versions'][1]['version_id']
        status, result = self.backend.request(history_path + '/rollback', {'version_id': old,
            'expected_revision': history['revision'], 'expected_current_version_id': history['current_version_id'],
            'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        self.assertEqual(next(item for item in self._get(self.backend, '/api/skills')['skills']
                              if item['skill_id'] == targets[1])['status'], 'disabled')
        self._delete_source(source)
        # 原导入版本独立有效，删除新版来源不抹掉合法旧版本，也不能恢复被删除的新版本。
        history = self._get(self.backend, history_path)
        self.assertEqual([item['version_id'] for item in history['versions']], [old])
        self.assertEqual(self.backend.request(history_path + '/rollback', {
            'version_id': published['published']['version_id'], 'expected_revision': history['revision'],
            'expected_current_version_id': old, 'operation_key': str(uuid4())})[0], 409)
        self._assert_physical_review_erasure(draft['draft_id'], published['published']['version_id'])

    def test_deleted_current_can_choose_independent_old_version_while_remaining_disabled(self):
        self._bind(self.contact_id)
        skill = self._import()
        self.assertEqual(self._configure()[0][0], 200)
        source, message = self._source_message()
        path, draft = self._next_draft([skill], [str(uuid5(UUID(skill), 'whole_strategy'))], target_message=message)
        compared, _ = self._compare(path, draft)
        published, _ = self._approve(path, compared)
        self._delete_source(source)
        history_path = self.path + '/skills/' + skill
        history = self._get(self.backend, history_path)
        self.assertIsNone(history['current_version_id'])
        self.assertEqual(history['status'], 'disabled')
        old = history['versions'][0]['version_id']
        status, result = self.backend.request(history_path + '/rollback', {'version_id': old,
            'expected_revision': history['revision'], 'expected_current_version_id': None, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['status'], 'disabled')
        self.assertEqual(result['current_version_id'], old)
        self.assertNotIn(published['published']['version_id'], str(result['versions']))

    def test_contact_history_and_learning_targets_are_isolated_from_other_contact_and_owner(self):
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft)
        published, _ = self._approve(path, compared)
        self._bind(self.second_contact_id)
        other_path = f'/api/contacts/{self.second_contact_id}/skill-learning'
        suffix = '/skills/' + published['published']['skill_id']
        self.assertEqual(self.backend.request(other_path + suffix)[0], 404)
        self.assertEqual(self._get(self.backend, other_path + '/skills')['skills'], [])
        foreign = self._production_backend(self.other_owner_id)
        self.assertEqual(foreign.request(self.path + suffix)[0], 404)
        self.assertEqual(self.backend.request(other_path, {'enabled': True, 'confirmed': True,
            'expected_revision': 0, 'operation_key': str(uuid4())})[0], 200)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', {'outcome': 'no_change'}))
        original = self.contact_id
        self.contact_id = self.second_contact_id
        try:
            self._discussion(correction='合成第二联系人独立纠正。')
            deadline = time.monotonic() + 10
            while len(self.extraction_model.seen_calls) < 2:
                self._get(self.backend, other_path)
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.02)
        finally:
            self.contact_id = original
        payload = json.loads(self.extraction_model.seen_calls[-1][-1].content)
        self.assertEqual(payload['existing_skills'], [])

    def test_history_rejects_other_contact_before_materializing_private_version_body(self):
        from notalone.skills import LocalSkillPackageReader
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft)
        published, _ = self._approve(path, compared)
        skill = published['published']['skill_id']
        history_path = self.path + '/skills/' + skill
        document = self._get(self.backend, history_path)['versions'][0]['document']
        self.assertTrue(document)
        self._bind(self.second_contact_id)
        other_path = f'/api/contacts/{self.second_contact_id}/skill-learning'
        body_reads = []
        fetchall, fetchone = psycopg.Cursor.fetchall, psycopg.Cursor.fetchone
        read_file = LocalSkillPackageReader._read_file

        def observe(cursor, rows):
            columns = tuple(column.name for column in cursor.description or ())
            if 'content' in columns:
                for row in rows:
                    content = row['content'] if isinstance(row, dict) else row[columns.index('content')]
                    if content == document:
                        body_reads.append(columns)

        def observed_all(cursor):
            rows = fetchall(cursor)
            observe(cursor, rows)
            return rows

        def observed_one(cursor):
            row = fetchone(cursor)
            observe(cursor, [] if row is None else [row])
            return row

        def observed_file(root, relative_path, maximum_bytes):
            data = read_file(root, relative_path, maximum_bytes)
            if document.encode('utf-8') in data:
                body_reads.append((root, relative_path))
            return data

        # 观察真实文件读取及数据库返回值，拒绝范围时不能先物化正文。
        with (patch.object(psycopg.Cursor, 'fetchall', observed_all),
              patch.object(psycopg.Cursor, 'fetchone', observed_one),
              patch.object(LocalSkillPackageReader, '_read_file', side_effect=observed_file)):
            self.assertEqual(self.backend.request(other_path + '/skills/' + skill)[0], 404)
            self.assertEqual(self._get(self.backend, other_path + '/skills')['skills'], [])
            self.assertEqual(self.other_backend.request(history_path)[0], 404)
            self.assertEqual(body_reads, [], '拒绝另一联系人前不得把其专属版本正文物化。')
            legitimate = self._get(self.backend, history_path)
        self.assertEqual(legitimate['versions'][0]['document'], document)
        self.assertEqual(len(body_reads), 1, '合法历史在核验后只读取该版本正文一次。')

    def test_mixed_target_scopes_are_shown_but_not_automatically_merged(self):
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft)
        published, _ = self._approve(path, compared)
        other = self._import('calm-response')
        targets = [published['published']['skill_id'], other]
        methods = [str(uuid5(UUID(targets[0]), 'method:clarify')), str(uuid5(UUID(other), 'whole_strategy'))]
        path, draft = self._next_draft(targets, methods, kind='merge')
        self.assertEqual({item['scope']['kind'] for item in draft['private_evidence']['existing_skills']}, {'contact', 'owner'})
        calls = self.reply_model.provider_calls
        status, _ = self.backend.request(path + '/compare', {'expected_revision': draft['revision'],
            'operation_key': str(uuid4()), 'input': {'incoming_text': '合成混合范围审核', 'intent': '说明想法', 'scene': '核对安排'},
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None}})
        self.assertEqual(status, 409)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def test_reviewed_rollback_and_original_receipt_fail_closed_after_source_is_queued_and_deleted(self):
        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft)
        first, _ = self._approve(path, compared)
        skill = first['published']['skill_id']
        path, draft = self._next_draft([skill], [str(uuid5(UUID(skill), 'method:clarify'))])
        compared, _ = self._compare(path, draft)
        self._approve(path, compared)
        history_path = self.path + '/skills/' + skill
        history = self._get(self.backend, history_path)
        command = {'version_id': first['published']['version_id'], 'expected_revision': history['revision'],
            'expected_current_version_id': history['current_version_id'], 'operation_key': str(uuid4())}
        self.assertEqual(self.backend.request(history_path + '/rollback', command)[0], 200)
        from notalone.application.source_service import SourceService
        with patch.object(SourceService, '_start', return_value=None):
            self.assertEqual(self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')[0], 202)
        self.assertIn(self.backend.request(history_path + '/rollback', command)[0], (404, 409))
        self.assertEqual(self.backend.request(f'/api/skills/{skill}/rollback', {'version_id': first['published']['version_id']})[0], 404)
        self._delete_source(source)
        for backend in (self.backend, self._production_backend(self.owner_id)):
            self.assertEqual(backend.request(history_path)[0], 404)
            self.assertIn(backend.request(history_path + '/rollback', command)[0], (404, 409))

    def test_rollback_commits_before_second_backend_waiting_source_delete(self):
        self._rollback_delete_order(source_first=False)

    def test_source_delete_commits_before_second_backend_waiting_fresh_rollback(self):
        self._rollback_delete_order(source_first=True)

    def _rollback_delete_order(self, *, source_first):
        from notalone.application.source_service import SourceService
        from notalone.persistence.skill_library import PostgresSkillLibrary
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository

        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft)
        first, _ = self._approve(path, compared)
        first_draft_id = draft['draft_id']
        skill, old = first['published']['skill_id'], first['published']['version_id']
        path, draft = self._next_draft([skill], [str(uuid5(UUID(skill), 'method:clarify'))])
        compared, _ = self._compare(path, draft)
        second, _ = self._approve(path, compared)
        independent = self._import('independent-history')
        status, foreign = self.other_backend.request('/api/skills/import', {
            'package_path': str(Path(self.temporary.name) / 'independent-history')})
        self.assertEqual(status, 200, foreign)
        history_path = self.path + '/skills/' + skill
        history = self._get(self.backend, history_path)
        command = {'version_id': old, 'expected_revision': history['revision'],
            'expected_current_version_id': second['published']['version_id'], 'operation_key': str(uuid4())}
        # 两个独立应用装配只有数据库共享；第二HTTP必须进入真实PostgreSQL等待。
        deleting_backend = self._production_backend(self.owner_id)
        self.assertNotEqual(self.backend.base_url, deleting_backend.base_url)
        entered, release, holders = threading.Event(), threading.Event(), []

        def hold(connection):
            holders.append(connection.info.backend_pid)
            entered.set()
            if not release.wait(10):
                raise TimeoutError('合成回滚／删除事务锁门超时。')

        if source_first:
            original = PostgresSourceDeletionRepository.cancel_import_tasks

            def held_cancel(connection, **kwargs):
                hold(connection)
                return original(connection, **kwargs)

            gate = patch.object(PostgresSourceDeletionRepository, 'cancel_import_tasks', side_effect=held_cancel)
        else:
            original = PostgresSkillLibrary.rollback_locked

            def held_rollback(library, connection, *args, **kwargs):
                hold(connection)
                return original(library, connection, *args, **kwargs)

            gate = patch.object(PostgresSkillLibrary, 'rollback_locked', held_rollback)
        delete_path = f'/api/contacts/{self.contact_id}/sources/{source}'
        with patch.object(SourceService, '_start', return_value=None), gate, ThreadPoolExecutor(max_workers=2) as pool:
            operations = [lambda: deleting_backend.request(delete_path, method='DELETE'),
                          lambda: self.backend.request(history_path + '/rollback', command)]
            leading_index = 0 if source_first else 1
            leading = pool.submit(operations[leading_index])
            try:
                self.assertTrue(entered.wait(5))
                waiting = pool.submit(operations[1 - leading_index])
                blocked = wait_for_blocked_operations(self.database_url, set(holders), 1)
                self.assertTrue(blocked - set(holders))
                self.assertFalse(waiting.done())
            finally:
                release.set()
            results = leading.result(timeout=10), waiting.result(timeout=10)
        deleted, rolled_back = results if source_first else results[::-1]
        self.assertEqual(deleted[0], 202, deleted)
        self.assertIn(rolled_back[0], (404, 409) if source_first else (200,), rolled_back)
        if not source_first:
            self.assertEqual(rolled_back[1]['current_version_id'], old)
        # 首个后续GET之前，直接观察删除事务清除的正文、资源及审核元数据。
        self._assert_physical_review_erasure(first_draft_id, old)
        self._assert_physical_review_erasure(draft['draft_id'], second['published']['version_id'])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT status FROM public.source_document WHERE id=%s', (source,)).fetchone()[0], 'delete_requested')
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_history_operation WHERE owner_id=%s AND contact_id=%s AND operation_key=%s',
                (self.owner_id, self.contact_id, UUID(command['operation_key']))).fetchone()[0], 0 if source_first else 1)
            for version in (old, second['published']['version_id']):
                self.assertEqual(connection.execute('SELECT description,content,content_sha256,source_locator,is_current FROM public.reply_skill_version WHERE id=%s',
                    (UUID(version),)).fetchone(), ('来源已删除', None, None, None, False))
                self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_skill_resource WHERE skill_version_id=%s', (UUID(version),)).fetchone()[0], 0)
                self.assertEqual(connection.execute('SELECT dependency_ids,source_generation,scene FROM public.reply_skill_publication WHERE version_id=%s',
                    (UUID(version),)).fetchone(), ([], {}, None))
        # 同一公开DELETE入口同步运行真实worker，再在任何GET前确认删除终态。
        with patch.object(SourceService, '_start', SourceService._drain):
            self.assertEqual(deleting_backend.request(delete_path, method='DELETE')[0], 202)
        self._assert_physical_review_erasure(draft['draft_id'], second['published']['version_id'])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT status FROM public.source_document WHERE id=%s', (source,)).fetchone()[0], 'deleted')
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self.backend.request(history_path)[0], 404)
        for operation_key in (command['operation_key'], str(uuid4())):
            self.assertIn(self.backend.request(history_path + '/rollback', {**command, 'operation_key': operation_key})[0], (404, 409))
        self.assertEqual(self.backend.request(f'/api/skills/{independent}/preview')[0], 200)
        self.assertEqual(self.other_backend.request(f"/api/skills/{foreign['skill_id']}/preview")[0], 200)
