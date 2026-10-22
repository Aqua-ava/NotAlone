"""真实审核装配、图、预算和SDK的本地传输合同；不调用外部服务。"""

import asyncio
import copy
from dataclasses import replace
from functools import partial
import json
import os
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_deepseek import ChatDeepSeek

from tests.support.ledger_adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.input_budget import (
    InputBudgetProfile, InputComponent, InputTokenMeasurement, TokenMeasurementKind,
)
from notalone.server.reply_wiring import build_skill_review_service
from notalone.skills.learning import SkillLearningInvalid
from notalone.skills.models import SkillCatalog
from tests.unit.reply.test_input_budget_runtime import prepared_context, SCOPE, BINDING_ID


class MockDispatchStopped(BaseException):
    """端点、派发数或时限越界后立即停止，不能被SDK重试。"""


class ReviewContext:
    def __init__(self):
        self.builds = 0
        self.deleted = False

    def build(self, *, command, **_):
        self.builds += 1
        base = prepared_context()
        return replace(base, command=command, current_text=command.content.draft_text)

    def validate_current(self, context):
        if self.deleted:
            raise SkillLearningInvalid()


class ReviewStore:
    def __init__(self):
        self.comparison_id = uuid4()
        self.calls = []
        self.state = 'pending'
        self.draft = {'draft_id': str(uuid4()), 'logical_skill_id': str(uuid4()),
            'target_versions': [], 'sanitized_strategy': {'name': 'careful-response',
            'description': '先核对再回应', 'document':
                '---\nname: careful-response\ndescription: 先核对再回应\n---\n先区分已知与推测。'}}

    def begin_comparison(self, scope, **command):
        self.command = command
        self.state = 'running'
        return self.draft, {'id': self.comparison_id, 'run_token': uuid4(),
            'library_revision': 0, 'input': command['input']}, False

    def validate_comparison(self, *args, with_execution_view=False):
        if self.state != 'running':
            raise SkillLearningInvalid()

    def record_call(self, scope, comparison_id, side, entry_id):
        self.calls.append((side, entry_id))

    def finish_comparison(self, scope, comparison_id, token, fingerprint, result):
        self.state = 'completed'
        return result

    def fail_comparison(self, *args):
        self.state = 'failed'


class EmptySkills:
    def for_scene(self, scene):
        return self

    def catalog(self, scope):
        return SkillCatalog(scope, 0, ())


class BodyCounter:
    """仅比较完整JSON表示，字符计数是合成协议，不是供应商token或上界。"""
    def __init__(self, model):
        self.model = model
        self.bodies = []

    def is_bound_to(self, model):
        return model is self.model

    def measure(self, request):
        messages = copy.deepcopy(list(request.messages))
        if request.system_message is not None:
            messages.insert(0, copy.deepcopy(request.system_message))
        body = {**copy.deepcopy(dict(request.model_settings)), 'model': request.model_id,
                'messages': messages, 'tools': copy.deepcopy(list(request.tool_schemas))}
        if request.response_schema is not None:
            body['response_format'] = copy.deepcopy(request.response_schema)
        self.bodies.append(body)
        return InputTokenMeasurement(model_id=request.model_id,
            input_tokens=len(json.dumps(body, ensure_ascii=False)) + 17,
            kind=TokenMeasurementKind.EXACT, measurement_id='synthetic-review-body-v1',
            covered_components=frozenset(InputComponent))


