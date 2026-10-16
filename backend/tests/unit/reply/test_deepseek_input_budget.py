"""官方 Flash 复用真实 SDK 的完整请求回归；所有传输均为离线合成响应。"""

from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.reply import test_ecnu_input_budget as ecnu


class DeepSeekInputBudgetTest(ecnu.EcnuInputBudgetTest):
    model_name = "deepseek-flash"
    base_url = "https://api.deepseek.com"
    context_window = 1048576
    long_text_repeats = 70000
    budget_builder = staticmethod(build_deepseek_input_budget)

    def test_default_sdk_and_both_official_routes_use_the_flash_profile(self):
        default = build_deepseek_model(api_key="synthetic-unused-key")
        self.assertEqual(default.model_name, "deepseek-flash")
        for model in (default, self.model()[0], self.model(base_url=self.base_url + "/v1/")[0]):
            with self.subTest(base_url=str(model.root_client.base_url)):
                profile, counter = self.budget_builder(model)
                self.assertEqual(profile.context_window_tokens, 1048576)
                self.assertEqual(profile.measurement_id, "deepseek-flash-chat-json-utf8-framing-estimate-v1")
                self.assertTrue(counter.is_bound_to(model))

    def test_official_capacity_does_not_authorize_other_models_or_similar_domains(self):
        for options in ({"model": "deepseek-v4-pro"}, {"model": "ecnu-max"},
                        {"base_url": self.base_url + ".example.test"},
                        {"base_url": self.base_url + "/beta"}):
            with self.subTest(options=options):
                model, payloads = self.model(**options)
                self.assertIsNone(self.budget_builder(model))
                self.assertEqual(payloads, [])
