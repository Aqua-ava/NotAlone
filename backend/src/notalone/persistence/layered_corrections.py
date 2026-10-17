"""整理纠错的确定性证据保护；不使用文字相似度或模型自评解除。"""

from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict
from notalone.persistence.layered_coverage import cancel_jobs
from notalone.persistence.reply_cleanup import delete_source_replies


class LayeredCorrectionStore:
    def correction_dependency_ids(self, connection, scope):
        # 无正文guard仍是真实输入；其最后合法身份消失时，旧对照副本也必须清除。
        return {identifier for row in self.feedback_rows(connection, scope)
            for key in ('dependency_ids', 'protected_memory_ids', 'protected_message_ids')
            for identifier in row[key]}

    def correction_context(self, connection, scope):
        return tuple({'feedback_id': str(row['id']), 'rejected_text': row['rejected_text'],
            'reason': row['reason'], 'rule': 'independent-literal-v1'}
            for row in self.feedback_rows(connection, scope))

    def report_fact_error(self, scope, command):
        from notalone.persistence.layered_memory import _digest
        with self.transaction(scope) as (connection, state, overview):
            digest = _digest(command)
            prior = connection.execute('SELECT * FROM public.layered_memory_fact_correction '
                'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND request_digest=%s '
                'AND settings_generation=%s',
                (scope.owner_id, scope.contact_id, digest, command['settings_generation'])).fetchone()
            if prior and state['settings_generation'] == command['settings_generation']:
                entry = next((entry for entry in self.eligible(overview)
                    if entry.memory.memory_id == prior['memory_id']
                    and entry.memory.revision == prior['memory_revision']), None)
                if entry:
                    return {'memory_id': str(prior['memory_id']), 'revision': prior['memory_revision']}
                raise LayeredMemoryConflict('待修正的底层叶版本已变化。')
            if (state['settings_generation'] != command['settings_generation']
                    or state['organization_generation'] != command['organization_generation']):
                raise LayeredMemoryConflict('整理版本或设置已变化。')
            generation, rows = self.generation_rows(connection, scope, state['organization_generation'])
            version = UUID(command['version_id'])
            if command['target_kind'] == 'scenario':
                target = next((row for row in rows if row['id'] == version), None)
                items = target['paragraphs'] if target else []
            else:
                target = self.profile_row(connection, scope, version) if generation and generation['profile_version_id'] == version else None
                items = target['entries'] if target and not target['withdrawn'] else []
            index = command['item_index']
            if index >= len(items):
                raise LayeredMemoryConflict('事实目标已失效。')
            selected = UUID(command['memory_id'])
            if selected not in {UUID(ref['memory_id']) for ref in items[index]['references']}:
                raise LayeredMemoryConflict('只能修正该项实际引用的底层记忆。')
            entry = next((entry for entry in overview.entries if entry.memory.memory_id == selected), None)
            if not entry or not entry.current_leaf:
                raise LayeredMemoryConflict('实际底层叶版本不可核对。')
            leaf = entry.current_leaf
            leaf_entry = next((item for item in self.eligible(overview) if item.memory.memory_id == leaf.memory_id), None)
            if leaf_entry is None:
                raise LayeredMemoryConflict('实际底层叶版本不可核对。')
            connection.execute('INSERT INTO public.layered_memory_fact_correction('
                'id,owner_id,contact_id,settings_generation,request_digest,memory_id,memory_revision,'
                'source_dependency_mode,dependency_ids,protected_message_ids) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (uuid4(), scope.owner_id, scope.contact_id, state['settings_generation'], digest,
                 leaf.memory_id, leaf.revision, leaf_entry.memory.source_dependency_mode.value,
                 sorted({leaf.memory_id, *leaf_entry.dependency_ids}),
                 sorted({ref.message_id for ref in leaf_entry.references if ref.message_id})))
            self._retract_fact_dependencies(connection, scope, leaf.memory_id)
            cancel_jobs(connection, scope)
            connection.execute('SELECT public.bump_layered_correction_revision(%s,%s)', (scope.owner_id, scope.contact_id))
            return {'memory_id': str(leaf.memory_id), 'revision': leaf.revision}

    def _retract_fact_dependencies(self, connection, scope, memory_id):
        # L1本身被报告有误：实际看过该叶的批次及递归画像全部受影响，不能只看直接引用。
        versions = connection.execute('SELECT v.id FROM public.scenario_document_version v '
            'JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE b.owner_id=%s '
            'AND b.contact_id IS NOT DISTINCT FROM %s AND %s=ANY(b.dependency_ids) '
            'UNION SELECT v.id FROM public.layered_profile_version v '
            'JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE b.owner_id=%s '
            'AND b.contact_id IS NOT DISTINCT FROM %s AND %s=ANY(b.dependency_ids)',
            (scope.owner_id, scope.contact_id, memory_id) * 2).fetchall()
        delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
            removed_ids={row['id'] for row in versions}, revoke_running_scope=False)
        connection.execute('DELETE FROM public.scenario_document_version WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s AND id=ANY(%s::uuid[])',
            (scope.owner_id, scope.contact_id, [row['id'] for row in versions]))
        connection.execute('UPDATE public.layered_profile_version SET withdrawn=true WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s AND id=ANY(%s::uuid[])',
            (scope.owner_id, scope.contact_id, [row['id'] for row in versions]))

    def feedback_rows(self, connection, scope):
        return connection.execute('SELECT * FROM public.layered_memory_feedback WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s ORDER BY created_at,id',
            (scope.owner_id, scope.contact_id)).fetchall()

    def unprotected(self, connection, scope, entries):
        feedback = self.feedback_rows(connection, scope)
        pending = {(row['memory_id'], row['memory_revision']) for row in connection.execute(
            'SELECT memory_id,memory_revision FROM public.layered_memory_fact_correction '
            'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s', (scope.owner_id, scope.contact_id))}
        memory_ids = {id for row in feedback for id in row['protected_memory_ids']}
        message_ids = {id for row in feedback for id in row['protected_message_ids']}
        result = []
        for entry in entries:
            memory = entry.memory
            if (memory.memory_id, memory.revision) in pending:
                continue
            # 共享的manual source身份不参与保护；实际版本链与规范消息才是证据身份。
            lineage = {memory.memory_id}
            previous = memory.supersedes_memory_id
            table = 'owner_memory' if scope.contact_id is None else 'confirmed_memory'
            while previous is not None and previous not in lineage:
                lineage.add(previous)
                row = connection.execute(f'SELECT supersedes_memory_id FROM public.{table} '
                    'WHERE owner_id=%s AND id=%s', (scope.owner_id, previous)).fetchone()
                previous = row['supersedes_memory_id'] if row else None
            messages = {ref.message_id for ref in entry.references if ref.message_id is not None}
            if not lineage & memory_ids and not messages & message_ids:
                result.append(entry)
        return tuple(result)

    def report_summary_error(self, scope, command):
        from notalone.persistence.layered_memory import _digest
        with self.transaction(scope) as (connection, state, overview):
            operation = UUID(command['operation_id'])
            prior = next((row for row in self.feedback_rows(connection, scope)
                          if row['operation_id'] == operation), None)
            digest = _digest(command)
            if prior:
                if (prior['request_digest'] != digest
                        or state['settings_generation'] != command['settings_generation']):
                    raise LayeredMemoryConflict('纠错操作已变化或其内容已删除。')
                return
            if (state['settings_generation'] != command['settings_generation']
                    or state['organization_generation'] != command['organization_generation']):
                raise LayeredMemoryConflict('整理版本或设置已变化。')
            generation, rows = self.generation_rows(connection, scope, state['organization_generation'])
            version = UUID(command['version_id'])
            if command['target_kind'] == 'scenario':
                target = next((row for row in rows if row['id'] == version), None)
                items = target['paragraphs'] if target else []
            else:
                target = self.profile_row(connection, scope, version) if generation and generation['profile_version_id'] == version else None
                items = target['entries'] if target and not target['withdrawn'] else []
            index = command['item_index']
            if index >= len(items):
                raise LayeredMemoryConflict('反馈目标已失效。')
            item = items[index]
            # 模型实际看过但未引用的输入也可能影响错误含义，未知时保护完整旧窗口。
            ids = {UUID(ref['memory_id']) for ref in target['input_manifest']}
            entries = [entry for entry in overview.entries if entry.memory.memory_id in ids]
            if len(entries) != len(ids) or not entries:
                raise LayeredMemoryConflict('目标的实际底层版本不可核对。')
            messages = {ref.message_id for entry in entries for ref in entry.references if ref.message_id}
            connection.execute('INSERT INTO public.layered_memory_feedback(id,owner_id,contact_id,operation_id,request_digest,'
                'settings_generation,target_kind,version_id,item_index,reason,rejected_text,input_manifest,dependency_ids,'
                'protected_memory_ids,protected_message_ids) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (uuid4(), scope.owner_id, scope.contact_id, operation, digest, state['settings_generation'],
                 command['target_kind'], version, index, command['reason'], item['text'], Jsonb(target['input_manifest']),
                 target['dependency_ids'], sorted(ids), sorted(messages)))
            self._retract_correction_target(connection, scope, command['target_kind'], version)
            cancel_jobs(connection, scope)
            connection.execute('UPDATE public.layered_memory_state SET correction_revision=correction_revision+1,'
                "dirty_revision=dirty_revision+1,next_due_at=clock_timestamp(),error_code='correction_protected' "
                'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s', (scope.owner_id, scope.contact_id))

    def _retract_correction_target(self, connection, scope, kind, version):
        # 反馈不是来源删除：同批次里已准入、未被反馈的独立主题保留。
        profiles = connection.execute('SELECT v.id FROM public.layered_profile_version v '
            'JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE b.owner_id=%s '
            'AND b.contact_id IS NOT DISTINCT FROM %s AND %s=ANY(b.scenario_version_ids)',
            (scope.owner_id, scope.contact_id, version)).fetchall() if kind == 'scenario' else []
        delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
            removed_ids={version, *(row['id'] for row in profiles)}, revoke_running_scope=False)
        if kind == 'scenario':
            connection.execute('DELETE FROM public.scenario_document_version WHERE id=%s', (version,))
        else:
            state = connection.execute('SELECT organization_generation FROM public.layered_memory_state '
                'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s', (scope.owner_id, scope.contact_id)).fetchone()
            _, rows = self.generation_rows(connection, scope, state['organization_generation'])
            connection.execute('UPDATE public.layered_profile_version SET withdrawn=true WHERE id=%s', (version,))
            self.publish_generation_in_transaction(connection, scope, expected_generation=state['organization_generation'],
                scenario_version_ids=[row['id'] for row in rows])
