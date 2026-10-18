"""真实SDK/最终HTTP正文验证有界复核；外部网络仅用MockTransport。"""

import asyncio
import json
import unittest
from dataclasses import replace

import httpx

from notalone.reply.adapters.constraint_review import ReplyConstraintReview
from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.adapters.model_call_ledger import ModelCallLedger
from notalone.reply.errors import ReplyCandidatesRejectedError, ReplyInvariantError, ReplyReviewInvalidError, ReplyTimeoutError
from notalone.reply.input_budget import InputBudgetExceededError
from tests.unit.reply.test_input_budget_runtime import SCOPE, prepared_context, reply_output
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort
from tests.reply_review_support import synthetic_claim, synthetic_review


def sdk_response(request, *, large=False, review_arguments=None, generation_arguments=None):
    payload = json.loads(request.content)
    review = payload["tools"][0]["function"]["name"] == "ReplyFidelityReview"
    if review:
        name = "ReplyFidelityReview"
        arguments = (review_arguments if review_arguments is not None else
                     synthetic_review(json.loads(payload["messages"][-1]["content"])))
    else:
        call = reply_output().tool_calls[0]
        name, arguments = call["name"], call["args"]
        if generation_arguments is not None:
            arguments = generation_arguments
        if large:
            arguments["candidates"][0]["text"] = "合成" * 20000
    return httpx.Response(200, json={
        "id": "synthetic-review", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "", "tool_calls": [
            {"id": "synthetic-review-call", "type": "function", "function": {
                "name": name, "arguments": json.dumps(arguments, ensure_ascii=False),
            }},
        ]}, "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 20 if review else 10, "completion_tokens": 4 if review else 3,
                  "total_tokens": 24 if review else 13},
    })


