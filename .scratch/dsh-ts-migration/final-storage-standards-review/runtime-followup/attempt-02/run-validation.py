"""在捕获提交加六份冻结覆盖的私有快照内串行验证；不使用当前 WIP。"""
from pathlib import Path
import hashlib
import io
import json
import os
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time

os.umask(0o077)
repo = Path.cwd()
evidence = Path(__file__).resolve().parent
private = evidence / 'private'
private.mkdir(mode=0o700, exist_ok=False)
frozen = repo / '.scratch/dsh-ts-migration/final-storage-review-input-v1'
manifest_bytes = (frozen / 'manifest.json').read_bytes()
manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
assert manifest_sha == '3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb'
manifest = json.loads(manifest_bytes)
node = Path(os.environ['NOTALONE_REVIEW_NODE'])
python = Path(os.environ['NOTALONE_REVIEW_PYTHON'])
stage = Path(tempfile.mkdtemp(prefix='notalone-standards-input-v1-'))
stage.chmod(0o700)
started = time.monotonic()
deadline = started + 180
active = None
runs = []
created_names = set()
cleanup = {'owned_database_count_after': None, 'owned_activity_count_after': None,
           'owned_process_count_after': None, 'temporary_stage_exists_after': None}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def remaining(reserve=0):
    return max(0.1, deadline - time.monotonic() - reserve)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def run_capture(args, **kwargs):
    return subprocess.check_output(args, timeout=remaining(25), **kwargs)


env = {'PATH': f'{node.parent}:{python.parent}:/usr/bin:/bin:/usr/sbin:/sbin',
       'HOME': str(stage / 'home'), 'TMPDIR': str(stage / 'tmp'),
       'NOTALONE_DISABLE_DOTENV': '1', 'PYTHONDONTWRITEBYTECODE': '1',
       'PGHOST': '/tmp', 'PGPORT': '5432', 'PGDATABASE': 'postgres',
       'PGAPPNAME': 'notalone_standards_input_v1_probe'}
for name in ['home', 'tmp']:
    (stage / name).mkdir(mode=0o700)


def owned_database_cleanup():
    ownership = private / 'owned-databases.jsonl'
    if ownership.exists():
        for line in ownership.read_text().splitlines():
            record = json.loads(line)
            if record['operation'] == 'create':
                created_names.add(record['database'])
    script = '''import json,sys,psycopg
from psycopg import sql
names=json.loads(sys.argv[1])
assert all(name.startswith('notalone_ts_host_') and name.endswith('_test') for name in names)
with psycopg.connect('host=/tmp dbname=postgres connect_timeout=3',autocommit=True) as c:
 c.execute("SET statement_timeout='3000ms'")
 before=c.execute('SELECT datname FROM pg_database WHERE datname=ANY(%s)',[names]).fetchall()
 for (name,) in before:
  c.execute('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()',[name])
  c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))
 after=c.execute('SELECT count(*) FROM pg_database WHERE datname=ANY(%s)',[names]).fetchone()[0]
 activity=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=ANY(%s)',[names]).fetchone()[0]
print(json.dumps({'remaining_owned_databases_before_cleanup':len(before),'owned_database_count_after':after,'owned_activity_count_after':activity}))
'''
    raw = subprocess.check_output([str(python), '-c', script, json.dumps(sorted(created_names))],
                                  env=env, timeout=max(5, min(20, remaining())))
    result = json.loads(raw)
    cleanup.update(result)
    cleanup['owned_database_created_count'] = len(created_names)


