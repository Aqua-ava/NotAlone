"""只读封存失败夹具、核对冻结源与网络审计，清理自有测试资源并生成分享证据。"""
from pathlib import Path
import hashlib,json,os,shutil,tarfile,re
from collections import Counter
import psycopg
from psycopg import sql
root=Path.cwd();out=root/'.scratch/dsh-ts-migration/incremental-stream-reconnect-probe'
registry=json.loads(Path('/tmp/notalone-reconnect-probe-current-private.json').read_text())
run=Path(registry['run']);old=Path(registry['attempt1']);meta=json.loads((run/'meta.json').read_text());first=json.loads((old/'result-raw.json').read_text());result=json.loads((run/'result-raw.json').read_text());raw=json.loads((run/'raw-evidence.json').read_text())
sha=lambda data:hashlib.sha256(data).hexdigest()
def tree(data):return sha(json.dumps(data,sort_keys=True,separators=(',',':')).encode())
def alive(pid):
 try:os.kill(pid,0);return True
 except ProcessLookupError:return False
fixture=Path(first['private_fixture']);database=first['database_name']
assert re.fullmatch(r'notalone_unconfigured_[a-f0-9]{32}_test',database)
cleanup={}
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as admin:
 server_started=admin.execute('SELECT pg_postmaster_start_time()').fetchone()[0]
 assert admin.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s',(database,)).fetchone()[0]==0
 with psycopg.connect('host=/tmp dbname='+database,autocommit=True) as conn:
  tables=[r[0] for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
  snapshot={'database':database,'tables':{}}
  for table in tables:snapshot['tables'][table]=[r[0] for r in conn.execute(sql.SQL('SELECT to_jsonb(t) FROM public.{} t').format(sql.Identifier(table)))]
  (old/'failed-database-snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,default=str,indent=2))
 assert admin.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s',(database,)).fetchone()[0]==0
 with tarfile.open(old/'failed-fixture-snapshot.tar.gz','w:gz') as tar:tar.add(fixture,arcname='fixture')
 # 仅夹具传输失败的自有库；所有业务行已在上方只读归档，不通过改行或清journal绕过产品。
 admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(database)))
 assert admin.execute('SELECT count(*) FROM pg_database WHERE datname IN (%s,%s)',(database,result['database_name'])).fetchone()[0]==0
 cleanup['both_test_databases_absent']=True
 cleanup['shared_postgres_preserved']=admin.execute('SELECT pg_postmaster_start_time()').fetchone()[0]==server_started
runtime=first['checks']['runtime'];cleanup['attempt1_runner_gone']=not alive(int((old/'runner.pid').read_text()));cleanup['attempt1_dsh_gone']=not alive(runtime['pid']);cleanup['attempt1_legacy_gone']=not alive(runtime['legacyPid']);cleanup['attempt1_info_removed']=not (fixture/'backend.info').exists();cleanup['attempt1_lock_removed']=not (fixture/'backend.info.dsh-lock').exists();cleanup['attempt1_profile_removed']=not list((old/'runtime').glob('notalone-dsh-host-*'))
identity=sha(json.dumps([str(fixture/'backend.info'),str(fixture/'synthetic.env')],separators=(',',':')).encode())[:24]
cleanup['attempt1_model_socket_removed']=not Path('/tmp',f'na-model-{os.getuid()}-{identity}','p.sock').exists()
assert all(cleanup.values()),cleanup
first_size=sum(p.stat().st_size for p in fixture.rglob('*') if p.is_file());shutil.rmtree(fixture);cleanup['attempt1_fixture_removed']=not fixture.exists();cleanup['pass_runner_gone']=not alive(int((run/'runner.pid').read_text()))
# 核验前后完整产品字节、冻结副本及归档；不把附加sitecustomize审计文件算成产品修改。
source={'file_count':len(meta['files']),'source_before_sha256':meta['source_tree_sha256'],'files':{},'shared_source_changed':[]}
after={}
for rel,before in meta['files'].items():
 current=sha((root/rel).read_bytes());frozen=sha((run/'frozen'/rel).read_bytes());after[rel]=current;source['files'][rel]={'before':before,'after':current,'frozen':frozen}
 if current!=before:source['shared_source_changed'].append(rel)
 assert frozen==before
source['source_after_sha256']=tree(after);source['frozen_product_bytes_unchanged']=True
assert not source['shared_source_changed'];assert source['source_before_sha256']==source['source_after_sha256']
for stage in (run,old):
 m=json.loads((stage/'meta.json').read_text())
 with tarfile.open(stage/'source-snapshot.tar.gz') as tar:
  assert {member.name:sha(tar.extractfile(member).read()) for member in tar.getmembers() if member.isfile()}==m['files']
