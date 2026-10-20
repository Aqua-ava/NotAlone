"""以合成查询端口验证实际取材器的完整JSON边界，不连接数据库。"""

from contextlib import ExitStack
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4, uuid5
from psycopg.rows import dict_row

from notalone.persistence.skill_learning_materials import select_learning_batch
from notalone.persistence.skill_learning import dependencies_current
from notalone.scopes import ContactScope
from notalone.skills.learning import learning_input_text


class MaterialRows:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class MaterialQueries:
    """只返回本例的合成输入，未知查询直接失败。"""

    def __init__(self, contents):
        self.inputs = [(uuid4(), uuid4(), content, None, [], None,
                        f'2026-01-01T00:00:{number:02d}', None)
                       for number, content in enumerate(contents)]
        self.consumed = set()
        self.input_pages = []

    def execute(self, query, params):
        if query.startswith('SELECT version.id,version.skill_id,version.content_sha256'):
            version = getattr(self, 'skill_version_id', getattr(self, 'version_id', None))
            if version is None or version not in params[1] or getattr(self, 'skill_deleted', False):
                return MaterialRows([])
            return MaterialRows([{'id': version, 'skill_id': self.skill_id, 'content_sha256': 'a' * 64,
                'review_origin': False, 'contact_id': None, 'origin_contact_id': None, 'scope_kind': None,
                'scope_contact_id': None, 'scene': None, 'dependency_ids': None, 'source_generation': None, 'deleted': None}])
        if 'WITH RECURSIVE material_provenance' in query:
            return MaterialRows([(value,) for value in params['dependencies']])
        if 'FROM public.assistant_session_input AS input' in query:
            rows = [row for row in self.inputs if row[0] not in self.consumed and
                    (params[2] is None or row[0] in params[2])]
            offset = params[-1] if 'OFFSET %s' in query else 0
            self.input_pages.append(offset)
            return MaterialRows(rows[offset:offset + 32])
        if any(fragment in query for fragment in (
            'FROM public.assistant_candidate_version AS version',
            'FROM public.assistant_candidate_selection AS selection',
            'FROM public.message AS message', 'owner_id<>',
            'SELECT id FROM public.assistant_session WHERE',
            'SELECT 1 FROM public.skill_learning_receipt',
            'SELECT id FROM public.reply_request WHERE',
            'FROM public.reply_skill AS skill',
            'jsonb_path_query',
        )):
            return MaterialRows([])
        if 'SELECT revision FROM public.skill_library' in query:
            return MaterialRows([(0,)])
        if 'SELECT revision FROM public.skill_learning_scope' in query:
            return MaterialRows([(1,)])
        raise AssertionError('合成取材端口出现未声明查询。')

    def cursor(self, *, row_factory):
        if row_factory is not dict_row:
            raise AssertionError('来源端口须使用声明的字典行工厂。')
        return DictionarySourceCursor(self)


class LearningMaterialsTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        stack = ExitStack()
        self.addCleanup(stack.close)
        # 来源验证独立有真实PG验收；本例只替换查询与来源端口，不改生产选择算法。
        module = 'notalone.persistence.skill_learning_materials.'
        stack.enter_context(patch(module+'_expand_message_sources', side_effect=lambda _, __, refs: refs))
        stack.enter_context(patch('notalone.persistence.skill_learning._dependencies_available_for_learning', return_value=True))
        stack.enter_context(patch(module+'capture_generation', return_value={}))

    def test_target_methods_belong_to_actual_published_version_and_exclude_pending_registry(self):
        for state in ('local_package', 'published_mapping', 'wrong_logical_skill'):
            with self.subTest(state=state):
                connection = TargetQueries(self.scope)
                published_id = uuid4()
                if state != 'local_package':
                    connection.published_methods = [{
                        'method_id': str(published_id),
                        'logical_skill_id': str(connection.skill_id if state == 'published_mapping' else uuid4())}]
                batch = select_learning_batch(connection, self.scope)
                if state == 'wrong_logical_skill':
                    self.assertEqual(batch.targets, (), '畸形发布映射不得作为当前可替代方法')
                    continue
                expected = published_id if state == 'published_mapping' else uuid5(connection.skill_id, 'whole_strategy')
                self.assertEqual(batch.targets[0]['methods'], [{
                    'method_id': str(expected), 'logical_skill_id': str(connection.skill_id)}])
                self.assertNotIn(str(connection.pending_method_id), str(batch.targets))

    def test_mixed_ordinary_sizes_progress_in_both_orders_without_consuming_skipped_material(self):
        small = {'type': 'purpose_exploration', 'purpose_hint': '"'*2600,
                 'requirements': '"'*3000}
        large = {'type': 'purpose_exploration', 'purpose_hint': '"'*3200,
                 'requirements': '"'*3200}
        for contents in ((small, large), (large, small)):
            with self.subTest(large_first=contents[0] is large):
                connection = MaterialQueries(contents)
                first = select_learning_batch(connection, self.scope)
                self.assertTrue(first.ready, '两份合法完整材料无法合批时应先推进一份')
                self.assertEqual(len(first.materials), 1)
                self.assertEqual(first.materials[0]['content'], contents[0])
                self.assertLessEqual(len(learning_input_text(first.materials, first.targets)), 24000)
                first_id = UUID(first.materials[0]['material_id'])
                selected_again = select_learning_batch(connection, self.scope, material_ids={first_id})
                self.assertEqual(selected_again.key, first.key, '同一有限材料必须可在保存前重验')
                connection.consumed.add(first_id)
                second = select_learning_batch(connection, self.scope)
                self.assertEqual(len(second.materials), 1)
                self.assertEqual(second.materials[0]['content'], contents[1])
                self.assertNotEqual(second.materials[0]['material_id'], first.materials[0]['material_id'])

    def test_one_small_ordinary_waits_and_oversized_material_does_not_create_a_false_batch(self):
        small = {'type': 'purpose_exploration', 'purpose_hint': '合成小份普通经验'}
        for contents in ((small,), (small, {'purpose_hint': '"'*16000})):
            with self.subTest(material_count=len(contents)):
                batch = select_learning_batch(MaterialQueries(contents), self.scope)
                self.assertFalse(batch.ready)
                self.assertEqual(len(batch.materials), 1)
                self.assertEqual(batch.materials[0]['content'], small)

    def test_oversized_prefix_does_not_hide_a_later_valid_correction(self):
        oversized = {'type': 'purpose_exploration', 'purpose_hint': '"'*4096,
                     'requirements': '"'*4096, 'correction': '"'*4096,
                     'answer': '"'*4096}
        short = {'type': 'purpose_exploration', 'purpose_hint': '合成后续经验',
                 'correction': '先核实问题，不要凭猜测回答。'}
        connection = MaterialQueries([oversized]*32 + [short])
        batch = select_learning_batch(connection, self.scope)
        self.assertTrue(batch.ready)
        self.assertEqual(len(batch.materials), 1)
        self.assertEqual(batch.materials[0]['content'], short)
        self.assertLessEqual(len(learning_input_text(batch.materials, batch.targets)), 24000)
        self.assertEqual(connection.consumed, set(), '跳过不代表已消费或可丢弃原材料')

    def test_full_batch_stops_before_expanding_or_paging_oversized_tail(self):
        short = {'type': 'purpose_exploration', 'purpose_hint': '合成有效经验',
                 'correction': '先核实问题，不要凭猜测回答。'}
        oversized = {**short, 'purpose_hint': '"'*4096, 'requirements': '"'*4096,
                     'correction': '"'*4096, 'answer': '"'*4096}
        connection = MaterialQueries([short]*8 + [oversized]*64)
        with patch('notalone.persistence.skill_learning_materials._expand_message_sources',
                   side_effect=lambda _, __, refs: refs) as expand:
            batch = select_learning_batch(connection, self.scope)
        self.assertEqual(len(batch.materials), 8)
        self.assertEqual(expand.call_count, 8, '满批后不得再展开第9份及其后资料')
        self.assertEqual(connection.input_pages, [0], '满批后不得再翻页扫描超长尾部')

    def test_each_historical_material_inherits_disabled_skill_versions_and_transitive_sources(self):
        for kind in ('assistant_usage', 'candidate_edit', 'candidate_selection',
                     'followup_observation', 'assistant_discussion'):
            with self.subTest(kind=kind):
                connection = HistoricalSkillQueries(self.scope, kind)
                batch = select_learning_batch(connection, self.scope)
                self.assertEqual(batch.targets, (), '停用Skill不是当前可替代目标')
                self.assertEqual(len(batch.materials), 1)
                self.assertEqual(batch.materials[0]['kind'], kind)
                self.assertTrue(connection.inherited <= set(batch.dependency_ids),
                                '材料须继承历史请求、样本和发布版本的真实Skill及传递来源')
                self.assertTrue({str(value) for value in connection.inherited}
                                <= set(batch.materials[0]['dependency_ids']))


