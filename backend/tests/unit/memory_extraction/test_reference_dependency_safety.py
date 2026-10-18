"""指代依赖的安全分流回归；给定标签不代表真实模型准确率。"""
from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded import compile_labels
from notalone.memory_extraction.models import MessageRef, MessageSender
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


class ReferenceDependencySafetyTest(unittest.TestCase):
    def test_omitted_subject_inherits_unresolved_dependency_before_adoption(self):
        source = window("那个人已经到了。")
        followup = MessageRef(uuid4(), "行李也取好了。", MessageSender.CONTACT,
                              source.messages[0].occurred_at)
        source = replace(source, messages=(*source.messages, followup),
                         target_message_ids=(source.messages[0].message_id, followup.message_id))
        draft = labels(row("0:0", "event", unresolved=True),
                       row("1:0", "event", dependency="0:0"))
        outcome = ExtractionFlow(runtime=RecordingRuntime(compile_labels(source, draft)),
                                 verification_runtime=SyntheticSupportingVerifier()).run(source)
        self.assertIsNone(outcome.failure_reason)
        self.assertEqual(len(outcome.accepted), 2)
        following = outcome.accepted[1]
        self.assertIn("那个人已经到了", following.text)
        self.assertTrue(following.alternatives)
        self.assertFalse(can_auto_adopt(following, PragmaticInterpreter().interpret(following)))

    def test_sixteen_dependency_windows_preserve_unknowns_and_clear_controls(self):
        # 四类语境 × 两个说话人 × 未决标记开／关；每项是独立完整窗口。
        scenarios = (
            ("那个人已经到了。", "行李也取好了。", "event"),
            ("那个事项已经处理了。", "材料也提交了。", "event"),
            ("小林和老陈都在场。", "已经交接钥匙了。", "relationship_event"),
            ("那本书已经收到了。", "已经读完了。", "event"),
        )
        for first, last, kind in scenarios:
            for sender in (MessageSender.SELF, MessageSender.CONTACT):
                for unresolved in (True, False):
                    with self.subTest(first=first, sender=sender, unresolved=unresolved):
                        source = window(first)
                        anchor = replace(source.messages[0], sender=sender)
                        final = MessageRef(uuid4(), last, sender, anchor.occurred_at)
                        source = replace(source, messages=(anchor, final),
                                         target_message_ids=(anchor.message_id, final.message_id))
                        draft = labels(row("0:0", kind, subject=sender.value, unresolved=unresolved),
                                       row("1:0", kind, subject=sender.value, dependency="0:0"))
                        output = compile_labels(source, draft)
                        outcome = ExtractionFlow(runtime=RecordingRuntime(output),
                            verification_runtime=SyntheticSupportingVerifier()).run(source)
                        self.assertIsNone(outcome.failure_reason)
                        following = outcome.accepted[-1]
                        self.assertEqual(following.subject.value, sender.value)
                        self.assertEqual(following.text,
                            ("用户" if sender is MessageSender.SELF else "联系人") + "原话：“" + last
                            + "”（相关原文：" + ("用户" if sender is MessageSender.SELF else "联系人")
                            + "说“" + first + "”）")
                        self.assertEqual(bool(following.alternatives), unresolved)
                        self.assertEqual(can_auto_adopt(following, PragmaticInterpreter().interpret(following)),
                                         not unresolved)
                        self.assertEqual(following.confidence, 0.9)
                        self.assertEqual(following.risk_flags, ())

    def test_transitive_and_same_message_dependencies_do_not_drop_unknowns(self):
        for same_message in (False, True):
            with self.subTest(same_message=same_message):
                source = window("那个事项已经处理了。")
                if same_message:
                    source = window("那个事项已经处理了，材料也提交了，回执已收到。")
                    keys = ("0:0", "0:1", "0:2")
                else:
                    anchor = source.messages[0]
                    messages = (anchor, *(MessageRef(uuid4(), text, anchor.sender, anchor.occurred_at)
                        for text in ("材料也提交了。", "回执已收到。")))
                    source = replace(source, messages=messages,
                        target_message_ids=tuple(message.message_id for message in messages))
                    keys = ("0:0", "1:0", "2:0")
                output = compile_labels(source, labels(
                    row(keys[0], "event", unresolved=True),
                    row(keys[1], "event", dependency=keys[0]),
                    row(keys[2], "event", dependency=keys[1]),
                ))
                self.assertEqual(len(output), 3)
                self.assertTrue(output[-1]["alternatives"])
                self.assertIn("那个事项已经处理了", output[-1]["text"])

    def test_unrelated_unknown_does_not_taint_independent_fact(self):
        source = window("那个事项已经处理了，我已经拿到毕业证。")
        output = compile_labels(source, labels(
            row("0:0", "event", unresolved=True), row("0:1", "event"),
        ))
        self.assertTrue(output[0]["alternatives"])
        self.assertFalse(output[1]["alternatives"])
        self.assertNotIn("那个事项", output[1]["text"])
