"""来源已核验但批量裁决损坏时不得伪装为零记忆成功。"""
from datetime import datetime, timedelta, timezone
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


class BatchRuntime:
    action = None
    duplicate = None
    def adjudicate_batch(self, *, memories, pool):
        return {row['candidate_id']: None if self.action is None else AdjudicationDecision(
            self.action, duplicate_memory_id=self.duplicate) for row in memories}


class InvalidBatchRetryTest(TestCase):
    def outcome(self, *, event=False):
        identifier = uuid4()
        text = '明天去看展。' if event else '联系人日常喜欢喝花茶。'
        when = datetime.now(timezone.utc)
        window = ExtractionWindow(uuid4(), uuid4(), (MessageRef(message_id=identifier, occurred_at=when,
            sender=MessageSender.CONTACT, text=text, text_representation='text', source_snapshots=({
                'source_ref_id':str(uuid4()),'source_id':str(uuid4()),'source_kind':'source_document',
                'source_content_sha256':'a'*64,'locator':'synthetic:1','raw_payload':{'time_iso':when.isoformat()}},)),))
        payload = _payload(identifier,text=text,_requires_all_sources=True)
        verification = verification_result(evidence=((identifier,text),))
        if event:
            pos = {'message_id':str(identifier),'char_start':0,'char_end':len(text)}
            start = when.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1)
            payload['event'] = {'version':2,'stage':'planned','stage_evidence':[pos],
                'occurrence_start':start.isoformat(),'occurrence_end':(start+timedelta(days=1)).isoformat(),
                'occurrence_evidence':[pos],'occurrence_precision':'day','occurrence_expression':'明天',
                'anchor_message_id':str(identifier)}
            verification['event_verification'] = {'stage_verdict':'supported','occurrence_verdict':'supported',
                'stage_evidence':[pos],'occurrence_evidence':[pos]}
        outcome = ExtractionFlow(runtime=RecordingRuntime((payload,)),
            verification_runtime=FixedSourceVerifier((verification,))).run(window)
        self.assertEqual(len(outcome.accepted),1)
        return ContactScope(window.owner_id,window.contact_id), outcome

    def test_invalid_automatic_batch_is_retryable_before_any_write(self):
        scope, outcome = self.outcome()
        runtime, store = BatchRuntime(), InMemoryMemoryStore()
        adoption = MemoryAdoption(memory_port=store, automatic=True, adjudication_runtime=runtime)
        with self.assertRaises(ExtractionRuntimeError):
            adoption.adopt(scope,outcome)
        self.assertEqual(store.list_confirmed(scope),())
        self.assertEqual(store.list_pending_candidates(scope),())
        runtime.action = AdjudicationAction.ADD
        self.assertEqual(adoption.adopt(scope,outcome).adopted,1)
        self.assertEqual(len(store.list_confirmed(scope)),1)

    def test_event_noop_preserves_existing_review_policy(self):
        scope, outcome = self.outcome(event=True)
        runtime, store = BatchRuntime(), InMemoryMemoryStore()
        runtime.action = AdjudicationAction.ADD
        adoption = MemoryAdoption(memory_port=store,automatic=True,adjudication_runtime=runtime)
        self.assertEqual(adoption.adopt(scope,outcome).adopted,1)
        runtime.action = AdjudicationAction.NOOP
        runtime.duplicate = store.list_confirmed(scope)[0].memory_id
        result = adoption.adopt(scope,outcome)
        self.assertEqual(result.adopted,0)
        self.assertEqual(len(store.list_confirmed(scope)),1)
        self.assertEqual(store.list_pending_candidates(scope),())
