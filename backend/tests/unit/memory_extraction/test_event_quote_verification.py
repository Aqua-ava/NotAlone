"""事件核验用唯一原文引句定位；下游语义、阶段和日历门保持严格。"""
from datetime import datetime, timezone
from unittest import TestCase
from uuid import uuid4
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction import test_verification_adapters as adapters
from tests.unit.memory_extraction.verification_helpers import verification_result
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class EventQuoteVerificationTest(TestCase):
    def run_case(self, *, text='😺2024年实习期间不便通话。', quote='2024年', stage_quote='实习期间',
                 foreign=False, old_position=False, occurrence='supported', second=False):
        mid = uuid4()
        def message(identifier, body):
            return MessageRef(message_id=identifier, text=body, sender=MessageSender.CONTACT,
                occurred_at=datetime(2026,10,22,9,tzinfo=timezone.utc), text_representation='text',
                source_snapshots=({'source_ref_id':str(uuid4()),'source_id':str(uuid4()),
                    'source_kind':'source_document','source_content_sha256':'a'*64,'locator':'synthetic:1',
                    'raw_payload':{'time_iso':'2026-10-22T09:00:00+00:00'}},))
        position = {'message_id':str(mid),'char_start':0,'char_end':len(text)}
        event = {'version':2,'stage':'occurred','stage_evidence':[position],
            'occurrence_start':'2024-01-01T00:00:00+00:00', 'occurrence_end':'2025-01-01T00:00:00+00:00',
            'occurrence_evidence':[position],'occurrence_precision':'year',
            'occurrence_expression':'2024年','anchor_message_id':str(mid)}
        payloads = [_payload(mid,text=text,category='common_fact',event=event,_requires_all_sources=True)]
        result = verification_result(evidence=((mid,text),))
        result['event_verification'] = {'stage_verdict':'supported','occurrence_verdict':occurrence,
            'stage_evidence':[{'message_id':str(mid),'quote':stage_quote}],
            'occurrence_evidence':[{'message_id':str(uuid4() if foreign else mid),'quote':quote}]}
        if old_position:
            result['event_verification']['occurrence_evidence'] = [{'message_id':str(mid),'char_start':1,'char_end':5}]
        messages, results = [message(mid,text)], [result]
        if second:
            other = uuid4(); body='我的生日是6月9日。'
            messages.append(message(other,body));payloads.append(_payload(other,text=body))
            results.append(verification_result(candidate_index=1,evidence=((other,body),)))
        model = ToolCallingFakeModel(responses=[adapters.structured_verification(tuple(results))])
        verifier = LangChainSourceVerificationRuntime(model=model,isolate_items=True)
        return ExtractionFlow(runtime=RecordingRuntime(tuple(payloads)), verification_runtime=verifier).run(
            ExtractionWindow(uuid4(),uuid4(),tuple(messages)))

    def test_unique_chinese_quote_after_emoji_gets_exact_codepoint_span(self):
        outcome = self.run_case()
        self.assertEqual(len(outcome.accepted),1)
        event = outcome.accepted[0].event
        self.assertTrue(event.occurrence_verified)
        self.assertEqual((event.occurrence_evidence[0].char_start,event.occurrence_evidence[0].char_end),(1,6))

    def test_missing_ambiguous_overlapping_and_foreign_quotes_are_rejected(self):
        cases = [{'quote':''},{'quote':'不存在'}, {'text':'😺2024年实习期间，2024年不便通话。'},
            {'text':'哈哈哈2024年实习期间不便通话。','stage_quote':'哈哈'}, {'foreign':True}]
        for options in cases:
            with self.subTest(options=options):
                self.assertEqual(self.run_case(**options).accepted,())

    def test_partial_year_quote_or_old_wrong_span_is_not_extended(self):
        for options in ({'quote':'2024'}, {'old_position':True}):
            with self.subTest(options=options):
                self.assertEqual(self.run_case(**options).accepted,())

    def test_uncertain_occurrence_remains_unverified(self):
        fact = self.run_case(occurrence='uncertain').accepted[0]
        self.assertFalse(fact.event.occurrence_verified)

    def test_one_invalid_quote_does_not_discard_other_supported_fact(self):
        outcome = self.run_case(quote='不存在',second=True)
        self.assertEqual([fact.text for fact in outcome.accepted],['我的生日是6月9日。'])
