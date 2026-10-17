"""学习新模型用途的认证请求门；原应用内存请求，不启动HTTP或PG。"""

import json
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from notalone.application.skill_learning import SkillLearningService
from notalone.application.model_priority import ModelWorkStopped
from notalone.persistence.skill_learning import SkillLearningNotFound
from notalone.server.sync_host import SyncHostStopped
from notalone.skills.learning import SkillLearningInvalid, SkillLearningUnavailable


class LearningPersistenceBoundary:
    """仅替换持久化边界；自动调度仍走生产Service和认证路由。"""
    def __init__(self):
        self.enabled, self.revision, self.ready = False, 0, False
        self.task_id, self.commands, self.retries = uuid4(), [], []

    def list(self, scope):
        return {'drafts': [], 'enabled': self.enabled, 'scope_revision': self.revision,
                'task': None, 'recent_outcomes': []}

    def configure(self, scope, **command):
        self.commands.append((scope, command))
        self.enabled, self.revision = command['enabled'], self.revision + 1

    def enqueue(self, scope, *, force_retry=False):
        self.retries.append(force_retry)
        return self.task_id if self.enabled and self.ready else None


class LearningTaskHostBoundary:
    def __init__(self):
        self.requests = []

    def wake(self, **request):
        self.requests.append(request)


