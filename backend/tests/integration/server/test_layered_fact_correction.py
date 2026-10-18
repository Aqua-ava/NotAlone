"""事实纠错在保存底层修正之前就撤下同一事实的派生资料。"""

import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.memory.layered import OrganizationBudget
from notalone.memory.models import FactSubject
from notalone.scopes import ContactScope, OwnerScope
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_correction_matrix as matrix_support
from tests.integration.server import test_layered_profile_management as profiles
from tests.integration.server import test_layered_correction_concurrency as adapters
from tests.integration.server import test_owner_memory_overview as owner_support


class LayeredFactCorrectionHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    _prepare_scope = matrix_support.LayeredCorrectionMatrixHttpTest._prepare_scope
    _target_command = matrix_support.LayeredCorrectionMatrixHttpTest._target_command

    def _prepare_independent_batches(self, scope_kind):
        owner = scope_kind == "owner"
        fields = {}
        if owner:
            path, memories, manual = "/api/memories/owner/layered-memory", "/api/memories/owner", "/api/memories/manual-owner"
        else:
            status, result = self.backend.request("/api/contacts", {
                "request_id": str(uuid4()), "display_name": "分批事实纠错合成联系人"})
            self.assertEqual(status, 201, result)
            fields["contact_id"] = result["contact"]["contact_id"]
            memories = f"/api/contacts/{fields['contact_id']}/memories"
            path, manual = f"/api/contacts/{fields['contact_id']}/layered-memory", "/api/memories/manual-contact"
        status, result = self.backend.request(manual, {
            **fields, "text": "独立合成运动背景。", "category": "common_fact"})
        self.assertEqual(status, 200, result)
        independent = result["memory"]
        backend = profiles.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=adapters._Proposal(), scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification(),
            budget=OrganizationBudget(max_memories=1, max_model_calls=4, max_characters=12000))
        self.assertEqual(backend.request(path + "/enable", {
            "settings_generation": 0, "purpose_confirmed": True})[0], 200)
        status, result = self.backend.request(manual, {
            **fields, "text": "需要修正的合成课程事实。", "category": "common_fact"})
        self.assertEqual(status, 200, result)
        primary = result["memory"]
        status, result = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(len(result["layered_memory"]["scenarios"]), 2, result)
        return backend, path, memories, result["layered_memory"], primary, independent

    def _profile_fact_error_retracts_same_fact_scenario(self, scope_kind, *, independent=False):
        prepare = self._prepare_independent_batches if independent else self._prepare_scope
        backend, path, _, ready, primary, unrelated = prepare(scope_kind)
        scope = (OwnerScope(self.owner_id) if scope_kind == "owner" else
            ContactScope(self.owner_id, UUID(path.split("/")[3])))
        before = self.service.capture(scope)
        affected = next(doc for doc in ready["scenarios"] if any(
            ref["memory_id"] == primary["memory_id"] for item in doc["paragraphs"]
            for ref in item["references"]))
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        status, result = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, result)
        self.assertFalse(self.service.validate(before))
        current = self._get(backend, path)["layered_memory"]
        self.assertNotIn(affected["version_id"], [doc["version_id"] for doc in current["scenarios"]],
            "画像所报错误的同一事实不能继续留在主题资料中")
        self.assertIsNone(current["profile"])
        snapshot = self.service.capture(scope)
        if independent:
            kept = next(doc for doc in ready["scenarios"] if doc != affected)
            self.assertEqual(current["scenarios"], [kept])
            self.assertEqual(self.service.read_scenario(snapshot, UUID(kept["scenario_id"]), (0, 1))["paragraphs"], kept["paragraphs"])
        else:
            self.assertEqual(current["scenarios"], [], "同批未直接引用错误事实的主题仍实际读过该输入")
            self.assertIsNone(snapshot)

    def test_contact_profile_fact_error_retracts_same_fact_scenario_before_l1_save(self):
        self._profile_fact_error_retracts_same_fact_scenario("contact")

    def test_owner_profile_fact_error_retracts_actual_input_closure_before_l1_save(self):
        self._profile_fact_error_retracts_same_fact_scenario("owner")

    def test_contact_fact_error_keeps_a_truly_independent_prior_batch(self):
        self._profile_fact_error_retracts_same_fact_scenario("contact", independent=True)

    def test_owner_fact_error_keeps_a_truly_independent_prior_batch(self):
        self._profile_fact_error_retracts_same_fact_scenario("owner", independent=True)

    def test_profile_fact_error_denies_same_fact_through_public_port(self):
        backend, path, _, ready, primary, _ = self._prepare_independent_batches("contact")
        affected = next(doc for doc in ready["scenarios"] if any(
            ref["memory_id"] == primary["memory_id"] for item in doc["paragraphs"]
            for ref in item["references"]))
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(path.split("/")[3])))
        with self.assertRaises(PermissionError):
            self.service.read_scenario(snapshot, UUID(affected["scenario_id"]), (0, 1))

    def test_fact_error_refresh_cannot_republish_the_pending_fact(self):
        backend, path, _, ready, primary, _ = self._prepare_scope("contact")
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        status, result = backend.request(path + "/refresh", {
            "settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, result)
        current = result["layered_memory"]
        references = [ref["memory_id"] for doc in current["scenarios"]
            for item in doc["paragraphs"] for ref in item["references"]]
        references.extend(ref["memory_id"] for item in (current["profile"] or {}).get("entries", [])
            for ref in item["references"])
        self.assertNotIn(primary["memory_id"], references,
            "等待用户保存底层修正期间，刷新不能用原事实重建派生正文")

    def test_fact_error_replay_recovers_the_exact_pending_leaf(self):
        backend, path, _, ready, primary, _ = self._prepare_scope("contact")
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        status, result = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, result)
        target = result["layered_memory"]["correction_target"]
        status, result = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, "首次响应丢失后重发同一命令应恢复精确底层入口")
        self.assertEqual(result["layered_memory"]["correction_target"], target)

    def _pending_fact_survives_reopen_until_exact_leaf_is_corrected(self, scope_kind):
        backend, path, memories, ready, primary, _ = self._prepare_independent_batches(scope_kind)
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        # 新服务与HTTP实例只复用持久资料，不继承内存中的点击目标。
        backend = profiles.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=adapters._Proposal(), scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification(),
            budget=OrganizationBudget(max_memories=1, max_model_calls=4, max_characters=12000))
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        status, disabled = backend.request(path + "/disable", {"settings_generation": 1})
        self.assertEqual(status, 200, disabled)
        status, enabled = backend.request(path + "/enable", {
            "settings_generation": disabled["layered_memory"]["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, enabled)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409)
        current = enabled["layered_memory"]
        self.assertNotIn(primary["memory_id"], str(current["scenarios"]))
        self.assertNotIn(primary["memory_id"], str(current["profile"]))
        status, corrected = self.backend.request(f"{memories}/{primary['memory_id']}/correct", {
            "revision": primary["revision"], "text": "用户明确修正后的合成课程事实。", "category": "common_fact"})
        self.assertEqual(status, 200, corrected)
        status, refreshed = backend.request(path + "/refresh", {
            "settings_generation": current["settings_generation"]})
        self.assertEqual(status, 200, refreshed)
        if refreshed["layered_memory"]["remaining_count"]:
            status, refreshed = backend.request(path + "/continue", {
                "settings_generation": current["settings_generation"],
                "work_revision": refreshed["layered_memory"]["work_revision"]})
            self.assertEqual(status, 200, refreshed)
        self.assertIn(corrected["memory"]["memory_id"], str(refreshed["layered_memory"]["scenarios"]))
        self.assertEqual(refreshed["layered_memory"]["pending_fact_count"], 0)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409)
        self.assertEqual(refreshed["layered_memory"]["feedback"], [])

    def test_contact_pending_fact_survives_restore_and_reopen_until_l1_correction(self):
        self._pending_fact_survives_reopen_until_exact_leaf_is_corrected("contact")

    def test_owner_pending_fact_survives_restore_and_reopen_until_l1_correction(self):
        self._pending_fact_survives_reopen_until_exact_leaf_is_corrected("owner")

    def _delete_pending_manual_leaf(self, scope_kind):
        backend, path, memories, ready, primary, _ = self._prepare_scope(scope_kind)
        command = {**self._target_command(ready, "profile", primary["memory_id"]),
            "memory_id": primary["memory_id"]}
        status, result = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, result)
        revision = result["layered_memory"]["correction_revision"]
        self.assertEqual(self.backend.request(f"{memories}/{primary['memory_id']}/delete", {})[0], 200)
        erased = self._get(backend, path)["layered_memory"]
        self.assertGreater(erased["correction_revision"], revision)
        self.assertEqual(erased["protected_count"], 0)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409)

    def test_contact_deleted_pending_leaf_erases_receipt_and_advances_revision(self):
        self._delete_pending_manual_leaf("contact")

    def test_owner_deleted_pending_leaf_erases_receipt_and_advances_revision(self):
        self._delete_pending_manual_leaf("owner")

    def _source_erasure_invalidates_receipt_without_releasing_a_live_canonical_leaf(self, scope_kind):
        if scope_kind == "owner":
            contact, source, message = owner_support.OwnerMemoryOverviewHttpTest.import_self(
                self, "本人待修正的合成课程事实。")
            memory = self.confirm(contact, "本人待修正的合成课程事实。", message, subject=FactSubject.SELF)
            path = "/api/memories/owner/layered-memory"
        else:
            contact, source, message = self.import_contact("待修正的合成课程依据。")
            memory = self.confirm(contact, "双方待修正的合成课程事实。", message)
            path = f"/api/contacts/{contact}/layered-memory"
        alias = uuid4()
        # 复用既有多来源合成装配；管理与删除观察均穿过公开HTTP。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES(%s,%s,%s,'wechat_jsonl','synthetic-fact-alias.jsonl',%s,1)",
                (alias, self.owner_id, contact, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES(%s,%s,%s,'source_document',%s,'synthetic:fact-alias','{}'::jsonb)",
                (message, self.owner_id, contact, alias))
        proposal = adapters._Proposal()
        backend = profiles.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=proposal, scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification())
        status, result = backend.request(path + "/enable", {"settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        ready = result["layered_memory"]
        command = {**self._target_command(ready, "profile", memory["memory_id"]), "memory_id": memory["memory_id"]}
        status, result = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, result)
        revision = result["layered_memory"]["correction_revision"]
        status, result = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, result)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409)
        self.delete_source(contact, source)
        status, result = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        current = result["layered_memory"]
        self.assertEqual(current["pending_fact_count"], 1, "同一规范消息仍有合法来源时，原叶继续等待修正")
        self.assertEqual(current["scenarios"], [])
        self.assertIsNone(current["profile"])
        self.assertEqual(len(proposal.inputs), 1)
        self.assertGreater(current["correction_revision"], revision)
        revision = current["correction_revision"]
        self.delete_source(contact, str(alias))
        erased = self._get(backend, path)["layered_memory"]
        self.assertEqual(erased["protected_count"], 0)
        self.assertEqual(erased["pending_fact_count"], 0)
        self.assertGreater(erased["correction_revision"], revision)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409)

    def test_contact_two_stage_source_erasure_preserves_only_the_legal_pending_leaf(self):
        self._source_erasure_invalidates_receipt_without_releasing_a_live_canonical_leaf("contact")

    def test_owner_two_stage_source_erasure_preserves_only_the_legal_pending_leaf(self):
        self._source_erasure_invalidates_receipt_without_releasing_a_live_canonical_leaf("owner")

    def _unrelated_manual_update_does_not_erase_the_pending_receipt(self, scope_kind):
        backend, path, memories, ready, primary, unrelated = self._prepare_scope(scope_kind)
        command = {**self._target_command(ready, "profile", primary["memory_id"]), "memory_id": primary["memory_id"]}
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        self.assertEqual(self.backend.request(f"{memories}/{unrelated['memory_id']}/correct", {
            "revision": unrelated["revision"], "text": "另一条手录事实的当前合成版本。", "category": "common_fact"})[0], 200)
        status, replay = backend.request(path + "/fact-error", command)
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay["layered_memory"]["correction_target"], {
            "memory_id": primary["memory_id"], "revision": primary["revision"]})

    def test_contact_unrelated_manual_update_keeps_pending_receipt(self):
        self._unrelated_manual_update_does_not_erase_the_pending_receipt("contact")

    def test_owner_unrelated_manual_update_keeps_pending_receipt(self):
        self._unrelated_manual_update_does_not_erase_the_pending_receipt("owner")
