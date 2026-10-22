"""公开运行时的请求交接；模型和时钟等待使用合成边界。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from time import monotonic
import unittest
from unittest.mock import patch
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped, PriorityExtractionRuntime
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from tests.unit.memory_extraction.test_models import _window


class RetryModel:
    max_retries = 0

    def __init__(self):
        self.first_returned = Event()
        self.requests = 0

    def bind_tools(self, tools, **options):
        return self

    def invoke(self, messages):
        self.requests += 1
        args = {'scenes': 'invalid'} if self.requests == 1 else {'scenes': []}
        self.first_returned.set()
        return AIMessage(content='', tool_calls=[{
            'name': 'DirectMemoryExtractionOutput', 'args': args, 'id': 'synthetic',
        }])


class PhysicalModelSchedulingTest(unittest.TestCase):
    def test_default_backoff_bounds_persistent_guard_cost_before_retry(self):
        control, model = ModelPriorityControl(), RetryModel()
        checks, waits = [], []
        now = 0.0

        def wait(seconds):
            nonlocal now
            waits.append(seconds)
            now += seconds
            return False

        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(model=model), control)
        with patch('notalone.application.model_priority.time.monotonic', side_effect=lambda: now), \
                patch.object(control.stop_event, 'wait', side_effect=wait), \
                control.background_scope(lambda: checks.append((now, model.requests))):
            self.assertEqual(runtime.extract(_window((uuid4(),))), ())

        self.assertAlmostEqual(sum(waits), 30)
        self.assertEqual(model.requests, 2)
        self.assertLessEqual(len(checks), 36, '30秒退避至多31次复验，另有5次请求／消费边界复验。')
        self.assertEqual(checks[-3:], [(30, 1), (30, 2), (30, 2)], '下一请求前仍须复验。')

    def test_stop_event_immediately_interrupts_default_backoff_wait(self):
        control, model, waiting = ModelPriorityControl(), RetryModel(), Event()
        guards = []
        original_wait = control.stop_event.wait

        def wait(seconds):
            waiting.set()
            return original_wait(seconds)

        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(model=model), control)
        def extract():
            with control.background_scope(lambda: guards.append(monotonic())):
                return runtime.extract(_window((uuid4(),)))

        with patch.object(control.stop_event, 'wait', side_effect=wait), ThreadPoolExecutor(max_workers=1) as executor:
            extraction = executor.submit(extract)
            try:
                self.assertTrue(waiting.wait(1), '必须已进入默认30秒退避的Event等待。')
                started = monotonic()
                control.stop()
                with self.assertRaises(ModelWorkStopped):
                    extraction.result(timeout=.2)
                elapsed = monotonic() - started
            finally:
                control.stop()
        self.assertLess(elapsed, .2)
        self.assertEqual(model.requests, 1)
        self.assertEqual(len(guards), 3, '即时停止不应再查询持久guard。')

    def test_source_revocation_ends_default_backoff_within_one_guard_interval(self):
        from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
        control, model = ModelPriorityControl(), RetryModel()
        waiting, revoked = Event(), Event()
        guards = []
        original_wait = control.stop_event.wait

        def wait(seconds):
            waiting.set()
            return original_wait(seconds)

        def guard():
            guards.append(monotonic())
            if revoked.is_set():
                raise BackgroundTaskPersistenceError('合成来源／租约已撤销。')

        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(model=model), control)
        def extract():
            with control.background_scope(guard):
                return runtime.extract(_window((uuid4(),)))

        with patch.object(control.stop_event, 'wait', side_effect=wait), ThreadPoolExecutor(max_workers=1) as executor:
            extraction = executor.submit(extract)
            try:
                self.assertTrue(waiting.wait(1), '须在默认30秒退避已开始后再撤销来源。')
                started = monotonic()
                revoked.set()
                with self.assertRaises(BackgroundTaskPersistenceError):
                    extraction.result(timeout=1.5)
                self.assertLess(monotonic() - started, 1.5, '1秒复验间隔另留调度余量。')
            finally:
                control.stop()
        self.assertEqual(model.requests, 1)
        self.assertEqual(len(guards), 4)

    def test_deadline_includes_foreground_handoff_and_prevents_next_round(self):
        from notalone.application.organization_call import bounded_organization_call
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_deadline import OrganizationCallTimeout
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal
        control, started, release_request = ModelPriorityControl(), Event(), Event()
        requested, entered, release_reply = Event(), Event(), Event()
        requests = []
        class ToolModel:
            def bind(self, **options):
                return self
            def invoke(self, messages):
                requests.append(messages)
                started.set()
                if not release_request.wait(2):
                    raise AssertionError('合成请求未释放。')
                return AIMessage(content='', tool_calls=[{'id': 'synthetic', 'name': 'read',
                    'args': {'path': 'missing.md'}}], response_metadata={'finish_reason': 'tool_calls'})
        budget = OrganizationBudget()
        adapter = DeepSeekOrganizationProposal(ToolModel(), layer='l2', budget=budget, transport=None, document_tools=True)
        def organize():
            return bounded_organization_call(lambda deadline: adapter.propose(
                memories=(), budget=budget, deadline=deadline), priority=control,
                guard=lambda: None, timeout_seconds=.2, per_request=True)
        def foreground():
            requested.set()
            with control.foreground():
                entered.set()
                release_reply.wait(2)
        with ThreadPoolExecutor(max_workers=2) as executor:
            organizing = executor.submit(organize)
            self.assertTrue(started.wait(1))
            replying = executor.submit(foreground)
            try:
                self.assertTrue(requested.wait(1))
                self.assertFalse(entered.wait(.03))
                release_request.set()
                self.assertTrue(entered.wait(1))
                with self.assertRaises(OrganizationCallTimeout):
                    organizing.result(timeout=1)
            finally:
                release_request.set()
                release_reply.set()
            replying.result(timeout=1)
        # 即使调用方已离开，过期后台也不得恢复下一轮。
        with control.foreground():
            self.assertEqual(len(requests), 1)

    def test_sdk_retry_keeps_each_physical_request_trace_and_ledger(self):
        import json
        import httpx
        from tests.support.ledger_adapters import InMemoryOutboundLedger
        from notalone.memory.adapters import InMemoryMemoryStore
        from notalone.memory_extraction.command import run_extraction
        from notalone.memory_trace.adapters import InMemoryTraceStore
        from notalone.memory_trace.transport import build_trace_http_client
        from notalone.reply.adapters.deepseek_provider import build_deepseek_model
        from notalone.scopes import ContactScope
        from tests.unit.memory_extraction.test_command import _messages
        requests, first_returned = [], Event()

        def respond(request):
            requests.append(json.loads(request.content))
            first_returned.set()
            if len(requests) == 1:
                return httpx.Response(503, json={'error': {'message': 'synthetic'}})
            return httpx.Response(200, json={'id': 'synthetic', 'object': 'chat.completion', 'created': 1,
                'model': 'deepseek-flash', 'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {
                    'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'synthetic', 'type': 'function',
                        'function': {'name': 'DirectMemoryExtractionOutput', 'arguments': '{"scenes":[]}'}}]}}]})

        control, scope = ModelPriorityControl(), ContactScope(uuid4(), uuid4())
        traces, ledger, entered = InMemoryTraceStore(), InMemoryOutboundLedger(), Event()
        with build_trace_http_client(transport=httpx.MockTransport(respond)) as client:
            model = build_deepseek_model(api_key='synthetic', max_retries=0, http_client=client)
            runtime = PriorityExtractionRuntime(DirectExtractionRuntime(
                model=model, max_retries=1, retry_delay_seconds=.4), control)
            def extract():
                return run_extraction(scope=scope, messages=_messages(1), watermark_message_id=None,
                    runtime=runtime, memory_port=InMemoryMemoryStore(), owner_memory_port=None,
                    trace_store=traces, ledger=ledger)
            def foreground():
                with control.foreground():
                    entered.set()
            with ThreadPoolExecutor(max_workers=2) as executor:
                extracting = executor.submit(extract)
                self.assertTrue(first_returned.wait(1))
                replying = executor.submit(foreground)
                self.assertTrue(entered.wait(.2), '正式SDK退避仍须让位前台。')
                replying.result(timeout=1)
                self.assertEqual(extracting.result(timeout=2).processed_messages, 1)
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]['trace_id'])
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(ledger.list_by_owner(scope.owner_id)), 2)
        self.assertEqual(len(detail['calls']), 2)
        self.assertEqual([event['stage'] for event in detail['events']].count('provider_request'), 2)

    def test_stop_interrupts_retry_wait_without_a_second_request(self):
        control, model = ModelPriorityControl(), RetryModel()
        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(
            model=model, max_retries=1, retry_delay_seconds=.4), control)
        with ThreadPoolExecutor(max_workers=1) as executor:
            extraction = executor.submit(runtime.extract, _window((uuid4(),)))
            self.assertTrue(model.first_returned.wait(1))
            control.stop()
            with self.assertRaises(ModelWorkStopped):
                extraction.result(timeout=.2)
        self.assertEqual(model.requests, 1)

    def test_source_revocation_interrupts_backoff_before_retry(self):
        from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
        control, model, revoked = ModelPriorityControl(), RetryModel(), Event()

        def guard():
            if revoked.is_set():
                raise BackgroundTaskPersistenceError('合成来源或租约已失效。')

        def extract():
            with control.background_scope(guard):
                return runtime.extract(_window((uuid4(),)))

        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(
            model=model, max_retries=1, retry_delay_seconds=.4), control)
        with ThreadPoolExecutor(max_workers=1) as executor:
            extraction = executor.submit(extract)
            self.assertTrue(model.first_returned.wait(1))
            revoked.set()
            with self.assertRaises(BackgroundTaskPersistenceError):
                extraction.result(timeout=.6)
        self.assertEqual(model.requests, 1)

    def test_caller_timeout_keeps_inflight_organization_request_exclusive(self):
        from notalone.application.organization_call import bounded_organization_call
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_deadline import OrganizationCallTimeout
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal
        control, started, release, entered = ModelPriorityControl(), Event(), Event(), Event()
        requests = []

        class SlowModel:
            def bind(self, **options):
                return self

            def invoke(self, messages):
                requests.append(messages)
                started.set()
                if not release.wait(2):
                    raise AssertionError('合成请求门闩未释放。')
                return AIMessage(content='{"scenarios":[]}', response_metadata={'finish_reason': 'stop'})

        budget = OrganizationBudget()
        adapter = DeepSeekOrganizationProposal(SlowModel(), layer='l2', budget=budget, transport=None)
        def organize():
            return bounded_organization_call(lambda deadline: adapter.propose(
                memories=(), budget=budget, deadline=deadline), priority=control,
                guard=lambda: None, timeout_seconds=.1, per_request=True)
        def foreground():
            with control.foreground():
                entered.set()
        with ThreadPoolExecutor(max_workers=2) as executor:
            organizing = executor.submit(organize)
            self.assertTrue(started.wait(1))
            replying = executor.submit(foreground)
            try:
                with self.assertRaises(OrganizationCallTimeout):
                    organizing.result(timeout=1)
                self.assertFalse(entered.wait(.05), '外层已超时，实际请求仍占许可。')
            finally:
                release.set()
            replying.result(timeout=1)
        self.assertEqual(len(requests), 1)

    def test_stop_after_physical_return_is_cooperative_and_never_retried(self):
        control = ModelPriorityControl()

        class StoppingModel(RetryModel):
            def invoke(self, messages):
                result = super().invoke(messages)
                result.tool_calls[0]['args'] = {'scenes': []}
                control.stop()
                return result

        model = StoppingModel()
        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(
            model=model, max_retries=1, retry_delay_seconds=0), control)
        with self.assertRaises(ModelWorkStopped):
            runtime.extract(_window((uuid4(),)))
        self.assertEqual(model.requests, 1)

    def test_foreground_runs_during_extraction_retry_backoff(self):
        control, model = ModelPriorityControl(), RetryModel()
        runtime = PriorityExtractionRuntime(DirectExtractionRuntime(
            model=model, max_retries=1, retry_delay_seconds=.4), control)
        foreground_entered = Event()

        def foreground():
            with control.foreground():
                foreground_entered.set()

        with ThreadPoolExecutor(max_workers=2) as executor:
            extraction = executor.submit(runtime.extract, _window((uuid4(),)))
            self.assertTrue(model.first_returned.wait(1))
            reply = executor.submit(foreground)
            self.assertTrue(foreground_entered.wait(.2), '前台应在退避结束前开始。')
            reply.result(timeout=1)
            self.assertEqual(extraction.result(timeout=1), ())
        self.assertEqual(model.requests, 2)

    def test_background_limit_allows_three_inflight_and_queues_the_fourth(self):
        control = ModelPriorityControl(background_limit=3)
        entered = [Event() for _ in range(4)]
        release = [Event() for _ in range(4)]
        state_lock = Lock()
        state = {'active': 0, 'peak': 0}

        def call(index):
            with control.background_call():
                with state_lock:
                    state['active'] += 1
                    state['peak'] = max(state['peak'], state['active'])
                entered[index].set()
                try:
                    if not release[index].wait(2):
                        raise AssertionError('合成后台调用未释放。')
                finally:
                    with state_lock:
                        state['active'] -= 1

        with ThreadPoolExecutor(max_workers=4) as executor:
            inflight = [executor.submit(call, index) for index in range(3)]
            for index in range(3):
                self.assertTrue(entered[index].wait(1), f'第{index + 1}个后台调用应同时在途。')
            fourth = executor.submit(call, 3)
            try:
                self.assertFalse(entered[3].wait(.05), '达到上限后第4个后台调用应等待。')
                for index in range(3):
                    release[index].set()
                self.assertTrue(entered[3].wait(1), '释放许可后等待者应恢复。')
            finally:
                for flag in release:
                    flag.set()
            for future in [*inflight, fourth]:
                future.result(timeout=1)
        self.assertEqual(state['peak'], 3, '在途后台调用不得超过配置上限。')
        self.assertEqual(control.background_limit, 3)

    def test_foreground_does_not_preempt_inflight_but_blocks_new_background_calls(self):
        control = ModelPriorityControl(background_limit=3)
        inflight_entered, release_inflight = Event(), Event()
        foreground_requested, foreground_entered = Event(), Event()
        release_foreground, queued_entered = Event(), Event()

        def inflight():
            with control.background_call():
                inflight_entered.set()
                if not release_inflight.wait(2):
                    raise AssertionError('合成在途后台调用未释放。')

        def foreground():
            foreground_requested.set()
            with control.foreground():
                foreground_entered.set()
                if not release_foreground.wait(2):
                    raise AssertionError('合成前台回复未释放。')

        def queued():
            with control.background_call():
                queued_entered.set()

        with ThreadPoolExecutor(max_workers=3) as executor:
            active = executor.submit(inflight)
            self.assertTrue(inflight_entered.wait(1))
            replying = executor.submit(foreground)
            self.assertTrue(foreground_requested.wait(1))
            self.assertFalse(foreground_entered.wait(.05), '前台须等待在途后台调用释放。')
            waiting = executor.submit(queued)
            try:
                self.assertFalse(queued_entered.wait(.05), '前台等待期间不得开始新的后台调用。')
                release_inflight.set()
                self.assertTrue(foreground_entered.wait(1), '在途后台调用释放后前台进入。')
                self.assertFalse(queued_entered.wait(.05), '前台活跃期间仍不得开始后台调用。')
                release_foreground.set()
                self.assertTrue(queued_entered.wait(1), '前台结束后等待的后台调用恢复。')
            finally:
                release_inflight.set()
                release_foreground.set()
            for future in (active, replying, waiting):
                future.result(timeout=1)

    def test_stop_wakes_all_waiters_and_rejects_new_calls(self):
        control = ModelPriorityControl(background_limit=1)
        active_entered, release_active = Event(), Event()

        def active_call():
            with control.background_call():
                active_entered.set()
                if not release_active.wait(2):
                    raise AssertionError('合成在途后台调用未释放。')

        def blocked_background():
            with control.background_call():
                raise AssertionError('停止后不应进入后台调用。')

        def blocked_foreground():
            with control.foreground():
                raise AssertionError('停止后不应进入前台。')

        with ThreadPoolExecutor(max_workers=4) as executor:
            active = executor.submit(active_call)
            self.assertTrue(active_entered.wait(1))
            waiters = [executor.submit(blocked_background) for _ in range(2)]
            foreground_waiter = executor.submit(blocked_foreground)
            try:
                control.stop()
                for future in [*waiters, foreground_waiter]:
                    with self.assertRaises(ModelWorkStopped):
                        future.result(timeout=1)
            finally:
                release_active.set()
            with self.assertRaises(ModelWorkStopped):
                active.result(timeout=1)
        with self.assertRaises(ModelWorkStopped):
            with control.background_call():
                raise AssertionError('停止后新调用应立即失败。')
        with self.assertRaises(ModelWorkStopped):
            with control.foreground():
                raise AssertionError('停止后新前台应立即失败。')

    def test_default_background_limit_keeps_single_permit(self):
        control = ModelPriorityControl()
        self.assertEqual(control.background_limit, 1)
        entered = [Event(), Event()]
        release = [Event(), Event()]

        def call(index):
            with control.background_call():
                entered[index].set()
                if not release[index].wait(2):
                    raise AssertionError('合成后台调用未释放。')

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(call, 0)
            self.assertTrue(entered[0].wait(1))
            second = executor.submit(call, 1)
            try:
                self.assertFalse(entered[1].wait(.05), '默认只允许一个后台调用在途。')
                release[0].set()
                self.assertTrue(entered[1].wait(1), '前一个调用释放后第二个恢复。')
            finally:
                release[0].set()
                release[1].set()
            first.result(timeout=1)
            second.result(timeout=1)

    def test_background_limit_rejects_invalid_values(self):
        with self.assertRaises(ValueError):
            ModelPriorityControl(background_limit=0)
        with self.assertRaises(TypeError):
            ModelPriorityControl(background_limit=True)
