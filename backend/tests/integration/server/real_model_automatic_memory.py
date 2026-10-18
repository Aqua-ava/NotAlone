"""显式运行的真实模型自动记忆验收；合成聊天、独立库和累计物理请求账本。"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import psycopg

from notalone.experiments.problem_budget import ProblemBudget, reserve_problem_attempt
from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, atomic_json
from notalone.runtime_config import load_project_env
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, HttpBackend

CASES = {
    'contact_tea': {'scope': 'contact', 'initial': ['我平时最喜欢喝乌龙茶，日常一直选乌龙茶。', '你好，今天见到你很高兴。'],
        'update': ['更正一下我的日常口味：我现在已经不喝乌龙茶，改为每天喝红茶，以后都选红茶。'], 'expected': '红茶'},
    'owner_exercise': {'scope': 'owner', 'initial': ['我长期习惯每周末去跑步锻炼。', '你好，很高兴见到你。'],
        'update': ['更正一下我的锻炼习惯：我现在不跑步了，改成每周末游泳，以后都去游泳。'], 'expected': '游泳'},
}


class RealMemoryAcceptance(CoreBusinessFlowFixture, unittest.TestCase):
    """只复用测试库生命周期，不替换模型、核验器或自动采纳策略。"""

    def setUp(self):
        from notalone.application.model_priority import ModelPriorityControl
        from notalone.application.organization_runtime import build_layered_memory_service
        from notalone.server.app import create_app
        from notalone.server.command import _build_task_host, _build_import_service, _build_memory_service
        from notalone.server.event_bus import EventBus

        self.owner_id = self.acceptance_owner
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成真实模型验收用户')", (self.owner_id,))
            connection.execute('INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,0)', (self.owner_id,))
        self.priority = ModelPriorityControl()
        self.layers = build_layered_memory_service(self.database_url, model_priority=self.priority)
        events = EventBus()
        from notalone.server.event_publisher import EventBusMessagePublisher
        self.host = _build_task_host(self.database_url, events, model_priority=self.priority, organization_runner=self.layers)
        assert self.host is not None
        self.layers.attach_task_host(self.host)
        self.publisher = EventBusMessagePublisher(events, owner_id=self.owner_id, task_host=self.host)
        if getattr(self, "entry", "import") == "observation":
            self.host.start_scheduling(owner_id=self.owner_id)
        self.backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-real-model-acceptance', events=events, task_host=self.host,
            import_service=_build_import_service(self.database_url), memory_service=_build_memory_service(self.database_url),
            layered_memory=self.layers, runtime_shutdown=self.stop), self.owner_id)
        self.addCleanup(self.backend.close)

    def stop(self):
        self.priority.stop()
        self.host.stop(timeout=5)

    def read(self, path):
        status, body = self.backend.request(path)
        self.assertEqual(status, 200, body)
        return body

    def import_dialog(self, number, texts, contact_id=None):
        path = self.output / f'input-{number}.jsonl'
        records = []
        for index, text in enumerate([*texts, '收到。']):
            from_me = (index < len(texts)) if self.case['scope'] == 'owner' else (index == len(texts))
            occurred = f'2026-10-18T{number + 8:02d}:{index:02d}:00+08:00'
            records.append({'id': {'local_id': number * 100 + index, 'server_id_str': f'synthetic-{number}-{index}',
                'talker': 'wxid_synthetic_automatic'}, 'create_time': int(datetime.fromisoformat(occurred).timestamp()),
                'is_from_me': from_me, 'kind': 'text', 'sender': '合成用户' if from_me else '合成联系人',
                'sender_wxid': 'wxid_synthetic_owner' if from_me else 'wxid_synthetic_automatic', 'text': text,
                'time': f'2026-10-18 {number + 8:02d}:{index:02d}:00',
                'time_iso': occurred})
        path.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in records), encoding='utf-8')
        path.chmod(0o600)
        status, preview = self.backend.request('/api/imports/preview', {'path': str(path)})
        self.assertEqual(status, 200, preview)
        self.assertTrue(preview['valid'], preview)
        body = {'path': str(path)}
        body.update({'contact_id': contact_id} if contact_id else {'new_contact_name': '合成自动维护验收'})
        status, result = self.backend.request('/api/imports/commit', body)
        self.assertEqual(status, 200, result)
        return result

    def observation_dialog(self, number, texts, contact_id=None):
        """正式已确认绑定的观察提交；中性消息补齐数量阈值，不替换任何模型。"""
        from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
        from notalone.persistence.contact_directory import PostgresContactDirectory
        from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
        from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
        from notalone.scopes import ContactScope

        if contact_id is None:
            contact = PostgresContactDirectory(self.database_url).create_contact(
                self.owner_id, uuid4(), '合成自动维护验收')
            contact_id = str(contact.contact_id)
            self.observation_binding = PostgresConversationBindingRepository(self.database_url).create_binding(
                owner_id=self.owner_id, contact_id=UUID(contact_id), channel='wechat',
                account_scope='synthetic-acceptance', conversation_locator=f'synthetic-{contact_id}')
        binding = self.observation_binding
        scope = ContactScope(self.owner_id, UUID(contact_id))
        # 每轮新身份5条，确保达到正式阈值；重复轮仍是新来源，不是入库幂等。
        contents = list(texts)
        contents.extend(['收到。', '嗯。', '好的。', '谢谢。', '知道了。'][:5-len(contents)])
        messages = []
        evidence = []
        for index, text in enumerate(contents):
            local_id = number * 100 + index
            occurred = datetime(2026, 10, 18, number + 1, index, tzinfo=timezone.utc)
            speaker = ('user' if self.case['scope'] == 'owner' else 'contact') if index < len(texts) else 'user'
            messages.append(NormalizedMessage(
                source_locator=f'cli:{local_id}', speaker=speaker, message_type='text', text_content=text,
                media_placeholder=None, occurred_at=occurred,
                wechat_metadata=WechatMessageMetadata(external_local_id=local_id,
                    external_server_id=f'synthetic-{number}-{index}', external_talker=binding.conversation_locator,
                    source_create_time=int(occurred.timestamp()), raw_payload_json=json.dumps({'text': text}, ensure_ascii=False))))
            evidence.append({'local_id': local_id, 'speaker': speaker, 'text': text, 'occurred_at': occurred.isoformat()})
        atomic_json(self.output / f'observation-input-{number}.json', evidence)
        batch = PostgresObservationStore(self.database_url).record_batch_with_messages(
            owner_id=self.owner_id, contact_id=scope.contact_id, binding_id=binding.binding_id,
            mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic-real-model-acceptance',
            conversation_locator=binding.conversation_locator, last_local_id=number*100+4,
            last_cursor=f'synthetic-cursor-{number}', record_count=len(messages), messages=tuple(messages))
        for message_id in batch.created_message_ids:
            if message_id is not None:
                self.publisher.publish_message_created(scope=scope, occurred_at=datetime.now(timezone.utc), message_id=message_id)
        status = self.read(f'/api/tasks/status?contact_id={contact_id}')
        task_id = (status.get('progress') or {}).get('task_id')
        self.assertIsNotNone(task_id, status)
        return {'contact_id': contact_id, 'task_id': task_id}

    def await_result(self, imported, stage):
        contact = imported['contact_id']
        deadline = time.monotonic() + 300
        memory_path = '/api/memories/owner' if self.case['scope'] == 'owner' else f'/api/contacts/{contact}/memories'
        layer_path = '/api/memories/owner/layered-memory' if self.case['scope'] == 'owner' else f'/api/contacts/{contact}/layered-memory'
        last = None
        while time.monotonic() < deadline:
            task = self.read(f'/api/tasks/status?contact_id={contact}&task_id={imported["task_id"]}')
            memories = self.read(memory_path)
            layers = self.read(layer_path)['layered_memory']
            last = {'task': task, 'memories': memories, 'layers': layers}
            if task['status'] in {'failed', 'cancelled'} or layers['status'] == 'failed':
                break
            if task['status'] == 'succeeded' and not memories['memories']:
                last['candidates'] = self.read(f'/api/contacts/{contact}/memory-candidates')
                break
            if task['status'] == 'succeeded' and layers['status'] == 'ready' and layers['profile'] and not layers['maintenance_pending']:
                break
            threading.Event().wait(.25)
        last['candidates'] = self.read(f'/api/contacts/{contact}/memory-candidates')
        atomic_json(self.output / f'{stage}.json', last)
        print(json.dumps({'stage': stage, 'task': last['task']['status'], 'memories': len(last['memories']['memories']),
            'layer_status': last['layers']['status'], 'profile': bool(last['layers']['profile']),
            'error_code': last['layers'].get('error_code')}, ensure_ascii=False), flush=True)
        self.assertEqual(last['task']['status'], 'succeeded', last['task'])
        self.assertEqual(last['layers']['status'], 'ready', last['layers'])
        self.assertIsNotNone(last['layers']['profile'])
        self.assertFalse(last['layers']['maintenance_pending'], last['layers'])
        self.assertEqual(last['layers']['covered_count'], last['layers']['eligible_count'])
        self.assertEqual(last['layers']['pending_fact_count'], 0, '自动链路不能留下未处理候选')
        self.assertFalse(any(c['status'] == 'pending' for c in last['candidates']['candidates']),
                         '版本不变不能代替真正完成重复skip')
        return last

    def test_complete_chain(self):
        submit = self.observation_dialog if getattr(self, 'entry', 'import') == 'observation' else self.import_dialog
        first = submit(1, self.case['initial'])
        before = self.await_result(first, 'initial')
        self.assertTrue(before['memories']['memories'])
        self.assertTrue(all(m['adoption_method'] == 'auto' for m in before['memories']['memories']))
        self.assertTrue(all('你好' not in m['text'] for m in before['memories']['memories']))
        second = submit(2, self.case['update'], first['contact_id'])
        after = self.await_result(second, 'updated')
        self.assertNotEqual(before['layers']['organization_generation'], after['layers']['organization_generation'])
        self.assertTrue(any(self.case['expected'] in m['text'] for m in after['memories']['memories']))
        old_ids = {m['memory_id'] for m in before['memories']['memories']}
        self.assertTrue(old_ids.isdisjoint(m['memory_id'] for m in after['memories']['memories']))
        self.assertTrue(all(m['adoption_method'] == 'auto' for m in after['memories']['memories']))
        # 新来源ID的改述重复不是导入幂等：应由记忆裁决跳过。
        repeated = submit(3, self.case['update'], first['contact_id'])
        unchanged = self.await_result(repeated, 'repeated')
        self.assertEqual({m['memory_id'] for m in after['memories']['memories']},
                         {m['memory_id'] for m in unchanged['memories']['memories']})
        self.assertEqual(after['layers']['profile']['version_id'], unchanged['layers']['profile']['version_id'])
        self.assertEqual(after['layers']['organization_generation'], unchanged['layers']['organization_generation'])
        # 机器断言只证明链路；语义和旧记忆是否正确退役由独立Agent核对证据。
        atomic_json(self.output / 'result.json', {'passed': True, 'entry': getattr(self, 'entry', 'import'), 'contact_id': first['contact_id'],
            'initial_generation': before['layers']['organization_generation'],
            'updated_generation': after['layers']['organization_generation']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--round', required=True)
    parser.add_argument('--entry', choices=('import', 'observation'), default='import')
    parser.add_argument('--case', choices=CASES, default='contact_tea')
    parser.add_argument('--retain-for-desktop', action='store_true', help='仅成功后保留合成测试库用于开发App验收，随后须显式清理')
    args = parser.parse_args()
    load_project_env()
    if os.environ.get('NOTALONE_ORGANIZATION_QUALITY_CONFIG'):
        raise RuntimeError('本验收针对默认自动维护；不可静默覆盖已配置的显式资格模式。')
    if not os.environ.get('NOTALONE_DEEPSEEK_API_KEY', '').strip():
        raise RuntimeError('须先配置真实模型凭据；不输出或写入凭据。')
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ['NOTALONE_PROBLEM_BUDGET'] = str(args.ledger)
    os.environ['NOTALONE_PROBLEM_ROUND'] = args.round
    ProblemBudget(args.ledger).snapshot()  # 在建库或请求前核对账本。
    RealMemoryAcceptance.output = args.output
    test = RealMemoryAcceptance('test_complete_chain')
    test.case = CASES[args.case]
    test.entry = args.entry
    suite = None
    original = httpx.HTTPTransport.handle_request
    lock = threading.Lock()
    calls = []
    passed = False
    try:
        RealMemoryAcceptance.setUpClass()
        # 固定物理suite身份；全部整理请求与L1共用同一个问题总账。
        owner, run, case = uuid4(), uuid4(), uuid4()
        test.acceptance_owner = owner
        fixture = {'scenario_key': args.case, 'dimension': 'conflict', 'scope_kind': test.case['scope'],
            'feedback_mode': 'baseline', 'feedback_layer': None, 'source_ref': {'key': 'acceptance',
                'database_url_env': 'NOTALONE_ACCEPTANCE_DATABASE_URL', 'expected_database': test.database_name},
            'owner_id': str(owner), 'run_id': str(run), 'case_id': str(case),
            'input_sha256': hashlib.sha256(json.dumps(test.case, ensure_ascii=False).encode()).hexdigest(),
            'annotation_sha256': hashlib.sha256(b'initial-update-organize-v1').hexdigest(), 'allocated_attempts': 750}
        suite = PersistentSuiteBudget.create(args.output / 'suite', {'schema_version': 'organization-synthetic-suite-v2',
            'dataset_version': 'automatic-memory-chain-v1', 'contract_id': fixture['input_sha256'],
            'max_http_attempts': 800, 'fixtures': [fixture]})

        def measured(transport, request):
            from notalone.memory.organization_quality_transport import _CURRENT_ORGANIZATION
            from notalone.memory.organization_sdk import PROFILE_PROMPT
            payload = json.loads(request.read())
            phase, reservation = 'l1', None
            if _CURRENT_ORGANIZATION.get() is not None:
                human = {}
                for message in payload['messages']:
                    if message.get('role') != 'user' or not isinstance(message.get('content'), str):
                        continue
                    try:
                        decoded = json.loads(message['content'])
                    except (ValueError, TypeError):
                        continue
                    if isinstance(decoded, dict):
                        human = decoded
                        break
                layer = human.get('layer', 'l3' if payload['messages'][0]['content'].startswith(PROFILE_PROMPT) else 'l2')
                phase = layer + ('_verification' if 'proposal' in human else '_proposal')
                reservation = suite.reserve(source_ref='acceptance', owner_id=owner, run_id=run, case_id=case, phase=phase)
            else:
                system = str(payload.get('messages', [{}])[0].get('content', ''))
                if '统一已有候选池' in system:
                    phase = 'l1_adjudication'
                elif '核验' in system:
                    phase = 'l1_verification'
                else:
                    phase = 'l1_extraction'
                reserve_problem_attempt()
            with lock:
                index = len(calls) + 1
                row = {'index': index, 'phase': phase, 'outcome': 'reserved', 'request_model': payload.get('model')}
                calls.append(row)
                atomic_json(args.output / 'calls.json', calls)
            atomic_json(args.output / f'request-{index}.json', payload)
            outcome, response = 'unknown', None
            started = time.monotonic()
            try:
                result = original(transport, request)
                result.read()
                response = result.json()
                outcome = 'succeeded' if result.is_success else 'failed'
                atomic_json(args.output / f'response-{index}.json', response)
                return result
            finally:
                duration = int((time.monotonic() - started) * 1000)
                if reservation:
                    suite.finish(reservation, outcome=outcome, request_model=payload.get('model'),
                        response_model=response.get('model') if isinstance(response, dict) else None, duration_ms=duration)
                with lock:
                    row.update(outcome=outcome, duration_ms=duration)
                    atomic_json(args.output / 'calls.json', calls)
                print(json.dumps(row), flush=True)

        with patch.object(httpx.HTTPTransport, 'handle_request', measured):
            result = unittest.TextTestRunner(verbosity=2).run(test)
        passed = result.wasSuccessful()
        return 0 if passed else 1
    finally:
        retained = bool(args.retain_for_desktop and passed)
        if retained:
            atomic_json(args.output / 'desktop-fixture.json', {'database_name': RealMemoryAcceptance.database_name,
                'owner_id': str(test.acceptance_owner), 'synthetic_only': True, 'cleanup_required': True})
            RealMemoryAcceptance.admin.close()
        else:
            RealMemoryAcceptance.doClassCleanups()
        with psycopg.connect('host=/tmp dbname=postgres') as connection:
            remaining = connection.execute('SELECT 1 FROM pg_database WHERE datname=%s',
                (RealMemoryAcceptance.database_name,)).fetchone() is not None
        atomic_json(args.output / 'cleanup.json', {'database_removed': not remaining, 'retained_for_desktop': retained, 'calls': len(calls),
            'cleanup_errors': len(getattr(RealMemoryAcceptance, 'tearDown_exceptions', ()))})


if __name__ == '__main__':
    raise SystemExit(main())