class ConstraintReviewSdkTest(unittest.TestCase):
    def test_pasted_reply_fixture_uses_confirmed_direction_for_review_source(self):
        from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers
        context = prepared_context()
        incoming, direction = "今晚一起去吗？", "今天不去，简短婉拒。"
        context = replace(context, command=replace(context.command, content=replace(context.command.content,
            draft_text=incoming, input_kind="current_chat", pasted_direction=direction,
            user_instruction=None)), current_text=incoming,
            evidence=(replace(context.evidence[0], kind="user_current_chat", text=incoming, status="user_input"),))
        runtime, requests, _ = self.runtime(sdk_response)
        result = runtime.generate(context)
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(result.candidates), 1)
        payload = json.loads(requests[1]["messages"][-1]["content"])
        self.assertNotIn("draft_text", payload)
        self.assertIsNone(payload["user_instruction"])
        rejected = synthetic_review(payload, verdicts=["reject"])
        violation = rejected["reviews"]["candidate_1"]["checks"]["instruction"]["result"]["violation"]
        self.assertEqual(violation["source_path"], "/confirmed_direction")
        self.assertEqual(violation["source_quote"], direction)
        self.assertEqual(accepted_candidate_numbers(rejected, payload), frozenset())

    def test_captured_review_wire_faults_fail_explicitly_without_retry(self):
        for fault in ("misplaced_propositions", "invalid_json", "wrong_range_id"):
            with self.subTest(fault=fault):
                def respond(request):
                    response = sdk_response(request)
                    payload = response.json()
                    call = payload["choices"][0]["message"]["tool_calls"][0]["function"]
                    if call["name"] == "ReplyFidelityReview":
                        review = json.loads(call["arguments"])
                        # 实际seq2/15多传同级propositions；seq5则返回不完整JSON。
                        if fault == "misplaced_propositions":
                            review["reviews"]["candidate_1"]["propositions"] = []
                        elif fault == "wrong_range_id":
                            review["reviews"]["candidate_1"]["claims"][0]["start_unit_id"] = "c2u1"
                        call["arguments"] = (call["arguments"][:-1] if fault == "invalid_json"
                                             else json.dumps(review))
                    return httpx.Response(200, json=payload)
                ledger = RecordingLedger()
                runtime, requests, decisions = self.runtime(respond, ledger=ledger)
                with self.assertRaises(ReplyReviewInvalidError):
                    runtime.generate(self.context())
                self.assertEqual(len(requests), 2)
                self.assertEqual(len(decisions), 2)
                self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "succeeded"])

    def test_internal_review_payload_stays_hard_before_provider_validation(self):
        from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers
        with self.assertRaises(ReplyInvariantError):
            accepted_candidate_numbers({}, {"candidates": []})
        with self.assertRaises(KeyError):
            accepted_candidate_numbers({}, {"candidates": [{"text": "内部字段缺失。"}]})

    def test_pasted_direction_can_support_first_person_and_review_only_filters_once(self):
        incoming, direction = "大学那会儿的事情，你还记得吗？", "告诉对方我记得这段往事，继续问他的近况。"
        for statement in ("我记得这段往事。", "那段往事我还有印象。"):
            with self.subTest(statement=statement):
                context = prepared_context()
                context = replace(context, command=replace(context.command, content=replace(context.command.content,
                    draft_text=incoming, input_kind="current_chat", pasted_direction=direction,
                    user_instruction=None)), current_text=incoming,
                    evidence=(replace(context.evidence[0], kind="user_current_chat", text=incoming, status="user_input"),))
                generation = reply_output().tool_calls[0]["args"]
                generation["candidates"][0].update(text=statement + "你最近怎么样？", basis="按用户明确方向。")
                reviewed = synthetic_review({"draft_text": direction, "candidates": generation["candidates"]})
                state = synthetic_claim(statement, kind="state", modality="stated", sources=[{
                    "source_path": "/confirmed_direction", "source_quote": "我记得这段往事"}])
                question = synthetic_claim("你最近怎么样？", start=len(statement) + 1)
                question["claim_id"] = 2
                reviewed["reviews"]["candidate_1"]["claims"] = [state, question]
                runtime, requests, decisions = self.runtime(lambda request: sdk_response(request,
                    generation_arguments=generation, review_arguments=reviewed))
                result = runtime.generate(context)
                self.assertEqual(result.candidates[0].text, generation["candidates"][0]["text"])
                self.assertEqual(len(requests), 2)
                self.assertEqual(len(decisions), 2)
                self.assertTrue(all(request["max_tokens"] == 4096 for request in requests))
                self.assertEqual((result.usage.input_tokens, result.usage.output_tokens), (30, 7))
                payload = json.loads(requests[1]["messages"][-1]["content"])
                self.assertEqual(payload["review_sources"]["/confirmed_direction"], {
                    "role": "current_user_input", "time_scope": "current"})

    def test_pasted_contact_text_gets_one_budgeted_review_and_cannot_authorize_user_memory_claim(self):
        incoming = "大学那会儿的事情，你还记得吗？"
        direction = "自然接住回忆，顺着已记录的对方经历继续问；不虚构共同经历。"
        context = prepared_context()
        context = replace(context, command=replace(context.command, content=replace(context.command.content,
            draft_text=incoming, input_kind="current_chat", pasted_direction=direction,
            user_instruction=None, include_relationship_context=True)), current_text=incoming,
            evidence=(replace(context.evidence[0], kind="user_current_chat", text=incoming, status="user_input"),))
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"][0].update(text="记得一些片段。", basis="自然回应来信。")
        reviewed = synthetic_review({"draft_text": direction, "candidates": generation["candidates"]})
        check = reviewed["reviews"]["candidate_1"]["checks"]["facts"]
        check.update(reason="来信提问不证明用户拥有该记忆。", result={"status": "violation", "violation": {
            "category": "unsupported_fact", "candidate_path": "/text", "candidate_quote": "记得一些片段",
            "source_path": "/confirmed_direction", "source_quote": "不虚构共同经历"}})
        runtime, requests, decisions = self.runtime(lambda request: sdk_response(request,
            generation_arguments=generation, review_arguments=reviewed))
        with self.assertRaises(ReplyCandidatesRejectedError):
            runtime.generate(context)
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(decisions), 2)
        payload = json.loads(requests[1]["messages"][-1]["content"])
        self.assertEqual(payload["current_text"], incoming)
        self.assertEqual(payload["confirmed_direction"], direction)
        self.assertNotIn("draft_text", payload)
        self.assertEqual(payload["literal_changes"][0]["status"], "unavailable")
        self.assertEqual(payload["literal_changes"][0]["scope"], "incoming_text_is_not_user_draft")

    def context(self):
        context = prepared_context()
        return replace(context, command=replace(context.command, content=replace(
            context.command.content, user_instruction="保留明确拒绝，不增加下次承诺。")))

    def runtime(self, respond, *, validator=lambda context: None, timeout=20, capacity=None, ledger=None):
        requests, decisions = [], []

        async def observe(request):
            requests.append(json.loads(request.content))
            result = respond(request)
            return await result if asyncio.iscoroutine(result) else result

        client = httpx.AsyncClient(transport=httpx.MockTransport(observe), trust_env=False)
        self.addCleanup(lambda: asyncio.run(client.aclose()))
        model = build_deepseek_model(api_key="synthetic-not-a-key", model_name="deepseek-flash",
                                    base_url="https://api.deepseek.com", http_async_client=client)
        profile, counter = build_deepseek_input_budget(model)
        if capacity:
            profile = replace(profile, context_window_tokens=capacity, safety_margin_tokens=1)
        return LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(SCOPE, 0),
            input_budget_profile=profile, input_token_counter=counter, timeout_seconds=timeout,
            on_input_budget=decisions.append,
            model_callback_factory=(lambda context: ModelCallLedger(scope=context.scope,
                ledger=ledger, model_name="deepseek-flash", validate=lambda: None,
                record_call=lambda identifier: None)) if ledger is not None else None,
            constraint_review=ReplyConstraintReview(validate_current=validator)), requests, decisions

    def test_single_review_is_fully_budgeted_and_usage_includes_both_sdk_calls(self):
        ledger = RecordingLedger()
        routes = []

        def observe_route(request):
            routes.append(str(request.url))
            return sdk_response(request)

        runtime, requests, decisions = self.runtime(observe_route, ledger=ledger)
        result = runtime.generate(self.context())
        self.assertEqual(routes, ["https://api.deepseek.com/chat/completions",
                                  "https://api.deepseek.com/beta/chat/completions"])
        self.assertEqual(len(requests), 2)
        self.assertEqual([item["function"]["name"] for item in requests[1]["tools"]], ["ReplyFidelityReview"])
        self.assertEqual(requests[1]["tool_choice"], {"type": "function", "function": {"name": "ReplyFidelityReview"}})
        self.assertTrue(all(item["max_tokens"] == 4096 for item in requests))
        self.assertEqual(len(decisions), 2)
        self.assertEqual(result.input_budget, decisions[-1])
        self.assertEqual((result.usage.input_tokens, result.usage.output_tokens), (30, 7))
        self.assertEqual([(row.input_tokens, row.output_tokens) for row in ledger.entries], [(10, 3), (20, 4)])

    def test_single_candidate_wire_requires_its_exact_slot_and_places_status_inside_result(self):
        runtime, requests, _ = self.runtime(sdk_response)
        runtime.generate(self.context())
        parameters = requests[1]["tools"][0]["function"]["parameters"]
        self.assertEqual(parameters["properties"]["protocol_version"]["enum"], ["reply-fidelity-units-v3"])
        self.assertIn("protocol_version", parameters["required"])
        reviews = parameters["properties"]["reviews"]
        self.assertEqual(reviews["type"], "object")
        self.assertEqual(set(reviews["required"]), {"candidate_1"})
        self.assertEqual(set(reviews["properties"]), {"candidate_1"})
        slot = reviews["properties"]["candidate_1"]
        self.assertEqual(slot["properties"]["candidate_number"]["enum"], [1])
        claim = slot["properties"]["claims"]["items"]
        self.assertNotIn("text", claim["properties"])
        self.assertEqual(claim["properties"]["start_unit_id"], {"type": "string"})
        self.assertEqual(claim["properties"]["end_unit_id"], {"type": "string"})
        checks = slot["properties"]["checks"]["properties"]
        for name, check in checks.items():
            self.assertEqual(set(check["properties"]),
                             {"reason", "result"})
            branches = check["properties"]["result"]["anyOf"]
            self.assertEqual([branch["properties"]["status"]["enum"] for branch in branches],
                             [["supported"], ["unknown"], ["violation"]])
            self.assertEqual([set(branch["properties"]) for branch in branches],
                             [{"status"}, {"status"}, {"status", "violation"}])

    def assert_dynamic_candidate_slots(self, expected_slots):
        generation = reply_output().tool_calls[0]["args"]
        template = generation["candidates"][0]
        generation["candidates"] = [
            {**template, "text": f"合成候选{number}：今晚不参加，祝活动顺利。"}
            for number in range(1, len(expected_slots) + 1)
        ]
        ledger, routes = RecordingLedger(), []

        def respond(request):
            routes.append(str(request.url))
            return sdk_response(request, generation_arguments=generation)

        runtime, requests, decisions = self.runtime(respond, ledger=ledger)
        result = runtime.generate(self.context())
        self.assertEqual(routes, ["https://api.deepseek.com/chat/completions",
                                  "https://api.deepseek.com/beta/chat/completions"])
        self.assertEqual([candidate.text for candidate in result.candidates],
                         [candidate["text"] for candidate in generation["candidates"]])
        function = requests[1]["tools"][0]["function"]
        self.assertIs(function["strict"], True)
        self.assertEqual(requests[1]["tool_choice"], {"type": "function", "function": {"name": "ReplyFidelityReview"}})
        reviews = function["parameters"]["properties"]["reviews"]
        self.assertEqual(reviews["type"], "object")
        self.assertIs(reviews["additionalProperties"], False)
        self.assertEqual(set(reviews["required"]), set(expected_slots))
        self.assertEqual(set(reviews["properties"]), set(expected_slots))
        for number, slot in enumerate(expected_slots, 1):
            self.assertEqual(reviews["properties"][slot]["properties"]["candidate_number"]["enum"], [number])
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(request["max_tokens"] == 4096 for request in requests))
        self.assertEqual(len(decisions), 2)
        self.assertEqual([(row.input_tokens, row.output_tokens) for row in ledger.entries], [(10, 3), (20, 4)])

    def test_two_candidates_wire_requires_only_the_two_bound_slots(self):
        self.assert_dynamic_candidate_slots(["candidate_1", "candidate_2"])

    def test_three_candidates_wire_requires_all_three_bound_slots(self):
        self.assert_dynamic_candidate_slots(["candidate_1", "candidate_2", "candidate_3"])

    def test_five_explicit_checks_deliver_the_original_candidate_without_a_global_verdict(self):
        arguments = {"protocol_version": "reply-fidelity-units-v3", "instruction_requires_expansion": False, "reviews": {"candidate_1": {
            "candidate_number": 1, "expression_change": "not_applicable", "checks": {
                "intent": {"result": {"status": "supported"}, "reason": "保留今晚不参加的立场。"},
                "instruction": {"result": {"status": "supported"}, "reason": "保留拒绝，未增加下次安排。"},
                "facts": {"result": {"status": "supported"}, "reason": "没有新增经历或现状。"},
                "commitments": {"result": {"status": "supported"}, "reason": "没有新增履约安排。"},
                "explanation": {"result": {"status": "supported"}, "reason": "说明与正文中的拒绝一致。"},
            },
        }}}
        arguments["reviews"]["candidate_1"]["claims"] = [synthetic_claim(reply_output().tool_calls[0]["args"]["candidates"][0]["text"])]
        runtime, requests, _ = self.runtime(lambda request: sdk_response(request, review_arguments=arguments))
        result = runtime.generate(self.context())
        self.assertEqual([item.text for item in result.candidates], ["合成候选：今晚不参加，祝活动顺利。"])
        self.assertEqual(len(requests), 2)
        row_schema = requests[1]["tools"][0]["function"]["parameters"]["properties"]["reviews"]["properties"]["candidate_1"]
        self.assertNotIn("verdict", row_schema["properties"])
        self.assertEqual(set(row_schema["properties"]["checks"]["required"]),
                         {"intent", "instruction", "facts", "commitments", "explanation"})

    def test_review_wire_preserves_canonical_messages_and_all_codepoints(self):
        messages = ["谢谢🙂e\u0301，", "  回头聊。", "晚安。"]
        text = "\n\n".join(messages)
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"][0].update(text=text, messages=messages)
        runtime, requests, decisions = self.runtime(lambda request: sdk_response(request,
            generation_arguments=generation))
        result = runtime.generate(self.context())
        candidate = json.loads(requests[1]["messages"][-1]["content"])["candidates"][0]
        self.assertEqual((candidate["text"], candidate["messages"]), (text, messages))
        self.assertEqual(candidate["review_target"]["units"],
                         [[f"c1u{number}", char] for number, char in enumerate(text, 1)])
        self.assertEqual(result.candidates[0].text, text)
        self.assertEqual(list(result.candidates[0].messages), messages)
        self.assertEqual((len(requests), len(decisions)), (2, 2))

    def test_strict_wire_uses_exclusive_checks_without_unsupported_length_keywords(self):
        runtime, requests, _ = self.runtime(sdk_response)
        runtime.generate(self.context())
        function = requests[1]["tools"][0]["function"]
        self.assertIs(function["strict"], True)

        def validate_schema(schema):
            if isinstance(schema, dict):
                self.assertFalse(set(schema) & {"minLength", "maxLength", "minItems", "maxItems"})
                if schema.get("type") == "object":
                    self.assertIs(schema["additionalProperties"], False)
                    self.assertEqual(set(schema["required"]), set(schema["properties"]))
                for value in schema.values():
                    validate_schema(value)
            elif isinstance(schema, list):
                for value in schema:
                    validate_schema(value)

        validate_schema(function["parameters"])
        checks = function["parameters"]["properties"]["reviews"]["properties"]["candidate_1"]["properties"]["checks"]
        for name, schema in checks["properties"].items():
            self.assertEqual(set(schema["properties"]),
                             {"reason", "result"})
            branches = schema["properties"]["result"]["anyOf"]
            self.assertEqual(len(branches), 3)
            self.assertEqual([branch["properties"]["status"]["enum"] for branch in branches],
                             [["supported"], ["unknown"], ["violation"]])
            for branch in branches:
                fields = {"status"}
                if branch["properties"]["status"]["enum"] == ["violation"]:
                    fields.add("violation")
                    self.assertEqual(branch["properties"]["violation"]["type"], "object")
                self.assertEqual(set(branch["properties"]), fields)

    def test_source_revalidation_failure_never_sends_the_second_request(self):
        def unavailable(context):
            raise ReplyInvariantError("合成来源已失效。")
        runtime, requests, _ = self.runtime(sdk_response, validator=unavailable)
        with self.assertRaises(ReplyInvariantError):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 1)

    def test_valid_all_rejected_review_is_a_candidate_outcome_not_a_model_failure(self):
        def reject(request):
            response = sdk_response(request)
            payload = response.json()
            call = payload["choices"][0]["message"]["tool_calls"][0]["function"]
            if call["name"] == "ReplyFidelityReview":
                review = json.loads(call["arguments"])
                check = review["reviews"]["candidate_1"]["checks"]["instruction"]
                check["reason"] = "本次要求未满足。"
                check["result"].update(status="violation", violation={
                    "category": "unmet_instruction", "candidate_path": "/text",
                    "candidate_quote": "今晚不参加", "source_path": "/user_instruction",
                    "source_quote": "保留明确拒绝",
                })
                call["arguments"] = json.dumps(review, ensure_ascii=False)
            return httpx.Response(200, json=payload)

        ledger = RecordingLedger()
        runtime, requests, _ = self.runtime(reject, ledger=ledger)
        with self.assertRaises(ReplyCandidatesRejectedError):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 2)
        self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "succeeded"])

    def test_unknown_in_any_required_check_never_delivers_or_regenerates(self):
        for name in ("intent", "instruction", "facts", "commitments", "explanation"):
            with self.subTest(check=name):
                def respond(request):
                    payload = json.loads(request.content)
                    arguments = None
                    if payload["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                        arguments = synthetic_review(json.loads(payload["messages"][-1]["content"]))
                        arguments["reviews"]["candidate_1"]["checks"][name]["result"]["status"] = "unknown"
                    return sdk_response(request, review_arguments=arguments)
                runtime, requests, _ = self.runtime(respond)
                with self.assertRaises(ReplyCandidatesRejectedError):
                    runtime.generate(self.context())
                self.assertEqual(len(requests), 2)

    def test_safe_invitation_survives_while_false_explanation_and_new_action_are_filtered(self):
        generation = reply_output().tool_calls[0]["args"]
        citation_ids = generation["candidates"][0]["citation_ids"]
        generation["candidates"] = [
            {"text": "最近怎么样？想聊聊的话，我今晚有空——不用急着回，看你的时间。",
             "basis": "保留今晚有空的可选邀请。", "risk_notes": [], "citation_ids": citation_ids},
            {"text": "最近怎么样？想聊聊的话，我今晚有空。", "basis": "删去了今晚这个时间限制。",
             "risk_notes": [], "citation_ids": citation_ids},
            {"text": "最近怎么样？想聊聊的话，我今晚有空，我开车接你。", "basis": "合成接送承诺。",
             "risk_notes": [], "citation_ids": citation_ids},
        ]

        def respond(request):
            payload = json.loads(request.content)
            arguments = None
            if payload["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                original = json.loads(payload["messages"][-1]["content"])
                arguments = synthetic_review(original)
                explanation = arguments["reviews"]["candidate_2"]["checks"]["explanation"]
                explanation["reason"] = "正文仍含今晚，所称删除没有发生。"
                explanation["result"].update(
                    status="violation", violation={
                        "category": "inaccurate_explanation", "candidate_path": "/basis",
                        "candidate_quote": "删去了今晚这个时间限制", "source_path": "/draft_text",
                        "source_quote": "我今晚有空",
                    })
                commitments = arguments["reviews"]["candidate_3"]["checks"]["commitments"]
                commitments["reason"] = "原句没有开车接送安排。"
                commitments["result"].update(
                    status="violation", violation={
                        "category": "added_obligation", "candidate_path": "/text",
                        "candidate_quote": "我开车接你", "source_path": "/draft_text",
                        "source_quote": "想聊聊的话我今晚有空",
                    })
            return sdk_response(request, review_arguments=arguments, generation_arguments=generation)

        context = self.context()
        draft = "最近怎么样？想聊聊的话我今晚有空。"
        context = replace(context, command=replace(context.command, content=replace(context.command.content,
            draft_text=draft, user_instruction="保留今晚有空的支持，不扩大为以后随时有空。")),
            current_text=draft, evidence=(replace(context.evidence[0], text=draft),))
        runtime, requests, _ = self.runtime(respond)
        result = runtime.generate(context)
        self.assertEqual([(item.text, item.basis, item.messages) for item in result.candidates], [(
            "最近怎么样？想聊聊的话，我今晚有空——不用急着回，看你的时间。", "保留今晚有空的可选邀请。", (),
        )])
        self.assertEqual(len(requests), 2)

    def test_invalid_locations_and_inconsistent_checks_fail_closed(self):
        for fault in ("missing", "extra_verdict", "supported_with_violation", "unknown_with_violation",
                      "supported_with_null_violation", "unknown_with_null_violation", "legacy_empty_array",
                      "legacy_violation_array", "null_violation", "violation_array", "missing_violation",
                      "violation_without_quote", "extra_violation_field", "legacy_claim_ids",
                      "non_shared_claim_ids", "legacy_flat_check", "legacy_flat_commitments",
                      "reason_in_result", "propositions_in_result", "duplicate_outer_status",
                      "fabricated_candidate", "fabricated_source", "candidate_as_source", "wrong_field",
                      "missing_proposition", "unrelated_proposition", "unhashable_status"):
            with self.subTest(fault=fault):
                def respond(request):
                    payload = json.loads(request.content)
                    if payload["tools"][0]["function"]["name"] != "ReplyFidelityReview":
                        return sdk_response(request)
                    arguments = synthetic_review(json.loads(payload["messages"][-1]["content"]))
                    row = arguments["reviews"]["candidate_1"]
                    violation = {"category": "unmet_instruction", "candidate_path": "/text",
                                 "candidate_quote": "今晚不参加", "source_path": "/draft_text",
                                 "source_quote": "今晚不参加"}
                    if fault == "missing":
                        del row["checks"]["facts"]
                    elif fault == "extra_verdict":
                        row["verdict"] = "supported"
                    elif fault == "unhashable_status":
                        row["checks"]["facts"]["result"]["status"] = []
                    elif fault == "legacy_flat_check":
                        row["checks"]["facts"] = {"reason": "旧协议不得继续交付。", "status": "supported"}
                    elif fault == "legacy_flat_commitments":
                        row["checks"]["commitments"] = {
                            "reason": "旧协议不得继续交付。", "status": "supported", "propositions": [],
                        }
                    elif fault == "reason_in_result":
                        row["checks"]["facts"]["result"]["reason"] = "理由只能位于检查对象。"
                    elif fault == "propositions_in_result":
                        row["checks"]["commitments"]["result"]["propositions"] = []
                    elif fault == "duplicate_outer_status":
                        row["checks"]["facts"]["status"] = "supported"
                    else:
                        check = row["checks"]["instruction"]["result"]
                        check.update(status="violation", violation=violation)
                        if fault in {"supported_with_violation", "unknown_with_violation"}:
                            check["status"] = fault.split("_", 1)[0]
                        elif fault in {"supported_with_null_violation", "unknown_with_null_violation"}:
                            check.update(status=fault.split("_", 1)[0], violation=None)
                        elif fault == "legacy_empty_array":
                            check.pop("violation")
                            check.update(status="supported", violations=[])
                        elif fault == "legacy_violation_array":
                            check["violations"] = [check.pop("violation")]
                        elif fault == "null_violation":
                            check["violation"] = None
                        elif fault == "violation_array":
                            check["violation"] = [violation]
                        elif fault == "missing_violation":
                            check.pop("violation")
                        elif fault == "violation_without_quote":
                            violation.pop("candidate_quote")
                        elif fault == "extra_violation_field":
                            violation["reason"] = "合成额外字段。"
                        elif fault == "legacy_claim_ids":
                            row["checks"]["commitments"]["claim_ids"] = [1]
                        elif fault == "non_shared_claim_ids":
                            row["checks"]["instruction"]["claim_ids"] = []
                        elif fault == "fabricated_candidate":
                            violation["candidate_quote"] = "明天我来接你"
                        elif fault == "fabricated_source":
                            violation["source_quote"] = "明天我来接你"
                        elif fault == "candidate_as_source":
                            violation["source_path"] = "/candidates/0/text"
                        elif fault == "wrong_field":
                            violation.update(candidate_path="/basis", candidate_quote="保持用户原句立场")
                        elif fault in {"missing_proposition", "unrelated_proposition"}:
                            check["status"] = "supported"
                            check.pop("violation")
                            violation["category"] = "added_obligation"
                            row["checks"]["commitments"]["result"].update(status="violation", violation=violation)
                            if fault == "unrelated_proposition":
                                row["claims"][0]["end_unit_id"] = "c1u2"
                            else:
                                row["claims"] = []
                    return sdk_response(request, review_arguments=arguments)
                ledger = RecordingLedger()
                runtime, requests, _ = self.runtime(respond, ledger=ledger)
                with self.assertRaises(ReplyReviewInvalidError):
                    runtime.generate(self.context())
                self.assertEqual(len(requests), 2)
                self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "succeeded"])

    def test_local_text_limits_remain_enforced_after_wire_length_limits_are_removed(self):
        context = self.context()
        text = "合" * 600
        context = replace(context, command=replace(context.command, content=replace(
            context.command.content, draft_text=text)), current_text=text,
            evidence=(replace(context.evidence[0], text=text),))
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"][0]["text"] = text
        for field, limit in (("reason", 256), ("candidate_quote", 512), ("source_quote", 512)):
            for length in (limit, limit + 1):
                with self.subTest(field=field, length=length):
                    def respond(request):
                        body = json.loads(request.content)
                        arguments = None
                        if body["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                            arguments = synthetic_review(json.loads(body["messages"][-1]["content"]))
                            checks = arguments["reviews"]["candidate_1"]["checks"]
                            if field == "reason":
                                checks["facts"]["reason"] = "合" * length
                            else:
                                violation = {"category": "unsupported_fact", "candidate_path": "/text",
                                             "candidate_quote": "合", "source_path": "/draft_text",
                                             "source_quote": "合"}
                                violation[field] = "合" * length
                                checks["facts"]["result"].update(status="violation", violation=violation)
                        return sdk_response(request, generation_arguments=generation, review_arguments=arguments)

                    runtime, requests, _ = self.runtime(respond)
                    if length > limit:
                        with self.assertRaises(ReplyReviewInvalidError):
                            runtime.generate(context)
                    elif field == "reason":
                        self.assertEqual([item.text for item in runtime.generate(context).candidates], [text])
                    else:
                        with self.assertRaises(ReplyCandidatesRejectedError):
                            runtime.generate(context)
                    self.assertEqual(len(requests), 2)

    def test_local_review_counts_identities_and_proposition_limit_remain_fail_closed(self):
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"] = [dict(generation["candidates"][0]) for _ in range(3)]
        for fault in ("empty_reviews", "four_reviews", "missing_review", "duplicate_number",
                      "out_of_range_number", "boolean_number", "non_object_reviews", "wrong_slot_binding",
                      "thirteen_claims"):
            with self.subTest(fault=fault):
                def respond(request):
                    body = json.loads(request.content)
                    arguments = None
                    if body["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                        arguments = synthetic_review(json.loads(body["messages"][-1]["content"]))
                        rows = arguments["reviews"]
                        if fault == "empty_reviews":
                            rows.clear()
                        elif fault == "four_reviews":
                            rows["candidate_4"] = {**rows["candidate_1"], "candidate_number": 4}
                        elif fault == "missing_review":
                            rows.pop("candidate_3")
                        elif fault == "duplicate_number":
                            rows["candidate_2"]["candidate_number"] = 1
                        elif fault == "out_of_range_number":
                            rows["candidate_1"]["candidate_number"] = 4
                        elif fault == "boolean_number":
                            rows["candidate_1"]["candidate_number"] = True
                        elif fault == "non_object_reviews":
                            arguments["reviews"] = list(rows.values())
                        elif fault == "wrong_slot_binding":
                            rows["candidate_1"], rows["candidate_2"] = rows["candidate_2"], rows["candidate_1"]
                        else:
                            rows["candidate_1"]["claims"] *= 13
                    return sdk_response(request, generation_arguments=generation, review_arguments=arguments)

                runtime, requests, _ = self.runtime(respond)
                with self.assertRaises(ReplyReviewInvalidError):
                    runtime.generate(self.context())
                self.assertEqual(len(requests), 2)

    def test_each_candidate_count_rejects_missing_extra_and_misbound_slots(self):
        for count in (1, 2, 3):
            for fault in ("missing_slot", "extra_slot", "misbound_number", "unexpected_slot_name"):
                with self.subTest(candidate_count=count, fault=fault):
                    generation = reply_output().tool_calls[0]["args"]
                    generation["candidates"] = [dict(generation["candidates"][0]) for _ in range(count)]

                    def respond(request):
                        body = json.loads(request.content)
                        arguments = None
                        if body["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                            arguments = synthetic_review(json.loads(body["messages"][-1]["content"]))
                            rows = arguments["reviews"]
                            if fault == "missing_slot":
                                rows.pop(f"candidate_{count}")
                            elif fault == "extra_slot":
                                rows[f"candidate_{count + 1}"] = {**rows["candidate_1"], "candidate_number": count + 1}
                            elif fault == "misbound_number":
                                rows["candidate_1"]["candidate_number"] = 2
                            else:
                                rows["candidate_01"] = rows.pop("candidate_1")
                        return sdk_response(request, generation_arguments=generation, review_arguments=arguments)

                    ledger = RecordingLedger()
                    runtime, requests, decisions = self.runtime(respond, ledger=ledger)
                    with self.assertRaises(ReplyReviewInvalidError):
                        runtime.generate(self.context())
                    self.assertEqual(len(requests), 2)
                    self.assertEqual(len(decisions), 2)
                    self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "succeeded"])

    def test_compound_commitment_violation_can_reference_separate_action_propositions(self):
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"][0].update(
            text="最近怎么样？想聊的话我今晚可以开车接你，再帮你把事情处理好。",
            basis="提供今晚的支持。")

        def respond(request):
            body = json.loads(request.content)
            arguments = None
            if body["tools"][0]["function"]["name"] == "ReplyFidelityReview":
                arguments = synthetic_review(json.loads(body["messages"][-1]["content"]))
                commitments = arguments["reviews"]["candidate_1"]["checks"]["commitments"]
                commitments["reason"] = "原句没有接送或办事投入。"
                commitments["result"].update(
                    status="violation", violation={
                        "category": "added_obligation", "candidate_path": "/text",
                        "candidate_quote": "我今晚可以开车接你，再帮你把事情处理好",
                        "source_path": "/draft_text", "source_quote": "今晚不参加",
                    })
                parts = ["最近怎么样？", "想聊的话我今晚可以开车接你，", "再帮你把事情处理好。"]
                claims = [synthetic_claim(part, kind="speech_act" if index == 1 else "commitment",
                                          start=1 + sum(len(value) for value in parts[:index - 1]))
                          for index, part in enumerate(parts, 1)]
                for index, claim in enumerate(claims, 1): claim["claim_id"] = index
                arguments["reviews"]["candidate_1"]["claims"] = claims
            return sdk_response(request, generation_arguments=generation, review_arguments=arguments)

        ledger = RecordingLedger()
        runtime, requests, _ = self.runtime(respond, ledger=ledger)
        with self.assertRaises(ReplyCandidatesRejectedError):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 2)
        self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "succeeded"])

    def test_review_receives_literal_insertions_from_actual_draft_and_candidate(self):
        context = self.context()
        draft = "最近怎么样？想聊聊的话我今晚有空。"
        context = replace(context, command=replace(context.command, content=replace(
            context.command.content, draft_text=draft)), current_text=draft,
            evidence=(replace(context.evidence[0], text=draft),))
        generation = reply_output().tool_calls[0]["args"]
        generation["candidates"][0].update(text="最近怎么样？想聊聊的话，我今晚有空。",
                                            basis="仅加逗号，去掉了原句的‘的’。")
        runtime, requests, _ = self.runtime(lambda request: sdk_response(request, generation_arguments=generation))
        runtime.generate(context)
        payload = json.loads(requests[1]["messages"][-1]["content"])
        self.assertEqual(payload["literal_changes"], [{"candidate_number": 1,
            "scope": "draft_text_to_candidate_text", "status": "computed", "changes": [{
                "operation": "insert", "draft_fragment": "", "candidate_fragment": "，",
            }]}])
        self.assertEqual(payload["candidates"][0]["basis"], "仅加逗号，去掉了原句的‘的’。")
        self.assertEqual(payload["candidates"][0]["messages"], [])
        self.assertEqual(len(requests), 2)

    def test_literal_change_evidence_distinguishes_deletion_replacement_and_unchanged_text(self):
        for text, expected in (("我有空。", [{"operation": "delete", "draft_fragment": "今晚", "candidate_fragment": ""}]),
                               ("我明晚有空。", [{"operation": "replace", "draft_fragment": "今", "candidate_fragment": "明"}]),
                               ("我今晚有空。", [])):
            with self.subTest(text=text):
                context = self.context()
                context = replace(context, command=replace(context.command, content=replace(
                    context.command.content, draft_text="我今晚有空。")), current_text="我今晚有空。",
                    evidence=(replace(context.evidence[0], text="我今晚有空。"),))
                generation = reply_output().tool_calls[0]["args"]
                generation["candidates"][0]["text"] = text
                runtime, requests, _ = self.runtime(lambda request: sdk_response(request, generation_arguments=generation))
                runtime.generate(context)
                proof = json.loads(requests[1]["messages"][-1]["content"])["literal_changes"][0]
                self.assertEqual((proof["status"], proof["changes"]), ("computed", expected))

    def test_unavailable_literal_comparison_preserves_the_entire_input_and_candidate(self):
        context = self.context()
        draft = "合成完整原句：" + "资料" * 2048
        context = replace(context, command=replace(context.command, content=replace(
            context.command.content, draft_text=draft)), current_text=draft,
            evidence=(replace(context.evidence[0], text=draft),))
        runtime, requests, _ = self.runtime(sdk_response)
        runtime.generate(context)
        payload = json.loads(requests[1]["messages"][-1]["content"])
        self.assertEqual(payload["draft_text"], draft)
        self.assertEqual(payload["candidates"][0]["text"], "合成候选：今晚不参加，祝活动顺利。")
        self.assertEqual(payload["literal_changes"], [{"candidate_number": 1,
            "scope": "draft_text_to_candidate_text", "status": "unavailable", "changes": [],
            "reason": "comparison_limit"}])

    def test_generation_and_review_share_one_timeout_and_cancel_the_review(self):
        for pasted in (False, True):
            with self.subTest(pasted=pasted):
                cancelled = []
                async def slow(request):
                    review = json.loads(request.content)["tools"][0]["function"]["name"] == "ReplyFidelityReview"
                    try:
                        await asyncio.sleep(.3 if review else .12)
                        return sdk_response(request)
                    except asyncio.CancelledError:
                        cancelled.append(review)
                        raise
                context = self.context()
                if pasted:
                    context = replace(context, command=replace(context.command, content=replace(
                        context.command.content, input_kind="current_chat", pasted_direction="自然回应，不虚构本人状态。",
                        user_instruction=None)), evidence=(replace(context.evidence[0], kind="user_current_chat", status="user_input"),))
                ledger = RecordingLedger()
                runtime, requests, _ = self.runtime(slow, timeout=.2, ledger=ledger)
                with self.assertRaises(ReplyTimeoutError):
                    runtime.generate(context)
                self.assertEqual(len(requests), 2)
                self.assertEqual(cancelled, [True])
                self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "run_failed"])

    def test_second_sdk_failure_has_its_own_record_and_failed_ledger_cannot_deliver(self):
        def fail_review(request):
            return (httpx.Response(400, json={"error": {"message": "synthetic"}})
                if json.loads(request.content)["tools"][0]["function"]["name"] == "ReplyFidelityReview"
                else sdk_response(request))
        ledger = RecordingLedger()
        runtime, requests, _ = self.runtime(fail_review, ledger=ledger)
        with self.assertRaises(Exception):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 2)
        self.assertEqual([row.outcome.value for row in ledger.entries], ["succeeded", "run_failed"])
        class BrokenLedger:
            def record(self, entry):
                raise RuntimeError("合成台账不可用。")
        runtime, requests, _ = self.runtime(sdk_response, ledger=BrokenLedger())
        with self.assertRaises(Exception):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 1)

    def test_maximum_length_character_table_is_rejected_before_review_dispatch(self):
        generation = reply_output().tool_calls[0]["args"]
        text = "合" * 65536
        generation["candidates"][0]["text"] = text
        generation["candidates"][0].pop("messages", None)
        runtime, requests, decisions = self.runtime(lambda request: sdk_response(request,
            generation_arguments=generation))
        with self.assertRaises(InputBudgetExceededError):
            runtime.generate(self.context())
        self.assertEqual(generation["candidates"][0]["text"], text)
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(decisions), 2)
        self.assertFalse(decisions[-1].allowed)

    def test_oversized_review_payload_is_rejected_before_second_dispatch(self):
        runtime, requests, decisions = self.runtime(lambda request: sdk_response(request, large=True), capacity=50000)
        with self.assertRaises(InputBudgetExceededError):
            runtime.generate(self.context())
        self.assertEqual(len(requests), 1)
        self.assertFalse(decisions[-1].allowed)


