"""离线整理全部样本；不启动HTTP/PG，不改冻结门槛或分母。"""
from pathlib import Path
import json,statistics,collections,hashlib
HERE=Path(__file__).resolve().parent
run=json.loads((HERE/'result.json').read_text());stages=json.loads((HERE/'C-full-observer-stages.json').read_text())
def pct(values,p=.95):
 a=sorted(values);x=(len(a)-1)*p;i=int(x);return a[i]+(a[min(i+1,len(a)-1)]-a[i])*(x-i)
def stats(v):return {'n':len(v),'p50':statistics.median(v),'p95':pct(v),'min':min(v),'max':max(v)} if v else {'n':0}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
phases=['A-old-anchor','B-full-baseline','C-full-observer','D-old-anchor'];cases=['contacts','sources','session-default']
analysis={'diagnostic_only':True,'formal_performance_qualified':False,'input_sha256':{f:sha(HERE/f) for f in ['result.json','C-full-observer-stages.json','source-preparation.json']},'cases':{},'boundary_sample_counts':{},'unknowns':run['unknowns'],'new_measurement_processes':0,'note':'p50/p95不相加；占比先逐请求算，再汇总；嵌套catalog/files不重复计入inspect。'}
rawmap={s['request_id']:s for s in stages['request_samples']}
for case in cases:
 per={p:stats([r['server_response_ms'] for r in run['rows'] if r['phase']==p and r['case_id']==case and not r['warmup'] and r['terminal_status']=='succeeded']) for p in phases}
 item=analysis['cases'][case]={'server_response_ms':per,'old_anchor_D_over_A':{k:per[phases[3]][k]/per[phases[0]][k] for k in ['p50','p95']},'observer_C_over_B':{k:per[phases[2]][k]/per[phases[1]][k] for k in ['p50','p95']},'baseline_B_over_old':{p:{k:per[phases[1]][k]/per[p][k] for k in ['p50','p95']} for p in [phases[0],phases[3]]},'spans_ms':{},'per_request_share':{},'transactions':{},'boundaries':{}}
 allrows=[r for r in run['rows'] if r['phase']=='C-full-observer' and r['case_id']==case]
 rows=[r for r in allrows if not r['warmup']];samples=[rawmap[r['request_id']] for r in rows]
 labels=sorted({p[1] for r in allrows for p in rawmap[r['request_id']]['points']})
 for label in labels:
  item['boundaries'][label]={'all_requests':sum(any(p[1]==label for p in rawmap[r['request_id']]['points']) for r in allrows),'scored_requests':sum(any(p[1]==label for p in rawmap[r['request_id']]['points']) for r in rows),'all_occurrences':sum(p[1]==label for r in allrows for p in rawmap[r['request_id']]['points']),'scored_occurrences':sum(p[1]==label for r in rows for p in rawmap[r['request_id']]['points'])}
 pairs=[('ingress_to_context','ingress','context.enter'),('private_false_await','private.before','private.after'),('auth','private.after','auth.done'),('public_false_await','public.before','public.after'),('handoff','handoff.before','handoff.after'),('context','context.enter','context.return'),('after_context','context.return','finish'),('body_read','body.before','body.after'),('body_parse','body.after','body.parsed'),('scope_and_session','scope.dispatch.before','scope.dispatch.after'),('manual_scope_to_session','scope.dispatch.before','session.before'),('default_session','session.before','session.after'),('response_json','json.before','json.after'),('response_end_to_finish','response.end.return','finish')]
 for label,start,end in pairs:
  values=[];shares=[]
  for row,sample in zip(rows,samples):
   p={x[1]:x[0] for x in sample['points']}
   if start in p and end in p:
    v=p[end]-p[start];values.append(v);shares.append(v/row['server_response_ms'])
  if values:item['spans_ms'][label]=stats(values);item['per_request_share'][label]=stats(shares)
 txvalues=collections.defaultdict(lambda:collections.defaultdict(list));totalfractions=collections.defaultdict(list)
 txpairs=[('storage','storage.enter','storage.exit'),('configuration','config.before','config.after'),('acquire_lease','acquire.before','acquire.after'),('begin_and_set','acquire.after','operation.before'),('operation','operation.before','operation.after'),('fresh_inspect','inspect.before','inspect.after'),('fresh_files','files.before','files.after'),('catalog_dispatch_to_result','catalog.dispatch','catalog.result'),('catalog_residual_await','catalog.await','catalog.result'),('after_catalog_checks','catalog.result','inspect.after'),('business_after_inspect','inspect.after','operation.after'),('commit','commit.before','commit.after'),('release','release.before','storage.exit')]
 for row,sample in zip(rows,samples):
  by=collections.defaultdict(dict)
  for t,label,n in sample['points']:by[n][label]=t
  sums=collections.defaultdict(float)
  for n,p in by.items():
   if n==0:continue
   for label,a,b in txpairs:
    if a in p and b in p:
     v=p[b]-p[a];txvalues[n][label].append(v);sums[label]+=v
  for label,v in sums.items():totalfractions[label].append(v/row['server_response_ms'])
 item['transactions']={str(n):{k:stats(v) for k,v in values.items()} for n,values in txvalues.items()}
 item['per_request_transaction_share']={k:stats(v) for k,v in totalfractions.items()}
 item['process_cpu_ms']=stats([(s['cpu_us']['user']+s['cpu_us']['system'])/1000 for s in samples]);item['event_loop_utilization']=stats([s['elu']['utilization'] for s in samples])
 item['monotonic_point_failures']=sum(any(a[0]>b[0] for a,b in zip(s['points'],s['points'][1:])) for s in samples)
 item['finish_to_http_max_abs_delta_ms']=max(abs(next(p[0] for p in s['points'] if p[1]=='finish')-r['server_response_ms']) for r,s in zip(rows,samples))
 item['response_hash_counts']={phase:dict(collections.Counter(r['response_sha256'] for r in run['rows'] if r['phase']==phase and r['case_id']==case)) for phase in phases}
 # 独立首层相邻区间检验，保留POST独有的整段public处理，不与子段相加。
 anchors=(['ingress','private.before','private.after','auth.done','public.before','public.after','handoff.before','context.enter','context.return','respond.begin','json.before','json.after','response.end.return','finish'] if case!='session-default' else ['ingress','private.before','private.after','auth.done','public.before','body.before','body.after','body.parsed','scope.dispatch.before','session.before','session.after','scope.dispatch.after','respond.begin','json.before','json.after','response.end.return','finish'])
 errors=[]
 for row,s in zip(rows,samples):
  p={x[1]:x[0] for x in s['points']};total=sum(p[b]-p[a] for a,b in zip(anchors,anchors[1:]));errors.append(abs(total-row['server_response_ms']))
 item['exclusive_top_partition_max_abs_delta_ms']=max(errors)
