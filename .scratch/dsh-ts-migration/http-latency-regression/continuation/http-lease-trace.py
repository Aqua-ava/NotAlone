#!/usr/bin/env python3
"""固定合成快照、单并发、两个成对 before/after HTTP 诊断；不认证总体性能。"""
from pathlib import Path
import hashlib, importlib.util, json, math, os, shutil, statistics, subprocess, sys, tempfile, time, uuid, io, tarfile

os.umask(0o077)
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
TOOLS = REPO/'.scratch/dsh-ts-migration/resumed-host-performance'
sys.path.insert(0, str(TOOLS))
from host_fixture import clone, drop, specification, digest_files
from host_perf import request, handshake, cleanup, environment_binding
import psycopg
from psycopg import sql

STATE = Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE'])
plan = json.loads((STATE/'plan.json').read_text())
work = Path(tempfile.mkdtemp(prefix='notalone-http-latency-'))
output = {'diagnostic_only':True,'formal_performance_qualified':False,'concurrency':1,'warmups_per_case':10,'scored_per_case_per_arm':30,'startups_and_rss_formal_protocol_not_executed':True,'rows':[],'hosts':[],'source_bindings':{},'cleanup':{}}
owned = set()

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(name,value):
    path=HERE/name
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    path.chmod(0o600)
def binding_check():
    result={}
    for name,root in [('old_source',Path(plan['old'])),('new_source',Path(plan['new'])),('dependencies',Path(plan['dependencies'])),('old_dependencies',STATE/'old-runtime')]:
        source=plan['binding'][name]
        result[name]=digest_files(root,[root/p for p in source['files']])['sha256']==source['sha256']
    result['snapshot']=sha(STATE/'synthetic.dump')==plan['binding']['snapshot_sha256']
    result['node']=sha(plan['node'])==plan['binding']['node_executable_sha256']
    result['python']=sha(plan['python'])==plan['binding']['python_executable_sha256']
    result['tools']=all(sha(TOOLS/name)==checksum for name,checksum in plan['binding']['tools']['files'].items())
    return result

def trace_rows(folder):
    path=folder/'trace.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def safe_logs(phase,arm,folder):
    for name in ['host.stdout.log','host.stderr.log','trace.jsonl']:
        path=folder/name
        if not path.exists(): continue
        raw=path.read_bytes()
        text=raw.decode(errors='replace').replace(str(work),'<owned-work>').replace(str(STATE),'<frozen-state>').replace(str(REPO),'<repo>')
        text=text.replace(str(Path.home()),'<user-home>')
        dest=HERE/f'lease-trace-{phase}-{arm}-{name}'
        dest.write_text(text)
        dest.chmod(0o600)
        output.setdefault('raw_log_sha256',{})[f'{phase}/{arm}/{name}']=hashlib.sha256(raw).hexdigest()