# 审计仅记录当前进程树的TCP/本机socket与DNS，不改变系统网络或DNS。
network={}
for name,key in [('node-network-audit.jsonl','node'),('python-network-audit.jsonl','python')]:
 rows=[json.loads(l) for l in (run/name).read_text().splitlines() if l]
 network[key]={'event_count':len(rows),'external_attempts':sum(not r['allowed'] for r in rows),'types':dict(Counter(r['kind'] for r in rows))}
 assert network[key]['external_attempts']==0
# 原始路径只留仓外，分享版使用别名。
aliases={str(run/'frozen'):'$FROZEN',str(run):'$RUN',str(old/'frozen'):'$FROZEN_ATTEMPT1',str(old):'$ATTEMPT1',meta['root']:'$PROJECT',meta['node']:'$NODE',meta['python']:'$PYTHON',str(Path(meta['python']).parents[1]):'$PYTHON_ENV',str(Path(meta['node']).parent):'$NODE_BIN',str(run.parent):'$TMP_ROOT',str(Path.home()):'$HOME','/tmp/notalone-dsh-official-687f282':'$DSH_OFFICIAL'}
def sanitize(text):
 pairs=[]
 for value,alias in aliases.items():
  pairs.append((value,alias))
  if value.startswith('/var/'):pairs.append(('/private'+value,alias))
 for value,alias in sorted(pairs,key=lambda p:len(p[0]),reverse=True):text=text.replace(value,alias)
 return text
(out/'logs').mkdir(exist_ok=True)
artifacts=[]
def shared(rawpath,dest,description):
 data=rawpath.read_bytes();text=sanitize(data.decode());target=out/dest;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text);artifacts.append({'raw_path':sanitize(str(rawpath)),'raw_sha256':sha(data),'shared_path':dest,'shared_sha256':sha(target.read_bytes()),'transformation':description})
for name,dest in [('probe.stdout','probe.stdout.txt'),('probe.stderr','probe.stderr.txt'),('dsh.stdout','dsh.stdout.txt'),('dsh.stderr','dsh.stderr.txt'),('node-network-audit.jsonl','node-network-audit.jsonl'),('python-network-audit.jsonl','python-network-audit.txt')]:shared(run/name,'logs/'+dest,'只将本机路径替换为别名')
for name,dest in [('probe.stderr','attempt-1.probe.stderr.txt'),('probe.stdout','attempt-1.probe.stdout.txt')]:shared(old/name,'logs/'+dest,'首轮夹具自然RED；只替换本机路径')
source_raw=run/'source-hashes.json';source_raw.write_text(json.dumps(source,indent=2));shared(source_raw,'source-hashes.json','实际产品源前后及冻结逐文件SHA256')
shared(run/'official-source-hashes.json','official-source-hashes.json','锁定官方源码字节未改')
result.pop('database_name',None);result['checks']['network_audit']=network;result['checks']['processing_outcomes']=dict(Counter(r['outcome'] for r in raw['processing']));result['cleanup'].update(cleanup);result['cleanup']['attempt1_archived_before_drop']=True;result['attempt1']={'pass':False,'stage':first['failure']['stage'],'public_confirm_status':500,'classified_as':'fixture_exec_format_error','product_defect_proven':False,'evidence':'合成CLI日志为空；同文件直接exec返回macOS errno8；shebang指向脚本包装器；修正为真实Node并显式import审计后只复跑本case','changes':['fake CLI shebang与审计装配','authority查询表名拼写'],'same_product_source':True};result['checks']['public_requests']={'enable_count':sum(r['path']=='/api/sync/enable' for r in raw['requests']),'check_retry_follow_mutations':sum(any(x in r['path'] for x in ['/check','/retry','/follow-']) for r in raw['requests']),'observation_method':'仅GET /api/sync/status','status_get_count':sum(r['method']=='GET' and r['path']=='/api/sync/status' for r in raw['requests'])}
# 精简分享的状态时间线保留故障与恢复事实，不包含合成联系人UUID。
seen=[]
for obs in raw['observations']:
 state={k:obs['status'][k] for k in ['sync_enabled','sync_scope','cli_sync_phase','cli_sync_mode','cli_stream_active','cli_failure_code']}
 if not seen or seen[-1]['status']!=state:seen.append({'at':obs['at'],'status':state})