class TargetQueries(MaterialQueries):
    def __init__(self, scope):
        super().__init__([{'type': 'purpose_exploration', 'purpose_hint': '合成方法整理',
                           'correction': '合成明确纠正'}])
        self.scope = scope
        self.skill_id, self.version_id, self.pending_method_id = uuid4(), uuid4(), uuid4()
        self.published_methods = None

    def execute(self, query, params):
        if 'FROM public.reply_skill AS skill' in query:
            return MaterialRows([(self.skill_id, self.version_id, 'synthetic-existing',
                                  '合成已有方法', 1, '先明确已知，再组织表达。')])
        if 'SELECT method_id FROM public.skill_method_identity' in query:
            return MaterialRows([(self.pending_method_id,)])
        if "SELECT strategy->'methods'" in query:
            if params != (self.scope.owner_id, self.skill_id, self.version_id) or "status='published'" not in query:
                raise AssertionError('当前方法映射必须指向同owner和真实已发布版本。')
            return MaterialRows([] if self.published_methods is None else [(self.published_methods,)])
        if 'SELECT dependency_ids FROM public.skill_draft' in query:
            return MaterialRows([])
        return super().execute(query, params)


class HistoricalSkillQueries(MaterialQueries):
    """同联系人历史请求图；当前目标目录为空，来源不随停用而消失。"""

    def __init__(self, scope, kind):
        super().__init__([])
        self.scope, self.kind = scope, kind
        self.input_id, self.session_id, self.turn_id = uuid4(), uuid4(), uuid4()
        self.request_id, self.candidate_id, self.version_id = uuid4(), uuid4(), uuid4()
        self.selection_id, self.message_id, self.sample_id = uuid4(), uuid4(), uuid4()
        self.skill_id, self.skill_version_id, self.source_id = uuid4(), uuid4(), uuid4()
        self.sample_candidate_id, self.sample_request_id = uuid4(), uuid4()
        self.sample_skill_id, self.sample_skill_version_id, self.sample_source_id = uuid4(), uuid4(), uuid4()
        self.inherited = {self.skill_id, self.skill_version_id, self.source_id,
                          self.sample_id, self.sample_skill_id, self.sample_skill_version_id, self.sample_source_id}
        self.edges = {
            self.turn_id: {self.request_id}, self.candidate_id: {self.request_id},
            self.request_id: {self.skill_id, self.skill_version_id, self.sample_id},
            self.skill_version_id: {self.source_id},
            self.sample_id: {self.sample_candidate_id, self.sample_source_id},
            self.sample_candidate_id: {self.sample_request_id},
            self.sample_request_id: {self.sample_skill_id, self.sample_skill_version_id},
        }
        content = {'type': 'rewrite_draft', 'draft_text': '合成历史使用', 'correction': '合成明确纠正'}
        self.group = [{'message_id': str(uuid4()), 'text': '合成原候选'}]
        if kind == 'assistant_usage':
            self.inputs = [(self.input_id, self.session_id, None, content, [], self.request_id,
                            '2026-01-01T00:00:00Z', self.turn_id)]
        elif kind == 'assistant_discussion':
            self.inputs = [(self.input_id, self.session_id, content, None, [self.turn_id], None,
                            '2026-01-01T00:00:00Z', None)]

    def execute(self, query, params):
        if 'WITH RECURSIVE material_provenance' in query:
            if params['owner_id'] != self.scope.owner_id or params['contact_id'] != self.scope.contact_id:
                raise AssertionError('历史取材图必须沿同owner与contact范围。')
            refs = set(params['dependencies'])
            pending = list(refs)
            while pending:
                for parent in set(self.edges.get(pending.pop(), ())) - refs:
                    refs.add(parent); pending.append(parent)
            return MaterialRows([(value,) for value in sorted(refs)])
        if 'SELECT id,message_group FROM public.reply_candidate' in query:
            return MaterialRows([(self.candidate_id, self.group)])
        if 'FROM public.assistant_candidate_version AS version' in query and self.kind == 'candidate_edit':
            return MaterialRows([(self.version_id, self.session_id, self.turn_id, self.candidate_id,
                                  self.group, '合成明确编辑要求', '2026-01-01T00:00:00Z', [])])
        if 'FROM public.assistant_candidate_selection AS selection' in query and self.kind == 'candidate_selection':
            return MaterialRows([(self.selection_id, self.session_id, self.candidate_id, self.version_id,
                                  self.group, '2026-01-01T00:00:00Z', [], self.turn_id)])
        if 'JOIN LATERAL (' in query and self.kind == 'followup_observation':
            return MaterialRows([(self.message_id, '合成后续观察', 'contact', '2026-01-01T00:00:00Z',
                                  self.turn_id, self.session_id, [], {'type': 'reply_to_message'})])
        return super().execute(query, params)


class DictionarySourceCursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, query, params):
        rows = self.connection.execute(query, params).fetchall()
        if query.startswith('SELECT version.id,version.skill_id,version.content_sha256'):
            return MaterialRows(rows)
        if 'coalesce(source_document_id, observation_id) AS source_id' in query:
            key = 'source_id'
        elif 'AS available' in query:
            key = 'available'
        elif 'jsonb_path_query' in query:
            key = 'id'
        else:
            raise AssertionError('字典来源端口出现未声明查询。')
        return MaterialRows([{key: row[0]} for row in rows])


class SourceRowQueries(MaterialQueries):
    def __init__(self):
        super().__init__([{'type': 'purpose_exploration', 'purpose_hint': '合成任务',
                           'correction': '合成明确纠正'}])
        self.source_id, self.message_id = uuid4(), uuid4()
        row = list(self.inputs[0])
        row[4] = [self.message_id]
        self.inputs[0] = tuple(row)
        self.cursor_factories = []
        self.cross_scope = False

    def cursor(self, *, row_factory):
        self.cursor_factories.append(row_factory)
        if row_factory is not dict_row:
            raise AssertionError('来源辅助函数须使用局部dict_row，不改变连接默认行工厂。')
        return DictionarySourceCursor(self)

    def execute(self, query, params):
        if 'owner_id<>' in query:
            return MaterialRows([(self.source_id,)] if self.cross_scope else [])
        if 'coalesce(source_document_id, observation_id) AS source_id' in query:
            return MaterialRows([(self.source_id,)])
        if 'AS available' in query:
            return MaterialRows([(True,)])
        if 'SELECT version.id FROM public.reply_skill_version' in query:
            return MaterialRows([])
        if any('SELECT id FROM public.'+table+' WHERE' in query for table in (
            'assistant_session_input', 'assistant_session_turn', 'assistant_candidate_version',
            'assistant_candidate_selection', 'reply_request', 'reply_candidate', 'reply_skill',
            'expression_preference',
        )):
            return MaterialRows([])
        return super().execute(query, params)


