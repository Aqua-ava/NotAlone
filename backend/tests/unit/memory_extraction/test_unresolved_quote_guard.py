"""完整作者引句不替代产权或受益人的消歧；SDK给定响应不认证模型质量。"""

from __future__ import annotations

from contextlib import ExitStack
from dataclasses import replace
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_extraction.models import MessageSender
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
from notalone.memory_extraction.verification import validate_source_verification
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3_runtime import response
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result


class UnresolvedQuoteGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_ambiguous_property_cannot_auto_adopt_after_supported_sdk_response(self) -> None:
        source = window("我哥前天把他的雨伞借给我了。")
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            with self.subTest(mode=mode, profile=profile):
                requests: list[dict] = []

                def handler(request: httpx.Request) -> httpx.Response:
                    payload = json.loads(request.content)
                    requests.append(payload)
                    name = payload["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        label = row("0:0", "relationship_event", confidence=0.95)
                        return response({"units": {"0:0": {k: v for k, v in label.items() if k != "unit"}}}, name=name)
                    result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                              "evidence": [{"message_id": str(source.messages[0].message_id),
                                            "quote": source.messages[0].text}]}
                    if mode != "legacy-v4":
                        result["proof"] = None
                    return response({"results": [result]}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model,
                            verification_mode=mode, prompt_profile=profile)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual(len(requests), 2)
                self.assertEqual(fact.text, "联系人原话：“" + source.messages[0].text + "”")
                self.assertEqual((fact.subject.value, fact.category.value, fact.speech_act.value,
                                  fact.assertion_status.value, fact.confidence),
                                 ("contact", "relationship_note", "assertion", "asserted", 0.95))
                self.assertEqual(fact.source_message_ids, (source.messages[0].message_id,))
                self.assertEqual(fact.alternatives,
                                 ("原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。",))
                self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                self.assertEqual(fact.risk_flags, ("semantic:pragmatics",))
                self.assertIsNone(fact.dimension_evidence.semantic_basis)

    def _check(self, text: str, *, sender: MessageSender = MessageSender.CONTACT,
               mode: str = "legacy-v4", candidate: str | None = None,
               verdict: str = "supported", issues: tuple[str, ...] = (),
               extra_message: bool = False):
        source = window(text)
        message = replace(source.messages[0], sender=sender)
        messages = (message,)
        if extra_message:
            messages = (replace(message, message_id=uuid4(), text="另一个话题。"), message)
        source = replace(source, messages=messages)
        author = "用户" if sender is MessageSender.SELF else "联系人"
        payload = _payload(message.message_id,
            text=candidate if candidate is not None else author + "原话：“" + text + "”",
            category="relationship_note", subject=sender.value, confidence=0.95)
        result = verification_result(verdict=verdict, issues=issues,
                                     evidence=((message.message_id, message.text),))
        if mode != "legacy-v4":
            result["proof"] = None
        verifier = FixedSourceVerifier((result,))
        verifier.verification_mode = mode
        outcome = ExtractionFlow(runtime=RecordingRuntime((payload,)),
                                 verification_runtime=verifier).run(source)
        self.assertIsNone(outcome.failure_reason)
        raw = verifier.calls[0][1]
        checked, = validate_source_verification((result,), window=source, facts=raw, mode=mode)
        return outcome, checked, raw[0], result

    def test_parameterized_unknown_owner_and_beneficiary_only_downgrade(self) -> None:
        controls = [
            (sender, f"{relative}{time}把{pronoun}的{item}借给我了。")
            for sender in (MessageSender.SELF, MessageSender.CONTACT)
            for relative, pronoun in (("我姐", "她"), ("我哥", "他"))
            for item in ("车", "书", "雨伞") for time in ("", "昨天", "前天")
        ]
        controls += [(MessageSender.CONTACT, "我姐昨天没有把她的书借给我。"),
                     (MessageSender.SELF, "我哥前天没把他的雨伞借给我。")]
        controls += [(MessageSender.SELF, f"{relative}让我{time}帮{pronoun}顶个班。")
                     for relative, pronoun in (("我姐", "她"), ("我哥", "他"), ("我同事", "他"))
                     for time in ("周末", "明天", "后天")]
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for sender, text in controls:
                with self.subTest(mode=mode, sender=sender, text=text):
                    outcome, checked, raw, original = self._check(text, sender=sender, mode=mode)
                    self.assertEqual((checked.model_verdict.value, checked.model_issues), ("supported", ()))
                    self.assertEqual((checked.verdict.value, tuple(x.value for x in checked.issues)),
                                     ("uncertain", ("pragmatics",)))
                    fact, = outcome.accepted
                    self.assertEqual(replace(fact, risk_flags=raw.risk_flags,
                                             dimension_evidence=raw.dimension_evidence), raw)
                    self.assertEqual(fact.risk_flags, ("semantic:pragmatics",))
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                    self.assertEqual(original["verdict"], "supported")
                    self.assertIsNone(fact.dimension_evidence.semantic_basis)
                    if mode != "legacy-v4":
                        self.assertEqual(checked.proof_verification.status, "UNKNOWN")

    def test_explicit_identity_and_out_of_scope_text_receive_no_positive_credit(self) -> None:
        controls = (
            ("我姐昨天把她的书借给我了。这里的“她”指我姐。", None, False),
            ("我哥前天把我姐的雨伞借给我了。", None, False),
            ("我刚到家。", None, False),
            ("我哥前天把他的雨伞借给我了。", "联系人拿到了雨伞。", False),
            ("我哥前天把他的雨伞借给我了。", "联系人原话：“我哥前天把他的雨伞借给我了。”另外已还清。", False),
            ("我哥前天把他的雨伞借给我了。", "用户原话：“我哥前天把他的雨伞借给我了。”", False),
            ("我哥前天把他的雨伞借给我了。", None, True),
            ("我哥把他的书借给我了。还有另一个人也借给我了。", None, False),
        )
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for text, candidate, extra in controls:
                with self.subTest(mode=mode, text=text, candidate=candidate, extra=extra):
                    outcome, checked, _, _ = self._check(text, mode=mode,
                                                        candidate=candidate, extra_message=extra)
                    self.assertEqual(checked.verdict.value, "supported")
                    self.assertEqual(checked.issues, ())
                    fact, = outcome.accepted
                    self.assertEqual(fact.risk_flags, ())
                    self.assertIsNone(fact.dimension_evidence.semantic_basis)
                    # 未命中新负向范围不等于程序签了supported；原模型判定仅原样传递。
                    if mode != "legacy-v4":
                        self.assertEqual(checked.proof_verification.status, "UNKNOWN")

    def test_original_uncertain_or_unsupported_is_never_upgraded_or_relabelled(self) -> None:
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for verdict in ("uncertain", "unsupported"):
                with self.subTest(mode=mode, verdict=verdict):
                    outcome, checked, _, _ = self._check("我哥前天把他的雨伞借给我了。",
                        mode=mode, verdict=verdict, issues=("subject",))
                    self.assertEqual((checked.verdict.value, checked.model_verdict.value), (verdict, verdict))
                    self.assertEqual(tuple(x.value for x in checked.issues), ("subject",))
                    self.assertEqual(checked.issues, checked.model_issues)
                    if verdict == "unsupported":
                        self.assertEqual(outcome.accepted, ())
                        self.assertEqual(outcome.rejected_count, 1)
                    else:
                        fact, = outcome.accepted
                        self.assertEqual(fact.risk_flags, ("semantic:subject",))
