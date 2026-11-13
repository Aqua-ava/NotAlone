/** 中断恢复仅查副本元数据；模型内容和身份均不写标准输出。 */
import {readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_',copy=process.argv[2];
const stat=await lstat(copy);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||!copy.startsWith(privateRoot+'/schedule-probe-'))throw Error('probe_copy_invalid');
const scope=JSON.parse(await readFile(join(privateRoot,'stage6-scope.json'),'utf8')),db=new DatabaseSync(join(copy,'snapshot.sqlite'),{readOnly:true});
const query=(sql:string,params:any[]=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...params);};
const group=(rows:any[],key:string)=>Object.fromEntries([...new Set(rows.map(row=>String(row[key])))].map(value=>[value,rows.filter(row=>String(row[key])===value).length]));
const plain=(value:any):any=>typeof value==='bigint'?value.toString():Array.isArray(value)?value.map(plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item)])):value;
try{
 const automatic=query('SELECT memory_auto_processing FROM database_instance WHERE slot=1')[0].memory_auto_processing===1n;
 const latest=query(`SELECT r.id,r.state,r.started_at,r.pause_requested_at FROM processing_run r WHERE r.owner_id=? AND EXISTS(SELECT 1 FROM run_contact c WHERE c.owner_id=r.owner_id AND c.run_id=r.id AND c.contact_id=?) AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=r.owner_id AND i.run_id=r.id AND i.source_contact_id=? AND i.role='target') ORDER BY r.started_at DESC,r.rowid DESC LIMIT 3`,[scope.ownerId,scope.contactId,scope.contactId]);
 const details=[];
 for(const run of latest){
  const tasks=query('SELECT id,state,error_code,scope_kind FROM processing_task WHERE owner_id=? AND run_id=?',[scope.ownerId,run.id]);
  const steps=query(`SELECT s.id,s.kind,s.state,s.successful_attempt_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const attempts=query(`SELECT a.id,a.state FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const calls=query(`SELECT c.id,c.state,c.settlement_state,c.operation_id FROM model_call c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const operations=query(`SELECT o.id,o.state FROM model_operation o JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const items=query(`SELECT x.state FROM operation_item x JOIN model_operation o ON o.owner_id=x.owner_id AND o.id=x.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const scopes=query(`SELECT x.state FROM operation_scope x JOIN model_operation o ON o.owner_id=x.owner_id AND o.id=x.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const targets=query(`SELECT p.extraction_state FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id WHERE i.owner_id=? AND i.run_id=? AND i.role='target'`,[scope.ownerId,run.id]);
  const events=query(`SELECT e.kind FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,run.id]);
  const safe={state:run.state,pauseRequested:run.pause_requested_at!==null,tasks:group(tasks,'state'),taskErrors:group(tasks,'error_code'),steps:group(steps,'state'),attempts:group(attempts,'state'),targets:group(targets,'extraction_state'),calls:group(calls,'state'),settlements:group(calls,'settlement_state'),operations:group(operations,'state'),items:group(items,'state'),scopes:group(scopes,'state'),events:group(events,'kind')};
  details.push({run,tasks,steps,attempts,calls,operations,safe});
 }
 await writeFile(join(privateRoot,'stage6-recovery-receipts-diagnosis.json'),JSON.stringify(plain({automatic,details}),null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({automatic,latest:details.map(row=>row.safe)}));
}finally{db.close();await rm(copy,{recursive:true,force:true});}
