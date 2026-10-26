"""一次有界、完整宿主480样本诊断；原始输出从开始仅写私有子树。"""
from pathlib import Path
import os, sys, json, hashlib, subprocess, time, signal, statistics, pwd, shutil
os.umask(0o077);sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[3]
PRIVATE=Path(os.environ['NOTALONE_BOUNDARY_PRIVATE'])/'run-v1'
STATE=Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE'])
TOOLS=REPO/'.scratch/dsh-ts-migration/resumed-host-performance'
ORIGINAL=REPO/'.scratch/dsh-ts-migration/http-latency-regression/continuation/http-production-instrumentation'
sys.path.insert(0,str(TOOLS))
from host_fixture import digest_files, specification
from host_perf import request, handshake, cleanup, environment_binding
import psycopg
from psycopg import sql
plan=json.loads((STATE/'plan.json').read_text())
control_user=pwd.getpwuid(os.getuid()).pw_name
os.environ['PGUSER']=control_user
os.environ['PATH']=str(Path(os.environ['NOTALONE_CONTROL_PG_RESTORE']).parent)+':'+str(Path(plan['node']).parent)+':'+os.environ['PATH']
START=time.monotonic();deadline=START+150
class BodyDeadline(Exception):pass
def expired(*_):raise BodyDeadline('bounded_work_deadline')
signal.signal(signal.SIGALRM,expired)
def check_budget():
 if time.monotonic()>=deadline:raise BodyDeadline('bounded_work_deadline')
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
def connect(db='postgres',autocommit=False):return psycopg.connect(host='/tmp',dbname=db,user=control_user,autocommit=autocommit,connect_timeout=3,options='-c statement_timeout=3000')
def bindings():
 result={}
 for key,root in [('old_source',Path(plan['old'])),('new_source',Path(plan['new'])),('dependencies',Path(plan['dependencies'])),('old_dependencies',STATE/'old-runtime')]:
  b=plan['binding'][key];result[key]=digest_files(root,[root/p for p in b['files']])['sha256']==b['sha256']
 for key,path in [('snapshot',STATE/'synthetic.dump'),('node',Path(plan['node'])),('python',Path(plan['python']))]:
  field={'snapshot':'snapshot_sha256','node':'node_executable_sha256','python':'python_executable_sha256'}[key];result[key]=sha(path)==plan['binding'][field]
 result['original_tools']=all(sha(TOOLS/name)==h for name,h in plan['binding']['tools']['files'].items())
 result['plan']=sha(STATE/'plan.json')==preflight['plan_sha256']
 result['run_tools']=all(sha(HERE/name)==h for name,h in preflight['tool_sha256'].items())
 result['control_pg_restore']=sha(os.environ['NOTALONE_CONTROL_PG_RESTORE'])==preflight['control_pg_restore_sha256']
 return result
preflight=json.loads((HERE/'preflight.json').read_text())
prepared=json.loads((PRIVATE/'prepared.json').read_text())
phases=[('A-old-anchor','old',Path(plan['old'])),('B-full-baseline','new',PRIVATE/'baseline-source'),('C-full-observer','new',PRIVATE/'observer-source'),('D-old-anchor','old',Path(plan['old']))]
output={'diagnostic_only':True,'formal_performance_qualified':False,'task25_passed':False,'source_commit':'1e90d9edde3a5c3ac0de08c018149dd79bbebdfc','concurrency':1,'warmups_per_case':10,'scored_per_case_per_host':30,'max_wall_seconds':180,'new_pg_patch':False,'new_async_hooks':False,'gc_observer':False,'rows':[],'hosts':[],'cleanup':{},'failures':[],'unknowns':['PG query await含执行/解码/续点；未分离','GC/JIT/实际loaded scripts未观测'],'raw_bindings':[],'input_bindings':{k:v for k,v in plan['binding'].items() if k.endswith('_sha256')},'runtime_environments':plan['runtime_environments'],'tool_path_note':'控制驱动PATH前置已授权PG与Node目录；新旧产品宿主PATH仍由冻结specification定义。各host另有自有TMPDIR；新启动适配器共同透传TMPDIR以将临时输出限制在自有子树。'}
for phase,arm,project in phases:
 for case in plan['http_cases']:
  for i in range(-10,30):output['rows'].append({'phase':phase,'arm':arm,'case_id':case['id'],'repeat':i,'warmup':i<0,'request_id':f'{phase}:{case["id"]}:{i}','terminal_status':'not_attempted','attempted':False})
owned=[];owned_history=[];children=[]
def safe_error(error):
 text=type(error).__name__+':'+str(error)
 for value,alias in [(str(PRIVATE),'<owned-private>'),(str(STATE),'<frozen-state>'),(str(REPO),'<repo>'),(str(Path.home()),'<user-home>'),(control_user,'<os-user>')]:text=text.replace(value,alias)
 return text

def clone(name):
 with connect(autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
 owned.append(name);owned_history.append(name)
 subprocess.run([os.environ['NOTALONE_CONTROL_PG_RESTORE'],'--no-owner','--no-privileges','--exit-on-error','--dbname','host=/tmp dbname='+name,str(STATE/'synthetic.dump')],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=min(30,max(1,deadline-time.monotonic())))
def drop(name):
 with connect(autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))
 owned.remove(name)
