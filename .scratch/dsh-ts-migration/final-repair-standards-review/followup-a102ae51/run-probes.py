from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import time

private=Path(sys.argv[1])
out=Path(__file__).resolve().parent
def sha(data):
    return hashlib.sha256(data).hexdigest()

def run(label,script):
    env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL']}
    env.update({'NOTALONE_DISABLE_DOTENV':'1','NOTALONE_REVIEW_SOURCE':str(private/'head')})
    start=time.monotonic()
    result=subprocess.run(['node',str(script)],cwd=private/'head/backend-ts',env=env,
                          stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
    raw=private/(label+'.raw.log')
    with os.fdopen(os.open(raw,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'wb') as f:
        f.write(result.stdout)
    public_bytes=result.stdout.decode('utf-8','replace').replace(str(private),'<private-review>')
    public_bytes=public_bytes.replace(str(out.parents[3]),'<repository>').replace(str(Path.home()),'<local-home>')
    public_bytes=re.sub(r'/Users/[^/\s]+','<local-home>',public_bytes)
    public_bytes=re.sub(r'\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b','<synthetic-uuid>',public_bytes).encode()
    public=out/(label+'.public.log')
    public.write_bytes(public_bytes)
    row={'name':label,'command':['node','<frozen-original-probe>' if script.parent==out.parent else '<followup>/'+script.name],
         'exit_code':result.returncode,'seconds':round(time.monotonic()-start,3),
         'script_sha256':sha(script.read_bytes()),'raw_log':raw.name,'raw_sha256':sha(result.stdout),
         'public_log':public.name,'public_sha256':sha(public_bytes),'raw_mode':oct(raw.stat().st_mode&0o777)}
    if result.returncode==0:
        row['observed']=json.loads(result.stdout.decode())
    return row

checks=[run('original-finding',out.parent/'query-overloads-probe.mjs'),
        run('dispatch-boundaries',out/'dispatch-probe.mjs')]
verification={'checks':checks,'scope':'原 finding 与最小修复边界；未重复完整模块或全量','all_passed':False}
(out/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2)+'\n')
assert all(row['exit_code']==0 for row in checks)
assert all(row['controlled'] for row in checks[0]['observed']['results'])
assert checks[0]['observed']['domain_identity_preserved'] is True
assert checks[1]['observed']['passed']==3
verification['all_passed']=True
(out/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'original_overloads_controlled':4,'domain_identity_preserved':True,'independent_boundary_checks':3,'all_passed':True}))
