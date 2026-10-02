"""记忆组件的模型配置边界；构造不连接数据库或调用模型。"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from notalone.memory_extraction.cli_support import build_extraction_components
from notalone.reply.adapters.deepseek_provider import build_deepseek_model


class ExtractionModelConfigurationTest(unittest.TestCase):
    def test_memory_components_enable_thinking_on_configured_model(self) -> None:
        with patch.dict("os.environ", {
            "NOTALONE_DEEPSEEK_API_KEY": "synthetic-key",
            "NOTALONE_DEEPSEEK_MODEL": "synthetic-memory-model",
            "NOTALONE_DEEPSEEK_BASE_URL": "https://model.example.test/v1",
        }, clear=True):
            components = build_extraction_components("postgresql:///synthetic_test")

        self.assertEqual(components.model_name, "synthetic-memory-model")
        self.assertEqual(
            components.model.model_dump()["extra_body"],
            {"thinking": {"type": "enabled"}},
        )
        self.assertEqual(
            components.model.model_dump()["openai_api_base"],
            "https://model.example.test/v1",
        )

    def test_general_model_keeps_existing_default_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            model = build_deepseek_model(api_key="synthetic-key")

        self.assertIsNone(model.model_dump()["extra_body"])


if __name__ == "__main__":
    unittest.main()
