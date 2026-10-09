"""来源核验提示对“转述支持”与 fail-closed 行为的契约测试。

提示文本无法在离线环境里证明模型行为，因此这里只固定两件可验证的事：
提示确实写明“完全被原话支持的 report/reported 候选不得仅因转述判 uncertain”，
以及核验返回后产品仍按原规则处理（supported 不加风险、uncertain 加 semantic 风险）。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import (
    ExtractedFact,
    ExtractionWindow,
    MessageRef,
    MessageSender,
)
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
from notalone.memory_extraction.verification_adapters import (
    SOURCE_VERIFICATION_SYSTEM_PROMPT,
)
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.verification_helpers import (
    FixedSourceVerifier,
    SyntheticSupportingVerifier,
    verification_result,
)


def _report_window() -> ExtractionWindow:
    """联系人转述第三方的合成窗口，target 消息直接支持该转述。"""

    owner_id = uuid4()
    contact_id = uuid4()
    message_id = uuid4()
    return ExtractionWindow(
        owner_id=owner_id,
        contact_id=contact_id,
        messages=(MessageRef(
            message_id=message_id,
            text="我妈说她下周三来杭州看我。",
            sender=MessageSender.CONTACT,
            occurred_at=datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc),
        ),),
        target_message_ids=(message_id,),
    )


def _report_payload(window: ExtractionWindow) -> dict:
    """自足的转述候选载荷，不依赖其他测试模块的私有构造器。"""

    return {
        "text": "联系人的母亲打算下周三来杭州。",
        "category": "relationship_note",
        "subject": "contact",
        "topic": "family",
        "source_message_ids": [str(window.messages[0].message_id)],
        "confidence": 0.9,
        "risk_flags": [],
        "valid_at": "2026-10-07T09:00:00+08:00",
        "invalid_at": None,
        "speech_act": "report",
        "assertion_status": "reported",
        "figurative_type": "literal",
        "alternatives": [],
        "interpretation_reason": "联系人明确转述母亲的行程。",
    }


class SourceVerificationPromptContractTest(unittest.TestCase):
    def test_prompt_states_report_is_not_alone_a_reason_for_uncertain(self) -> None:
        """完全被支持的转述候选不得仅因 report/reported 判 uncertain。"""

        prompt = SOURCE_VERIFICATION_SYSTEM_PROMPT
        self.assertIn("不能仅因", prompt)
        self.assertIn("report/reported", prompt)
        self.assertIn("issues=[]", prompt)
        self.assertIn("supported", prompt)
        for phrase in ("直接参与者", "来源支持"):
            self.assertIn(phrase, prompt)

    def test_prompt_keeps_label_loss_as_uncertain(self) -> None:
        """丢失或升级 report/reported 本身仍须判 uncertain/pragmatics。"""

        prompt = SOURCE_VERIFICATION_SYSTEM_PROMPT
        self.assertIn("pragmatics", prompt)
        self.assertIn("仍须", prompt)


class ReportVerdictHandlingTest(unittest.TestCase):
    def test_supported_report_keeps_fact_without_semantic_risk(self) -> None:
        window = _report_window()
        flow = ExtractionFlow(
            runtime=RecordingRuntime((_report_payload(window),)),
            verification_runtime=SyntheticSupportingVerifier(),
        )
        outcome = flow.run(window)
        self.assertEqual(outcome.rejected_count, 0)
        self.assertEqual(len(outcome.accepted), 1)
        fact: ExtractedFact = outcome.accepted[0]
        self.assertEqual(
            tuple(flag for flag in fact.risk_flags if flag.startswith("semantic:")),
            (),
        )
        decision = PragmaticInterpreter().interpret(fact)
        self.assertEqual(decision.disposition.value, "pending")
        self.assertIn("report", decision.reasons)
        self.assertIn("reported", decision.reasons)

    def test_uncertain_verdict_still_adds_semantic_pragmatics(self) -> None:
        window = _report_window()
        verifier = FixedSourceVerifier((
            verification_result(
                verdict="uncertain",
                issues=("pragmatics",),
                evidence=(),
            ),
        ))
        flow = ExtractionFlow(
            runtime=RecordingRuntime((_report_payload(window),)),
            verification_runtime=verifier,
        )
        outcome = flow.run(window)
        self.assertEqual(outcome.rejected_count, 0)
        self.assertEqual(len(outcome.accepted), 1)
        self.assertIn("semantic:pragmatics", outcome.accepted[0].risk_flags)

    def test_unsupported_verdict_still_rejects(self) -> None:
        window = _report_window()
        verifier = FixedSourceVerifier((
            verification_result(verdict="unsupported", issues=("subject",)),
        ))
        flow = ExtractionFlow(
            runtime=RecordingRuntime((_report_payload(window),)),
            verification_runtime=verifier,
        )
        outcome = flow.run(window)
        self.assertEqual(outcome.accepted, ())
        self.assertEqual(outcome.rejected_count, 1)


if __name__ == "__main__":
    unittest.main()
