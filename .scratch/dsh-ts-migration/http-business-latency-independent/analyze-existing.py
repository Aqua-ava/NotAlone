#!/usr/bin/env python3
"""仅离线汇总已存在的合成证据；不启动 HTTP、数据库或基准。"""
from pathlib import Path
import collections
import hashlib
import json
import os
import statistics
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BASE = REPO/'.scratch/dsh-ts-migration/http-latency-regression/continuation'
STATE = Path.home()/'.local/state/notalone/diagnostics/migration-resume-20261025/host-perf-e5d-probe-state'
OLD = '3c168296e9e8edaa43b8b323ff693e790e709069'
raw_inputs = {}

def load(path):
    raw = path.read_bytes()
    raw_inputs[str(path.relative_to(REPO))] = hashlib.sha256(raw).hexdigest()
    return json.loads(raw)

def median(values):
    return statistics.median(values)

evidence = {'diagnostic_only': True, 'formal_performance_qualified': False, 'old_commit': OLD}
production = load(BASE/'http-production-03.json')
recorded = load(BASE/'http-production-03-summary.json')
evidence['existing_http'] = {}
empty_hash = hashlib.sha256(json.dumps({'sources': []}, sort_keys=True).encode()).hexdigest()
for case in ('contacts', 'sources', 'session-default'):
    arms = {}
    for arm in ('old', 'new'):
        rows = [row for row in production['rows'] if row['case_id'] == case and row['arm'] == arm and not row['warmup']]
        assert len(rows) == 30 and all(row['terminal_status'] == 'succeeded' for row in rows)
        arms[arm] = {'n': len(rows), 'server_p50_ms': median(row['server_response_ms'] for row in rows),
                     'client_minus_server_p50_ms': median(row['client_response_ms']-row['server_response_ms'] for row in rows),
                     'response_hash_counts': dict(collections.Counter(row['response_sha256'] for row in rows))}
        assert abs(arms[arm]['server_p50_ms']-recorded['cases'][case]['after']['p50_ms'][arm]) < 1e-10
        if case == 'sources':
            assert set(arms[arm]['response_hash_counts']) == {empty_hash}
    evidence['existing_http'][case] = {'arms': arms, 'recorded_p50_ratio': recorded['cases'][case]['after']['p50_ratio'],
                                     'recorded_p95_ratio': recorded['cases'][case]['after']['p95_ratio']}
evidence['empty_sources_hash_verified'] = True
evidence['new_business_files'] = {}
for path in ('backend-ts/src/contact-context.ts', 'backend-ts/src/pure-ts-public-api.ts', 'backend-ts/src/pure-ts-reply-scope.ts', 'backend-ts/src/assistant-discussion-service.ts', 'backend-ts/src/host-plugin.ts', 'backend-ts/src/host-json.ts'):
    digest = hashlib.sha256((REPO/path).read_bytes()).hexdigest()
    assert digest == production['source_bindings']['after']['files'][path]
    evidence['new_business_files'][path] = digest
frozen = json.loads((STATE/'plan.json').read_text())
assert frozen['binding']['old_commit'] == OLD
evidence['old_archived_files_verified'] = {}
for path in ('backend/src/notalone/persistence/source_tasks.py', 'backend/src/notalone/persistence/contact_directory.py', 'backend/src/notalone/persistence/message_sources.py', 'backend/src/notalone/persistence/assistant_session_store.py', 'backend/src/notalone/server/app.py'):
    archived = (Path(frozen['old'])/path).read_bytes()
    assert archived == subprocess.check_output(['git', 'show', OLD+':'+path], cwd=REPO)
    evidence['old_archived_files_verified'][path] = hashlib.sha256(archived).hexdigest()
