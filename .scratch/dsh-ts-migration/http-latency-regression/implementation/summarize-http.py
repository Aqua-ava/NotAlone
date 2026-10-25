"""只重算已保存观测，沿用预注册统计器与 HTTP 阈值；不重跑请求。"""
from pathlib import Path
import hashlib, json, sys
sys.dont_write_bytecode=True
base=Path(__file__).resolve().parent
source=base.parents[3]/'.scratch/dsh-ts-migration/resumed-host-performance/host_statistics.py'
sys.path.insert(0,str(source.parent))
from host_statistics import metrics
run=json.loads((base/'http-recheck.json').read_text())
report={'diagnostic_only':True,'formal_performance_qualified':False,'formal_overall_gate':'not_executed','formal_startups_and_rss_not_executed':True,'statistics_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'input_sha256':hashlib.sha256((base/'http-recheck.json').read_bytes()).hexdigest(),'threshold_origin':'resumed-host-performance/host_statistics.py:124','http_thresholds':{'p50':1.15,'p95':1.25},'resamples':10000,'seed':102,'phases':{}}
for phase in ['before','after']:
 report['phases'][phase]={}
 for case in ['contacts','sources','session-default']:
  selected=[r for r in run['rows'] if r['phase']==phase and r['case_id']==case and not r['warmup']]
  item=metrics(selected,'server_response_ms',range(30),(1.15,1.25),'paired-http-repeat',True)
  item['planned_per_arm']=30
  item['failed_per_arm']={arm:sum(r['terminal_status']!='succeeded' for r in selected if r['arm']==arm) for arm in ['old','new']}
  report['phases'][phase][case]=item
path=base/'http-diagnostic-statistics.json'
path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
print(json.dumps({phase:{case:{p:{k:v for k,v in row[p].items() if k in ['ratio','ci95','threshold','gate']} for p in ['p50','p95']} for case,row in items.items()} for phase,items in report['phases'].items()},ensure_ascii=False))
