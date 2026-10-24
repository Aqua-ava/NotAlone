"""候选单一执行方及生命周期测试；只用合成服务和loopback。"""
import os
import socket
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch, Mock
from uuid import UUID

from notalone.application.reply_remote import RemoteReplyPort, ReplyRemoteUnavailable
from notalone.application.assistant_session_service import AssistantSessionService
from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.reply.interface import RewriteDraft, ReplyGenerated, ContextReceipt
from notalone.scopes import ContactScope, VerifiedConversationScope

OWNER, CONTACT, BINDING = (UUID(int=i) for i in (1, 2, 3))
SCOPE = VerifiedConversationScope(OWNER, CONTACT, BINDING)
ALLOWED_PORTS = set()
CONNECT = socket.socket.connect

def guarded_connect(sock, address):
    if (not isinstance(address, tuple) or address[0] != '127.0.0.1'
            or address[1] not in ALLOWED_PORTS):
        raise AssertionError('装配责任测试仅允许本用例loopback端口')
    return CONNECT(sock, address)

ENV = {'NOTALONE_TS_HOST': '1', 'NOTALONE_REPLY_RUNTIME': 'typescript',
       'NOTALONE_REPLY_REMOTE_URL': 'http://127.0.0.1:54321',
       'NOTALONE_REPLY_REMOTE_TOKEN': 'synthetic-private-token-' * 3}

class ReplyWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from notalone.application import reply_service
        from notalone.server import reply_wiring
        cls.service,cls.wiring=reply_service,reply_wiring

    def isolated(self, environment):
        stack = ExitStack()
        stack.enter_context(patch.dict(os.environ, environment, clear=True))
        stack.enter_context(patch('socket.socket.connect', new=guarded_connect))
        # 不运行旧生成/检索，也不触及任何真实数据库。
        for name in ('ReplyGenerator', 'LangChainReplyRuntime', 'PriorityReplyPort', 'RoundSkillSyncPort'):
            stack.enter_context(patch.object(self.wiring, name, side_effect=AssertionError('不得进入旧回复链')))
        stack.enter_context(patch.object(self.wiring, 'build_deepseek_model', return_value=SimpleNamespace(model_name='synthetic-08-model')))
        stack.enter_context(patch.object(self.wiring, 'build_deepseek_input_budget', return_value=None))
        stack.enter_context(patch.object(self.wiring, '_synchronize_skill_library', return_value=1))
        stack.enter_context(patch.object(self.wiring, 'build_skill_review_service', return_value=object()))
        stack.enter_context(patch.object(self.wiring, '_manual_scope_lookup', return_value=lambda *_: SCOPE))
        stack.enter_context(patch.object(self.wiring, '_active_binding_lookup', return_value=lambda *_: None))
        stack.enter_context(patch('notalone.persistence.reply_history_coverage.PostgresReplyHistoryCoverage',
                                  return_value=lambda *_: 'complete'))
        return stack

    def test_single_remote_for_prepare_generate_and_existing_08_candidate_path(self):
        with self.isolated(ENV):
            service = self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER,
                                                      model_priority=object())
            remote = service._reply
            self.assertIs(type(remote), RemoteReplyPort)
            self.assertIsInstance(service.exploration, self.wiring.ReplyExplorationService)
            self.assertIsInstance(service.exploration._runtime, self.wiring.LangChainExplorationRuntime)
            self.assertIsInstance(service.exploration._generation, self.wiring.AssistantExplorationGeneration)
            self.assertIs(service.exploration._generation._sessions()._reply, service)
            self.assertIsNotNone(service.skill_review)
            request = self.service.ReplyServiceRequest(UUID(int=4), RewriteDraft('合成原稿'), skill_disabled=True)
            outcome = ReplyGenerated(UUID(int=5), (), ContextReceipt(()), None)
            with patch.object(RemoteReplyPort, 'prepare', autospec=True, return_value=None) as prepare, \
                 patch.object(RemoteReplyPort, 'generate', autospec=True, return_value=outcome) as generate:
                service.generate(owner_id=OWNER, contact_id=CONTACT, request=request, prepare_only=True)
                service.generate(owner_id=OWNER, contact_id=CONTACT, request=request)
                store = Mock()
                store.require_prepared_format.return_value = None
                store.complete.return_value = 'synthetic-completed'
                sessions = AssistantSessionService(store=store, reply=service)
                sessions._generate_reserved(ContactScope(OWNER, CONTACT), UUID(int=6), UUID(int=7), request)
                self.assertEqual(prepare.call_count, 1)
                self.assertEqual(generate.call_count, 2)
                self.assertTrue(all(call.args[0] is remote for call in [*prepare.call_args_list, *generate.call_args_list]))
                # 原08准备路径也复用同一ReplyService，不另建生成器或许可。
                receipt = AssistantGenerationReceipt(UUID(int=6), UUID(int=7), request.idempotency_key, UUID(int=8), 'prepared')
                store.prepared_request.return_value = request
                sessions._fixed_receipt(ContactScope(OWNER, CONTACT), receipt)
                self.assertEqual(prepare.call_count, 2)
                self.assertIs(prepare.call_args.args[0], remote)
            with patch.object(RemoteReplyPort, 'close', autospec=True) as close:
                self.wiring.close_reply_service(service)
                close.assert_called_once_with(remote)

    def test_missing_invalid_or_conflicting_mode_never_falls_back(self):
        variants = []
        for key in ('NOTALONE_REPLY_REMOTE_URL', 'NOTALONE_REPLY_REMOTE_TOKEN', 'NOTALONE_TS_HOST'):
            value = dict(ENV);value.pop(key);variants.append(value)
        variants.extend([{**ENV, 'NOTALONE_REPLY_RUNTIME': 'python'}, {**ENV, 'NOTALONE_REPLY_RUNTIME': 'typo'},
                         {**ENV, 'NOTALONE_REPLY_REMOTE_URL': 'http://synthetic.invalid:54321'}])
        for environment in variants:
            with self.subTest(keys=sorted(environment)), self.isolated(environment):
                with self.assertRaises((ReplyRemoteUnavailable, ValueError)):
                    self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER)

    def test_unmigrated_mode_is_one_startup_choice_and_missing_08_does_not_disable_it_silently(self):
        sentinel = object()
        with patch.dict(os.environ, {}, clear=True), patch.object(self.wiring, '_build_reply_service', return_value=sentinel) as build:
            self.assertIs(self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER), sentinel)
            self.assertIsNone(build.call_args.kwargs['remote_reply'])
        with patch.dict(os.environ, ENV, clear=True), patch.object(self.wiring, '_build_reply_service', return_value=None), \
             patch.object(RemoteReplyPort, 'close', autospec=True) as close:
            with self.assertRaises(ReplyRemoteUnavailable):
                self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER)
            close.assert_called_once()

    def test_startup_failure_closes_new_remote_and_request_failure_does_not_fallback(self):
        with self.isolated(ENV), patch.object(self.wiring, '_active_binding_lookup', side_effect=RuntimeError('synthetic-init')):
            with patch.object(RemoteReplyPort, 'close', autospec=True) as close:
                with self.assertRaises(RuntimeError):
                    self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER)
                close.assert_called_once()
        with self.isolated(ENV):
            service = self.wiring.build_reply_service(database_url='synthetic-unused', owner_id=OWNER)
            request = self.service.ReplyServiceRequest(UUID(int=4), RewriteDraft('合成原稿'))
            with patch.object(RemoteReplyPort, 'generate', autospec=True, side_effect=ReplyRemoteUnavailable()) as generate:
                with self.assertRaises(ReplyRemoteUnavailable):
                    service.generate(owner_id=OWNER, contact_id=CONTACT, request=request)
                generate.assert_called_once()
            self.wiring.close_reply_service(service)

    def test_real_loopback_from_built_service_candidateflow_and_continuation(self):
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from tests.unit.application.test_reply_remote import result
        from notalone.application.assistant_continuation import AssistantContinuationReplyRequest
        calls=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path,self.headers.get('Authorization'),body))
                response={'verified_scope':body['verified_scope']}
                response.update({'prepared':True,'receipt':{'format':'synthetic'}} if self.path.endswith('/prepare') else {'reply':result()})
                encoded=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);port=server.server_address[1]
        ALLOWED_PORTS.add(port);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with self.isolated({**ENV,'NOTALONE_REPLY_REMOTE_URL':f'http://127.0.0.1:{port}'}):
                service=self.wiring.build_reply_service(database_url='synthetic-unused',owner_id=OWNER,model_priority=object())
                remote=service._reply
                request=self.service.ReplyServiceRequest(UUID(int=4),RewriteDraft('合成原稿'),skill_disabled=True)
                self.assertIsNone(service.generate(owner_id=OWNER,contact_id=CONTACT,request=request,prepare_only=True).reason)
                generated=service.generate(owner_id=OWNER,contact_id=CONTACT,request=request).reply
                self.assertEqual(generated.reply_request_id,UUID(int=5))
                store=Mock();store.complete.side_effect=lambda scope,session,turn,outcome:outcome
                store.require_prepared_format.return_value=None
                continuation=AssistantContinuationReplyRequest(idempotency_key=UUID(int=20),content=RewriteDraft('合成续写'),skill_disabled=True,continuation={'synthetic':'private-context'})
                continuation_store=Mock();continuation_store.reserve_continuation.return_value=SimpleNamespace(turn_id=UUID(int=21),request=continuation)
                sessions=AssistantSessionService(store=store,reply=service,continuation_store=continuation_store)
                output=sessions.continue_completed(owner_id=OWNER,contact_id=CONTACT,session_id=UUID(int=22),command=object())
                self.assertEqual(output.reply_request_id,UUID(int=5))
                self.assertIs(service._reply,remote)
                self.assertEqual([c[0] for c in calls],['/internal/reply/prepare','/internal/reply/generate','/internal/reply/generate'])
                self.assertTrue(all(c[1]=='Bearer '+ENV['NOTALONE_REPLY_REMOTE_TOKEN'] for c in calls))
                last=calls[-1][2]
                self.assertNotIn('continuation',last['request'])
                self.assertEqual(last['internal']['authenticatedContinuation']['continuation'],continuation.continuation)
                self.wiring.close_reply_service(service)
                with self.assertRaises(ReplyRemoteUnavailable):service.generate(owner_id=OWNER,contact_id=CONTACT,request=request)
                self.assertEqual(len(calls),3)
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2);ALLOWED_PORTS.remove(port)
            self.assertFalse(thread.is_alive())

    def test_command_closes_remote_before_model_stop_on_normal_and_startup_failure(self):
        from notalone.server import command
        from notalone.application import organization_runtime
        for stage in ('normal','memory','app'):
            with self.subTest(stage=stage),self.isolated(ENV),ExitStack() as stack:
                service=self.wiring.build_reply_service(database_url='synthetic-unused',owner_id=OWNER,model_priority=object())
                remote=service._reply;order=[];priority=Mock();priority.stop.side_effect=lambda:order.append('priority-stop')
                original_close=RemoteReplyPort.close
                def close(actual):
                    self.assertIs(actual,remote);order.append('remote-close');original_close(actual)
                stack.enter_context(patch.object(RemoteReplyPort,'close',autospec=True,side_effect=close))
                stack.enter_context(patch.dict(os.environ,NOTALONE_DATABASE_URL='synthetic-unused',NOTALONE_OWNER_ID=str(OWNER)))
                for name,value in {'load_project_env':None,'extraction_batch_concurrency':1,'has_active_backend':False,
                    '_build_sync_host':None,'_build_wechat_setup_service':None,'build_reply_service':service,
                    '_build_import_service':None,'_build_skill_service':None,'_build_ledger_service':None,
                    'remove_backend_info':None,'_serve_until_stopped':None}.items():
                    stack.enter_context(patch.object(command,name,return_value=value))
                stack.enter_context(patch.object(command,'ModelPriorityControl',return_value=priority))
                stack.enter_context(patch.object(command,'_build_task_host',return_value=None))
                stack.enter_context(patch.object(organization_runtime,'build_layered_memory_service',return_value=Mock()))
                stack.enter_context(patch.object(command,'_build_memory_service',side_effect=RuntimeError('synthetic-startup') if stage=='memory' else None,return_value=None))
                def app(**kwargs):
                    if stage=='app':raise ValueError('synthetic-config')
                    return SimpleNamespace(runtime_shutdown=kwargs['runtime_shutdown'])
                stack.enter_context(patch.object(command,'create_app',side_effect=app))
                def backend(app,**kwargs):return SimpleNamespace(start=lambda:('127.0.0.1',54321),shutdown=app.runtime_shutdown)
                stack.enter_context(patch.object(command,'BackendServer',side_effect=backend))
                args=SimpleNamespace(sync_interval=1,host='127.0.0.1',port=0)
                if stage=='memory':
                    with self.assertRaisesRegex(RuntimeError,'synthetic-startup'):command._run(args,Mock())
                else:self.assertEqual(command._run(args,Mock()),0 if stage=='normal' else 2)
                self.assertEqual(order[:2],['remote-close','priority-stop'])
                with self.assertRaises(ReplyRemoteUnavailable):remote._request('generate',{})

    def test_remote_business_reasons_preserve_result_for_prepare_and_generate(self):
        from notalone.application.reply_remote import ReplyRemoteRejected, _REJECTION_REASONS
        with self.isolated(ENV):
            service=self.wiring.build_reply_service(database_url='synthetic-unused',owner_id=OWNER)
            request=self.service.ReplyServiceRequest(UUID(int=4),RewriteDraft('合成原稿'),skill_disabled=True)
            for reason in _REJECTION_REASONS:
                for prepare_only in (False,True):
                    with self.subTest(reason=reason,prepare=prepare_only),patch.object(RemoteReplyPort,'prepare' if prepare_only else 'generate',side_effect=ReplyRemoteRejected(reason)):
                        result=service.generate(owner_id=OWNER,contact_id=CONTACT,request=request,prepare_only=prepare_only)
                        self.assertIsNone(result.reply);self.assertEqual(result.reason,reason)
            self.wiring.close_reply_service(service)

if __name__ == '__main__':
    unittest.main()