try:
    paths = ['backend-ts/src', 'backend-ts/package.json',
             'backend-ts/pnpm-lock.yaml', 'backend-ts/test/host-storage-fixture.mjs',
             'backend-ts/test/business-transaction-errors.test.mjs',
             'backend/src/notalone', 'backend/database/migrations']
    archive = run_capture(['git', 'archive', '--format=tar', manifest['head_at_capture'], *paths])
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as stream:
        for member in stream.getmembers():
            assert not member.name.startswith('/') and '..' not in Path(member.name).parts
            assert member.isdir() or member.isfile()
        stream.extractall(stage)
    bindings = []
    for path in stage.rglob('*'):
        if path.is_dir():
            path.chmod(0o700)
        elif path.is_file():
            path.chmod(0o600)
            data = path.read_bytes()
            bindings.append({'path':str(path.relative_to(stage)), 'sha256':sha(data), 'bytes':len(data),
                             'origin':'captured_commit'})
    for item in manifest['files']:
        data = (frozen / item['snapshot']).read_bytes()
        assert sha(data) == item['sha256'] and len(data) == item['bytes']
        path = stage / item['path']
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(data)
        path.chmod(0o600)
        bindings = [entry for entry in bindings if entry['path'] != item['path']]
        bindings.append({'path':item['path'],'sha256':sha(data),'bytes':len(data),'origin':'frozen_six_files'})
    (stage / 'backend-ts/node_modules').symlink_to(repo / 'backend-ts/node_modules', target_is_directory=True)
    wrapper = stage / 'fixture-python'
    wrapper.write_text(f'''#!{python}
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
if len(args)>=3 and args[0]=='-c':
 name=args[2]
 if name.startswith('notalone_ts_host_') and name.endswith('_test'):
  operation='create' if 'CREATE DATABASE' in args[1] else 'drop' if 'DROP DATABASE' in args[1] else 'other'
  with open({str(private / 'owned-databases.jsonl')!r},'a') as stream:
   stream.write(json.dumps({{'operation':operation,'database':name}})+'\\n')
os.execv({str(python)!r},[{str(python)!r},*args])
''')
    wrapper.chmod(0o700)
    env['NOTALONE_TEST_PYTHON'] = str(wrapper)
    versions = {'node':run_capture([str(node), '--version'], env=env).decode().strip(),
                'python':run_capture([str(python), '--version'], env=env).decode().strip()}
    dependency_bindings = []
    pg = repo / 'backend-ts/node_modules/pg'
    pool = pg.resolve().parent / 'pg-pool'
    for logical,path in [('pg/package.json',pg/'package.json'),('pg/lib/client.js',pg/'lib/client.js'),
                         ('pg/lib/query.js',pg/'lib/query.js'),('pg-pool/package.json',pool/'package.json'),
                         ('pg-pool/index.js',pool/'index.js')]:
        dependency_bindings.append({'logical_path':logical,'sha256':sha(path.read_bytes())})
    write_json(evidence / 'runtime-input-binding.json', {'base_commit':manifest['base_commit'],
        'head_at_capture':manifest['head_at_capture'],'input_manifest_sha256':manifest_sha,
        'snapshot_files':sorted(bindings,key=lambda item:item['path']),
        'installed_dependency_bindings':dependency_bindings,'versions':versions,
        'environment':'allowlist，synthetic HOME/TMPDIR，禁用 dotenv，未继承实际业务配置'})
    write_json(private / 'owned-resources.json', {'stage':str(stage),'controller_pid':os.getpid()})
    phases = [
        ('single-native-query-contract', 'test/business-transaction-errors.test.mjs', '^pg 成功重载保留'),
        ('related-native-error-read-transaction', 'test/business-transaction-errors.test.mjs',
         '^(业务 NotFound|真实 PostgreSQL 查询失败|pg |配置内回调|排队的配置|toPostgres|Query |只读事务|提交阶段|事务连接|连接尚未|取消原因|关闭排空)'),
        ('related-storage-lease-schema', 'test/host-storage.test.mjs',
         '^(原账本及116|035接管|每次业务读取|暖读后SQL文件|连续本机|并发业务|租约撤销后|空闲连接被终止|Client链式|仅持有空闲|catalog限定|复用连接逐次|暖读后的数据库)'),
    ]
    for label,file,pattern in phases:
        log = private / f'{label}.raw.log'
        command = [str(node),'--test','--test-concurrency=1','--test-reporter=tap',f'--test-name-pattern={pattern}',file]
        tick = time.monotonic()
        print(json.dumps({'phase':label,'state':'running'},ensure_ascii=False),flush=True)
        with log.open('wb') as output:
            active = subprocess.Popen(command,cwd=stage/'backend-ts',env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                code = active.wait(timeout=remaining(25))
            except subprocess.TimeoutExpired:
                os.killpg(active.pid,signal.SIGTERM)
                try:active.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(active.pid,signal.SIGKILL);active.wait(timeout=3)
                code = 124
            active = None
        raw = log.read_bytes()
        text = raw.decode(errors='replace')
        public = re.sub(r'/Users/[^\s\]\[()\"\'<>]+','<私有路径>',text)
        public = public.replace(str(stage),'<私有运行快照>')
        public = re.sub(r'notalone_ts_host_[a-f0-9]{32}_test','<本轮合成_test库>',public)
        public_log = evidence / f'{label}.public.log'
        public_log.write_text(public)
        metrics = {key:int(value) for key,value in re.findall(r'^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$',text,re.M)}
        result = {'phase':label,'returncode':code,'elapsed_seconds':round(time.monotonic()-tick,3),
                  'metrics':metrics,'raw_sha256':sha(raw),'public_sha256':sha(public.encode()),
                  'raw_log':f'private/{log.name}','public_log':public_log.name}
        runs.append(result)
        print(json.dumps(result,ensure_ascii=False),flush=True)
        if code != 0:break
    for item in manifest['files']:
        assert sha((stage/item['path']).read_bytes()) == item['sha256']
        assert sha((frozen/item['snapshot']).read_bytes()) == item['sha256']
except BaseException as error:
    write_json(private / 'controller-error.json',{'type':type(error).__name__,'message':str(error)})
    print(json.dumps({'controller_error':type(error).__name__},ensure_ascii=False),flush=True)
finally:
    if active is not None:
        try:os.killpg(active.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        active.wait(timeout=3)
    try:owned_database_cleanup()
    except BaseException as error:
        write_json(private/'cleanup-error.json',{'type':type(error).__name__,'message':str(error)})
        cleanup['cleanup_error_type'] = type(error).__name__
    process_rows = subprocess.check_output(['ps','-axo','pid=,ppid=,command='],text=True)
    owned_processes = []
    for row in process_rows.splitlines():
        if str(stage) in row and int(row.strip().split(None,1)[0]) != os.getpid():owned_processes.append(row)
    write_json(private/'process-check.json',{'owned_process_rows':owned_processes})
    cleanup['owned_process_count_after'] = len(owned_processes)
    if not owned_processes:
        shutil.rmtree(stage)
    cleanup['temporary_stage_exists_after'] = stage.exists()
    cleanup['owned_temporary_directory_count_after'] = 1 if stage.exists() else 0
    result = {'input_manifest_sha256':manifest_sha,'head_at_capture':manifest['head_at_capture'],
              'final_commit':None,'runs':runs,'cleanup':cleanup,'elapsed_seconds':round(time.monotonic()-started,3),
              'overall_gate':'not_approved','tests_are_independent_execution':True}
    write_json(evidence/'runtime-result.json',result)
    print(json.dumps({'result':'complete','runs':len(runs),'cleanup':cleanup,'elapsed_seconds':result['elapsed_seconds']},ensure_ascii=False),flush=True)
