"""通过可执行 CLI、HTTP 与进程寿命验证采样合同。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class SamplerContract(unittest.TestCase):
    def test_short_pair_keeps_tree_samples_order_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='na-perf-contract-') as temporary:
            out = Path(temporary) / 'run'
            result = subprocess.run(
                [sys.executable, str(HERE / 'host_perf.py'), 'self-test', '--out', str(out)],
                capture_output=True, text=True, timeout=25,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            run = json.loads((out / 'run.json').read_text())
            self.assertEqual([r['arm'] for r in run['startups']], ['old', 'new'])
            self.assertEqual(len(run['startups']), 2)
            for row in run['startups']:
                self.assertEqual(row['terminal_status'], 'succeeded', row)
                self.assertEqual(len(row['rss']), 2)
                self.assertGreater(row['startup_ms'], 0)
                self.assertTrue(all(s['tree_rss_kib'] > 0 for s in row['rss']))
                self.assertTrue(all(len(s['processes']) >= 2 for s in row['rss']))
                self.assertTrue(row['cleanup']['verified'])
                for pid in row['cleanup']['observed_pids']:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
            report = json.loads((out / 'report.json').read_text())
            self.assertFalse(report['protocol_qualified'])
            self.assertEqual(report['overall'], 'undetermined')
            self.assertEqual(run['physical_model_requests'], 0)


    def test_report_preserves_failed_denominator_and_seeded_intervals(self):
        with tempfile.TemporaryDirectory(prefix='na-perf-report-') as temporary:
            folder = Path(temporary)
            starts = []
            for repeat in range(20):
                for arm, value in [('old', 10), ('new', 11)]:
                    starts.append({'arm': arm, 'repeat': repeat, 'terminal_status': 'succeeded',
                                   'startup_ms': value, 'rss_median_kib': value * 100,
                                   'rss': [{'tree_rss_kib': value * 100}] * 60,
                                   'cleanup': {'verified': True}})
            run = {'kind': 'fixture', 'planned_startups': 40, 'startups': starts,
                   'physical_model_requests': 0, 'http': [], 'http_cases': []}
            source = folder / 'run.json'
            source.write_text(json.dumps(run))
            command = [sys.executable, str(HERE / 'host_perf.py'), 'report',
                       '--run', str(source), '--out', str(folder / 'report.json')]
            result = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((folder / 'report.json').read_text())
            metric = report['metrics']['startup_ms']['p50']
            self.assertEqual(metric['old'], 10)
            self.assertEqual(metric['new'], 11)
            self.assertAlmostEqual(metric['ratio'], 1.1)
            self.assertEqual(metric['ci95'], [1.1, 1.1])
            self.assertEqual(report['bootstrap']['seed'], 102)
            self.assertEqual(report['bootstrap']['resamples'], 10000)
            starts[-1]['terminal_status'] = 'failed'
            starts[-1]['startup_ms'] = None
            source.write_text(json.dumps(run))
            result = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            failed = json.loads((folder / 'report.json').read_text())
            self.assertEqual(failed['population']['new']['planned'], 20)
            self.assertEqual(failed['population']['new']['failed'], 1)
            self.assertEqual(failed['overall'], 'failed')
            self.assertFalse(failed['protocol_qualified'])


    def test_http_failure_cannot_disappear_behind_latency_unknown(self):
        with tempfile.TemporaryDirectory(prefix='na-perf-http-failure-') as temporary:
            folder=Path(temporary)
            starts=[{'arm':arm,'repeat':index,'terminal_status':'succeeded','startup_ms':10,
                     'rss_median_kib':100,'rss':[{'tree_rss_kib':100}]*60,
                     'cleanup':{'verified':True}} for index in range(20) for arm in ('old','new')]
            http=[{'arm':arm,'case_id':'contacts','repeat':index,'warmup':index<0,
                   'terminal_status':'failed' if arm=='new' and index==29 else 'succeeded',
                   'server_response_ms':None if arm=='new' and index==29 else 10,
                   'client_response_ms':None if arm=='new' and index==29 else 10}
                  for index in range(-10,30) for arm in ('old','new')]
            source=folder/'run.json';target=folder/'report.json'
            source.write_text(json.dumps({'kind':'fixture','planned_startups':40,'startups':starts,
                'http':http,'http_cases':[{'id':'contacts','write':False}],'physical_model_requests':0}))
            result=subprocess.run([sys.executable,str(HERE/'host_perf.py'),'report',
                '--run',str(source),'--out',str(target)],capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            report=json.loads(target.read_text())
            self.assertEqual(report['overall'],'failed')
            population=report['http']['contacts']['population']['new']
            self.assertEqual(population['planned'],30)
            self.assertEqual(population['failed_ids'],[29])
            self.assertEqual(population['failed'],1)


    def test_ready_timeout_keeps_failed_host_and_stops_its_children(self):
        with tempfile.TemporaryDirectory(prefix='na-perf-timeout-') as temporary:
            out=Path(temporary)/'run'
            result=subprocess.run([sys.executable,str(HERE/'host_perf.py'),'self-test',
                '--out',str(out),'--fail-new'],capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            run=json.loads((out/'run.json').read_text())
            self.assertEqual(len(run['startups']),2)
            failed=run['startups'][1]
            self.assertEqual(failed['terminal_status'],'failed')
            self.assertIsNone(failed['startup_ms'])
            self.assertGreaterEqual(failed['timeout_lower_bound_ms'],1000)
            self.assertTrue(failed['cleanup']['verified'])
            self.assertGreaterEqual(len(failed['cleanup']['observed_pids']),2)
            for pid in failed['cleanup']['observed_pids']:
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            report=json.loads((out/'report.json').read_text())
            self.assertEqual(report['overall'],'failed')
            self.assertEqual(report['population']['new']['planned'],1)
            self.assertEqual(report['population']['new']['failed'],1)


if __name__ == '__main__':
    unittest.main()
