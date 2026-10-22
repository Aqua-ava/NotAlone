"""用合成 HTTP 验证来源核验与官方思考模式的请求兼容性。"""

from __future__ import annotations

import hashlib
import json
import unittest
from dataclasses import replace
from uuid import uuid4

import httpx

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.verification_adapters import (
    LangChainSourceVerificationRuntime,
    source_verification_contract,
)
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import verification_result


def _completion(result: dict) -> httpx.Response:
    return httpx.Response(200, json={
        "id": "synthetic-verification", "object": "chat.completion", "created": 1,
        "model": "deepseek-flash", "choices": [{
            "index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "", "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": "SourceVerificationOutput",
                        "arguments": json.dumps({"results": [result]}),
                    },
                }],
            },
        }],
    })


class VerificationHTTPContractTest(unittest.TestCase):
    def test_existing_prompt_and_schema_bytes_stay_frozen(self):
        # 旧合同沿 88871e7c；核心 profile 沿 99bbf798；方向与施受核验规则修订后重签
        # 共享 prompt，三个协议 schema 摘要保持，未改已封存运行。
        contracts = (
            ("legacy-v4", "default", "e36a8b03e714284f217b30c56c0fa09f66bb8cf4bfe705db9e3c102e749b2b8b",
             "ec92479140e3c6945efee42115af25e69686fdfdf851bae2dce994eb393344b2"),
            ("legacy-v4", "public-author-quote-v1", "4e9db1bfdfd61f98a11570509f893db08d49cc409ada3b717d0664210fd0a333",
             "ec92479140e3c6945efee42115af25e69686fdfdf851bae2dce994eb393344b2"),
            ("legacy-v4", "core-source-fidelity-v1", "ae338f0fc0c8a262bc4e431c88adc07de6757272f3e1e16b9bdfe53003e4537f",
             "ec92479140e3c6945efee42115af25e69686fdfdf851bae2dce994eb393344b2"),
            ("nullable-proof-v1", "default", "7de18b81adcb449c9ac4e38b37597df948fb2ed173f700e32c399cba4b6e1ba4",
             "5533c8c33be4047ac20f573f642596d87700309e0ca0e36b93923714981efaed"),
            ("nullable-proof-v2", "default", "b7cf1adf90f42df2398e9329d239c61a084df4047dbe09d7fb4a132fb76d8f90",
             "898d11f5d9410cd5104bbd67d29580f03041076a0e841d7ad2ee28c388a351d8"),
            ("nullable-proof-v3", "default", "2079cac3adf184e18d59dc13f36300d016f54d4062a5d8cf07d2e1dcbf4a88c4",
             "f09fceb25f2b5cfebeb6f8a382a012c28e1e727ea1ae317a9c19cb926a52c897"),
        )
        for mode, profile, prompt_sha, schema_sha in contracts:
            with self.subTest(mode=mode, profile=profile):
                prompt, schema = source_verification_contract(mode, prompt_profile=profile)
                self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), prompt_sha)
                encoded = json.dumps(schema, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                self.assertEqual(hashlib.sha256(encoded.encode()).hexdigest(), schema_sha)

    def test_core_profile_changes_only_system_prompt_through_sdk(self):
        message_id = uuid4()
        window = _window((message_id,))
        source = "我认为园艺很有益，既能放松，也能观察季节。"
        window = replace(window, messages=(replace(window.messages[0], text=source),))
        facts = ExtractionFlow(runtime=RecordingRuntime((_payload(
            message_id, text="联系人原话：“既能放松，也能观察季节。”",
            category="relationship_note",
        ),))).run(window).accepted
        result = verification_result(evidence=((message_id, source),))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return _completion(result)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret", model_name="deepseek-flash",
                base_url="https://api.deepseek.com",
                extra_body={"thinking": {"type": "enabled"}, "reasoning_effort": "max"},
                http_client=client,
            )
            for profile in ("default", "public-author-quote-v1", "core-source-fidelity-v1"):
                runtime = LangChainSourceVerificationRuntime(model=model, prompt_profile=profile)
                output = runtime.for_mode("legacy-v4").verify(window=window, facts=facts)
                self.assertEqual(output, (result,))
                self.assertEqual(requests[-1]["messages"][0]["content"],
                                 source_verification_contract("legacy-v4", prompt_profile=profile)[0])

        self.assertEqual(len(requests), 3)
        prompts = [body["messages"][0]["content"] for body in requests]
        self.assertTrue(prompts[2].startswith(prompts[1]))
        self.assertNotEqual(prompts[2], prompts[1])
        for body in requests:
            body["messages"][0]["content"] = "<仅此处允许变化>"
        self.assertEqual(requests[0], requests[1])
        self.assertEqual(requests[0], requests[2])
        self.assertNotIn("tool_choice", requests[2])
        self.assertEqual(requests[2]["thinking"], {"type": "enabled"})
        self.assertEqual(requests[2]["reasoning_effort"], "max")

    def test_core_profile_rejects_unknown_or_proof_combinations_before_http(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(500)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret", model_name="deepseek-flash",
                base_url="https://api.deepseek.com", http_client=client,
            )
            with self.assertRaises(ValueError):
                LangChainSourceVerificationRuntime(model=model, prompt_profile="core-source-fidelity-v2")
            runtime = LangChainSourceVerificationRuntime(model=model, prompt_profile="core-source-fidelity-v1")
            for mode in ("nullable-proof-v1", "nullable-proof-v2", "nullable-proof-v3"):
                with self.subTest(mode=mode):
                    with self.assertRaises(ValueError):
                        LangChainSourceVerificationRuntime(
                            model=model, verification_mode=mode, prompt_profile="core-source-fidelity-v1",
                        )
                    with self.assertRaises(ValueError):
                        runtime.for_mode(mode)
        self.assertEqual(requests, [])

    def test_core_profile_does_not_repair_verdicts_or_bypass_evidence_checks(self):
        # 外部响应是合成的；本测试只验证接线与原门禁，不认证提示的语义准确率。
        for source, text, category, speech_act in (
            ("我认为园艺有益，既能放松，也能观察季节。", "联系人原话：“既能放松，也能观察季节。”",
             "relationship_note", "assertion"),
            ("我打算改天整理书架。", "联系人原话：“我打算改天整理书架。”", "recent_state", "plan"),
        ):
            for verdict, issues, quote in (
                ("supported", (), source), ("uncertain", ("pragmatics",), source),
                ("unsupported", ("meaning",), source), ("supported", (), "来源没有的保证"),
            ):
                with self.subTest(speech_act=speech_act, verdict=verdict, quote=quote):
                    message_id = uuid4()
                    window = _window((message_id,))
                    window = replace(window, messages=(replace(window.messages[0], text=source),))
                    payload = _payload(message_id, text=text, category=category, speech_act=speech_act)
                    result = verification_result(verdict=verdict, issues=issues, evidence=((message_id, quote),))
                    requests, outcomes = [], []

                    def handler(request):
                        requests.append(json.loads(request.content))
                        return _completion(result)

                    with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                        model = build_deepseek_model(
                            api_key="synthetic-secret", model_name="deepseek-flash",
                            base_url="https://api.deepseek.com", http_client=client,
                        )
                        for profile in ("default", "core-source-fidelity-v1"):
                            outcomes.append(ExtractionFlow(
                                runtime=RecordingRuntime((payload,)),
                                verification_runtime=LangChainSourceVerificationRuntime(
                                    model=model, prompt_profile=profile,
                                ),
                            ).run(window))
                    self.assertEqual(len(requests), 2)
                    self.assertEqual(
                        replace(outcomes[0], accepted=(), candidate_trace_ids=()),
                        replace(outcomes[1], accepted=(), candidate_trace_ids=()),
                    )
                    self.assertEqual(len(outcomes[0].accepted), len(outcomes[1].accepted))
                    for before, after in zip(outcomes[0].accepted, outcomes[1].accepted, strict=True):
                        self.assertEqual(replace(before, dimension_evidence=None),
                                         replace(after, dimension_evidence=None))
                        self.assertEqual(
                            before.dimension_evidence.to_payload() if before.dimension_evidence else None,
                            after.dimension_evidence.to_payload() if after.dimension_evidence else None,
                        )
                    outcome = outcomes[1]
                    if quote != source:
                        self.assertIsNotNone(outcome.failure_reason)
                    elif verdict == "unsupported":
                        self.assertEqual(outcome.accepted, ())
                        self.assertEqual(outcome.rejected_count, 1)
                    else:
                        self.assertEqual(len(outcome.accepted), 1)
                        self.assertEqual(outcome.accepted[0].text, text)
                        self.assertEqual(outcome.accepted[0].confidence, payload["confidence"])
                        if verdict == "uncertain":
                            self.assertIn("semantic:pragmatics", outcome.accepted[0].risk_flags)
                    self.assertEqual(requests[1]["tool_choice"], {
                        "type": "function", "function": {"name": "SourceVerificationOutput"},
                    })

    def test_official_flash_keeps_thinking_and_verifies_with_auto_tool_choice(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        result = verification_result(
            evidence=((message_id, window.messages[0].text),),
        )
        requests = []

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            if body.get("tool_choice", "auto") != "auto":
                return httpx.Response(400, json={"error": {
                    "message": "Thinking mode does not support this tool_choice",
                    "type": "invalid_request_error",
                }})
            return _completion(result)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret", model_name="deepseek-flash",
                base_url="https://api.deepseek.com",
                extra_body={"thinking": {"type": "enabled"}, "reasoning_effort": "max"},
                http_client=client,
            )
            output = LangChainSourceVerificationRuntime(model=model).verify(
                window=window, facts=facts,
            )

        self.assertEqual(output, (result,))
        self.assertEqual(len(requests), 1)
        self.assertNotIn("tool_choice", requests[0])
        self.assertEqual(requests[0]["thinking"], {"type": "enabled"})
        self.assertEqual(requests[0]["reasoning_effort"], "max")
        self.assertEqual(requests[0]["tools"][0]["function"]["name"],
                         "SourceVerificationOutput")

    def test_other_routes_keep_named_verification_tool_choice(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        result = verification_result(
            evidence=((message_id, window.messages[0].text),),
        )
        for model_name, base_url in (
            ("deepseek-flash", "https://proxy.example.test/v1"),
            ("deepseek-chat", "https://api.deepseek.com"),
            ("ecnu-max", "https://chat.ecnu.edu.cn/open/api/v1"),
        ):
            with self.subTest(model_name=model_name, base_url=base_url):
                requests = []

                def handler(request):
                    requests.append(json.loads(request.content))
                    return _completion(result)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(
                        api_key="synthetic-secret", model_name=model_name,
                        base_url=base_url, http_client=client,
                    )
                    output = LangChainSourceVerificationRuntime(model=model).verify(
                        window=window, facts=facts,
                    )

                self.assertEqual(output, (result,))
                self.assertEqual(requests[0]["tool_choice"], {
                    "type": "function", "function": {"name": "SourceVerificationOutput"},
                })

    def test_auto_tool_choice_still_rejects_text_only_and_unfounded_evidence(self):
        message_id = uuid4()
        window = _window((message_id,))
        facts = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
        ).run(window).accepted
        invalid_result = verification_result(evidence=((message_id, "来源里没有这句话"),))
        for mode in ("text_only", "invalid_evidence"):
            with self.subTest(mode=mode):
                requests = []

                def handler(request):
                    requests.append(json.loads(request.content))
                    if mode == "invalid_evidence":
                        return _completion(invalid_result)
                    return httpx.Response(200, json={
                        "id": "synthetic-text", "object": "chat.completion", "created": 1,
                        "model": "deepseek-flash", "choices": [{
                            "index": 0, "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "核验通过"},
                        }],
                    })

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(
                        api_key="synthetic-secret", model_name="deepseek-flash",
                        base_url="https://api.deepseek.com/v1",
                        extra_body={"thinking": {"type": "enabled"}}, http_client=client,
                    )
                    with self.assertRaises(ExtractionInvalidOutputError):
                        LangChainSourceVerificationRuntime(model=model).verify(
                            window=window, facts=facts,
                        )

                self.assertEqual(len(requests), 1)
                self.assertNotIn("tool_choice", requests[0])
                self.assertEqual(requests[0]["thinking"], {"type": "enabled"})
