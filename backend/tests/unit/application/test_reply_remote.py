"""纯合成loopback薄桥验证；不读取.env、不连接模型或业务库。"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID

from notalone.application.reply_remote import (
    RemoteReplyPort, ReplyRemoteUnavailable, ReplyRemoteInvalidResponse,
    decode_reply_generated, reply_remote_payload,
)
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.reply.interface import (
    GenerateReply, RewriteDraft, ReplyToMessage, InitiateConversation, ConfirmedDirection,
    DirectionSource, SuggestionReference, NoSkill, UserSkillChoice, CandidateMessage,
)
from notalone.reply.assistant_continuation_reference import ContinuationGenerateReply, AssistantContinuationReference
from notalone.reply.errors import ReplyInvariantError, ReplyInputInvalidatedError
from notalone.reply.input_budget import InputBudgetExceededError


def uid(n):
    return UUID(int=n)


SCOPE = VerifiedConversationScope(uid(1), uid(2), uid(3))
SCOPE_JSON = {k: str(getattr(SCOPE, k)) for k in ('owner_id', 'contact_id', 'conversation_binding_id')}
COMMAND = GenerateReply(uid(4), ContactScope(uid(1), uid(2)), uid(3), RewriteDraft('合成草稿'))


def budget():
    return dict(state='ready', allowed=True, model_id='synthetic-model', context_window_tokens=1000,
        input_tokens=100, output_reserve_tokens=200, total_tokens=320, measurement_kind='approximate',
        measurement_id='synthetic-messages-v1', reason=None, safety_margin_tokens=20)


def result():
    return {'reply_request_id': str(uid(5)), 'candidates': [dict(candidate_id=str(uid(6)), text='第一句\n\n第二句',
        basis='合成依据', citation_ids=[str(uid(7))], risk_notes=['合成风险'], messages=[
            {'message_id': str(uid(8)), 'text': '第一句'}, {'message_id': str(uid(9)), 'text': '第二句'}])],
        'context_receipt': dict(evidence_ids=[str(uid(7))], expression_preference_ids=[str(uid(10))],
            expression_preferences=[dict(preference_id=str(uid(10)), text='合成表达要求', revision=2**60+1,
                                         scope=dict(contact_id=str(uid(2)), reply_mode='rewrite_draft'))],
            layered_read_failed=True, owner_layered_read_failed=False, overview_read_failed=True),
        'used_skill': dict(skill_id=str(uid(11)), version_id=str(uid(12)), name='gentle-reply', selection_method='user',
            selection_reason='合成选择', resource_paths=['references/synthetic.md'], load_state='loaded', version_number=2,
            scope=dict(kind='contact', contact_id=str(uid(2)), scene=None),
            execution_view=dict(policy_revision=3, method_ids=[str(uid(13))], sha256='a'*64)),
        'input_budget': budget(),
        'basis_changes': [dict(evidence_id=str(uid(12)), kind='reply_skill', reason='skill_policy_changed')]}


class ReplyRemoteDecodeTest(unittest.TestCase):
    def test_full_dto_preserves_ids_bigint_skill_budget_and_basis(self):
        value = decode_reply_generated(json.loads(json.dumps(result())), SCOPE)
        self.assertEqual(value.candidates[0].message_group[1].message_id, uid(9))
        self.assertEqual(value.context_receipt.expression_preferences[0].revision, 2**60+1)
        self.assertTrue(value.context_receipt.layered_read_failed)
        self.assertEqual(value.used_skill.execution_view.method_ids, (uid(13),))
        self.assertEqual(value.input_budget.to_payload(), budget())
        self.assertEqual(value.basis_changes[0].reason, 'skill_policy_changed')

    def test_corrupt_or_cross_scope_response_is_rejected(self):
        changes = [lambda x: x.update(cost={'amount': 0}),
            lambda x: x['context_receipt']['expression_preferences'][0]['scope'].update(contact_id=str(uid(99))),
            lambda x: x['context_receipt']['expression_preferences'][0].update(revision=True),
            lambda x: x['used_skill']['scope'].update(contact_id=str(uid(99))),
            lambda x: x['used_skill']['execution_view'].update(sha256='invalid'),
            lambda x: x['input_budget'].update(total_tokens=1),
            lambda x: x['input_budget'].update(allowed=False),
            lambda x: x['candidates'][0]['messages'][1].update(message_id=str(uid(8))),
            lambda x: x['candidates'][0].update(citation_ids=[str(uid(99))]),
            lambda x: x['basis_changes'][0].update(kind='owner_memory')]
        for mutate in changes:
            with self.subTest(mutate=mutate):
                value = result(); mutate(value)
                with self.assertRaises(ReplyRemoteInvalidResponse):
                    decode_reply_generated(value, SCOPE)

    def test_commands_and_trusted_continuation_use_separate_envelope(self):
        direct = ConfirmedDirection('合成方向', DirectionSource.DIRECT_INPUT)
        for content in (COMMAND.content, ReplyToMessage(uid(20), direct), InitiateConversation(direct),
                        RewriteDraft('合成想法', input_kind='workspace', workspace_action='express', context_text='合成上下文', excluded_message_ids=(uid(21),))):
            command = GenerateReply(uid(4), COMMAND.scope, uid(3), content, skill=NoSkill())
            value = reply_remote_payload(command, SCOPE, uid(1))
            self.assertEqual(value['verified_scope'], SCOPE_JSON)
            self.assertTrue(value['request']['skill_disabled'])
            self.assertEqual(value['internal'], {})
        ref = AssistantContinuationReference(uid(6), uid(22), (CandidateMessage(uid(8), '合成选择正文'),))
        command = ContinuationGenerateReply(idempotency_key=uid(4), scope=COMMAND.scope, conversation_binding_id=uid(3),
            content=COMMAND.content, continued_from_candidate_id=uid(6), skill=UserSkillChoice(uid(12)),
            continuation={'version': 1, 'candidate_id': str(uid(6))}, continuation_reference=ref)
        value = reply_remote_payload(command, SCOPE, uid(1))
        self.assertNotIn('continuation', value['request'])
        self.assertNotIn('continuation_reference', value['request'])
        self.assertEqual(value['internal']['authenticatedContinuation']['continuation_reference']['messages'][0]['message_id'], str(uid(8)))
        self.assertEqual(value['request']['skill_version_id'], str(uid(12)))
        with self.assertRaises(ReplyInvariantError):
            reply_remote_payload(COMMAND, VerifiedConversationScope(uid(1), uid(99), uid(3)), uid(1))
        old = GenerateReply(uid(4), COMMAND.scope, uid(3), InitiateConversation(ConfirmedDirection('合成方向',
            DirectionSource.CONFIRMED_SUGGESTION, SuggestionReference(uid(30), 1, uid(31)))))
        with self.assertRaises(ReplyInvariantError):
            reply_remote_payload(old, SCOPE, uid(1))


class ReplyRemoteHttpTest(unittest.TestCase):
    def setUp(self):
        self.requests, self.status = [], 200
        self.body = {'verified_scope': SCOPE_JSON, 'reply': result()}
        self.received, self.release = threading.Event(), threading.Event()
        self.block = False
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                outer.requests.append((self.path, self.headers.get('Authorization'),
                    json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                outer.received.set()
                if outer.block:
                    outer.release.wait(2)
                self.send_response(outer.status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                try:
                    self.wfile.write(json.dumps(outer.body).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.remote = RemoteReplyPort(url=f'http://127.0.0.1:{self.server.server_port}', token='synthetic-'*4, owner_id=uid(1))

    def tearDown(self):
        self.release.set(); self.remote.close(); self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def test_prepare_generate_authenticated_and_exact_scope_echo(self):
        self.body = {'verified_scope': SCOPE_JSON, 'prepared': True, 'input_budget': budget(), 'receipt': {}}
        self.assertIsNone(self.remote.prepare(COMMAND, verified_scope=SCOPE))
        self.body = {'verified_scope': SCOPE_JSON, 'reply': result()}
        generated = self.remote.generate(COMMAND, verified_scope=SCOPE)
        self.assertEqual(generated.reply_request_id, uid(5))
        self.assertEqual([r[0] for r in self.requests], ['/internal/reply/prepare', '/internal/reply/generate'])
        self.assertEqual(self.requests[0][1], 'Bearer ' + 'synthetic-'*4)
        self.body = {'verified_scope': {**SCOPE_JSON, 'conversation_binding_id': str(uid(99))}, 'reply': result()}
        with self.assertRaises(ReplyRemoteInvalidResponse):
            self.remote.generate(COMMAND, verified_scope=SCOPE)

    def test_error_mapping_and_no_redirect_retry_or_fallback(self):
        self.status, self.body = 409, {'error': 'reply_input_invalidated'}
        with self.assertRaises(ReplyInputInvalidatedError):
            self.remote.generate(COMMAND, verified_scope=SCOPE)
        self.body = {'error': 'input_budget_exceeded', 'input_budget': {**budget(), 'state': 'exceeded', 'allowed': False}}
        with self.assertRaises(InputBudgetExceededError) as caught:
            self.remote.generate(COMMAND, verified_scope=SCOPE)
        self.assertEqual(caught.exception.decision.input_tokens, 100)
        for status in (302, 401, 500):
            self.status, self.body = status, {'error': 'private-synthetic-unknown'}
            before = len(self.requests)
            with self.assertRaises(ReplyRemoteUnavailable) as caught:
                self.remote.generate(COMMAND, verified_scope=SCOPE)
            self.assertNotIn('private-synthetic', str(caught.exception))
            self.assertEqual(len(self.requests), before + 1)

    def test_business_error_contract_preserves_original_classes_and_reasons(self):
        from notalone.application.reply_remote import ReplyRemoteRejected
        from notalone.application.assistant_session_service import AssistantSessionRejected
        from notalone.application.assistant_preparation_control import AssistantPreparationStopped
        from notalone.application.model_priority import ModelWorkStopped
        from notalone.reply.errors import (ReplyContextInvariantError, ReplyContextError, ReplyBudgetError,
            ReplyPersistenceError, ReplyRunError, ReplyProviderContextLimitError)
        self.status = 409
        cases = {
            'reply_context_invalidated': ReplyContextInvariantError,
            'reply_context_unavailable': ReplyContextError,
            'reply_budget_exceeded': ReplyBudgetError,
            'reply_budget_unavailable': ReplyBudgetError,
            'reply_persistence_unavailable': ReplyPersistenceError,
            'reply_generation_failed': ReplyRunError,
            'provider_context_limit': ReplyProviderContextLimitError,
            'reply_cancelled': ModelWorkStopped,
            'runtime_stopping': ModelWorkStopped,
            'exploration_stale': AssistantSessionRejected,
            'exploration_expired': AssistantSessionRejected,
        }
        for code, expected in cases.items():
            with self.subTest(code=code):
                self.body = {'error': code}
                before = len(self.requests)
                with self.assertRaises(expected) as caught:
                    self.remote.generate(COMMAND, verified_scope=SCOPE)
                self.assertIs(type(caught.exception), expected)
                self.assertEqual(len(self.requests), before + 1)
                if code.startswith('exploration_'):
                    self.assertEqual(caught.exception.reason, code)
        for reason in ('scope_mismatch', 'no_active_binding', 'manual_contact_unconfirmed',
                       'invalid_verification', 'history_sync_pending', 'history_incomplete_confirmation_required'):
            self.body = {'error': 'reply_rejected', 'reason': reason}
            with self.assertRaises(ReplyRemoteRejected) as caught:
                self.remote.generate(COMMAND, verified_scope=SCOPE)
            self.assertEqual(caught.exception.reason, reason)
        for reason in (None, 'synthetic-private-unknown', 12):
            self.body = {'error': 'reply_rejected', 'reason': reason}
            with self.assertRaises(ReplyRemoteInvalidResponse):
                self.remote.generate(COMMAND, verified_scope=SCOPE)
        for code, reason in (('reply_cancelled', 'cancelled'), ('runtime_stopping', 'runtime_stopping')):
            self.body = {'error': code}
            with self.assertRaises(AssistantPreparationStopped) as caught:
                self.remote.prepare(COMMAND, verified_scope=SCOPE)
            self.assertEqual(caught.exception.reason, reason)
        self.body = {'error': 'input_budget_unavailable', 'input_budget': {
            **budget(), 'state': 'unavailable', 'allowed': False, 'input_tokens': None,
            'total_tokens': None, 'measurement_kind': None, 'measurement_id': None}}
        from notalone.reply.input_budget import InputBudgetUnavailableError
        with self.assertRaises(InputBudgetUnavailableError) as caught:
            self.remote.generate(COMMAND, verified_scope=SCOPE)
        self.assertIsNone(caught.exception.decision.input_tokens)

    def test_shared_rejection_patch_on_temporary_copy_preserves_service_result(self):
        import importlib.util
        import pathlib
        import subprocess
        import sys
        import tempfile
        from notalone.application.reply_remote import ReplyRemoteRejected, _REJECTION_REASONS
        from notalone.application.assistant_session_service import AssistantSessionRejected
        from notalone.application.reply_service import ReplyService as OriginalReplyService, ReplyServiceRequest
        root = pathlib.Path(__file__).resolve().parents[4]
        relative = pathlib.Path('backend/src/notalone/application/reply_service.py')
        patch = root / '.scratch/dsh-ts-migration/reply-generation/reply-remote-rejection.patch'
        with tempfile.TemporaryDirectory(prefix='synthetic-reply-rejection-') as directory:
            copied = pathlib.Path(directory) / relative
            copied.parent.mkdir(parents=True)
            copied.write_bytes((root / relative).read_bytes())
            subprocess.run(['/usr/bin/patch', '-p1', '-i', str(patch)], cwd=directory, check=True, capture_output=True)
            name = 'synthetic_patched_reply_service'
            spec = importlib.util.spec_from_file_location(name, copied)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                spec.loader.exec_module(module)
                class Port:
                    def prepare(self, **kwargs):
                        raise ReplyRemoteRejected(reason)
                    generate = prepare
                request = module.ReplyServiceRequest(idempotency_key=uid(70), content=RewriteDraft('合成原稿'), skill_disabled=True)
                service = module.ReplyService(binding_lookup=lambda *_: None, conversation_factory=lambda _: None,
                    manual_scope_lookup=lambda *_: SCOPE, reply=Port())
                for reason in _REJECTION_REASONS:
                    for prepare_only in (False, True):
                        result = service.generate(owner_id=SCOPE.owner_id, contact_id=SCOPE.contact_id,
                            request=request, prepare_only=prepare_only)
                        self.assertTrue(result.rejected)
                        self.assertIsNone(result.reply)
                        self.assertEqual(result.reason, reason)
                        # 原08外层对拒绝结果执行同一转换。
                        wrapped = AssistantSessionRejected(result.reason)
                        self.assertEqual(wrapped.reason, reason)
                for coverage, reason in (('syncing', 'history_sync_pending'), ('incomplete', 'history_incomplete_confirmation_required')):
                    old = OriginalReplyService(binding_lookup=lambda *_: None, conversation_factory=lambda _: None,
                        history_coverage=lambda *_: coverage, reply=Port())
                    original = old.generate(owner_id=SCOPE.owner_id, contact_id=SCOPE.contact_id,
                        request=ReplyServiceRequest(idempotency_key=uid(71), content=RewriteDraft('合成原稿')))
                    self.assertEqual((original.reply, original.reason), (None, reason))
            finally:
                sys.modules.pop(name, None)

    def test_close_interrupts_inflight_and_rejects_new_requests(self):
        self.block = True
        errors = []
        def work():
            try:
                self.remote.generate(COMMAND, verified_scope=SCOPE)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=work); thread.start()
        self.assertTrue(self.received.wait(1)); self.remote.close(); thread.join(1)
        self.assertFalse(thread.is_alive()); self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ReplyRemoteUnavailable)
        with self.assertRaises(ReplyRemoteUnavailable):
            self.remote.generate(COMMAND, verified_scope=SCOPE)
        self.assertEqual(len(self.requests), 1)

    def test_deadline_does_not_retry_or_accept_late_result(self):
        self.block = True
        remote = RemoteReplyPort(url=f'http://127.0.0.1:{self.server.server_port}', token='synthetic-'*4, owner_id=uid(1), timeout=0.05)
        try:
            with self.assertRaises(ReplyRemoteUnavailable):
                remote.generate(COMMAND, verified_scope=SCOPE)
            self.assertEqual(len(self.requests), 1)
        finally:
            remote.close()

    def test_missing_or_nonloopback_configuration_is_unavailable(self):
        with self.assertRaises(ReplyRemoteUnavailable):
            RemoteReplyPort.from_environment({}, owner_id=uid(1))
        for url in ('https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.com:1234', 'http://127.0.0.1:1234/path'):
            with self.assertRaises(ValueError):
                RemoteReplyPort(url=url, token='synthetic-'*4, owner_id=uid(1))


if __name__ == '__main__':
    unittest.main()
