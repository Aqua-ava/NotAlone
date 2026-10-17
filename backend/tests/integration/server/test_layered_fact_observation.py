"""观察与导入共用规范消息时，删除观察仍须清原请求身份及依赖。"""

import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.memory.models import FactSubject
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_profile_management as profiles
from tests.integration.server import test_layered_correction_matrix as matrix
from tests.integration.server import test_layered_correction_concurrency as adapters
from tests.integration.server import test_owner_memory_overview as owner_support


class LayeredFactObservationHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _observation_erasure_keeps_only_live_pending_constraint(self, scope_kind, *, ref_only=False):
        owner = scope_kind == "owner"
        if owner:
            contact, source, message = owner_support.OwnerMemoryOverviewHttpTest.import_self(self, "本人有合成课程事实。")
            path = "/api/memories/owner/layered-memory"
        else:
            contact, source, message = self.import_contact("合成课程事实依据。")
            path = f"/api/contacts/{contact}/layered-memory"
        contact_id = UUID(contact)
        binding = PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-fact-observation", conversation_locator=self.contact_locators[contact])
        observations = PostgresObservationStore(self.database_url)
        observed = observations.record_batch(owner_id=self.owner_id, contact_id=contact_id,
            binding_id=binding.binding_id, mode=ObservationMode.LIVE, cli_version="synthetic-cli",
            conversation_locator=self.contact_locators[contact], last_local_id=10,
            last_cursor="synthetic:10", record_count=1)
        reference = uuid4()
        # 只为合成规范消息装配双来源，不运行CLI或读取微信。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.message_source_ref "
                "(id,message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) "
                "VALUES(%s,%s,%s,%s,'local_wechat_observation',%s,'synthetic:10','{}'::jsonb)",
                (reference, message, self.owner_id, contact_id, observed.observation_id))
        memory = self.confirm(contact, "本人有合成课程事实。" if owner else "双方有合成课程事实。", message,
            **({"subject": FactSubject.SELF} if owner else {}))
        proposal = adapters._Proposal()
        backend = profiles.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=proposal, scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification())
        status, result = backend.request(path + "/enable", {"settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        ready = result["layered_memory"]
        command = {**matrix.LayeredCorrectionMatrixHttpTest._target_command(self, ready, "profile", memory["memory_id"]),
            "memory_id": memory["memory_id"]}
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200)
        unrelated = observations.record_batch(owner_id=self.owner_id, contact_id=contact_id,
            binding_id=binding.binding_id, mode=ObservationMode.LIVE, cli_version="synthetic-cli",
            conversation_locator=self.contact_locators[contact], since_local_id=10, last_local_id=20,
            last_cursor="synthetic:20", record_count=1)
        observations.delete_observation(owner_id=self.owner_id, contact_id=contact_id, observation_id=unrelated.observation_id)
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 200,
            "未参与原请求的观察删除不能破坏合法回执")
        if ref_only:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.message_source_ref WHERE owner_id=%s AND contact_id=%s AND id=%s",
                    (self.owner_id, contact_id, reference))
        else:
            observations.delete_observation(owner_id=self.owner_id, contact_id=contact_id, observation_id=observed.observation_id)
        messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
        self.assertIn(str(message), {item["message_id"] for item in messages})
        self.assertEqual(backend.request(path + "/fact-error", command)[0], 409,
            "被删观察参与的原请求不能凭仍活动的规范消息恢复回执")
        # 来源删除验收须覆盖私密身份；仅公开响应失效不等于删除闭包完成。
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("SELECT request_digest,dependency_ids,observation_ids,source_ref_ids FROM public.layered_memory_fact_correction "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (self.owner_id, None if owner else contact_id)).fetchall()
        self.assertEqual(rows, [(None, [], [], [])])
        status, result = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["layered_memory"]["pending_fact_count"], 1)
        self.assertEqual(result["layered_memory"]["scenarios"], [])
        self.assertIsNone(result["layered_memory"]["profile"])
        self.assertEqual(len(proposal.inputs), 1)
        revision = result["layered_memory"]["correction_revision"]
        self.delete_source(contact, source)
        erased = self._get(backend, path)["layered_memory"]
        self.assertEqual(erased["pending_fact_count"], 0)
        self.assertGreater(erased["correction_revision"], revision)

    def test_contact_observation_delete_erases_receipt_but_keeps_canonical_pending_leaf(self):
        self._observation_erasure_keeps_only_live_pending_constraint("contact")

    def test_owner_observation_delete_erases_receipt_but_keeps_canonical_pending_leaf(self):
        self._observation_erasure_keeps_only_live_pending_constraint("owner")

    def test_contact_original_ref_delete_erases_receipt_without_releasing_live_canonical(self):
        self._observation_erasure_keeps_only_live_pending_constraint("contact", ref_only=True)

    def test_owner_original_ref_delete_erases_receipt_without_releasing_live_canonical(self):
        self._observation_erasure_keeps_only_live_pending_constraint("owner", ref_only=True)
