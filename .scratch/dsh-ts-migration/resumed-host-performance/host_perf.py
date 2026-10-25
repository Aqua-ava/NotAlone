#!/usr/bin/env python3
"""成对宿主采样入口；只把实际观测写入报告。"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time
import shutil
import uuid
import fcntl
from datetime import datetime, timezone
from typing import Any
from host_statistics import build_report
from host_fixture import prepare, clone, drop, specification, digest_files

HERE = Path(__file__).resolve().parent
SEED = 102


def save(path: Path, value: Any) -> None:
    pending=path.with_name(path.name+'.pending')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    pending.chmod(0o600)
    pending.replace(path)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def process_table() -> dict[int, dict]:
    result = subprocess.run(
        ['ps', '-axo', 'pid=,ppid=,pgid=,rss=,stat=,lstart=,comm='],
        capture_output=True, text=True, check=True, timeout=5,
    )
    table = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 10)
        if len(fields) < 11:
            continue
        pid, parent, group, rss = map(int, fields[:4])
        table[pid] = {'pid': pid, 'ppid': parent, 'pgid': group,
                      'rss_kib': rss, 'state': fields[4],
                      'identity': ' '.join(fields[5:10])+' '+fields[10],
                      'executable': Path(fields[10]).name}
    return table


def descendants(table: dict, root: int) -> list[dict]:
    selected = {root} if root in table else set()
    while True:
        more = {pid for pid, row in table.items() if row['ppid'] in selected}
        if more <= selected:
            break
        selected |= more
    return [table[pid] for pid in sorted(selected) if 'Z' not in table[pid]['state']]


def request(info: dict, path: str, method: str = 'GET', body: Any = None,
            request_id: str = '', timeout: float = 4, headers=None) -> dict:
    host, port = info['address'].split(':')
    if host != '127.0.0.1':
        raise ValueError('非本机握手地址')
    connection = http.client.HTTPConnection(host, int(port), timeout=timeout)
    started = time.monotonic_ns()
    try:
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        connection.request(method, path, body=payload, headers={
            'Authorization': 'Bearer ' + info['token'],
            'Content-Type': 'application/json', 'Connection': 'close',
            'X-NotAlone-Perf-Id': request_id,
            **(headers or {}),
        })
        response = connection.getresponse()
        data = response.read()
        ended = time.monotonic_ns()
        return {'status': response.status, 'client_response_ms': (ended-started)/1e6,
                'body': json.loads(data), 'started_ns': started, 'ended_ns': ended}
    finally:
        connection.close()


def handshake(path: Path) -> dict:
    fields = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
    return {'address': fields['address'], 'token': fields['token'], 'pid': int(fields['pid'])}


def cleanup(child: subprocess.Popen, observed: dict[int, str], root: int | None) -> dict:
    table = process_table()
    for row in descendants(table, root or child.pid):
        observed[row['pid']] = row['identity']
    if child.stdin:
        child.stdin.close()
    # 只信任本轮独立进程组与已观察的进程身份，不按名称终止其他进程。
    for sig, budget in ((signal.SIGTERM, 7), (signal.SIGKILL, 3)):
        table = process_table()
        targets = [pid for pid, identity in observed.items()
                   if pid in table and table[pid]['identity'] == identity and 'Z' not in table[pid]['state']]
        for pid in reversed(targets):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        if child.poll() is None:
            try:
                child.send_signal(sig)
            except ProcessLookupError:
                pass
        try:
            child.wait(timeout=budget)
        except subprocess.TimeoutExpired:
            continue
        table = process_table()
        remaining = [pid for pid in targets if pid in table and 'Z' not in table[pid]['state']
                     and table[pid]['identity'] == observed[pid]]
        if not remaining:
            return {'verified': True, 'observed_pids': sorted(observed), 'remaining': []}
    table = process_table()
    remaining = [pid for pid, identity in observed.items() if pid in table
                 and table[pid]['identity'] == identity and 'Z' not in table[pid]['state']]
    return {'verified': not remaining and child.poll() is not None,
            'observed_pids': sorted(observed), 'remaining': remaining}


def sample_one(arm: str, specification: dict, directory: Path, sample_count: int,
               interval: float, ready_timeout: float, repeat: int, workload=None,
               warmups=10, repetitions=30) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    info_path = directory / 'backend.info'
    environment = {str(k): str(v).replace('{run}', str(directory))
                   for k, v in specification['environment'].items()}
    environment['NOTALONE_BACKEND_INFO'] = str(info_path)
    command = [str(x).replace('{run}', str(directory)) for x in specification['command']]
    row = {'arm': arm, 'repeat': repeat, 'terminal_status': 'failed', 'rss': [],
           'startup_ms': None, 'unknown_reason': None, 'http': [],
           'started_utc':datetime.now(timezone.utc).isoformat(),
           'tree_definition':'认证握手 pid 及其后代；采样器与父启动适配器另列。'}
    observed: dict[int, str] = {}
    root = None
    with (directory / 'host.stdout.log').open('w') as stdout, (directory / 'host.stderr.log').open('w') as stderr:
        started = time.monotonic_ns()
        child = None
        try:
            child = subprocess.Popen(command, cwd=specification['cwd'], env=environment,
                                     stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, start_new_session=True)
            deadline = time.monotonic() + ready_timeout
            while time.monotonic() < deadline:
                if (directory/'backend-exit.json').exists():
                    raise RuntimeError('backend_exited_before_business_ready')
                if child.poll() is not None:
                    raise RuntimeError('host_exited_before_business_ready')
                try:
                    info = handshake(info_path)
                    ready = request(info, specification.get('ready_path', '/api/contacts'), timeout=1)
                    contacts=ready['body'].get('contacts',[])
                    scope_ready=not specification.get('ready_contact_id') or (
                        len(contacts)==specification['ready_contact_count'] and specification['ready_contact_id'] in
                        {contact.get('contact_id') for contact in contacts})
                    if ready['status'] == 200 and scope_ready:
                        root = info['pid']
                        break
                except (OSError, ValueError, KeyError, http.client.HTTPException):
                    pass
                time.sleep(.025)
            else:
                raise TimeoutError('business_ready_timeout')
            spawned = directory / 'spawn.json'
            if spawned.exists():
                started = json.loads(spawned.read_text())['started_ns']
            row['startup_ms'] = (ready['ended_ns'] - started) / 1e6
            row['ready_status'] = ready['status']
            row['backend_pid'] = root
            ready_at = time.monotonic()
            runtime=request(info,'/api/runtime/status')
            row['runtime_ownership']={key:runtime['body'].get(key) for key in ('state','runtime','hostRuntime','legacyPid','ownership')}
            for index in range(sample_count):
                due = ready_at + (index + 1) * interval
                time.sleep(max(0, due-time.monotonic()))
                table = process_table()
                tree = descendants(table, root)
                if child.poll() is not None or not tree:
                    raise RuntimeError('host_exited_during_rss_sampling')
                for process in tree:
                    observed[process['pid']] = process['identity']
                row['rss'].append({'offset_seconds': time.monotonic()-ready_at,
                                   'tree_rss_kib': sum(p['rss_kib'] for p in tree),
                                   'launcher_rss_kib':table.get(child.pid,{}).get('rss_kib') if child.pid!=root else None,
                                   'processes': tree})
                if specification.get('electron'):
                    electron=specification['electron']
                    identity=table.get(electron['pid'])
                    if not identity or identity['identity']!=electron['identity']:
                        raise RuntimeError('electron_identity_changed')
                    electron_tree=descendants(table,electron['pid'])
                    row['rss'][-1]['electron_tree_rss_kib']=sum(p['rss_kib'] for p in electron_tree)
                    row['rss'][-1]['electron_processes']=electron_tree
            row['rss_median_kib'] = statistics.median([s['tree_rss_kib'] for s in row['rss']]) if row['rss'] else None
            if workload:
                sample_http(info, workload, directory, arm, warmups, repetitions,row['http'])
            row['terminal_status'] = 'succeeded'
        except (Exception, KeyboardInterrupt) as error:
            if isinstance(error,KeyboardInterrupt):
                row['terminal_status']='cancelled'
            if (directory/'spawn.json').exists():
                started=json.loads((directory/'spawn.json').read_text())['started_ns']
            row['observed_until_failure_ms']=(time.monotonic_ns()-started)/1e6
            if isinstance(error,TimeoutError):
                row['timeout_lower_bound_ms']=row['observed_until_failure_ms']
            row['unknown_reason'] = type(error).__name__ + ':' + str(error)
        finally:
            row['cleanup'] = cleanup(child, observed, root) if child else {'verified':True,'observed_pids':[],'remaining':[]}
            row['ended_utc']=datetime.now(timezone.utc).isoformat()
            if not row['cleanup']['verified']:
                row['terminal_status'] = 'failed'
                row['unknown_reason'] = 'cleanup_not_verified'
    return row


def sample_http(info, workload, directory, arm, warmups, repetitions, result=None):
    result = [] if result is None else result
    for case in workload:
        for index in range(-warmups, repetitions):
            observed_start=time.monotonic_ns()
            request_id = f"{arm}:{case['id']}:{index}"
            row = {'arm': arm, 'case_id': case['id'], 'repeat': index,
                   'warmup': index < 0, 'terminal_status': 'failed',
                   'server_response_ms': None, 'persistence_complete_ms': None,
                   'transaction_ms': None, 'queue_ms': None,
                   'durability_observed_ms': None, 'unknown_reason': None}
            try:
                response = request(info, case['path'], case['method'], case.get('body'), request_id,
                                   headers=case.get('headers'))
                row['status'] = response['status']
                row['client_response_ms'] = response['client_response_ms']
                row['response_sha256'] = hashlib.sha256(json.dumps(response['body'],sort_keys=True).encode()).hexdigest()
                business_error=None
                if response['status'] != 200:
                    row['http_error_code'] = response['body'].get('error')
                    row['http_error_reason'] = response['body'].get('reason')
                    business_error='http_status_' + str(response['status'])
                if not business_error and case.get('expected_contact_count') is not None:
                    contacts=response['body'].get('contacts',[])
                    if len(contacts)!=case['expected_contact_count'] or case['required_contact_id'] not in {c.get('contact_id') for c in contacts}:
                        business_error='synthetic_contact_scope_mismatch'
                if not business_error and any(response['body'].get(k)!=v for k,v in case.get('expected',{}).items()):
                    business_error='synthetic_business_output_mismatch'
                if case.get('write') and not business_error:
                    readback = request(info, case['verify_path'].format(**response['body']),headers=case.get('headers'))
                    row['durability_observed_ms'] = (readback['ended_ns']-response['started_ns'])/1e6
                    if readback['status'] != 200:
                        business_error='durability_readback_failed'
                    else:
                        row['durability_verified'] = True
                deadline = time.monotonic() + 1
                matches = []
                while time.monotonic() < deadline:
                    trace = directory/'trace.jsonl'
                    if trace.exists():
                        values = []
                        for line in trace.read_text().splitlines():
                            try:
                                values.append(json.loads(line))
                            except ValueError:
                                pass
                        matches = [v for v in values if v.get('type')=='http' and
                                   v.get('request_id')==request_id and v.get('pid')==info['pid']]
                        if matches:
                            break
                    time.sleep(.005)
                if len(matches) != 1:
                    raise ValueError('server_boundary_unknown')
                for key in ('server_response_ms','persistence_complete_ms','transaction_ms','queue_ms'):
                    row[key] = matches[0].get(key)
                commits = [v for v in values if v.get('request_id')==request_id and v.get('persistence_complete_ns')]
                if commits:
                    # Node/Python 同机 monotonic 时钟；代理提交与入口响应保持各自边界。
                    last_commit = max(v['persistence_complete_ns'] for v in commits)
                    elapsed = (last_commit-matches[0]['ingress_ns'])/1e6
                    if not 0 <= elapsed <= row['server_response_ms'] + 1:
                        raise ValueError('cross_process_monotonic_boundary_invalid')
                    row['persistence_complete_ms'] = elapsed
                    row['transaction_ms'] = sum(v.get('transaction_ms') or 0 for v in commits)
                    row['commit_processes'] = sorted({v['pid'] for v in commits})
                if case.get('write') and row['persistence_complete_ms'] is None:
                    business_error=business_error or 'commit_boundary_unknown'
                if business_error:
                    raise ValueError(business_error)
                row['terminal_status'] = 'succeeded'
            except Exception as error:
                row['observed_until_failure_ms']=(time.monotonic_ns()-observed_start)/1e6
                if isinstance(error,TimeoutError):
                    row['timeout_lower_bound_ms']=row['observed_until_failure_ms']
                row['unknown_reason'] = type(error).__name__ + ':' + str(error)
            result.append(row)
    return result


def environment_binding(plan):
    return {'system': platform.system(), 'release': platform.release(), 'architecture': platform.machine(),
            'machine_sha256': hashlib.sha256(platform.node().encode()).hexdigest(),
            'python_version': subprocess.check_output([plan['python'],'--version'],text=True).strip(),
            'node_version': subprocess.check_output([plan['node'],'--version'],text=True).strip(),
            'power': subprocess.run(['pmset','-g','batt'],capture_output=True,text=True,timeout=3).stdout,
            'loadavg': os.getloadavg(), 'cpu_count': os.cpu_count(),
            'process_concurrency': 1, 'os_cold_cache_claimed': False}


def verify_binding(plan):
    binding = plan['binding']
    old = digest_files(Path(plan['old']))['sha256'] == binding['old_source']['sha256']
    source = Path(plan['new'])
    new = digest_files(source,[source/p for p in binding['new_source']['files']])['sha256'] == binding['new_source']['sha256']
    dependencies = Path(plan['dependencies'])
    dependency = digest_files(dependencies,[dependencies/p for p in binding['dependencies']['files']])['sha256'] == binding['dependencies']['sha256']
    snapshot = sha(Path(plan['state'])/'synthetic.dump') == binding['snapshot_sha256']
    old_dependencies=True
    if binding.get('old_dependencies'):
        runtime=Path(plan['state'])/'old-runtime'
        old_dependencies=digest_files(runtime,[runtime/p for p in binding['old_dependencies']['files']])['sha256']==binding['old_dependencies']['sha256']
    tools=True
    if binding.get('tools'):
        tools=digest_files(HERE,[HERE/p for p in binding['tools']['files']])['sha256']==binding['tools']['sha256']
    workload=hashlib.sha256(json.dumps(plan['http_cases'],sort_keys=True).encode()).hexdigest()
    roles=hashlib.sha256(json.dumps(plan.get('runtime_environments',{}),sort_keys=True).encode()).hexdigest()
    return {'old_source':old, 'old_dependencies':old_dependencies,'new_source':new, 'dependencies':dependency, 'snapshot':snapshot,
            'tools':tools,'workload':workload==binding.get('workload_sha256',workload),
            'runtime_environments':roles==binding.get('runtime_environments_sha256',roles),
            'node_executable':sha(Path(plan['node']))==binding.get('node_executable_sha256',sha(Path(plan['node']))),
            'python_executable':sha(Path(plan['python']))==binding.get('python_executable_sha256',sha(Path(plan['python'])))}


def collect(plan, out, probe):
    out.mkdir(parents=True)
    checks = verify_binding(plan)
    if not all(checks.values()):
        raise ValueError('frozen_binding_changed')
    # 同机器的采样入口互斥。外部 App／测试占用仍由根会话串行调度。
    lock = open('/tmp/notalone-host-performance.lock','a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    run = {'kind':'probe' if probe else 'formal', 'planned_startups':2 if probe else 40,
           'startups':[], 'http':[], 'http_cases':plan['http_cases'],
           'physical_model_requests':0, 'network_denied_attempts':0,
           'binding_verified':False, 'binding_before':checks,
           'environment_before':environment_binding(plan),
           'electron':{'status':'not_sampled','reason':'离线宿主采样，不启动或操作 Electron。'},
           'sampling':{'rss_samples_per_start':2 if probe else 60,
                       'rss_interval_seconds':.25 if probe else 1,
                       'http_warmups_per_case':1 if probe else 10,
                       'http_scored_per_case':2 if probe else 30}}
    if plan.get('electron'):
        run['electron']={'status':'sampled_separately','root_pid':plan['electron']['pid']}
    elif plan.get('electron_absent'):
        if any(p['executable'].startswith(('Electron','NotAlone')) for p in process_table().values()):
            raise ValueError('electron_absence_not_verified')
        run['electron']={'status':'verified_absent','rss_kib':None,'reason':'采样前进程清单未发现 Electron／NotAlone；不虚构 0 RSS。'}
    binding = json.loads(json.dumps(plan['binding']))
    for key in ('old_source','old_dependencies','new_source','dependencies','tools'):
        if key not in binding:
            continue
        binding[key] = {'sha256':binding[key]['sha256'], 'file_count':len(binding[key]['files'])}
    run['binding'] = binding
    save(out/'run.json',run)
    owned_databases=[]
    try:
        # 全局严格 ABAB，旧／新各 20 次；每次都恢复同一份快照。
        schedule=[('startup',repeat,arm) for repeat in range(1 if probe else 20) for arm in ('old','new')]
        if not probe:
            schedule += [('http',0,arm) for arm in ('old','new')]
        for phase, repeat, arm in schedule:
            directory=out/f'{phase}-{repeat:02d}-{arm}'
            database='na_hostperf_'+uuid.uuid4().hex+'_test'
            clone(plan,database);owned_databases.append(database)
            try:
                spec=specification(plan,arm,directory,database)
                spec['electron']=plan.get('electron')
                row=sample_one(arm,spec,directory,2 if probe else 60 if phase=='startup' else 0,
                               .25 if probe else 1,25,repeat,
                               workload=plan['http_cases'] if probe or phase=='http' else None,
                               warmups=1 if probe else 10,repetitions=2 if probe else 30)
                row['phase']=phase
                cache=directory/'home/memory-embedding'
                row['model_cache_after']=digest_files(cache)
                import psycopg
                with psycopg.connect('host=/tmp dbname='+database) as connection:
                    counts=connection.execute('SELECT (SELECT count(*) FROM model_call_receipt),(SELECT count(*) FROM outbound_ledger_entry)').fetchone()
                row['model_operation_records']={'model_call_receipt':counts[0],'outbound_ledger_entry':counts[1]}
                if any(counts):
                    run['physical_model_requests']=None
                if phase=='startup':
                    run['startups'].append(row)
                else:
                    run.setdefault('http_hosts',[]).append(row)
                run['http']+=row.pop('http')
                trace=directory/'trace.jsonl'
                if trace.exists():
                    run['network_denied_attempts']+=sum(json.loads(line).get('type')=='network_denied' for line in trace.read_text().splitlines())
                if not row['cleanup']['verified']:
                    raise RuntimeError('cleanup_failed_stop_before_next_arm')
                if row['terminal_status']=='cancelled':
                    raise KeyboardInterrupt('host_performance_cancelled')
            finally:
                drop(database);owned_databases.remove(database)
                save(out/'run.json',run)
        run['binding_after']=verify_binding(plan)
        run['environment_after']=environment_binding(plan)
        if plan.get('electron_absent'):
            run['electron']['absence_after_verified']=not any(p['executable'].startswith(('Electron','NotAlone')) for p in process_table().values())
        run['binding_verified']=all(run['binding_after'].values()) and run['network_denied_attempts']==0
    finally:
        run['cleanup']={'owned_databases_remaining':len(owned_databases)}
        save(out/'run.json',run)
        save(out/'report.json',build_report(run))
        fcntl.flock(lock,fcntl.LOCK_UN);lock.close()


def self_test(out: Path, fail_new=False) -> None:
    out.mkdir(parents=True)
    spec = {'cwd': str(HERE), 'command': [sys.executable, str(HERE/'synthetic_host.py')],
            'environment': {'PATH': os.environ['PATH'], 'HOME': str(out), 'PYTHONDONTWRITEBYTECODE': '1'}}
    run = {'kind': 'sampler_self_test', 'planned_startups': 2, 'startups': [], 'physical_model_requests': 0}
    for arm in ('old', 'new'):
        selected={**spec,'environment':dict(spec['environment'])}
        if arm=='new' and fail_new:
            selected['environment']['NOTALONE_PERF_NEVER_READY']='1'
        row=sample_one(arm, selected, out/arm, 2, .1, 1 if fail_new else 5, 0)
        run['startups'].append(row)
        if row['terminal_status']=='cancelled':
            break
    save(out/'run.json', run)
    save(out/'report.json', build_report(run))


def main() -> int:
    def interrupted(_signum,_frame):
        for name in ('SIGINT','SIGTERM','SIGALRM'):
            signal.signal(getattr(signal,name),signal.SIG_IGN)
        raise KeyboardInterrupt('host_performance_interrupted')
    for name in ('SIGINT','SIGTERM','SIGALRM'):
        signal.signal(getattr(signal,name),interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    command = sub.add_parser('self-test')
    command.add_argument('--out', type=Path, required=True)
    command.add_argument('--fail-new', action='store_true')
    report = sub.add_parser('report')
    report.add_argument('--run', type=Path, required=True)
    report.add_argument('--out', type=Path, required=True)
    preparation = sub.add_parser('prepare')
    preparation.add_argument('--state', type=Path, required=True)
    preparation.add_argument('--python', default=sys.executable)
    preparation.add_argument('--node', default=shutil.which('node'))
    preparation.add_argument('--old-wheel-cache',type=Path)
    collection = sub.add_parser('collect')
    collection.add_argument('--plan', type=Path, required=True)
    collection.add_argument('--out', type=Path, required=True)
    mode=collection.add_mutually_exclusive_group(required=True)
    mode.add_argument('--probe', action='store_true')
    mode.add_argument('--formal', action='store_true')
    electron=collection.add_mutually_exclusive_group()
    electron.add_argument('--electron-pid',type=int)
    electron.add_argument('--electron-absent',action='store_true')
    collection.add_argument('--diagnostic', action='store_true')
    args = parser.parse_args()
    if args.action == 'self-test':
        self_test(args.out.resolve(),args.fail_new)
    elif args.action == 'report':
        save(args.out, build_report(json.loads(args.run.read_text())))
    elif args.action == 'prepare':
        prepare(args.state.resolve(),args.python,args.node,args.old_wheel_cache)
        print('合成快照与源码冻结完成。')
    elif args.action == 'collect':
        plan=json.loads(args.plan.read_text())
        if args.diagnostic and not args.probe:
            raise ValueError('diagnostic_requires_probe')
        plan['diagnostic']=args.diagnostic
        if args.formal and not (args.electron_pid or args.electron_absent):
            raise ValueError('formal_requires_electron_pid_or_verified_absence')
        if args.electron_pid:
            identity=process_table().get(args.electron_pid)
            if not identity or not identity['executable'].startswith(('Electron','NotAlone')):
                raise ValueError('electron_identity_not_verified')
            plan['electron']={'pid':args.electron_pid,'identity':identity['identity']}
        plan['electron_absent']=args.electron_absent
        collect(plan,args.out.resolve(),args.probe)
        print('采样结束；结论以 report.json 为准。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
