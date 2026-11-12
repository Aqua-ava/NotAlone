import type {StorageAction,StorageRow,StorageTransaction,StorageLease} from '../../storage/sqlite/contracts.ts';
import type {DiagnosticEvent} from '../../diagnostics/unified-contract.mjs';

type StateRow={id:string;state:string;runId:string;taskId?:string;contactPrefix?:string;code?:string};
type State={run?:StateRow;tasks:StateRow[];batches:StateRow[]};
const text=(value:unknown):string|undefined=>typeof value==='string'?value:undefined;
const prefix=(value:unknown):string|undefined=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value)?value.slice(0,8).toLowerCase():undefined;
const watched=new Set(['start','startContact','startHistory','startHistoryBatch','restartPolicy','autoContinue','claim','blockClaim','finish','fail','control','abandonUnknown','settleRun','finishLater','recover','setAutomatic','enrollRun','claimDue','claimScene','claimProfile','prepareVerifiedProfileReplay','saveScene','saveProfile','publish','settle','noteFailure']);
const reason=(code:unknown):string=>{
 if(typeof code!=='string')return 'failed';
 if(code.includes('receipt_unknown')||code.includes('call_unknown'))return 'receipt_unknown';
 if(code.includes('interrupted')||code==='runtime_interrupted')return 'worker_interrupted';
 if(code.includes('budget'))return 'budget_exhausted';
 if(code.includes('policy'))return 'policy_changed';
 if(code.includes('scope')||code.includes('source')||code.includes('stale'))return 'source_changed';
 if(code.includes('lease'))return 'lease_lost';
 if(code.includes('model_'))return 'model_unavailable';
 if(code==='targets_completed_elsewhere')return 'targets_completed_elsewhere';
 return 'failed';
};
/** 诊断查询和接收器失败都不成为业务失败；仅记录固定字段的值。 */
function safely<T>(work:()=>T):T|undefined{try{return work();}catch{return;}}
function append(tx:StorageTransaction,event:DiagnosticEvent):void{safely(()=>tx.recordUnifiedDiagnostic?.(event));}
function stateRow(row:StorageRow,runId:string,taskId?:string):StateRow{
 return {id:String(row.id),state:String(row.state),runId,...(taskId?{taskId}:{}),...(prefix(row.contact_id)?{contactPrefix:prefix(row.contact_id)}:{}),...(text(row.error_code)?{code:text(row.error_code)}:{})};
}
function capture(tx:StorageTransaction,ownerId:string,runId:string,taskId?:string,stepId?:string,recovering=false):State{
 const run=tx.get('SELECT id,state FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 const tasks=tx.all(`SELECT id,state,contact_id,error_code FROM processing_task WHERE owner_id=? AND run_id=?${taskId?' AND id=?':''}`,taskId?[ownerId,runId,taskId]:[ownerId,runId]);
 const batches=stepId?tx.all('SELECT s.id,s.state,s.task_id,t.contact_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND s.id=?',[ownerId,stepId])
  :taskId?tx.all("SELECT s.id,s.state,s.task_id,t.contact_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND s.task_id=? AND s.state IN ('pending','failed','running') ORDER BY s.step_no LIMIT 1",[ownerId,taskId]):recovering?tx.all("SELECT s.id,s.state,s.task_id,t.contact_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND t.run_id=? AND s.state='running'",[ownerId,runId]):[];
 return {run:run?stateRow(run,runId):undefined,tasks:tasks.map(row=>stateRow(row,runId,String(row.id))),batches:batches.map(row=>stateRow(row,runId,String(row.task_id)))};
}
function revokedReason(tx:StorageTransaction,ownerId:string,row:StateRow):string{
 if(!row.taskId)return 'source_changed';
 return tx.get(`SELECT 1 FROM task_contribution tc JOIN run_contact rc ON rc.owner_id=tc.owner_id AND rc.run_id=tc.run_id AND rc.contact_id=tc.source_contact_id
  LEFT JOIN read_grant g ON g.owner_id=rc.owner_id AND g.id=rc.grant_id
  WHERE tc.owner_id=? AND tc.task_id=? AND (g.id IS NULL OR g.revoked_at IS NOT NULL) LIMIT 1`,[ownerId,row.taskId])?'authorization_revoked':'source_changed';
}
function changed(tx:StorageTransaction,ownerId:string,kind:'run'|'task'|'batch',before:StateRow|undefined,after:StateRow,why:string):void{
 if(before?.state===after.state&&before.code===after.code)return;
 const event:DiagnosticEvent={event:`processing.${kind}_changed`,caller:`memory_${kind}`,runId:after.runId,fromState:before?.state??'idle',toState:after.state,
  reasonCode:after.state==='revoked'?revokedReason(tx,ownerId,after):after.state==='unknown'?'receipt_unknown':kind!=='run'&&before?.state==='failed'&&['pending','running'].includes(after.state)?'retry':after.code&&after.code!==before?.code?reason(after.code):why,
  ...(after.taskId?{taskId:after.taskId}:{}),...(after.contactPrefix?{contactPrefix:after.contactPrefix}:{}),...(kind==='batch'?{batchId:after.id}:{})};
 append(tx,event);
}
function publish(tx:StorageTransaction,ownerId:string,before:State|undefined,after:State,why:string):void{
 if(after.run)changed(tx,ownerId,'run',before?.run,after.run,why);
 const tasks=new Map(before?.tasks.map(row=>[row.id,row])??[]),batches=new Map(before?.batches.map(row=>[row.id,row])??[]);
 for(const task of after.tasks)changed(tx,ownerId,'task',tasks.get(task.id),task,why);
 for(const batch of after.batches)changed(tx,ownerId,'batch',batches.get(batch.id),batch,why);
}
/** 状态只按本动作的 run/task/step 定向观察；写入由 Worker 在提交成功后发布。 */
export function observedProcessingAction(action:StorageAction):StorageAction{
 const name=action.name.split('.').at(-1)!;
 if(action.mode!=='write'||!watched.has(name))return action;
 return {...action,execute(tx:StorageTransaction,raw:unknown,lease:StorageLease){
  if(!safely(()=>typeof tx.recordUnifiedDiagnostic==='function'))return action.execute(tx,raw,lease);
  const input=(raw&&typeof raw==='object'?raw:{}) as Record<string,unknown>,ownerId=text(input.ownerId);
  if(!ownerId)return action.execute(tx,raw,lease);
  let runId=text(input.runId),taskId=text(input.taskId),stepId:string|undefined;
  const metadata=safely(()=>{
   if(text(input.attemptId))return tx.get('SELECT s.id AS step_id,s.task_id,t.run_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE a.owner_id=? AND a.id=?',[ownerId,String(input.attemptId)]);
   return;
  });
  if(metadata){runId=String(metadata.run_id);taskId=String(metadata.task_id);stepId=String(metadata.step_id);}
  if(taskId&&!runId){const task=safely(()=>tx.get('SELECT run_id FROM processing_task WHERE owner_id=? AND id=?',[ownerId,taskId!]));if(task)runId=String(task.run_id);}
  const recovering=name==='recover'?safely(()=>{
   const ids=new Set(tx.all("SELECT id FROM processing_run WHERE owner_id=? AND state IN ('pending','running')",[ownerId]).map(row=>String(row.id)));
   // 用户暂停不取消已发出的当前批次；恢复集合跟随旧执行者的实际在途尝试，不能只看 run 主状态。
   const kinds=action.name.startsWith('memoryDocuments.')?"('document_scene','document_profile')":"('extraction_verification')";
   for(const row of tx.all(`SELECT DISTINCT t.run_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
    JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE a.owner_id=? AND a.state='running' AND a.runtime_token<>? AND s.kind IN ${kinds}`,[ownerId,lease.runtimeId]))ids.add(String(row.run_id));
   return [...ids];
  }):undefined;
  const before=runId?safely(()=>capture(tx,ownerId,runId!,taskId,stepId)):undefined;
  const recoveredBefore=recovering?.map(id=>({id,state:safely(()=>capture(tx,ownerId,id,undefined,undefined,true))}));
  const automatic=name==='setAutomatic'?safely(()=>tx.get('SELECT memory_auto_processing AS enabled FROM database_instance WHERE slot=1')):undefined;
  const enrollment=name==='enrollRun'&&runId?safely(()=>tx.get('SELECT followup_state FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId!])):undefined;
  const value=action.execute(tx,raw,lease);
  safely(()=>{
   if(name==='setAutomatic'){
    const was=Number(automatic?.enabled)===1,enabled=input.enabled===true;
    if(was!==enabled)append(tx,{event:'processing.control_changed',caller:'memory_processing',fromState:was?'enabled':'disabled',toState:enabled?'enabled':'disabled',reasonCode:enabled?'enabled':'disabled'});
    return;
   }
   const result=value&&typeof value==='object'?value as Record<string,any>:undefined;
   const actualRun=runId??text(result?.runId)??text(result?.run?.runId),actualStep=stepId??text(result?.stepId);
   const why=name==='control'?(input.action==='pause'?'paused':'resumed'):name==='abandonUnknown'?'retry':name==='recover'?'worker_interrupted':name==='restartPolicy'?'policy_changed':name==='autoContinue'?'retry':name==='fail'||name==='blockClaim'||name==='noteFailure'?reason(input.code):['finish','saveScene','saveProfile','publish','settle','enrollRun'].includes(name)?'completed':name==='claim'?'started':name==='settleRun'||name==='finishLater'?'completed':'started';
   if(actualRun){
    const after=capture(tx,ownerId,actualRun,taskId,actualStep);
    // 同一个固定步骤失败后重领属于重试，不创建新的业务任务。
    publish(tx,ownerId,before,after,name==='claim'&&before?.tasks.some(task=>task.state==='failed')?'retry':why);
    if(stepId&&text(result?.stepId)&&result!.stepId!==stepId)publish(tx,ownerId,{tasks:[],batches:[]},{tasks:[],batches:capture(tx,ownerId,actualRun,taskId,result!.stepId).batches},why);
   }
   const launched=text(result?.launchRunId);
   if(launched&&launched!==actualRun)publish(tx,ownerId,undefined,capture(tx,ownerId,launched),why);
   if(name==='enrollRun'&&actualRun&&enrollment?.followup_state!=='enrolled'){
    const waiting=tx.get(`SELECT count(*) AS n FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation
     WHERE q.owner_id=? AND q.run_id=? AND q.outcome='pending' AND q.paused=0 AND s.state='scheduled'`,[ownerId,actualRun]);
    if(waiting&&Number(waiting.n)>0)append(tx,{event:'processing.control_changed',caller:'memory_run',runId:actualRun,fromState:'processing',toState:'waiting',reasonCode:'waiting_window',count:Number(waiting.n)});
   }
   for(const prior of recoveredBefore??[]){
    const after=capture(tx,ownerId,prior.id);
    after.batches=(prior.state?.batches??[]).flatMap(old=>{const row=tx.get('SELECT s.id,s.state,s.task_id,t.contact_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND s.id=?',[ownerId,old.id]);return row?[stateRow(row,prior.id,String(row.task_id))]:[];});
    publish(tx,ownerId,prior.state,after,'worker_interrupted');
   }
  });
  return value;
 }};
}
/** 仅由媒体实际从不可用转为可用的提交路径调用；不把预算排除推断为晚就绪。 */
export function recordReadyImageOutsideRun(tx:StorageTransaction,ownerId:string,contactId:string,messageId:string):void{
 if(!safely(()=>typeof tx.recordUnifiedDiagnostic==='function'))return;
 safely(()=>{
  const current=tx.get(`SELECT r.id AS run_id,t.id AS task_id FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id
   WHERE t.owner_id=? AND t.scope_kind='contact' AND t.contact_id=? AND t.state<>'revoked'
    AND r.state IN ('pending','running','paused','failed','incomplete')
   ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`,[ownerId,contactId]);
  if(!current||tx.get('SELECT 1 FROM run_input WHERE owner_id=? AND run_id=? AND source_contact_id=? AND message_id=? LIMIT 1',[ownerId,current.run_id,contactId,messageId]))return;
  // 排除本轮创建以后才同步进来的新消息；这里只提示先有消息、后有实际图片的固定输入缺口。
  if(!tx.get(`SELECT 1 FROM capture_record cr JOIN sync_capture sc ON sc.owner_id=cr.owner_id AND sc.id=cr.capture_id
   JOIN processing_run r ON r.owner_id=cr.owner_id AND r.id=? WHERE cr.owner_id=? AND cr.contact_id=? AND cr.message_id=? AND sc.captured_at<=r.started_at LIMIT 1`,[current.run_id,ownerId,contactId,messageId]))return;
  append(tx,{event:'processing.image_excluded',caller:'memory_run',runId:String(current.run_id),taskId:String(current.task_id),contactPrefix:contactId.slice(0,8),reasonCode:'image_late_ready',count:1});
 });
}

/** 已有动作刚刚完成的确定性状态写入；仍只缓冲，回滚不会留下伪状态。 */
export function recordProcessingRunChange(tx:StorageTransaction,runId:string,fromState:string,toState:string,reasonCode:string):void{
 if(fromState!==toState)append(tx,{event:'processing.run_changed',caller:'memory_run',runId,fromState,toState,reasonCode});
}
