"""显式范围和预算的用户入口；纯请求不得接触数据库或模型。"""

import json
import unittest
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import Mock, patch

import psycopg

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.versions import MemoryVersionConflict
from notalone.memory.upgrade import UpgradeConflict, UpgradeDeleted, UpgradeNotFound
from notalone.application.memory_upgrade import MemoryUpgradeService
from notalone.application.model_priority import ModelWorkStopped
from notalone.server.app import create_app
from notalone.server.sync_host import SyncHostStopped
from notalone.server.testing import InProcessClient


class MemoryUpgradeRequestTest(unittest.TestCase):
    def setUp(self):
        self.owner, self.contact = uuid4(), uuid4()
        self.client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-upgrade'))
        self.headers = {'Authorization': 'Bearer synthetic-upgrade'}

    def test_missing_confirmation_cross_scope_and_unbounded_budget_are_rejected_before_processing(self):
        body = {'scope': {'kind': 'contact', 'contact_id': str(self.contact)},
                'budget': {'message_limit': 20, 'batch_size': 10, 'model_calls': 4},
                'operation_key': str(uuid4()), 'confirmed': True}
        invalid = [{}, {**body, 'confirmed': False}, {**body, 'owner_id': str(self.owner)},
                   {**body, 'scope': {'kind': 'owner', 'contact_id': str(self.contact)}},
                   {**body, 'budget': {**body['budget'], 'model_calls': 0}},
                   {**body, 'budget': {**body['budget'], 'message_limit': True}},
                   {**body, 'budget': {**body['budget'], 'batch_size': 21}}]
        with patch('psycopg.connect', side_effect=AssertionError('纯请求不允许连接数据库')):
            for value in invalid:
                with self.subTest(value=value):
                    response = self.client.request('POST', '/api/memory-upgrades',
                        headers=self.headers, body=json.dumps(value).encode())
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    def test_explicit_prepare_and_restart_read_wake_only_the_durable_selected_job(self):
        from notalone.application.memory_upgrade import MemoryUpgradeService
        job_id, task_id, preparations, wakes = uuid4(), uuid4(), [], []

        class UpgradePersistenceBoundary:
            def prepare(inner, selected, budget, operation):
                preparations.append((selected, budget, operation))
                return job_id

            def read(inner, selected, identifier):
                return {'job': {'job_id': str(identifier), 'state': 'active', 'batches': []}}

            def pending_tasks(inner, selected, identifier):
                return [(self.contact, task_id)]

        class TaskHostBoundary:
            def wake(inner, **request):
                wakes.append(request)

        store = UpgradePersistenceBoundary()
        def client():
            return InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
                owner_id=self.owner, token='synthetic-upgrade',
                memory_upgrades=MemoryUpgradeService(store, task_host=TaskHostBoundary())))
        operation = uuid4()
        response = client().request('POST', '/api/memory-upgrades', headers=self.headers, body=json.dumps({
            'scope': {'kind': 'contact', 'contact_id': str(self.contact)},
            'budget': {'message_limit': 20, 'batch_size': 10, 'model_calls': 4},
            'operation_key': str(operation), 'confirmed': True,
        }).encode())
        self.assertEqual(response.status_code, 202, response.json())
        self.assertEqual(response.json()['job']['job_id'], str(job_id))
        self.assertEqual(len(preparations), 1)
        self.assertEqual(preparations[0][0].owner_id, self.owner)
        self.assertEqual(preparations[0][0].contact_id, self.contact)
        self.assertEqual(preparations[0][1].model_calls, 4)
        self.assertEqual(preparations[0][2], operation)
        restored = client().get(f'/api/memory-upgrades/{job_id}?contact_id={self.contact}', headers=self.headers)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(len(preparations), 1)
        self.assertEqual(wakes, [{'owner_id': self.owner, 'contact_id': self.contact, 'task_id': task_id}] * 2)

    def _undo_with_failure(self, error):
        class UpgradeBoundary:
            def operate(inner, *args, **kwargs):
                raise error

        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-upgrade', memory_upgrades=UpgradeBoundary()))
        return client.request('POST', f'/api/memory-upgrades/{uuid4()}?contact_id={self.contact}',
            headers=self.headers, body=json.dumps({
                'action': 'undo', 'expected_revision': 1, 'operation_key': str(uuid4()),
                'confirmed': True, 'batches': [{'batch_id': str(uuid4()), 'expected_revision': 1}],
            }).encode())

    def test_undo_source_and_manual_decision_conflicts_return_sanitized_409(self):
        with patch('psycopg.connect', side_effect=AssertionError('纯请求不允许连接数据库')):
            for error_type in (MemoryVersionConflict, MemoryCorrectionConflictError):
                with self.subTest(error_type=error_type.__name__):
                    response = self._undo_with_failure(error_type('合成敏感冲突详情'))
                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.json(), {'error': 'memory_upgrade_stale_or_unavailable'})
                    self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    def test_undo_database_failure_keeps_sanitized_503(self):
        with patch('psycopg.connect', side_effect=AssertionError('纯请求不允许连接数据库')):
            response = self._undo_with_failure(psycopg.OperationalError('合成敏感数据库详情'))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'memory_upgrade_unavailable'})
        self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    def _prepare_body(self):
        return {'scope': {'kind': 'contact', 'contact_id': str(self.contact)},
                'budget': {'message_limit': 20, 'batch_size': 10, 'model_calls': 4},
                'operation_key': str(uuid4()), 'confirmed': True}

    def _operation_body(self):
        return {'action': 'undo', 'expected_revision': 1, 'operation_key': str(uuid4()),
                'confirmed': True, 'batches': [{'batch_id': str(uuid4()), 'expected_revision': 1}]}

    def test_non_string_identities_are_rejected_before_storage_or_scheduling(self):
        store = Mock()
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-upgrade', memory_upgrades=MemoryUpgradeService(store)))
        for field in ('prepare_operation', 'contact', 'operate_operation', 'batch'):
            for value in (42, [], {}, True, None):
                with self.subTest(field=field, value=value):
                    if field in ('prepare_operation', 'contact'):
                        body, path = self._prepare_body(), '/api/memory-upgrades'
                        if field == 'contact':
                            body['scope']['contact_id'] = value
                        else:
                            body['operation_key'] = value
                    else:
                        body = self._operation_body()
                        path = f'/api/memory-upgrades/{uuid4()}?contact_id={self.contact}'
                        if field == 'batch':
                            body['batches'][0]['batch_id'] = value
                        else:
                            body['operation_key'] = value
                    response = client.request('POST', path, headers=self.headers, body=json.dumps(body).encode())
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.json(), {'error': 'memory_upgrade_request_invalid'})
                    self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
        self.assertEqual(store.mock_calls, [])

    def _request_fault(self, error, operation):
        store = SimpleNamespace(**{operation: Mock(side_effect=error)})
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-upgrade', memory_upgrades=MemoryUpgradeService(store)))
        if operation in ('list', 'read'):
            suffix = f'/{uuid4()}' if operation == 'read' else ''
            return client.get(f'/api/memory-upgrades{suffix}?contact_id={self.contact}', headers=self.headers)
        path, body = '/api/memory-upgrades', self._prepare_body()
        if operation == 'operate':
            path, body = f'{path}/{uuid4()}?contact_id={self.contact}', self._operation_body()
        return client.request('POST', path, headers=self.headers, body=json.dumps(body).encode())

    def test_valid_requests_keep_internal_failures_as_server_errors(self):
        for error in (AttributeError, TypeError, ValueError, KeyError):
            for operation in ('list', 'read', 'prepare', 'operate'):
                with self.subTest(error=error.__name__, operation=operation):
                    response = self._request_fault(error('合成内部细节'), operation)
                    self.assertEqual(response.status_code, 500)
                    self.assertEqual(response.json(), {'error': 'internal_error'})
                    self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    def test_domain_database_and_stopping_faults_keep_existing_statuses(self):
        for error, status, code in (
            (UpgradeNotFound, 404, 'not_found'),
            (UpgradeDeleted, 410, 'memory_upgrade_deleted'),
            (UpgradeConflict, 409, 'memory_upgrade_stale_or_unavailable'),
            (MemoryCorrectionConflictError, 409, 'memory_upgrade_stale_or_unavailable'),
            (MemoryVersionConflict, 409, 'memory_upgrade_stale_or_unavailable'),
            (psycopg.OperationalError, 503, 'memory_upgrade_unavailable'),
            (SyncHostStopped, 503, 'runtime_stopping'),
            (ModelWorkStopped, 503, 'runtime_stopping'),
        ):
            for operation in ('list', 'read', 'prepare', 'operate'):
                with self.subTest(error=error.__name__, operation=operation):
                    response = self._request_fault(error('合成边界细节'), operation)
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json(), {'error': code})
                    self.assertEqual(response.headers.get('Cache-Control'), 'no-store')


if __name__ == '__main__':
    unittest.main()
