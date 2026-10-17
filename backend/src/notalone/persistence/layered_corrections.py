"""整理纠错的确定性证据保护；不使用文字相似度或模型自评解除。"""

from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict
from notalone.persistence.layered_coverage import cancel_jobs
from notalone.persistence.reply_cleanup import delete_source_replies


class LayeredCorrectionStore:
    def feedback_rows(self, connection, scope):
        return connection.execute('SELECT * FROM public.layered_memory_feedback WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s ORDER BY created_at,id',
            (scope.owner_id, scope.contact_id)).fetchall()

    def unprotected(self, connection, scope, entries):
        feedback = self.feedback_rows(connection, scope)
        memory_ids = {id for row in feedback for id in row['protected_memory_ids']}
        message_ids = {id for row in feedback for id in row['protected_message_ids']}
        result = []
        for entry in entries:
            memory = entry.memory
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
                if prior['request_digest'] != digest:
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
            ids = {UUID(ref['memory_id']) for ref in item['references']}
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
            self._retract_correction_inputs(connection, scope, ids)
            cancel_jobs(connection, scope)
            connection.execute('UPDATE public.layered_memory_state SET correction_revision=correction_revision+1,'
                "dirty_revision=dirty_revision+1,next_due_at=clock_timestamp(),error_code='correction_protected' "
                'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s', (scope.owner_id, scope.contact_id))

    def _retract_correction_inputs(self, connection, scope, ids):
        # 先收集所有实际看过该输入的版本，再擦回复、准备、讨论与恢复副本。
        rows = connection.execute('SELECT v.id FROM public.scenario_document_version v JOIN public.layered_memory_batch b '
            'ON b.id=v.batch_id WHERE b.owner_id=%s AND b.contact_id IS NOT DISTINCT FROM %s AND b.dependency_ids && %s::uuid[] '
            'UNION SELECT v.id FROM public.layered_profile_version v JOIN public.layered_profile_batch b '
            'ON b.id=v.batch_id WHERE b.owner_id=%s AND b.contact_id IS NOT DISTINCT FROM %s AND b.dependency_ids && %s::uuid[]',
            (scope.owner_id, scope.contact_id, list(ids)) * 2).fetchall()
        if rows:
            delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                removed_ids={row['id'] for row in rows}, revoke_running_scope=False)
        connection.execute('DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s '
            'AND dependency_ids && %s::uuid[]', (scope.owner_id, scope.contact_id, list(ids)))
        connection.execute('DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s '
            'AND dependency_ids && %s::uuid[]', (scope.owner_id, scope.contact_id, list(ids)))
