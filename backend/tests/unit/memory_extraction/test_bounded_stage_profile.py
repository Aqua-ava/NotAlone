"""有限任务教学增量沿真实SDK与任务选择；不认证模型质量。"""
from dataclasses import replace
import hashlib
import json
import unittest
from unittest.mock import patch, Mock
from uuid import uuid4

from tests.integration.memory_extraction import test_evaluation_wire_contract as wire_tests
from tests.unit.memory_extraction.test_bounded_runtime_proof import window_for, messages_window


class BoundedStageProfileTest(unittest.TestCase):
    setUp = wire_tests.EvaluationWireContractTest.setUp
    model = wire_tests.EvaluationWireContractTest.model

    def test_dependency_v2_sdk_keeps_selected_and_missing_dependencies_without_repair(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.flow import _to_fact
        from notalone.memory_extraction.source_proof import parse_proposal, _validate_positions
        from notalone.tasks.extraction_runtime import extraction_runtime_for_config, runtime_config_for_mode
        from notalone.tasks.models import ExtractionRuntimeMode
        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        for context, target, dependency in (
            ("我把实验记录册叫作青签。", "青签已经编号好了。", "0:0"),
            ("今天窗外有雾。", "实验记录册已经编号好了。", None),
            # 模型漏选：不得由教学、编译器或包装器替它补依赖。
            ("我把实验记录册叫作青签。", "青签已经编号好了。", None),
        ):
            window = messages_window((context, target))
            for runtime_type, events in ((adapter.GroundedExtractionRuntime, True), (adapter.GroundedV2ExtractionRuntime, False)):
                row = {"kind": "event", "subject": "contact", "topic": "other", "dependency": dependency,
                       "unresolved": False, "confidence": .6, "sensitivity": "none", **({"event": None} if events else {})}
                model = self.model(tool_name="GroundedMemoryLabels", arguments={"units": {"1:0": row}})
                selected = extraction_runtime_for_config(runtime_type(model=model), config)
                self.assertEqual(selected.prompt_profile, "bounded-dependency-teaching-v2")
                raw, = selected.extract(window)
                self.assertEqual(raw["confidence"], .6)
                self.assertEqual(set(raw["source_message_ids"]), {str(window.messages[-1].message_id),
                    *([str(window.messages[0].message_id)] if dependency else [])})
                self.assertEqual("（相关原文：" in raw["text"], dependency is not None)
                if dependency:
                    self.assertIn(context, raw["text"])
                actual = self.requests[-1][2]
                self.assertEqual(actual["messages"][0]["content"],
                    adapter.grounded_v2_prompt("bounded-dependency-teaching-v2", events=events))
                # 仅验证来源域；这个独立教学词汇不授予六类语义正证。
                origin = {"message_id": str(window.messages[0].message_id), "start": 0, "end": len(context)}
                mention = {"message_id": str(window.messages[-1].message_id), "start": 0, "end": 2}
                proposal = parse_proposal({"version": 3, "atom_links": None, "reported": None,
                    "reference": [{"rule_id": "BR_KIN_LEND_V1", "mention": mention, "target": origin, "binding": origin}]}, version=3)
                if dependency:
                    _validate_positions(proposal, window, _to_fact(raw))
                else:
                    with self.assertRaisesRegex(ValueError, "证明区间不属于实际候选来源"):
                        _validate_positions(proposal, window, _to_fact(raw))

    def test_dependency_v3_crosses_target_omission_and_required_context_without_repair(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.flow import _to_fact
        from notalone.memory_extraction.source_proof import parse_proposal, _validate_positions
        from notalone.tasks.extraction_runtime import extraction_runtime_for_config, runtime_config_for_mode
        from notalone.tasks.models import ExtractionRuntimeMode
        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        profile = "bounded-dependency-teaching-v3"
        for all_targets in (False, True):
            for required in (False, True):
                context = "我把实验记录册叫作青签。" if required else "今天窗外有雾。"
                target = "青签已经编号好了。" if required else "实验记录册已经编号好了。"
                window = messages_window((context, target), all_targets=all_targets)
                # 正例选择；负例null；必要上下文另模拟漏选，程序不得补写。
                for dependency in (("0:0", None) if required else (None,)):
                    for runtime_type, events in ((adapter.GroundedExtractionRuntime, True), (adapter.GroundedV2ExtractionRuntime, False)):
                        row = {"kind": "event", "subject": "contact", "topic": "other", "dependency": dependency,
                               "unresolved": False, "confidence": .6, "sensitivity": "none", **({"event": None} if events else {})}
                        labels = {"1:0": row}
                        if all_targets:
                            labels["0:0"] = {**row, "kind": "not_memory", "dependency": None}
                        model = self.model(tool_name="GroundedMemoryLabels", arguments={"units": labels})
                        runtime = runtime_type(model=model).for_prompt_profile(profile)
                        selected = extraction_runtime_for_config(runtime, config)
                        self.assertEqual(selected.prompt_profile, profile)
                        raw, = selected.extract(window)
                        self.assertEqual(raw["confidence"], .6)
                        self.assertEqual(len(raw["source_message_ids"]), 2 if dependency else 1)
                        self.assertEqual("（相关原文：" in raw["text"], bool(dependency))
                        actual = self.requests[-1][2]
                        self.assertEqual(actual["messages"][0]["content"], adapter.grounded_v2_prompt(profile, events=events))
                        self.assertIn("not_memory", actual["messages"][0]["content"])
                        self.assertEqual("[0:0] [target]" in actual["messages"][1]["content"], all_targets)
                        origin = {"message_id": str(window.messages[0].message_id), "start": 0, "end": len(context)}
                        mention = {"message_id": str(window.messages[-1].message_id), "start": 0, "end": 2}
                        proof = parse_proposal({"version": 3, "atom_links": None, "reported": None,
                            "reference": [{"rule_id": "BR_KIN_LEND_V1", "mention": mention, "target": origin, "binding": origin}]}, version=3)
                        if dependency:
                            _validate_positions(proof, window, _to_fact(raw))
                        else:
                            with self.assertRaisesRegex(ValueError, "证明区间不属于实际候选来源"):
                                _validate_positions(proof, window, _to_fact(raw))

    def test_default_prompt_bytes_and_closed_profile_are_unchanged(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.evaluation_extraction import extraction_contract, extraction_runtime
        # 从本轮修改前HEAD取得；保护core/reference的实际提示字节。
        for name, digest in (
            ("BOUNDED_DEPENDENCY_TEACHING_V2", "9e9de6989fc4ea6cd2f421923b4c15be19bc57afce9074611c3b5e3ee6f9523d"),
            ("BOUNDED_STAGE_TEACHING_V1", "45d896ce822de702e7870e5a8e172d997398b9981f0483b564732b6bb52071f6"),
            ("GROUNDED_V2_PROMPT", "837344477304319f03f770e2d94571755d5cee8b445c6f3b3c7c1eeb63fa6a52"),
            ("GROUNDED_V3_PROMPT", "e35b256adc84a7e61faade14267a187b7844f8b16abcdb9819371ed70905e7cf"),
            ("GROUNDED_V4_PROMPT", "2feb96d892198307e082328cf8af092e3ac62587267116cc682649b468ec961c"),
        ):
            self.assertEqual(hashlib.sha256(getattr(adapter, name).encode()).hexdigest(), digest)
        self.assertEqual(hashlib.sha256(adapter.grounded_v2_prompt(adapter.BOUNDED_STAGE_PROMPT_PROFILE).encode()).hexdigest(),
                         "abfb51c173c181bacfa180dc696bd4ef5f1978a05b5dc80ccff2b6cde70aa7ce")
        self.assertEqual(hashlib.sha256(adapter.grounded_v2_prompt(adapter.BOUNDED_DEPENDENCY_PROMPT_PROFILE).encode()).hexdigest(),
                         "6ac7ef8a6c7d2fb81909af7bd6c884aab621c5c0d0f56354e5973bfae52d2e1c")
        for runtime_type in (adapter.GroundedExtractionRuntime, adapter.GroundedV2ExtractionRuntime):
            old = runtime_type(model=Mock()).for_prompt_profile(adapter.BOUNDED_STAGE_PROMPT_PROFILE)
            self.assertEqual(old.prompt_profile, adapter.BOUNDED_STAGE_PROMPT_PROFILE)
        for profile in (None, True, [], "bounded-stage-teaching-v2", "reference-uniqueness-v1"):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                adapter.GroundedExtractionRuntime(model=Mock()).for_prompt_profile(profile)
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                adapter.GroundedV2ExtractionRuntime(model=Mock()).for_prompt_profile(profile)
        for mode in ("legacy-e14", "grounded-v3", "grounded-v4"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                extraction_contract(mode, window_for("合成资料。"), prompt_profile=adapter.BOUNDED_DEPENDENCY_PROMPT_PROFILE)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                extraction_runtime(mode, Mock(), prompt_profile=adapter.BOUNDED_DEPENDENCY_PROMPT_PROFILE)

    def test_actual_sdk_both_protocols_keep_schema_compiler_and_raw_confidence(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.grounded import compile_labels, compile_event_labels
        from notalone.tasks.extraction_runtime import extraction_runtime_for_config, runtime_config_for_mode
        from notalone.tasks.models import ExtractionRuntimeMode, ExtractionRuntimeConfig
        window = window_for("我已经晾好衣服了。")
        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        for runtime_type, events in ((adapter.GroundedExtractionRuntime, True), (adapter.GroundedV2ExtractionRuntime, False)):
            row = {"kind": "event", "subject": "contact", "topic": "other", "dependency": None,
                   "unresolved": False, "confidence": .6, "sensitivity": "none", **({"event": None} if events else {})}
            draft = {"units": {"0:0": row}}
            model = self.model(tool_name="GroundedMemoryLabels", arguments=draft)
            original = runtime_type(model=model)
            original.extract(window)
            baseline = self.requests[-1][2]
            base_prompt = adapter.GROUNDED_V2_PROMPT + (adapter.GROUNDED_EVENT_PROMPT if events else "")
            self.assertEqual(baseline["messages"][0]["content"], base_prompt)
            for saved in (config, ExtractionRuntimeConfig.from_payload(config.to_payload())):
                selected = extraction_runtime_for_config(original, saved)
                self.assertIsInstance(selected, runtime_type)
                self.assertIsNot(selected, original)
                with patch.object(adapter, "record") as record:
                    facts = selected.extract(window)
                expected = (compile_event_labels if events else compile_labels)(window, draft)
                self.assertEqual(facts, expected)
                self.assertEqual(facts[0]["confidence"], .6)
                actual = self.requests[-1][2]
                self.assertEqual(actual["tools"], baseline["tools"])
                self.assertEqual(actual["messages"][1:], baseline["messages"][1:])
                prompt = actual["messages"][0]["content"]
                self.assertEqual(prompt, base_prompt + adapter.BOUNDED_STAGE_TEACHING_V1 + adapter.BOUNDED_DEPENDENCY_TEACHING_V2)
                for call in record.call_args_list:
                    identity = call.args[1]
                    self.assertEqual(identity["prompt_profile"], adapter.BOUNDED_DEPENDENCY_PROMPT_PROFILE)
                    self.assertEqual(identity["prompt_sha256"], hashlib.sha256(json.dumps(prompt, ensure_ascii=False,
                        sort_keys=True, separators=(",", ":")).encode()).hexdigest())
            original.extract(window)
            self.assertEqual(self.requests[-1][2], baseline)

    def test_worker_selects_through_priority_without_changing_protocol_or_legacy(self):
        from contextlib import nullcontext
        from notalone.application.model_priority import PriorityExtractionRuntime
        from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime, BOUNDED_DEPENDENCY_PROMPT_PROFILE
        from notalone.tasks.extraction_runtime import extraction_runtime_for_config, runtime_config_for_mode
        from notalone.tasks.models import ExtractionRuntimeMode
        from notalone.tasks.worker import PostgresMemoryExtractionRunner
        from notalone.scopes import ContactScope
        runtime = GroundedExtractionRuntime(model=Mock())
        control = Mock()
        control.background_call.side_effect = lambda: nullcontext()
        accounting = Mock()
        priority = PriorityExtractionRuntime(runtime, control, accounting=accounting)
        legacy = runtime_config_for_mode(ExtractionRuntimeMode.LEGACY)
        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        self.assertIs(extraction_runtime_for_config(priority, None), priority)
        self.assertIs(extraction_runtime_for_config(priority, legacy), priority)
        with self.assertRaises(ValueError):
            extraction_runtime_for_config(priority, replace(config, rule_set_sha256="0" * 64))
        with self.assertRaises(ValueError):
            extraction_runtime_for_config(object(), config)
        runner = PostgresMemoryExtractionRunner.__new__(PostgresMemoryExtractionRunner)
        for name in runner.__slots__:
            setattr(runner, name, Mock())
        runner._runtime = priority
        runner._verification_runtime.for_mode.return_value.verification_mode = "nullable-proof-v3"
        with patch("notalone.memory_extraction.cli_support.load_contact_messages", return_value=()), \
                patch("notalone.persistence.memory_processing.PostgresMemoryProcessingStore.targets", return_value=((), (), 1)), \
                patch("notalone.tasks.worker.run_extraction") as run:
            runner.run(scope=ContactScope(uuid4(), uuid4()), task_id=uuid4(), extraction_runtime_config=config)
        selected = run.call_args.kwargs["runtime"]
        self.assertEqual(selected.prompt_profile, BOUNDED_DEPENDENCY_PROMPT_PROFILE)
        self.assertIs(selected._control, control)
        self.assertIs(selected._accounting, accounting)
        with patch.object(GroundedExtractionRuntime, "extract", return_value=[]) as extract:
            selected.extract(window_for("合成资料。"))
        extract.assert_called_once()
        accounting.extraction_started.assert_called_once()
        accounting.extraction_returned.assert_called_once()
        control.wait_for_foreground.assert_called_once()


if __name__ == "__main__":
    unittest.main()
