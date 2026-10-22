"""本人整理纠错沿公开 HTTP 清除跨联系人的实际回复使用闭包。"""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import SystemMessage, ToolMessage

from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server import test_layered_fact_correction as fact_support
from tests.integration.server import test_layered_correction_matrix as matrix_support


class OwnerLayeredCorrectionReplyCopiesHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    _prepare_independent_batches = fact_support.LayeredFactCorrectionHttpTest._prepare_independent_batches
    _target_command = matrix_support.LayeredCorrectionMatrixHttpTest._target_command
    owner_path = "/api/memories/owner/layered-memory"

    def prepare_owner(self):
        management, _, _, ready, target, independent = self._prepare_independent_batches("owner")
        self.management = management
        self.ready, self.target, self.independent = ready, target, independent
        self.scenario = next(doc for doc in ready["scenarios"] if any(
            ref["memory_id"] == target["memory_id"] for paragraph in doc["paragraphs"]
            for ref in paragraph["references"]))
        self.independent_scenario = next(doc for doc in ready["scenarios"] if doc != self.scenario)
        self.layered_reply_options = {
            "layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 10000),
            "owner_layered_reply_budget": LayeredReplyBudget(4, 4, 10000, ScenarioReadBudget(2, 2, 6000)),
        }
        self.contacts = [self.import_contact(text)[0] for text in (
            "甲询问课程进展。", "乙询问课程背景。", "包裹已签收，谢谢。")]
        for contact in self.contacts:
            self.activate_replies(contact)
        self.paths = [self.reply_path(contact) for contact in self.contacts]
        self.owner_before = self._get(self.backend, "/api/memories/owner")["memories"]

    def generate_used(self, contact, path):
        start = len(self.reply_model.seen_calls)
        self.reply_model.plans.extend([
            {"history": {"name": "read_scenario", "args": {
                "scenario_id": self.scenario["scenario_id"], "paragraph_index": 0}}},
            {"text": "已根据本人课程背景形成候选。", "basis": "本次实际背景和主题正文。"},
        ])
        body = self.rewrite_body(contact, "请聊聊合成课程。")
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        calls = self.reply_model.seen_calls[start:]
        self.assertEqual(len(calls), 2)
        initial = "\n".join(str(item.content) for item in calls[0] if isinstance(item, SystemMessage))
        self.assertIn(self.ready["profile"]["version_id"], initial)
        self.assertIn(self.target["text"], initial)
        sent = [json.loads(item.content) for item in calls[-1]
                if isinstance(item, ToolMessage) and item.name == "read_scenario"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["status"], "succeeded", sent)
        self.assertEqual(sent[0]["document"]["version_id"], self.scenario["version_id"])
        self.assertEqual(sent[0]["document"]["paragraphs"], self.scenario["paragraphs"])
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved["owner_layered_context"]["profile_version_id"], self.ready["profile"]["version_id"])
        self.assertEqual(saved["owner_layered_scenario_reads"], sent)
        self.assertIn(self.target["memory_id"], [item["evidence_id"] for item in saved["evidence"]])
        return {"contact": contact, "path": path, "body": body, "turn": turn, "saved": saved}

    def edit_and_carries(self, record):
        candidate = record["turn"]["candidates"][0]
        path, contact = record["path"], record["contact"]
        versions_path = path + "/candidates/" + candidate["candidate_id"] + "/versions"
        edit_text = "用户编辑：这次只作简短回应。"
        messages = [{"message_id": candidate["messages"][0]["message_id"], "text": edit_text}]
        status, history = self.backend.request(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": candidate["candidate_id"], "messages": messages})
        self.assertEqual(status, 200, history)
        version = history["versions"][-1]["version_id"]
        record.update(versions_path=versions_path, history=history, carries=[])
        for consume in (False, True):
            status, selected = self.backend.request(path + "/selections", {
                "selection_key": str(uuid4()), "candidate_id": candidate["candidate_id"], "version_id": version})
            self.assertEqual(status, 200, selected)
            command = {"expected_selection_id": selected["selection_id"],
                       "candidate_id": candidate["candidate_id"], "version_id": version}
            status, carried = self.backend.request(path + "/new-with-candidate", command)
            self.assertEqual(status, 200, carried)
            child = f"/api/contacts/{contact}/assistant-sessions/{carried['session_id']}"
            current = self._get(self.backend, child)
            self.assertEqual(current["inputs"][0]["content"]["messages"], messages)
            carry = {"path": child, "input_id": carried["input_version_id"], "command": command,
                     "before": current}
            record["carries"].append(carry)
            if consume:
                body = self.rewrite_body(contact, "谢谢，明天见。", include_context=False)
                body["expected_input_version_id"] = carried["input_version_id"]
                self.reply_model.plans.append({"text": "携入后的独立回应。", "basis": "本次明确选择的候选。"})
                status, descendant = self.backend.request(child + "/replies", body)
                self.assertEqual(status, 200, descendant)
                self.assertIn(edit_text, str(self.reply_model.payloads[-1]["assistant_discussion"]))
                carry.update(body=body, turn=descendant,
                             saved=self._get(self.backend, self.evidence_path(contact, descendant)))
        self.assertNotEqual(record["carries"][0]["input_id"], record["carries"][1]["input_id"])
        record["history"] = self._get(self.backend, versions_path)

    def prepare_records(self):
        self.prepare_owner()
        self.records = []
        for contact, path in zip(self.contacts[:2], self.paths[:2]):
            record = self.generate_used(contact, path)
            self.edit_and_carries(record)
            prepared = self.rewrite_body(contact, "保留待生成的课程输入。")
            status, receipt = self.backend.request(path + "/replies/prepare", prepared)
            self.assertEqual(status, 200, receipt)
            record.update(prepared=prepared, receipt=receipt)
            self.records.append(record)
        # 关闭新层不免除L1：先独立核对初始、携入和后继实际模型输入。
        contact, path = self.contacts[2], self.paths[2]
        start = len(self.reply_model.seen_calls)
        self.reply_model.plans.append({"text": "包裹已签收，谢谢。", "basis": "当前草稿。"})
        body = self.rewrite_body(contact, "包裹已签收，谢谢。", include_context=False)
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        self.control = {"contact": contact, "path": path, "body": body, "turn": turn,
                        "saved": self._get(self.backend, self.evidence_path(contact, turn))}
        self.edit_and_carries(self.control)
        actual = "\n".join(str(message.content) for call in self.reply_model.seen_calls[start:] for message in call)
        self.assertNotIn(self.target["memory_id"], str(self.control["saved"]["evidence"]))
        for forbidden in (self.target["memory_id"], self.target["text"], self.scenario["version_id"],
                          self.ready["profile"]["version_id"]):
            self.assertNotIn(forbidden, actual)
            self.assertNotIn(forbidden, json.dumps(self.control, ensure_ascii=False))
        prepared = self.rewrite_body(contact, "包裹已签收，谢谢。", include_context=False)
        self.assertEqual(self.backend.request(path + "/replies/prepare", prepared)[0], 200)
        self.control["prepared"] = prepared
        with psycopg.connect(self.database_url) as connection:
            for record in self.records:
                frozen = connection.execute("SELECT prepared_context FROM public.assistant_session_turn "
                    "WHERE owner_id=%s AND idempotency_key=%s", (self.owner_id,
                    UUID(record["prepared"]["idempotency_key"]))).fetchone()[0]
                self.assertIn(self.ready["profile"]["version_id"], str(frozen))
                self.assertIn(self.scenario["version_id"], str(frozen))
            frozen = connection.execute("SELECT prepared_context FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND idempotency_key=%s", (self.owner_id,
                UUID(prepared["idempotency_key"]))).fetchone()[0]
            for forbidden in (self.target["memory_id"], self.scenario["version_id"], self.ready["profile"]["version_id"]):
                self.assertNotIn(forbidden, str(frozen))

    def report(self, kind, *, fact=False):
        command = self._target_command(self.ready, kind, self.target["memory_id"])
        command.update({"memory_id": self.target["memory_id"]} if fact else {
            "reason": "总结错误，请只按原资料核对。", "operation_id": str(uuid4())})
        status, result = self.management.request(self.owner_path + ("/fact-error" if fact else "/summary-error"), command)
        self.assertEqual(status, 200, result)
        return result["layered_memory"], command

    def assert_prepared_erased_before_read(self):
        # 公开命令完成后、任何GET前直接检查敏感准备已在同事务清空，避免惰性读取掩盖残留。
        keys = [UUID(record["prepared"]["idempotency_key"]) for record in self.records]
        inputs = [UUID(carry["input_id"]) for record in self.records for carry in record["carries"]]
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("SELECT state,input_payload,prepared_context,dependency_ids "
                "FROM public.assistant_session_turn WHERE owner_id=%s AND idempotency_key=ANY(%s::uuid[])",
                (self.owner_id, keys)).fetchall()
            self.assertEqual(rows, [("redacted", None, None, []), ("redacted", None, None, [])])
            rows = connection.execute("SELECT state,content,dependency_ids FROM public.assistant_session_input "
                "WHERE owner_id=%s AND id=ANY(%s::uuid[])", (self.owner_id, inputs)).fetchall()
            self.assertEqual(rows, [("redacted", None, [])] * 4)

    def assert_erased_and_control_retained(self):
        calls = len(self.reply_model.seen_calls)
        for record in self.records:
            self.assertNotEqual(self.backend.request(self.evidence_path(record["contact"], record["turn"]))[0], 200)
            self.assertNotEqual(self.backend.request(record["versions_path"])[0], 200)
            current = self._get(self.backend, record["path"])
            self.assertTrue(all(turn["state"] == "redacted" and turn["reply"] is None for turn in current["turns"]))
            for body in (record["body"], record["prepared"]):
                self.assertNotEqual(self.backend.request(record["path"] + "/replies", body)[0], 200)
            for carry in record["carries"]:
                child = self._get(self.backend, carry["path"])
                self.assertEqual(child["inputs"][0]["state"], "redacted")
                self.assertIsNone(child["inputs"][0]["content"])
                self.assertNotEqual(self.backend.request(record["path"] + "/new-with-candidate", carry["command"])[0], 200)
                if "turn" in carry:
                    self.assertNotEqual(self.backend.request(self.evidence_path(record["contact"], carry["turn"]))[0], 200)
                    self.assertNotEqual(self.backend.request(carry["path"] + "/replies", carry["body"])[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)
        control = self.control
        self.assertEqual(self._get(self.backend, self.evidence_path(control["contact"], control["turn"])), control["saved"])
        self.assertEqual(self._get(self.backend, control["versions_path"]), control["history"])
        for carry in control["carries"]:
            self.assertIsNotNone(self._get(self.backend, carry["path"])["inputs"][0]["content"])
            if "turn" in carry:
                self.assertEqual(self._get(self.backend, self.evidence_path(control["contact"], carry["turn"])), carry["saved"])

    def reopen_and_refresh(self, *, fact, kind):
        current = self._get(self.management, self.owner_path)["layered_memory"]
        for action in ("refresh", "disable", "enable", "refresh"):
            command = {"settings_generation": current["settings_generation"]}
            if action == "enable":
                command["purpose_confirmed"] = True
            status, result = self.management.request(self.owner_path + "/" + action, command)
            self.assertEqual(status, 200, result)
            current = result["layered_memory"]
            self.assertEqual(current["pending_fact_count"], 1 if fact else 0)
            if fact:
                self.assertNotIn(self.target["memory_id"], str(current["scenarios"]))
                self.assertNotIn(self.target["memory_id"], str(current["profile"]))
            else:
                self.assertGreaterEqual(current["protected_count"], 1)
                self.assertNotIn(self.target["text"], str(current["scenarios"] if kind == "scenario" else current["profile"]))
            self.assertNotIn(self.ready["profile"]["version_id"], str(current["profile"]))
        current = self.settled_organization()
        self.assertIn(self.independent["memory_id"], str(current["scenarios"]))
        return current

    def settled_organization(self):
        # 实际通知Worker可能已领取；有界读取等待权威状态，不对active工作误发continue。
        tick = Event()
        for _ in range(30):
            current = self._get(self.management, self.owner_path)["layered_memory"]
            if current["status"] != "updating":
                return current
            tick.wait(0.2)
        self.fail({"message": "本人整理未在有界读取内完成", "state": current})

    def complete_control_prepare(self):
        before = len(self.reply_model.seen_calls)
        self.reply_model.plans.append({"text": "签收回执保持独立。", "basis": "当前草稿。"})
        status, turn = self.backend.request(self.control["path"] + "/replies", self.control["prepared"])
        self.assertEqual(status, 200, turn)
        self.assertEqual(len(self.reply_model.seen_calls), before + 1)
        actual = str([message.content for message in self.reply_model.seen_calls[-1]])
        for forbidden in (self.target["memory_id"], self.scenario["version_id"], self.ready["profile"]["version_id"]):
            self.assertNotIn(forbidden, actual)

    def test_owner_scenario_summary_error_cleans_both_contacts_and_preserves_independent_content(self):
        self.prepare_records()
        current, _ = self.report("scenario")
        self.assert_prepared_erased_before_read()
        self.assertEqual(current["scenarios"], [self.independent_scenario])
        if current["profile"] is not None:
            self.assertNotEqual(current["profile"]["version_id"], self.ready["profile"]["version_id"])
            self.assertEqual({reference["memory_id"] for item in current["profile"]["entries"]
                              for reference in item["references"]}, {self.independent["memory_id"]})
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], self.owner_before)
        self.assert_erased_and_control_retained()
        self.backend = self._backend(self.owner_id)
        self.assert_erased_and_control_retained()
        self.reopen_and_refresh(fact=False, kind="scenario")
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], self.owner_before)
        self.assert_erased_and_control_retained()
        self.complete_control_prepare()

    def test_owner_profile_summary_error_cleans_both_contacts_and_preserves_scenarios(self):
        self.prepare_records()
        current, _ = self.report("profile")
        self.assert_prepared_erased_before_read()
        self.assertEqual(current["scenarios"], self.ready["scenarios"])
        if current["profile"] is not None:
            self.assertNotEqual(current["profile"]["version_id"], self.ready["profile"]["version_id"])
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], self.owner_before)
        self.assert_erased_and_control_retained()
        self.backend = self._backend(self.owner_id)
        self.assert_erased_and_control_retained()
        self.reopen_and_refresh(fact=False, kind="profile")
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], self.owner_before)
        self.assert_erased_and_control_retained()
        self.complete_control_prepare()

    def assert_fact_correction(self, kind):
        self.prepare_records()
        wrong = {**self._target_command(self.ready, kind, self.target["memory_id"]),
                 "memory_id": self.independent["memory_id"]}
        before = self._get(self.management, self.owner_path)["layered_memory"]
        self.assertEqual(self.management.request(self.owner_path + "/fact-error", wrong)[0], 409)
        self.assertEqual(self._get(self.management, self.owner_path)["layered_memory"], before)
        current, command = self.report(kind, fact=True)
        self.assert_prepared_erased_before_read()
        expected = {"memory_id": self.target["memory_id"], "revision": self.target["revision"]}
        self.assertEqual(current["correction_target"], expected)
        self.assertEqual(current["pending_fact_count"], 1)
        self.assertEqual(current["scenarios"], [self.independent_scenario])
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], self.owner_before)
        status, replayed = self.management.request(self.owner_path + "/fact-error", command)
        self.assertEqual(status, 200, replayed)
        self.assertEqual(replayed["layered_memory"]["correction_target"], expected)
        self.assert_erased_and_control_retained()
        self.backend = self._backend(self.owner_id)
        self.assert_erased_and_control_retained()
        current = self.reopen_and_refresh(fact=True, kind=kind)
        self.assertEqual(self.management.request(self.owner_path + "/fact-error", command)[0], 409)
        replacement = "本人只完成了合成课程的基础部分。"
        status, result = self.backend.request("/api/memories/owner/" + self.target["memory_id"] + "/correct", {
            "text": replacement, "revision": self.target["revision"], "category": "common_fact"})
        self.assertEqual(status, 200, result)
        corrected = result["memory"]
        self.assertNotEqual(corrected["memory_id"], self.target["memory_id"])
        self.assertEqual(corrected["supersedes_memory_id"], self.target["memory_id"])
        self.assertEqual(corrected["revision"], self.target["revision"] + 1)
        self.assertEqual(corrected["text"], replacement)
        memories = self._get(self.backend, "/api/memories/owner")["memories"]
        self.assertEqual([memory for memory in memories if memory["memory_id"] != corrected["memory_id"]],
                         [memory for memory in self.owner_before if memory["memory_id"] != self.target["memory_id"]])
        status, refreshed = self.management.request(self.owner_path + "/refresh", {
            "settings_generation": current["settings_generation"]})
        self.assertEqual(status, 200, refreshed)
        current = self.settled_organization()
        if current["remaining_count"]:
            status, refreshed = self.management.request(self.owner_path + "/continue", {
                "settings_generation": current["settings_generation"], "work_revision": current["work_revision"]})
            self.assertEqual(status, 200, {"result": refreshed, "prior": current})
            current = self.settled_organization()
        self.assertEqual(current["pending_fact_count"], 0)
        self.assertIn(corrected["memory_id"], str(current["scenarios"]))
        self.assertIn(self.independent["memory_id"], str(current["scenarios"]))
        self.assertNotIn(self.target["memory_id"], str(current["scenarios"]))
        self.assertNotIn(self.target["memory_id"], str(current["profile"]))
        self.assertNotIn(self.scenario["version_id"], str(current["scenarios"]))
        self.assert_erased_and_control_retained()
        self.backend = self._backend(self.owner_id)
        self.assert_erased_and_control_retained()
        self.complete_control_prepare()

    def test_owner_scenario_fact_error_cleans_usage_before_exact_l1_save_and_rebuilds_legally(self):
        self.assert_fact_correction("scenario")

    def test_owner_profile_fact_error_cleans_usage_before_exact_l1_save_and_rebuilds_legally(self):
        self.assert_fact_correction("profile")

    def assert_late_result_rejected(self, kind, *, fact, stage):
        from notalone.persistence.reply_store import PostgresReplyStore

        self.prepare_owner()
        entered, release = Event(), Event()
        observed = {}
        service = self.service

        def wait_at_boundary():
            entered.set()
            if not release.wait(10):
                observed["timed_out"] = True
                raise TimeoutError("本人纠错的有限运行边界未释放。")

        if stage == "tool":
            class ReadBarrier:
                def __getattr__(self, name):
                    return getattr(service, name)

                def read_scenario(self, snapshot, identifier, span):
                    result = service.read_scenario(snapshot, identifier, span)
                    observed["document"] = result
                    wait_at_boundary()
                    return result

            self.layered_reply_options["layered_memory"] = ReadBarrier()
            self.backend = self._backend(self.owner_id)
        else:
            class WriterBarrier(PostgresReplyStore):
                def save(self, request, context, reply):
                    observed["profile"] = context.owner_layered_context.to_payload() if context.owner_layered_context else None
                    observed["reads"] = context.owner_layered_scenario_reads
                    wait_at_boundary()
                    return super().save(request, context, reply)

            store = WriterBarrier(self.database_url, layered_memory=self.service,
                layered_budget=self.layered_reply_options["layered_reply_budget"],
                owner_layered_budget=self.layered_reply_options["owner_layered_reply_budget"])
            with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
                self.backend = self._backend(self.owner_id)
        self.reply_model.plans.extend([
            {"history": {"name": "read_scenario", "args": {
                "scenario_id": self.scenario["scenario_id"], "paragraph_index": 0}}},
            {"text": "纠错后不得落库的迟到候选。", "basis": "旧本人主题正文。"},
        ])
        body = self.rewrite_body(self.contacts[0], "请聊聊合成课程。")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, self.paths[0] + "/replies", body, timeout=30)
            try:
                self.assertTrue(entered.wait(8), observed)
                self.report(kind, fact=fact)
                if fact:
                    status, corrected = self.backend.request("/api/memories/owner/" + self.target["memory_id"] + "/correct", {
                        "text": "本人只完成了合成课程的基础部分。", "revision": self.target["revision"]})
                    self.assertEqual(status, 200, corrected)
            finally:
                release.set()
            status, result = pending.result(timeout=30)
        # 所有断言在调用栈外执行，业务错误处理不能吞掉gate中的测试断言。
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("timed_out", observed)
        self.assertEqual(len(self.reply_model.seen_calls), 1 if stage == "tool" else 2)
        if stage == "tool":
            self.assertEqual(observed["document"]["version_id"], self.scenario["version_id"])
        else:
            self.assertEqual(observed["profile"]["profile_version_id"], self.ready["profile"]["version_id"])
            self.assertEqual(observed["reads"][0]["document"]["version_id"], self.scenario["version_id"])
        calls = len(self.reply_model.seen_calls)
        self.assertNotIn("纠错后不得落库的迟到候选", str(self._get(self.backend, self.paths[0])))
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(self.paths[0] + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

    def test_owner_scenario_summary_after_tool_read_blocks_next_actual_send(self):
        self.assert_late_result_rejected("scenario", fact=False, stage="tool")

    def test_owner_scenario_summary_before_writer_blocks_late_commit(self):
        self.assert_late_result_rejected("scenario", fact=False, stage="writer")

    def test_owner_profile_summary_after_tool_read_blocks_next_actual_send(self):
        self.assert_late_result_rejected("profile", fact=False, stage="tool")

    def test_owner_profile_summary_before_writer_blocks_late_commit(self):
        self.assert_late_result_rejected("profile", fact=False, stage="writer")

    def test_owner_scenario_fact_correction_after_tool_read_blocks_next_actual_send(self):
        self.assert_late_result_rejected("scenario", fact=True, stage="tool")

    def test_owner_scenario_fact_correction_before_writer_blocks_late_commit(self):
        self.assert_late_result_rejected("scenario", fact=True, stage="writer")

    def test_owner_profile_fact_correction_after_tool_read_blocks_next_actual_send(self):
        self.assert_late_result_rejected("profile", fact=True, stage="tool")

    def test_owner_profile_fact_correction_before_writer_blocks_late_commit(self):
        self.assert_late_result_rejected("profile", fact=True, stage="writer")