class SkillLearningRequestTest(unittest.TestCase):
    def setUp(self):
        self.owner, self.contact = uuid4(), uuid4()
        self.client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-token'))
        self.path = f'/api/contacts/{self.contact}/skill-learning'
        self.headers = {'Authorization': 'Bearer synthetic-token'}

    def test_missing_consent_and_forged_owner_do_not_reach_storage(self):
        for body in ({'enabled': True}, {'enabled': True, 'confirmed': False},
                     {'enabled': True, 'confirmed': True, 'owner_id': str(self.owner)},
                     {'enabled': 'true', 'confirmed': True}, {'resume': False}):
            with self.subTest(body=body):
                result = self.client.request('POST', self.path, headers=self.headers, body=json.dumps(body).encode())
                self.assertEqual(result.status_code, 400)
                self.assertEqual(result.headers.get('Cache-Control'), 'no-store')

    def test_history_rollback_rejects_forged_or_incomplete_action_before_storage(self):
        body = {'version_id': str(uuid4()), 'expected_revision': 2,
                'expected_current_version_id': str(uuid4()), 'operation_key': str(uuid4())}
        invalid = [{**body, 'owner_id': str(self.owner)}, {**body, 'expected_revision': True},
                   {**body, 'operation_key': []}, {**body, 'expected_current_version_id': ''},
                   {key: value for key, value in body.items() if key != 'operation_key'}]
        for payload in invalid:
            response = self.client.request('POST', self.path + f'/skills/{uuid4()}/rollback',
                headers=self.headers, body=json.dumps(payload).encode())
            self.assertEqual(response.status_code, 400, response.json())
            self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    def test_unauthenticated_or_publish_requests_cannot_enable_learning(self):
        result = self.client.request('POST', self.path, body=json.dumps({'enabled': True, 'confirmed': True}).encode())
        self.assertEqual(result.status_code, 401)
        result = self.client.request('POST', self.path + '/publish', headers=self.headers, body=b'{}')
        self.assertEqual(result.status_code, 404)

    def test_non_string_operation_identity_returns_400_before_storage_or_worker(self):
        store, host = LearningPersistenceBoundary(), LearningTaskHostBoundary()
        service = SkillLearningService(store)
        service.task_host = host
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-token', skill_learning=service))
        for operation in (42, [], {}, True, None):
            with self.subTest(operation=operation):
                result = client.request('POST', self.path, headers=self.headers, body=json.dumps({
                    'enabled': True, 'confirmed': True, 'operation_key': operation, 'expected_revision': 0,
                }).encode())
                self.assertEqual(result.status_code, 400, result.json())
                self.assertEqual(result.json()['error'], 'skill_learning_request_invalid')
                self.assertEqual(result.headers.get('Cache-Control'), 'no-store')
        self.assertEqual(store.commands, [])
        self.assertEqual(host.requests, [])

    def _request_fault(self, error, operation):
        store = LearningPersistenceBoundary()
        service = SkillLearningService(store)
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-token', skill_learning=service))
        with patch.object(store, operation, side_effect=error):
            if operation == 'list':
                return client.get(self.path, headers=self.headers)
            payload = {'resume': True} if operation == 'enqueue' else {
                'enabled': True, 'confirmed': True, 'operation_key': str(uuid4()), 'expected_revision': 0,
            }
            return client.request('POST', self.path, headers=self.headers, body=json.dumps(payload).encode())

    def test_valid_operations_keep_internal_failures_as_server_errors(self):
        for error in (AttributeError, TypeError, ValueError):
            for operation in ('list', 'configure', 'enqueue'):
                with self.subTest(error=error.__name__, operation=operation):
                    result = self._request_fault(error('合成内部故障'), operation)
                    self.assertEqual(result.status_code, 500)
                    self.assertEqual(result.json(), {'error': 'internal_error'})
                    self.assertEqual(result.headers.get('Cache-Control'), 'no-store')

    def test_domain_and_database_faults_keep_existing_public_statuses(self):
        for error, status, code in (
            (SkillLearningNotFound, 404, 'not_found'),
            (SkillLearningInvalid, 409, 'skill_learning_stale_or_disabled'),
            (SkillLearningUnavailable, 409, 'skill_learning_stale_or_disabled'),
            (psycopg.OperationalError, 503, 'skill_learning_unavailable'),
            (SyncHostStopped, 503, 'runtime_stopping'),
            (ModelWorkStopped, 503, 'runtime_stopping'),
        ):
            for operation in ('list', 'configure', 'enqueue'):
                with self.subTest(error=error.__name__, operation=operation):
                    result = self._request_fault(error('合成边界故障'), operation)
                    self.assertEqual(result.status_code, status)
                    self.assertEqual(result.json(), {'error': code})
                    self.assertEqual(result.headers.get('Cache-Control'), 'no-store')

    def test_explicit_enable_and_later_authority_read_schedule_only_ready_materials(self):
        store, host = LearningPersistenceBoundary(), LearningTaskHostBoundary()
        service = SkillLearningService(store)
        # 与生产装配相同的宿主入口；不是学习模型可执行Tool。
        service.task_host = host
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-token', skill_learning=service))
        operation = uuid4()
        response = client.request('POST', self.path, headers=self.headers, body=json.dumps({
            'enabled': True, 'confirmed': True, 'operation_key': str(operation), 'expected_revision': 0,
        }).encode())
        self.assertEqual(response.status_code, 200, response.json())
        self.assertTrue(response.json()['enabled'])
        self.assertEqual(host.requests, [])
        self.assertEqual(store.commands[0][1], {'enabled': True, 'operation_key': operation, 'expected_revision': 0})
        store.ready = True
        self.assertEqual(client.get(self.path, headers=self.headers).status_code, 200)
        self.assertEqual(host.requests, [{'owner_id': self.owner, 'contact_id': self.contact, 'task_id': store.task_id}])
        response = client.request('POST', self.path, headers=self.headers, body=json.dumps({
            'enabled': False, 'confirmed': True, 'operation_key': str(uuid4()), 'expected_revision': 1,
        }).encode())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['enabled'])
        self.assertEqual(len(host.requests), 1)

    def test_resume_is_explicit_and_can_retry_the_same_durable_batch(self):
        store, host = LearningPersistenceBoundary(), LearningTaskHostBoundary()
        store.enabled, store.ready = True, True
        service = SkillLearningService(store)
        service.task_host = host
        client = InProcessClient(create_app(database_url='postgresql:///synthetic_unused_test',
            owner_id=self.owner, token='synthetic-token', skill_learning=service))
        result = client.request('POST', self.path, headers=self.headers, body=b'{"resume": true}')
        self.assertEqual(result.status_code, 200, result.json())
        self.assertEqual(store.retries, [True])
        self.assertEqual(host.requests[0]['task_id'], store.task_id)

    def test_draft_review_rejects_unconfirmed_or_ambiguous_scope_before_storage(self):
        path = self.path + '/drafts/' + str(uuid4())
        base = {'expected_revision': 1, 'operation_key': str(uuid4())}
        for action, payload in (
            ('compare', {**base, 'input': {'incoming_text': '合成审核输入', 'intent': '说明想法', 'scene': ''},
                         'scope': {'kind': 'owner', 'contact_id': None, 'scene': None}}),
            ('approve', {**base, 'comparison_id': str(uuid4()), 'confirmed': False,
                         'replacements_confirmed': True,
                         'scope': {'kind': 'contact', 'contact_id': str(self.contact), 'scene': None}}),
            ('decision', {**base, 'decision': 'accept'}),
        ):
            with self.subTest(action=action):
                response = self.client.request('POST', path + '/' + action, headers=self.headers,
                                               body=json.dumps(payload).encode())
                self.assertEqual(response.status_code, 400, response.json())
                self.assertEqual(response.headers.get('Cache-Control'), 'no-store')


if __name__ == '__main__':
    unittest.main()