def trace_rows(folder):
 p=folder/'trace.jsonl';return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []
def public_logs(folder,phase):
 for name in ['host.stdout.log','host.stderr.log','trace.jsonl','stages.json','backend-exit.json']:
  p=folder/name
  if not p.is_file():continue
  raw=p.read_bytes();text=raw.decode(errors='replace')
  for value,alias in [(str(PRIVATE),'<owned-private>'),(str(STATE),'<frozen-state>'),(str(REPO),'<repo>'),(str(Path.home()),'<user-home>')]:text=text.replace(value,alias)
  text=text.replace(control_user,'<os-user>')
  dest=HERE/f'{phase}-{name}';dest.write_text(text);dest.chmod(0o600)
  output['raw_bindings'].append({'raw_locator':f'run-v1/hosts/{phase}/{name}','raw_sha256':hashlib.sha256(raw).hexdigest(),'public_file':dest.name,'public_sha256':sha(dest)})
def sample(phase,arm,project):
 import uuid
 name='na_hostperf_'+uuid.uuid4().hex+'_test';folder=PRIVATE/'hosts'/phase
 host={'phase':phase,'arm':arm,'terminal_status':'failed','sample_count':0,'actual_attempted':0};child=None;info=None
 try:
  check_budget();clone(name)
  spec=specification({**plan,arm:str(project)},arm,folder,name)
  spec['environment'].pop('NOTALONE_PERF_DIAGNOSTIC',None)
  for key in ['command','cwd']:
   if isinstance(spec[key],list):spec[key]=[str(v).replace('{run}',str(folder)) for v in spec[key]]
   else:spec[key]=str(spec[key]).replace('{run}',str(folder))
  spec['environment']['NOTALONE_BACKEND_INFO']=str(folder/'backend.info')
  tmp=folder/'tmp';tmp.mkdir(mode=0o700);spec['environment']['TMPDIR']=str(tmp)
  if arm=='new':
   spec['command']=[plan['node'],str(HERE/'new-host.mjs')]
   spec['environment'].update({'NOTALONE_BASELINE_PRELOAD':str(ORIGINAL/'perf-preload.mjs'),'NOTALONE_BOUNDARY_OBSERVER':'1' if phase=='C-full-observer' else '0','NOTALONE_BOUNDARY_STAGE_FILE':str(folder/'stages.json')})
  else:spec['environment']['PYTHONPATH']=str(ORIGINAL)+':'+str(project/'backend/src')
  with (folder/'host.stdout.log').open('w') as stdout,(folder/'host.stderr.log').open('w') as stderr:
   child=subprocess.Popen(spec['command'],cwd=spec['cwd'],env=spec['environment'],stdin=subprocess.PIPE,stdout=stdout,stderr=stderr,start_new_session=True)
   children.append({'child':child,'info':None,'phase':phase,'cleaned':False})
   ready_deadline=min(deadline,time.monotonic()+25)
   while time.monotonic()<ready_deadline:
    if child.poll() is not None:raise RuntimeError('host_exited_before_ready')
    try:
     info=handshake(folder/'backend.info');children[-1]['info']=info
     response=request(info,'/api/contacts',timeout=1)
     contacts=response['body'].get('contacts',[])
     if response['status']==200 and len(contacts)==4 and plan['contact'] in {v.get('contact_id') for v in contacts}:break
    except (OSError,ValueError,KeyError):pass
    time.sleep(.025)
   else:raise TimeoutError('business_ready_timeout')
   host['ready_elapsed_seconds']=time.monotonic()-START
   for case in plan['http_cases']:
    rows=[r for r in output['rows'] if r['phase']==phase and r['case_id']==case['id']]
    for row in rows:
     check_budget();row['attempted']=True;row['terminal_status']='failed';started=time.monotonic_ns()
     try:
      result=request(info,case['path'],case['method'],case.get('body'),row['request_id'],headers=case.get('headers'))
      row.update(status=result['status'],client_response_ms=result['client_response_ms'],response_sha256=hashlib.sha256(json.dumps(result['body'],sort_keys=True).encode()).hexdigest())
      if result['status']!=200:raise RuntimeError('http_status_'+str(result['status']))
      if case.get('expected_contact_count') is not None:
       values=result['body'].get('contacts',[])
       if len(values)!=case['expected_contact_count'] or case['required_contact_id'] not in {v.get('contact_id') for v in values}:raise RuntimeError('contact_scope_mismatch')
      if any(result['body'].get(k)!=v for k,v in case.get('expected',{}).items()):raise RuntimeError('business_output_mismatch')
      if case.get('write'):
       back=request(info,case['verify_path'].format(**result['body']),headers=case.get('headers'))
       row.update(durability_verified=back['status']==200,durability_observed_ms=(back['ended_ns']-result['started_ns'])/1e6)
       if not row['durability_verified']:raise RuntimeError('durability_readback_failed')
      matches=[v for v in trace_rows(folder) if v.get('type')=='http' and v.get('request_id')==row['request_id'] and v.get('pid')==info['pid']]
      if len(matches)!=1:raise RuntimeError('server_boundary_unknown')
      row['server_response_ms']=matches[0]['server_response_ms'];row['terminal_status']='succeeded'
     except BodyDeadline:raise
     except Exception as error:row.update(observed_until_failure_ms=(time.monotonic_ns()-started)/1e6,unknown_reason=safe_error(error))
   host['terminal_status']='succeeded'
 except Exception as error:
  host['unknown_reason']=safe_error(error);raise
 finally:
  if child:
   host['cleanup']=cleanup(child,{},info['pid'] if info else None);children[-1]['cleaned']=host['cleanup']['verified']
  else:host['cleanup']={'verified':True,'remaining':[]}
  host['actual_attempted']=sum(r['attempted'] for r in output['rows'] if r['phase']==phase)
  host['sample_count']=sum(r['terminal_status']=='succeeded' for r in output['rows'] if r['phase']==phase)
  if name in owned:
   with connect(name) as c:
    counts=c.execute('SELECT (SELECT count(*) FROM model_call_receipt),(SELECT count(*) FROM outbound_ledger_entry)').fetchone()
    host['model_records']={'model_call_receipt':counts[0],'outbound_ledger_entry':counts[1]}
    host['other_sessions_after_shutdown']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()').fetchone()[0]
  host['network_denied_attempts']=sum(v.get('type')=='network_denied' for v in trace_rows(folder))
  public_logs(folder,phase)
  output['hosts'].append(host)
  save(PRIVATE/'progress.json',output)
  if name in owned and host['cleanup']['verified']:drop(name)
  if not host['cleanup']['verified']:raise RuntimeError('owned_process_cleanup_failed')

