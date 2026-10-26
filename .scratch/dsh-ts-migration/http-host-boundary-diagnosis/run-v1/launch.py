"""启动唯一冻结流程；启动前失败不创建实验资源。"""
from pathlib import Path
import json,hashlib,subprocess,os
os.umask(0o077)
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[3]
PRIVATE=Path(os.environ['NOTALONE_BOUNDARY_PRIVATE'])/'run-v1'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest=json.loads((HERE/'prepared-manifest.json').read_text())
checks={'frozen_payload_hashes':all(sha(HERE/f)==h for f,h in manifest['payload_sha256'].items()),'not_started':not(PRIVATE/'started.json').exists(),'prepared_private_sources_present':all((PRIVATE/x).is_dir() for x in ['baseline-source','observer-source']),'production_equal_to_1e90':subprocess.run(['git','diff','--quiet','1e90d9edde3a5c3ac0de08c018149dd79bbebdfc','HEAD','--','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],cwd=REPO).returncode==0}
state=Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE']);preflight=json.loads((HERE/'preflight.json').read_text())
checks['control_pg_restore_hash']=sha(os.environ['NOTALONE_CONTROL_PG_RESTORE'])==preflight['control_pg_restore_sha256']
assert all(checks.values()),checks
with (PRIVATE/'driver.stdout.log').open('w') as stdout,(PRIVATE/'driver.stderr.log').open('w') as stderr:
 child=subprocess.Popen([os.environ['NOTALONE_CONTROL_PYTHON'],str(HERE/'run.py')],cwd=REPO,env=os.environ,stdout=stdout,stderr=stderr,start_new_session=True)
(PRIVATE/'driver-launch.json').write_text(json.dumps({'pid':child.pid,'checks':checks,'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),'command_alias':'python run-v1/run.py','prepared_manifest_sha256':sha(HERE/'prepared-manifest.json'),'launcher_sha256':sha(__file__)})+'\n')
print(json.dumps({'launched_single_frozen_flow':True,'checks':checks,'driver_pid':child.pid,'max_wall_seconds':180}))
