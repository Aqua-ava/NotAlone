"""原03固定15窗的封闭登记控制；只用公开合成资料和临时预算。"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from datetime import datetime
import unittest
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_provider_contract import MIXED_PLAN
from notalone.memory_extraction.evaluation_bounded_cases import BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS
from notalone.memory_extraction.evaluation_offline import _frozen_config
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory.bounded_evidence import rule_set_sha256
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests
from tests.unit.memory_extraction.test_evaluation_provider_contract import _payload, _completion


from notalone.memory_extraction.grounded_adapter import BOUNDED_DEPENDENCY_PROMPT_PROFILE, BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE, grounded_v2_prompt

PLAN = "bounded-runtime15-v1"
PROFILE = "deepseek-bounded-task-v1"
ENDPOINT = "https://api.deepseek.com/chat/completions"


def phase_body(phase: str) -> dict:
    body = _payload()
    extraction = phase == "extraction"
    name = "GroundedMemoryLabels" if extraction else "SourceVerificationOutput"
    body.update(model="deepseek-flash", reasoning_effort="max" if extraction else "none",
                thinking={"type": "enabled" if extraction else "disabled"})
    body["tools"][0]["function"]["name"] = name
    if extraction:
        body["messages"][0]["content"] = grounded_v2_prompt(BOUNDED_DEPENDENCY_PROMPT_PROFILE)
        body.pop("tool_choice")
    else:
        body["tool_choice"]["function"]["name"] = name
    return body


class BoundedProviderRegistrationTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def bounded_contract(self, **changes):
        expected_profile = (BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE
            if changes.get("provider_profile") == "deepseek-pro-bounded-thinking-v1" else BOUNDED_DEPENDENCY_PROMPT_PROFILE)
        return self._contract(**{
            "provider_profile": PROFILE, "execution_plan": PLAN,
            "extraction_mode": "grounded-v2", "verification_tool_choice": "forced",
            "extraction_prompt_profile": expected_profile, **changes,
        })

    def test_new_profile_binds_e2_and_exact_phase_requests(self):
        contract = self.bounded_contract()
        for phase in ("extraction", "verification"):
            body = phase_body(phase)
            with self.subTest(phase=phase), contract.expect_request(body):
                contract.check_request(httpx.Request("POST", ENDPOINT, json=body))
                changed = deepcopy(body)
                changed["messages"][0]["content"] += "合成漂移"
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.check_request(httpx.Request("POST", ENDPOINT, json=changed))
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.check_request(httpx.Request("POST", ENDPOINT + "/other", json=body))
        contract.observe_response(httpx.Response(200, json=_completion("deepseek-flash")))
        with self.assertRaises(EvaluationBudgetAbort):
            contract.observe_response(httpx.Response(200, json=_completion("deepseek-v4-flash")))

    def test_pro_thinking_profile_requires_both_max_and_no_tool_choice(self):
        contract = self.bounded_contract(provider_profile="deepseek-pro-bounded-thinking-v1",
                                         verification_tool_choice="omitted")
        for phase in ("extraction", "verification"):
            body = {**phase_body(phase), "model": "deepseek-v4-pro", "max_tokens": 8192,
                    "thinking": {"type": "enabled"}, "reasoning_effort": "max"}
            body.pop("tool_choice", None)
            if phase == "extraction":
                body["messages"][0]["content"] = grounded_v2_prompt(BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE)
            with contract.expect_request(body):
                contract.check_request(httpx.Request("POST", ENDPOINT, json=body))
            for change in ({"thinking": {"type": "disabled"}}, {"reasoning_effort": "none"},
                           {"tool_choice": "auto"}, {"max_tokens": True}, {"max_tokens": 8191}):
                with self.subTest(phase=phase, change=change), self.assertRaises(EvaluationBudgetAbort):
                    with contract.expect_request({**body, **change}):
                        self.fail("双推理合同不接受阶段漂移")
        contract.observe_response(httpx.Response(200, json=_completion("deepseek-v4-pro")))
        for identity in ("deepseek-flash", "deepseek-pro", None):
            with self.subTest(identity=identity), self.assertRaises(EvaluationBudgetAbort):
                contract.observe_response(httpx.Response(200, json=_completion(identity)))
        with self.assertRaises(EvaluationBudgetAbort):
            self.bounded_contract(provider_profile="deepseek-pro-bounded-thinking-v1")

    def test_pro_profile_has_independent_model_identity_and_exact_output_cap(self):
        contract = self.bounded_contract(provider_profile="deepseek-pro-bounded-task-v1")
        for phase in ("extraction", "verification"):
            body = {**phase_body(phase), "model": "deepseek-v4-pro", "max_tokens": 8192}
            with contract.expect_request(body):
                contract.check_request(httpx.Request("POST", ENDPOINT, json=body))
            for change in ({"model": "deepseek-flash"}, {"max_tokens": 8191}, {"max_tokens": True},
                           {"max_completion_tokens": 8192}, {"reasoning_effort": "high"},
                           {"thinking": {"type": "enabled" if phase == "verification" else "disabled"}}):
                with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                    with contract.expect_request({**body, **change}):
                        self.fail("错误模型或输出上限不得绑定")
            del body["max_tokens"]
            with self.assertRaises(EvaluationBudgetAbort), contract.expect_request(body):
                self.fail("缺输出上限不得绑定")
        contract.observe_response(httpx.Response(200, json=_completion("deepseek-v4-pro")))
        for identity in ("deepseek-flash", "deepseek-pro", None):
            with self.subTest(identity=identity), self.assertRaises(EvaluationBudgetAbort):
                contract.observe_response(httpx.Response(200, json=_completion(identity)))
        for changes in ({"execution_plan": "original"}, {"execution_plan": MIXED_PLAN},
                        {"extraction_mode": "grounded-v4"}, {"verification_tool_choice": "omitted"}):
            with self.subTest(changes=changes), self.assertRaises(EvaluationBudgetAbort):
                self.bounded_contract(provider_profile="deepseek-pro-bounded-task-v1", **changes)

    def test_pro_incomplete_finish_stops_even_with_complete_tool_json_but_flash_is_unchanged(self):
        for reason in ("length", "content_filter"):
            body = _completion("deepseek-v4-pro")
            body["choices"][0]["finish_reason"] = reason
            body["choices"][0]["message"]["tool_calls"] = [{"id": "synthetic-call", "type": "function",
                "function": {"name": "SourceVerificationOutput", "arguments": '{"results":[]}'}}]
            with self.subTest(reason=reason), self.assertRaisesRegex(EvaluationBudgetAbort, "pro_completion_incomplete"):
                self.bounded_contract(provider_profile="deepseek-pro-bounded-task-v1").observe_response(httpx.Response(200, json=body))
            body["model"] = "deepseek-flash"
            self.bounded_contract().observe_response(httpx.Response(200, json=body))

    def test_pro_incomplete_response_is_saved_and_budget_closed_before_any_second_request(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationTransport
        for profile, reason in ((profile, reason) for profile in ("deepseek-pro-bounded-task-v1", "deepseek-pro-bounded-thinking-v1")
                                for reason in ("length", "content_filter")):
            thinking = profile == "deepseek-pro-bounded-thinking-v1"
            config, plan, windows = bounded_config(prompt_profile=BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE if thinking else BOUNDED_DEPENDENCY_PROMPT_PROFILE)
            config.update(request_contract_version=5 if thinking else 3, provider_profile=profile,
                          request_model="deepseek-v4-pro", max_tokens=8192)
            if thinking:
                config["tool_choice"]["verification"]["mode"] = "omitted"
            directory = self.root / str(uuid4())
            directory.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=directory, request_limit=30,
                allowed_endpoints=(ENDPOINT,), config_sha256=canonical_sha256(config))
            self.addCleanup(budget.close)
            records = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan, actual_windows=windows)
            contract = self.bounded_contract(provider_profile=profile, verification_tool_choice="omitted" if thinking else "forced")
            response = _completion("deepseek-v4-pro")
            response["choices"][0]["finish_reason"] = reason
            response["choices"][0]["message"]["tool_calls"] = [{"id": "synthetic-call", "type": "function",
                "function": {"name": "SourceVerificationOutput", "arguments": '{"results":[]}'}}]
            sent = []
            def respond(request):
                sent.append(request)
                return httpx.Response(200, json=response)
            body = {**phase_body("verification"), "model": "deepseek-v4-pro", "max_tokens": 8192}
            if thinking:
                body.update(thinking={"type": "enabled"}, reasoning_effort="max")
                body.pop("tool_choice")
            with budget.batch(), records.stage(0, "verification"), contract.expect_request(body), httpx.Client(
                    transport=EvaluationTransport(budget, contract=contract, records=records,
                        synthetic_transport=httpx.MockTransport(respond)), trust_env=False) as client:
                with self.assertRaisesRegex(EvaluationBudgetAbort, "pro_completion_incomplete"):
                    client.post(ENDPOINT, json=body)
                with self.assertRaises(EvaluationBudgetAbort):
                    client.post(ENDPOINT, json=body)
            saved = [event for event in records.events() if event["kind"] == "provider_response"]
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["payload"]["body"]["choices"][0]["finish_reason"], reason)
            self.assertEqual(len(sent), 1)
            self.assertTrue(budget.closed_receipt()["closed"])
            self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)

    def test_thinking_sdk_missing_or_multiple_tools_stop_without_retry(self):
        import asyncio
        import json
        from langchain_deepseek import ChatDeepSeek
        from langchain_core.utils.function_calling import convert_to_openai_tool
        from pydantic import SecretStr
        from notalone.memory_trace.transport import _request_hook, _response_hook
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import (
            LangChainSourceVerificationRuntime, source_verification_contract, _verification_text,
        )
        from tests.unit.memory_extraction.test_bounded_runtime_proof import window_for, compiled_fact

        window = window_for("我已经收好铅笔了。")
        fact = compiled_fact(window)
        prompt, schema = source_verification_contract("nullable-proof-v3")
        messages = [{"role": "system", "content": prompt}, {"role": "user", "content":
            _verification_text(window, (fact,), include_position_guide=True)}]
        expected = {"model": "deepseek-v4-pro", "max_tokens": 8192, "temperature": 0.0,
            "stream": False, "thinking": {"type": "enabled"}, "reasoning_effort": "max",
            "messages": messages, "tools": [convert_to_openai_tool(schema)]}
        for count in (0, 2):
            contract = self.bounded_contract(provider_profile="deepseek-pro-bounded-thinking-v1",
                                             verification_tool_choice="omitted")
            sent = []
            response = _completion("deepseek-v4-pro")
            response["choices"][0]["message"]["tool_calls"] = [
                {"id": f"synthetic-{index}", "type": "function", "function": {
                    "name": "SourceVerificationOutput", "arguments": json.dumps({"results": []})}}
                for index in range(count)]
            def respond(request):
                contract.check_request(request)
                sent.append(json.loads(request.content))
                raw = httpx.Response(200, request=request, json=response)
                contract.observe_response(raw)
                return raw
            async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
            self.addCleanup(lambda client=async_client: asyncio.run(client.aclose()))
            with httpx.Client(transport=httpx.MockTransport(respond), trust_env=False,
                    event_hooks={"request": [_request_hook], "response": [_response_hook]}) as client:
                model = ChatDeepSeek(api_key=SecretStr("synthetic-only"), model="deepseek-v4-pro",
                    base_url="https://api.deepseek.com", temperature=0.0, max_tokens=8192, max_retries=0,
                    extra_body={"thinking": {"type": "enabled"}, "reasoning_effort": "max"},
                    http_client=client, http_async_client=async_client)
                runtime = LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3",
                                                              force_tool_choice=False).for_mode("nullable-proof-v3")
                with self.subTest(count=count), contract.expect_request(expected), self.assertRaises(ExtractionInvalidOutputError):
                    runtime.verify(window=window, facts=(fact,))
            self.assertEqual(len(sent), 1)
            self.assertNotIn("tool_choice", sent[0])

    def test_new_profile_cannot_borrow_old_plan_modes_or_identity_policy(self):
        for change in ({"execution_plan": "original"}, {"execution_plan": MIXED_PLAN},
                       {"provider_profile": "deepseek-flash-max"}, {"provider_profile": "ecnu"},
                       {"extraction_mode": "grounded-v3"}, {"extraction_mode": "grounded-v4"},
                       {"verification_tool_choice": "omitted"},
                       {"response_identity_policy": "ecnu_configured_route_known_labels_v1"},
                       {"extraction_prompt_profile": "reference-uniqueness-v1"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.bounded_contract(**change)
        with self.assertRaises(EvaluationBudgetAbort):
            self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=MIXED_PLAN,
                           extraction_mode="grounded-v2", verification_tool_choice="forced")

    def test_phase_parameters_remain_exact_and_source_drift_stops_preflight(self):
        contract = self.bounded_contract()
        for phase in ("extraction", "verification"):
            for key, value in (("thinking", {"type": "enabled" if phase == "verification" else "disabled"}),
                               ("reasoning_effort", "high"), ("model", "deepseek-chat")):
                body = phase_body(phase)
                body[key] = value
                with self.subTest(phase=phase, key=key), self.assertRaises(EvaluationBudgetAbort):
                    with contract.expect_request(body):
                        self.fail("非法策略不得绑定")
            body = phase_body(phase)
            if phase == "extraction":
                body["tool_choice"] = {"type": "function", "function": {"name": "GroundedMemoryLabels"}}
            else:
                body.pop("tool_choice")
            with self.assertRaises(EvaluationBudgetAbort):
                with contract.expect_request(body):
                    self.fail("错误工具策略不得绑定")
        self.source.write_text("# 合成冻结漂移\n")
        with self.assertRaises(EvaluationBudgetAbort):
            contract.check_preflight()


def bounded_config(*, windows=None, task_ids=None, prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE):
    owner = uuid4()
    generated = tuple(ExtractionWindow(
        owner_id=owner, contact_id=uuid4(),
        messages=tuple(MessageRef(
            message_id=uuid4(), text=message["text"], sender=MessageSender(message["sender"]),
            occurred_at=datetime.fromisoformat(message["occurred_at"]),
            message_type=message["message_type"], text_representation=message["text_representation"],
        ) for message in row["messages"]),
    ) for row in BOUNDED_RUNTIME_INPUTS)
    generated = tuple(replace(window, target_message_ids=tuple(
        window.messages[index].message_id for index in row["target_indices"]
    )) for window, row in zip(generated, BOUNDED_RUNTIME_INPUTS))
    windows = windows if windows is not None else generated
    task_ids = task_ids if task_ids is not None else tuple(uuid4() for _ in windows)
    plan = tuple({"case_position": index, "case_name": case.name,
                  "input_sha256": canonical_sha256(window)}
                 for index, (case, window) in enumerate(zip(BOUNDED_RUNTIME_CASES, windows)))
    rule_hash = rule_set_sha256()
    config = _frozen_config(plan, request_timeout_seconds=300.0, max_retries=0,
        extraction_mode="grounded-v2", verification_mode="nullable-proof-v3", windows=windows,
        extraction_prompt_profile=prompt_profile)
    config.pop("thinking")
    config.update(mode="deepseek_bounded_runtime15", stage="bounded-runtime15", execution_plan=PLAN,
        reference_version=PLAN, request_contract_version=2, base_url="https://api.deepseek.com",
        endpoint=ENDPOINT, request_model="deepseek-flash", fallback=False,
        response_identity_policy="first_valid_completion_observation_stop_on_change",
        selected_case_positions=list(range(15)), runtime_rule_set_sha256=rule_hash, gold_sha256="a" * 64,
        bounded_inputs_sha256=canonical_sha256(tuple({"messages": row["messages"],
            "target_indices": row["target_indices"]} for row in BOUNDED_RUNTIME_INPUTS)),
        formal_tasks=[{"owner_id": str(window.owner_id), "contact_id": str(window.contact_id),
            "task_id": str(task_id), "input_sha256": item["input_sha256"],
            "extraction_runtime_config": {"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": rule_hash}}
            for window, item, task_id in zip(windows, plan, task_ids, strict=True)],
        tool_choice={"extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                     "verification": {"mode": "forced", "name": "SourceVerificationOutput"}})
    return config, plan, windows


class BoundedRecordsRegistrationTest(unittest.TestCase):
    def test_v3_registration_is_exactly_bound_to_thinking_even_after_all_hashes_change(self):
        for thinking, prompt in ((False, BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE),
                                 (True, BOUNDED_DEPENDENCY_PROMPT_PROFILE)):
            config, plan, windows = bounded_config(prompt_profile=prompt)
            config.update(provider_profile="deepseek-pro-bounded-thinking-v1" if thinking else "deepseek-pro-bounded-task-v1",
                          request_contract_version=5 if thinking else 3, request_model="deepseek-v4-pro", max_tokens=8192)
            if thinking:
                config["tool_choice"]["verification"]["mode"] = "omitted"
            with self.subTest(thinking=thinking, prompt=prompt), self.assertRaises(EvaluationBudgetAbort):
                self.register(config, plan, windows)

    def test_current_bounded_registration_requires_dependency_v2(self):
        config, plan, windows = bounded_config()
        self.assertEqual(config["extraction_prompt_profile"], "bounded-dependency-teaching-v2")
        self.assertEqual(self.register(config, plan, windows).extraction_prompt_profile,
                         "bounded-dependency-teaching-v2")
        changed = deepcopy(config)
        changed["extraction_prompt_profile"] = "bounded-stage-teaching-v1"
        with self.assertRaises(EvaluationBudgetAbort):
            self.register(changed, plan, windows)

    def test_stage_profile_cannot_be_omitted_or_rehashed_to_another_prompt(self):
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        config, plan, windows = bounded_config()
        for profile in (None, "default", "bounded-stage-teaching-v1", "reference-uniqueness-v1", "bounded-stage-teaching-v2"):
            changed = deepcopy(config)
            if profile is None:
                changed.pop("extraction_prompt_profile")
            else:
                changed["extraction_prompt_profile"] = profile
            # 同时重算旧提示合同及登记摘要也不能换profile。
            contracts = [extraction_contract("grounded-v2", window) for window in windows]
            changed["extraction_prompt_sha256"] = canonical_sha256(contracts[0][0])
            changed["extraction_window_contracts"] = [{"input_sha256": item["input_sha256"],
                "prompt_sha256": canonical_sha256(prompt), "schema_sha256": canonical_sha256(schema)}
                for item, (prompt, schema) in zip(plan, contracts)]
            with self.subTest(profile=profile), self.assertRaises(EvaluationBudgetAbort):
                self.register(changed, plan, windows)

    setUp = provider_tests.EvaluationProviderContractTest.setUp

    def register(self, config, plan, windows, *, limit=30):
        output = self.root / str(uuid4())
        output.mkdir(mode=0o700)
        budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=limit,
            allowed_endpoints=(ENDPOINT,), config_sha256=canonical_sha256(config))
        try:
            return EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan, actual_windows=windows)
        finally:
            budget.close()

    def test_exact_actual_windows_and_formal_tasks_register_only_new_identity(self):
        config, plan, windows = bounded_config()
        store = self.register(config, plan, windows)
        self.assertEqual(store.execution_plan, PLAN)
        self.assertEqual(store.reference_version, PLAN)
        self.assertEqual(store.extraction_mode, "grounded-v2")
        self.assertEqual(store.gold_sha256, "a" * 64)
        config["gold_sha256"] = "b" * 64
        self.assertEqual(store.gold_sha256, "a" * 64)

    def test_pro_registration_requires_version_profile_model_and_output_cap_together(self):
        original, plan, windows = bounded_config()
        pro = {**original, "request_contract_version": 3,
               "provider_profile": "deepseek-pro-bounded-task-v1", "request_model": "deepseek-v4-pro",
               "max_tokens": 8192}
        self.assertEqual(self.register(pro, plan, windows).execution_plan, PLAN)
        for change in ({"request_contract_version": 2}, {"request_contract_version": True},
                       {"provider_profile": "deepseek-bounded-task-v1"}, {"provider_profile": "anything"},
                       {"request_model": "deepseek-flash"}, {"max_tokens": 8191}, {"max_tokens": True},
                       {"max_completion_tokens": 8192}, {"unknown_profile_field": "x"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.register({**pro, **change}, plan, windows)
        for key in ("provider_profile", "max_tokens"):
            changed = dict(pro)
            del changed[key]
            with self.subTest(missing=key), self.assertRaises(EvaluationBudgetAbort):
                self.register(changed, plan, windows)
        for change in ({"request_model": "deepseek-v4-pro"},
                       {"provider_profile": "deepseek-pro-bounded-task-v1"}, {"max_tokens": 8192}):
            with self.subTest(legacy_change=change), self.assertRaises(EvaluationBudgetAbort):
                self.register({**original, **change}, plan, windows)

    def test_thinking_registration_rejects_rehashed_profile_phase_and_version_mismatch(self):
        original, plan, windows = bounded_config(prompt_profile=BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE)
        config = {**original, "request_contract_version": 5,
                  "provider_profile": "deepseek-pro-bounded-thinking-v1", "request_model": "deepseek-v4-pro",
                  "max_tokens": 8192, "tool_choice": {"extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                    "verification": {"mode": "omitted", "name": "SourceVerificationOutput"}}}
        self.assertEqual(self.register(config, plan, windows).bounded_provider_profile.value,
                         "deepseek-pro-bounded-thinking-v1")
        for change in ({"request_contract_version": 3}, {"request_contract_version": 4},
                       {"provider_profile": "deepseek-pro-bounded-task-v1"},
                       {"tool_choice": original["tool_choice"]}, {"thinking": {"type": "enabled"}},
                       {"reasoning_effort": "max"}, {"max_tokens": True}, {"extra": None}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.register({**config, **change}, plan, windows)
        for key in ("provider_profile", "max_tokens", "request_contract_version"):
            changed = dict(config)
            del changed[key]
            with self.subTest(key=key), self.assertRaises(EvaluationBudgetAbort):
                self.register(changed, plan, windows)
        # 旧Pro不能只省略V工具选择来冒充新身份。
        with self.assertRaises(EvaluationBudgetAbort):
            self.register({**config, "provider_profile": "deepseek-pro-bounded-task-v1",
                           "request_contract_version": 3}, plan, windows)

    def test_fixed_changes_reject_even_after_budget_config_is_rehashed(self):
        original, plan, windows = bounded_config()
        changes = (
            {"execution_plan": "original"}, {"mode": "offline_mock"}, {"stage": "full140"},
            {"reference_version": "legacy-v1"}, {"extraction_mode": "grounded-v4"},
            {"verification_mode": "legacy-v4"}, {"verification_mode": "nullable-proof-v2"},
            {"max_retries": False}, {"max_retries": 1}, {"timeout": 300}, {"timeout": 600.0},
            {"request_contract_version": True}, {"temperature": True}, {"stream": True}, {"fallback": True},
            {"base_url": "https://api.deepseek.com/v1"}, {"endpoint": ENDPOINT + "/other"},
            {"request_model": "deepseek-chat"}, {"thinking": {"type": "enabled"}}, {"reasoning_effort": "max"},
            {"phase_request_version": "deepseek-phase-split-v1"}, {"phase_request_policy": {}},
            {"response_identity_policy": "ecnu_configured_route_known_labels_v1"},
            {"selected_case_positions": list(range(14))}, {"selected_case_positions": [False, *range(1, 15)]},
            {"runtime_rule_set_sha256": "0" * 64}, {"bounded_inputs_sha256": "0" * 64}, {"gold_sha256": "invalid"},
            {"extraction_prompt_sha256": "0" * 64}, {"extraction_schema_sha256": "0" * 64},
            {"verification_prompt_sha256": "0" * 64}, {"verification_schema_sha256": "0" * 64},
            {"extraction_window_contracts": []}, {"tool_choice": {"extraction": "omitted", "verification": "forced"}},
            {"extraction_prompt_profile": "default"}, {"verification_prompt_profile": "default"},
            {"formal_tasks": []},
        )
        for change in changes:
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.register({**deepcopy(original), **change}, plan, windows)
        for limit in (29, 31):
            with self.subTest(limit=limit), self.assertRaises(EvaluationBudgetAbort):
                self.register(original, plan, windows, limit=limit)

    def test_full_actual_window_and_fixed_public_content_are_both_required(self):
        config, plan, windows = bounded_config()
        for actual in (None, windows[:-1], tuple(reversed(windows)),
                       (replace(windows[0], messages=(replace(windows[0].messages[0],
                           message_snapshot={"synthetic": "changed"}),)), *windows[1:])):
            with self.subTest(actual=type(actual)), self.assertRaises(EvaluationBudgetAbort):
                self.register(config, plan, actual)
        changed = (replace(windows[0], messages=(replace(windows[0].messages[0], text="我刚刚到公司。"),)), *windows[1:])
        config, plan, _ = bounded_config(windows=changed)
        with self.assertRaises(EvaluationBudgetAbort):
            self.register(config, plan, changed)
        duplicated = (windows[0], replace(windows[1], contact_id=windows[0].contact_id), *windows[2:])
        config, plan, _ = bounded_config(windows=duplicated)
        with self.assertRaises(EvaluationBudgetAbort):
            self.register(config, plan, duplicated)

    def test_formal_task_identity_and_current_configuration_cannot_be_substituted(self):
        original, plan, windows = bounded_config()
        for change in (
            {"owner_id": str(uuid4())}, {"contact_id": str(uuid4())}, {"task_id": True},
            {"task_id": "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF"},
            {"task_id": original["formal_tasks"][1]["task_id"]}, {"input_sha256": "0" * 64},
            {"extra": None}, {"extraction_runtime_config": {"version": True, "mode": "bounded-runtime-v1", "rule_set_sha256": rule_set_sha256()}},
            {"extraction_runtime_config": {"version": 1, "mode": "legacy", "rule_set_sha256": None}},
            {"extraction_runtime_config": {"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": "0" * 64}},
        ):
            config = deepcopy(original)
            config["formal_tasks"][0].update(change)
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.register(config, plan, windows)
        config = deepcopy(original)
        del config["formal_tasks"][0]["task_id"]
        with self.assertRaises(EvaluationBudgetAbort):
            self.register(config, plan, windows)

    def test_binding_copies_and_formal_event_cannot_change_frozen_task(self):
        config, plan, windows = bounded_config()
        store = self.register(config, plan, windows)
        first = store.formal_task_binding(0)
        original = deepcopy(first)
        first["extraction_runtime_config"]["version"] = 2
        config["formal_tasks"][0]["task_id"] = str(uuid4())
        self.assertEqual(store.formal_task_binding(0), original)
        for position in (False, -1, 15):
            with self.assertRaises(EvaluationBudgetAbort):
                store.formal_task_binding(position)
        task = {key: original[key] for key in ("owner_id", "contact_id", "task_id", "extraction_runtime_config")}
        api = {"path": f"/api/contacts/{original['contact_id']}/memory-candidates",
               "status_code": 200, "body": {"candidates": []}}
        with store.stage(0, "case"):
            store.record(kind="formal_task_execution", payload={"task": task, "worker_results": (), "trace": {}, "memory_api": api})
        self.assertEqual(store.events()[0]["kind"], "formal_task_execution")
        with store.stage(0, "case"), self.assertRaises(EvaluationBudgetAbort):
            store.record(kind="formal_task_execution", payload={"task": {**task, "task_id": str(uuid4())},
                "worker_results": (), "trace": {}, "memory_api": api})

    def test_proof3_fields_and_formal_events_do_not_open_legacy_modes(self):
        plan = ({"case_position": 0, "case_name": "旧合成记录", "input_sha256": "a" * 64},)
        original = {"mode": "offline_mock", "plan_sha256": canonical_sha256(plan)}
        for key in ("formal_tasks", "bounded_inputs_sha256", "runtime_rule_set_sha256"):
            with self.subTest(key=key), self.assertRaises(EvaluationBudgetAbort):
                self.register({**original, key: None}, plan, None)
        with self.assertRaises(EvaluationBudgetAbort):
            self.register({**original, "verification_mode": "nullable-proof-v3"}, plan, None)
        store = self.register(original, plan, None)
        self.assertIsNone(store.gold_sha256)
        with store.stage(0, "case"), self.assertRaises(EvaluationBudgetAbort):
            store.record(kind="formal_task_execution", payload={"task": {}, "worker_results": (), "trace": {}})

    def test_formal_memory_api_and_event_shape_remain_case_scoped(self):
        for change in ("foreign_path", "bool_status", "missing_api", "extra_field", "verification_stage", "bool_config"):
            config, plan, windows = bounded_config()
            store = self.register(config, plan, windows)
            binding = store.formal_task_binding(0)
            payload = {"task": {key: binding[key] for key in (
                "owner_id", "contact_id", "task_id", "extraction_runtime_config")},
                "worker_results": [], "trace": {}, "memory_api": {
                    "path": f"/api/contacts/{binding['contact_id']}/memory-candidates",
                    "status_code": 200, "body": {"candidates": []}}}
            if change == "foreign_path":
                payload["memory_api"]["path"] = f"/api/contacts/{uuid4()}/memory-candidates"
            elif change == "bool_status":
                payload["memory_api"]["status_code"] = True
            elif change == "missing_api":
                del payload["memory_api"]
            elif change == "extra_field":
                payload["passed"] = True
            elif change == "bool_config":
                payload["task"]["extraction_runtime_config"]["version"] = True
            with self.subTest(change=change), store.stage(0, "verification" if change == "verification_stage" else "case"):
                with self.assertRaises(EvaluationBudgetAbort):
                    store.record(kind="formal_task_execution", payload=payload)

    def test_bounded_response_and_failure_keep_observed_status_before_stop(self):
        config, plan, windows = bounded_config()
        store = self.register(config, plan, windows)
        with store.stage(0, "verification"):
            store.capture_response(1, httpx.Response(200, json=_completion("deepseek-flash")))
            store.capture_failure(1, "validation_failure")
        response, failure = store.events()
        self.assertTrue(response["payload"]["response_obtained"])
        self.assertTrue(failure["payload"]["response_obtained"])


if __name__ == "__main__":
    unittest.main()
