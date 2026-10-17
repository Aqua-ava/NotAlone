"""共享原始来源贯穿记忆、回复与 Skill 演进的公开 HTTP 组合验收。"""

import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.application.source_service import SourceService
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from tests.integration.persistence.concurrency import wait_for_blocked_operations
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_skill_evolution_models import EvolutionMemoryModel
from tests.integration.server.memory_skill_evolution_support import EvolutionHttpSupport


class MemorySkillEvolutionHttpTest(EvolutionHttpSupport, CoreBusinessFlowFixture, unittest.TestCase):
    def test_legal_grounded_upgrade_precedes_manual_decisions_and_source_delete_erases_it(self):
        state = self.prepare_evolution()
        self.assertIn("legal_upgrade", state.keys())
        self.assertEqual(state["legal_upgrade"]["batches"][0]["state"], "applied")
        # 后续人工纠错可撤下同窗口候选；本次落地证据固定在人工动作之前。
        candidate = state["legal_candidate"]
        self.assertEqual(candidate["status"], "pending")
        self.assertEqual(candidate["source_ids"], [state["latent_message_id"]])
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assert_evolution_deleted(state)

    def test_shared_source_reaches_updated_memories_actual_reply_and_pending_skill(self):
        state = self.prepare_evolution()
        contact = self._get(self.backend, f"/api/contacts/{self.contact_id}/relationship-overview")["overview"]
        owner = self._get(self.backend, "/api/memories/owner/overview")["overview"]
        for overview, key in ((contact, "contact_memory"), (owner, "owner_memory")):
            entry = next(item for item in overview["entries"] if item["memory"]["memory_id"] == state[key]["memory_id"])
            self.assertEqual(entry["memory"]["text"], state[key]["text"])
            self.assertIn(state["source_id"], {ref["source_id"] for ref in entry["provenance"]["references"]})
        materials = state["draft"]["private_evidence"]["materials"]
        identities = {item["material_id"] for item in materials}
        self.assertIn(state["edited_version"]["version_id"], identities)
        self.assertIn(state["selection"]["selection_id"], identities)
        selection = next(item for item in materials if item["kind"] == "candidate_selection")
        self.assertEqual(selection["content"]["sending_status"], "unknown")
        self.assertIn(state["material_id"], {item["material_id"] for item in materials})
        self.assertIn(state["source_id"], state["draft"]["private_evidence"]["source_dependencies"])
        self.assertEqual(state["draft"]["status"], "pending")
        self.assertEqual([item["skill_id"] for item in self._get(self.backend, "/api/skills")["skills"]],
                         [state["independent_skill_id"]])
        self.assertEqual(self.other_backend.request(state["draft_path"])[0], 404)

    def test_shared_source_publication_feedback_upgrade_restart_and_physical_deletion(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        published = self.publish_evolution(state)
        policy = self.stop_evolution_method(state)
        reply = self.evolution_reply(state, published["version_id"])
        self.assertEqual(len(reply["used_skill"]["execution_view"]["method_ids"]), 1)
        self.assertEqual(reply["used_skill"]["execution_view"]["policy_revision"], policy["revision"])
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        for extra in ({"scene": "其他场景"}, {"other": True}):
            self.evolution_reply(state, published["version_id"], **extra)
            self.assertIn("合成排除方法甲", str(self._last_evolution_generation_messages()))

        authority_before_upgrade = self._evolution_authority()
        prepared, prepare_command = self._prepare(limit=20, size=20, calls=12)
        job = self._wait(prepared)
        self.assertEqual(self._evolution_authority(), authority_before_upgrade)
        self.assertEqual(len(job["batches"]), 1)
        comparison = job["batches"][0]["comparison"]
        self.assertIn(state["contact_memory"]["memory_id"], {item["memory_id"] for item in comparison["current"]})
        self.assertGreater(comparison["stats"]["skipped_deleted"], 0)
        self.assertEqual(comparison["actions"], [], "旧窗口含未知纠错含义，不能把它伪装成新证据。")
        self.assertEqual(self.backend.request("/api/memory-upgrades", prepare_command)[1]["job_id"], job["job_id"])
        self.assertEqual(self.other_backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}")[0], 404)
        (status, _), approval = self._action(job, "apply")
        self.assertEqual(status, 200)
        applied = self._wait(job, states=("applied",))
        self.assertEqual(self._evolution_authority(), authority_before_upgrade)
        state["upgrade_jobs"].append(applied)
        self.assertEqual(self.backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}", approval)[0], 200)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self._wait(job, states=("applied",))["batches"], applied["batches"])
        self.evolution_reply(state, published["version_id"])
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state, applied)
        self._delete_source(state["source_id"])
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assert_evolution_deleted(state, applied)
        self.assertEqual(self.backend.request(state["draft_path"] + "/approve", state["approve_command"])[0], 409)
        job_path = f"/api/memory-upgrades/{job['job_id']}?{self._query()}"
        calls = len(self.extraction_model.seen_calls)
        status, replayed = self.backend.request(job_path, approval)
        self.assertEqual(status, 200)
        self.assertIsNone(replayed["batches"][0]["comparison"])
        self.assertEqual(len(self.extraction_model.seen_calls), calls)
        self.assertEqual(self.backend.request(job_path, {**approval, "operation_key": str(uuid4())})[0], 409)
        (status, _), _ = self._action(replayed, "delete")
        self.assertEqual(status, 200)
        self.assertEqual(self.backend.request(job_path)[0], 410)

    def test_same_task_reviewed_update_conflict_and_rollback_preserve_method_stop_then_delete(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        first = self.publish_evolution(state)
        self.stop_evolution_method(state)
        self.evolution_reply(state, first["version_id"])
        draft = self.propose_evolution_update(state)
        history_path = self.path + "/skills/" + first["skill_id"]
        self.assertEqual(self._get(self.backend, history_path)["current_version_id"], first["version_id"])
        compared, _ = self._compare(state["draft_path"], draft, kind="owner")
        strategy = compared["sanitized_strategy"]
        editable = {key: strategy[key] for key in ("name", "description", "scene")}
        editable["methods"] = [
            {key: method[key] for key in ("key", "title", "instruction", "replaces_method_ids")}
            for method in strategy["methods"]
        ]
        editable["methods"][1]["instruction"] += " 先让用户核对自己的边界。"
        changed = self._ok(state["draft_path"] + "/edit", {
            "expected_revision": compared["revision"], "operation_key": str(uuid4()), "strategy": editable,
        })["draft"]
        self.assertIsNone(changed["comparison"])
        self.assertEqual(self.backend.request(state["draft_path"] + "/approve", {
            "expected_revision": compared["revision"], "operation_key": str(uuid4()),
            "comparison_id": compared["comparison"]["comparison_id"], "scope": compared["comparison"]["scope"],
            "confirmed": True, "replacements_confirmed": True,
        })[0], 409)
        state["draft"] = changed
        second = self.publish_evolution(state)
        self.assertEqual((second["skill_id"], second["version_number"]), (first["skill_id"], 2))
        self.evolution_reply(state, second["version_id"])
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        history = self._get(self.backend, history_path)
        rollback = {"version_id": first["version_id"], "expected_revision": history["revision"],
                    "expected_current_version_id": second["version_id"], "operation_key": str(uuid4())}
        restored = self._ok(history_path + "/rollback", rollback)
        self.assertEqual(restored["current_version_id"], first["version_id"])
        self.assertEqual(self._ok(history_path + "/rollback", rollback), restored)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.evolution_reply(state, first["version_id"])
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)
        self.assertIn(self.backend.request(history_path + "/rollback", rollback)[0], (404, 409))

    def test_workflow_deleted_before_same_source_preserves_published_policy_until_source_erasure(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        published = self.publish_evolution(state)
        self.stop_evolution_method(state)
        prepared, _ = self._prepare(limit=20, size=20, calls=12)
        job = self._wait(prepared)
        (status, _), command = self._action(job, "delete")
        self.assertEqual(status, 200)
        self._assert_workflow_erased(job)
        job_path = f"/api/memory-upgrades/{job['job_id']}?{self._query()}"
        self.assertEqual(self.backend.request(job_path, command, method="DELETE")[0], 200)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self.backend.request(job_path)[0], 410)
        self.evolution_reply(state, published["version_id"])
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state, job)

    def test_rollback_commits_before_waiting_source_deletion_without_restoring_erased_versions(self):
        self._assert_rollback_delete_race(source_first=False)

    def test_source_deletion_commits_before_waiting_fresh_rollback_with_valid_version_parameters(self):
        self._assert_rollback_delete_race(source_first=True)

    def _assert_rollback_delete_race(self, *, source_first):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        first = self.publish_evolution(state)
        self.stop_evolution_method(state)
        self.propose_evolution_update(state)
        second = self.publish_evolution(state)
        history_path = self.path + "/skills/" + first["skill_id"]
        history = self._get(self.backend, history_path)
        command = {"version_id": first["version_id"], "expected_revision": history["revision"],
                   "expected_current_version_id": second["version_id"], "operation_key": str(uuid4())}
        entered, release = threading.Event(), threading.Event()
        holder = []

        def hold(connection):
            holder.append(connection.info.backend_pid)
            entered.set()
            if not release.wait(10):
                raise TimeoutError("合成回滚与删除事务未在限定时间内解除暂停。")

        if source_first:
            original = PostgresSourceDeletionRepository.cancel_import_tasks

            def held_cancel(connection, **kwargs):
                # request_delete 已更新来源状态，仍持有实际事务锁且尚未提交。
                hold(connection)
                return original(connection, **kwargs)

            gate = patch.object(PostgresSourceDeletionRepository, "cancel_import_tasks", side_effect=held_cancel)
        else:
            original = PostgresSkillLibrary.rollback_locked

            def held_rollback(library, connection, *args, **kwargs):
                # HTTP 已读取合法历史和修订，实际回滚仍在同一持锁事务中。
                hold(connection)
                return original(library, connection, *args, **kwargs)

            gate = patch.object(PostgresSkillLibrary, "rollback_locked", held_rollback)

        delete_path = f"/api/contacts/{self.contact_id}/sources/{state['source_id']}"
        with patch.object(SourceService, "_start", return_value=None), gate, ThreadPoolExecutor(max_workers=2) as pool:
            operations = [lambda: self.backend.request(delete_path, method="DELETE"),
                          lambda: self.backend.request(history_path + "/rollback", command)]
            first_index = 0 if source_first else 1
            leading = pool.submit(operations[first_index])
            try:
                self.assertTrue(entered.wait(5))
                waiting = pool.submit(operations[1 - first_index])
                wait_for_blocked_operations(self.database_url, set(holder), 1)
                self.assertFalse(waiting.done(), "第二个真实HTTP事务须确实等待第一个事务的数据库锁。")
            finally:
                release.set()
            leading_result, waiting_result = leading.result(timeout=10), waiting.result(timeout=10)
        deleted, rolled_back = ((leading_result, waiting_result) if source_first else (waiting_result, leading_result))
        self.assertEqual(deleted[0], 202, deleted)
        if source_first:
            self.assertIn(rolled_back[0], (404, 409), rolled_back)
        else:
            self.assertEqual(rolled_back[0], 200, rolled_back)
            self.assertEqual(rolled_back[1]["current_version_id"], first["version_id"])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT status FROM public.source_document WHERE id=%s",
                                                (state["source_id"],)).fetchone()[0], "delete_requested")
            # 删除请求事务已撤销发布权威；先行回滚的成功与回执仍在上面及下面独立核验。
            versions = connection.execute(
                "SELECT version.id::text,version.status,version.enabled,version.is_current,version.content "
                "FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id "
                "WHERE skill.owner_id=%s AND skill.id=%s AND version.id=ANY(%s::uuid[])",
                (self.owner_id, first["skill_id"], [first["version_id"], second["version_id"]]),
            ).fetchall()
            self.assertEqual({row[0]: row[1:] for row in versions}, {
                first["version_id"]: ("deleted", False, False, None),
                second["version_id"]: ("deleted", False, False, None),
            })
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_skill_version version "
                "JOIN public.reply_skill skill ON skill.id=version.skill_id "
                "WHERE skill.owner_id=%s AND skill.id=%s AND version.is_current",
                (self.owner_id, first["skill_id"]),
            ).fetchone()[0], 0)
            # _start暂停仅挡住后续物理删除；不能让排队时已撤活的版本重新成为current。
            self.assertGreater(connection.execute(
                "SELECT count(*) FROM public.message_source_ref "
                "WHERE owner_id=%s AND contact_id=%s AND source_document_id=%s",
                (self.owner_id, self.contact_id, state["source_id"]),
            ).fetchone()[0], 0)
            receipts = connection.execute("SELECT count(*) FROM public.skill_history_operation WHERE owner_id=%s "
                "AND contact_id=%s AND operation_key=%s", (self.owner_id, self.contact_id, command["operation_key"])).fetchone()[0]
            self.assertEqual(receipts, 0 if source_first else 1)
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assert_evolution_deleted(state)
        self.assertIn(self.backend.request(history_path + "/rollback", {**command, "operation_key": str(uuid4())})[0], (404, 409))

    def test_source_queued_during_review_cannot_save_late_comparison_or_publish_after_restart(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        compared, command = self._compare(state["draft_path"], state["draft"], kind="owner")
        with ThreadPoolExecutor(max_workers=1) as pool, self.hold_evolution_provider() as (entered, release):
            future = pool.submit(self.backend.request, state["draft_path"] + "/compare",
                                 {**command, "operation_key": str(uuid4())})
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.backend.request(
                f"/api/contacts/{self.contact_id}/sources/{state['source_id']}", method="DELETE",
            )[0], 202)
            release.set()
            self.assertNotEqual(future.result(timeout=10)[0], 200)
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assert_evolution_deleted(state)
        self.assertEqual(self.backend.request(state["draft_path"] + "/approve", {
            "expected_revision": compared["revision"], "operation_key": str(uuid4()),
            "comparison_id": compared["comparison"]["comparison_id"], "scope": compared["comparison"]["scope"],
            "confirmed": True, "replacements_confirmed": True,
        })[0], 409)

    def test_method_stop_after_actual_skill_read_rejects_late_candidate_and_retry_uses_filtered_view(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        published = self.publish_evolution(state)
        body = {**state["reply_body"], "idempotency_key": str(uuid4()),
                "skill_version_id": published["version_id"]}
        with ThreadPoolExecutor(max_workers=1) as pool, self.hold_evolution_provider(offset=2) as (entered, release):
            future = pool.submit(self.backend.request, state["session_path"] + "/replies", body)
            self.assertTrue(entered.wait(5), "须在实际读过Skill之后改变政策。")
            self.stop_evolution_method(state)
            release.set()
            self.assertNotEqual(future.result(timeout=10)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_candidate AS candidate JOIN public.reply_request AS request "
                "ON request.id=candidate.reply_request_id WHERE request.owner_id=%s AND request.idempotency_key=%s",
                (self.owner_id, body["idempotency_key"]),
            ).fetchone()[0], 0)
        retried = self._ok(state["session_path"] + "/replies", body)
        self.assertEqual(len(retried["used_skill"]["execution_view"]["method_ids"]), 1)
        self.assertNotIn("合成排除方法甲", str(self._last_evolution_generation_messages()))
        state.setdefault("dependent_replies", []).append({"reply": retried, "body": body,
            "path": state["session_path"], "evidence_path":
                f"/api/contacts/{self.contact_id}/replies/{retried['reply_request_id']}/evidence"})
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)

    def test_same_material_failure_retry_restart_keeps_task_identity_without_duplicate_draft(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        self.extraction_model.learning_proposals.append({"outcome": "no_change"})
        self._discussion(correction="合成新的纠正：保持事实和用户当前意愿。", target=state["target_message_id"])
        before = len(self.extraction_model.seen_calls)
        self.extraction_model.learning_failures_remaining = 3
        self.assertEqual(self._configure()[0][0], 200)
        failed = self._wait_learning(statuses=("failed",))
        self.assertEqual(len(self.extraction_model.seen_calls) - before, 3)
        self.assertEqual([item["draft_id"] for item in failed["drafts"]], [state["draft"]["draft_id"]])
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self.backend.request(self.path, {"resume": True})[0], 200)
        recovered = self._wait_learning()
        self.assertEqual(recovered["task"]["task_id"], failed["task"]["task_id"])
        self.assertEqual(recovered["recent_outcomes"][0], "no_change")
        self.assertEqual(len(self.extraction_model.seen_calls) - before, 4)
        self.assertEqual([item["draft_id"] for item in recovered["drafts"]], [state["draft"]["draft_id"]])
        self.assertEqual(self._configure(False)[0][0], 200)
        self._delete_source(state["source_id"])
        self.assert_evolution_deleted(state)

    def test_source_queued_during_new_learning_erases_old_draft_and_discards_late_proposal(self):
        state = self.prepare_evolution()
        self.assertEqual(self._configure(False)[0][0], 200)
        self.extraction_model.learning_proposals.append({"outcome": "no_change"})
        self._discussion(correction="合成后续纠正：新经验仍须核对来源。", target=state["target_message_id"])
        entered, release = threading.Event(), self.extraction_model.pause_next_response()
        original = EvolutionMemoryModel.wait_for_response

        def held(model):
            if len(model.seen_calls) in model.response_gates:
                entered.set()
            return original(model)

        try:
            with patch.object(EvolutionMemoryModel, "wait_for_response", held):
                self.assertEqual(self._configure()[0][0], 200)
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.backend.request(
                    f"/api/contacts/{self.contact_id}/sources/{state['source_id']}", method="DELETE",
                )[0], 202)
                release.set()
                self._delete_source(state["source_id"])
        finally:
            release.set()
        self.assert_evolution_deleted(state)
        calls = len(self.extraction_model.seen_calls)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self.backend.request(self.path, {"resume": True})[0], 200)
        self.assert_evolution_deleted(state)
        self.assertEqual(len(self.extraction_model.seen_calls), calls)
