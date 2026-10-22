"""对修复后冻结源码进行真实模型全链路验收；仅使用合成资料与自有测试库。"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import traceback
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
import httpx2
import psycopg

from notalone.runtime_config import load_project_env
from notalone.problem_budget import ProblemBudget, check_problem_budget
from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, atomic_json
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, HttpBackend

INITIAL = [
    '我的生日是5月8日。',
    '2024年实习期间，我每周三都不能接电话。实习去年就结束了，结束后周三能不能接电话，我还没有说过。',
    '我平时最喜欢喝乌龙茶，日常一般都选乌龙茶。',
    '我妹妹喜欢攀岩，我自己不玩攀岩。',
    (True, '你说的是平时都不吃辣，还是只有周末在家吃饭时不吃辣？'),
    (False, '后者，其他时候我没说过。'),
]
UPDATED = ['更正一下，我的生日是5月18日，不是5月8日。',
           '我的日常口味改了：以后喝红茶，不再选乌龙茶。但晚上我不喝含咖啡因的饮料。']
REPLIES = [
    ('empty_history', '谢谢你今天帮忙整理资料。', None, False),
    ('negation', '表示理解，不催促，不约定下次见面的时间。',
     '对方说：不是不想见你，只是这周工作太忙了。', True),
    ('current_memory', '想约对方白天喝茶，顺便核对对方现在的茶饮偏好和生日日期，再定时间。',
     '请结合我们已有的资料。不要替我声明我记得某件事，不要凭空补充一起经历过的事情。', True),
    ('explicit_memory', '我记得你说过现在改喝红茶了，我白天有空，想问问你愿不愿意一起喝茶。',
     '只询问意愿，不增加已经约定见面或以后随时陪伴的承诺。', True),
    ('evening_condition', '今晚想请对方喝点东西，结合已知饮品偏好给出合适的邀请。',
     '只提出邀请，不加入我没表达的记得，不增加已经约定见面或以后随时陪伴的承诺。', True),
    ('historical_subject', '想核对对方现在周三是否方便通话，以及本人是否玩攀岩，再决定是否邀约。',
     '结合已有资料，未知的部分询问，不把历史限制当成现在的安排。', True),
]


def scrub(value):
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items()
                if key not in {'reasoning_content', 'reasoning', 'analysis'}}
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value


class Database(CoreBusinessFlowFixture, unittest.TestCase):
    pass


class Capture:
    def __init__(self, output, suite, owner, run, case, host):
        self.output, self.suite = output, suite
        self.owner, self.run, self.case, self.host = owner, run, case, host
        self.lock, self.calls, self.stage = threading.Lock(), [], 'setup'

    def begin(self, request):
        if request.url.host != self.host:
            raise RuntimeError('验收不允许连接未授权的模型主机。')
        payload = json.loads(request.read())
        phase = 'model'
        tools = [tool.get('function', {}).get('name') for tool in payload.get('tools', [])]
        system = str(payload.get('messages', [{}])[0].get('content', ''))
        if tools == ['DirectMemoryExtractionOutput']:
            phase = 'l1_extraction'
        elif tools == ['SourceVerificationOutput']:
            phase = 'l1_verification'
        elif tools == ['BatchMemoryAdjudicationOutput']:
            phase = 'l1_adjudication'
        elif '画像' in system or 'profile.md' in system:
            phase = 'profile'
        elif '场景' in system or 'SOURCES' in system:
            phase = 'scene'
        if 'ReplyRuntimeOutput' in tools:
            phase = 'reply'
        from notalone.memory.organization_quality_transport import _CURRENT_ORGANIZATION
        from notalone.memory.organization_sdk import PROFILE_PROMPT
        reservation = None
        if _CURRENT_ORGANIZATION.get() is not None:
            human = {}
            for message in payload.get('messages', []):
                if message.get('role') != 'user' or not isinstance(message.get('content'), str):
                    continue
                try:
                    decoded = json.loads(message['content'])
                except (ValueError, TypeError):
                    continue
                if isinstance(decoded, dict):
                    human = decoded
                    break
            layer = human.get('layer', 'l3' if system.startswith(PROFILE_PROMPT) else 'l2')
            phase = layer + ('_verification' if 'proposal' in human else '_proposal')
            reservation = self.suite.reserve(source_ref='current', owner_id=self.owner,
                run_id=self.run, case_id=self.case, phase=phase)
        else:
            if 'ReplyRuntimeOutput' not in tools:
                phase = ('l1_adjudication' if 'BatchMemoryAdjudicationOutput' in tools else
                         'l1_relation_verification' if 'MemoryRelationVerificationOutput' in tools else
                         'l1_verification' if '核验' in system else 'l1_extraction')
            from notalone.problem_budget import reserve_problem_attempt
            reserve_problem_attempt()
        with self.lock:
            index = len(self.calls) + 1
            row = dict(index=index, stage=self.stage, phase=phase, tools=tools,
                       request_model=payload.get('model'), outcome='reserved')
            self.calls.append(row)
            atomic_json(self.output/'calls.json', self.calls)
        atomic_json(self.output/f'request-{index:03}.json', scrub(payload))
        return row, reservation, time.monotonic()

    def finish(self, state, response=None, error=None):
        row, reservation, started = state
        payload = None
        if response is not None:
            try:
                payload = response.json()
            except ValueError:
                payload = {'non_json_sha256': hashlib.sha256(response.content).hexdigest()}
            atomic_json(self.output/f'response-{row["index"]:03}.json', scrub(payload))
        outcome = 'succeeded' if response is not None and response.is_success else 'failed' if response is not None else 'unknown'
        elapsed = round((time.monotonic()-started)*1000)
        if reservation is not None:
            self.suite.finish(reservation, outcome=outcome, request_model=row['request_model'],
                response_model=payload.get('model') if isinstance(payload, dict) else None, duration_ms=elapsed)
        chain, cause = [], error
        while cause is not None and len(chain) < 6:
            chain.append({'type': type(cause).__name__, 'errno': getattr(cause, 'errno', None)})
            next_cause = cause.__cause__ or cause.__context__
            if next_cause is cause:
                break
            cause = next_cause
        with self.lock:
            row.update(error_causes=chain, outcome=outcome, duration_ms=elapsed,
                       http_status=response.status_code if response is not None else None,
                       error_type=type(error).__name__ if error else None)
            atomic_json(self.output/'calls.json', self.calls)
        print(json.dumps(row, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--reply-thinking', choices=('disabled', 'low', 'high', 'max'), default='disabled')
    parser.add_argument('--compare-reply-disabled', action='store_true')
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--round', default='current-default')
    parser.add_argument('--case-file', type=Path)
    parser.add_argument('--hypothesis', required=True)
    parser.add_argument('--reuse-round', action='store_true',
                        help='同一冻结版本和假设的后续数据集，继续既有未结案轮；不新增或重置授权。')
    args = parser.parse_args()
    if args.compare_reply_disabled and args.reply_thinking == 'disabled':
        parser.error('配对对照须先指定一个实际思考强度。')
    global INITIAL, UPDATED, REPLIES
    extra_cases = {}
    if args.case_file:
        extra_cases = json.loads(args.case_file.read_text())
        INITIAL = [tuple(row) if isinstance(row, list) else row for row in extra_cases['initial']]
        UPDATED = extra_cases['updated']
        REPLIES = extra_cases['replies']
    root = args.output
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    load_project_env()
    if os.environ.get('NOTALONE_ORGANIZATION_QUALITY_CONFIG'):
        raise RuntimeError('当前复验不得覆盖显式整理配置。')
    from urllib.parse import urlsplit
    host = urlsplit(os.environ.get('NOTALONE_DEEPSEEK_BASE_URL', 'https://api.deepseek.com')).hostname
    if not os.environ.get('NOTALONE_DEEPSEEK_API_KEY'):
        raise RuntimeError('没有配置模型凭据。')
    os.environ['NOTALONE_SKILLS_DIR'] = str(root/'isolated-skills')
    os.environ['NOTALONE_DISABLE_DOTENV'] = '1'
    package_root = Path(__import__('notalone.server.app', fromlist=['__file__']).__file__).parents[1]
    fingerprint = hashlib.sha256()
    for path in sorted(package_root.rglob('*.py')):
        fingerprint.update(str(path.relative_to(package_root)).encode())
        fingerprint.update(path.read_bytes())
    frozen = {'initial': INITIAL, 'updated': UPDATED, 'repeated': UPDATED, 'replies': REPLIES,
              'additional_modes': ['current_chat否定作用域', '默认draft改写明确拒绝'],
              'provider_host': host, 'model': os.getenv('NOTALONE_DEEPSEEK_MODEL', 'deepseek-flash'),
              'runtime_sha256': fingerprint.hexdigest(), 'reply_thinking': args.reply_thinking,
              'compare_reply_disabled': args.compare_reply_disabled,
              'module': __import__('notalone.server.app', fromlist=['__file__']).__file__,
              'synthetic_only': True, 'repeated_identity': 'reuse_exact_updated_source_file',
              'annotation': extra_cases.get('annotation', '原失败及正确对照回归'),
              'additional_cases': extra_cases.get('additional_cases')}
    atomic_json(root/'cases.json', frozen)
    if args.preflight:
        print(json.dumps({'preflight':'ok', 'provider_host':host, 'model':frozen['model'], 'cases':5+len(REPLIES)}))
        return 0
    ledger = ProblemBudget(args.ledger)
    hypothesis = args.hypothesis + '；实际源码与模型：' + frozen['runtime_sha256'] + '/' + host + '/' + frozen['model'] + '/reply_thinking=' + args.reply_thinking + '/compare_disabled=' + str(args.compare_reply_disabled)
    if args.reuse_round:
        with ledger.connection() as db:
            ledger.check(db)
            if db.execute('SELECT hypothesis,outcome FROM rounds WHERE id=?', (args.round,)).fetchone() != (hypothesis, None):
                raise RuntimeError('仅允许继续同一假设且未结案的既有轮。')
    else:
        ledger.start(args.round, hypothesis)
    started_used=ledger.snapshot()['used']
    os.environ['NOTALONE_PROBLEM_BUDGET'] = str(ledger.path)
    os.environ['NOTALONE_PROBLEM_ROUND'] = args.round
    owner, run, case = uuid4(), uuid4(), uuid4()
    backend = priority = task_host = layers = original_backend = None
    suite = None
    results, failure = {}, None
    try:
        Database.setUpClass()
        os.environ['NOTALONE_DATABASE_URL'] = Database.database_url
        os.environ['NOTALONE_OWNER_ID'] = str(owner)
        atomic_json(root/'database.json', {'database_name':Database.database_name, 'owner_id':str(owner)})
        fixture = dict(scenario_key='current-default', dimension='conflict', scope_kind='contact',
            feedback_mode='baseline', feedback_layer=None,
            source_ref=dict(key='current', database_url_env='NOTALONE_DATABASE_URL', expected_database=Database.database_name),
            owner_id=str(owner), run_id=str(run), case_id=str(case),
            input_sha256=hashlib.sha256(json.dumps(frozen,ensure_ascii=False).encode()).hexdigest(),
            annotation_sha256=hashlib.sha256(b'current-default-full-stage-v1').hexdigest(), allocated_attempts=750)
        suite = PersistentSuiteBudget.create(root/'suite', dict(schema_version='organization-synthetic-suite-v2',
            dataset_version='current-default-20261022-v1',contract_id=fixture['input_sha256'],max_http_attempts=800,fixtures=[fixture]))
        capture = Capture(root, suite, owner, run, case, host)
        import notalone.problem_budget as pb
        original_reserve = pb.reserve_problem_attempt
        def precheck(*, request=None):
            if request is None:
                return original_reserve()
            check_problem_budget()
        def measure_sync(original):
            def sync(transport, request):
                state, response, error = capture.begin(request), None, None
                try:
                    response = original(transport, request)
                    response.read()
                    return response
                except BaseException as caught:
                    error = caught
                    raise
                finally:
                    capture.finish(state, response, error)
            return sync
        def measure_async(original):
            async def async_send(transport, request):
                state, response, error = capture.begin(request), None, None
                try:
                    response = await original(transport, request)
                    await response.aread()
                    return response
                except BaseException as caught:
                    error = caught
                    raise
                finally:
                    capture.finish(state, response, error)
            return async_send
        with ExitStack() as stack:
            stack.enter_context(patch.object(pb, 'reserve_problem_attempt', precheck))
            for library in (httpx,httpx2):
                stack.enter_context(patch.object(library.HTTPTransport, 'handle_request',
                    measure_sync(library.HTTPTransport.handle_request)))
                stack.enter_context(patch.object(library.AsyncHTTPTransport, 'handle_async_request',
                    measure_async(library.AsyncHTTPTransport.handle_async_request)))
            from notalone.application.model_priority import ModelPriorityControl
            from notalone.application.organization_runtime import build_layered_memory_service
            from notalone.server.command import _build_task_host, _build_import_service, _build_memory_service
            from notalone.server.reply_wiring import build_reply_service
            from notalone.server.app import create_app
            from notalone.server.event_bus import EventBus
            from notalone.persistence.contact_directory import PostgresContactDirectory
            from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
            with psycopg.connect(Database.database_url) as c:
                c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'本轮合成验收用户')",(owner,))
                c.execute('INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,0)',(owner,))
            priority = ModelPriorityControl()
            layers = build_layered_memory_service(Database.database_url, model_priority=priority)
            events = EventBus()
            task_host = _build_task_host(Database.database_url, events, model_priority=priority, organization_runner=layers)
            assert task_host is not None
            layers.attach_task_host(task_host)
            reply = build_reply_service(database_url=Database.database_url, owner_id=owner,
                                        model_priority=priority, layered_memory=layers,
                                        reply_thinking_effort=None if args.reply_thinking == 'disabled' else args.reply_thinking)
            assert reply is not None
            backend = HttpBackend(create_app(database_url=Database.database_url,owner_id=owner,token='synthetic-current-quality',
                events=events,task_host=task_host,import_service=_build_import_service(Database.database_url),
                memory_service=_build_memory_service(Database.database_url),layered_memory=layers,reply_service=reply),owner)
            contact = PostgresContactDirectory(Database.database_url).create_contact(owner,uuid4(),'本轮合成资料联系人').contact_id
            empty = PostgresContactDirectory(Database.database_url).create_contact(owner,uuid4(),'本轮合成空资料联系人').contact_id
            for contact_id in (contact, empty):
                status, body = backend.request(f'/api/contacts/{contact_id}/manual-confirmation',{})
                assert status == 200,body
                PostgresConversationBindingRepository(Database.database_url).create_binding(
                    owner_id=owner,contact_id=contact_id,channel='wechat',
                    account_scope='synthetic-current-quality',
                    conversation_locator='synthetic-'+contact_id.hex)
            def read(path):
                status, body = backend.request(path,timeout=20)
                if status != 200: raise RuntimeError(f'读取失败 {status}: {body}')
                return body
            def snapshot(stage):
                state = {'memories':read(f'/api/contacts/{contact}/memories'),
                         'layers':read(f'/api/contacts/{contact}/layered-memory'),
                         'candidates':read(f'/api/contacts/{contact}/memory-candidates'),
                         'messages':read(f'/api/contacts/{contact}/messages')}
                atomic_json(root/f'{stage}.json',state)
                return state
            def generate_reply(index):
                name, draft, context, relationship = REPLIES[index]
                capture.stage = 'reply_'+name
                body={'contact_id':str(empty if index == 0 else contact),'idempotency_key':str(uuid4()),'content':{
                    'type':'rewrite_draft','input_kind':'workspace','workspace_action':'express',
                    'draft_text':draft,'context_text':context,'include_relationship_context':relationship,
                    'excluded_message_ids':[],'user_instruction':'自然简短，保留本次想法，不自行增加事实或承诺。'}}
                reply_started = time.monotonic()
                status, response = backend.request('/api/reply/generate',body,timeout=300)
                record={'status':status,'request':body,'response':response, 'duration_ms': round((time.monotonic()-reply_started)*1000)}
                if status == 200:
                    record['evidence'] = read(f'/api/contacts/{body["contact_id"]}/replies/{response["reply_request_id"]}/evidence')
                atomic_json(root/f'reply-{name}.json',record)
                results['reply_'+name]={'status':status,'candidates':len(response.get('candidates',[]))}
                print(json.dumps({'reply':name,**results['reply_'+name]},ensure_ascii=False),flush=True)
            for number,(stage,texts) in enumerate((('initial',INITIAL),('updated',UPDATED),('repeated',UPDATED)),1):
                capture.stage = stage
                records=[]
                for index,text in enumerate([*texts,'收到。']):
                    when=datetime(2026,10,22,8+number,index,tzinfo=timezone(timedelta(hours=8)))
                    mine=index == len(texts)
                    if isinstance(text, tuple):
                        mine,text=text
                    records.append(dict(id=dict(local_id=number*100+index,server_id_str=f'current-{number}-{index}',talker='wxid_synthetic_current'),
                        create_time=int(when.timestamp()),is_from_me=mine,kind='text',sender='合成用户' if mine else '合成联系人',
                        sender_wxid='wxid_synthetic_owner' if mine else 'wxid_synthetic_current',text=text,
                        time=when.strftime('%Y-%m-%d %H:%M:%S'),time_iso=when.isoformat()))
                source=root/f'input-{stage}.jsonl'
                if stage == 'repeated':
                    source = root/'input-updated.jsonl'
                else:
                    source.write_text('\n'.join(json.dumps(row,ensure_ascii=False) for row in records)+'\n');source.chmod(0o600)
                status, preview=backend.request('/api/imports/preview',{'path':str(source),'contact_id':str(contact)})
                if status!=200 or not preview.get('valid'): raise RuntimeError(f'预览失败: {preview}')
                status, imported=backend.request('/api/imports/commit',{'path':str(source),'contact_id':str(contact),
                    'expected_content_sha256':preview['content_sha256']})
                if status!=200: raise RuntimeError(f'导入失败: {imported}')
                atomic_json(root/f'{stage}-import.json', {'source_sha256':preview['content_sha256'], 'receipt':imported})
                event=threading.Event(); deadline=time.monotonic()+480
                last=None
                while time.monotonic()<deadline:
                    task=read(f'/api/tasks/status?contact_id={contact}&task_id={imported["task_id"]}')
                    state=snapshot(stage)
                    layer=state['layers']['layered_memory']
                    last={'task':task,'state':state}
                    if task['status'] in {'failed','cancelled'}: break
                    if task['status']=='succeeded' and layer.get('status')=='failed': break
                    if task['status']=='succeeded' and layer.get('status')=='paused' and layer.get('error_code'): break
                    if task['status']=='succeeded' and layer.get('eligible_count') == 0 and not layer.get('maintenance_pending'): break
                    if task['status']=='succeeded' and layer.get('status')=='ready' and not layer.get('maintenance_pending'): break
                    event.wait(.5)
                atomic_json(root/f'{stage}-completion.json',last)
                results[stage]={'task':last['task']['status'],'layer':last['state']['layers']['layered_memory'].get('status')}
                print(json.dumps({'stage':stage,**results[stage]},ensure_ascii=False),flush=True)
            generate_reply(0)
            generate_reply(1)
            generate_reply(2)
            generate_reply(3)
            generate_reply(4)
            generate_reply(5)
            capture.stage='reply_pasted_negation'
            body={'contact_id':str(contact),'idempotency_key':str(uuid4()),'content':{
                'type':'rewrite_draft','input_kind':'current_chat',
                'draft_text':'不是不想见你，只是这周工作太忙了。',
                'pasted_direction':'表示理解，不催促，不约定下次见面的时间。',
                'user_instruction':'保留对方这周忙的原意，不能说对方不想见，不增加下次承诺。'}}
            for name in ('pasted_negation','draft_rewrite'):
                capture.stage='reply_'+name
                if name=='draft_rewrite':
                    body={'contact_id':str(contact),'idempotency_key':str(uuid4()),'content':{
                        'type':'rewrite_draft','draft_text':'今晚我不参加，祝你们玩得开心。',
                        'user_instruction':'保持明确拒绝，不改成犹豫或答应，不增加下次参加的承诺。'}}
                if name in extra_cases.get('additional_cases', {}):
                    body['content'] = extra_cases['additional_cases'][name]
                reply_started = time.monotonic()
                status,response=backend.request('/api/reply/generate',body,timeout=300)
                record={'status':status,'request':body,'response':response, 'duration_ms': round((time.monotonic()-reply_started)*1000)}
                if status == 200:
                    record['evidence'] = read(f'/api/contacts/{contact}/replies/{response["reply_request_id"]}/evidence')
                atomic_json(root/f'reply-{name}.json',record)
                results['reply_'+name]={'status':status,'candidates':len(response.get('candidates',[]))}
            primary_final = snapshot('final')
            if args.compare_reply_disabled:
                # 同一冻结资料与来源版本上切换实际服务；两次均走正式 HTTP 与工厂。
                original_backend = backend
                reply = build_reply_service(database_url=Database.database_url, owner_id=owner,
                    model_priority=priority, layered_memory=layers)
                assert reply is not None
                backend = HttpBackend(create_app(database_url=Database.database_url, owner_id=owner,
                    token='synthetic-current-quality', events=EventBus(), task_host=task_host,
                    import_service=_build_import_service(Database.database_url),
                    memory_service=_build_memory_service(Database.database_url),
                    layered_memory=layers, reply_service=reply), owner)
                for name in [row[0] for row in REPLIES] + ['pasted_negation', 'draft_rewrite']:
                    prior = json.loads((root/f'reply-{name}.json').read_text())
                    body = prior['request']
                    body['idempotency_key'] = str(uuid4())
                    capture.stage = 'paired_disabled_' + name
                    reply_started = time.monotonic()
                    status, response = backend.request('/api/reply/generate', body, timeout=300)
                    record = {'status': status, 'request': body, 'response': response,
                        'duration_ms': round((time.monotonic()-reply_started)*1000)}
                    if status == 200:
                        record['evidence'] = read(f'/api/contacts/{body["contact_id"]}/replies/{response["reply_request_id"]}/evidence')
                    atomic_json(root/f'paired-disabled-{name}.json', record)
                    results['paired_disabled_'+name] = {'status': status, 'candidates': len(response.get('candidates', []))}
                paired_final = snapshot('paired-final')
                before = [(m['memory_id'], m['revision'], m['text'], m['source_ids']) for m in primary_final['memories']['memories']]
                after = [(m['memory_id'], m['revision'], m['text'], m['source_ids']) for m in paired_final['memories']['memories']]
                if before != after:
                    raise RuntimeError('配对回复期间底层记忆版本发生变化，不能当作固定资料对照。')
                if primary_final['layers']['layered_memory'].get('scenarios') != paired_final['layers']['layered_memory'].get('scenarios'):
                    raise RuntimeError('配对回复期间L2场景发生变化，不能当作固定资料对照。')
                if primary_final['layers']['layered_memory'].get('profile') != paired_final['layers']['layered_memory'].get('profile'):
                    raise RuntimeError('配对回复期间画像发生变化，不能当作固定资料对照。')
                atomic_json(root/'paired-input-identity.json', {'same_memory_versions': True, 'same_profile': True, 'same_scenarios': True,
                    'profile_before': primary_final['layers']['layered_memory'].get('profile'),
                    'profile_after': paired_final['layers']['layered_memory'].get('profile')})
            capture.stage='shutdown'
            priority.stop();task_host.stop(timeout=60)
            backend.close();backend=None
            layers.stop()
            atomic_json(root/'results.json',results)
            atomic_json(root/'accounting.json',{'problem':ledger.snapshot(),'physical_calls':len(capture.calls),
                'suite_calls':suite.snapshot()['used_attempts']})
            assert ledger.snapshot()['used']-started_used==len(capture.calls)
            assert suite.snapshot()['used_attempts']==sum(
                row['phase'] in {'l2_proposal','l2_verification','l3_proposal','l3_verification'}
                for row in capture.calls)
    except BaseException as caught:
        failure={'type':type(caught).__name__,'message':str(caught),'traceback':traceback.format_exc()}
        atomic_json(root/'failure.json',failure)
        print(json.dumps({'failure_type':type(caught).__name__,'message':str(caught)[:200]},ensure_ascii=False),flush=True)
    finally:
        if priority is not None: priority.stop()
        if task_host is not None: task_host.stop(timeout=60)
        if backend is not None: backend.close()
        if original_backend is not None: original_backend.close()
        if layers is not None: layers.stop()
        Database.doClassCleanups()
        with psycopg.connect('host=/tmp dbname=postgres') as c:
            gone=c.execute('SELECT 1 FROM pg_database WHERE datname=%s',(getattr(Database,'database_name',''),)).fetchone() is None
        atomic_json(root/'cleanup.json',{'database_removed':gone,'fixture_cleanup_errors':len(getattr(Database,'tearDown_exceptions',()))})
        atomic_json(root/'results.json',results)
        if failure:
            ledger.finish(args.round, 'unknown', str(root/'results.json'))
        else:
            atomic_json(root/'judgment-pending.json', {'round':args.round,
                'reason':'技术执行完成；等待独立逐项语义验收后再在原账本结案。'})
        atomic_json(root/'budget-final.json',ledger.snapshot())
    return 1 if failure else 0


if __name__=='__main__':
    raise SystemExit(main())
