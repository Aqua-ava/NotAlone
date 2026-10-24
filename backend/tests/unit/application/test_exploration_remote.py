"""薄桥只读重建 A 命令；B 的写入只经认证 TS 入口。"""
from dataclasses import replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import Mock
from uuid import uuid4

from notalone.application.exploration_remote import RemoteExplorationService
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.exploration import ExplorationInput, ExplorationStale
from notalone.reply.exploration_task import ExplorationTask, ExplorationCompletedInput
from notalone.reply.interface import DirectionSource, NoSkill
from notalone.scopes import ContactScope


class RemoteExplorationTests(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.session, self.exploration, self.input, self.key = (uuid4() for _ in range(4))
        self.store, self.generation = Mock(), Mock()
        self.task = ExplorationTask(self.exploration, self.scope, self.session, self.input,
            uuid4(), self.key, ExplorationInput('initiate_conversation'), (), (), 1, None,
            datetime.now(timezone.utc), state='selected', selected_intent='询问安排',
            selection_id=uuid4(), selection_source=DirectionSource.DIRECT_INPUT)
        self.store.read.return_value = self.task
        self.service = RemoteExplorationService(url='http://127.0.0.1:12345', token='x' * 32,
            owner_id=self.scope.owner_id, store=self.store, generation=self.generation, read_command=self.store.read)
        self.addCleanup(self.service.close)
        self.requests = []

    def command(self):
        return {'kind': 'generation_command', 'exploration_id': str(self.exploration),
                'input_version_id': str(self.input), 'request_key': str(self.key),
                'confirmed_intent': '询问安排'}

    def fake(self, result):
        def request(scope, action, request, session_id=None):
            self.requests.append((scope, action, request, session_id))
            return result if action != 'finish' else {}
        self.service._request = request

    def confirm(self, **kwargs):
        return self.service.confirm(scope=self.scope, session_id=self.session,
            exploration_id=self.exploration, input_version_id=self.input,
            direct_intent='询问安排', **kwargs)

    def test_generate_uses_original_a_port_and_ts_finish_without_b_write(self):
        self.fake(self.command())
        result = self.confirm()
        self.assertEqual(result['turn'], self.generation.generate.return_value)
        command = self.generation.generate.call_args.args[0]
        self.assertEqual(command.task, self.task)
        self.assertIsInstance(command.skill, NoSkill)
        self.assertEqual([item[1] for item in self.requests], ['confirm', 'finish'])
        self.assertEqual(self.store.method_calls, [unittest.mock.call.read(self.scope, self.exploration)])

    def test_prepare_preserves_a_receipt_and_does_not_finish(self):
        self.fake(self.command())
        result = self.confirm(prepare_only=True)
        self.assertEqual(result['generation'], self.generation.prepare.return_value)
        self.generation.generate.assert_not_called()
        self.assertEqual(len(self.requests), 1)

    def test_mutated_scope_or_persisted_identity_never_enters_a(self):
        self.fake(self.command())
        self.store.read.return_value = replace(self.task, request_key=uuid4())
        with self.assertRaises(ExplorationStale):
            self.confirm()
        self.generation.generate.assert_not_called()

    def test_selection_only_cannot_receive_generation_command(self):
        self.fake(self.command())
        with self.assertRaises(ReplyInvariantError):
            self.confirm(selection_only=True)
        self.store.read.assert_not_called()

    def test_replay_uses_persisted_completed_input(self):
        self.fake({'kind': 'replay_command', 'exploration_id': str(self.exploration)})
        completed = ExplorationCompletedInput(self.exploration, self.key,
            {'content': {'type': 'initiate_conversation', 'purpose': '原意愿'}})
        self.store.replay_confirmation.return_value = completed
        result = self.confirm()
        self.generation.replay.assert_called_once_with(self.scope, self.session, completed)
        self.assertEqual(result['confirmed_intent'], '原意愿')
        self.store.read.assert_not_called()
        self.assertEqual(len(self.requests), 1)

    def test_missing_replay_refuses_generation(self):
        self.fake({'kind': 'replay_command', 'exploration_id': str(self.exploration)})
        self.store.replay_confirmation.return_value = None
        with self.assertRaises(ExplorationStale):
            self.confirm()
        self.generation.replay.assert_not_called()

    def test_answer_prepare_replay_keeps_original_operation(self):
        self.fake({'kind': 'replay_command', 'exploration_id': str(self.exploration)})
        completed = ExplorationCompletedInput(self.exploration, self.key, {})
        self.store.replay_answer.return_value = completed
        question, operation = uuid4(), uuid4()
        self.service.answer(scope=self.scope, session_id=self.session, exploration_id=self.exploration,
            input_version_id=self.input, question_id=question, answer='合成回答', operation_key=operation,
            prepare_only=True)
        self.store.replay_answer.assert_called_once_with(self.scope, self.session, self.exploration,
            self.input, question_id=question, answer='合成回答', operation_key=operation)
        self.generation.prepare_replay.assert_called_once_with(self.scope, self.session, completed)

    def test_http_auth_scope_echo_and_open_payload(self):
        seen = []
        scope = self.scope
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append((self.path, self.headers['Authorization'], body))
                result = {'owner_id': str(scope.owner_id), 'contact_id': str(scope.contact_id),
                          'result': {'kind': 'directions'}}
                if len(seen) > 1:
                    result['contact_id'] = str(uuid4())
                encoded = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        service = RemoteExplorationService(url=f'http://127.0.0.1:{server.server_port}', token='x' * 32,
            owner_id=self.scope.owner_id, store=self.store, generation=self.generation, read_command=self.store.read)
        self.addCleanup(service.close)
        from notalone.application.manual_input_scope import manual_input_contact
        token = manual_input_contact.set(scope.contact_id)
        try:
            self.assertEqual(service.open(scope=scope, session_id=self.session,
                content=self.task.content, operation_key=self.key), {'kind': 'directions'})
        finally:
            manual_input_contact.reset(token)
        self.assertEqual(seen[0][0], '/internal/exploration')
        self.assertEqual(seen[0][1], 'Bearer ' + 'x' * 32)
        self.assertEqual(seen[0][2]['request']['content']['type'], 'purpose_exploration')
        self.assertEqual(seen[0][2]['session_id'], str(self.session))
        self.assertIs(seen[0][2]['manual_input'], True)
        with self.assertRaises(ReplyInvariantError):
            service.read(scope=scope, exploration_id=self.exploration)

    def test_http_errors_preserve_public_failure_categories_and_budget(self):
        from notalone.reply.errors import ReplyRunError, ReplyProviderContextLimitError
        from notalone.reply.exploration import ExplorationError
        from notalone.reply.input_budget import InputBudgetExceededError
        budget = {'state': 'exceeded', 'allowed': False, 'model_id': 'synthetic',
                  'context_window_tokens': 100, 'input_tokens': 100, 'output_reserve_tokens': 10,
                  'total_tokens': 110, 'measurement_kind': 'exact', 'measurement_id': 'synthetic',
                  'reason': 'input_budget_exceeded', 'safety_margin_tokens': 0}
        cases = [(400, {'error': 'exploration_request_invalid'}, ValueError),
                 (409, {'error': 'exploration_rejected'}, ExplorationError),
                 (503, {'error': 'exploration_failed'}, ReplyRunError),
                 (409, {'error': 'provider_context_limit'}, ReplyProviderContextLimitError),
                 (409, {'error': 'exploration_rejected', 'input_budget': budget}, InputBudgetExceededError),
                 (409, {'error': 'input_budget_exceeded', 'input_budget': budget}, InputBudgetExceededError)]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                code, payload, _ = cases.pop(0)
                encoded = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        service = RemoteExplorationService(url=f'http://127.0.0.1:{server.server_port}', token='x' * 32,
            owner_id=self.scope.owner_id, store=self.store, generation=self.generation, read_command=self.store.read)
        self.addCleanup(service.close)
        for _, _, expected in tuple(cases):
            with self.subTest(expected=expected), self.assertRaises(expected) as raised:
                service.read(scope=self.scope, exploration_id=self.exploration)
            if expected is InputBudgetExceededError:
                self.assertEqual(raised.exception.decision.to_payload(),
                                 {key: value for key, value in budget.items() if key != 'safety_margin_tokens'})
        self.assertEqual(cases, [])

    def test_command_reader_never_uses_pruning_store_read_or_transaction(self):
        from unittest.mock import patch
        from notalone.application.exploration_remote import PostgresExplorationCommandReader
        from notalone.reply.exploration import ExplorationExpired
        reader = PostgresExplorationCommandReader(database_url='synthetic-unused', store=self.store)
        connection = Mock()
        with patch('notalone.application.exploration_remote.psycopg.connect') as connect, \
             patch('notalone.application.exploration_remote.lock_owner_scope') as lock:
            connect.return_value.__enter__.return_value = connection
            self.store.read_in_transaction.return_value = self.task
            self.assertEqual(reader(self.scope, self.exploration), self.task)
            lock.assert_called_once_with(connection, owner_id=self.scope.owner_id)
            self.store.read_in_transaction.assert_called_once_with(connection, self.scope, self.exploration)
            self.store.read.assert_not_called()
            self.store._prune.assert_not_called()
            self.store._transaction.assert_not_called()
            self.store.read_in_transaction.side_effect = ExplorationExpired('合成过期')
            with self.assertRaises(ExplorationStale):
                reader(self.scope, self.exploration)
            self.store._prune.assert_not_called()
            self.store._transaction.assert_not_called()

    def test_manual_contact_mismatch_refuses_before_http(self):
        from notalone.application.manual_input_scope import manual_input_contact
        token = manual_input_contact.set(uuid4())
        try:
            with self.assertRaises(ExplorationStale):
                self.service.read(scope=self.scope, exploration_id=self.exploration)
        finally:
            manual_input_contact.reset(token)

    def test_stop_uses_readonly_command_session_and_checks_input_identity(self):
        self.fake({})
        self.service.stop(scope=self.scope, exploration_id=self.exploration, input_version_id=self.input)
        self.store.read.assert_called_once_with(self.scope, self.exploration)
        self.assertEqual(self.requests, [(self.scope, 'stop', {
            'exploration_id': self.exploration, 'input_version_id': self.input}, self.session)])
        self.requests.clear()
        with self.assertRaises(ExplorationStale):
            self.service.stop(scope=self.scope, exploration_id=self.exploration, input_version_id=uuid4())
        self.assertEqual(self.requests, [])
        self.store._prune.assert_not_called()
