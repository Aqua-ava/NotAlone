"""DeepSeek 模型构造入口的环境变量与配置校验测试。"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from langchain_deepseek import ChatDeepSeek

from notalone.reply.adapters.deepseek_provider import (
    DEFAULT_DEEPSEEK_MODEL,
    DEFAULT_DEEPSEEK_TIMEOUT_SECONDS,
    build_deepseek_model,
)


class BuildDeepSeekModelTest(unittest.TestCase):
    """只验证构造行为，不发起任何外部模型调用。"""

    def test_builds_model_with_explicit_key(self) -> None:
        model = build_deepseek_model(api_key="test-key")

        self.assertIsInstance(model, ChatDeepSeek)
        self.assertEqual(model.model_name, DEFAULT_DEEPSEEK_MODEL)
        self.assertEqual(model.request_timeout, DEFAULT_DEEPSEEK_TIMEOUT_SECONDS)

    def test_builds_model_with_custom_name_and_timeout(self) -> None:
        model = build_deepseek_model(
            api_key="test-key",
            model_name="deepseek-chat",
            timeout_seconds=12.5,
        )

        self.assertEqual(model.model_name, "deepseek-chat")
        self.assertEqual(model.request_timeout, 12.5)

    def test_reads_key_from_environment(self) -> None:
        with patch.dict(
            "os.environ", {"NOTALONE_DEEPSEEK_API_KEY": "env-key"}
        ):
            model = build_deepseek_model()

        self.assertIsInstance(model, ChatDeepSeek)

    def test_missing_key_raises_actionable_error(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError) as context:
                build_deepseek_model()

        message = str(context.exception)
        self.assertIn("NOTALONE_DEEPSEEK_API_KEY", message)
        self.assertNotIn("env-key", message)

    def test_blank_key_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_deepseek_model(api_key="   ")

    def test_blank_model_name_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_deepseek_model(api_key="test-key", model_name="  ")

    def test_invalid_timeout_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_deepseek_model(api_key="test-key", timeout_seconds=0)

        with self.assertRaises(ValueError):
            build_deepseek_model(api_key="test-key", timeout_seconds=-5)

    def test_explicit_base_url_overrides_default(self) -> None:
        model = build_deepseek_model(
            api_key="test-key", base_url="https://proxy.example.test/v1"
        )

        self.assertEqual(
            model.model_dump()["openai_api_base"], "https://proxy.example.test/v1"
        )

    def test_default_base_url_stays_official(self) -> None:
        model = build_deepseek_model(api_key="test-key")

        self.assertIsNone(model.model_dump()["openai_api_base"])

    def test_base_url_reads_from_environment(self) -> None:
        with patch.dict(
            "os.environ",
            {"NOTALONE_DEEPSEEK_BASE_URL": "https://env-proxy.example.test/v1"},
        ):
            model = build_deepseek_model(api_key="test-key")

        self.assertEqual(
            model.model_dump()["openai_api_base"],
            "https://env-proxy.example.test/v1",
        )

    def test_blank_base_url_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_deepseek_model(api_key="test-key", base_url="  ")


if __name__ == "__main__":
    unittest.main()
