"""通过正式提取与独立核验边界验证来源日历，模型响应只作外部输入。"""
from datetime import datetime, timezone
import unittest
from uuid import uuid4
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result


class TemporalPrecisionFlowTest(unittest.TestCase):
    def run_case(self, *, text='明天去看展。', when='2030-01-31T23:30:00+08:00',
                 expression='明天', precision='day', start='2030-02-01T00:00:00+08:00',
                 end='2030-02-02T00:00:00+08:00', source_timezone=True, validity=None):
        mid = uuid4()
        actual = datetime.fromisoformat(when).astimezone(timezone.utc) if when else None
        snapshots = ({'source_ref_id': str(uuid4()), 'source_id': str(uuid4()),
            'source_kind': 'source_document', 'locator': 'line:1',
            'source_content_sha256': 'a'*64, 'raw_payload': {'time_iso': when} if source_timezone else {}},)
        message = MessageRef(mid, text, MessageSender.CONTACT, actual, snapshots, text_representation='text')
        window = ExtractionWindow(uuid4(), uuid4(), (message,))
        pos = {'message_id':str(mid), 'char_start':0,'char_end':len(text)}
        event = {'version':2,'stage':'planned','stage_evidence':[pos],
            'occurrence_start':start,'occurrence_end':end,'occurrence_evidence':[pos],
            'occurrence_precision':precision,'occurrence_expression':expression,'anchor_message_id':str(mid)}
        fact = _payload(mid,text=text,category='relationship_note',event=event)
        if validity is not None:
            fact.update(event=None, _requires_all_sources=True, category='recent_state', valid_at=validity[0], invalid_at=validity[1])
        result = verification_result(evidence=((mid,text),))
        result['event_verification']={'stage_verdict':'supported','occurrence_verdict':'supported' if start else 'uncertain',
            'stage_evidence':[pos],'occurrence_evidence':[pos]}
        if validity is not None:
            result.pop('event_verification')
        return ExtractionFlow(runtime=RecordingRuntime((fact,)),
            verification_runtime=FixedSourceVerifier((result,))).run(window)

    def test_midnight_relative_day_uses_own_source_offset_and_survives_payload(self):
        outcome = self.run_case()
        self.assertEqual(len(outcome.accepted),1)
        event = outcome.accepted[0].event.to_payload()
        self.assertEqual(event['occurrence_start'],'2030-02-01T00:00:00+08:00')
        self.assertEqual(event['occurrence_precision'],'day')
        self.assertTrue(event['occurrence_verified'])

    def test_partial_calendar_precision_and_uncertain_dates_are_not_invented(self):
        for kwargs, expected in (
            ({'text':'去年换了工作。','when':'2030-03-04T10:00:00+08:00','expression':'去年',
              'precision':'year','start':'2029-01-01T00:00:00+08:00','end':'2030-01-01T00:00:00+08:00'}, 'year'),
            ({'text':'上月出差。','when':'2030-01-15T10:00:00-07:00','expression':'上月',
              'precision':'month','start':'2029-12-01T00:00:00-07:00','end':'2030-01-01T00:00:00-07:00'}, 'month'),
            ({'source_timezone':False}, 'unknown'),
            ({'when':None}, 'unknown'),
            ({'text':'他上周说明天出差。'}, 'unknown'),
            ({'start':'2030-01-31T00:00:00+08:00','end':'2030-02-01T00:00:00+08:00'}, 'unknown'),
            ({'text':'最近忙。','expression':'最近'}, 'unknown'),
        ):
            with self.subTest(kwargs=kwargs):
                outcome = self.run_case(**kwargs)
                self.assertEqual(len(outcome.accepted),1)
                event = outcome.accepted[0].event.to_payload()
                self.assertEqual(event['occurrence_precision'],expected)
                if expected == 'unknown':
                    self.assertIsNone(event['occurrence_start'])
                    self.assertFalse(event['occurrence_verified'])

    def test_time_expression_cannot_be_invented_outside_real_source(self):
        outcome = self.run_case(expression='昨天')
        self.assertEqual(outcome.accepted, ())

    def test_explicit_clock_interval_retains_precision_and_wrong_end_offset_is_unknown(self):
        correct = dict(text='2030年2月1日09:00到11:00看展。',expression='2030年2月1日09:00到11:00',
            precision='instant',start='2030-02-01T09:00:00+08:00',end='2030-02-01T11:00:00+08:00')
        event = self.run_case(**correct).accepted[0].event
        self.assertTrue(event.occurrence_verified)
        event = self.run_case(**{**correct,'end':'2030-02-01T03:00:00+00:00'}).accepted[0].event
        self.assertIsNone(event.occurrence_start)

    def test_unstated_temporary_deadline_is_unknown_but_full_source_week_is_preserved(self):
        invented = self.run_case(text='现在还在等电梯。', validity=('2030-01-31T23:30:00+08:00','2030-02-01T00:00:00+08:00')).accepted[0]
        self.assertIsNone(invented.valid_at)
        self.assertIsNone(invented.invalid_at)
        week = self.run_case(text='本周不便通话。', validity=('2030-01-28T00:00:00+08:00','2030-02-04T00:00:00+08:00')).accepted[0]
        self.assertEqual(week.valid_at.isoformat(),'2030-01-28T00:00:00+08:00')
        self.assertEqual(week.invalid_at.isoformat(),'2030-02-04T00:00:00+08:00')
