"""通过纯预算公开接口验证完整请求的计量边界。"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from typing import cast

from notalone.reply.errors import ReplyBudgetError
from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetGuard,
    InputBudgetExceededError,
    InputBudgetProfile,
    InputBudgetRequest,
    InputBudgetUnavailableError,
    InputComponent,
    InputTokenMeasurement,
    TokenMeasurementKind,
)


MODEL_ID = "synthetic-budget-v1"
MEASUREMENT_ID = "synthetic-full-framing-v1"
COMPLETE_COMPONENTS = frozenset({
    InputComponent.SYSTEM,
    InputComponent.MESSAGES,
    InputComponent.TOOLS,
    InputComponent.RESPONSE_SCHEMA,
    InputComponent.MODEL_SETTINGS,
    InputComponent.PROVIDER_FRAMING,
})


def make_request() -> InputBudgetRequest:
    return InputBudgetRequest(
        model_id=MODEL_ID,
        system_message={"role": "system", "content": "合成系统指令与策略目录。"},
        messages=(
            {"role": "user", "content": "合成先前讨论：保留明确要求。"},
            {"role": "assistant", "content": "合成旧候选。"},
            {"role": "user", "content": "合成当前要求和联系人检索依据。"},
        ),
        tool_schemas=({
            "type": "function",
            "function": {
                "name": "synthetic_read_only",
                "parameters": {"type": "object", "properties": {}},
            },
        },),
        response_schema={
            "type": "object",
            "properties": {"result": {"type": "string"}},
        },
        model_settings={"max_tokens": 100, "temperature": 0},
        output_token_limit=100,
    )


def make_profile() -> InputBudgetProfile:
    return InputBudgetProfile(
        model_id=MODEL_ID,
        context_window_tokens=1000,
        output_reserve_tokens=100,
        warning_ratio=0.8,
        measurement_kind=TokenMeasurementKind.EXACT,
        measurement_id=MEASUREMENT_ID,
    )


def make_measurement(input_tokens: int) -> InputTokenMeasurement:
    return InputTokenMeasurement(
        model_id=MODEL_ID,
        input_tokens=input_tokens,
        kind=TokenMeasurementKind.EXACT,
        measurement_id=MEASUREMENT_ID,
        covered_components=COMPLETE_COMPONENTS,
    )


class SyntheticCounter:
    """系统边界夹具；返回已知合成请求的完整 token 计数。"""

    def __init__(self, measurement: object) -> None:
        self.measurement = measurement
        self.seen_requests: list[InputBudgetRequest] = []

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        self.seen_requests.append(request)
        return cast(InputTokenMeasurement, self.measurement)


class InputBudgetTest(unittest.TestCase):
    def test_invalid_configuration_is_rejected_without_a_counter_or_model(self) -> None:
        invalid = [
            {"model_id": ""},
            {"model_id": None},
            {"measurement_id": ""},
            {"measurement_kind": "exact"},
        ]
        invalid.extend(
            {field: value}
            for field in ("context_window_tokens", "output_reserve_tokens")
            for value in (True, False, 0, -1, 1.5, float("nan"), float("inf"), "1000")
        )
        invalid.extend(
            {"warning_ratio": value}
            for value in (True, False, 0, -0.1, 1, float("nan"), float("inf"), "0.8")
        )
        invalid.append({"output_reserve_tokens": 1000})
        for changes in invalid:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    replace(make_profile(), **changes)

    def test_full_request_below_warning_counts_output_reserve(self) -> None:
        request = make_request()
        counter = SyntheticCounter(make_measurement(699))
        guard = InputBudgetGuard(profile=make_profile(), counter=counter)

        decision = guard.assess(request)

        self.assertEqual(decision.state, BudgetState.READY)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.total_tokens, 799)
        self.assertEqual(counter.seen_requests, [request])

    def test_warning_starts_at_configured_total_including_output_reserve(self) -> None:
        guard = InputBudgetGuard(
            profile=make_profile(),
            counter=SyntheticCounter(make_measurement(700)),
        )

        decision = guard.assess(make_request())

        self.assertEqual(decision.state, BudgetState.WARNING)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.total_tokens, 800)

    def test_exact_capacity_fits_but_one_token_over_is_rejected(self) -> None:
        fitting = InputBudgetGuard(
            profile=make_profile(),
            counter=SyntheticCounter(make_measurement(900)),
        )
        exceeding = InputBudgetGuard(
            profile=make_profile(),
            counter=SyntheticCounter(make_measurement(901)),
        )

        self.assertTrue(fitting.assess(make_request()).allowed)
        decision = exceeding.assess(make_request())

        self.assertEqual(decision.state, BudgetState.EXCEEDED)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.total_tokens, 1001)
        with self.assertRaises(ReplyBudgetError):
            exceeding.require(make_request())

    def test_unknown_or_mismatched_capability_blocks_before_counter(self) -> None:
        cases = (
            (replace(make_profile(), context_window_tokens=None), make_request()),
            (replace(make_profile(), output_reserve_tokens=None), make_request()),
            (replace(make_profile(), measurement_kind=None), make_request()),
            (replace(make_profile(), measurement_id=None), make_request()),
            (make_profile(), replace(make_request(), model_id="synthetic-other-model")),
        )
        for profile, request in cases:
            with self.subTest(profile=profile):
                counter = SyntheticCounter(make_measurement(1))
                guard = InputBudgetGuard(profile=profile, counter=counter)

                decision = guard.assess(request)

                self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
                self.assertFalse(decision.allowed)
                self.assertIsNone(decision.input_tokens)
                self.assertIsNone(decision.total_tokens)
                self.assertEqual(counter.seen_requests, [])
                with self.assertRaises(ReplyBudgetError):
                    guard.require(request)

    def test_missing_counter_has_no_implicit_approximation(self) -> None:
        guard = InputBudgetGuard(profile=make_profile(), counter=None)

        decision = guard.assess(make_request())

        self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
        self.assertFalse(decision.allowed)
        with self.assertRaises(ReplyBudgetError):
            guard.require(make_request())

    def test_counter_must_cover_every_final_request_component(self) -> None:
        for missing in COMPLETE_COMPONENTS:
            with self.subTest(missing=missing):
                counter = SyntheticCounter(replace(
                    make_measurement(1),
                    covered_components=COMPLETE_COMPONENTS - {missing},
                ))
                guard = InputBudgetGuard(profile=make_profile(), counter=counter)

                decision = guard.assess(make_request())

                self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
                self.assertFalse(decision.allowed)
                self.assertIsNone(decision.input_tokens)
                self.assertIsNone(decision.total_tokens)
                with self.assertRaises(ReplyBudgetError):
                    guard.require(make_request())

    def test_malformed_or_unverified_measurement_never_allows_a_call(self) -> None:
        invalid = [None, 1]
        invalid.extend(
            replace(make_measurement(1), input_tokens=value)
            for value in (True, False, -1, 1.5, float("nan"), float("inf"), "1")
        )
        invalid.extend((
            replace(make_measurement(1), model_id="synthetic-other-model"),
            replace(make_measurement(1), kind="approximate"),
            replace(make_measurement(1), measurement_id="unverified-counter"),
            replace(make_measurement(1), covered_components=set(COMPLETE_COMPONENTS)),
            replace(make_measurement(1), covered_components=frozenset(
                component.value for component in COMPLETE_COMPONENTS
            )),
        ))
        for measurement in invalid:
            with self.subTest(measurement=measurement):
                guard = InputBudgetGuard(
                    profile=make_profile(),
                    counter=SyntheticCounter(measurement),
                )

                decision = guard.assess(make_request())

                self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
                self.assertIsNone(decision.input_tokens)
                self.assertIsNone(decision.total_tokens)
                with self.assertRaises(ReplyBudgetError):
                    guard.require(make_request())

    def test_actual_output_limit_must_match_configured_reserve(self) -> None:
        limits = (None, True, False, -1, 0, 99, 101, 100.0,
                  float("nan"), float("inf"))
        for limit in limits:
            with self.subTest(limit=limit):
                counter = SyntheticCounter(make_measurement(1))
                guard = InputBudgetGuard(profile=make_profile(), counter=counter)
                request = replace(make_request(), output_token_limit=limit)

                decision = guard.assess(request)

                self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
                self.assertEqual(counter.seen_requests, [])
                with self.assertRaises(ReplyBudgetError):
                    guard.require(request)

    def test_invalid_complete_request_blocks_before_counter(self) -> None:
        invalid = (
            None,
            replace(make_request(), system_message="合成不完整系统输入"),
            replace(make_request(), messages=[]),
            replace(make_request(), messages=("合成不完整消息",)),
            replace(make_request(), tool_schemas=[]),
            replace(make_request(), tool_schemas=("合成不完整工具",)),
            replace(make_request(), response_schema="合成不完整schema"),
            replace(make_request(), model_settings=None),
        )
        for request in invalid:
            with self.subTest(request=request):
                counter = SyntheticCounter(make_measurement(1))
                guard = InputBudgetGuard(profile=make_profile(), counter=counter)

                decision = guard.assess(request)

                self.assertEqual(decision.state, BudgetState.UNAVAILABLE)
                self.assertEqual(counter.seen_requests, [])
                with self.assertRaises(ReplyBudgetError):
                    guard.require(request)

    def test_counter_error_hides_body_and_cause(self) -> None:
        class UnavailableCounter:
            def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
                raise RuntimeError("合成计量失败敏感标记：" + str(request.messages))

        guard = InputBudgetGuard(profile=make_profile(), counter=UnavailableCounter())

        with self.assertNoLogs("notalone.reply.input_budget", level="DEBUG"):
            with self.assertRaises(InputBudgetUnavailableError) as caught:
                guard.require(make_request())

        error = caught.exception
        self.assertEqual(error.decision.state, BudgetState.UNAVAILABLE)
        self.assertNotIn("合成计量失败敏感标记", str(error))
        self.assertNotIn("合成先前讨论", repr(error))
        self.assertIsNone(error.__context__)

    def test_public_metadata_has_only_budget_data(self) -> None:
        request = make_request()
        guard = InputBudgetGuard(
            profile=make_profile(),
            counter=SyntheticCounter(make_measurement(700)),
        )

        payload = guard.require(request).to_payload()

        self.assertEqual(payload, {
            "state": "warning",
            "allowed": True,
            "model_id": MODEL_ID,
            "context_window_tokens": 1000,
            "input_tokens": 700,
            "output_reserve_tokens": 100,
            "total_tokens": 800,
            "measurement_kind": "exact",
            "measurement_id": MEASUREMENT_ID,
            "reason": None,
        })
        self.assertNotIn("合成先前讨论", json.dumps(payload, ensure_ascii=False))
        self.assertNotIn("合成", repr(request))

    def test_tool_round_rechecks_full_messages(self) -> None:
        request = make_request()
        counter = SyntheticCounter(make_measurement(899))
        guard = InputBudgetGuard(profile=make_profile(), counter=counter)
        self.assertTrue(guard.require(request).allowed)
        with_tool = replace(request, messages=request.messages + ({
            "role": "tool",
            "tool_call_id": "synthetic-read-id",
            "content": "合成补入的历史与Skill正文；先前讨论必须完整保留。",
        },))
        counter.measurement = make_measurement(901)

        with self.assertRaises(InputBudgetExceededError) as caught:
            guard.require(with_tool)

        self.assertEqual(caught.exception.decision.total_tokens, 1001)
        self.assertEqual(counter.seen_requests, [request, with_tool])
        self.assertEqual(counter.seen_requests[-1].messages[0]["content"],
                         "合成先前讨论：保留明确要求。")
        self.assertEqual(counter.seen_requests[-1].messages[-1]["content"],
                         "合成补入的历史与Skill正文；先前讨论必须完整保留。")
        self.assertEqual(counter.seen_requests[-1].system_message["content"],
                         "合成系统指令与策略目录。")

    def test_verified_upper_bound_is_labelled_and_bound_to_its_profile(self) -> None:
        profile = replace(
            make_profile(),
            measurement_kind=TokenMeasurementKind.VERIFIED_UPPER_BOUND,
        )
        measurement = replace(
            make_measurement(700),
            kind=TokenMeasurementKind.VERIFIED_UPPER_BOUND,
        )
        guard = InputBudgetGuard(profile=profile, counter=SyntheticCounter(measurement))

        decision = guard.require(make_request())

        self.assertEqual(decision.state, BudgetState.WARNING)
        self.assertEqual(
            decision.to_payload()["measurement_kind"], "verified_upper_bound",
        )
        mismatched = InputBudgetGuard(
            profile=make_profile(), counter=SyntheticCounter(measurement),
        )
        with self.assertRaises(InputBudgetUnavailableError):
            mismatched.require(make_request())


if __name__ == "__main__":
    unittest.main()