class LearningSourceRowsTest(unittest.TestCase):
    def test_existing_capture_without_explicit_skill_ids_still_checks_disabled_history_before_restore(self):
        scope = ContactScope(uuid4(), uuid4())
        connection = HistoricalSkillAvailabilityQueries(scope)
        self.assertTrue(dependencies_current(connection, scope, [connection.turn_id]),
                        '停用仍保留合法历史使用来源')
        connection.skill_deleted = True
        self.assertFalse(dependencies_current(connection, scope, [connection.turn_id]),
                         '旧草稿即使缺少显式Skill ID也不能在原Skill删除后恢复')

    def test_rejected_cross_scope_material_stops_before_further_source_partition_reads(self):
        connection = SourceRowQueries()
        connection.cross_scope = True
        with patch('notalone.persistence.skill_learning_materials.capture_generation', return_value={}):
            batch = select_learning_batch(connection, ContactScope(uuid4(), uuid4()))
        self.assertEqual(batch.materials, ())
        self.assertTrue(connection.cursor_factories)
        self.assertTrue(all(factory is dict_row for factory in connection.cursor_factories))


    def test_actual_source_helpers_work_with_tuple_default_material_selection(self):
        scope = ContactScope(uuid4(), uuid4())
        connection = SourceRowQueries()
        with patch('notalone.persistence.skill_learning_materials.capture_generation', return_value={}):
            batch = select_learning_batch(connection, scope)
        self.assertTrue(batch.ready)
        self.assertIn(connection.source_id, batch.dependency_ids)
        self.assertIn(connection.message_id, batch.dependency_ids)
        self.assertTrue(connection.cursor_factories)
        self.assertTrue(all(factory is dict_row for factory in connection.cursor_factories))

    def test_actual_dependency_helper_uses_dictionary_cursor_without_changing_default_rows(self):
        scope = ContactScope(uuid4(), uuid4())
        connection = SourceRowQueries()
        self.assertTrue(dependencies_current(connection, scope, [connection.message_id, connection.source_id]))
        self.assertTrue(connection.cursor_factories)
        self.assertTrue(all(factory is dict_row for factory in connection.cursor_factories))


class HistoricalSkillAvailabilityQueries(HistoricalSkillQueries):
    """真实来源门禁的合成行：未删历史版本合法，删除后的身份不属于raw来源。"""

    def __init__(self, scope):
        super().__init__(scope, 'assistant_usage')
        self.skill_deleted = False
        self.edges = {self.turn_id: {self.request_id},
                      self.request_id: {self.skill_id, self.skill_version_id},
                      self.skill_version_id: {self.source_id}}

    def execute(self, query, params):
        if 'WITH RECURSIVE material_provenance' in query:
            return super().execute(query, params)
        if 'AS available' in query:
            return MaterialRows([(set(params['dependencies']) <= {self.source_id},)])
        if 'SELECT version.id FROM public.reply_skill_version' in query:
            return MaterialRows([] if self.skill_deleted else [(self.skill_version_id,)])
        for table, identifiers in (('assistant_session_turn', {self.turn_id}),
                                   ('reply_request', {self.request_id}),
                                   ('reply_skill', set() if self.skill_deleted else {self.skill_id})):
            if query.startswith('SELECT id FROM public.'+table+' WHERE'):
                if 'context_snapshot ?' in query:
                    return MaterialRows([])
                return MaterialRows([(value,) for value in set(params[2]) & identifiers])
        if query.startswith('SELECT id FROM public.'):
            return MaterialRows([])
        return super().execute(query, params)