trace_path = BASE/'sql-profile-after-new-trace.jsonl'
raw = trace_path.read_bytes()
raw_inputs[str(trace_path.relative_to(REPO))] = hashlib.sha256(raw).hexdigest()
trace = [json.loads(line) for line in raw.splitlines()]
evidence['earlier_instrumented_profile'] = {'warning': '较早 HostStorage WIP 且启用 CPU profiler；不能与 production-03 混作同一运行', 'cases': {}}
for case in ('contacts', 'sources', 'session-default'):
    rows = [row for row in trace if row.get('type') == 'http' and row['request_id'].startswith('after:new:'+case+':') and int(row['request_id'].split(':')[-1]) >= 0]
    assert len(rows) == 30
    counts = {json.dumps(row['storage_counts'], sort_keys=True) for row in rows}
    assert len(counts) == 1
    evidence['earlier_instrumented_profile']['cases'][case] = {
        'n': len(rows), 'counts': rows[0]['storage_counts'],
        'stage_p50_ms': {key: median(row['storage_times'][key] for row in rows) for key in rows[0]['storage_times']},
        'business_rows_shapes': dict(collections.Counter(str([item['rows'] for item in row['storage_details']['sql:business_sql']]) for row in rows))}
measurement = load(HERE/'sql-measurement.json')
assert measurement['status'] == 'succeeded' and measurement['cleanup']['database_absent'] and measurement['cleanup']['database_sessions_after'] == 0
summary = {'samples_including_warmup': len(measurement['samples']), 'elapsed_seconds': measurement['elapsed_seconds'],
           'cleanup': measurement['cleanup'], 'transaction_isolation': measurement['transaction_isolation'],
           'same_database_other_active_before': measurement['same_database_other_active_before'],
           'same_database_other_active_after': measurement['same_database_other_active_after'],
           'adapter_limit': measurement['adapter'], 'contacts': {}, 'sources': {}, 'plans': {}}
for arm in ('old', 'new'):
    rows = [row for row in measurement['samples'] if row['case'] == 'contacts' and row['arm'] == arm and not row['warmup']]
    summary['contacts'][arm] = {'n': len(rows), 'p50_query_ms': median(row['query_ms'] for row in rows), 'all_rows_4': all(row['rows'] == 4 for row in rows),
                              'result_hashes': list({row['normalized_sha256'] for row in rows})}
rows = [row for row in measurement['samples'] if row['case'] == 'sources' and not row['warmup']]
summary['sources'] = {'n': len(rows), 'all_revisions_equal': all(row['revisions_equal'] for row in rows),
                      'six_steps_p50_ms': median(row['query_ms'] for row in rows),
                      'phase_p50_ms': {phase['phase']: median(row['phases'][i]['query_ms'] for row in rows) for i, phase in enumerate(rows[0]['phases'])},
                      'three_revisions_sum_p50_ms': median(sum(phase['query_ms'] for phase in row['phases'] if phase['phase'].startswith('revision_')) for row in rows),
                      'five_guard_steps_sum_p50_ms': median(sum(phase['query_ms'] for phase in row['phases'] if phase['phase'] != 'sources_select') for row in rows),
                      'guard_fraction_per_sample_p50': median(sum(phase['query_ms'] for phase in row['phases'] if phase['phase'] != 'sources_select')/row['query_ms'] for row in rows)}
for name, record in measurement['plans'].items():
    plan = record['plan'][0]
    nodes = []
    def walk(node):
        if 'Relation Name' in node:
            nodes.append({key: node[key] for key in ('Node Type', 'Relation Name', 'Actual Rows', 'Actual Loops') if key in node})
        for child in node.get('Plans', []):
            walk(child)
    walk(plan['Plan'])
    summary['plans'][name] = {'planning_ms': plan['Planning Time'], 'execution_ms': plan['Execution Time'],
                             'actual_rows': plan['Plan']['Actual Rows'], 'shared_hits': plan['Plan'].get('Shared Hit Blocks'),
                             'shared_reads': plan['Plan'].get('Shared Read Blocks'), 'relation_nodes': nodes}
process = json.loads((HERE/'private/process.json').read_text())
try:
    os.kill(process['pid'], 0)
    summary['cleanup']['diagnostic_process_absent'] = False
except ProcessLookupError:
    summary['cleanup']['diagnostic_process_absent'] = True
evidence['finite_sql_summary'] = summary
evidence['input_sha256'] = raw_inputs
for path, expected in raw_inputs.items():
    assert hashlib.sha256((REPO/path).read_bytes()).hexdigest() == expected
(HERE/'evidence-summary.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'offline_checks': 'succeeded', 'finite_sql_samples': len(measurement['samples']), 'cleanup': summary['cleanup'], 'http_gate_passed': False}, ensure_ascii=False))
