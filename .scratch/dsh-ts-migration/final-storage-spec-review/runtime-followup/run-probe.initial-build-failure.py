"""根明确归还窗口后才运行；只启动两次独立合成Node探针，不启动产品宿主。"""
from pathlib import Path
import argparse, hashlib, json, os, re, subprocess, tempfile, time

parser=argparse.ArgumentParser()
parser.add_argument('--node',required=True)
parser.add_argument('--runtime-window-authorized',action='store_true')
args=parser.parse_args()
if not args.runtime_window_authorized:
    raise SystemExit('等待根显式归还运行窗口；本轮不执行')
here=Path(__file__).resolve().parent
repo=here.parents[3]
node=Path(args.node).resolve(strict=True)
results=here/'execution-v1'
results.mkdir(exist_ok=False)
def verify_static_v1():
    for line in (here.parent/'SHA256SUMS').read_text().splitlines():
        expected,relative=line.split('  ',1)
        if hashlib.sha256((here.parent/relative).read_bytes()).hexdigest()!=expected:
            raise SystemExit('原静态v1摘要不匹配：'+relative)
verify_static_v1()
private=Path(tempfile.mkdtemp(prefix='notalone-spec-priority-private-'))
os.chmod(private,0o700)
summary={'schema_version':'independent-priority-runtime-v1','node_sha256':hashlib.sha256(node.read_bytes()).hexdigest(),'runs':[],'static_v1_unchanged':True}
started=time.monotonic()
for label,extra in [('base-red',['--base-red']),('candidate',[])]:
    env={'PATH':'/usr/bin:/bin','HOME':str(private),'TMPDIR':str(private)}
    command=[str(node),str(here/'probe.mjs'),'--runtime-window-authorized',*extra]
    before=time.monotonic()
    try:
        run=subprocess.run(command,cwd=repo,env=env,capture_output=True,timeout=max(1,75-(time.monotonic()-started)))
        code=run.returncode;stdout=run.stdout;stderr=run.stderr
    except subprocess.TimeoutExpired as error:
        code=124;stdout=error.stdout or b'';stderr=error.stderr or b''
    raw=stdout+b'\nSTDERR\n'+stderr
    raw_path=private/(label+'.raw.log');raw_path.write_bytes(raw);os.chmod(raw_path,0o600)
    def scrub(value):
        text=value.decode(errors='replace').replace(str(repo),'<repo>').replace(str(private),'<private>')
        return re.sub(r'/Users/[^\s:]+','<local-path>',text)
    (results/(label+'.stdout.json')).write_text(scrub(stdout))
    (results/(label+'.stderr.log')).write_text(scrub(stderr))
    try:public=json.loads(stdout)
    except json.JSONDecodeError:public={'state':'runner_failed','total':0,'failed':1}
    summary['runs'].append({'arm':label,'exit_code':code,'elapsed_seconds':time.monotonic()-before,'state':public['state'],'total':public['total'],'failed':public['failed'],'raw_sha256':hashlib.sha256(raw).hexdigest()})
summary['state']='passed' if len(summary['runs'])==2 and summary['runs'][0]['exit_code']==2 and summary['runs'][0]['total']==1 and summary['runs'][0]['failed']==1 and summary['runs'][1]['exit_code']==0 and summary['runs'][1]['failed']==0 else 'failed'
verify_static_v1()
summary['elapsed_seconds']=time.monotonic()-started
summary['data_scope']={'synthetic_loopback_http_only':True,'database_queries':0,'product_hosts':0,'app_or_wechat':False,'model_calls':0}
(results/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
(results/'private-raw-locator.json').write_text(json.dumps({'directory':str(private)},ensure_ascii=False)+'\n')
os.chmod(results/'private-raw-locator.json',0o600)
print(json.dumps(summary,ensure_ascii=False,indent=2))
raise SystemExit(0 if summary['state']=='passed' else 2)
