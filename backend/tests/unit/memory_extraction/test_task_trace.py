"""指定任务的非正文配置追踪；空输入和实际完整窗口采用同一合同。"""

from __future__ import annotations

from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.scopes import ContactScope
from notalone.tasks.models import ExtractionRuntimeConfig, ExtractionRuntimeMode
from tests.unit.memory_extraction.test_models import _window


class _EmptyRuntime:
    def __init__(self) -> None:
        self.windows = []

    def extract(self, window):
        self.windows.append(window)
        return ()


class TaskRuntimeTraceTest(unittest.TestCase):
    def _run(self, *, messages=(), watermark=None, **kwargs):
        scope = ContactScope(uuid4(), uuid4())
        trace = InMemoryTraceStore()
        runtime = _EmptyRuntime()
        stats = run_extraction(
            scope=scope, messages=messages, watermark_message_id=watermark,
            runtime=runtime, memory_port=InMemoryMemoryStore(),
            owner_memory_port=None, trace_store=trace, **kwargs,
        )
        payloads = tuple(
            trace.get_batch(scope, batch["trace_id"])["events"][0]["payload"]
            for batch in trace.list_batches(scope)
        )
        return stats, runtime, payloads

    def test_empty_input_records_explicit_legacy_task_without_model_call(self):
        task_id = uuid4()
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        stats, runtime, payloads = self._run(
            task_id=task_id, extraction_runtime_config=config,
        )
        self.assertEqual(stats.batches, 0)
        self.assertEqual(runtime.windows, [])
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["task_runtime"], {
            "task_id": str(task_id), "mode": "legacy",
            "config_version": 1, "rule_set_sha256": None,
        })
        self.assertEqual(payloads[0]["target_message_ids"], [])

    def test_historical_null_task_config_stays_null_even_when_up_to_date(self):
        message = _window((uuid4(),)).messages[0]
        task_id = uuid4()
        _, runtime, payloads = self._run(
            messages=(message,), watermark=message.message_id, task_id=task_id,
        )
        self.assertEqual(runtime.windows, [])
        self.assertEqual(payloads[0]["task_runtime"], {
            "task_id": str(task_id), "mode": "legacy",
            "config_version": None, "rule_set_sha256": None,
        })

    def test_every_batch_keeps_task_config_and_the_actual_complete_window(self):
        messages = tuple(
            replace(item, text=f"合成完整消息{index}")
            for index, item in enumerate(_window(tuple(uuid4() for _ in range(5))).messages)
        )
        task_id = uuid4()
        _, runtime, payloads = self._run(
            messages=messages, task_id=task_id, batch_size=2,
            extraction_runtime_config=ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None),
        )
        self.assertEqual(len(runtime.windows), 3)
        self.assertEqual(len(payloads), 3)
        expected = {item.message_id: item.text for item in messages}
        for payload in payloads:
            self.assertEqual(payload["task_runtime"]["task_id"], str(task_id))
            self.assertEqual(payload["task_runtime"]["config_version"], 1)
            self.assertEqual(
                {item["message_id"]: item["text"] for item in payload["messages"]},
                {str(key): value for key, value in expected.items()},
            )
        self.assertEqual(
            {identifier for payload in payloads for identifier in payload["target_message_ids"]},
            {str(item.message_id) for item in messages},
        )

    def test_direct_default_preserves_existing_trace_contract(self):
        _, _, payloads = self._run()
        self.assertNotIn("task_runtime", payloads[0])

    def test_invalid_task_config_fails_before_trace_or_model(self):
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        for kwargs in (
            {"extraction_runtime_config": config},
            {"task_id": "not-a-uuid"},
            {"task_id": True},
            {"task_id": uuid4(), "extraction_runtime_config": config.to_payload()},
        ):
            with self.subTest(kwargs=kwargs):
                runtime, trace = _EmptyRuntime(), InMemoryTraceStore()
                scope = ContactScope(uuid4(), uuid4())
                with self.assertRaises(ValueError):
                    run_extraction(
                        scope=scope, messages=(), watermark_message_id=None,
                        runtime=runtime, memory_port=InMemoryMemoryStore(),
                        owner_memory_port=None, trace_store=trace, **kwargs,
                    )
                self.assertEqual(runtime.windows, [])
                self.assertEqual(trace.list_batches(scope), ())


if __name__ == "__main__":
    unittest.main()
