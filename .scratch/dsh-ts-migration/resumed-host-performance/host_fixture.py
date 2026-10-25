"""仓库外的冻结源码、合成快照与只属于本轮的 PostgreSQL 克隆。"""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid
from legacy_runtime import prepare_legacy_runtime

OLD = '3c168296e9e8edaa43b8b323ff693e790e709069'
DSH = '687f282e8625c6b8d11ff58211a90524be2e4317'
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OWNER = '10200000-0000-4000-8000-000000000001'
CONTACT = '10200000-0000-4000-8000-000000000002'


def digest_files(root: Path, paths=None):
    files = paths or [p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and '.pyc' != p.suffix]
    items = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
    digest = hashlib.sha256(json.dumps(items,sort_keys=True).encode()).hexdigest()
    return {'sha256': digest, 'files': items}


def clean_environment(home: Path):
    return {'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'zh_CN.UTF-8', 'TZ': 'Asia/Taipei',
            'NOTALONE_DISABLE_DOTENV': '1', 'PYTHON_DOTENV_DISABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1',
            'DSH_TELEMETRY_DISABLED': '1'}


def prepare(state: Path, python: str, node: str, old_wheel_cache: Path | None = None):
    if state.exists():
        raise ValueError('state_directory_must_be_new')
    state.mkdir(parents=True,mode=0o700)
    old, new = state/'old', state/'new'
    old.mkdir();new.mkdir()
    archive = subprocess.run(['git','archive',OLD,'backend/src','backend/database','backend/pyproject.toml',
                              'desktop/scripts/runtime/requirements.lock','desktop/scripts/runtime/python-wheels.lock.json'],
                             cwd=ROOT,capture_output=True,check=True,timeout=20)
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as stream:
        stream.extractall(old, filter='data')
    # 新臂只归档同一提交的 Node 代码和 SQL，不携带将被26移除的 Python。
    new_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    source_paths = ['backend/database','backend-ts/src','backend-ts/profile',
                    'backend-ts/package.json','backend-ts/pnpm-lock.yaml']
    archive = subprocess.run(['git','archive',new_commit,*source_paths],cwd=ROOT,
                             capture_output=True,check=True,timeout=20)
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as stream:
        stream.extractall(new, filter='data')
    (new/'backend-ts/node_modules').symlink_to(ROOT/'backend-ts/node_modules',target_is_directory=True)
    # 第三方闭包实际字节冻结为摘要，正式运行前后复核；不复制 855 MiB 依赖。
    dependencies = ROOT/'backend-ts/node_modules'
    versions={name:json.loads((dependencies/'@deepseek-ai'/name/'package.json').read_text())['version']
              for name in ('dsh','dsh-llm','dsh-agent','dsh-scope','dsh-session','dsh-tools','dsh-skill')}
    if any(version!='0.2.1-rc.2' for version in versions.values()):
        raise ValueError('locked_dsh_version_mismatch')
    dependency_files = [p for p in dependencies.rglob('*') if p.is_file() and not p.is_symlink()]
    dependency = digest_files(dependencies,dependency_files)
    snapshot=state/'synthetic.dump'
    env=clean_environment(state)
    python,old_runtime=prepare_legacy_runtime(state,old,python,env,
        old_wheel_cache or ROOT/'desktop/artifacts/runtime-sources')
    old_runtime['source_commit']=OLD
    database='na_hostperf_'+uuid.uuid4().hex+'_test'
    import psycopg
    from psycopg import sql
    with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as connection:
        connection.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(database)))
    try:
        schema_config=state/'schema.env'
        schema_config.write_text(f'NOTALONE_DATABASE_URL=host=/tmp dbname={database}\nNOTALONE_SKILLS_DIR={state}/schema-skills\n')
        schema_config.chmod(0o600)
        prepared=subprocess.run([node,str(new/'backend-ts/src/schema-prepare-cli.ts'),
            '--migrations',str(new/'backend/database/migrations'),'--prepare'],
            env={**env,'NOTALONE_ENV_FILE':str(schema_config),
                 'NOTALONE_DATABASE_URL':'host=/tmp dbname='+database},
            capture_output=True,text=True,timeout=60)
        (state/'schema-prepare.stderr.log').write_text(prepared.stderr)
        result=json.loads(prepared.stdout)
        if prepared.returncode or result.get('code')!='ready':
            raise RuntimeError('node_schema_prepare_not_ready:'+str(result.get('code')))
        with psycopg.connect('host=/tmp dbname='+database) as connection:
            for number in range(2):
                owner=OWNER if number==0 else '10200000-0000-4000-8000-000000000003'
                connection.execute('INSERT INTO owner(id,display_name) VALUES(%s,%s)',(owner,'合成本人'+str(number)))
                for contact_number in range(4):
                    contact=CONTACT if number==0 and contact_number==0 else str(uuid.uuid5(uuid.NAMESPACE_OID,f'hostperf-{number}-{contact_number}'))
                    connection.execute('INSERT INTO contact(id,owner_id,display_name) VALUES(%s,%s,%s)',(contact,owner,'合成联系人'+str(contact_number)))
                    connection.execute('INSERT INTO manual_contact_confirmation(owner_id,contact_id) VALUES(%s,%s)',(owner,contact))
            schema=connection.execute('SELECT name,checksum FROM notalone_schema_migration ORDER BY name').fetchall()
        pg_dump=shutil.which('pg_dump')
        if not pg_dump:
            raise RuntimeError('pg_dump_unavailable')
        subprocess.run([pg_dump,'--format=custom','--no-owner','--no-privileges','--file',str(snapshot),
                        'host=/tmp dbname='+database],check=True,capture_output=True,timeout=30)
    finally:
        with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as connection:
            connection.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(database)))
    # 私有 plan 承载绝对路径；公开摘要只含源码相对路径与哈希。
    plan={'version':'host-performance-v1','state':str(state),'python':python,'node':node,
          'old':str(old),'new':str(new),'dependencies':str(dependencies),'owner':OWNER,'contact':CONTACT,
          'runtime_environments':{'old':{},'new':{
              'NOTALONE_HOST_RUNTIME':'typescript','NOTALONE_REPLY_RUNTIME':'typescript',
              'NOTALONE_EXTRACTION_RUNTIME':'typescript','NOTALONE_HISTORY_RUNTIME':'typescript'}},
          'binding':{'old_commit':OLD,'new_commit':new_commit,
                     'dsh_commit':DSH,'dsh_version':'0.2.1-rc.2',
                     'installed_dsh_versions':versions,
                     'old_source':digest_files(old),
                     'old_runtime':old_runtime,'old_dependencies':digest_files(state/'old-runtime'),
                     'new_source':digest_files(new,[p for relative in source_paths for p in
                        ((new/relative).rglob('*') if (new/relative).is_dir() else [new/relative]) if p.is_file()]),
                     'dependencies':dependency,'snapshot_sha256':hashlib.sha256(snapshot.read_bytes()).hexdigest(),
                     'schema':schema,'material':{'owners':2,'contacts_per_owner':4,'sources':0,'messages':0,'model_work':0},
                     'cache':{'mode':'isolated-empty-home','model_requests':0,'embedding_work':0,
                              'weight_files':[],'weights_sha256':hashlib.sha256(b'').hexdigest()}},
          'http_cases':[{'id':'contacts','path':'/api/contacts','method':'GET','write':False,
                         'expected_contact_count':4,'required_contact_id':CONTACT},
                        {'id':'sources','path':f'/api/contacts/{CONTACT}/sources','method':'GET','write':False,
                         'expected':{'sources':[]}},
                        {'id':'session-default','path':f'/api/contacts/{CONTACT}/assistant-session/default',
                         'method':'POST','body':{},'write':True,
                         'headers':{'X-NotAlone-Manual-Contact':CONTACT},
                         'verify_path':f'/api/contacts/{CONTACT}/assistant-sessions/{{session_id}}'}]}
    plan['binding']['workload_sha256']=hashlib.sha256(json.dumps(plan['http_cases'],sort_keys=True).encode()).hexdigest()
    plan['binding']['runtime_environments']=plan['runtime_environments']
    plan['binding']['runtime_environments_sha256']=hashlib.sha256(json.dumps(plan['runtime_environments'],sort_keys=True).encode()).hexdigest()
    plan['binding']['configuration_sha256']=hashlib.sha256(json.dumps({
        'database':'same-synthetic-snapshot','owner':OWNER,'skills':'isolated-empty',
        'model_credentials':'absent','dotenv':'disabled','wechat':'isolated-no-authorization',
        'cache':plan['binding']['cache'],'workload_sha256':plan['binding']['workload_sha256'],
        'runtime_environments':plan['runtime_environments'],
    },sort_keys=True).encode()).hexdigest()
    plan['binding']['node_executable_sha256']=hashlib.sha256(Path(node).read_bytes()).hexdigest()
    plan['binding']['python_executable_sha256']=hashlib.sha256(Path(python).read_bytes()).hexdigest()
    plan['binding']['profile_sha256']=hashlib.sha256((new/'backend-ts/profile/host.patch.yml').read_bytes()).hexdigest()
    plan['binding']['lock_sha256']=hashlib.sha256((new/'backend-ts/pnpm-lock.yaml').read_bytes()).hexdigest()
    runtime=subprocess.check_output([python,'-c',
        'import importlib.metadata,json; print(json.dumps(sorted((d.metadata["Name"],d.version) for d in importlib.metadata.distributions())))'],
        env=clean_environment(state),text=True,timeout=10)
    plan['binding']['python_distributions_sha256']=hashlib.sha256(runtime.encode()).hexdigest()
    (state/'python-distributions.json').write_text(runtime)
    plan['binding']['tools']=digest_files(HERE,[p for p in HERE.iterdir() if p.suffix in ('.py','.mjs')])
    committed=subprocess.check_output(['git','ls-tree','-r','--format=%(objectname) %(path)',
        plan['binding']['new_commit'],'--',*source_paths],cwd=ROOT,text=True)
    blobs=dict((line.split(' ',1)[1],line.split(' ',1)[0]) for line in committed.splitlines())
    def git_blob(path):
        data=path.read_bytes()
        return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
    plan['binding']['new_source_matches_commit']=all(blobs.get(relative)==git_blob(new/relative)
        for relative in plan['binding']['new_source']['files'])
    (state/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
    (state/'plan.json').chmod(0o600)
    return plan


def clone(plan, name):
    assert name.startswith('na_hostperf_') and name.endswith('_test')
    import psycopg
    from psycopg import sql
    with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as connection:
        connection.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
    try:
        subprocess.run([shutil.which('pg_restore'),'--no-owner','--no-privileges','--exit-on-error',
                        '--dbname','host=/tmp dbname='+name,str(Path(plan['state'])/'synthetic.dump')],
                       check=True,capture_output=True,timeout=30)
    except BaseException:
        drop(name)
        raise


def drop(name):
    assert name.startswith('na_hostperf_') and name.endswith('_test')
    import psycopg
    from psycopg import sql
    with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as connection:
        connection.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))


