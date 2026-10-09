"""短期时效记忆的提示词与 schema 契约测试。

提示文本无法在离线环境里证明模型行为，因此这里只固定可验证的部分：
提示确实写明"短期信息必须有可推算的失效时间、只有真正长期有效的事实才留空"
的泛化规则与时区口径，且结构化 schema 的描述与提示词不自相矛盾。
真实模型的遵守率必须由另批模型评测验证，本文件不涉及。

两轴审查（2026-10-05）补充：旧表述"只写日期或只写'明天'而没有结束点的日程，
取该日当地时间的当天结束（次日零点）"里的"该日"既可读成 occurred_at 当天，也可读成
日程所指的明天，可能把明天的日程判成当天零点失效。这里固定两条互不重叠的规则：
日程用"该日程所指日期的次日零点"，瞬时状态用"occurred_at 当天结束"。
"""

from __future__ import annotations

import unittest

from notalone.memory_extraction.adapters import (
    EXTRACTION_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
)


def _field_description(field: str) -> str:
    return EXTRACTION_SCHEMA["properties"]["facts"]["items"]["properties"][field][
        "description"
    ]


class ExpiryPromptContractTest(unittest.TestCase):
    """提示词必须给出可泛化的短期失效推算规则。"""

    def test_prompt_requires_invalid_at_for_short_lived_types(self) -> None:
        prompt = EXTRACTION_SYSTEM_PROMPT
        # 必须点名分类枚举中的短期类型与次日安排，不能只靠"有时效"这类泛称。
        self.assertIn("recent_state", prompt)
        self.assertIn("临时状态", prompt)
        self.assertIn("次日", prompt)
        self.assertIn("写明期间的短期安排", prompt)
        self.assertIn("invalid_at", prompt)

    def test_prompt_bounds_transient_state_to_the_same_day(self) -> None:
        prompt = EXTRACTION_SYSTEM_PROMPT
        self.assertIn("瞬时状态", prompt)
        self.assertIn("当天结束", prompt)

    def test_prompt_names_the_schedule_date_instead_of_an_ambiguous_day(self) -> None:
        """日程边界必须点名"该日程所指日期"，不能只写可能被读成 occurred_at 当天的"该日"。"""

        prompt = EXTRACTION_SYSTEM_PROMPT
        self.assertIn("该日程所指日期的次日零点", prompt)
        self.assertNotIn("取该日当地时间的当天结束", prompt)

    def test_prompt_keeps_schedule_and_transient_state_rules_apart(self) -> None:
        """两条规则必须各自点名日期基准，避免同一句话把明天日程判成当天零点失效。"""

        prompt = EXTRACTION_SYSTEM_PROMPT
        self.assertIn("瞬时状态", prompt)
        self.assertIn("occurred_at 当天结束", prompt)
        self.assertNotIn("该日当地时间", prompt)

    def test_prompt_keeps_empty_expiry_only_for_long_lived_facts(self) -> None:
        prompt = EXTRACTION_SYSTEM_PROMPT
        self.assertIn("只有真正长期有效的事实", prompt)
        self.assertIn("才留空", prompt)

    def test_prompt_pins_relative_dates_to_the_source_offset(self) -> None:
        prompt = EXTRACTION_SYSTEM_PROMPT
        self.assertIn("UTC 偏移", prompt)
        self.assertIn("不推算", prompt)
        self.assertIn("当前时间", prompt)

    def test_prompt_rejects_a_fixed_expiry_window_for_every_recent_state(self) -> None:
        prompt = EXTRACTION_SYSTEM_PROMPT
        # 固定天数兜底属于产品决定（本票有意不做），提示词沿用既有拒绝口径。
        self.assertIn("不为所有近况套固定过期天数", prompt)


class ExpirySchemaContractTest(unittest.TestCase):
    """schema 描述也进入模型输入，必须与提示词口径一致。"""

    def test_invalid_at_description_states_the_same_rule(self) -> None:
        description = _field_description("invalid_at")
        self.assertIn("recent_state", description)
        self.assertIn("次日", description)
        self.assertIn("当天结束", description)
        self.assertIn("occurred_at", description)

    def test_invalid_at_description_separates_schedule_from_transient_state(self) -> None:
        """schema 与提示词同口径：日程按所指日期的次日零点，瞬时状态按 occurred_at 当天。"""

        description = _field_description("invalid_at")
        self.assertIn("该日程所指日期的次日零点", description)
        self.assertIn("occurred_at 当天结束", description)
        self.assertNotIn("取该日当地时间的当天结束", description)
        self.assertNotIn("取当天结束", description)

    def test_valid_at_description_covers_short_lived_arrangements(self) -> None:
        description = _field_description("valid_at")
        self.assertIn("短期安排", description)
        self.assertIn("occurred_at", description)

    def test_valid_at_description_pins_transient_state_to_its_evidence(self) -> None:
        """瞬时状态的观察起点只能是证据自身的 occurred_at，不能被日程规则挪到次日。"""

        description = _field_description("valid_at")
        self.assertIn("瞬时状态", description)
        self.assertIn("该状态的证据时间", description)
        self.assertIn("不臆测更早的开始时间", description)

    def test_both_time_fields_stay_nullable_strings(self) -> None:
        properties = EXTRACTION_SCHEMA["properties"]["facts"]["items"]["properties"]
        for field in ("valid_at", "invalid_at"):
            with self.subTest(field=field):
                self.assertEqual(
                    properties[field]["anyOf"],
                    [{"type": "string"}, {"type": "null"}],
                )


if __name__ == "__main__":
    unittest.main()
