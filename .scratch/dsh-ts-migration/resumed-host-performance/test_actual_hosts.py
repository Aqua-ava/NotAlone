"""真实旧 Python／官方 DSH 启动探针；只运行独立合成 PostgreSQL。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parent


class ActualHostProbe(unittest.TestCase):
    def test_frozen_old_python_and_pure_ts_public_http(self):
        temporary=tempfile.mkdtemp(prefix='na-hostperf-integration-',dir='/tmp')
        root=Path(temporary)
        arguments=[sys.executable,str(HERE/'host_perf.py'),'prepare','--state',str(root/'state')]
        if os.environ.get('NOTALONE_HOST_PERF_OLD_WHEEL_CACHE'):
            arguments+=['--old-wheel-cache',os.environ['NOTALONE_HOST_PERF_OLD_WHEEL_CACHE']]
        prepared=subprocess.run(arguments,capture_output=True,text=True,timeout=300)
        self.assertEqual(prepared.returncode,0,prepared.stderr[-2000:])
        plan=json.loads((root/'state/plan.json').read_text())
        self.assertTrue(plan['binding']['old_runtime']['isolated'])
        self.assertEqual(plan['binding']['old_runtime']['source_commit'],plan['binding']['old_commit'])
        self.assertFalse((root/'state/new/backend/src').exists())
        self.assertNotEqual(Path(plan['python']).parent,Path(sys.executable).parent)
        for key in ('NOTALONE_HOST_RUNTIME','NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_HISTORY_RUNTIME'):
            self.assertEqual(plan['runtime_environments']['new'][key],'typescript')
            self.assertNotIn(key,plan['runtime_environments']['old'])
        result=subprocess.run([sys.executable,str(HERE/'host_perf.py'),'collect',
            '--plan',str(root/'state/plan.json'),'--probe','--out',str(root/'run')],
            capture_output=True,text=True,timeout=110)
        self.assertEqual(result.returncode,0,result.stderr[-2000:])
        run=json.loads((root/'run/run.json').read_text())
        self.assertEqual(len(run['startups']),2)
        for row in run['startups']:
            self.assertEqual(row['terminal_status'],'succeeded',row)
            self.assertTrue(row['cleanup']['verified'],row)
            self.assertEqual(row['model_operation_records'],{'model_call_receipt':0,'outbound_ledger_entry':0})
            self.assertEqual(row['model_cache_after']['files'],{})
        self.assertEqual(run['physical_model_requests'],0)
        self.assertEqual(run['network_denied_attempts'],0)
        self.assertTrue(run['binding_verified'])
        self.assertEqual(len(run['http']),18)
        for row in run['http']:
            self.assertEqual(row['terminal_status'],'succeeded',row)
            self.assertGreater(row['server_response_ms'],0,row)
            if row['case_id']=='session-default':
                self.assertGreater(row['persistence_complete_ms'],0,row)
                self.assertGreater(row['durability_observed_ms'],0,row)
        report=json.loads((root/'run/report.json').read_text())
        self.assertFalse(report['protocol_qualified'])
        self.assertNotEqual(report['overall'],'passed')
        self.assertFalse(report['new_arm_python_observed'])
        fresh=next(row for row in run['startups'] if row['arm']=='new')
        self.assertEqual(fresh['runtime_ownership']['hostRuntime'],'typescript')
        self.assertIsNone(fresh['runtime_ownership']['legacyPid'])
        self.assertTrue(all('python' not in item['executable'].lower() for sample in fresh['rss'] for item in sample['processes']))
