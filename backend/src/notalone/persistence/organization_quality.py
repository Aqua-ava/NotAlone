"""公开质量输入与报告的短事务，复用整理范围锁和真实来源清单。"""

from uuid import UUID, uuid4
from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict
from notalone.memory.organization_quality import content_digest, FACT_PREPARATION_DATASET_VERSION
from notalone.memory.owner_organization_input import organization_model_memories, organization_model_scenarios


class PostgresOrganizationQualityStore:
    def __init__(self, layered_store):
        self._layered = layered_store

    def prepare(self, scope, versions, contract):
        if (not isinstance(versions, list) or not versions or len(versions) > contract.budget.max_memories
                or any(not isinstance(item, dict) or set(item) != {'memory_id', 'revision'}
                    or type(item['revision']) is not int or item['revision'] < 1 for item in versions)):
            raise ValueError('须选择有界实际记忆版本。')
        selected = {str(UUID(item['memory_id'])): item['revision'] for item in versions}
        if len(selected) != len(versions):
            raise ValueError('不得重复选择同一实际版本。')
        with self._layered.transaction(scope) as (connection, state, overview):
            entries = tuple(item for item in self._layered.unprotected(connection, scope, self._layered.eligible(overview)) if str(item.memory.memory_id) in selected)
            if (len(entries) != len(versions) or any(selected[str(item.memory.memory_id)] != item.memory.revision for item in entries)):
                raise LayeredMemoryConflict('所选版本不属于本范围当前合法资料。')
            entries, contexts, inherited = self._layered.organization_context_inputs(connection, scope, state, entries, contract.budget, overview)
            selected_ids = {str(entry.memory.memory_id) for entry in entries}
            actual_entries = self._layered.unprotected(connection, scope, self._layered.eligible(overview))
            actual_allowed = {str(entry.memory.memory_id) for entry in actual_entries}
            for previous in self._layered.generation_rows(connection, scope, state['organization_generation'])[1]:
                if not all(ref['memory_id'] in actual_allowed for paragraph in previous['paragraphs'] for ref in paragraph['references']):
                    continue
                prior = connection.execute('SELECT input_manifest FROM public.layered_memory_batch WHERE id=%s', (previous['batch_id'],)).fetchone()
                if any(item['memory_id'] not in selected_ids for item in prior['input_manifest']):
                    raise ValueError('冻结输入未覆盖正式L3会读取的全部合法主题底层版本；请调整明确选择或有界预算。')
            memories = organization_model_memories(scope, tuple(self._layered._input(item) for item in entries))
            payload = {'memories': [item.to_payload() for item in memories], 'scenarios': list(organization_model_scenarios(scope, contexts)),
                       'corrections': list(self._layered.correction_context(connection, scope))}
            guard = self._guard_snapshot(connection, scope, state)
            import json
            if len(json.dumps(payload, ensure_ascii=False)) > contract.budget.max_characters:
                raise ValueError('所选完整输入超过整理预算。')
            manifest = self._layered._manifest(connection, scope, entries)
            dependencies = {entry.memory.memory_id for entry in entries} | set(inherited)
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            for pending in self._pending_facts(connection, scope):
                dependencies.update({pending['id'], pending['memory_id'], *pending['dependency_ids'], *pending['protected_message_ids']})
                dependencies.update(pending.get('observation_ids', ()))
                dependencies.update(pending.get('source_ref_ids', ()))
            for feedback in self._layered.feedback_rows(connection, scope):
                dependencies.add(feedback['id'])
                dependencies.update(feedback['dependency_ids'])
                dependencies.update(feedback['protected_memory_ids'])
                dependencies.update(feedback['protected_message_ids'])
            identifier = uuid4()
            fact_corrections = self._fact_corrections(connection, scope, manifest, case_id=identifier, consume=True)
            for fact in fact_corrections:
                dependencies.update(UUID(fact[key]) for key in ('decision_id', 'record_id', 'replacement_memory_id'))
                if fact['fact_error_receipt']:
                    dependencies.update(UUID(value) for value in fact['fact_error_receipt']['dependency_ids'])
            evidence = {'fact_corrections': fact_corrections}
            construction = [{'memory_id': str(entry.memory.memory_id), 'revision': entry.memory.revision,
                             'provenance_kind': entry.provenance_kind, 'timing': entry.memory.timing.to_payload()}
                            for entry in entries]
            digest = content_digest(payload)
            connection.execute('INSERT INTO public.organization_quality_case(id,owner_id,contact_id,settings_generation,'
                'contract_id,contract,input_sha256,input_manifest,model_input,construction,dependency_ids,guard_snapshot,stage_evidence) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (identifier, scope.owner_id, scope.contact_id, state['settings_generation'], contract.identity,
                 Jsonb(contract.to_payload()), digest, Jsonb(manifest), Jsonb(payload), Jsonb(construction), sorted(dependencies), Jsonb(guard), Jsonb(evidence)))
            connection.execute('UPDATE public.organization_quality_fact_intent SET state=\'consumed\',consumer_case_id=%s '
                'WHERE id=ANY(%s::uuid[]) AND state=\'resolved\'', (identifier,
                    [UUID(fact['fact_error_receipt']['intent_id']) for fact in fact_corrections if fact['fact_error_receipt']]))
            return {'case_id': str(identifier), 'scope_kind': 'owner' if scope.contact_id is None else 'contact',
                    'contact_id': str(scope.contact_id) if scope.contact_id else None, 'contract_id': contract.identity,
                    'input_sha256': digest, 'model_input': payload, 'construction': construction, 'guard_snapshot': guard, 'stage_evidence': evidence,
                    'review_status': 'unknown', 'quality_verified': False}

    def read_case(self, owner_id, case_id):
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE id=%s AND owner_id=%s',
                                     (case_id, owner_id)).fetchone()
            if row is None:
                raise LookupError('质量输入不存在或已随来源清除。')
            self._check_case(connection, row)
            return {'case_id': str(row['id']), 'scope_kind': 'owner' if row['contact_id'] is None else 'contact',
                    'contact_id': str(row['contact_id']) if row['contact_id'] else None,
                    'contract_id': row['contract_id'], 'input_sha256': row['input_sha256'],
                    'model_input': row['model_input'], 'construction': row['construction'], 'guard_snapshot': row['guard_snapshot'],
                    'review_status': row['review_status'], 'annotations': row['annotations'],
                    'output': row['output_payload'], 'stage_evidence': row['stage_evidence'], 'quality_verified': False}

    def _owner_transaction(self, owner_id):
        from contextlib import contextmanager
        import psycopg
        from psycopg.rows import dict_row
        from notalone.persistence.locks import lock_owner_scope

        @contextmanager
        def transaction():
            with psycopg.connect(self._layered._database_url, row_factory=dict_row) as connection:
                connection.execute("SET LOCAL lock_timeout='2s'")
                connection.execute("SET LOCAL statement_timeout='5s'")
                lock_owner_scope(connection, owner_id=owner_id)
                yield connection
        return transaction()

    def _fact_corrections(self, connection, scope, manifest, *, case_id=None, consume=False):
        versions = {item['memory_id']: item['revision'] for item in manifest}
        rows = connection.execute('SELECT id,record_id,replacement_memory_id,record_kind,evidence FROM public.memory_correction_decision '
            'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND decision=\'corrected\' '
            'AND replacement_memory_id=ANY(%s::uuid[]) ORDER BY id',
            (scope.owner_id, scope.contact_id, [UUID(value) for value in versions])).fetchall()
        intents = connection.execute('SELECT * FROM public.organization_quality_fact_intent WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s '
            'AND ((state=\'resolved\' AND %s) OR (state=\'consumed\' AND consumer_case_id=%s)) ORDER BY id FOR UPDATE',
            (scope.owner_id, scope.contact_id, consume, case_id)).fetchall()
        def receipt(decision):
            intent = next((item for item in intents if item['decision_id'] == decision['id']
                and item['replacement_memory_id'] == decision['replacement_memory_id']), None)
            if intent is None:
                return None
            return {**{key: str(intent[key]) for key in ('id', 'origin_case_id', 'origin_run_id', 'old_memory_id',
                    'replacement_memory_id', 'decision_id') if key != 'id'},
                'intent_id': str(intent['id']), 'state': 'consumed', 'request_digest': intent['request_digest'],
                'settings_generation': intent['settings_generation'], 'old_revision': intent['old_revision'],
                'replacement_revision': intent['replacement_revision'],
                'dependency_ids': [str(value) for value in intent['dependency_ids']],
                'human_review': False, 'quality_verified': False}
        return [{'decision_id': str(row['id']), 'record_id': str(row['record_id']),
            'replacement_memory_id': str(row['replacement_memory_id']), 'replacement_revision': versions[str(row['replacement_memory_id'])],
            'record_kind': row['record_kind'], 'evidence_sha256': content_digest(row['evidence']),
            'fact_error_receipt': receipt(row)} for row in rows]

    @staticmethod
    def _pending_facts(connection, scope):
        return connection.execute('SELECT * FROM public.layered_memory_fact_correction WHERE owner_id=%s '
            'AND contact_id IS NOT DISTINCT FROM %s ORDER BY id', (scope.owner_id, scope.contact_id)).fetchall()

    def _guard_snapshot(self, connection, scope, state):
        return {'correction_revision': state['correction_revision'],
                'organization_generation': state['organization_generation'],
                'fact_pending': [{'id': str(row['id']), 'memory_id': str(row['memory_id']), 'memory_revision': row['memory_revision'],
                    'settings_generation': row['settings_generation'], 'request_digest': row['request_digest'],
                    'source_dependency_mode': row['source_dependency_mode'],
                    'dependency_ids': [str(value) for value in row['dependency_ids']],
                    'protected_message_ids': [str(value) for value in row['protected_message_ids']],
                    'observation_ids': [str(value) for value in row.get('observation_ids', ())],
                    'source_ref_ids': [str(value) for value in row.get('source_ref_ids', ())]}
                    for row in self._pending_facts(connection, scope)],
                'feedback_targets': [{'feedback_id': str(row['id']), 'target_kind': row['target_kind'],
                    'version_id': str(row['version_id']) if row['version_id'] else None, 'item_index': row['item_index'],
                    'state': row['state'], 'protected_memory_ids': [str(value) for value in row['protected_memory_ids']],
                    'protected_message_ids': [str(value) for value in row['protected_message_ids']]}
                    for row in self._layered.feedback_rows(connection, scope)]}

    def _check_case(self, connection, row):
        from notalone.scopes import organization_scope
        scope = organization_scope(row['owner_id'], row['contact_id'])
        overview = (self._layered._overview.read_owner_in_transaction(connection, scope.owner_id, organization=True)
                    if scope.contact_id is None else self._layered._overview.read_contact_in_transaction(connection, scope))
        entries = tuple(item for item in self._layered.unprotected(connection, scope, self._layered.eligible(overview))
                        if str(item.memory.memory_id) in {m['memory_id'] for m in row['input_manifest']})
        state = connection.execute('SELECT settings_generation,organization_generation,correction_revision FROM public.layered_memory_state '
            'WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s', (scope.owner_id, scope.contact_id)).fetchone()
        if (not state or state['settings_generation'] != row['settings_generation']
                or self._guard_snapshot(connection, scope, state) != row['guard_snapshot']
                or list(self._layered.correction_context(connection, scope)) != row['model_input'].get('corrections', [])
                or self._fact_corrections(connection, scope, row['input_manifest'], case_id=row['id']) != row['stage_evidence'].get('fact_corrections', [])
                or self._layered._manifest(connection, scope, entries) != row['input_manifest']):
            raise LayeredMemoryConflict('评测输入的实际来源、版本或范围世代已变化。')
        return tuple(self._layered._input(item) for item in entries)

    def checkpoint_l2(self, owner_id, case, proposal, budget):
        """独立评测checkpoint只保存投影证据；不改变产品世代和事实来源。"""
        from notalone.scopes import organization_scope
        from notalone.memory.scenario_publication import plan_scenario_publication, scenario_document
        scope = organization_scope(owner_id, case['contact_id'])
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE owner_id=%s AND id=%s '
                'AND execution_token=%s AND execution_state=\'running\' AND lease_expires_at>clock_timestamp()',
                (owner_id, case['id'], case['execution_token'])).fetchone()
            if row is None:
                raise LookupError('评测checkpoint目标已撤销。')
            self._check_case(connection, row)
            _, previous = self._layered.generation_rows(connection, scope, row['guard_snapshot']['organization_generation'])
            allowed = {item['memory_id'] for item in row['input_manifest']}
            plans, current = plan_scenario_publication(scope, proposal, previous, budget,
                task_id=case['id'], batch_id=case['id'], now=self._layered._clock())
            overview = (self._layered._overview.read_owner_in_transaction(connection, owner_id, organization=True)
                if scope.contact_id is None else self._layered._overview.read_contact_in_transaction(connection, scope))
            actual_entries = self._layered.unprotected(connection, scope, self._layered.eligible(overview))
            actual_allowed = {str(entry.memory.memory_id) for entry in actual_entries}
            prior = {item['id']: item for item in previous}
            new_manifest = row['input_manifest'] + [item for plan in plans if plan['prior_version_id'] is not None
                for item in prior[plan['prior_version_id']]['input_manifest']]
            for plan in plans:
                plan['row']['input_manifest'] = new_manifest
            input_rows = [item for item in current if all(ref['memory_id'] in actual_allowed
                for paragraph in item['paragraphs'] for ref in paragraph['references'])]
            for item in input_rows:
                if any(value['memory_id'] not in allowed for value in item['input_manifest']):
                    raise LayeredMemoryConflict('评测checkpoint不能省略既有主题实际读入的底层版本。')
            entries, manifest = self._layered.profile_input_entries(connection, scope, actual_entries, input_rows)
            raw_memories = tuple(self._layered._input(entry) for entry in entries)
            memories = organization_model_memories(scope, raw_memories)
            contexts = tuple(scenario_document(item) for item in input_rows)
            projected = organization_model_scenarios(scope, contexts)
            payload = {'memories': [item.to_payload() for item in memories], 'scenarios': list(projected),
                       'corrections': row['model_input']['corrections']}
            import json
            if len(json.dumps(payload, ensure_ascii=False)) > budget.max_characters:
                raise ValueError('实际L3 checkpoint完整输入超过预算。')
            evidence = {'kind': 'evaluation_checkpoint', 'published_to_product': False,
                'normal_call_required': bool(input_rows),
                'documents': list(contexts), 'model_input': payload,
                'input_manifest': manifest, 'input_sha256': content_digest(payload)}
            connection.execute('UPDATE public.organization_quality_case SET stage_evidence=stage_evidence||%s WHERE id=%s',
                (Jsonb({'l3_checkpoint': evidence}), case['id']))
            return raw_memories, tuple(projected)

    def record_challenge_input(self, owner_id, case_id, token, phase, payload):
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE owner_id=%s AND id=%s '
                'AND execution_token=%s AND execution_state=\'running\' AND lease_expires_at>clock_timestamp()',
                (owner_id, case_id, token)).fetchone()
            if row is None:
                raise LookupError('错误候选挑战目标已撤销。')
            self._check_case(connection, row)
            connection.execute('UPDATE public.organization_quality_case SET stage_evidence=stage_evidence||%s WHERE id=%s',
                (Jsonb({phase + '_input': {'kind': 'adversarial_verification', 'model_input': payload,
                    'input_sha256': content_digest(payload), 'normal_production_call': False}}), case_id))

    def create_run(self, owner_id, case_ids, contract, *, max_http_attempts, dataset_version, data_kind):
        self._layered.require_synthetic_database()
        if (not isinstance(case_ids, list) or not 1 <= len(case_ids) <= 240
                or len(set(case_ids)) != len(case_ids) or type(max_http_attempts) is not int
                or not 1 <= max_http_attempts <= 750 or not isinstance(dataset_version, str)
                or not 1 <= len(dataset_version.strip()) <= 160 or data_kind != 'fixed_synthetic'):
            raise ValueError('评测须固定有界合成集合与同一持久调用额度。')
        identifiers = [UUID(item) for item in case_ids]
        with self._owner_transaction(owner_id) as connection:
            rows = connection.execute('SELECT * FROM public.organization_quality_case WHERE owner_id=%s AND id=ANY(%s) '
                                      'ORDER BY id FOR UPDATE', (owner_id, identifiers)).fetchall()
            if len(rows) != len(identifiers) or any(row['run_id'] is not None or row['contract'].get('input_projection_version') != contract.input_projection_version for row in rows):
                raise LayeredMemoryConflict('质量输入不可用、已属于一次运行或合同已变化。')
            for row in rows:
                self._check_case(connection, row)
            if dataset_version == FACT_PREPARATION_DATASET_VERSION and (len(rows) != 1 or max_http_attempts != 1
                    or len(rows[0]['input_manifest']) != 1 or rows[0]['annotations'] is not None
                    or rows[0]['output_payload'] is not None or rows[0]['execution_state'] != 'prepared'):
                raise LayeredMemoryConflict('事实路径预备用途只允许单一未执行、未审阅的精确叶版本。')
            identifier = uuid4()
            dataset_hash = content_digest([{'case_id': str(row['id']), 'input_sha256': row['input_sha256']} for row in rows])
            connection.execute('INSERT INTO public.organization_quality_run(id,owner_id,stage,contract_id,contract,dataset_version,'
                'dataset_sha256,data_kind,case_count,max_http_attempts) VALUES(%s,%s,\'organization\',%s,%s,%s,%s,%s,%s,%s)',
                (identifier, owner_id, contract.identity, Jsonb(contract.to_payload()), dataset_version, dataset_hash,
                 data_kind, len(rows), max_http_attempts))
            connection.execute('UPDATE public.organization_quality_case SET run_id=%s WHERE id=ANY(%s)', (identifier, identifiers))
        return identifier

    def report_rows(self, owner_id, run_id=None):
        with self._owner_transaction(owner_id) as connection:
            return self.report_rows_in_transaction(connection, owner_id, run_id)

    def withdraw(self, owner_id, identifier, *, run=False):
        """显式撤销用途也能清除已因预期过渡撤走正文的原登记。"""
        with self._owner_transaction(owner_id) as connection:
            column = 'origin_run_id' if run else 'origin_case_id'
            removed = connection.execute('DELETE FROM public.organization_quality_fact_intent WHERE owner_id=%s '
                f'AND ({column}=%s OR consumer_case_id=%s) RETURNING id', (owner_id, identifier, identifier)).fetchall()
            table = 'organization_quality_run' if run else 'organization_quality_case'
            result = connection.execute(f'DELETE FROM public.{table} WHERE owner_id=%s AND id=%s RETURNING id',
                (owner_id, identifier)).fetchone()
            if not removed and result is None:
                raise LookupError('质量用途不存在或已经撤销。')
        return {'withdrawn': True}

    def report_rows_in_transaction(self, connection, owner_id, run_id=None):
        run = connection.execute('SELECT * FROM public.organization_quality_run WHERE owner_id=%s '
            'AND (%s::uuid IS NULL OR id=%s) AND stage=\'organization\' ORDER BY created_at DESC,id DESC LIMIT 1',
            (owner_id, run_id, run_id)).fetchone()
        if not run:
            raise LookupError('质量报告不存在或已随参与来源清除。')
        cases = connection.execute('SELECT * FROM public.organization_quality_case WHERE run_id=%s ORDER BY id', (run['id'],)).fetchall()
        for row in cases:
            self._check_case(connection, row)
        attempts = connection.execute('SELECT * FROM public.organization_quality_attempt WHERE run_id=%s ORDER BY ordinal', (run['id'],)).fetchall()
        return run, cases, attempts

    def review_case(self, owner_id, case_id, payload, *, output=False):
        from notalone.memory.organization_quality_review import annotations, output_review
        from notalone.memory.organization_quality_report import human_approved
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE id=%s AND owner_id=%s FOR UPDATE',
                                     (case_id, owner_id)).fetchone()
            if row is None:
                raise LookupError('实际输入已不存在。')
            self._check_case(connection, row)
            if not output and row['run_id'] is not None:
                run = connection.execute('SELECT state,dataset_version FROM public.organization_quality_run WHERE id=%s', (row['run_id'],)).fetchone()
                if run['dataset_version'] == FACT_PREPARATION_DATASET_VERSION:
                    raise LayeredMemoryConflict('一次性事实路径预备用途不接受质量审阅。')
                if run['state'] != 'prepared':
                    raise LayeredMemoryConflict('运行已开始，须新建输入与运行以重新冻结支持合同。')
            if output and row['execution_state'] not in {'complete', 'failed'}:
                raise LayeredMemoryConflict('须待本场景实际执行结束后审阅完整输出。')
            checked = output_review(payload, row) if output else annotations(payload, row)
            if output:
                connection.execute('UPDATE public.organization_quality_case SET output_review=%s WHERE id=%s', (Jsonb(checked), case_id))
            else:
                connection.execute('UPDATE public.organization_quality_case SET annotations=%s,review_status=%s WHERE id=%s',
                    (Jsonb(checked), 'human_reviewed' if human_approved(checked) else 'unknown', case_id))
        return self.read_case(owner_id, case_id)

    def claim_case(self, owner_id, run_id, contract, *, transport_kind, allow_unreviewed_smoke=False):
        from notalone.memory.organization_quality_report import human_approved
        with self._owner_transaction(owner_id) as connection:
            run = connection.execute('SELECT * FROM public.organization_quality_run WHERE id=%s AND owner_id=%s FOR UPDATE',
                                     (run_id, owner_id)).fetchone()
            if run is None:
                raise LookupError('评测运行已不存在。')
            if run['dataset_version'] == FACT_PREPARATION_DATASET_VERSION:
                raise LayeredMemoryConflict('一次性事实路径预备用途不能执行模型或签发质量。')
            if run['contract_id'] != contract.identity:
                raise LayeredMemoryConflict('实际候选或整理合同已改变，须新建运行。')
            cases = connection.execute('SELECT * FROM public.organization_quality_case WHERE run_id=%s ORDER BY id', (run_id,)).fetchall()
            if run['state'] == 'prepared':
                frozen = all(human_approved(case['annotations']) for case in cases)
                if not frozen and not allow_unreviewed_smoke:
                    raise LayeredMemoryConflict('实际语义评测须先冻结人工输入支持；工程冒烟须显式标明。')
                digest = content_digest([{'input_sha256': c['input_sha256'], 'annotations': c['annotations']} for c in cases])
                connection.execute('UPDATE public.organization_quality_run SET state=\'running\',transport_kind=%s,'
                    'input_review_frozen=%s,input_review_sha256=%s WHERE id=%s', (transport_kind, frozen, digest, run_id))
            elif run['transport_kind'] != transport_kind:
                raise LayeredMemoryConflict('同一运行不能切换真实与受控传输。')
            running = next((case for case in cases if case['execution_state'] == 'running'), None)
            if running is not None:
                active = connection.execute('SELECT lease_expires_at>clock_timestamp() AS active FROM public.organization_quality_case WHERE id=%s', (running['id'],)).fetchone()['active']
                if active:
                    raise LayeredMemoryConflict('本运行已有有界执行，不能重复占用或重置额度。')
                connection.execute('UPDATE public.organization_quality_case SET execution_state=\'failed\',error_code=\'interrupted_request_unknown\','
                    'execution_token=NULL,lease_expires_at=NULL WHERE id=%s', (running['id'],))
            case = next((case for case in cases if case['execution_state'] == 'prepared'), None)
            if case is None:
                connection.execute('UPDATE public.organization_quality_run SET state=\'complete\',finished_at=clock_timestamp() WHERE id=%s', (run_id,))
                return None
            memories = self._check_case(connection, case)
            token = uuid4()
            connection.execute('UPDATE public.organization_quality_case SET execution_state=\'running\',execution_token=%s,'
                'lease_expires_at=clock_timestamp()+interval \'195 seconds\' WHERE id=%s', (token, case['id']))
            return {**case, 'execution_token': token, 'memories': memories}

    def record_stage(self, owner_id, case_id, token, phase, value, *, error_code=None, finished=False):
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE id=%s AND owner_id=%s '
                'AND execution_token=%s AND execution_state=\'running\' FOR UPDATE', (case_id, owner_id, token)).fetchone()
            if row is None:
                raise LookupError('迟到评测结果没有当前有效目标。')
            self._check_case(connection, row)
            output = {**(row['output_payload'] or {}), phase: value}
            connection.execute('UPDATE public.organization_quality_case SET output_payload=%s,output_review=NULL,error_code=%s,'
                'execution_state=%s,execution_token=CASE WHEN %s THEN NULL ELSE execution_token END WHERE id=%s',
                (Jsonb(output), error_code, 'failed' if error_code else 'complete' if finished else 'running', bool(error_code or finished), case_id))
            if error_code or finished:
                pending = connection.execute('SELECT 1 FROM public.organization_quality_case WHERE run_id=%s '
                    'AND execution_state IN (\'prepared\',\'running\') LIMIT 1', (row['run_id'],)).fetchone()
                if pending is None:
                    connection.execute('UPDATE public.organization_quality_run SET state=\'complete\',finished_at=clock_timestamp() WHERE id=%s', (row['run_id'],))

    def record_budget_rejection(self, owner_id, case_id, token, phase, measurement):
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE owner_id=%s AND id=%s '
                'AND execution_token=%s AND execution_state=\'running\' FOR UPDATE', (owner_id, case_id, token)).fetchone()
            if row is None:
                raise LookupError('预算拒绝的输入已撤销。')
            self._check_case(connection, row)
            evidence = row['stage_evidence']
            evidence['budget_rejections'] = [*evidence.get('budget_rejections', []), {'phase': phase, **measurement}]
            connection.execute('UPDATE public.organization_quality_case SET stage_evidence=%s WHERE id=%s', (Jsonb(evidence), case_id))

    def reserve_attempt(self, owner_id, run_id, case_id, token, phase, request_payload, *, request_route='unknown', measurements=None):
        from notalone.memory.layered import OrganizationBudgetExhausted
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE id=%s AND owner_id=%s '
                'AND run_id=%s AND execution_token=%s AND execution_state=\'running\' FOR UPDATE',
                (case_id, owner_id, run_id, token)).fetchone()
            if row is None:
                raise LookupError('请求发送前实际输入已撤销。')
            self._check_case(connection, row)
            run = connection.execute('UPDATE public.organization_quality_run SET http_attempts_used=http_attempts_used+1 '
                'WHERE id=%s AND http_attempts_used<max_http_attempts RETURNING http_attempts_used', (run_id,)).fetchone()
            if run is None:
                raise OrganizationBudgetExhausted('同一持久评测运行的实际HTTP额度已耗尽。')
            identifier = uuid4()
            connection.execute('INSERT INTO public.organization_quality_attempt(id,run_id,case_id,ordinal,phase,request_payload,request_model,request_route,measurements) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)', (identifier, run_id, case_id, run['http_attempts_used'], phase,
                Jsonb(request_payload), str(request_payload.get('model', 'unknown')), request_route, Jsonb(measurements or {})))
            return identifier

    def finish_attempt(self, owner_id, attempt_id, *, response=None, outcome, duration_ms, measurements=None):
        with self._owner_transaction(owner_id) as connection:
            # 目标不存在时只丢弃迟到回执，不INSERT或重建来源/输入副本。
            connection.execute('UPDATE public.organization_quality_attempt SET response_payload=%s,outcome=%s,'
                'response_model=%s,system_fingerprint=%s,duration_ms=%s,measurements=measurements||%s WHERE id=%s AND run_id IN '
                '(SELECT id FROM public.organization_quality_run WHERE owner_id=%s)',
                (Jsonb(response) if response is not None else None, outcome,
                 response.get('model') if isinstance(response, dict) else None,
                 response.get('system_fingerprint') if isinstance(response, dict) else None,
                 duration_ms, Jsonb(measurements or {}), attempt_id, owner_id))

    def calibrate(self, owner_id, run_id, payload, contract):
        from notalone.memory.organization_quality_review import reviewer, decision
        if (not isinstance(payload, dict) or set(payload) != {'contract_id', 'reviewer', 'decision', 'notes'}
                or payload['contract_id'] != contract.identity or not isinstance(payload['notes'], str)
                or not payload['notes'].strip() or len(payload['notes']) > 4000):
            raise ValueError('预算标定须绑定实际合同、审阅者与具体观察。')
        reviewer(payload['reviewer'])
        decision(payload['decision'])
        with self._owner_transaction(owner_id) as connection:
            result = connection.execute('UPDATE public.organization_quality_run SET calibration=%s WHERE owner_id=%s AND id=%s '
                'AND contract_id=%s AND state=\'complete\' RETURNING id', (Jsonb(payload), owner_id, run_id, contract.identity)).fetchone()
            if result is None:
                raise LayeredMemoryConflict('须先完成同一实际合同的完整评测。')

    def check_execution(self, owner_id, case_id, token):
        with self._owner_transaction(owner_id) as connection:
            row = connection.execute('SELECT * FROM public.organization_quality_case WHERE owner_id=%s AND id=%s '
                'AND execution_token=%s AND execution_state=\'running\' AND lease_expires_at>clock_timestamp()',
                (owner_id, case_id, token)).fetchone()
            if row is None:
                raise LookupError('本次评测执行已失效。')
            self._check_case(connection, row)

    def revoke(self, owner_id, contract_id, receipt, reason):
        with self._owner_transaction(owner_id) as connection:
            connection.execute('INSERT INTO public.organization_quality_revocation(owner_id,contract_id,receipt,reason) '
                'VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING', (owner_id, contract_id, receipt, reason))

    def revocation(self, owner_id, contract_id, receipt, *, connection=None):
        def read(conn):
            row = conn.execute('SELECT reason FROM public.organization_quality_revocation WHERE owner_id=%s AND contract_id=%s AND receipt=%s',
                               (owner_id, contract_id, receipt)).fetchone()
            return row['reason'] if row else None
        if connection is not None:
            return read(connection)
        with self._owner_transaction(owner_id) as current:
            return read(current)
