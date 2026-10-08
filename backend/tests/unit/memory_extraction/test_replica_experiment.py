"""实验通过公开运行接口比较同一次自然输出，不连接真实存储。"""

from __future__ import annotations

import unittest
import io
import json
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.replica_experiment import (
    ARMS, blind_trials, main, run_trial, trial_schedule,
)


class Runtime:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    def extract(self, window):
        self.calls += 1
        return self.payload


class Verifier:
    def verify(self, *, window, facts):
        return tuple({
            'candidate_index': index, 'verdict': 'supported', 'issues': [],
            'evidence': [{'message_id': str(window.messages[0].message_id),
                          'quote': window.messages[0].text}],
        } for index in range(len(facts)))


class ReplicaExperimentTests(unittest.TestCase):
    def test_same_natural_output_is_extracted_once_then_guarded(self):
        message = MessageRef(uuid4(), '我平时只喝温水。', MessageSender.CONTACT,
                             datetime(2026, 7, 1, tzinfo=timezone.utc))
        window = ExtractionWindow(uuid4(), uuid4(), (message,))
        runtime = Runtime(({
            'text': '联系人平时只喝温水。', 'category': 'preference',
            'subject': 'contact', 'topic': 'health',
            'source_message_ids': [str(message.message_id)],
            'confidence': 0.9, 'risk_flags': [], 'valid_at': None,
            'invalid_at': None, 'speech_act': 'assertion',
            'assertion_status': 'asserted', 'figurative_type': 'literal',
            'alternatives': [], 'interpretation_reason': '直接自述。',
        },))
        result = run_trial(case_id='test', dimension='semantic', arm='A', repeat=0,
                           window=window, runtime=runtime, verifier=Verifier())
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result['raw']['facts'][0]['destination'], 'auto')
        self.assertEqual(result['guarded']['facts'][0]['destination'], 'auto')
        self.assertEqual(result['payloads'][0]['text'], '联系人平时只喝温水。')

    def test_blinding_hides_arm_confidence_and_verifier_reasons(self):
        trial = {'case_id': 'synthetic', 'dimension': 'semantic', 'arm': 'D', 'repeat': 1,
                 'raw': {'facts': [{'text': '联系人只喝温水。', 'confidence': .99,
                                    'interpretation_reason': '猜测',
                                    'risk_flags': ['semantic:time']}],
                         'failure_reason': None, 'rejected_count': 0},
                 'guarded': None}
        result = blind_trials([trial], {'synthetic': {'gold': []}})
        record = result['records'][0]
        self.assertNotIn('arm', record)
        self.assertNotIn('confidence', record['outputs']['raw']['facts'][0])
        self.assertNotIn('risk_flags', record['outputs']['raw']['facts'][0])
        self.assertEqual(result['mapping'][record['blind_id']]['arm'], 'D')

    def test_schedule_contains_all_pairs_without_replacement(self):
        schedule = trial_schedule(['first', 'second'], 2)
        self.assertEqual(len(schedule), 16)
        self.assertEqual(len(set(schedule)), 16)
        self.assertEqual(schedule, trial_schedule(['first', 'second'], 2))
        self.assertEqual({arm for _, arm, _ in schedule}, set(ARMS))
        with self.assertRaises(ValueError):
            trial_schedule(['duplicate', 'duplicate'], 2)

    def test_cli_without_explicit_key_never_builds_model(self):
        with patch.dict('os.environ', {}, clear=True), redirect_stdout(io.StringIO()):
            with patch('notalone.reply.adapters.deepseek_provider.build_deepseek_model') as build:
                self.assertEqual(main(['--output-dir', '/tmp/not-created']), 2)
        build.assert_not_called()

    def test_cli_preserves_frozen_inputs_and_all_arm_outputs(self):
        from notalone.memory_extraction.replica_cases import REPLICA_CASES

        tool_choices = []

        class EmptyModel:
            def bind_tools(self, schemas, **kwargs):
                name = schemas[0]['title']
                tool_choices.append((name, kwargs.get('tool_choice')))
                key = 'narratives' if name == 'MemoryNarrativeOutput' else 'facts'
                return SimpleNamespace(invoke=lambda messages: SimpleNamespace(
                    tool_calls=[{'name': name, 'args': {key: []}}],
                    usage_metadata={'input_tokens': 12, 'output_tokens': 2},
                    response_metadata={'model_name': 'synthetic-model'},
                ))

        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'new-output'
            with patch.dict('os.environ', {'NOTALONE_EVALUATION_API_KEY': 'test-only'}, clear=True):
                with patch('notalone.reply.adapters.deepseek_provider.build_deepseek_model',
                           return_value=EmptyModel()):
                    with patch('notalone.memory_extraction.replica_cases.REPLICA_CASES',
                               (REPLICA_CASES[7],)), redirect_stdout(io.StringIO()):
                        self.assertEqual(main(['--output-dir', str(destination),
                                               '--split', 'development', '--repetitions', '1']), 0)
                        with self.assertRaises(FileExistsError):
                            main(['--output-dir', str(destination), '--split', 'development'])
            self.assertIn(('MemoryExtractionOutput', 'MemoryExtractionOutput'), tool_choices)
            manifest = json.loads((destination / 'manifest.json').read_text())
            blinded = json.loads((destination / 'blinded.json').read_text())
            self.assertEqual(len(manifest['schedule']), 4)
            self.assertEqual(len(blinded), 4)
            self.assertTrue(manifest['synthetic_only'])
            self.assertEqual(len(manifest['dataset_sha256']), 64)
            self.assertEqual((destination / 'manifest.json').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
