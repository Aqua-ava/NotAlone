"""来源已核验但批量裁决损坏时不得伪装为零记忆成功。"""
from datetime import datetime, timezone
from unittest import TestCase
from uuid import uuid4
from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result


class InvalidBatchRetryTest(TestCase):
    def test_invalid_automatic_batch_is_retryable_before_any_write(self):
        identifier = uuid4()
        text = '联系人日常喜欢喝花茶。'
        window = ExtractionWindow(uuid4(), uuid4(), (MessageRef(message_id=identifier, occurred_at=datetime.now(timezone.utc),
            sender=MessageSender.CONTACT, text=text, text_representation='text', source_snapshots=({
                'source_ref_id': str(uuid4()), 'source_id': str(uuid4()), 'source_kind': 'source_document',
                'source_content_sha256': 'a'*64, 'locator': 'synthetic:1', 'raw_payload': {}},)),))
        outcome = ExtractionFlow(runtime=RecordingRuntime((_payload(identifier, text=text),)),
            verification_runtime=FixedSourceVerifier((verification_result(evidence=((identifier,text),)),))).run(window)
        self.assertEqual(len(outcome.accepted), 1)
        class BatchRuntime:
            valid = False
            def adjudicate_batch(self, *, memories, pool):
                return {row['candidate_id']: AdjudicationDecision(AdjudicationAction.ADD) if self.valid else None
                        for row in memories}
        runtime, store = BatchRuntime(), InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)
        adoption = MemoryAdoption(memory_port=store, automatic=True, adjudication_runtime=runtime)
        with self.assertRaises(ExtractionRuntimeError):
            adoption.adopt(scope, outcome)
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(store.list_pending_candidates(scope), ())
        runtime.valid = True
        self.assertEqual(adoption.adopt(scope, outcome).adopted, 1)
        self.assertEqual(len(store.list_confirmed(scope)), 1)