def sample(phase,arm,project):
    name='na_hostperf_'+uuid.uuid4().hex+'_test'
    clone(plan,name)
    owned.add(name)
    folder=work/f'{phase}-{arm}'
    local_plan={**plan,arm:str(project)}
    spec=specification(local_plan,arm,folder,name)
    if arm=='new': spec['command']=[plan['node'],str(HERE/'http-lease-instrumentation/new-host.mjs')]
    else: spec['environment']['PYTHONPATH']=str(HERE/'http-lease-instrumentation')+':'+str(project/'backend/src')
    spec['environment'].pop('NOTALONE_PERF_DIAGNOSTIC',None)
    for key in ['command','cwd']:
        if isinstance(spec[key],list): spec[key]=[str(v).replace('{run}',str(folder)) for v in spec[key]]
        else: spec[key]=str(spec[key]).replace('{run}',str(folder))
    spec['environment']['NOTALONE_BACKEND_INFO']=str(folder/'backend.info')
    host={'phase':phase,'arm':arm,'terminal_status':'failed','sample_count':0}
    child=None
    info=None
    try:
        with (folder/'host.stdout.log').open('w') as stdout,(folder/'host.stderr.log').open('w') as stderr:
            child=subprocess.Popen(spec['command'],cwd=spec['cwd'],env=spec['environment'],stdin=subprocess.PIPE,stdout=stdout,stderr=stderr,start_new_session=True)
            deadline=time.monotonic()+25
            while time.monotonic()<deadline:
                if child.poll() is not None: raise RuntimeError('host_exited_before_ready')
                try:
                    info=handshake(folder/'backend.info')
                    response=request(info,'/api/contacts',timeout=1)
                    contacts=response['body'].get('contacts',[])
                    if response['status']==200 and len(contacts)==4 and plan['contact'] in {c.get('contact_id') for c in contacts}: break
                except (OSError,ValueError,KeyError): pass
                time.sleep(.025)
            else: raise TimeoutError('business_ready_timeout')
            for case in plan['http_cases']:
                for index in range(-10,30):
                    row={'phase':phase,'arm':arm,'case_id':case['id'],'repeat':index,'warmup':index<0,'terminal_status':'failed'}
                    started=time.monotonic_ns()
                    try:
                        request_id=f'{phase}:{arm}:{case["id"]}:{index}'
                        result=request(info,case['path'],case['method'],case.get('body'),request_id,headers=case.get('headers'))
                        row.update(status=result['status'],client_response_ms=result['client_response_ms'],response_sha256=hashlib.sha256(json.dumps(result['body'],sort_keys=True).encode()).hexdigest())
                        if result['status']!=200: raise RuntimeError('http_status_'+str(result['status']))
                        if case.get('expected_contact_count') is not None:
                            contacts=result['body'].get('contacts',[])
                            if len(contacts)!=case['expected_contact_count'] or case['required_contact_id'] not in {c.get('contact_id') for c in contacts}: raise RuntimeError('contact_scope_mismatch')
                        if any(result['body'].get(k)!=v for k,v in case.get('expected',{}).items()): raise RuntimeError('business_output_mismatch')
                        if case.get('write'):
                            back=request(info,case['verify_path'].format(**result['body']),headers=case.get('headers'))
                            row.update(durability_verified=back['status']==200,durability_observed_ms=(back['ended_ns']-result['started_ns'])/1e6)
                            if not row['durability_verified']: raise RuntimeError('durability_readback_failed')
                        matches=[v for v in trace_rows(folder) if v.get('type')=='http' and v.get('request_id')==request_id and v.get('pid')==info['pid']]
                        if len(matches)!=1: raise RuntimeError('server_boundary_unknown')
                        row['server_response_ms']=matches[0]['server_response_ms']
                        row['terminal_status']='succeeded'
                    except Exception as error:
                        row['observed_until_failure_ms']=(time.monotonic_ns()-started)/1e6
                        row['unknown_reason']=type(error).__name__+':'+str(error).replace(str(work),'<owned-work>')
                    output['rows'].append(row)
            host['terminal_status']='succeeded'
            host['sample_count']=120
    except Exception as error:
        host['unknown_reason']=type(error).__name__+':'+str(error).replace(str(work),'<owned-work>')
    finally:
        host['cleanup']=cleanup(child,{},info['pid'] if info else None) if child else {'verified':True,'remaining':[]}
        with psycopg.connect('host=/tmp dbname='+name) as connection:
            counts=connection.execute('SELECT (SELECT count(*) FROM model_call_receipt),(SELECT count(*) FROM outbound_ledger_entry)').fetchone()
        host['model_records']={'model_call_receipt':counts[0],'outbound_ledger_entry':counts[1]}
        host['network_denied_attempts']=sum(v.get('type')=='network_denied' for v in trace_rows(folder))
        host['model_cache_files']=sum(p.is_file() for p in (folder/'home/memory-embedding').rglob('*'))
        safe_logs(phase,arm,folder)
        if not host['cleanup']['verified']: raise RuntimeError('owned_process_cleanup_failed')
        drop(name)
        owned.remove(name)
        output['hosts'].append(host)
        save('http-lease-trace-progress.json',output)

def instrument(path):
    value=path.read_text()
    prefix="""const storageDiagnostic = (label,ms=0,detail) => {const state=globalThis[Symbol.for('notalone.http.storage.context')]?.getStore();if(state){state.storage_counts[label]=(state.storage_counts[label]??0)+1;state.storage_times[label]=(state.storage_times[label]??0)+ms;if(detail!==undefined)(state.storage_details[label]??=[]).push(detail);}};
"""
    value=prefix+value
    value=value.replace("if (active && value && typeof value === 'object') reusable = false;", "if (active && value && typeof value === 'object') {storageDiagnostic('dirty:get:'+String(property));reusable=false;}")
    value=value.replace("if (active && (property !== 'query' || typeof args[0] !== 'string')) reusable = false;", "if (active && (property !== 'query' || typeof args[0] !== 'string')) {storageDiagnostic('dirty:method:'+String(property)+':'+typeof args[0]);reusable=false;}")
    value += """
for(const method of ['withClient','inspect','migrationFiles','acquireBusinessConnection','releaseBusinessConnection']) {
 const original=HostStorage.prototype[method];HostStorage.prototype[method]=function(...args){
  const start=performance.now();
  const before=this.idleBusinessConnection;
  const finish=(result)=>{storageDiagnostic(method,performance.now()-start,method==='acquireBusinessConnection'?{pid:result.client.processID,reused:before===result}:method==='releaseBusinessConnection'?{reusable:args[1],retained:this.idleBusinessConnection===args[0]}:undefined);return result;};
  const result=original.apply(this,args);
  return result&&typeof result.then==='function'?result.then(finish,error=>{storageDiagnostic(method+':error',performance.now()-start);throw error;}):finish(result);
 };
}
"""
    path.write_text(value)