def specification(plan, arm, folder, database):
    folder.mkdir(parents=True,exist_ok=True)
    home=folder/'home';home.mkdir()
    (home/'memory-embedding').mkdir()
    env=clean_environment(home)
    project=Path(plan[arm])
    trace=folder/'trace.jsonl'
    config=folder/'synthetic.env'
    config.write_text(f'NOTALONE_DATABASE_URL=host=/tmp dbname={database}\nNOTALONE_OWNER_ID={OWNER}\nNOTALONE_SKILLS_DIR={home}/skills\n')
    config.chmod(0o600)
    env.update({'NOTALONE_DATABASE_URL':'host=/tmp dbname='+database,'NOTALONE_OWNER_ID':OWNER,
                'NOTALONE_ENV_FILE':str(config),'NOTALONE_SKILLS_DIR':str(home/'skills'),
                'NOTALONE_WECHAT_CLI':str(home/'missing-wechat'), 'NOTALONE_PERF_TRACE':str(trace),
                'NOTALONE_MANAGED_USER_DATA':str(home),'NOTALONE_PERF_PROJECT':str(project),
                'NOTALONE_MEMORY_EMBEDDING_CACHE':str(home/'memory-embedding'),
                'NOTALONE_PERF_RUN':str(folder)})
    roles=plan['runtime_environments'][arm]
    env.update(roles)
    if arm=='old':
        env['PYTHONPATH']=str(HERE)+':'+str(project/'backend/src')
        env['PATH']=str(Path(plan['python']).parent)+':/usr/bin:/bin:/usr/sbin:/sbin'
    else:
        env['PATH']=str(Path(plan['node']).parent)+':/usr/bin:/bin:/usr/sbin:/sbin'
    with config.open('a') as stream:
        stream.write(''.join(f'{key}={value}\n' for key,value in sorted(roles.items())))
    if plan.get('diagnostic'):
        env['NOTALONE_PERF_DIAGNOSTIC']='1'
    command=([plan['python'],'-m','notalone.server.command','--parent-pid',str(os.getpid())] if arm=='old' else
             [plan['node'],str(HERE/'new-host.mjs')])
    return {'cwd':str(home),'command':command,'environment':env,'ready_path':'/api/contacts',
            'ready_contact_id':CONTACT,'ready_contact_count':4}
