"""只离线分析本次结果，不执行SQL或把不同执行相减。"""
from pathlib import Path
import json,statistics,re,hashlib
HERE=Path(__file__).resolve().parent;RESULTS=HERE/'results-run-01'
def stats(v):
 if not v:return {'n':0}
 a=sorted(v);x=(len(a)-1)*.95;i=int(x)
 return {'n':len(a),'p50':statistics.median(a),'p95':a[i]+(a[min(i+1,len(a)-1)]-a[i])*(x-i),'min':min(a),'max':max(a)}
def walk(node,path='Plan'):
 yield path,node
 for i,child in enumerate(node.get('Plans',[])):yield from walk(child,path+'.Plans['+str(i)+']')
def main():
 run=json.loads((RESULTS/'result.json').read_text());probe=run['probe'];allrows=probe['rows']
 out={'diagnostic_only':True,'formal_performance_qualified':False,'input_result_sha256':hashlib.sha256((RESULTS/'result.json').read_bytes()).hexdigest(),'planned_units':40,'unit_status_counts':{s:sum(r['status']==s for r in allrows) for s in ['succeeded','failed','not_attempted','unknown']},'all_rows':[],'unknowns':probe.get('unknowns',[]),'actual_transaction_settings':probe.get('actual_transaction_settings'),'notes':['PG planning/execution仅同一次EXPLAIN内相加','EXPLAIN未覆盖剩余不叫客户端开销','不相减raw与EXPLAIN，更不相减首轮HTTP','cast或索引形状不足以证明因果'],'physical_counts':{k:v for k,v in probe.items() if k.startswith('physical_') or k.startswith('setup_')}}
 metrics={};count_points={};node_summary={}
 for row in allrows:
  data={'index':row['index'],'warmup':row['warmup'],'status':row['status']};out['all_rows'].append(data)
  if row['status']!='succeeded':data['unknown_reason']=row.get('error',row.get('unknown_reason'));continue
  points={p['label']:p['time_ms'] for p in row['points']}
  expected=['catalog.dispatch','files.before','files.after','catalog.await','catalog.resume']
  data['missing_points']=[p for p in expected if p not in points];data['metrics_ms']={}
  for label,start,end in [('raw_dispatch_resume','catalog.dispatch','catalog.resume'),('fresh_files','files.before','files.after'),('raw_residual_await','catalog.await','catalog.resume')]:
   if start in points and end in points:data['metrics_ms'][label]=points[end]-points[start]
  data['metrics_ms']['explain_client_await']=row['explain_finished_ms']-row['explain_started_ms']
  data['metrics_ms']['transaction']=row['finished_ms']-row['started_ms']
  plan=row['explain'][0];data['actual_plan_nodes']=[]
  for label,key in [('pg_planning','Planning Time'),('pg_execution','Execution Time')]:
   if key in plan:data['metrics_ms'][label]=plan[key]
  if 'pg_planning' in data['metrics_ms'] and 'pg_execution' in data['metrics_ms']:
   data['metrics_ms']['same_explain_reported_pg_sum']=data['metrics_ms']['pg_planning']+data['metrics_ms']['pg_execution']
   data['metrics_ms']['same_explain_uncovered_remaining']=data['metrics_ms']['explain_client_await']-data['metrics_ms']['same_explain_reported_pg_sum']
  data['jit']=plan.get('JIT');data['raw_envelope_counts']={k:len(v) if isinstance(v,list) else None for k,v in row.get('raw_envelope',{}).items()};data['connection']=row['raw_connection'];data['same_connection']=row['raw_connection']==row['explain_connection']
  for path,node in walk(plan.get('Plan',{})):
   if node.get('Relation Name') not in ['pg_class','pg_attribute']:continue
   keys=['Node Type','Relation Name','Alias','Index Name','Index Cond','Filter','Join Filter','Hash Cond','Merge Cond','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Join Filter']
   fact={'path':path,**{k:node[k] for k in keys if k in node},**{k:v for k,v in node.items() if k.startswith(('Shared ','Local ','Temp '))}}
   cond=' '.join(str(node.get(k,'')) for k in ['Index Cond','Filter','Join Filter','Hash Cond','Merge Cond'])
   fact['cast_text_visible']=bool(re.search(r'::text\b',cond));fact['cast_name_visible']=bool(re.search(r'::name\b',cond));fact['name_mentioned_in_index_cond']=bool(re.search(r'\b(?:relname|attname)\b',node.get('Index Cond','')))
   data['actual_plan_nodes'].append(fact)
  if not row['warmup']:
   for label,v in data['metrics_ms'].items():metrics.setdefault(label,[]).append(v)
   for label in expected:count_points[label]=count_points.get(label,0)+int(label in points)
 out['scored_metric_summary']= {k:stats(v) for k,v in metrics.items()};out['scored_boundary_counts']=count_points
 out['same_connection_complete']=all(r.get('same_connection',False) for r in out['all_rows'] if r['status']=='succeeded')
 (RESULTS/'analysis.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'statuses':out['unit_status_counts'],'metrics':out['scored_metric_summary'],'boundaries':count_points,'physical_counts':out['physical_counts']},ensure_ascii=False))
if __name__=='__main__':main()
