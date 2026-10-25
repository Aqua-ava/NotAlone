#!/usr/bin/env python3
"""一次合成 SQL 分段测量；不启动产品、不建立新的性能门槛。"""
from pathlib import Path
import ast
import hashlib
import json
import os
import re
import signal
import statistics
import subprocess
import time
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

os.umask(0o077)
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
STATE = Path.home()/'.local/state/notalone/diagnostics/migration-resume-20261025/host-perf-e5d-probe-state'
CONTINUATION = REPO/'.scratch/dsh-ts-migration/http-latency-regression/continuation'
OLD = '3c168296e9e8edaa43b8b323ff693e790e709069'
FILES = ['backend-ts/src/contact-context.ts', 'backend-ts/src/pure-ts-public-api.ts',
         'backend-ts/src/pure-ts-reply-scope.ts', 'backend-ts/src/assistant-discussion-service.ts',
         'backend-ts/src/host-plugin.ts', 'backend-ts/src/host-json.ts']
name = 'na_http_business_'+uuid.uuid4().hex+'_test'
started = time.monotonic()
report = {'diagnostic_only': True, 'formal_performance_qualified': False,
          'physical_model_requests': 0, 'http_requests': 0, 'concurrency': 1,
          'adapter': 'psycopg；两臂共用，含往返和解码，不代表 Node pg 解码',
          'warmups': 10, 'scored': 30, 'samples': [], 'plans': {}, 'cleanup': {},
          'loadavg_before': list(os.getloadavg()), 'window': 'root 与主作者已明确暂停其他诊断；跨库系统噪声未知'}
created = False
params = None
connection = None

def digest(value):
    return hashlib.sha256(value).hexdigest()

def old_file(path):
    return subprocess.check_output(['git', 'show', OLD+':'+path], cwd=REPO).decode()

def execute(query, values=()):
    begin = time.perf_counter_ns()
    cursor = connection.execute(query, values or None, prepare=False)
    rows = cursor.fetchall() if cursor.description else []
    return rows, (time.perf_counter_ns()-begin)/1e6

def begin_transaction():
    execute('BEGIN')
    for command in ("SET LOCAL search_path = pg_catalog, public", "SET LOCAL statement_timeout = '3000ms'", "SET LOCAL lock_timeout = '1000ms'"):
        execute(command)

def expire(_signal, _frame):
    raise TimeoutError('有限 SQL 诊断达到 110 秒上限')

