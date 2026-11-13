/** 真实样本验收辅助。只通过已有回环HTTP变更；数据库只复制后只读，不输出正文或凭据。 */
import {readFile,writeFile,mkdtemp,copyFile,chmod,rm,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {runTargetsReleased} from '../../../backend-ts/src/memory/sqlite/run-retirement.ts';
import {isolatedContactItemIds} from '../../../backend-ts/src/memory/sqlite/image-isolation.ts';
import {assertContribution} from '../../../backend-ts/src/memory/sqlite/qualification.ts';

const privateRoot='/tmp/notalone-image-reliability-hw9x92j_';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const reason=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(value)?value:'accept_live_unavailable';
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
/** 沿桌面readConnection同一合同；避免Node strip-only导入桌面的参数属性语法。 */
async function readConnection(path:string){
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){throw Error((error as NodeJS.ErrnoException).code==='ENOENT'?'accept_live_backend_unavailable':'accept_live_info_invalid');}
 try{
  const entry=await file.stat();if(!entry.isFile()||entry.size>4096||(entry.mode&0o077)!==0||entry.uid!==process.getuid?.())throw Error('accept_live_info_invalid');
  const buffer=Buffer.alloc(4097),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>4096)throw Error('accept_live_info_invalid');
  const values=new Map<string,string>();for(const line of buffer.subarray(0,bytesRead).toString('utf8').split('\n')){
   if(!line)continue;const match=/^(address|token|pid)=(.+)$/.exec(line);if(!match||values.has(match[1]))throw Error('accept_live_info_invalid');values.set(match[1],match[2]);
  }
  const match=/^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(values.get('address')??''),port=Number(match?.[1]),pid=Number(values.get('pid'));
  const token=values.get('token')??'';
  if(values.size!==3||!match||port>65535||!/^[A-Za-z0-9_-]{1,256}$/.test(token)||!/^[1-9][0-9]{0,9}$/.test(values.get('pid')??'')||pid>2147483647)throw Error('accept_live_info_invalid');
  return {port,pid,token};
 }finally{await file.close();}
}
type Scope={ownerId:string;contactId:string;imageCount:number};
type Options={command:string;scopePath:string;databasePath:string;infoPath:string;offline:boolean;maxPolls:number;intervalMs:number;runId?:string;requestKey:string;operationId:string};
function options():Options{
 const args=process.argv.slice(2),command=args.shift()??'preflight';
 if(!['preflight','status','summary','audit','poll','history','readjudicate','retry','continue','pause','drain','automatic-off'].includes(command))throw Error('accept_live_command_invalid');
 const values=new Map<string,string>();let offline=false;
 while(args.length){const key=args.shift()!;if(key==='--offline'){offline=true;continue;}if(!['--scope','--database','--info','--max-polls','--interval-ms','--run-id','--request-key','--operation-id'].includes(key)||!args.length||values.has(key))throw Error('accept_live_argument_invalid');values.set(key,args.shift()!);}
 const result:Options={command,offline,scopePath:values.get('--scope')??join(privateRoot,'stage6-scope.json'),
  databasePath:values.get('--database')??join(homedir(),'Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite'),
  infoPath:values.get('--info')??join(homedir(),'Library/Application Support/NotAloneDesktop/managed/sqlite-backend.info'),
  maxPolls:Number(values.get('--max-polls')??180),intervalMs:Number(values.get('--interval-ms')??2000),runId:values.get('--run-id'),
  requestKey:values.get('--request-key')??randomUUID(),operationId:values.get('--operation-id')??randomUUID()};
 if(![result.scopePath,result.databasePath,result.infoPath].every(isAbsolute)||!Number.isSafeInteger(result.maxPolls)||result.maxPolls<1||result.maxPolls>3600
  ||!Number.isSafeInteger(result.intervalMs)||result.intervalMs<250||result.intervalMs>10000||result.runId!==undefined&&!uuid(result.runId)||!uuid(result.requestKey)||!uuid(result.operationId))throw Error('accept_live_argument_invalid');
 if(offline&&!['preflight','summary','audit'].includes(command))throw Error('accept_live_offline_command_invalid');return result;
}
async function loadScope(path:string):Promise<Scope>{
 const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink()||(entry.mode&0o077)!==0||entry.uid!==process.getuid?.())throw Error('accept_live_scope_file_invalid');
 const value=JSON.parse(await readFile(path,'utf8'));
 if(!uuid(value.ownerId)||!uuid(value.contactId)||value.imageCount!==14)throw Error('accept_live_scope_file_invalid');
 return {ownerId:value.ownerId,contactId:value.contactId,imageCount:value.imageCount};
}
/** 副本与WAL/SHM全部在任务私有目录，查询结束即删除；复制竞争最多重试三次。 */
async function snapshot<T>(opts:Options,scope:Scope,read:(db:DatabaseSync)=>T):Promise<T>{
 for(let attempt=0;attempt<3;attempt++){
  const root=await mkdtemp(join(privateRoot,'live-readonly-'));await chmod(root,0o700);let db:DatabaseSync|undefined;
  try{
   for(const suffix of ['', '-wal','-shm']){
    try{const source=opts.databasePath+suffix,entry=await lstat(source);if(!entry.isFile()||entry.isSymbolicLink()||entry.uid!==process.getuid?.())throw Error('accept_live_database_invalid');await copyFile(source,join(root,'snapshot.sqlite')+suffix,constants.COPYFILE_EXCL);await chmod(join(root,'snapshot.sqlite')+suffix,0o600);}
    catch(error){if(suffix&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
   }
   db=new DatabaseSync(join(root,'snapshot.sqlite'),{readOnly:true});
   if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw Error('accept_live_snapshot_inconsistent');
   return read(db);
  }catch(error){if(attempt===2)throw error;}
  finally{db?.close();await rm(root,{recursive:true,force:true});}
 }
 throw Error('accept_live_snapshot_failed');
}
function metadata(db:DatabaseSync,scope:Scope,runId?:string){
 const get=(sql:string,parameters:any[]=[])=>db.prepare(sql).get(...parameters),all=(sql:string,parameters:any[]=[])=>db.prepare(sql).all(...parameters);
 const tx={get,all,run(){throw Error('accept_live_readonly_violation');}} as any;
 const instance=get('SELECT database_id,memory_auto_processing FROM database_instance WHERE slot=1')!;
 const contact=get("SELECT display_name,remark,state FROM contact WHERE owner_id=? AND id=?",[scope.ownerId,scope.contactId]);
 const nameMatches=contact?.state==='active'&&(contact.display_name==='王威'||contact.remark==='王威');
 const uniqueName=Number(get("SELECT count(*) AS n FROM contact WHERE owner_id=? AND state='active' AND (display_name=? OR remark=?)",[scope.ownerId,'王威','王威'])!.n)===1;
 const unknown=Number(get(`SELECT count(DISTINCT c.id) AS n FROM model_call c JOIN operation_scope s ON s.owner_id=c.owner_id AND s.operation_id=c.operation_id
  WHERE c.owner_id=? AND s.source_contact_id=? AND (c.state IN ('prepared','sending','unknown') OR c.settlement_state IN ('reserved','unknown'))`,[scope.ownerId,scope.contactId])!.n);
 const files=all(`SELECT f.id,f.byte_size,p.id AS item_id,p.extraction_state FROM media_file f LEFT JOIN processing_item p
  ON p.owner_id=f.owner_id AND p.contact_id=f.contact_id AND p.message_id=f.message_id AND p.purpose='memory_extraction'
  WHERE f.owner_id=? AND f.contact_id=? AND f.role='image_display' AND f.content_state='present' AND f.publish_state='current'
  AND f.container_valid=1 AND f.viewable=1 ORDER BY f.created_at,f.id`,[scope.ownerId,scope.contactId]);
 const isolated=isolatedContactItemIds(tx,scope.ownerId,scope.contactId);
 const versions=all(`SELECT json_extract(img.value,'$.id') AS id,json_extract(img.value,'$.bytes') AS bytes,
  json_extract(img.value,'$.width') AS width,json_extract(img.value,'$.height') AS height,json_extract(img.value,'$.requestMimeType') AS format,c.state
  FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.originated_call_id JOIN json_each(e.payload,'$.images') img
  WHERE e.owner_id=? AND t.contact_id=? AND e.kind='image_inputs'`,[scope.ownerId,scope.contactId]);
 const images=files.map(file=>{const sent=versions.filter(version=>version.id===file.id),known=sent.filter(version=>version.state==='succeeded');
  const state=file.extraction_state==='succeeded'?(known.length?'succeeded':'succeeded_without_image_trace'):isolated.has(String(file.item_id))?'isolated':'pending';
  return {imageId:String(file.id),originalBytes:Number(file.byte_size),state,reason:state==='isolated'?'media_model_input_unavailable':null,
   successfulCalls:known.length,sent:sent.map(version=>({bytes:Number(version.bytes),width:Number(version.width),height:Number(version.height),format:String(version.format),state:reason(version.state)}))};});
 const calls=all(`SELECT o.purpose,c.state,c.settlement_state,count(DISTINCT c.id) AS n FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  JOIN operation_scope s ON s.owner_id=c.owner_id AND s.operation_id=c.operation_id WHERE c.owner_id=? AND s.source_contact_id=?
  GROUP BY o.purpose,c.state,c.settlement_state ORDER BY o.purpose,c.state`,[scope.ownerId,scope.contactId]).map(row=>({purpose:reason(row.purpose),state:reason(row.state),settlement:reason(row.settlement_state),count:Number(row.n)}));
 const scopedRuns=all('SELECT DISTINCT run_id FROM run_contact WHERE owner_id=? AND contact_id=?',[scope.ownerId,scope.contactId]);
 const mixedRuns=Number(get(`SELECT count(DISTINCT r.run_id) AS n FROM run_contact r JOIN run_input i ON i.owner_id=r.owner_id AND i.run_id=r.run_id
  WHERE r.owner_id=? AND r.contact_id=? AND i.source_contact_id<>?`,[scope.ownerId,scope.contactId,scope.contactId])!.n);
 const targetRunScopeValid=runId===undefined||!!get('SELECT 1 FROM run_contact WHERE owner_id=? AND run_id=? AND contact_id=?',[scope.ownerId,runId,scope.contactId])
  &&!get('SELECT 1 FROM run_input WHERE owner_id=? AND run_id=? AND source_contact_id<>? LIMIT 1',[scope.ownerId,runId,scope.contactId])
  &&!get('SELECT 1 FROM task_contribution WHERE owner_id=? AND run_id=? AND source_contact_id<>? LIMIT 1',[scope.ownerId,runId,scope.contactId]);
 const residualDetails=(id:string)=>{
  const run=get('SELECT state,pause_requested_at,accepted_owner_feedback_revision,policy_config FROM processing_run WHERE owner_id=? AND id=?',[scope.ownerId,id])!;
  const owner=get('SELECT feedback_revision FROM owner WHERE owner_id=?',[scope.ownerId])!;
  const contacts=all(`SELECT rc.*,c.selection_generation AS current_selection,c.data_generation AS current_data,c.feedback_revision AS current_feedback,
   b.identity_generation AS current_identity,a.scope_revision AS current_account,a.source_generation AS current_source,
   g.revoked_at AS old_grant_revoked,g.selection_generation AS old_grant_selection,latest.id AS latest_grant_id
   FROM run_contact rc JOIN contact c ON c.owner_id=rc.owner_id AND c.id=rc.contact_id
   LEFT JOIN read_grant g ON g.owner_id=rc.owner_id AND g.id=rc.grant_id LEFT JOIN read_grant latest ON latest.owner_id=rc.owner_id AND latest.contact_id=rc.contact_id AND latest.revoked_at IS NULL
   LEFT JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id LEFT JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id
   LEFT JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id WHERE rc.owner_id=? AND rc.run_id=?`,[scope.ownerId,id]);
  const matches=contacts.map(contact=>{let contribution=true;try{assertContribution(tx,scope.ownerId,id,String(contact.contact_id));}catch{contribution=false;}
   return {contribution,selection:contact.accepted_selection_generation===contact.current_selection&&contact.old_grant_selection===contact.current_selection,
    data:contact.accepted_data_generation===contact.current_data,feedback:contact.accepted_feedback_revision===contact.current_feedback,
    identity:contact.accepted_identity_generation===contact.current_identity,account:contact.accepted_account_revision===contact.current_account,
    source:contact.accepted_source_generation===contact.current_source,latestGrant:contact.grant_id===contact.latest_grant_id,oldGrantActive:contact.old_grant_revoked===null};});
  const counters=all(`SELECT count(DISTINCT CASE WHEN t.state='unknown' THEN t.id END) AS tasks,
   count(DISTINCT CASE WHEN s.state IN ('running','unknown') THEN s.id END) AS steps,
   count(DISTINCT CASE WHEN a.state IN ('running','unknown') THEN a.id END) AS attempts,
   count(DISTINCT CASE WHEN o.state IN ('prepared','in_flight','unknown') THEN o.id END) AS operations,
   count(DISTINCT CASE WHEN c.state IN ('prepared','sending','unknown') OR c.settlement_state IN ('reserved','unknown') THEN c.id END) AS calls
   FROM processing_task t LEFT JOIN processing_step s ON s.owner_id=t.owner_id AND s.task_id=t.id
   LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_operation o ON o.owner_id=s.owner_id AND o.memory_step_id=s.id
   LEFT JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,id])[0];
  const pending=Number(get(`SELECT count(DISTINCT c.id) AS n FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
   JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   WHERE t.owner_id=? AND t.run_id=? AND c.state='pending'`,[scope.ownerId,id])!.n);
  const effects=Number(get(`SELECT count(DISTINCT o.id) AS n FROM model_operation o JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id
   JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? AND (
    EXISTS(SELECT 1 FROM operation_item item WHERE item.owner_id=o.owner_id AND item.operation_id=o.id AND item.state IN ('reserved','unknown'))
    OR EXISTS(SELECT 1 FROM operation_scope os WHERE os.owner_id=o.owner_id AND os.operation_id=o.id AND os.state IN ('reserved','unknown')))`,[scope.ownerId,id])!.n);
  const later=Number(get(`SELECT count(*) AS n FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
   WHERE q.owner_id=? AND q.run_id=? AND (q.outcome='unknown' OR s.state IN ('unknown','running'))`,[scope.ownerId,id])!.n);
  const config=JSON.parse(String(run.policy_config)),stale=matches.some(contact=>!contact.contribution),blockers={...counters,pendingCandidates:pending,reservedOrUnknownEffects:effects,laterUnsettled:later};
  return {ownerFeedbackMatches:run.accepted_owner_feedback_revision===owner.feedback_revision,contactCount:contacts.length,
   generationMatches:Object.fromEntries(['contribution','selection','data','feedback','identity','account','source','latestGrant','oldGrantActive'].map(key=>[key,matches.every(value=>(value as any)[key])])),
   policyCurrentShape:config?.version===2&&config.mode==='legacy'&&config.verification_policy==='complete-claim-v1'&&typeof config.source_stamp==='string',
   scopeStaleByCurrentContribution:stale,blockers,wouldRetireOnCurrentInitialize:(run.state==='paused'||run.pause_requested_at!==null)&&stale&&Object.values(blockers).every(value=>value===0)};
 };
 const residuals=Object.fromEntries([['failedLegacy','d8b8510d'],['stalePausedLegacy','c296e552']].map(([label,prefix])=>{
  const row=get('SELECT id,state FROM processing_run WHERE owner_id=? AND id LIKE ?',[scope.ownerId,prefix+'%']);
  return [label,row?{state:reason(row.state),targetsReleased:runTargetsReleased(tx,scope.ownerId,String(row.id)),details:residualDetails(String(row.id)),
   targets:Number(get("SELECT count(*) AS n FROM run_input WHERE owner_id=? AND run_id=? AND role='target'",[scope.ownerId,row.id])!.n),
   occupied:Number(get(`SELECT count(DISTINCT i.item_id) AS n FROM operation_item i JOIN model_operation o ON o.owner_id=i.owner_id AND o.id=i.operation_id
    JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE t.owner_id=? AND t.run_id=? AND i.state IN ('reserved','sent','unknown')`,[scope.ownerId,row.id])!.n)}:{state:'absent'}];
 }));
 const counts={total:images.length,succeeded:images.filter(image=>image.state==='succeeded').length,isolated:images.filter(image=>image.state==='isolated').length,
  pending:images.filter(image=>image.state==='pending').length,missingTrace:images.filter(image=>image.state==='succeeded_without_image_trace').length};
 return {databaseId:String(instance.database_id),automatic:Number(instance.memory_auto_processing),nameMatches,uniqueName,unknownCalls:unknown,
  onlySampleRunInputs:mixedRuns===0,targetRunScopeValid,sampleRunCount:scopedRuns.length,imageCounts:counts,images,calls,residuals,
  coverageComplete:images.length===14&&counts.succeeded+counts.isolated===14};
}
async function api(opts:Options,path:string,method:'GET'|'POST'='GET',body?:unknown):Promise<any>{
 const connection=await readConnection(opts.infoPath);if(!connection)throw Error('accept_live_backend_unavailable');
 output({phase:'diagnostic_request',endpoint:path.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/ig,'sample')}); const response=await fetch(`http://127.0.0.1:${connection.port}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(method==='POST'&&path==='/api/memory-processing/schedule'?15*60_000:method==='POST'?60_000:15_000),
  headers:{Authorization:`Bearer ${connection.token}`,Accept:'application/json','Content-Type':'application/json','X-Trace-Id':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.headers.get('content-type')?.startsWith('application/json'))throw Error('accept_live_response_invalid');
 const reader=response.body!.getReader();let length=0;const chunks:Uint8Array[]=[];
 for(;;){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>8*1024*1024){await reader.cancel();throw Error('accept_live_response_limit');}chunks.push(item.value);}
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!response.ok)throw Error(reason(data?.error));return data;
}
function activeWork(db:DatabaseSync,scope:Scope){
 const one=(sql:string)=>Number(db.prepare(sql).get(scope.ownerId,scope.contactId,scope.contactId)?.n??0);
 const scoped=`t.owner_id=? AND (t.contact_id=? OR EXISTS(SELECT 1 FROM task_contribution tc WHERE tc.owner_id=t.owner_id AND tc.task_id=t.id AND tc.source_contact_id=?))`;
 return {tasks:one(`SELECT count(*) AS n FROM processing_task t WHERE ${scoped} AND t.state='running'`),
  steps:one(`SELECT count(*) AS n FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE ${scoped} AND s.state='running'`),
  attempts:one(`SELECT count(*) AS n FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE ${scoped} AND a.state='running'`),
  calls:Number(db.prepare(`SELECT count(DISTINCT c.id) AS n FROM model_call c JOIN operation_scope sc ON sc.owner_id=c.owner_id AND sc.operation_id=c.operation_id WHERE c.owner_id=? AND sc.source_contact_id=? AND (c.state IN ('prepared','sending') OR c.settlement_state='reserved')`).get(scope.ownerId,scope.contactId)?.n??0)};
}
async function audit(opts:Options,scope:Scope){
 const path=join(privateRoot,'stage6-authorized.json'),entry=await lstat(path);
 const parent=await lstat(privateRoot);
 if(!entry.isFile()||entry.isSymbolicLink()||(entry.mode&0o022)!==0||entry.uid!==process.getuid?.()||!parent.isDirectory()||(parent.mode&0o077)!==0)throw Error('accept_live_authorization_invalid');
 const authorization=JSON.parse(await readFile(path,'utf8')),since=Number(authorization.start)*1000;
 if(!Number.isFinite(since)||since<1||authorization.preservedUsed!==8||authorization.limit!==96)throw Error('accept_live_authorization_invalid');
 return snapshot(opts,scope,db=>{
  const count=(sql:string,args:any[])=>Number(db.prepare(sql).get(...args)?.n??0);
  const foreign='(x.owner_id<>? OR x.source_contact_id<>?)';
  const runInputs=count(`SELECT count(*) AS n FROM run_input x JOIN processing_run r ON r.owner_id=x.owner_id AND r.id=x.run_id WHERE r.started_at>=? AND ${foreign}`,[since,scope.ownerId,scope.contactId]);
  const taskContributions=count(`SELECT count(*) AS n FROM task_contribution x JOIN processing_run r ON r.owner_id=x.owner_id AND r.id=x.run_id WHERE r.started_at>=? AND ${foreign}`,[since,scope.ownerId,scope.contactId]);
  const runContacts=count('SELECT count(*) AS n FROM run_contact x JOIN processing_run r ON r.owner_id=x.owner_id AND r.id=x.run_id WHERE r.started_at>=? AND (x.owner_id<>? OR x.contact_id<>?)',[since,scope.ownerId,scope.contactId]);
  const newCalls=`SELECT c.* FROM model_call c LEFT JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id
   WHERE c.sent_at>=? OR c.sent_at IS NULL AND a.started_at>=?`;
  const modelCalls=count(`WITH new_calls AS (${newCalls}) SELECT count(*) AS n FROM new_calls`,[since,since]);
  const foreignCallSources=count(`WITH new_calls AS (${newCalls}) SELECT count(DISTINCT c.id) AS n FROM new_calls c JOIN operation_scope x ON x.owner_id=c.owner_id AND x.operation_id=c.operation_id WHERE ${foreign}`,[since,since,scope.ownerId,scope.contactId]);
  const unprovenCalls=count(`WITH new_calls AS (${newCalls}) SELECT count(*) AS n FROM new_calls c WHERE NOT EXISTS(SELECT 1 FROM operation_scope x WHERE x.owner_id=c.owner_id AND x.operation_id=c.operation_id AND x.owner_id=? AND x.source_contact_id=?)`,[since,since,scope.ownerId,scope.contactId]);
  const foreignTaskSources=count(`WITH new_calls AS (${newCalls}) SELECT count(DISTINCT c.id) AS n FROM new_calls c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   WHERE (t.scope_kind='contact' AND (t.owner_id<>? OR t.contact_id<>?)) OR EXISTS(SELECT 1 FROM task_contribution tc WHERE tc.owner_id=t.owner_id AND tc.task_id=t.id AND (tc.owner_id<>? OR tc.source_contact_id<>?))`,[since,since,scope.ownerId,scope.contactId,scope.ownerId,scope.contactId]);
  const unprovenSelfCalls=count(`WITH new_calls AS (${newCalls}) SELECT count(DISTINCT c.id) AS n FROM new_calls c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   WHERE t.scope_kind='self' AND NOT EXISTS(SELECT 1 FROM task_contribution tc WHERE tc.owner_id=t.owner_id AND tc.task_id=t.id AND tc.owner_id=? AND tc.source_contact_id=?)`,[since,since,scope.ownerId,scope.contactId]);
  const globalUnknown=count("SELECT count(*) AS n FROM model_call WHERE state='unknown' OR settlement_state='unknown'",[]);
  const sampleUnknown=count(`SELECT count(DISTINCT c.id) AS n FROM model_call c JOIN operation_scope x ON x.owner_id=c.owner_id AND x.operation_id=c.operation_id WHERE x.owner_id=? AND x.source_contact_id=? AND (c.state='unknown' OR c.settlement_state='unknown')`,[scope.ownerId,scope.contactId]);
  return {newRuns:count('SELECT count(*) AS n FROM processing_run WHERE started_at>=?',[since]),newForeignRunInputs:runInputs,newForeignTaskContributions:taskContributions,newForeignRunContacts:runContacts,
   newModelCalls:modelCalls,newForeignModelCallSources:foreignCallSources,newUnprovenModelCalls:unprovenCalls,newForeignModelTaskSources:foreignTaskSources,newUnprovenSelfModelCalls:unprovenSelfCalls,
   globalUnknown,sampleUnknown,otherUnknown:globalUnknown-sampleUnknown,otherUnknownUnchanged:globalUnknown-sampleUnknown===4,
   passed:[runInputs,taskContributions,runContacts,foreignCallSources,unprovenCalls,foreignTaskSources,unprovenSelfCalls,sampleUnknown].every(value=>value===0)&&globalUnknown-sampleUnknown===4};
 });
}
async function saveMetadata(phase:string,value:any){
 await writeFile(join(privateRoot,`stage6-live-${phase}.json`),JSON.stringify(value,null,2),{mode:0o600});
 const {images,calls,...summary}=value;return {...summary,callCount:Array.isArray(calls)?calls.reduce((sum:number,call:any)=>sum+call.count,0):undefined};
}
function viewSummary(view:any){
 const run=view.run??view;const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:0;
 return {run:run?.runId?{state:reason(run.state),status:reason(run.status),reason:run.statusReason===null?null:reason(run.statusReason),stage:reason(run.stage),
  total:numeric(run.total),succeeded:numeric(run.succeeded),isolated:numeric(run.isolated),failed:numeric(run.failed),unknown:numeric(run.unknown),
  controlVersion:numeric(run.controlVersion),actions:Array.isArray(run.actions)?run.actions.filter((action:unknown)=>['continue','abandon_unknown','retry_images'].includes(String(action))):[]}:null,
  queue:view.queue?{pending:numeric(view.queue.pending),unavailable:numeric(view.queue.unavailable),historyPending:numeric(view.queue.history?.pending),
   laterPending:numeric(view.queue.later?.pending),laterStage:view.queue.later?.stage==null?null:reason(view.queue.later.stage),nextDueAt:typeof view.queue.later?.nextDueAt==='number'?view.queue.later.nextDueAt:null}:null};
}
async function preflight(opts:Options,scope:Scope,runId?:string){
 const meta=await snapshot(opts,scope,db=>metadata(db,scope,runId));
 const failures:string[]=[];if(!meta.nameMatches||!meta.uniqueName)failures.push('accept_live_contact_mismatch');if(meta.imageCounts.total!==scope.imageCount)failures.push('accept_live_image_count_mismatch');
 if(meta.automatic!==0)failures.push('accept_live_automatic_not_disabled');if(meta.unknownCalls)failures.push('accept_live_unknown_call');
 if(!meta.onlySampleRunInputs||!meta.targetRunScopeValid)failures.push('accept_live_run_scope_mismatch');
 let runtime:any,view:any,schedule:any;
 if(!opts.offline){
  runtime=await api(opts,'/api/runtime/status');
  if(runtime.storage!=='sqlite'||runtime.storageIdentity?.ownerId!==scope.ownerId||runtime.storageIdentity?.databaseId!==meta.databaseId||!runtime.storageIdentity?.available)failures.push('accept_live_backend_scope_mismatch');
  const automatic=await api(opts,'/api/memory-processing/automatic');if(automatic.enabled!==false)failures.push('accept_live_automatic_not_disabled');
  schedule=await api(opts,'/api/memory-processing/schedule');if(schedule.acceptanceBudgetBound!==true)failures.push('accept_live_budget_unbound');
  view=await api(opts,`/api/memory-processing/contacts/${scope.contactId}/current`);
 }
 return {meta,runtime,view,schedule,failures,readyForMutation:failures.length===0&&runtime?.background_processing==='manual'&&schedule?.acceptanceBudgetBound===true};
}
async function poll(opts:Options,scope:Scope){
 let last='',stable=0,view:any,lastActiveAt=0,active:any,idleProofs=0;
 for(let index=0;index<opts.maxPolls;index++){
  view=await api(opts,`/api/memory-processing/contacts/${scope.contactId}/current`);
  if(view.contactId!==scope.contactId)throw Error('accept_live_response_scope_mismatch');
  const summary=viewSummary(view),key=JSON.stringify(summary);stable=key===last?stable+1:0;if(key!==last){active=undefined;idleProofs=0;}last=key;
  if(index===0||index%15===0)output({phase:'poll',iteration:index,...summary});
  const status=view.run?.status;
  if(stable>=2&&!['processing','queued','running'].includes(status)){
   if(!active||Date.now()-lastActiveAt>=30_000||Object.values(active).every(count=>count===0)&&Date.now()-lastActiveAt>=opts.intervalMs){
    active=await snapshot(opts,scope,db=>activeWork(db,scope));lastActiveAt=Date.now();idleProofs=Object.values(active).every(count=>count===0)?idleProofs+1:0;output({phase:'poll_active',...active,idleProofs});
   }
   if(idleProofs>=2)return {settled:true,polls:index+1,view};
  }
  if(index+1<opts.maxPolls)await wait(opts.intervalMs);
 }
 return {settled:false,polls:opts.maxPolls,view};
}
async function main(){
 const opts=options(),scope=await loadScope(opts.scopePath),mutating=['history','readjudicate','retry','continue','pause','drain'].includes(opts.command);
 if(opts.command==='audit'){const value=await audit(opts,scope);output({phase:'audit',...value});await writeFile(join(privateRoot,'stage6-live-audit.json'),JSON.stringify(value,null,2),{mode:0o600});if(!value.passed)process.exitCode=1;return;}
 if(opts.command==='automatic-off'){
  const runtime=await api(opts,'/api/runtime/status');if(runtime.storageIdentity?.ownerId!==scope.ownerId)throw Error('accept_live_backend_scope_mismatch');
  await api(opts,'/api/memory-processing/automatic','POST',{enabled:false});const value=await api(opts,'/api/memory-processing/automatic');output({phase:'automatic_off',disabled:value.enabled===false});return;
 }
 if(opts.command==='status'){
  const runtime=await api(opts,'/api/runtime/status'),view=await api(opts,`/api/memory-processing/contacts/${scope.contactId}/current`),automatic=await api(opts,'/api/memory-processing/automatic');
  if(runtime.storageIdentity?.ownerId!==scope.ownerId||view.contactId!==scope.contactId)throw Error('accept_live_backend_scope_mismatch');
  output({phase:'status',automatic:automatic.enabled===true,backgroundMode:reason(runtime.background_processing),...viewSummary(view)});return;
 }
 if(opts.command==='summary'){
  const data=await snapshot(opts,scope,db=>metadata(db,scope,opts.runId));const {databaseId,...safe}=data;const finalAudit=await audit(opts,scope);output({phase:'summary',...await saveMetadata('summary',{...safe,audit:finalAudit})});if(!finalAudit.passed)process.exitCode=1;return;
 }
 if(opts.command==='poll'){const result=await poll(opts,scope);output({phase:'poll_result',settled:result.settled,polls:result.polls,...viewSummary(result.view)});return;}
 const checked=await preflight(opts,scope,opts.runId),{databaseId,...safe}=checked.meta;
 output({phase:'preflight',passed:checked.failures.length===0,readyForMutation:checked.readyForMutation,backgroundMode:checked.runtime?reason(checked.runtime.background_processing):'offline',
  acceptanceBudgetBound:checked.schedule?.acceptanceBudgetBound===true,failures:checked.failures,...await saveMetadata('preflight',safe)});
 if(!mutating){if(checked.failures.length)process.exitCode=1;return;}
 if(!checked.readyForMutation)throw Error(checked.failures[0]??'accept_live_manual_backend_required');
 let finalOff=false;
 try{
  let target=checked.view?.run;if(opts.runId)target=await api(opts,`/api/memory-processing/runs/${opts.runId}`);
  const runId=opts.runId??target?.runId;
  if(['retry','continue','pause'].includes(opts.command)&&!uuid(runId))throw Error('accept_live_run_required');
  if(uuid(runId)){
   const valid=await snapshot(opts,scope,db=>metadata(db,scope,runId));if(!valid.targetRunScopeValid)throw Error('accept_live_run_scope_mismatch');
  }
  if(opts.command!=='pause')await api(opts,'/api/memory-processing/automatic','POST',{enabled:true});
  let result;
  if(opts.command==='drain')result=await api(opts,'/api/memory-processing/schedule','POST',{});
  else if(opts.command==='history')result=await api(opts,`/api/memory-processing/contacts/${scope.contactId}/history`,'POST',{request_key:opts.requestKey});
  else if(opts.command==='readjudicate')result=await api(opts,`/api/memory-processing/contacts/${scope.contactId}/readjudicate`,'POST',{});
  else result=await api(opts,`/api/memory-processing/runs/${runId}/${opts.command==='retry'?'retry-images':opts.command}`,'POST',{action_version:target.controlVersion,operation_id:opts.operationId});
  output({phase:'accepted',command:opts.command,...viewSummary(result)});
  const resultOfPoll=await poll(opts,scope);output({phase:'operation_result',settled:resultOfPoll.settled,polls:resultOfPoll.polls,...viewSummary(resultOfPoll.view)});
 }finally{
  try{await api(opts,'/api/memory-processing/automatic','POST',{enabled:false});finalOff=(await api(opts,'/api/memory-processing/automatic')).enabled===false;}catch{finalOff=false;}
  output({phase:'finally',automaticDisabled:finalOff});if(!finalOff)process.exitCode=1;
 }
 const after=await snapshot(opts,scope,db=>metadata(db,scope));const {databaseId:ignored,...afterSafe}=after;const finalAudit=await audit(opts,scope);output({phase:'after',...await saveMetadata('after',{...afterSafe,audit:finalAudit})});if(!finalAudit.passed)process.exitCode=1;
}
await main().catch(error=>{output({phase:'failed',reason:reason(error instanceof Error?error.message:null),errorClass:reason(error?.constructor?.name?.replace(/[A-Z]/g,(v)=>'_'+v.toLowerCase()).replace(/^_/,'')),errorCode:typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:null,localFrame:error instanceof Error?error.stack?.split('\n').find(line=>line.includes('accept-live-diagnose.mts'))?.replace(/^.*accept-live-diagnose.mts/, 'accept-live-diagnose.mts'):null});process.exitCode=1;});
