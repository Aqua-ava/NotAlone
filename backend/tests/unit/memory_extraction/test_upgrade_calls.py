"""升级预算在实际模型入口扣记，应用只重放已批准的裁决。"""

import unittest
from contextlib import contextmanager
from uuid import uuid4

from notalone.application.memory_upgrade import UpgradeModelCalls, RecordedAdjudication
from notalone.memory.upgrade import UpgradeConflict
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision, SimilarMemory
from notalone.scopes import ContactScope


class UpgradeCallsTest(unittest.TestCase):
    def test_source_changed_while_waiting_for_permit_never_enters_model_or_charges(self):
        state = {'valid': True, 'charged': 0, 'called': 0}

        class Control:
            @contextmanager
            def background_call(self):
                state['valid'] = False
                yield
            def wait_for_foreground(self):
                pass

        class Store:
            def charge(self, claim):
                if not state['valid']:
                    raise UpgradeConflict()
                state['charged'] += 1
            def validate(self, claim):
                if not state['valid']:
                    raise UpgradeConflict()

        class Runtime:
            def extract(self, window):
                state['called'] += 1
                return ()

        calls = UpgradeModelCalls(scope=ContactScope(uuid4(), uuid4()), claim=object(), store=Store(),
                                  extraction=Runtime(), priority=Control())
        with self.assertRaises(UpgradeConflict):
            calls.extract(object())
        self.assertEqual((state['charged'], state['called']), (0, 0))

    def test_recorded_adjudication_replays_only_the_same_frozen_inputs(self):
        class Runtime:
            def adjudicate(self, **kwargs):
                return AdjudicationDecision(AdjudicationAction.UPDATE, kwargs['similar'][0].memory_id)

        similar = (SimilarMemory(uuid4(), '合成旧茶偏好', 'other'),)
        recorder = RecordedAdjudication(runtime=Runtime())
        expected = recorder.adjudicate(candidate_text='合成新茶偏好', similar=similar)
        replay = RecordedAdjudication(records=recorder.records)
        self.assertEqual(replay.adjudicate(candidate_text='合成新茶偏好', similar=similar), expected)
        replay.assert_consumed()
        with self.assertRaises(UpgradeConflict):
            RecordedAdjudication(records=recorder.records).adjudicate(candidate_text='已改变', similar=similar)
        with self.assertRaises(UpgradeConflict):
            RecordedAdjudication(records=recorder.records).assert_consumed()