class ReviewSdkTransportTest(unittest.TestCase):
    def test_production_reply_builder_sets_zero_retries_and_preserves_ecnu_configuration(self):
        from notalone.server.reply_wiring import build_reply_service
        for environment, expected in (({}, {'thinking': {'type': 'disabled'}}),
            ({'NOTALONE_DEEPSEEK_MODEL': 'ecnu-max',
              'NOTALONE_DEEPSEEK_BASE_URL': 'https://chat.ecnu.edu.cn/open/api/v1'}, None)):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), patch(
                'notalone.server.reply_wiring.build_deepseek_model', side_effect=ValueError()) as build:
                self.assertIsNone(build_reply_service(database_url='synthetic-unused', owner_id=SCOPE.owner_id))
                build.assert_called_once_with(max_retries=0, extra_body=expected)

    def exercise(self, case='success', *, capacity=200000, known_budget=True,
                 mismatch=False, extra_body=None):
        context, store, ledger = ReviewContext(), ReviewStore(), InMemoryOutboundLedger()
        requests = []
        started = time.monotonic()
        counter = None

        def tool(name, arguments, identifier):
            return {'id': identifier, 'type': 'function', 'function': {
                'name': name, 'arguments': json.dumps(arguments)}}

        def respond(request):
            if (str(request.url) != 'http://127.0.0.1:1/v1/chat/completions'
                    or request.method != 'POST' or len(requests) >= 3
                    or time.monotonic() - started >= 15):
                raise MockDispatchStopped('审核Mock超出固定端点、3次或15秒。')
            body = json.loads(request.content)
            requests.append(body)
            evidence = os.environ.get('NOTALONE_REVIEW_SDK_EVIDENCE')
            if evidence:
                # 私有运行者事前建立0600文件并单独限制整批派发额度。
                with open(evidence, encoding='utf-8') as previous:
                    if sum(1 for _ in previous) >= 32:
                        raise MockDispatchStopped('本批SDK Mock总派发达到32。')
                descriptor = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'a', encoding='utf-8') as output:
                    output.write(json.dumps({'case': case, 'body': body,
                        'budget': counter.bodies[-1] if counter.bodies else None}, ensure_ascii=False) + '\n')
                    output.flush()
                    os.fsync(output.fileno())
            if case == '500':
                return httpx.Response(500, json={'error': {'message': 'synthetic failure'}})
            human = json.loads(next(m['content'] for m in body['messages'] if m['role'] == 'user'))
            selected = human['skill_selection'].get('version_id')
            already_read = any(m['role'] == 'tool' for m in body['messages'])
            if selected and not already_read:
                path = '/notalone/reply-skills/careful-response/SKILL.md'
                if case == 'read_failure':
                    path = '/notalone/reply-skills/another/SKILL.md'
                calls = [tool('read_file', {'file_path': path}, 'read-synthetic')]
            else:
                citation = str(uuid4()) if case == 'citation' else human['evidence'][0]['evidence_id']
                calls = [tool('ReplyRuntimeOutput', {'candidates': [{'text': '先核对，再回应。',
                    'basis': '保持用户本次意图。', 'citation_ids': [citation], 'risk_notes': []}],
                    'used_skill_version_id': selected}, 'output-synthetic')]
                if case == 'wrong_tool':
                    calls[0]['function']['arguments'] = json.dumps({'invalid': True})
                if case == 'multiple':
                    calls.append(tool('ReplyRuntimeOutput', {}, 'extra-synthetic'))
                if case == 'free_text':
                    calls = []
            if case == 'delete' and len(requests) == 2:
                context.deleted = True
            message = {'role': 'assistant', 'content': '自由正文' if case == 'free_text' else ''}
            if calls:
                message['tool_calls'] = calls
            return httpx.Response(200, json={'id': 'synthetic-review', 'object': 'chat.completion',
                'created': 1, 'model': 'deepseek-chat', 'choices': [{'index': 0,
                    'finish_reason': 'tool_calls' if calls else 'stop', 'message': message}],
                'usage': {'prompt_tokens': 5, 'completion_tokens': 2, 'total_tokens': 7}})

        sync = httpx.Client(transport=httpx.MockTransport(respond), trust_env=False)
        asynchronous = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
        try:
            with patch.dict(os.environ, {'LANGSMITH_TRACING': 'false', 'LANGCHAIN_TRACING_V2': 'false',
                                        'NOTALONE_DISABLE_DOTENV': '1', 'NOTALONE_ENV_FILE': '/dev/null'}), patch(
                'notalone.reply.adapters.deepseek_provider.ChatDeepSeek',
                partial(ChatDeepSeek, http_async_client=asynchronous),
            ):
                model = build_deepseek_model(api_key='synthetic-unused-review-key',
                    base_url='http://127.0.0.1:1/v1', model_name='deepseek-chat',
                    extra_body=extra_body if extra_body is not None else {'thinking': {'type': 'disabled'}},
                    http_client=sync, max_retries=0, timeout_seconds=1)
                counter = BodyCounter(model if not mismatch else object())
                profile = InputBudgetProfile(model_id=model.model_name, context_window_tokens=capacity,
                    output_reserve_tokens=1024, warning_ratio=0.8, measurement_kind=TokenMeasurementKind.EXACT,
                    measurement_id='synthetic-review-body-v1') if known_budget else None
                with patch('notalone.persistence.skill_review.PostgresSkillReviewStore', return_value=store), patch(
                    'notalone.server.reply_wiring._active_binding_lookup',
                    return_value=lambda *args: SimpleNamespace(binding_id=BINDING_ID)), patch(
                    'notalone.server.reply_wiring.PostgresSkillPort', return_value=EmptySkills()), patch(
                    'notalone.server.reply_wiring.PostgresOutboundLedger', return_value=ledger):
                    service = build_skill_review_service(database_url='synthetic-unused-storage',
                        model=model, context=context, model_priority=None, input_budget_profile=profile,
                        input_token_counter=counter if known_budget else None, on_input_budget=None)
                    command = {'draft_id': uuid4(), 'expected_revision': 1, 'operation_key': uuid4(),
                        'input': {'incoming_text': '合成输入', 'intent': '先核实', 'scene': '核对安排'},
                        'scope_confirmation': {'kind': 'contact', 'contact_id': str(SCOPE.contact_id), 'scene': None}}
                    if case == 'success' and known_budget and not mismatch and capacity > 10000 and extra_body is None:
                        result = service.compare(SCOPE, **command)
                        self.assertEqual(result['after']['load_state'], 'loaded')
                        self.assertEqual(store.state, 'completed')
                    else:
                        with self.assertRaises(Exception):
                            service.compare(SCOPE, **command)
                        self.assertEqual(store.state, 'failed')
        finally:
            sync.close()
            asyncio.run(asynchronous.aclose())
        self.assertTrue(sync.is_closed and asynchronous.is_closed)
        self.assertEqual(context.builds, 1)
        self.assertEqual(len(requests), len(ledger.list_by_owner(SCOPE.owner_id)))
        for actual, measured in zip(requests, counter.bodies):
            self.assertEqual(actual, measured)
            self.assertEqual(actual['thinking'], {'type': 'disabled'})
            self.assertEqual(actual['tool_choice'], 'required')
            self.assertEqual(actual['model'], 'deepseek-chat')
            self.assertEqual(actual['max_tokens'], 1024)
        return requests, store, ledger, counter

    def test_same_frozen_input_and_each_sdk_body_match_the_budget(self):
        requests, store, ledger, counter = self.exercise()
        self.assertEqual(len(requests), 3)
        self.assertEqual([side for side, _ in store.calls], ['before', 'after', 'after'])
        before, after = [json.loads(requests[i]['messages'][1]['content']) for i in (0, 1)]
        before.pop('skill_selection')
        after.pop('skill_selection')
        self.assertEqual(before, after)

    def test_http500_is_one_physical_dispatch_and_one_failed_side_ledger(self):
        requests, store, ledger, _ = self.exercise('500')
        self.assertEqual(len(requests), 1)
        self.assertEqual([side for side, _ in store.calls], ['before'])
        self.assertEqual(ledger.list_by_owner(SCOPE.owner_id)[0].outcome, LedgerOutcome.RUN_FAILED)

    def test_unknown_binding_overrides_and_capacity_reject_locally_without_ledger(self):
        for options in ({'known_budget': False}, {'mismatch': True}, {'capacity': 1050},
                        *({'extra_body': {field: value}} for field, value in (
                            ('model', 'other'), ('messages', []), ('tools', []), ('max_tokens', 2)))):
            with self.subTest(options=options):
                requests, store, _, _ = self.exercise(**options)
                self.assertEqual(requests, [])
                self.assertEqual(store.calls, [])

    def test_strict_output_and_citations_cannot_publish_or_escape_the_frozen_input(self):
        for case in ('wrong_tool', 'multiple', 'free_text', 'citation', 'read_failure', 'delete'):
            with self.subTest(case=case):
                requests, store, _, _ = self.exercise(case)
                self.assertLessEqual(len(requests), 3 if case == 'read_failure' else 2)
                self.assertEqual(store.state, 'failed')