stream_entries=[e for e in raw['commands'] if e['kind'] in ['stream_start','stream_exit','stream_replay_event','body']]
coverage={'case':'19自然退避自动重建全局流','pass':True,'official_version':'0.2.1-rc.2','official_commit':'687f282e8625c6b8d11ff58211a90524be2e4317','source_before_sha256':source['source_before_sha256'],'source_after_sha256':source['source_after_sha256'],'real_components':['launchDsh','官方named profile notalone','当前host-plugin','LegacyBackend/原生3秒宿主heartbeat','SyncIncrementalEngine/CLI适配器','公开scope/binding/enable/status/disable/shutdown','真实PG独占随机_test库'],'fake_boundary':['只读CLI外部输入','进程内传输审计'],'excluded':['真实App/微信','全部私聊范围','停机追赶','连续多次断连/指数退避','真实模型/外网','整票19完成'],'observed_timeline':seen,'stream_body_log':stream_entries,'source_references':{'forbidden_check_reset':'backend-ts/src/sync-incremental-engine.ts:89','first_retry_3000ms':'backend-ts/src/sync-incremental-engine.ts:22,165-167','auto_reopen':'backend-ts/src/sync-incremental-engine.ts:204-207','real_heartbeat':'backend/src/notalone/server/sync_host.py:258,634-675','remote_cycle':'backend/src/notalone/front_sync/incremental_remote.py:93','cli_exit7_classification':'backend-ts/src/sync-incremental-cli-stream.ts:47-50'},'assertions':result['checks']['reconnect']}
for name,value in [('result-final-raw.json',result),('coverage-raw.json',coverage),('cleanup-raw.json',cleanup)]: (run/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
shared(run/'result-final-raw.json','result.json','精简合成断流/去重/来源/审计及清理事实；路径别名化')
shared(run/'coverage-raw.json','coverage-check.json','保留公开状态时间线、真实全局流代数/argv及正文计数，不含正文/UUID')
shared(run/'cleanup-raw.json','cleanup-proof.json','仅自有资源与共享PG保留核验')
# 当前交付脚本已移除静态本机用户名路径；原执行准备脚本仅仓外留字节。
shared(run/'probe.mjs','probe.mjs','执行脚本逐字（无需路径变换）')
artifacts.append({'raw_path':'$RUN/prepare-executed.py','raw_sha256':sha((run/'prepare-executed.py').read_bytes()),'shared_path':'prepare.py','shared_sha256':sha((out/'prepare.py').read_bytes()),'transformation':'仅将静态本机运行时路径改为明确环境变量/Path.home解析，并移除仓内私有路径指针；未重跑case'})
for stage,alias in [(run,'$RUN'),(old,'$ATTEMPT1')]:
 for name in ['source-snapshot.tar.gz','raw-evidence.json','meta.json','node-audit.mjs','result-raw.json','failed-database-snapshot.json','failed-fixture-snapshot.tar.gz','failure-observations.json','probe.mjs']:
  p=stage/name
  if p.exists():artifacts.append({'raw_path':alias+'/'+name,'raw_sha256':sha(p.read_bytes()),'size_bytes':p.stat().st_size,'raw_only':True})
# 归档已按734个输入文件逐一回验；清理无进程引用的扩展源码staging，保留源码归档及原日志。
removed=0
for stage in (run,old):
 staging=stage/'frozen';removed+=sum(p.stat().st_size for p in staging.rglob('*') if p.is_file() and 'node_modules' not in p.parts)
 shutil.rmtree(staging)
cleanup['source_staging_removed']=all(not (stage/'frozen').exists() for stage in (run,old));cleanup['staging_bytes_removed']=removed;cleanup['failed_fixture_bytes_archived_then_removed']=first_size
(run/'cleanup-raw.json').write_text(json.dumps(cleanup,ensure_ascii=False,indent=2));(out/'cleanup-proof.json').write_text(sanitize((run/'cleanup-raw.json').read_text()))
for entry in artifacts:
 if entry.get('shared_path')=='cleanup-proof.json':entry['raw_sha256']=sha((run/'cleanup-raw.json').read_bytes());entry['shared_sha256']=sha((out/'cleanup-proof.json').read_bytes())
artifact_manifest={'source_sha256':source['source_before_sha256'],'raw_aliases':['$RUN','$ATTEMPT1'],'source_archive_verified_per_file':True,'artifacts':artifacts}
(out/'artifact-hashes.json').write_text(json.dumps(artifact_manifest,ensure_ascii=False,indent=2))
print(json.dumps({'pass':True,'source_before':source['source_before_sha256'],'source_after':source['source_after_sha256'],'network':network,'cleanup':cleanup,'result_sha256':sha((out/'result.json').read_bytes()),'artifact_manifest_sha256':sha((out/'artifact-hashes.json').read_bytes())},ensure_ascii=False))
