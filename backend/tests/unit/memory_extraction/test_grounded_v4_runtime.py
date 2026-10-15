"""显式开发v4的真实SDK经精确Mock验收；没有真实供应商或质量认证。"""
from __future__ import annotations

import json
import os
import socket
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


class GroundedV4RuntimeTest(unittest.TestCase):
    def setUp(self):
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_sdk_object_ownership_contract_keeps_confidence_one_supported_candidate_pending(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime
        from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result

        # 给定标签与V=supported只核合同/采纳门，不认证模型会判断车主。
        source = window("我姐把她的车借给我了。")
        scope = ContactScope(source.owner_id, source.contact_id)
        draft = labels(row("0:0", "relationship_event", topic="family", unresolved=True,
                           ambiguity_codes=["object_ownership"], confidence=1.0))
        verifier = FixedSourceVerifier((verification_result(
            evidence=((source.messages[0].message_id, source.messages[0].text),),
        ),))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabelsV4")

        store, traces = InMemoryMemoryStore(), InMemoryTraceStore()
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            stats = run_extraction(
                scope=scope, messages=source.messages, watermark_message_id=None,
                runtime=GroundedV4ExtractionRuntime(model=model), memory_port=store,
                owner_memory_port=None, verification_runtime=verifier, trace_store=traces,
            )

        self.assertEqual(len(requests), 1)
        prompt = requests[0]["messages"][0]["content"]
        for guidance in ("object_ownership=物品所有者未明", "不因出借或接收认定所有者",
                         "不能用place_ownership或other_unresolved替代", "已明确的角色或所有权不额外标未知"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV4")
        slot = tool["parameters"]["properties"]["units"]["properties"]["0:0"]
        codes = slot["properties"]["ambiguity_codes"]
        self.assertEqual(set(codes["items"]["enum"]), {
            "entity_identity", "place_ownership", "borrowing_direction", "other_unresolved",
            "clock_period", "event_stage", "object_ownership",
        })
        self.assertEqual(codes["maxItems"], 7)
        self.assertTrue(codes["uniqueItems"])
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(store.list_confirmed(scope), ())
        pending, = store.list_pending_candidates(scope)
        self.assertEqual(pending.confidence, 1.0)
        self.assertEqual(pending.text, "联系人原话：“我姐把她的车借给我了。”")
        self.assertEqual((pending.valid_at, pending.invalid_at), (None, None))
        self.assertIn("pragmatic:ambiguous", pending.risk_flags)
        self.assertNotIn("semantic:unverified", pending.risk_flags)
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["verification"]["result"]["verdict"], "supported")
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_compile"]["payloads"][0]["speech_act"], "assertion")
        self.assertEqual(events["grounded_compile"]["payloads"][0]["assertion_status"], "asserted")
        self.assertIsNotNone(pending.dimension_evidence)
        assert pending.dimension_evidence is not None
        self.assertIsNone(pending.dimension_evidence.semantic_basis)

    def test_old_plans_reject_v4_before_credentials_budget_audit_or_transport(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort

        def forbidden(*args, **kwargs):
            self.fail("旧计划不接受v4，不能读取凭据、建预算、审核或进入传输。")

        repo = Path(__file__).resolve().parents[4]
        output = repo / ".scratch/v4-unregistered-output-must-not-exist"
        self.assertFalse(output.exists())
        with patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(Path, "home", side_effect=forbidden):
            for profile in ("ecnu", "deepseek-flash-max"):
                for case_set in ("reference21", "full140"):
                    for transport in (None, httpx.MockTransport(forbidden)):
                        with self.subTest(profile=profile, case_set=case_set, mock=transport is not None):
                            with self.assertRaisesRegex(EvaluationBudgetAbort, "evaluation_full140_v4_fixed_plan_required"):
                                run_ecnu_evaluation(
                                    output_directory=output, run_id=uuid4(),
                                    deadline=datetime(2030, 1, 1, tzinfo=timezone.utc), repo_root=repo,
                                    source_hashes={}, frozen_gold={}, credential_loader=forbidden,
                                    audit_case=forbidden, synthetic_transport=transport,
                                    provider_profile=profile, case_set=case_set, extraction_mode="grounded-v4",
                                )
        self.assertFalse(output.exists())

    def test_sdk_unknowns_preserve_quote_and_all_new_kinds_stay_pending(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime

        for text, kind, codes in (
            ("我可能有点感冒。", "uncertain_state", []),
            ("我说收益明天到手。", "figurative_unknown_plan", []),
            ("今天加班到九点。", "stage_unknown_state", ["clock_period", "event_stage"]),
        ):
            with self.subTest(kind=kind):
                source = window(text)
                draft = labels(row("0:0", kind, unresolved=bool(codes), ambiguity_codes=codes, confidence=1.0))
                requests = []

                def handler(request):
                    requests.append(json.loads(request.content))
                    return response(draft, name="GroundedMemoryLabelsV4")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    stats = run_extraction(
                        scope=ContactScope(source.owner_id, source.contact_id), messages=source.messages,
                        watermark_message_id=None, runtime=GroundedV4ExtractionRuntime(model=model),
                        memory_port=InMemoryMemoryStore(), owner_memory_port=None,
                    )
                self.assertEqual(len(requests), 1)
                self.assertEqual(stats.adopted, 0)
                self.assertEqual(stats.pending, 1)

    def test_v4_rejects_legacy_tool_name_and_corrupt_draft_without_repair_call(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError

        source = window("我可能下个月去外地。")
        for name, draft in (
            ("GroundedMemoryLabelsV3", labels(row("0:0", "plan", ambiguity_codes=[]))),
            ("GroundedMemoryLabelsV4", {"units": {}}),
            ("GroundedMemoryLabelsV4", labels(row("0:0", "uncertain_plan", ambiguity_codes=[], text="新正文"))),
            ("GroundedMemoryLabelsV4", labels(row("0:0", "relationship_event", unresolved=True,
                                                  ambiguity_codes=["object_owner"]))),
            ("GroundedMemoryLabelsV4", labels(row("0:0", "relationship_event", unresolved=True,
                                                  ambiguity_codes=["object_ownership", "object_ownership"]))),
            ("GroundedMemoryLabelsV4", labels(row("0:0", "relationship_event", unresolved=False,
                                                  ambiguity_codes=["object_ownership"]))),
            ("GroundedMemoryLabelsV4", labels(row("0:0", "relationship_event", unresolved=True))),
        ):
            with self.subTest(name=name, draft=draft):
                requests = []

                def handler(request):
                    requests.append(request)
                    return response(draft, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    with self.assertRaises(ExtractionInvalidOutputError):
                        GroundedV4ExtractionRuntime(model=model).extract(source)
                self.assertEqual(len(requests), 1)

    def test_sdk_wire_freezes_v4_fields_and_traces_given_labels_without_auto_adoption(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime

        source = window("我可能下个月去外地。")
        scope = ContactScope(source.owner_id, source.contact_id)
        draft = labels(row("0:0", "uncertain_plan", ambiguity_codes=[], confidence=1.0))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabelsV4")

        traces = InMemoryTraceStore()
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            stats = run_extraction(
                scope=scope, messages=source.messages, watermark_message_id=None,
                runtime=GroundedV4ExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                owner_memory_port=None, trace_store=traces,
            )

        self.assertEqual(len(requests), 1)
        prompt = requests[0]["messages"][0]["content"]
        for guidance in ("grounded-v4", "非互斥", "否定发生借贷", "原文明示本人已参与",
                         "uncertain_plan", "clock_period", "event_stage"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV4")
        slot = tool["parameters"]["properties"]["units"]["properties"]["0:0"]
        self.assertEqual(slot["properties"]["ambiguity_codes"]["maxItems"], 7)
        for leaf in ("uncertain_plan", "uncertain_state", "stage_unknown_state", "figurative_unknown_plan"):
            self.assertIn(leaf, slot["properties"]["kind"]["enum"])
        for free_field in ("text", "alternatives", "valid_at", "invalid_at", "assertion_status", "figurative_type"):
            self.assertNotIn(free_field, slot["properties"])
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_draft"]["protocol"], "grounded-v4")
        compiled = events["grounded_compile"]
        self.assertEqual(compiled["protocol"], "grounded-v4")
        self.assertEqual(compiled["payloads"][0]["valid_at"], "2026-11-01T00:00:00+08:00")
        self.assertEqual(compiled["payloads"][0]["invalid_at"], "2026-12-01T00:00:00+08:00")
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)


if __name__ == "__main__":
    unittest.main()
