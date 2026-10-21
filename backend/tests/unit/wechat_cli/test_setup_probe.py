"""首次连接只执行固定只读状态和会话元数据命令。"""
import json
from types import SimpleNamespace
import unittest
from notalone.wechat_cli.adapter import LocalWechatCli
from notalone.wechat_cli.errors import CliAdapterError


def status(account='wxid_synthetic', ready=True):
    return {'ok':True, 'data':{'status':{'account_debug':{'wxid':account, 'db_root':'/private/synthetic'},
        'account':{'identity_configured':True, 'schema2_ready':ready},
        'mode':{'strict_read_only':True}, 'live_read_ok':ready, 'readiness':'ready' if ready else 'blocked'}}}


class SetupProbeTest(unittest.TestCase):
    def cli(self, values):
        self.commands = []
        def run(command):
            self.commands.append(command)
            return SimpleNamespace(returncode=0, stdout=json.dumps(values.pop(0)), stderr='')
        return LocalWechatCli(executable='synthetic-cli', runner=run)

    def test_readable_account_requires_metadata_and_matching_identity_afterwards(self):
        cli = self.cli([status(), {'ok':True,'data':{'sessions':[]}}, status()])
        self.assertEqual(cli.configured_account(expected_account='wxid_synthetic'), 'wxid_synthetic')
        self.assertEqual(self.commands, [
            ('synthetic-cli','status','--include-debug','--strict-read-only'),
            ('synthetic-cli','sessions','--type-filter','private','--limit','1','--strict-read-only'),
            ('synthetic-cli','status','--include-debug','--strict-read-only')])

    def test_not_ready_never_invokes_sessions_or_setup(self):
        cli = self.cli([status(ready=False)])
        with self.assertRaises(CliAdapterError):
            cli.configured_account(expected_account='wxid_synthetic')
        self.assertEqual(len(self.commands), 1)

    def test_identity_changed_during_probe_fails_closed(self):
        cli = self.cli([status(), {'ok':True,'data':{'sessions':[]}}, status('wxid_changed')])
        with self.assertRaises(CliAdapterError):
            cli.configured_account(expected_account='wxid_synthetic')

    def test_readiness_alone_without_stable_identity_is_not_a_candidate(self):
        for identity in ('', '../private/key', 'someone\nelse', None):
            with self.subTest(identity=identity):
                cli = self.cli([status(account=identity)])
                with self.assertRaises(CliAdapterError):
                    cli.configured_account(expected_account='wxid_synthetic')
                self.assertEqual(len(self.commands), 1)

    def test_candidate_detection_only_reads_configuration_status(self):
        cli = self.cli([status()])
        self.assertEqual(cli.configured_account(), 'wxid_synthetic')
        self.assertEqual(self.commands, [('synthetic-cli','status','--include-debug','--strict-read-only')])

    def test_changed_account_is_rejected_before_session_access(self):
        cli = self.cli([status('wxid_changed')])
        with self.assertRaises(CliAdapterError):
            cli.configured_account(expected_account='wxid_synthetic')
        self.assertEqual(len(self.commands), 1)

    def test_configured_account_accepts_real_status_slower_than_two_seconds(self):
        import subprocess
        import sys
        from unittest.mock import patch
        real_popen = subprocess.Popen
        output = json.dumps(status())
        def process(command, **kwargs):
            return real_popen((sys.executable, '-c',
                'import time; time.sleep(2.2); print(' + repr(output) + ')'), **kwargs)
        cli = LocalWechatCli(executable='synthetic-cli')
        self.addCleanup(cli.close)
        with patch('notalone.wechat_cli.adapter.subprocess.Popen', side_effect=process):
            self.assertEqual(cli.configured_account(), 'wxid_synthetic')

    def test_status_timeout_reaps_process_and_does_not_accept_partial_output(self):
        import os
        import subprocess
        import sys
        import time
        from unittest.mock import patch
        real_popen = subprocess.Popen
        processes = []
        def process(command, **kwargs):
            child = real_popen((sys.executable, '-c',
                'import time; print(' + repr(json.dumps(status())) + ', flush=True); time.sleep(20)'), **kwargs)
            processes.append(child)
            return child
        cli = LocalWechatCli(executable='synthetic-cli')
        self.addCleanup(cli.close)
        started = time.monotonic()
        with patch('notalone.wechat_cli.adapter.subprocess.Popen', side_effect=process):
            with self.assertRaises(CliAdapterError) as raised:
                cli.configured_account()
        self.assertEqual(raised.exception.code, 'cli_timeout')
        self.assertLess(time.monotonic() - started, 7.5)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(processes[0].pid, 0)
