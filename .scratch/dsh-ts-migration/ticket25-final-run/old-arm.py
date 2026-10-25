"""冻结旧源码的真实业务管线；只把 SDK 公共 HTTP transport 路由到本机供应商。"""
from __future__ import annotations

import asyncio
import dataclasses
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import time
from uuid import UUID, uuid4
from langchain_core.callbacks import BaseCallbackHandler
from langchain_deepseek import ChatDeepSeek

sys.path.insert(0, sys.argv[1])
os.environ['NOTALONE_DISABLE_DOTENV'] = '1'
import httpx
from bridge import reserve_request
import psycopg
from notalone.reply.adapters import chat_json_input_budget as input_budget_module
from notalone.application.reply_service import ReplyService, ReplyServiceRequest
from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import RewriteDraft
from notalone.scopes import VerifiedConversationScope, ContactScope
from notalone.server.reply_wiring import _manual_scope_lookup
from notalone.application.manual_input_scope import manual_input_contact


def guard(event, args):
    if event == 'socket.connect' and args[0].family != socket.AF_UNIX:
        if not isinstance(args[1], tuple) or args[1][0] != '127.0.0.1':
            raise RuntimeError('本机 pilot 禁止外网连接。')


sys.addaudithook(guard)


def streaming_configuration(model, profile, base_url):
    """采集器扩展：让同一完整请求计量绑定显式 stream:true。

    旧产品计量器按设计只接受非流式模型。Ticket 25 对流式首 token 做对照时，
    仅移除该布尔值拒绝；地址、SDK 客户端、有效默认字段及完整 JSON 摘要仍按
    原实现逐项核验，stream:true 也会进入配置摘要和被计量的请求正文。
    """
    from notalone.reply.adapters.thinking_deepseek import ThinkingDeepSeek
    if type(model) not in (ChatDeepSeek, ThinkingDeepSeek) or model.model_name != profile.model_id:
        raise ValueError('输入估算仅支持已批准的模型适配器。')
    if (
        model.use_responses_api
        or (model.api_base is not None and str(model.api_base).rstrip('/') != base_url)
    ):
        raise ValueError('输入估算的配置接收地址不匹配。')
    roots = (model.root_client, model.root_async_client)
    endpoints = (model.client, model.async_client)
    if any(str(root.base_url).rstrip('/') != base_url for root in roots):
        raise ValueError('输入估算的实际 SDK 接收地址不匹配。')
    if any(endpoint._client is not root for endpoint, root in zip(endpoints, roots)):
        raise ValueError('输入估算未绑定实际 SDK 客户端。')
    defaults = dict(model._get_request_payload([]))
    extra = defaults.pop('extra_body', None)
    if extra:
        from notalone.reply.adapters.deepseek_provider import approved_thinking_body
        if not approved_thinking_body(model, extra) or 'thinking' in defaults:
            raise ValueError('输入估算的附加正文尚未核实。')
        defaults.update(extra)
    if (not isinstance(defaults, dict)
            or set(defaults) - input_budget_module._REQUEST_FIELDS):
        raise ValueError('SDK 请求字段尚未纳入输入估算。')
    digest = hashlib.sha256(input_budget_module._json_bytes(defaults)).digest()
    return (*map(id, roots), *map(id, endpoints), digest)


# 旧臂默认使用 ChatDeepSeek；导入后固定核验被替换的只是这一项流式拒绝。
assert 'model.use_responses_api or model.streaming' in (
    __import__('inspect').getsource(input_budget_module._configuration)
)
input_budget_module._configuration = streaming_configuration


class LocalTransport(httpx.HTTPTransport):
    def __init__(self, endpoint, budget, observe):
        super().__init__(retries=0, limits=httpx.Limits(max_keepalive_connections=0))
        self.endpoint = endpoint
        self.budget = budget
        self.observe = observe

    def handle_request(self, request):
        request.url = httpx.URL(self.endpoint + '/python/chat/completions')
        if self.budget is not None:
            reserve_request(self.budget, request)
        elif os.environ.get('NOTALONE_COMPARISON_LOCAL_ONLY') != '1':
            raise RuntimeError('budget_configuration_required')
        self.observe('network_start', transport='sync')
        return super().handle_request(request)


class LocalAsyncTransport(httpx.AsyncHTTPTransport):
    def __init__(self, endpoint, budget, observe):
        super().__init__(retries=0, limits=httpx.Limits(max_keepalive_connections=0))
        self.endpoint = endpoint
        self.budget = budget
        self.observe = observe

    async def handle_async_request(self, request):
        request.url = httpx.URL(self.endpoint + '/python/chat/completions')
        if self.budget is not None:
            reserve_request(self.budget, request)
        elif os.environ.get('NOTALONE_COMPARISON_LOCAL_ONLY') != '1':
            raise RuntimeError('budget_configuration_required')
        self.observe('network_start', transport='async')
        return await super().handle_async_request(request)


