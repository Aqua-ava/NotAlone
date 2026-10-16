"""官方 DeepSeek 经生产装配、公开 HTTP 与隔离库验证；模型传输只返回合成资料。"""

import json

import httpx

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server import test_ecnu_input_budget as ecnu


class DeepSeekInputBudgetHttpTest(ecnu.EcnuInputBudgetHttpTest):
    model_name = "deepseek-flash"
    base_url = "https://api.deepseek.com"
    context_window = 1048576
    long_draft_repeats = 24000

    @classmethod
    def setUpClass(cls) -> None:
        # 沿用随机建库、正式迁移与清理，不使用业务库或根 .env。
        FidelityHttpFixture.setUpClass.__func__(cls)

    def _respond(self, request):
        # 官方默认思考模式拒绝强制 Tool；按真实合同反馈，避免合成成功掩盖参数错配。
        payload = json.loads(request.content)
        if payload.get("tool_choice") == "required" and payload.get("reasoning_effort") != "none":
            return httpx.Response(400, json={"error": {
                "message": "合成合同：思考模式不支持强制 Tool。",
                "type": "invalid_request_error", "code": "invalid_request_error",
            }})
        return super()._respond(request)
