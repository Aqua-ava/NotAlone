"""通过真实框架运行时验证生成预算，全部使用合成输入。"""

import inspect
import asyncio
import time
import unittest
from datetime import timedelta
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.retrieval import InMemoryRetrieval

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.errors import ReplyBudgetError, ReplyRunError
from tests.unit.reply.test_langchain_vertical_slice import (
    EmptySkillPort,
    MESSAGE_ID,
    ToolCallingFakeModel,
)
from tests.unit.reply.test_ledger_wiring import _make_command, _make_context


# 运行时限为 recursion_limit=16；真实模型每轮输出唯一 id 的 AIMessage，
# 每轮消耗 2 步（模型 + 工具节点），因此工具循环最多 8 个模型轮。
MAX_MODEL_ROUNDS = 8


class FreshRepeatingModel(ToolCallingFakeModel):
    """每轮生成全新 AIMessage（唯一 id），模拟真实模型的追加式消息历史。"""

    tool_call: dict[str, Any]

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        if len(self.seen_calls) >= 40:
            raise RuntimeError("合成测试保险上限，防止旧实现无限循环")
        self.seen_calls.append(messages)
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[{**self.tool_call, "id": f"synthetic-{len(self.seen_calls)}"}],
                    )
                )
            ]
        )


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
        model = FreshRepeatingModel(
            tool_call={"name": "read_file", "args": {"file_path": "/missing/SKILL.md"}},
            responses=[AIMessage(content="")],
        )
        runtime = LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(context.scope, 4),
        )
        with self.assertRaises(ReplyRunError):
            runtime.generate(context)
        self.assertLessEqual(len(model.seen_calls), MAX_MODEL_ROUNDS)

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

    def test_search_loop_still_outputs_after_budget_exhaustion(self):
        """回归 issue 02：历史检索预算耗尽后必须仍能产出最终结构化候选。"""

        context = _make_context(_make_command())
        responses = [
            AIMessage(content="", tool_calls=[{
                "name": "read_file", "args": {"file_path": "/missing/SKILL.md"},
                "id": "synthetic-skill-read",
            }]),
        ]
        for index in range(5):
            responses.append(AIMessage(content="", tool_calls=[{
                "name": "conversation_search",
                "args": {"query": f"合成查询词 {index}"},
                "id": f"synthetic-search-{index}",
            }]))
        responses.append(AIMessage(content="", tool_calls=[{
            "name": "ReplyRuntimeOutput",
            "args": {
                "candidates": [{
                    "text": "基于已有证据的合成候选。",
                    "basis": "历史检索未命中，使用当前文本与既有依据。",
                    "citation_ids": [str(MESSAGE_ID)],
                    "risk_notes": [],
                }],
                "used_skill_version_id": None,
            },
            "id": "synthetic-final-output",
        }]))
        model = ToolCallingFakeModel(responses=responses)
        runtime = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(context.scope, 4),
            retrieval=InMemoryRetrieval(),
        )
        result = runtime.generate(context)

        self.assertEqual(len(model.seen_calls), 7)
        self.assertEqual(len(result.candidates), 1)
        self.assertEqual(result.candidates[0].text, "基于已有证据的合成候选。")
        statuses = [trace.status for trace in result.tool_calls]
        self.assertEqual(
            statuses,
            ["empty", "empty", "empty", "budget_exceeded", "budget_exceeded"],
        )

    def test_model_that_never_outputs_stays_bounded(self):
        """历史检索无限重试仍必须在步骤上限内以预算错误收尾。"""

        context = _make_context(_make_command())
        model = FreshRepeatingModel(
            tool_call={"name": "conversation_search", "args": {"query": "合成查询"}},
            responses=[AIMessage(content="")],
        )
        runtime = LangChainReplyRuntime(
            model=model,
            skill_port=EmptySkillPort(context.scope, 4),
            retrieval=InMemoryRetrieval(),
        )
        with self.assertRaises(ReplyBudgetError):
            runtime.generate(context)
        self.assertLessEqual(len(model.seen_calls), MAX_MODEL_ROUNDS)

    def test_default_reply_lease_exceeds_generation_cap_with_margin(self) -> None:
        """回复请求租约必须覆盖生成时限上限加取消等待余量。

        生成整图被 runtime 时限（构造上限 20s）包住，取消后再等待
        ``seconds + 2`` 秒兜底；租约小于它时，长生成虽已产出候选，
        ``save`` 会判定租约过期并丢弃。调整任一侧都要同步复核另一方。
        """

        default_lease = inspect.signature(
            PostgresReplyStore.__init__
        ).parameters["lease_duration"].default
        runtime_cap = LangChainReplyRuntime.MAX_GENERATION_TIMEOUT_SECONDS

        self.assertGreater(default_lease, timedelta(seconds=runtime_cap + 2))
