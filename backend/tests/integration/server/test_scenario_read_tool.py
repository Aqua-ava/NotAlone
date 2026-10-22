"""场景正文工具穿过公开HTTP、真实PG与受控模型的合同。"""

import json
import unittest

from langchain_core.messages import ToolMessage

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_layered_reply_context import LayeredReplyHttpTest
from tests.integration.server.test_layered_memory_management import ControlledProposal


class TwoScenarioProposal(ControlledProposal):
    def propose(self, *, memories, budget, deadline):
        proposal = super().propose(memories=memories, budget=budget, deadline=deadline)
        first = proposal["scenarios"][0]
        first["paragraphs"].append({**first["paragraphs"][0], "text": "共同课程发生于过去；目前情况未核实。"})
        proposal["scenarios"].append({**first, "topic_key": "learning-followup",
                                     "title": "学习后续", "hint": "另一个主题入口"})
        return proposal


class ScenarioReadHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = LayeredReplyHttpTest.controlled
    read = LayeredReplyHttpTest.read
    prepare_layered_reply = LayeredReplyHttpTest.prepare_layered_reply

    def enable(self, backend, contact):
        status, result = backend.request(f"/api/contacts/{contact}/layered-memory/enable", {
            "settings_generation": self.read(backend, contact)["settings_generation"],
            "purpose_confirmed": True}, timeout=40)
        self.assertEqual(status, 200, result)
        return result["layered_memory"]

    def use_tools(self, *, calls=3, paragraphs=4, characters=4000, directory=4):
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        self.layered_reply_options["layered_reply_budget"] = LayeredReplyBudget(4, directory, 4000,
            scenario_read=ScenarioReadBudget(calls, paragraphs, characters))
        self.backend = self._backend(self.owner_id)

    @staticmethod
    def tool_plan(scenario, index=0, **extra):
        return {"history": {"name": "read_scenario", "args": {
            "scenario_id": scenario, "paragraph_index": index, **extra}}}

    def complete(self, contact, path, plans):
        first_call = len(self.reply_model.seen_calls)
        self.reply_model.plans.extend([*plans, {"text": "聊聊共同课程。", "basis": "按实际提供的资料。"}])
        self.last_complete_body = self.rewrite_body(contact, "聊聊共同课程。")
        status, turn = self.backend.request(path + "/replies", self.last_complete_body, timeout=30)
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        sent = [json.loads(message.content) for message in self.reply_model.seen_calls[-1]
                if isinstance(message, ToolMessage) and message.name == "read_scenario"]
        self.assertEqual(evidence["layered_scenario_reads"], sent)
        return evidence, self.reply_model.seen_calls[first_call:]

    def test_actual_tool_paragraphs_are_sent_and_saved_for_evidence(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        scenario = ready["scenarios"][0]
        self.reply_model.plans.extend([
            {"history": {"name": "read_scenario", "args": {
                "scenario_id": scenario["scenario_id"], "paragraph_index": 0}}},
            {"text": "我们一起上过课。", "basis": "按本次实际读取的主题正文。"},
        ])
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊一起上课。"))
        self.assertEqual(status, 200, turn)
        tool = next(message for message in self.reply_model.seen_calls[1]
                    if isinstance(message, ToolMessage) and message.name == "read_scenario")
        self.assertTrue(tool.content.startswith("{"), tool.content)
        receipt = json.loads(tool.content)
        self.assertEqual(receipt["status"], "succeeded")
        document = receipt["document"]
        self.assertEqual(document["version_id"], scenario["version_id"])
        self.assertEqual(document["paragraph_range"], [0, 1])
        self.assertEqual(document["paragraphs"], scenario["paragraphs"][:1])
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence["layered_scenario_reads"], [receipt])
        self.assertNotIn("paragraphs", evidence["layered_context"]["directory"][0])
        self.assertEqual(evidence["retrieval"]["budgets"]["source_messages"]["used_calls"], 0)

    def test_tool_cannot_read_an_unexposed_entry_from_the_larger_frozen_collection(self):
        contact, _, message = self.import_contact("双方共同参加过合成课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        management = self.controlled(scenario_proposer=TwoScenarioProposal())
        ready = self.enable(management, contact)
        self.layered_reply_options = {"layered_memory": self.service}
        self.activate_replies(contact)
        self.use_tools(directory=1)
        path = self.reply_path(contact)
        first, second = ready["scenarios"]
        evidence, calls = self.complete(contact, path, [self.tool_plan(second["scenario_id"])])
        self.assertEqual(len(evidence["layered_context"]["directory"]), 1)
        exposed = evidence["layered_context"]["directory"][0]["scenario_id"]
        # 管理排序和回复排序可能不同；明确请求实际未暴露的那个稳定身份。
        if exposed == second["scenario_id"]:
            evidence, calls = self.complete(contact, path, [self.tool_plan(first["scenario_id"])])
        receipt = evidence["layered_scenario_reads"][0]
        self.assertEqual(receipt["status"], "not_in_directory")
        self.assertNotIn("document", receipt)

    def test_raw_extra_and_wrong_types_get_deterministic_bounded_receipts(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools(calls=8)
        identifier = ready["scenarios"][0]["scenario_id"]
        bad = [self.tool_plan(identifier, True), self.tool_plan(identifier, "0"),
               self.tool_plan(identifier, owner_id=str(self.owner_id)),
               self.tool_plan(identifier, file_path="/skills/other/SKILL.md"),
               self.tool_plan(identifier, version_id=ready["scenarios"][0]["version_id"]),
               self.tool_plan(identifier, -1), self.tool_plan(identifier, 1)]
        evidence, _ = self.complete(contact, path, bad)
        receipts = evidence["layered_scenario_reads"]
        self.assertEqual([item["status"] for item in receipts],
                         ["invalid_arguments"] * 5 + ["out_of_range"] * 2)
        self.assertTrue(all("document" not in item for item in receipts))
        self.assertEqual([item["budget"]["used_calls"] for item in receipts], list(range(1, 8)))

    def test_legacy_range_arguments_do_not_silently_read_a_single_paragraph(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        legacy = {"scenario_id": ready["scenarios"][0]["scenario_id"],
                  "paragraph_start": 0, "paragraph_end": 1}
        evidence, _ = self.complete(contact, path, [
            {"history": {"name": "read_scenario", "args": legacy}},
            {"history": {"name": "read_scenario", "args": {**legacy, "paragraph_index": 0}}}])
        self.assertEqual([item["status"] for item in evidence["layered_scenario_reads"]],
                         ["invalid_arguments", "invalid_arguments"])
        self.assertTrue(all("document" not in item for item in evidence["layered_scenario_reads"]))

    def test_duplicate_and_call_exhaustion_do_not_return_the_body_again(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools(calls=2)
        plan = self.tool_plan(ready["scenarios"][0]["scenario_id"])
        evidence, _ = self.complete(contact, path, [plan, plan, plan])
        receipts = evidence["layered_scenario_reads"]
        self.assertEqual([item["status"] for item in receipts], ["succeeded", "duplicate", "budget_exceeded"])
        self.assertEqual([item["budget"]["used_calls"] for item in receipts], [1, 2, 2])
        self.assertEqual([item["budget"]["used_paragraphs"] for item in receipts], [1, 1, 1])
        self.assertTrue(all("document" not in item for item in receipts[1:]))

    def test_parallel_calls_atomically_share_call_capacity_and_deduplicate_paragraphs(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools(calls=2)
        args = self.tool_plan(ready["scenarios"][0]["scenario_id"])["history"]["args"]
        evidence, _ = self.complete(contact, path, [{"parallel_scenarios": [args, args, args]}])
        receipts = evidence["layered_scenario_reads"]
        self.assertCountEqual([item["status"] for item in receipts], ["succeeded", "duplicate", "budget_exceeded"])
        self.assertEqual(sum("document" in item for item in receipts), 1)
        self.assertEqual(max(item["budget"]["used_calls"] for item in receipts), 2)
        self.assertEqual(max(item["budget"]["used_paragraphs"] for item in receipts), 1)

    def test_success_and_rejections_count_the_complete_real_model_requests(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        decisions = []
        self.layered_reply_options["on_input_budget"] = decisions.append
        self.use_tools(calls=1)
        args = ready["scenarios"][0]["scenario_id"]
        evidence, calls = self.complete(contact, path, [self.tool_plan(args), self.tool_plan(args)])
        actual = self.reply_model.seen_model_payloads
        self.assertEqual(len(actual), 3)
        for payload, decision in zip(actual, decisions[-3:], strict=True):
            self.assertEqual(decision.input_tokens,
                len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))) + 17)
            self.assertEqual(decision.total_tokens, decision.input_tokens + 4096)
            self.assertIn("system", {message["role"] for message in payload["messages"]})
            self.assertIn("read_scenario", str(payload["tools"]))
        self.assertIn("budget_exceeded", str(actual[-1]["messages"]))
        self.assertIn(evidence["layered_scenario_reads"][0]["document"]["paragraphs"][0]["text"], str(actual[-1]["messages"]))

    def test_paragraph_and_character_limits_reject_whole_body_without_borrowing_history(self):
        contact, _, message = self.import_contact("双方共同参加过合成课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        management = self.controlled(scenario_proposer=TwoScenarioProposal())
        ready = self.enable(management, contact)
        self.layered_reply_options = {"layered_memory": self.service}
        self.activate_replies(contact)
        identifier = ready["scenarios"][0]["scenario_id"]
        for limits, indices in (({"paragraphs": 1}, (0, 1)), ({"characters": 1}, (0,))):
            with self.subTest(limits=limits):
                self.use_tools(**limits)
                status, session = self.backend.request(f"/api/contacts/{contact}/assistant-sessions", {}, method="POST")
                self.assertEqual(status, 200, session)
                path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
                evidence, _ = self.complete(contact, path, [self.tool_plan(identifier, index) for index in indices])
                receipt = evidence["layered_scenario_reads"][-1]
                self.assertEqual(receipt["status"], "budget_exceeded")
                if "paragraphs" in limits:
                    first = evidence["layered_scenario_reads"][0]
                    self.assertEqual(first["status"], "succeeded")
                    self.assertEqual(receipt["budget"]["used_paragraphs"], 1)
                    self.assertEqual(receipt["budget"]["used_characters"], first["budget"]["used_characters"])
                else:
                    self.assertEqual((receipt["budget"]["used_paragraphs"], receipt["budget"]["used_characters"]), (0, 0))
                self.assertNotIn("document", receipt)
                history = evidence["retrieval"]["budgets"]["source_messages"]
                self.assertEqual((history["call_limit"], history["item_limit"], history["token_limit"]), (3, 16, 2048))

    def invalidate_after_read(self, action):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        contact, source, management, ready, path = self.prepare_layered_reply()
        entered, release = Event(), Event()
        def before_send(decision):
            if len(self.reply_model.seen_calls) == 1:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("读取后模型出站边界未释放。")
        self.layered_reply_options["on_input_budget"] = before_send
        self.use_tools()
        self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
                                      {"text": "不应出站。", "basis": "不得提交。"}])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
            try:
                self.assertTrue(entered.wait(5))
                if action == "disable":
                    status, changed = management.request(f"/api/contacts/{contact}/layered-memory/disable",
                        {"settings_generation": ready["settings_generation"]})
                    self.assertEqual(status, 200, changed)
                elif action == "withdraw":
                    status, changed = management.request(f"/api/contacts/{contact}/layered-memory/withdraw-scenario",
                        {"settings_generation": ready["settings_generation"],
                         "organization_generation": ready["organization_generation"],
                         "scenario_version_id": ready["scenarios"][0]["version_id"]})
                    self.assertEqual(status, 200, changed)
                else:
                    self.delete_source(contact, source)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(len(self.reply_model.plans), 1)

    def test_disabling_after_body_read_blocks_the_next_actual_model_send(self):
        self.invalidate_after_read("disable")

    def test_source_deletion_after_body_read_blocks_the_next_actual_model_send(self):
        self.invalidate_after_read("source")

    def test_withdrawing_after_body_read_blocks_the_next_actual_model_send(self):
        self.invalidate_after_read("withdraw")

    def test_stale_body_read_returns_no_document_and_cannot_send_the_receipt(self):
        from concurrent.futures import ThreadPoolExecutor
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.use_tools()
        self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
                                      {"text": "不应发送。", "basis": "失效后停止。"}])
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self.assertEqual(management.request(f"/api/contacts/{contact}/layered-memory/disable",
                    {"settings_generation": ready["settings_generation"]})[0], 200)
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        measured = self.reply_input_counter.seen_payloads[-1]
        receipt = next(json.loads(item["content"]) for item in measured["messages"]
                       if item["role"] == "tool")
        self.assertEqual(receipt["status"], "stale")
        self.assertNotIn("document", receipt)

    def test_historical_independent_review_receives_the_exact_actual_tool_body(self):
        self.historical_constraint_review = True
        from langchain_core.messages import HumanMessage
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
            {"text": "你好，想起一起上课的时光。", "basis": "实际主题记录双方共同参加过课程。"}])
        body = self.rewrite_body(contact, "你好。")
        body["content"]["user_instruction"] = "自然表达，允许联系合法历史。"
        def review(payload, report):
            self.assertNotIn("共同参加过课程", str(payload["evidence"]))
            receipts = payload.get("layered_scenario_reads", [])
            supported = bool(receipts and receipts[0].get("status") == "succeeded")
            report["reviews"]["candidate_1"]["checks"]["facts"]["result"]["status"] = "supported" if supported else "unknown"
            return report
        self.reply_model.review_transform = review
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        self.assertEqual(len(self.reply_model.seen_calls), 3)
        generation = self.reply_model.seen_calls[1]
        actual = [json.loads(item.content) for item in generation if isinstance(item, ToolMessage)]
        reviewed = next(json.loads(item.content) for item in self.reply_model.seen_calls[2] if isinstance(item, HumanMessage))
        self.assertEqual(reviewed["layered_scenario_reads"], actual)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved["layered_scenario_reads"], actual)

    def test_historical_review_can_locate_only_read_body_facts_and_does_not_authorize_intent(self):
        self.historical_constraint_review = True
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        source = "/layered_scenario_reads/0/document/paragraphs/0/text"
        for category, violation in (("facts", "unsupported_fact"), ("intent", "changed_intent")):
            with self.subTest(category=category):
                self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
                    {"text": "我们从来没有一起上过课。", "basis": "合成矛盾事实。"}])
                def contradict(payload, report):
                    report["reviews"]["candidate_1"]["checks"][category]["result"] = {
                        "status": "violation", "violation": {"category": violation,
                        "candidate_path": "/text", "candidate_quote": "从来没有一起上过课",
                        "source_path": source, "source_quote": "双方共同参加过课程。"}}
                    return report
                self.reply_model.review_transform = contradict
                body = self.rewrite_body(contact, "你好。")
                body["content"]["user_instruction"] = "自然表达。"
                status, result = self.backend.request(path + "/replies", body, timeout=30)

                # 非法复核source_path按明确复核错误失败闭合，不交付候选。
                self.assertEqual(status, 409 if category == "facts" else 502, result)
                self.assertEqual(result["error"], "reply_candidates_rejected" if category == "facts" else "reply_review_invalid")

    def test_saved_body_is_not_rebuilt_after_disable_and_backend_restart(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.use_tools()
        saved, _ = self.complete(contact, path, [self.tool_plan(ready["scenarios"][0]["scenario_id"])])
        self.assertEqual(management.request(f"/api/contacts/{contact}/layered-memory/disable",
            {"settings_generation": ready["settings_generation"]})[0], 200)
        restarted = self._backend(self.owner_id)
        self.assertEqual(self._get(restarted, f"/api/contacts/{contact}/replies/{saved['reply_request_id']}/evidence"), saved)

    def test_withdrawing_scenario_erases_saved_tool_body_and_blocks_replay(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.use_tools()
        saved, _ = self.complete(contact, path, [self.tool_plan(ready["scenarios"][0]["scenario_id"])])
        calls = len(self.reply_model.seen_calls)
        status, changed = management.request(f"/api/contacts/{contact}/layered-memory/withdraw-scenario",
            {"settings_generation": ready["settings_generation"],
             "organization_generation": ready["organization_generation"],
             "scenario_version_id": ready["scenarios"][0]["version_id"]})
        self.assertEqual(status, 200, changed)
        restarted = self._backend(self.owner_id)
        self.assertNotEqual(restarted.request(f"/api/contacts/{contact}/replies/{saved['reply_request_id']}/evidence")[0], 200)
        self.assertNotIn("按实际提供的资料", str(self._get(restarted, path)))
        self.assertNotEqual(restarted.request(path + "/replies", self.last_complete_body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

    def test_hidden_generation_source_erases_saved_body_and_blocks_replay(self):
        from datetime import datetime, timezone
        contact, first_source, message = self.import_contact("双方共同参加过课程。")
        first_memory = self.confirm(contact, "双方共同参加过课程。", message)
        _, second_source, message = self.import_contact("双方曾分开练习。", contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        second_memory = self.confirm(contact, "双方曾分开练习。", message)
        management = self.controlled()
        ready = self.enable(management, contact)
        self.layered_reply_options = {"layered_memory": self.service}
        self.activate_replies(contact)
        self.use_tools()
        path = self.reply_path(contact)
        saved, _ = self.complete(contact, path, [self.tool_plan(ready["scenarios"][0]["scenario_id"])])
        direct = {ref["memory_id"] for paragraph in saved["layered_scenario_reads"][0]["document"]["paragraphs"]
                  for ref in paragraph["references"]}
        hidden_source = second_source if second_memory["memory_id"] not in direct else first_source
        hidden_memory = second_memory if hidden_source == second_source else first_memory
        self.assertNotIn(hidden_memory["memory_id"], direct)
        calls = len(self.reply_model.seen_calls)
        self.delete_source(contact, hidden_source)
        restarted = self._backend(self.owner_id)
        self.assertNotEqual(restarted.request(f"/api/contacts/{contact}/replies/{saved['reply_request_id']}/evidence")[0], 200)
        self.assertNotIn("按实际提供的资料", str(self._get(restarted, path)))
        self.assertNotEqual(restarted.request(path + "/replies", self.last_complete_body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

    def test_final_writer_revalidates_the_tool_body_after_model_validation(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from unittest.mock import patch
        from notalone.persistence.reply_store import PostgresReplyStore
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.use_tools()
        entered, release = Event(), Event()
        class WriterBarrier(PostgresReplyStore):
            def save(self, request, context, reply):
                self_context = context.layered_scenario_reads
                if not self_context or self_context[0]["status"] != "succeeded":
                    raise AssertionError("最终writer没有携带本次实际正文。")
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("合成最终writer边界未释放。")
                return super().save(request, context, reply)
        store = WriterBarrier(self.database_url, layered_memory=self.service,
            layered_budget=self.layered_reply_options["layered_reply_budget"])
        with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
            self.backend = self._backend(self.owner_id)
        self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
            {"text": "提交竞态合成候选。", "basis": "实际冻结正文。"}])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(management.request(f"/api/contacts/{contact}/layered-memory/disable",
                    {"settings_generation": ready["settings_generation"]})[0], 200)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertNotIn("提交竞态合成候选", str(self._get(self.backend, path)))

    def test_complete_request_capacity_stops_before_second_send_without_cutting_user_input(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        plan = self.tool_plan(ready["scenarios"][0]["scenario_id"])
        self.complete(contact, path, [plan])
        first = self.reply_model.seen_model_payloads[0]
        self.reply_capacity = len(json.dumps(first, ensure_ascii=False, separators=(",", ":"))) + 17 + 4096 + 1
        self.backend = self._backend(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-sessions", {}, method="POST")
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        before = len(self.reply_model.seen_calls)
        self.reply_model.plans.extend([plan, {"text": "容量不足时不得发送。", "basis": "完整请求不能裁切。"}])
        body = self.rewrite_body(contact, "聊聊共同课程。")
        status, result = self.backend.request(path + "/replies", body, timeout=30)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.seen_calls), before + 1)
        self.assertEqual(self.reply_model.payloads[-1]["draft_text"], "聊聊共同课程。")
        measured = self.reply_input_counter.seen_payloads[-1]
        self.assertIn("succeeded", str(measured["messages"]))
        self.assertEqual(len(self.reply_model.plans), 1)

    def test_model_cannot_turn_a_scenario_version_into_a_citation_identity(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        self.reply_model.plans.extend([self.tool_plan(ready["scenarios"][0]["scenario_id"]),
            {"text": "不能冒充已授权证据。", "basis": "版本不是证据身份。",
             "citation_ids": [ready["scenarios"][0]["version_id"]]}])
        status, result = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("不能冒充已授权证据", str(self._get(self.backend, path)))

    def test_missing_explicit_tool_budget_does_not_register_new_reading_capability(self):
        contact, _, _, _, path = self.prepare_layered_reply()
        self.complete(contact, path, [])
        self.assertNotIn("read_scenario", str(self.reply_model.seen_model_payloads[-1]["tools"]))

    def test_model_cannot_hide_an_extra_argument_behind_framework_runtime_injection(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        self.use_tools()
        identifier = ready["scenarios"][0]["scenario_id"]
        evidence, _ = self.complete(contact, path, [
            self.tool_plan(identifier, **{key: {"owner_id": "model-supplied"}})
            for key in ("runtime", "config", "self")])
        receipts = evidence["layered_scenario_reads"]
        self.assertEqual([receipt["status"] for receipt in receipts], ["invalid_arguments"] * 3)
        self.assertTrue(all("document" not in receipt for receipt in receipts))