signal.signal(signal.SIGALRM, expire)
signal.setitimer(signal.ITIMER_REAL, 110)
try:
    frozen = json.loads((STATE/'plan.json').read_text())
    assert frozen['binding']['old_commit'] == OLD
    source = (REPO/FILES[0]).read_text()
    production = json.loads((CONTINUATION/'http-production-03.json').read_text())
    hashes = {f: digest((REPO/f).read_bytes()) for f in FILES}
    assert all(h == production['source_bindings']['after']['files'][f] for f, h in hashes.items())
    report['source_sha256'] = hashes
    report['old_commit'] = OLD
    report['dump_sha256'] = digest((STATE/'synthetic.dump').read_bytes())
    assert report['dump_sha256'] == frozen['binding']['snapshot_sha256']
    valid_new = re.search(r'return `(EXISTS\(SELECT.*?)`;', source, re.S).group(1).replace('${alias}', 'm')
    contacts_new = re.search(r"if\(url.pathname==='/api/contacts'\).*?client.query\(`(.*?)`,\[owner\]", source, re.S).group(1)
    contacts_new = contacts_new.replace("${validMessageSource('m')}", valid_new).replace('$1', '%s')
    old_helper = old_file('backend/src/notalone/persistence/message_sources.py')
    valid_old = re.search(r'def valid_source_ref_exists_sql.*?return f"""(.*?)"""', old_helper, re.S).group(1).replace('{message_alias}', 'message')
    contacts_old = re.search(r'query = f"""(.*?)"""', old_file('backend/src/notalone/persistence/contact_directory.py'), re.S).group(1).replace('{message_source_exists}', valid_old)
    scope = re.search(r'async function scopeRevision.*?client.query\(`(.*?)`,\[owner,contact\]', source, re.S).group(1).replace('$1', '%s').replace('$2', '%s')
    sources = re.search(r"endsWith\('/sources'\).*?client.query\(`(.*?)`,\[owner,contact\]", source, re.S).group(1).replace('$1', '%s').replace('$2', '%s')
    old_tree = ast.parse(old_file('backend/src/notalone/persistence/source_tasks.py'))
    old_source_sql = next(node.args[0].value for node in ast.walk(old_tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'execute' and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) and 'SELECT source.id, source.file_name' in node.args[0].value)
    queries = {'contacts_old': contacts_old, 'contacts_new': contacts_new, 'scope_revision': scope, 'sources': sources, 'sources_old': old_source_sql}
    assert not any('${' in query for query in queries.values())
    (HERE/'measured-sql.json').write_text(json.dumps(queries, ensure_ascii=False, indent=2)+'\n')
    report['query_sha256'] = {k: digest(v.encode()) for k, v in queries.items()}
    settings = dict(line.split('=', 1) for line in (STATE/'schema.env').read_text().splitlines() if '=' in line)
    params = conninfo_to_dict(settings['NOTALONE_DATABASE_URL'].strip().strip('"').strip("'"))
    assert params.get('host') == '/tmp' and int(params.get('port', 5432)) == 5432
    params.update(dbname='postgres', application_name='na_http_business_admin')
    restore = Path(os.environ['NOTALONE_SQL_PG_RESTORE'])
    assert restore.is_absolute() and restore.is_file()
    report['pg_restore_sha256'] = digest(restore.read_bytes())
    with psycopg.connect(**params, autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        created = True
    environment = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    for key, value in params.items():
        target = {'host': 'PGHOST', 'port': 'PGPORT', 'user': 'PGUSER', 'password': 'PGPASSWORD', 'sslmode': 'PGSSLMODE'}.get(key)
        if target:
            environment[target] = str(value)
    environment.update(PGDATABASE=name, PGAPPNAME='na_http_business_restore')
    result = subprocess.run([str(restore), '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', name, str(STATE/'synthetic.dump')], env=environment, capture_output=True, timeout=45)
    if result.returncode:
        (HERE/'private/restore.stderr').write_bytes(result.stderr)
        raise RuntimeError('合成 dump 恢复失败；原日志留私有目录')
    connection = psycopg.connect(**{**params, 'dbname': name, 'application_name': 'na_http_business_sql'}, autocommit=True)
    owner, contact = frozen['owner'], frozen['contact']
    report['transaction_isolation'] = execute('SHOW default_transaction_isolation')[0][0][0]
    report['same_database_other_active_before'] = execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'")[0][0][0]
    baseline = None
    for index in range(-10, 30):
        order = ['old', 'new'] if index % 2 == 0 else ['new', 'old']
        for arm in order:
            begin_transaction()
            rows, elapsed = execute(queries['contacts_'+arm], (owner,))
            execute('COMMIT')
            normalized = [(str(row[0]), row[1], int(row[2]), int(row[3])) for row in rows] if arm == 'old' else [(str(row[0]), row[1], row[2]['message_count'], row[2]['source_count']) for row in rows]
            canonical = digest(json.dumps(normalized, sort_keys=True).encode())
            baseline = baseline or canonical
            assert canonical == baseline and len(rows) == 4
            report['samples'].append({'case': 'contacts', 'arm': arm, 'repeat': index, 'warmup': index < 0, 'query_ms': elapsed, 'rows': len(rows), 'normalized_sha256': canonical})
    lock = 'SELECT pg_advisory_xact_lock(hashtextextended(%s,0))'
    phases = [('revision_before', scope, (owner, contact)), ('contact_lock', lock, (f'contact:{owner}:{contact}',)), ('owner_lock', lock, (f'owner:{owner}',)), ('revision_after_lock', scope, (owner, contact)), ('sources_select', sources, (owner, contact)), ('revision_after_result', scope, (owner, contact))]
    for index in range(-10, 30):
        begin_transaction()
        records = []
        revisions = []
        for label, query, values in phases:
            rows, elapsed = execute(query, values)
            records.append({'phase': label, 'query_ms': elapsed, 'rows': len(rows)})
            if label.startswith('revision_'):
                revisions.append(rows)
            if label == 'sources_select':
                assert not rows
        assert len(revisions[0]) == 1 and revisions[0] == revisions[1] == revisions[2]
        execute('COMMIT')
        report['samples'].append({'case': 'sources', 'arm': 'new', 'repeat': index, 'warmup': index < 0, 'phases': records, 'revisions_equal': True, 'query_ms': sum(v['query_ms'] for v in records)})
    for label, values in [('contacts_old', (owner,)), ('contacts_new', (owner,)), ('scope_revision', (owner, contact)), ('sources', (owner, contact)), ('sources_old', (owner, contact))]:
        begin_transaction()
        plan_rows, elapsed = execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+queries[label], values)
        execute('COMMIT')
        serialized = re.sub(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', '<synthetic-id>', json.dumps(plan_rows[0][0]))
        report['plans'][label] = {'explain_call_ms': elapsed, 'plan': json.loads(serialized)}
    report['same_database_other_active_after'] = execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'")[0][0][0]
    report['source_unchanged'] = all(digest((REPO/f).read_bytes()) == h for f, h in hashes.items())
    assert report['source_unchanged']
    report['status'] = 'succeeded'
except BaseException as error:
    report['status'] = 'failed'
    report['error_type'] = type(error).__name__
    (HERE/'private/error.txt').write_text(str(error))
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    if connection is not None:
        connection.close()
    if created:
        try:
            assert name.startswith('na_http_business_') and name.endswith('_test')
            with psycopg.connect(**params, autocommit=True) as admin:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                report['cleanup']['database_absent'] = not bool(admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone())
                report['cleanup']['database_sessions_after'] = admin.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s', (name,)).fetchone()[0]
        except BaseException as error:
            report['cleanup']['database_absent'] = False
            report['cleanup']['error_type'] = type(error).__name__
    report['cleanup']['connection_closed'] = connection is None or connection.closed
    report['elapsed_seconds'] = time.monotonic()-started
    report['loadavg_after'] = list(os.getloadavg())
    (HERE/'sql-measurement.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k: report.get(k) for k in ('status', 'error_type', 'elapsed_seconds', 'cleanup')}, ensure_ascii=False))
