"""LangChain 提取运行时的结构化输出解析测试。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.memory_extraction.adapters import (
    EXTRACTION_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
    LangChainExtractionRuntime,
)
from notalone.memory_extraction.errors import ExtractionRuntimeError
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


def _structured_response(payloads: tuple[dict, ...], call_id: str = "facts-1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "MemoryExtractionOutput",
                "args": {"facts": list(payloads)},
                "id": call_id,
            }
        ],
    )


class LangChainExtractionRuntimeTest(unittest.TestCase):
    """只用 fake model 验证传输与整体解析行为，不发起外部调用。"""

    def _runtime(self, responses: list[AIMessage]):
        self.model = ToolCallingFakeModel(responses=responses)
        return LangChainExtractionRuntime(model=self.model)

    def test_returns_raw_payloads(self) -> None:
        message_id = uuid4()
        payload = _payload(message_id)

        runtime = self._runtime([_structured_response((payload,))])
        result = runtime.extract(_window((message_id,)))

        self.assertEqual(result, (payload,))

    def test_unparseable_response_raises_runtime_error(self) -> None:
        runtime = self._runtime(
            [AIMessage(content="模型没有按结构化格式返回。")]
        )

        with self.assertRaises(ExtractionRuntimeError):
            runtime.extract(_window((uuid4(),)))

    def test_model_exception_is_mapped_to_runtime_failure(self) -> None:
        class RaisingModel:
            def bind_tools(self, tools):  # noqa: ARG002
                raise RuntimeError("synthetic provider failure")

        runtime = LangChainExtractionRuntime(model=RaisingModel())

        with self.assertRaisesRegex(ExtractionRuntimeError, "模型调用失败"):
            runtime.extract(_window((uuid4(),)))

    def test_prompt_marks_message_ids_and_senders(self) -> None:
        runtime = self._runtime(
            [_structured_response((_payload(uuid4()),))]
        )
        runtime.extract(_window((uuid4(),)))

        seen = "\n".join(
            str(message.content)
            for call in self.model.seen_calls
            for message in call
        )
        self.assertIn("message_id=", seen)
        self.assertIn("sender=", seen)

    def test_prompt_marks_target_and_context_messages(self) -> None:
        target_id = uuid4()
        context_id = uuid4()
        window = _window((context_id, target_id))
        window = window.__class__(
            owner_id=window.owner_id,
            contact_id=window.contact_id,
            messages=window.messages,
            target_message_ids=(target_id,),
        )
        runtime = self._runtime(
            [_structured_response((_payload(target_id),))]
        )

        runtime.extract(window)

        seen = "\n".join(
            str(message.content)
            for call in self.model.seen_calls
            for message in call
        )
        self.assertIn("[target]", seen)
        self.assertIn("[context]", seen)

    def test_schema_requires_pragmatic_interpretation_fields(self) -> None:
        required = set(
            EXTRACTION_SCHEMA["properties"]["facts"]["items"]["required"]
        )

        self.assertTrue(
            {
                "speech_act",
                "assertion_status",
                "figurative_type",
                "alternatives",
                "interpretation_reason",
            } <= required
        )
        self.assertIn("语用", EXTRACTION_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