def main():
 if (PRIVATE/'started.json').exists():raise RuntimeError('this_frozen_flow_already_started')
 save(PRIVATE/'started.json',{'started':True,'wall_seconds':180})
 signal.alarm(150)
 try:
  output['binding_before']=bindings()
  if not all(output['binding_before'].values()):raise RuntimeError('frozen_binding_mismatch')
  output['environment_before']=environment_binding(plan)
  for key,root in [('base_source_sha256',PRIVATE/'baseline-source'),('observer_source_sha256',PRIVATE/'observer-source')]:
   if not all(sha(root/p)==h for p,h in prepared[key].items()):raise RuntimeError('prepared_source_mismatch')
  for phase,arm,project in phases:sample(phase,arm,project)
  output['binding_after']=bindings()
  output['source_unchanged_after']=all(sha((PRIVATE/label)/p)==h for key,label in [('base_source_sha256','baseline-source'),('observer_source_sha256','observer-source')] for p,h in prepared[key].items())
  output['environment_after']=environment_binding(plan)
 except Exception as error:output['failures'].append(safe_error(error))
 finally:
  signal.alarm(30)
  for item in children:
   if not item['cleaned']:
    info=item['info'];result=cleanup(item['child'],{},info['pid'] if info else None);item['cleaned']=result['verified']
  for name in list(owned):
   try:drop(name)
   except Exception as error:output['failures'].append('cleanup:'+safe_error(error))
  with connect(autocommit=True) as c:
   output['cleanup']['owned_databases_remaining']=c.execute('SELECT count(*) FROM pg_database WHERE datname=ANY(%s)',[owned_history]).fetchone()[0]
   output['cleanup']['owned_sessions_remaining']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=ANY(%s)',[owned_history]).fetchone()[0]
  output['cleanup']['owned_processes_cleaned']=all(item['cleaned'] for item in children)
  for label in ['baseline-source','observer-source']:
   target=PRIVATE/label
   if target.exists():shutil.rmtree(target)
  for phase,_,_ in phases:
   folder=PRIVATE/'hosts'/phase
   if folder.exists():
    keep={'host.stdout.log','host.stderr.log','trace.jsonl','stages.json','backend-exit.json'}
    for p in folder.iterdir():
     if p.name not in keep:
      if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
      else:p.unlink()
  output['cleanup']['owned_source_directories_remaining']=sum((PRIVATE/label).exists() for label in ['baseline-source','observer-source'])
  output['cleanup']['owned_runtime_directories_remaining']=sum((PRIVATE/'hosts'/phase/'tmp').exists() or (PRIVATE/'hosts'/phase/'home').exists() for phase,_,_ in phases)
  output['wall_seconds']=time.monotonic()-START
  for r in output['rows']:
   if r['terminal_status']=='not_attempted':r['unknown_reason']='flow_aborted_before_request'
  save(PRIVATE/'result.json',output);save(HERE/'result.json',output)
  signal.alarm(0)
 print(json.dumps({'terminal_counts':{status:sum(r['terminal_status']==status for r in output['rows']) for status in ['succeeded','failed','not_attempted']},'wall_seconds':output['wall_seconds'],'cleanup':output['cleanup'],'failures':output['failures']},ensure_ascii=False))
 return 0 if all(r['terminal_status']=='succeeded' for r in output['rows']) and not output['failures'] and all(output.get('binding_after',{}).values()) else 2
if __name__=='__main__':sys.exit(main())
