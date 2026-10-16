"""用合成 HTTP 验证来源核验与官方思考模式的请求兼容性。"""

from __future__ import annotations

import json
import unittest
from uuid import uuid4

import httpx

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.verification_adapters import (
    LangChainSourceVerificationRuntime,
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
