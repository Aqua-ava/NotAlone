"""获准后的一次40事务监督器；准备/读取本文件不会运行。"""
from pathlib import Path
import os,sys,json,hashlib,subprocess,signal,time,pwd,uuid,io,tarfile,shutil
os.umask(0o077);sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[4]
class WorkDeadline(Exception):pass
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');p.chmod(0o600)
def main():
 import psycopg
 from psycopg import sql
 config=json.loads((HERE/'configuration.json').read_text());pins=json.loads((HERE/'source-pins.json').read_text())
 state=Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE']);plan=json.loads((state/'plan.json').read_text())
 private=Path(os.environ['NOTALONE_BOUNDARY_PRIVATE'])/'catalog-wait-v2-revision-03-run-01'
 private.mkdir(mode=0o700,exist_ok=False)
 public=HERE/'results-run-01';assert not public.exists()
 restore=Path(os.environ['NOTALONE_CONTROL_PG_RESTORE'])
 control_user=pwd.getpwuid(os.getuid()).pw_name
 os.environ['PGUSER']=control_user;os.environ['PATH']=str(restore.parent)+':'+str(Path(plan['node']).parent)+':'+os.environ['PATH']
 tools=REPO/'.scratch/dsh-ts-migration/resumed-host-performance';sys.path.insert(0,str(tools))
 from host_fixture import digest_files,specification
 def connect(db='postgres',autocommit=False):return psycopg.connect(host='/tmp',dbname=db,user=control_user,connect_timeout=3,autocommit=autocommit,options='-c statement_timeout=3000')
 manifest=json.loads((HERE/'manifest.json').read_text())
 def binding():
  fixed=pins['fixed_input_sha256'];out={'plan':sha(state/'plan.json')==fixed['plan_sha256'],'snapshot':sha(state/'synthetic.dump')==fixed['fixed_snapshot_sha256'],'node':sha(plan['node'])==fixed['node_executable_sha256'],'python':sha(plan['python'])==fixed['python_executable_sha256'],'pg_restore':sha(restore)==fixed['control_pg_restore_sha256'],'probe_tools':all(sha(HERE/f)==v for f,v in manifest['files'].items()),'source_pins':all(sha(REPO/f)==v for f,v in pins['source_read_sha256'].items()),'fixture_tools':all(sha(tools/f)==v for f,v in plan['binding']['tools']['files'].items())}
  for key,root in [('dependencies',Path(plan['dependencies'])),('old_dependencies',state/'old-runtime')]:
   b=plan['binding'][key];out[key]=digest_files(root,[root/f for f in b['files']])['sha256']==b['sha256']
  return out
 def redact(text):
  for value,alias in [(str(private),'<owned-private>'),(str(state),'<frozen-state>'),(str(REPO),'<repo>'),(str(Path.home()),'<user-home>'),(control_user,'<os-user>')]:text=text.replace(value,alias)
  return text
 output={'diagnostic_only':True,'formal_performance_qualified':False,'configuration':config,'input_binding':pins['fixed_input_sha256'],'new_global_pg_patch':False,'ready_dataRow_observation':False,'failures':[],'cleanup':{},'raw_public_bindings':[]}
 start=time.monotonic();child=None;owned=False;created=False;project=private/'project';folder=private/'probe';database='na_hostperf_'+uuid.uuid4().hex+'_test'
 save(private/'owned-resources.json',{'database':database,'child_pid':None,'project':'project','run':'probe'})
 def alarm(*_):raise WorkDeadline('bounded_work_deadline')
 signal.signal(signal.SIGALRM,alarm);signal.alarm(config['work_seconds'])
 try:
  output['binding_before']=binding()
  if not all(output['binding_before'].values()):raise RuntimeError('frozen_binding_mismatch')
  archive=subprocess.check_output(['git','archive',config['production_base_commit'],'backend/database','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],cwd=REPO)
  project.mkdir(mode=0o700)
  with tarfile.open(fileobj=io.BytesIO(archive)) as stream:stream.extractall(project,filter='data')
  for p in project.rglob('*'):p.chmod(0o700 if p.is_dir() else 0o600)
  (project/'backend-ts/node_modules').symlink_to(Path(plan['dependencies']),target_is_directory=True)
  target=project/'backend-ts/src/host-storage.ts';patch=json.loads((HERE/'observer-source-binding.json').read_text())
  if sha(target)!=patch['original_sha256']:raise RuntimeError('private_original_source_mismatch')
  text=target.read_text()
  for change in patch['replacements']:
   if text.count(change['before'])!=1:raise RuntimeError('unique_source_marker_mismatch')
   text=text.replace(change['before'],change['after'])
  target.write_text(patch['helper_prefix']+text)
  if sha(target)!=patch['private_instrumented_sha256']:raise RuntimeError('private_observer_source_mismatch')
  output['private_source_sha256_before']=sha(target)
  with connect(autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(database)))
  owned=True;created=True
  with (private/'restore.stdout.log').open('w') as stdout,(private/'restore.stderr.log').open('w') as stderr:
   restored=subprocess.run([str(restore),'--no-owner','--no-privileges','--exit-on-error','--dbname','host=/tmp dbname='+database,str(state/'synthetic.dump')],stdout=stdout,stderr=stderr,timeout=30)
  if restored.returncode:raise RuntimeError('synthetic_restore_failed')
  spec=specification({**plan,'new':str(project)},'new',folder,database);env=spec['environment'];env.pop('NOTALONE_PERF_DIAGNOSTIC',None)
  tmp=folder/'tmp';tmp.mkdir(mode=0o700);env.update({'TMPDIR':str(tmp),'NOTALONE_CATALOG_RUN':str(folder),'NOTALONE_CATALOG_PROJECT':str(project)})
  with (private/'probe.stdout.log').open('w') as stdout,(private/'probe.stderr.log').open('w') as stderr:
   child=subprocess.Popen([plan['node'],str(HERE/'probe.mjs')],cwd=spec['cwd'],env=env,stdout=stdout,stderr=stderr,start_new_session=True)
   save(private/'owned-resources.json',{'database':database,'child_pid':child.pid,'project':'project','run':'probe'})
   child.wait(timeout=max(1,config['work_seconds']-(time.monotonic()-start)))
  output['probe_exit_code']=child.returncode
  if child.returncode:output['failures'].append('probe_failed_all_original_rows_retained')
  if (folder/'probe-result.json').exists():output['probe']=json.loads((folder/'probe-result.json').read_text())
  else:output['failures'].append('probe_result_missing_unknown_sample_progress')
  output['private_source_unchanged']=sha(target)==output['private_source_sha256_before']
  output['binding_after']=binding()
 except Exception as error:output['failures'].append(redact(type(error).__name__+':'+str(error)))
 finally:
  signal.alarm(config['cleanup_seconds'])
  try:
   if child and child.poll() is None:
    child.terminate()
    try:child.wait(timeout=8)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3);output['cleanup']['owned_child_force_killed']=True
   output['cleanup']['probe_exited']=child is None or child.poll() is not None
   if owned:
    with connect(autocommit=True) as c:
     output['cleanup']['owned_sessions_before_drop']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s',[database]).fetchone()[0]
     c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(database)));owned=False
   if created:
    with connect(autocommit=True) as c:
     output['cleanup']['owned_databases_remaining']=c.execute('SELECT count(*) FROM pg_database WHERE datname=%s',[database]).fetchone()[0]
     output['cleanup']['owned_sessions_remaining']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s',[database]).fetchone()[0]
   else:
    output['cleanup'].update(owned_databases_remaining=0,owned_sessions_remaining=0,reason='no_database_created')
   if project.exists():shutil.rmtree(project)
   for p in [folder/'tmp',folder/'home']:
    if p.exists():shutil.rmtree(p)
   output['cleanup']['owned_source_dirs_remaining']=int(project.exists())
   output['cleanup']['owned_runtime_dirs_remaining']=sum(p.exists() for p in [folder/'tmp',folder/'home'])
  except Exception as error:output['failures'].append('cleanup:'+redact(type(error).__name__+':'+str(error)))
  output['wall_seconds']=time.monotonic()-start
  if 'probe' not in output:output['probe']={'rows':[{'index':i-config['warmups'],'warmup':i<config['warmups'],'status':'unknown' if child else 'not_attempted','unknown_reason':'probe_result_not_available'} for i in range(config['units'])]}
  save(private/'result.json',output)
  public.mkdir()
  for p in [private/'restore.stdout.log',private/'restore.stderr.log',private/'probe.stdout.log',private/'probe.stderr.log',folder/'probe-result.json']:
   if not p.is_file():continue
   raw=p.read_bytes();dest=public/p.name;dest.write_text(redact(raw.decode(errors='replace')))
   output['raw_public_bindings'].append({'raw_locator':'catalog-wait-v2-revision-03-run-01/'+str(p.relative_to(private)),'raw_sha256':hashlib.sha256(raw).hexdigest(),'public_file':dest.name,'public_sha256':sha(dest)})
  save(private/'result.json',output)
  save(public/'result.json',json.loads(redact(json.dumps(output,ensure_ascii=False))))
  signal.alarm(0)
 print(json.dumps({'units':len(output['probe']['rows']),'statuses':{status:sum(r['status']==status for r in output['probe']['rows']) for status in ['succeeded','failed','not_attempted','unknown']},'cleanup':output['cleanup'],'wall_seconds':output['wall_seconds'],'failures':output['failures']},ensure_ascii=False))
 return 0 if not output['failures'] and all(r['status']=='succeeded' for r in output['probe']['rows']) else 2
if __name__=='__main__':sys.exit(main())