try:
    output['binding_before']=binding_check()
    if not all(output['binding_before'].values()): raise RuntimeError('frozen_binding_mismatch')
    output['environment_before']=environment_binding(plan)
    base=work/'before-source';fixed=work/'after-source'
    base.mkdir();fixed.mkdir()
    source_base_commit='639eb2ce40169ff4d644670418644c0a28d35a0e'
    archive=subprocess.check_output(['git','archive',source_base_commit,'backend/database','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],cwd=REPO)
    for root in [base,fixed]:
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:stream.extractall(root,filter='data')
        (root/'backend-ts/node_modules').symlink_to(Path(plan['dependencies']),target_is_directory=True)
    target='backend-ts/src/host-storage.ts'
    shutil.copyfile(REPO/target,fixed/target)
    instrument(fixed/target)
    bound={str(p.relative_to(base)):sha(p) for p in base.rglob('*') if p.is_file() and 'node_modules' not in p.parts}
    for label,root in [('before',base),('after',fixed)]:
        digest=digest_files(root,[root/p for p in bound])
        output['source_bindings'][label]={'sha256':digest['sha256'],'files':digest['files'],'base_commit':source_base_commit,'host_storage_sha256':sha(root/target)}
    differing=[name for name in bound if sha(base/name)!=sha(fixed/name)]
    if differing != [target]: raise RuntimeError('unexpected_source_delta')
    output['changed_product_files']=differing
    output['snapshot_sha256']=plan['binding']['snapshot_sha256']
    output['workload_sha256']=plan['binding']['workload_sha256']
    output['dependencies_sha256']=plan['binding']['dependencies']['sha256']
    output['old_dependencies_sha256']=plan['binding']['old_dependencies']['sha256']
    output['runtime_environments']=plan['runtime_environments']
    output['connection_settings']={'endpoint':'local-unix-socket','sslmode':'prefer (socket no TLS)','concurrency':1,'same_settings_across_before_after_phases':True,'old_and_new_transaction_settings_identical':False,'isolation_new':'repeatable read / read only; writes unchanged','query_observation':'no pg/psycopg query patch; HTTP response boundary only','new_transaction_settings':['search_path=pg_catalog,public','statement_timeout=3000ms','lock_timeout=1000ms']}
    for phase,root in [('after',fixed)]:
        for arm,project in [('old',Path(plan['old'])),('new',root)]: sample(phase,arm,project)
    output['binding_after']=binding_check()
    output['source_unchanged_after']=all(digest_files(root,[root/p for p in bound])['sha256']==output['source_bindings'][label]['sha256'] for label,root in [('before',base),('after',fixed)])
    output['environment_after']=environment_binding(plan)
finally:
    for name in list(owned):
        drop(name)
        owned.remove(name)
    with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
        output['cleanup']['owned_databases_remaining']=c.execute('SELECT count(*) FROM pg_database WHERE datname=ANY(%s)',[list(owned)]).fetchone()[0] if owned else 0
    output['owned_artifacts']={str(p.relative_to(work)):sha(p) for p in work.rglob('*') if p.is_file() and 'node_modules' not in p.parts}
    shutil.rmtree(work)
    output['cleanup']['owned_work_directory_removed']=not work.exists()
    output['cleanup']['owned_processes_cleaned']=all(x['cleanup']['verified'] for x in output['hosts'])
    save('http-lease-trace.json',output)

summary={'diagnostic_only':True,'formal_performance_qualified':False,'cases':{},'successes':{},'regression_remaining':False}
def percentile(values,p):
    ordered=sorted(values);x=(len(ordered)-1)*p;lo=int(x);return ordered[lo]+(ordered[min(lo+1,len(ordered)-1)]-ordered[lo])*(x-lo)
for phase in ['after']:
    summary['successes'][phase]={arm:sum(row['terminal_status']=='succeeded' for row in output['rows'] if row['phase']==phase and row['arm']==arm) for arm in ['old','new']}
    for case in plan['http_cases']:
        key=case['id'];item=summary['cases'].setdefault(key,{})
        values={arm:[row['server_response_ms'] for row in output['rows'] if row['phase']==phase and row['arm']==arm and row['case_id']==key and not row['warmup'] and row['terminal_status']=='succeeded'] for arm in ['old','new']}
        if any(len(v)!=30 for v in values.values()): item[phase]={'qualified':False};continue
        p50={arm:statistics.median(v) for arm,v in values.items()};p95={arm:percentile(v,.95) for arm,v in values.items()}
        item[phase]={'n':{k:len(v) for k,v in values.items()},'p50_ms':p50,'p95_ms':p95,'p50_ratio':p50['new']/p50['old'],'p95_ratio':p95['new']/p95['old']}
        if phase=='after' and (item[phase]['p50_ratio']>1.1 or item[phase]['p95_ratio']>1.1):summary['regression_remaining']=True
summary['physical_model_requests']=sum(sum(h['model_records'].values()) for h in output['hosts'])
summary['all_bindings_verified']=all(output['binding_before'].values()) and all(output.get('binding_after',{}).values()) and output.get('source_unchanged_after',False)
summary['cleanup']=output['cleanup']
summary['no_pg_query_patch']=True
save('http-lease-trace-summary.json',summary)
print(json.dumps(summary,ensure_ascii=False))
if len(output['rows'])!=240 or any(row['terminal_status']!='succeeded' for row in output['rows']) or not summary['all_bindings_verified']:sys.exit(2)