def encode(value):
    if dataclasses.is_dataclass(value):
        return {field.name: encode(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {str(k): encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [encode(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if hasattr(value, 'value'):
        return value.value
    return value


def run(data):
    name = data['database']
    assert name.startswith('notalone_ts_host_') and name.endswith('_test')
    db = 'host=/tmp dbname=' + name
    scope = ContactScope(UUID(data['scope']['owner_id']), UUID(data['scope']['contact_id']))
    binding = UUID(data['scope']['conversation_binding_id'])
    verified = VerifiedConversationScope(scope.owner_id, scope.contact_id, binding)
    primary = json.loads(Path(__file__).with_name('primary.json').read_text())
    content=data['body']['content']
    member=next((m for m in primary['cases'] if m['generation_input']['current_intent']==content['draft_text'] and json.loads(content['context_text'])=={k:v for k,v in m['generation_input'].items() if k in ['available_facts','current_message','recent_context']} and json.loads(content['user_instruction'])=={k:v for k,v in m['generation_input'].items() if k in ['unknowns','allowed_changes']}),None)
    if member is None: raise ValueError('primary_frozen_case_unknown')
    primary_ids=tuple(UUID(member['evidence_ids'][kind]) for kind in ['user_purpose','user_draft','user_current_chat'])
    primary_id_queue={}
    saved = []
    events = []
    started_ns = None

    def observe(kind, **details):
        if started_ns is not None:
            events.append({'type': kind, 'at_ms': (time.perf_counter_ns() - started_ns) / 1e6,
                           **details})

    def model_response(_prepared, _model, _message):
        # 原runtime公开回调只在完整非流式SDK响应后触发；没有首token证据。
        observe('sdk_complete_message')

    class ToolObserver(BaseCallbackHandler):
        def on_tool_start(self, serialized, input_str, **kwargs): observe('tool_start_'+serialized.get('name','unknown'))
        def on_tool_end(self, output, **kwargs):
            if '[Skill 不可用]' in str(output): observe('actual_read_file_scope_denied')
        def on_llm_new_token(self, token, **kwargs):
            observe('first_token' if not token_seen else 'model_token',
                    is_token_delta=bool(str(token)), token_length=len(str(token)))
            if not token_seen: token_seen.append(True)
        def on_llm_end(self, response, **kwargs):
            observe('network_end', sdk='langchain')

    class ObservedContext(RetrievalReplyContext):
        def build(self, *args, **kwargs):
            # 旧workspace先构造再丢弃一个默认draft；不把该nonce误当用户证据。
            prefix=([uuid4()] if kwargs.get('reply_request_id') is None else [])+[uuid4()]
            primary_id_queue['ids']=iter([*prefix,*primary_ids])
            observe('context_build_start')
            try:
                built=super().build(*args, **kwargs)
                if tuple(e.evidence_id for e in built.evidence)!=primary_ids or tuple(e.kind for e in built.evidence)!=('user_purpose','user_draft','user_current_chat') or built.layered_context is not None or built.owner_layered_context is not None:
                    raise ValueError('primary_extra_legacy_context')
                return built
            finally:
                observe('context_build_end')

        def validate_current(self, *args, **kwargs):
            observe('context_validate_start')
            try:
                return super().validate_current(*args, **kwargs)
            finally:
                observe('context_validate_end')

    class ObservedStore(PostgresReplyStore):
        def save(self, *args, **kwargs):
            observe('persistence_start')
            start = time.perf_counter_ns()
            result = super().save(*args, **kwargs)
            saved.append({'name': 'store.save', 'started_ns': start,
                          'ended_ns': time.perf_counter_ns()})
            observe('persistence_end')
            return result

    token_seen=[]
    async_client = httpx.AsyncClient(transport=LocalAsyncTransport(data['provider'], data['problem_budget'], observe), trust_env=False)
    with httpx.Client(transport=LocalTransport(data['provider'], data['problem_budget'], observe), trust_env=False) as client:
        model = build_deepseek_model(api_key='synthetic-unused', model_name='deepseek-flash',
            base_url='https://api.deepseek.com', timeout_seconds=10, max_retries=0,
            extra_body={'thinking': {'type': 'disabled'}},
            http_client=client, http_async_client=async_client)
        assert model.max_retries == model.root_client.max_retries == model.root_async_client.max_retries == 0
        # 先声明流式，让输入计量摘要包含实际 stream:true。
        model.streaming = True
        model.temperature = primary['controls']['temperature']
        model.max_tokens = primary['controls']['max_output_tokens']
        model.top_p = primary['controls']['top_p']
        model.stop = primary['controls']['stop']
        capability = build_deepseek_input_budget(model)
        assert capability is not None
        profile, counter = capability
        retrieval = PostgresRetrieval(db, owner_memory_store=PostgresOwnerMemoryStore(db))
        store = ObservedStore(db)
        generator = ReplyGenerator(store=store, ledger=PostgresOutboundLedger(db),
            context=ObservedContext(retrieval=retrieval, skill_library_revision=0,id_factory=lambda:next(primary_id_queue['ids'])),
            runtime=LangChainReplyRuntime(model=model, skill_port=PostgresSkillPort(db),
                retrieval=retrieval, timeout_seconds=10,
                input_budget_profile=profile, input_token_counter=counter,
                on_model_response=model_response,model_callbacks=(ToolObserver(),)))
        service = ReplyService(binding_lookup=lambda *_: None,
            conversation_factory=lambda *_: (_ for _ in ()).throw(AssertionError('只用合成手动确认')),
            manual_scope_lookup=_manual_scope_lookup(db),
            reply=generator)
        priority = ModelPriorityControl()
        content = data['body']['content']
        request = ReplyServiceRequest(idempotency_key=UUID(data['body']['idempotency_key']),
            content=RewriteDraft(draft_text=content['draft_text'], input_kind='workspace',
                workspace_action='express', include_relationship_context=True,
                context_text=content.get('context_text'),
                user_instruction=content.get('user_instruction')), skill_disabled=True)
        start = time.perf_counter_ns()
        started_ns = start
        observe('business_service_start', at_ms=0,
                wall_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
        token = manual_input_contact.set(scope.contact_id)
        try:
            with priority.foreground():
                observe('queue_end')
                result = service.generate(owner_id=scope.owner_id, contact_id=scope.contact_id, request=request)
            returned = time.perf_counter_ns()
            observe('business_service_end', outcome='succeeded')
        except Exception as error:
            observe('business_service_end', outcome='failed', error_type=type(error).__name__)
            return {
                'status': 'failed', 'error_type': type(error).__name__, 'error': str(error),
                'business_observed_ms': (time.perf_counter_ns() - start) / 1e6,
                'partial_observations': {
                    'clock': 'python_service_relative_monotonic', 'events': events,
                    'wall_started_at': next((event.get('wall_at') for event in events
                                            if event['type'] == 'business_service_start'), None),
                    'first_event_ms': next((event['at_ms'] for event in events
                                            if event['type'] == 'network_start'), None),
                    'first_token_ms': next((event['at_ms'] for event in events
                                            if event['type'] == 'first_token'), None),
                    'first_event_kind': 'stream_request_send',
                    'token_definition': 'langchain_on_llm_new_token',
                    'complete_five_phase_partition': True},
            }
        finally:
            manual_input_contact.reset(token)
            asyncio.run(async_client.aclose())
        assert result.reply is not None, result.reason
        stored = store.read(result.reply.reply_request_id, scope)
        assert stored.result == result.reply
        with psycopg.connect(db) as connection:
            rows = connection.execute('SELECT candidate_text FROM reply_candidate WHERE reply_request_id=%s ORDER BY id',
                                      (result.reply.reply_request_id,)).fetchall()
        return {'status': 'succeeded', 'result': encode(result.reply),
                'persisted_candidates': len(rows), 'stored_result_equal': True,
                'evidence': encode(stored.evidence),
                'business_observed_ms': (returned - start) / 1e6,
                'partial_observations': {
                    'clock': 'python_service_relative_monotonic', 'events': events,
                    'wall_started_at': next((event.get('wall_at') for event in events
                                            if event['type'] == 'business_service_start'), None),
                    'first_event_ms': next((event['at_ms'] for event in events
                                            if event['type'] == 'network_start'), None),
                    'first_token_ms': next((event['at_ms'] for event in events
                                            if event['type'] == 'first_token'), None),
                    'first_event_kind': 'stream_request_send',
                    'token_definition': 'langchain_on_llm_new_token',
                    'complete_five_phase_partition': True},
                'raw_spans': [{**span, 'started_ms': (span['started_ns'] - start) / 1e6,
                               'ended_ms': (span['ended_ns'] - start) / 1e6} for span in saved],
                'sdk': {'model': model.model_name, 'max_retries': model.max_retries,
                        'root_max_retries': model.root_client.max_retries,
                        'async_root_max_retries': model.root_async_client.max_retries,
                        'max_tokens': model.max_tokens,
                        'versions': {name: importlib.metadata.version(name) for name in
                                     ('httpx', 'openai', 'langchain', 'langchain-deepseek', 'deepagents')}},
                'runtime_source_sha256': hashlib.sha256(Path(sys.modules[LangChainReplyRuntime.__module__].__file__).read_bytes()).hexdigest()}


for line in sys.stdin:
    try:
        result = run(json.loads(line))
    except Exception as error:
        result = {'status': 'failed', 'error_type': type(error).__name__, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
