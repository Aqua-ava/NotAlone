from pathlib import Path
import hashlib,json,os,subprocess,sys,uuid
os.umask(0o077);sys.dont_write_bytecode=True
base=Path(__file__).resolve().parent
sys.path.insert(0,str(base.parents[3]/'.scratch/dsh-ts-migration/resumed-host-performance'))
from host_fixture import clone,drop
import psycopg
state=Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE']);plan=json.loads((state/'plan.json').read_text())
name='na_hostperf_'+uuid.uuid4().hex+'_test'
clone(plan,name)
report={'diagnostic_only':True,'own_database_name_sha256':hashlib.sha256(name.encode()).hexdigest()}
try:
 with psycopg.connect('host=/tmp dbname='+name) as c:
  keys=['transaction_isolation','transaction_read_only','search_path','statement_timeout','lock_timeout']
  report['old_connection_defaults']={key:c.execute('SELECT current_setting(%s)',[key]).fetchone()[0] for key in keys}
 env={**os.environ,'NOTALONE_SETTINGS_DATABASE':'host=/tmp dbname='+name}
 result=subprocess.run([plan['node'],str(base/'settings-probe.mjs')],env=env,capture_output=True,text=True,timeout=15,check=True)
 report['new_transaction_settings']=json.loads(result.stdout)
 with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
  report['own_sessions_after_node_closed']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=%s',[name]).fetchone()[0]
finally:
 drop(name)
 with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
  report['own_database_absent_after_drop']=not c.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)',[name]).fetchone()[0]
 report['old_probe_scope']='与旧contacts直接psycopg.connect相同设置；其他旧路由的显式事务设置按原源码保留，不冒充已逐连接测量。'
 path=base/'settings.json';path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
print(json.dumps(report,ensure_ascii=False))