class RecordingLedger:
    def __init__(self):
        self.entries = []

    def record(self, entry):
        self.entries.append(entry)
        return entry


class LayeredReviewSourceContractTest(unittest.TestCase):
    def test_only_actual_profile_text_can_support_fact_or_explanation(self):
        from notalone.reply.adapters.constraint_review_contract import accepted_candidate_numbers, CHECK_CATEGORIES
        payload = {"draft_text": "你好", "candidates": [{"candidate_number": 1, "text": "曾共同学习", "basis": "曾共同学习",
            "messages": [], "risk_notes": []}], "layered_context": {
            "profile_entries": [{"text": "过去共同学习", "references": [{"text": "隐藏引用"}]}],
            "directory": [{"title": "共同学习", "hint": "共同学习", "paragraphs": [{"text": "未读正文"}]}],
            "dependency_ids": ["隐藏依赖"]}}
        from notalone.reply.adapters.constraint_review_contract import review_target
        payload["candidates"][0]["review_target"] = review_target(payload["candidates"][0])
        for category, path, quote, valid in (
            ("facts", "/layered_context/profile_entries/0/text", "共同学习", True),
            ("explanation", "/layered_context/profile_entries/0/text", "共同学习", True),
            ("facts", "/layered_context/profile_entries/1/text", "共同学习", False),
            ("facts", "/layered_context/profile_entries/0/references/0/text", "隐藏引用", False),
            ("facts", "/layered_context/directory/0/title", "共同学习", False),
            ("facts", "/layered_context/directory/0/hint", "共同学习", False),
            ("facts", "/layered_context/directory/0/paragraphs/0/text", "未读正文", False),
            ("facts", "/layered_context/dependency_ids/0", "隐藏依赖", False),
            ("intent", "/layered_context/profile_entries/0/text", "共同学习", False),
            ("instruction", "/layered_context/profile_entries/0/text", "共同学习", False),
            ("commitments", "/layered_context/profile_entries/0/text", "共同学习", False),
        ):
            with self.subTest(category=category, path=path):
                report = synthetic_review(payload)
                check = report["reviews"]["candidate_1"]["checks"][category]
                check["result"] = {"status": "violation", "violation": {
                    "category": CHECK_CATEGORIES[category][0],
                    "candidate_path": "/basis" if category == "explanation" else "/text",
                    "candidate_quote": "共同学习", "source_path": path, "source_quote": quote}}
                if valid:
                    self.assertEqual(accepted_candidate_numbers(report, payload), frozenset())
                else:
                    with self.assertRaises(ReplyReviewInvalidError):
                        accepted_candidate_numbers(report, payload)
