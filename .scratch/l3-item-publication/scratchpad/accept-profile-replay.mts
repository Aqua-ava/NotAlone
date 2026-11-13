/** 仅通过认证HTTP恢复指定旧核验；真实库仅副本只读，输出计数。 */
import {readFile,writeFile,mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
const root=(await readFile('/tmp/notalone-image-reliability-location','utf8')).trim();
const scope=JSON.parse(await readFile(root+'/stage6-scope.json','utf8'));
const source=homedir()+'/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite';
const infoPath=homedir()+'/Library/Application Support/NotAloneDesktop/managed/sqlite-backend.info';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function inspectOnce(){
 const dir=await mkdtemp(root+'/profile-readonly-');await chmod(dir,0o700);let db:DatabaseSync|undefined;
 try{
  for(const suffix of ['','-wal','-shm'])try{await copyFile(source+suffix,dir+'/snapshot.sqlite'+suffix);await chmod(dir+'/snapshot.sqlite'+suffix,0o600);}catch(error){if(!suffix||(error as any).code!=='ENOENT')throw error;}
  db=new DatabaseSync(dir+'/snapshot.sqlite',{readOnly:true});const get=(sql:string,...p:any[])=>db!.prepare(sql).get(...p) as any,all=(sql:string,...p:any[])=>db!.prepare(sql).all(...p) as any[];
  if(get('PRAGMA quick_check').quick_check!=='ok')throw Error('snapshot_invalid');
  const contact=get('SELECT display_name,remark,state FROM contact WHERE owner_id=? AND id=?',scope.ownerId,scope.contactId);
  if(contact?.state!=='active'||![contact.display_name,contact.remark].includes('王威'))throw Error('sample_mismatch');
  const target=get("SELECT task_id,state,error_code FROM memory_document_later_schedule WHERE owner_id=? AND contact_id=? AND generation=6 AND stage='document_profile'",scope.ownerId,scope.contactId);
  if(!target)throw Error('sample_task_missing');
  const task=get('SELECT run_id FROM processing_task WHERE owner_id=? AND id=?',scope.ownerId,target.task_id);
  const selected=get(`SELECT e.payload FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.task_id=? AND e.kind='document_profile_selection' AND a.state='succeeded' ORDER BY a.attempt_no DESC LIMIT 1`,scope.ownerId,target.task_id);
  const published=get("SELECT id FROM document_publication WHERE owner_id=? AND basis_task_id=? AND availability='available'",scope.ownerId,target.task_id);
  const statements=published?all(`SELECT s.block_no,s.body FROM publication_member p JOIN memory_document d ON d.owner_id=p.owner_id AND d.id=p.document_id JOIN document_statement s ON s.owner_id=p.owner_id AND s.document_id=p.document_id AND s.version_no=p.version_no WHERE p.owner_id=? AND p.publication_id=? AND d.kind='profile' ORDER BY s.block_no`,scope.ownerId,published.id):[];
  const packets=all(`SELECT e.id,e.payload,e.originated_call_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.task_id=? AND a.attempt_no=1 AND e.kind IN ('document_input','document_output') ORDER BY e.event_no`,scope.ownerId,target.task_id);
  const calls=all('SELECT id,state,settlement_state,receipt,received_at FROM model_call ORDER BY id');
  const contributions=all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',scope.ownerId,target.task_id);
  const selectedData=selected?JSON.parse(selected.payload):null;
  const run=get('SELECT state FROM processing_run WHERE owner_id=? AND id=?',scope.ownerId,task.run_id);
  const profileSteps=all("SELECT id,state,successful_attempt_id FROM processing_step WHERE owner_id=? AND task_id=? AND kind='document_profile'",scope.ownerId,target.task_id);
  const attempts=profileSteps.length===1?all('SELECT attempt_no,state,error_code FROM step_attempt WHERE owner_id=? AND step_id=? ORDER BY attempt_no',scope.ownerId,profileSteps[0].id):[];
  return {taskId:target.task_id,runId:task.run_id,runState:run.state,profileStepStates:profileSteps.map(s=>s.state),attempts,automatic:get('SELECT memory_auto_processing FROM database_instance WHERE slot=1').memory_auto_processing,
   onlySample:contributions.length===1&&contributions[0].source_contact_id===scope.contactId,
   sampleUnknown:get(`SELECT count(DISTINCT c.id) n FROM model_call c JOIN operation_scope s ON s.owner_id=c.owner_id AND s.operation_id=c.operation_id WHERE c.owner_id=? AND s.source_contact_id=? AND (c.state IN ('prepared','sending','unknown') OR c.settlement_state IN ('reserved','unknown'))`,scope.ownerId,scope.contactId).n,
   activeCalls:calls.filter(c=>['prepared','sending'].includes(c.state)).length,modelCalls:calls.length,callHash:hash(calls),packetHash:hash(packets),packetCount:packets.length,
   schedule:target.state,error:target.error_code,published:!!published,profileEntries:statements.length,blockNumbers:statements.map(s=>s.block_no),
   selection:selectedData?{accepted:selectedData.accepted.length,rejected:selectedData.rejected.length,retained:selectedData.retained.length}:null};
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
}
async function inspect(){
 for(let attempt=0;attempt<3;attempt++)try{return await inspectOnce();}catch(error){if((error as any)?.message!=='snapshot_invalid'||attempt===2)throw error;}
 throw Error('snapshot_invalid');
}
async function connection(){
 const values=new Map((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 if(!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(values.get('address')??'')||!/^[A-Za-z0-9_-]{1,256}$/.test(values.get('token')??''))throw Error('connection_invalid');
 return {url:'http://'+values.get('address'),token:values.get('token')!};
}
const command=process.argv[2]??'preflight';
try{
 const before=await inspect();if(before.automatic!==0||!before.onlySample||before.sampleUnknown||before.activeCalls)throw Error('preflight_scope_or_ledger_blocked');
 if(command==='preflight'||command==='status'){await writeFile(root+(command==='preflight'?'/l3-partial-replay-before.json':'/l3-partial-replay-after.json'),JSON.stringify(before),{mode:0o600});console.log(JSON.stringify({...before,taskId:undefined,runId:undefined,callHash:undefined,packetHash:undefined}));}
 else if(command==='replay'){
  const conn=await connection(),response=await fetch(conn.url+'/api/memory-processing/schedule',{method:'POST',headers:{Authorization:'Bearer '+conn.token,'Content-Type':'application/json'},body:JSON.stringify({task_id:before.taskId}),signal:AbortSignal.timeout(60_000)});
  const value=await response.json() as any;await writeFile(root+'/l3-partial-replay-http.json',JSON.stringify({httpStatus:response.status,outcome:value?.outcome??null,error:value?.error??null}),{mode:0o600});const after=await inspect();
  const result={httpStatus:response.status,outcome:value?.outcome??null,error:value?.error??null,automaticBefore:before.automatic,automaticAfter:after.automatic,onlySample:after.onlySample,modelCallsUnchanged:before.callHash===after.callHash,modelCallDelta:after.modelCalls-before.modelCalls,originalPacketsUnchanged:before.packetHash===after.packetHash,published:after.published,profileEntries:after.profileEntries,selection:after.selection,blockNumbers:after.blockNumbers,schedule:after.schedule,sampleUnknown:after.sampleUnknown};
  await writeFile(root+'/l3-partial-replay-result.json',JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));
  if(!response.ok||!after.published||after.profileEntries!==15||after.selection?.accepted!==15||after.selection?.rejected!==1||!result.modelCallsUnchanged||!result.originalPacketsUnchanged||after.automatic!==0)process.exitCode=1;
 }else throw Error('command_invalid');
}catch(error){console.log(JSON.stringify({error:(error as any)?.code??(/^[a-z_]+$/.test((error as any)?.message??'')?(error as any).message:'acceptance_failed')}));process.exitCode=1;}
