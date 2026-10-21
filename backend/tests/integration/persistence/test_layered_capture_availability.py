"""无发布集合时捕获无需构建概览；已有集合仍逐次复验来源与设置。"""

from contextlib import contextmanager
import unittest
from unittest.mock import patch
from uuid import UUID

import psycopg

from notalone.memory.models import FactSubject
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.scopes import ContactScope, OwnerScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_profile_management as profile_support


class LayeredCaptureAvailabilityTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_unpublished_states_skip_overview_for_contact_and_owner(self):
        contact, _, _ = self.import_contact("尚无整理结果的合成来源。")
        store = PostgresLayeredMemoryStore(self.database_url)
        for scope in (ContactScope(self.owner_id, UUID(contact)), OwnerScope(self.owner_id)):
            method = "read_owner_in_transaction" if isinstance(scope, OwnerScope) else "read_contact_in_transaction"
            for state in (None, (False, "disabled"), (True, "failed"), (True, "stale"), (True, "ready")):
                with self.subTest(scope=type(scope).__name__, state=state):
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute("DELETE FROM public.layered_memory_state WHERE owner_id=%s "
                            "AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id, scope.contact_id))
                        if state is not None:
                            connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id,enabled,status) "
                                "VALUES(%s,%s,%s,%s)", (scope.owner_id, scope.contact_id, *state))
                            if state[1] == "ready":
                                connection.execute("INSERT INTO public.layered_memory_generation(owner_id,contact_id,"
                                    "organization_generation,schema_version,scenario_version_ids,dependency_ids) "
                                    "VALUES(%s,%s,0,2,'{}','{}')", (scope.owner_id, scope.contact_id))
                    with patch.object(store._overview, method, wraps=getattr(store._overview, method)) as overview:
                        self.assertIsNone(store.capture(scope))
                        self.assertEqual(overview.call_count, 0, "没有发布结果时不应全量复验底层概览")

    def _publish(self, *, owner_scope=False):
        contact, source, message = self.import_contact("对方共同参加合成课程。", owner_text="本人参加合成课程。")
        if owner_scope:
            messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
            message = UUID(next(row["message_id"] for row in messages if row["speaker"] == "user"))
        self.confirm(contact, "本人参加合成课程。" if owner_scope else "双方共同参加过合成课程。", message,
                     subject=FactSubject.SELF if owner_scope else FactSubject.CONTACT)
        backend = profile_support.LayeredProfileHttpTest.controlled(self)
        path = "/api/memories/owner/layered-memory" if owner_scope else f"/api/contacts/{contact}/layered-memory"
        status, result = backend.request(path + "/enable", {"settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["layered_memory"]["scenarios"])
        scope = OwnerScope(self.owner_id) if owner_scope else ContactScope(self.owner_id, UUID(contact))
        return scope, source

    def test_published_generations_still_validate_source_changes(self):
        for owner_scope in (False, True):
            with self.subTest(owner_scope=owner_scope):
                scope, source = self._publish(owner_scope=owner_scope)
                store = PostgresLayeredMemoryStore(self.database_url)
                method = "read_owner_in_transaction" if owner_scope else "read_contact_in_transaction"
                with patch.object(store._overview, method, wraps=getattr(store._overview, method)) as overview:
                    with patch.object(store, "validate_in_transaction",
                                      wraps=store.validate_in_transaction) as validate:
                        self.assertIsNotNone(store.capture(scope))
                        self.assertEqual(validate.call_count, 1)
                    self.assertGreater(overview.call_count, 0)
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute("UPDATE public.source_document SET content_sha256=repeat('f',64) "
                            "WHERE owner_id=%s AND id=%s", (self.owner_id, source))
                    overview.reset_mock()
                    self.assertIsNone(store.capture(scope))
                    # 来源变更触发器可能已经撤销整个发布集合；两条路径都必须拒绝旧结果。

    def test_disable_after_availability_probe_is_rechecked_in_transaction(self):
        scope, _ = self._publish()
        store = PostgresLayeredMemoryStore(self.database_url)
        transaction = store.transaction

        @contextmanager
        def disabled_before_locked_read(selected):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.layered_memory_state SET enabled=false,status='disabled' "
                    "WHERE owner_id=%s AND contact_id=%s", (scope.owner_id, scope.contact_id))
            with transaction(selected) as result:
                yield result

        with patch.object(store, "transaction", disabled_before_locked_read):
            self.assertIsNone(store.capture(scope))
