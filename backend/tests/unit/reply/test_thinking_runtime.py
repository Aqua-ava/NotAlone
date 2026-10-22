"""同一官方模型的思考模式：离线实际 SDK/图/计量及有界输出回归。"""
import json
import unittest
from langchain_core.messages import AIMessage
from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
from notalone.reply.errors import ReplyError
from notalone.reply.adapters.thinking_deepseek import ThinkingDeepSeek
from tests.unit.reply import test_ecnu_input_budget as ecnu
from tests.unit.reply.test_input_budget_runtime import prepared_context, reply_output


class ThinkingRuntimeTest(unittest.TestCase):
    model_class = ThinkingDeepSeek
    model_name = 'deepseek-flash'
    base_url = 'https://api.deepseek.com'
    model = ecnu.EcnuInputBudgetTest.model
    runtime = ecnu.EcnuInputBudgetTest.runtime
    budget_builder = staticmethod(build_deepseek_input_budget)

    def thinking_model(self, **kwargs):
        return self.model(extra_body={'thinking': {'type': 'enabled'}}, reasoning_effort='low', **kwargs)

    def test_thinking_uses_auto_and_counts_actual_final_output_tool(self):
        model, requests = self.thinking_model()
        result = self.runtime(model).generate(prepared_context())
        self.assertEqual(result.candidates[0].text, reply_output().tool_calls[0]['args']['candidates'][0]['text'])
        self.assertEqual(len(requests), 1)
        payload = json.loads(requests[0])
        self.assertEqual(payload['thinking'], {'type': 'enabled'})
        self.assertEqual(payload['reasoning_effort'], 'low')
        self.assertIn(payload.get('tool_choice'), (None, 'auto'))
        self.assertEqual(sum(t['function']['name'] == 'ReplyRuntimeOutput' for t in payload['tools']), 1)
        self.assertEqual(result.input_budget.input_tokens, len(requests[0]) + 4096)

    def test_plain_text_without_final_output_tool_fails_without_retry_loop(self):
        model, requests = self.thinking_model(responses=[AIMessage(content='未经结构核验的普通文字')])
        with self.assertRaises(ReplyError):
            self.runtime(model).generate(prepared_context())
        self.assertEqual(len(requests), 1)

    def test_changed_thinking_configuration_cannot_reuse_counter(self):
        model, requests = self.thinking_model()
        configuration = self.budget_builder(model)
        self.assertIsNotNone(configuration)
        _, counter = configuration
        model.extra_body = {'thinking': {'type': 'disabled'}}
        self.assertFalse(counter.is_bound_to(model))
        self.assertEqual(requests, [])

    def test_parallel_final_outputs_are_rejected(self):
        output = reply_output()
        output.tool_calls.append({**output.tool_calls[0], 'id': 'another-final-output'})
        model, requests = self.thinking_model(responses=[output])
        with self.assertRaises(ReplyError):
            self.runtime(model).generate(prepared_context())
        self.assertEqual(len(requests), 1)

    def test_tool_round_keeps_reasoning_and_every_complete_request_is_counted(self):
        first = AIMessage(content='', additional_kwargs={'reasoning_content': '合成供应商占位字段。'}, tool_calls=[{
            'id': 'synthetic-read', 'name': 'read_file',
            'args': {'file_path': '/notalone/reply-skills/unknown/SKILL.md'},
        }])
        model, requests = self.thinking_model(responses=[first, reply_output()])
        decisions = []
        result = self.runtime(model, decisions=decisions).generate(prepared_context())
        self.assertTrue(result.candidates)
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(decisions), 2)
        second = json.loads(requests[1])
        prior = next(message for message in second['messages'] if message.get('tool_calls'))
        self.assertEqual(prior['reasoning_content'], '合成供应商占位字段。')
        for request, decision in zip(requests, decisions):
            self.assertEqual(decision.input_tokens, len(request) + 4096)

    def test_mixed_final_cannot_be_retried_into_valid_output(self):
        first = reply_output()
        first.tool_calls.append({'id': 'mixed-read', 'name': 'read_file',
            'args': {'file_path': '/notalone/reply-skills/unknown/SKILL.md'}})
        model, requests = self.thinking_model(responses=[first, reply_output()])
        with self.assertRaises(ReplyError):
            self.runtime(model).generate(prepared_context())
        self.assertEqual(len(requests), 1)
