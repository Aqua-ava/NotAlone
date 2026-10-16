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

    def test_sdk_reference_uniqueness_profile_keeps_captured_unlabelled_a05_auto(self):
        import hashlib
        from notalone.memory_extraction.evaluation import build_window, evaluate_case
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime
        from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier

        case = next(case for case in CASES if case.name == "指代：姐借车")
        source = build_window(case)
        # 同值于已封040b场A05原参数；不依赖ignored原件，也不替模型补码。
        draft = labels(row("0:0", "relationship_event", topic="family", confidence=0.95,
                           ambiguity_codes=[]))
        requests, results = [], []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabelsV4")

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            for profile in ("default", "reference-uniqueness-v1"):
                result = evaluate_case(
                    case, source, GroundedV4ExtractionRuntime(model=model, prompt_profile=profile),
                    verification_runtime=SyntheticSupportingVerifier(),
                )
                self.assertEqual(result.actual, "auto")
                self.assertEqual(result.facts[0]["alternatives"], ())
                self.assertEqual(result.facts[0]["confidence"], 0.95)
                results.append(result)

        self.assertEqual(len(requests), 2)
        original = requests[0]["messages"][0]["content"]
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(),
                         "253d66bc5687a8e83f5da31e13cc1f63af07e54d6e61c0800d300dacdddb4ca2")
        guidance = (
            "将第三人代词所称物品的所有权归到某个已知人物前，单独核对来源是否明确支持这条归属关系。"
            "最近出现的先行词、窗口只提及一个候选人、亲属称呼或代词性别本身，不能单独构成归属依据；"
            "出借、接收等已知行动角色也不能替代它。来源未明确该关系时，保留代词原字，并按实际未知选择物品归属及必要的人物指称类别；"
            "不补另一个所有者，也不反向断言不属于该人物。直接明示的所有者或有明确来源关系的指称不额外标未知。"
            "只核所保存主张实际依赖的关系，独立明确的动作、对象、数量、否定和历史性质继续保留。"
            "此处不要求每条消息另有固定 Identity 模板句，也不取消完整相连问答中已有的指称依据。"
        )
        self.assertEqual(requests[1]["messages"][0]["content"], original + "\n" + guidance + "\n")
        self.assertEqual(requests[0]["tools"], requests[1]["tools"])
        self.assertEqual(requests[0]["messages"][1:], requests[1]["messages"][1:])
        self.assertEqual(results[0].facts, results[1].facts)

    def test_reference_uniqueness_profile_rejects_unknown_and_old_runtime_pairings_before_transport(self):
        from notalone.memory_extraction.grounded_adapter import (
            GroundedExtractionRuntime, GroundedV3ExtractionRuntime, GroundedV4ExtractionRuntime,
        )

        requests = []

        def handler(request):
            requests.append(request)
            raise AssertionError("非法profile不应发出请求")

        class ProfileSubclass(str):
            pass

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            for profile in (None, False, 1, "", "unknown", "reference-uniqueness-v2",
                            "reference-uniqueness-v1 ", ProfileSubclass("reference-uniqueness-v1")):
                with self.subTest(profile=profile), self.assertRaises(ValueError):
                    GroundedV4ExtractionRuntime(model=model, prompt_profile=profile)
            for runtime in (GroundedExtractionRuntime, GroundedV3ExtractionRuntime):
                with self.subTest(runtime=runtime.__name__), self.assertRaises(TypeError):
                    runtime(model=model, prompt_profile="reference-uniqueness-v1")
        self.assertEqual(requests, [])

    def test_reference_uniqueness_given_labels_keep_unknown_pending_and_independent_claims_clear(self):
        from notalone.memory_extraction.adoption import can_auto_adopt
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.flow import ExtractionFlow
        from notalone.memory_extraction.grounded_adapter import GroundedV4ExtractionRuntime
        from notalone.memory_extraction.pragmatics import PragmaticInterpreter
        from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier

        by_name = {case.name: case for case in CASES}
        # 所有码及类型均人为给定；只证明提示选择不改编译、不按词补码。
        controls = (
            (build_window(by_name["指代：姐借车"]), labels(row(
                "0:0", "relationship_event", topic="family", confidence=1.0, unresolved=True,
                ambiguity_codes=["object_ownership", "entity_identity"],
            )), False),
            (build_window(by_name["指代：借书看完"]), labels(
                row("0:0", "event", confidence=0.95, ambiguity_codes=[]),
                row("0:1", "greeting", ambiguity_codes=[]),
            ), True),
            (build_window(by_name["指代：跨消息老李"]), labels(row(
                "1:0", "relationship_event", dependency="0:0", confidence=0.95, ambiguity_codes=[],
            )), True),
            (window("这辆车是我自己的。"), labels(row(
                "0:0", "stable_fact", confidence=0.95, ambiguity_codes=[],
            )), True),
        )
        for source, draft, expected_auto in controls:
            with self.subTest(text=source.messages[-1].text):
                facts = []
                for profile in ("default", "reference-uniqueness-v1"):
                    with build_trace_http_client(transport=httpx.MockTransport(
                        lambda _: response(draft, name="GroundedMemoryLabelsV4"),
                    )) as client:
                        model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                     http_client=client)
                        outcome = ExtractionFlow(
                            runtime=GroundedV4ExtractionRuntime(model=model, prompt_profile=profile),
                            verification_runtime=SyntheticSupportingVerifier(),
                        ).run(source)
                    self.assertIsNone(outcome.failure_reason)
                    fact, = outcome.accepted
                    self.assertEqual(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)), expected_auto)
                    self.assertEqual(bool(fact.alternatives), not expected_auto)
                    facts.append(fact)
                self.assertEqual(facts[0], facts[1])

    def test_default_v2_v3_v4_prompts_and_full140_schemas_keep_prechange_bytes(self):
        import hashlib
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
        from notalone.memory_extraction.grounded_adapter import (
            GROUNDED_PROMPT, GROUNDED_V3_PROMPT, GROUNDED_V4_PROMPT,
            grounded_schema, grounded_schema_v3, grounded_schema_v4,
        )

        # 先于本次源码变更取得的摘要；固定默认合同，不代表给定标签的模型质量。
        windows = [build_window(case) for case in (*CASES, *SEMANTIC_CASES)]
        for prompt, schema, prompt_sha, schemas_sha in (
            (GROUNDED_PROMPT, grounded_schema,
             "8580e630bbc4d600b08beb8a607cfcc05dc3efeb7daacc98a9f95bcb6164a01b",
             "c55322ae1480541222fdb03285b29613e47be0089d1692c57d30d36d27c2d10d"),
            (GROUNDED_V3_PROMPT, grounded_schema_v3,
             "3a73e81e83b500d4f4293622f23bfaa681b38d33883e25193ddbccb3225fba91",
             "7a76206ef4316e7489a1cc43308da3495685e87e30fe9ccbaf3891e8e60bbb0a"),
            (GROUNDED_V4_PROMPT, grounded_schema_v4,
             "253d66bc5687a8e83f5da31e13cc1f63af07e54d6e61c0800d300dacdddb4ca2",
             "3dd4a405494abe201396e9cfde6143337c929186657df55fa569e255ff49b524"),
        ):
            with self.subTest(title=schema(windows[0])["title"]):
                self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), prompt_sha)
                self.assertEqual(canonical_sha256([schema(source) for source in windows]), schemas_sha)

    def test_sdk_matter_reference_guidance_keeps_supported_confident_request_pending(self):
        from notalone.memory_extraction.grounded_adapter import (
            GroundedV4ExtractionRuntime, GROUNDED_PROMPT, GROUNDED_V3_PROMPT,
            grounded_schema, grounded_schema_v3,
        )
        from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result

        source = window("那件事情你暂时不要透露。")
        scope = ContactScope(source.owner_id, source.contact_id)
        draft = labels(row("0:0", "request", unresolved=True,
                           ambiguity_codes=["matter_reference"], confidence=1.0))
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
        for guidance in ("matter_reference=原句所指事项在本窗口无法唯一识别", "不补事项内容或类型",
                         "不能用other_unresolved替代", "由模型逐项判断并显式选择",
                         "出借施事、接收者、物品所有者和代词指称分别核对",
                         "施事或接收角色不证明所有权", "不能按代词性别或亲属称呼认定唯一指称",
                         "角色已明确不因此变成未知", "来源已唯一明确的事项或归属不额外标未知"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV4")
        codes = tool["parameters"]["properties"]["units"]["properties"]["0:0"]["properties"]["ambiguity_codes"]
        self.assertIn("matter_reference", codes["items"]["enum"])
        self.assertEqual(codes["maxItems"], 8)
        for schema in (grounded_schema(source), grounded_schema_v3(source)):
            self.assertNotIn("matter_reference", json.dumps(schema))
        for old_prompt in (GROUNDED_PROMPT, GROUNDED_V3_PROMPT):
            self.assertNotIn("matter_reference", old_prompt)
            self.assertNotIn("出借施事、接收者、物品所有者和代词指称分别核对", old_prompt)
        self.assertEqual((stats.adopted, stats.pending), (0, 1))
        self.assertEqual(store.list_confirmed(scope), ())
        pending, = store.list_pending_candidates(scope)
        self.assertEqual(pending.confidence, 1.0)
        self.assertEqual(pending.text, "截至2026-10-14，联系人原话：“那件事情你暂时不要透露。”")
        self.assertIn("pragmatic:ambiguous", pending.risk_flags)
        self.assertIn("事项指称在本窗口无法唯一识别", pending.alternatives[0])
        self.assertIsNotNone(pending.dimension_evidence)
        assert pending.dimension_evidence is not None
        self.assertIsNone(pending.dimension_evidence.semantic_basis)
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["verification"]["result"]["verdict"], "supported")

    def test_sdk_continuation_contract_keeps_supported_full_quote_pending_at_point_five_five(self):
        from notalone.memory_extraction.evaluation import build_window, evaluate_case
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.grounded_adapter import (
            GroundedV4ExtractionRuntime, GROUNDED_PROMPT, GROUNDED_V3_PROMPT,
            grounded_schema, grounded_schema_v3,
        )
        from notalone.memory_extraction.verification import SourceVerificationMode
        from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result

        class NullableVerifier(FixedSourceVerifier):
            verification_mode = SourceVerificationMode.NULLABLE_PROOF_V1

        case = next(case for case in CASES if case.name == "指代：门票")
        source = build_window(case)
        draft = labels(
            row("1:0", "event", dependency="0:0", confidence=0.85, ambiguity_codes=[]),
            row("1:1", "continuation", dependency="1:0", confidence=0.55, ambiguity_codes=[]),
        )
        verifier = NullableVerifier(({**verification_result(
            evidence=tuple((message.message_id, message.text) for message in source.messages),
        ), "proof": None},))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabelsV4")

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            result = evaluate_case(case, source, GroundedV4ExtractionRuntime(model=model),
                                   verification_runtime=verifier)

        self.assertIsNone(result.failure_reason)
        self.assertEqual([(fact["confidence"], fact["destination"]) for fact in result.facts], [(0.55, "pending")])
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(result.facts[0]["text"], "联系人原话：“买好了，两张。”（相关原文：用户说“门票买好了吗？”）")
        self.assertEqual(len(requests), 1)
        prompt = requests[0]["messages"][0]["content"]
        for guidance in ("continuation=已完成普通event的紧邻后置附属数量", "不是独立事件或前置prefix",
                         "中文0至99", "半角阿拉伯整数0至9999", "不允许前导零", "金额、日期、谓词",
                         "不按数字或量词自动选择continuation", "最低confidence"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV4")
        slots = tool["parameters"]["properties"]["units"]["properties"]
        self.assertEqual(set(slots), {"1:0", "1:1"})
        self.assertIn("continuation", slots["1:1"]["properties"]["kind"]["enum"])
        self.assertEqual(set(slots["1:1"]["required"]), {
            "kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity", "ambiguity_codes",
        })
        self.assertFalse(slots["1:1"]["additionalProperties"])
        for schema in (grounded_schema(source), grounded_schema_v3(source)):
            self.assertNotIn("continuation", schema["properties"]["units"]["properties"]["1:1"]["properties"]["kind"]["enum"])
        for old_prompt in (GROUNDED_PROMPT, GROUNDED_V3_PROMPT):
            self.assertNotIn("continuation", old_prompt)

    def test_sdk_stable_fact_uses_v4_guidance_and_closed_schema_without_observation_date(self):
        from notalone.memory_extraction.grounded_adapter import (
            GroundedV4ExtractionRuntime, GROUNDED_PROMPT, GROUNDED_V3_PROMPT,
            grounded_schema, grounded_schema_v3,
        )

        source = window("我在市立图书馆担任管理员。")
        draft = labels(row("0:0", "stable_fact", topic="work", ambiguity_codes=[], confidence=0.97))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabelsV4")

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            fact, = GroundedV4ExtractionRuntime(model=model).extract(source)

        self.assertEqual(len(requests), 1)
        prompt = requests[0]["messages"][0]["content"]
        for guidance in ("stable_fact=原文明示的稳定身份、职业、专业等客观事实", "不是已完成动作",
                         "不能仅因“目前”或“现在”就改用临时state", "知情、决策、近况、短期身体状况",
                         "不认证永久有效、现实身份或来源可信"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV4")
        slot = tool["parameters"]["properties"]["units"]["properties"]["0:0"]
        self.assertIn("stable_fact", slot["properties"]["kind"]["enum"])
        self.assertEqual(set(slot["required"]), {
            "kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity", "ambiguity_codes",
        })
        self.assertFalse(slot["additionalProperties"])
        for schema in (grounded_schema(source), grounded_schema_v3(source)):
            self.assertNotIn("stable_fact", schema["properties"]["units"]["properties"]["0:0"]["properties"]["kind"]["enum"])
        for old_prompt in (GROUNDED_PROMPT, GROUNDED_V3_PROMPT):
            self.assertNotIn("stable_fact", old_prompt)
        self.assertEqual(fact["text"], "联系人原话：“我在市立图书馆担任管理员。”")
        self.assertEqual((fact["category"], fact["valid_at"], fact["invalid_at"]), ("common_fact", None, None))
        self.assertNotIn("semantic_basis", fact)

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
            "clock_period", "event_stage", "object_ownership", "matter_reference",
        })
        self.assertEqual(codes["maxItems"], 8)
        self.assertTrue(codes["uniqueItems"])
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(store.list_confirmed(scope), ())
        pending, = store.list_pending_candidates(scope)
        self.assertEqual(pending.confidence, 1.0)
        self.assertEqual(pending.text, "联系人原话：“我姐把她的车借给我了。”")
        self.assertEqual(pending.interpretation_reason,
                         "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。"
                         " 当前未决说明：所引原句中的物品所有者在本窗口无法唯一确定；"
                         "不因出借或接收认定所有者，保留原句。")
        self.assertEqual((pending.valid_at, pending.invalid_at), (None, None))
        self.assertIn("pragmatic:ambiguous", pending.risk_flags)
        self.assertNotIn("semantic:unverified", pending.risk_flags)
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["verification"]["result"]["verdict"], "supported")
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_compile"]["payloads"][0]["speech_act"], "assertion")
        self.assertEqual(events["grounded_compile"]["payloads"][0]["assertion_status"], "asserted")
        self.assertEqual(events["grounded_compile"]["payloads"][0]["interpretation_reason"],
                         pending.interpretation_reason)
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
        self.assertEqual(slot["properties"]["ambiguity_codes"]["maxItems"], 8)
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
