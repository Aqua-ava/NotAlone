"""通过实际 SDK 的 HTTP 边界验证提取恢复，不含真实聊天。"""
import json
import unittest
from uuid import uuid4
import httpx
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from notalone.memory_extraction.errors import ExtractionRuntimeError
from tests.unit.memory_extraction.test_models import _window

class DirectRecoveryTests(unittest.TestCase):
    def run_runtime(self, replies, **options):
        requests = []
        def handle(request):
            requests.append(json.loads(request.read()))
            value = replies[min(len(requests)-1, len(replies)-1)]
            if isinstance(value, Exception): raise value
            if isinstance(value, int): return httpx.Response(value, json={'error': {'message': 'synthetic'}})
            return httpx.Response(200, json={'id':'synthetic','object':'chat.completion','created':1,'model':'deepseek-flash','choices':[{'index':0,'finish_reason':'tool_calls','message':{'role':'assistant','content':None,'tool_calls':[{'id':'call1','type':'function','function':{'name':'DirectMemoryExtractionOutput','arguments':value}}]}}]})
        client=httpx.Client(transport=httpx.MockTransport(handle))
        self.addCleanup(client.close)
        model=build_deepseek_model(api_key='synthetic',max_retries=0,http_client=client)
        runtime=DirectExtractionRuntime(model=model, max_retries=1, retry_delay_seconds=0, **options)
        return runtime,requests

    def test_repairs_missing_opening_quote_without_extra_request(self):
        raw='{"scenes":[{"scene_name":"合成主题","memories":[{"text":"合成事实", valid_at":null}]}]}'
        runtime,requests=self.run_runtime([raw])
        result=runtime.extract(_window((uuid4(),)))
        self.assertEqual(result[0]['text'],'合成事实')
        self.assertIsNone(result[0]['valid_at'])
        self.assertEqual(len(requests),1)

    def test_connection_failure_retries_same_input_once(self):
        runtime,requests=self.run_runtime([httpx.ConnectError('synthetic'), '{"scenes":[]}'])
        self.assertEqual(runtime.extract(_window((uuid4(),))),())
        self.assertEqual(len(requests),2)
        self.assertEqual(requests[0],requests[1])

    def test_auth_failure_is_not_retried(self):
        runtime,requests=self.run_runtime([401])
        with self.assertRaisesRegex(ExtractionRuntimeError,'AuthenticationError'):
            runtime.extract(_window((uuid4(),)))
        self.assertEqual(len(requests),1)

    def test_retry_exhaustion_does_not_multiply_sdk_attempts(self):
        runtime,requests=self.run_runtime([503])
        with self.assertRaises(ExtractionRuntimeError):runtime.extract(_window((uuid4(),)))
        self.assertEqual(len(requests),2)

    def test_truncated_json_is_not_completed_and_is_retried(self):
        runtime,requests=self.run_runtime(['{"scenes": [', '{"scenes":[]}'])
        self.assertEqual(runtime.extract(_window((uuid4(),))),())
        self.assertEqual(len(requests),2)

    def test_trailing_comma_repair_preserves_string_contents(self):
        raw='{"scenes":[{"scene_name":"主题","memories":[{"text":"字面 ,} 和 valid_at\\\" 保持原样",},],},]}'
        runtime,requests=self.run_runtime([raw])
        result=runtime.extract(_window((uuid4(),)))
        self.assertEqual(result[0]['text'],'字面 ,} 和 valid_at" 保持原样')
        self.assertEqual(len(requests),1)

    def test_duplicate_keys_cannot_be_repaired(self):
        from notalone.memory_extraction.json_recovery import parse_arguments
        with self.assertRaises(ValueError):
            parse_arguments('{"scenes":[],"scenes":[1]}',field_names=frozenset({'scenes'}))

    def test_trace_write_failure_is_not_retried(self):
        from unittest.mock import patch
        from notalone.memory_trace import TraceWriteError
        runtime,requests=self.run_runtime(['{"scenes":[]}'])
        with patch('notalone.memory_extraction.direct_adapter.invoke_traced_model',side_effect=TraceWriteError('synthetic',uuid4())) as invoke:
            with self.assertRaises(TraceWriteError):runtime.extract(_window((uuid4(),)))
        self.assertEqual(invoke.call_count,1)
        self.assertEqual(len(requests),0)
