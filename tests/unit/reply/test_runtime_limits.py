"""通过真实框架运行时验证生成预算，全部使用合成输入。"""

import asyncio
import time
import unittest

from langchain_core.messages import AIMessage

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.errors import ReplyRunError
from tests.unit.reply.test_langchain_vertical_slice import (
    EmptySkillPort,
    ToolCallingFakeModel,
)
from tests.unit.reply.test_ledger_wiring import _make_command, _make_context


class RepeatingModel(ToolCallingFakeModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if len(self.seen_calls) >= 40:
            raise RuntimeError("合成测试保险上限，防止旧实现无限循环")
        return super()._generate(messages, stop, run_manager, **kwargs)


class SlowModel(ToolCallingFakeModel):
    cancelled: bool = False

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            await asyncio.sleep(2)
            return self._generate(messages, stop, run_manager, **kwargs)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class RuntimeLimitsTest(unittest.TestCase):
    def test_repeated_tool_calls_stop_within_reply_budget(self):
        context = _make_context(_make_command())
        model = RepeatingModel(responses=[AIMessage(content="", tool_calls=[{
            "name": "read_file", "args": {"file_path": "/missing/SKILL.md"},
            "id": "synthetic-repeat",
        }])])
        runtime = LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(context.scope, 4),
        )
        with self.assertRaises(ReplyRunError):
            runtime.generate(context)
        self.assertLessEqual(len(model.seen_calls), 12)

    def test_slow_model_is_cancelled_before_returning_timeout(self):
        context = _make_context(_make_command())
        model = SlowModel(responses=[AIMessage(content="合成迟到输出")])
        runtime = LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(context.scope, 4),
            timeout_seconds=0.05,
        )
        started = time.monotonic()
        with self.assertRaises(ReplyRunError):
            runtime.generate(context)
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(model.cancelled)
        self.assertEqual(model.seen_calls, [])