refresh_start=next(e['time_ms'] for e in stages['events'] if e['label']=='task.refresh.before')
refresh_end=next(e['time_ms'] for e in stages['events'] if e['label']=='task.refresh.after')
analysis['actual_events']={'ready_events':stages['events'],'task_refresh_duration_ms':refresh_end-refresh_start,'task_refresh_overlaps_marked_samples':sum(s['ingress_ms']<=refresh_end and s['ingress_ms']+next(p[0] for p in s['points'] if p[1]=='finish')>=refresh_start for s in stages['request_samples']),'task_refresh_end_to_first_marked_ingress_ms':min(s['ingress_ms'] for s in stages['request_samples'])-refresh_end,'marked_ingress_to_last_finish_ms':max(s['ingress_ms']+next(p[0] for p in s['points'] if p[1]=='finish') for s in stages['request_samples'])-min(s['ingress_ms'] for s in stages['request_samples'])}
analysis['all_marker_samples']=len(stages['request_samples']);analysis['limits']=stages['limits'];analysis['durability_verified_count']=sum(r.get('durability_verified',False) for r in run['rows']);analysis['total_successes']=sum(r['terminal_status']=='succeeded' for r in run['rows'])
(HERE/'analysis.json').write_text(json.dumps(analysis,ensure_ascii=False,indent=2)+'\n')
for case,v in analysis['cases'].items():
 print(case,json.dumps({'p50_ms':{p:v['server_response_ms'][p]['p50'] for p in phases},'old_D_over_A':v['old_anchor_D_over_A'],'observer_C_over_B':v['observer_C_over_B'],'inspect_share_median':v['per_request_transaction_share']['fresh_inspect']['p50'],'catalog_residual_share_median':v['per_request_transaction_share']['catalog_residual_await']['p50'],'monotonic_failures':v['monotonic_point_failures'],'partition_error_ms':v['exclusive_top_partition_max_abs_delta_ms']}))
print('actual_events',json.dumps(analysis['actual_events']))
# 客户端也保留同一批原请求；finish后观察工作不能隐藏在服务器时间之外。
for case,item in analysis['cases'].items():
 clients={p:{k:v for k,v in stats([r['client_response_ms'] for r in run['rows'] if r['phase']==p and r['case_id']==case and not r['warmup']]).items() if k in ['n','p50','p95']} for p in phases}
 item['client_response_ms']=clients
 item['client_observer_C_over_B']={k:clients['C-full-observer'][k]/clients['B-full-baseline'][k] for k in ['p50','p95']}
 item['client_minus_server_ms']={p:{k:v for k,v in stats([r['client_response_ms']-r['server_response_ms'] for r in run['rows'] if r['phase']==p and r['case_id']==case and not r['warmup']]).items() if k in ['n','p50','p95']} for p in phases}
(HERE/'analysis.json').write_text(json.dumps(analysis,ensure_ascii=False,indent=2)+'\n')
