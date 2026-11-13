/** 只读私有副本调用正式阻碍判定；所有身份仅留私有结果，标准输出没有身份或内容。 */
import {readFile,writeFile,lstat,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {runTargetsReleased} from '../../../backend-ts/src/memory/sqlite/run-retirement.ts';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_',copy=process.argv[2];
const stat=await lstat(copy);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||!copy.startsWith(privateRoot+'/schedule-probe-'))throw Error('probe_copy_invalid');
const project=fileURLToPath(new URL('../../../',import.meta.url)),backend=join(project,'backend-ts');
const {build}=createRequire(join(project,'desktop/package.json'))('esbuild'),backendRequire=createRequire(join(backend,'package.json'));
const sourceFile=join(backend,'src/memory/sqlite/documents/later-schedule.ts'),source=await readFile(sourceFile,'utf8');
const compiled=await build({stdin:{contents:source+'\nexport {scopeBlocked as probeScopeBlocked,dueRows as probeDueRows};\n',sourcefile:sourceFile,resolveDir:dirname(sourceFile),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'external-packages',setup(b){b.onResolve({filter:/^[^./][^:]*/},a=>a.path.startsWith('node:')?{path:a.path,external:true}:{path:backendRequire.resolve(a.path),external:true});}}]});
const moduleFile=join(copy,'private-helper.mjs');await writeFile(moduleFile,compiled.outputFiles[0].text,{mode:0o600});
const helper=await import(pathToFileURL(moduleFile).href),scope=JSON.parse(await readFile(join(privateRoot,'stage6-scope.json'),'utf8'));
const db=new DatabaseSync(join(copy,'snapshot.sqlite'),{readOnly:true});
const plain=(value:any):any=>typeof value==='bigint'?value.toString():Array.isArray(value)?value.map(plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item)])):value;
const grouped=(rows:any[],key:string)=>Object.fromEntries([...new Set(rows.map(row=>String(row[key])))].map(value=>[value,rows.filter(row=>String(row[key])===value).length]));
const details:any[]=[];
try{
 const query=(sql:string,params:any[]=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...params);};
 const traces:any[]=[];const tx={all(sql:string,params:any[]=[]){const rows=query(sql,params);if(sql.includes('t.id AS task_id,t.state AS task_state'))traces.push(...rows);return rows;},get(sql:string,params:any[]=[]){return query(sql,params)[0];},runtimeGet(){},run(){throw Error('probe_write_forbidden');}} as any;
 const schedule=query("SELECT * FROM memory_document_later_schedule WHERE owner_id=? AND scope_kind='contact' AND contact_id=? AND state='scheduled' ORDER BY generation",[scope.ownerId,scope.contactId]);
 for(const row of schedule){
  traces.length=0;const cache=new Map<string,boolean>(),blocked=helper.probeScopeBlocked(tx,scope.ownerId,row,cache),blockers=[...traces];
  const runs=[...new Set(blockers.map(blocker=>String(blocker.run_id)))],chains=[];
  for(const runId of runs){
   const run=query('SELECT state,pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[scope.ownerId,runId])[0];
   const calls=query(`SELECT c.state,c.settlement_state FROM processing_task t JOIN processing_step s ON s.owner_id=t.owner_id AND s.task_id=t.id JOIN model_operation o ON o.owner_id=s.owner_id AND o.memory_step_id=s.id JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,runId]);
   const operations=query(`SELECT o.state FROM processing_task t JOIN processing_step s ON s.owner_id=t.owner_id AND s.task_id=t.id JOIN model_operation o ON o.owner_id=s.owner_id AND o.memory_step_id=s.id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,runId]);
   const items=query(`SELECT i.state FROM operation_item i JOIN model_operation o ON o.owner_id=i.owner_id AND o.id=i.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,runId]);
   const scopes=query(`SELECT x.state FROM operation_scope x JOIN model_operation o ON o.owner_id=x.owner_id AND o.id=x.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,runId]);
   const candidates=query(`SELECT c.state FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?`,[scope.ownerId,runId]);
   chains.push({runId,run,targetsReleased:runTargetsReleased(tx,scope.ownerId,runId),calls:grouped(calls,'state'),settlements:grouped(calls,'settlement_state'),operations:grouped(operations,'state'),items:grouped(items,'state'),scopes:grouped(scopes,'state'),candidates:grouped(candidates,'state')});
  }
  const active=blockers.filter(blocker=>!chains.find(chain=>chain.runId===blocker.run_id)?.targetsReleased);
  const reasons={deletion:!!tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' LIMIT 1",[scope.ownerId]),requirementPaused:!!tx.get('SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=? AND paused=1',[scope.ownerId,row.scope_key,row.generation]),scopeFailedUnknown:!!tx.get("SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND state IN ('failed','unknown') LIMIT 1",[scope.ownerId,row.scope_key]),pauseRequested:active.filter(row=>row.pause_requested_at!==null).length,runPaused:active.filter(row=>row.run_state==='paused').length,taskPaused:active.filter(row=>row.task_state==='paused').length,taskUnknown:active.filter(row=>row.task_state==='unknown').length,hasUnknown:active.filter(row=>row.has_unknown===1n).length,failed:active.filter(row=>row.run_state==='failed'||row.task_state==='failed'||row.task_state==='incomplete'&&row.task_error!==null&&row.task_error!=='targets_completed_elsewhere').length};
  details.push({row,blocked,contactEq:row.contact_id===scope.contactId,requirements:query('SELECT * FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_key=? AND generation=?',[scope.ownerId,row.scope_key,row.generation]),blockers,chains,reasons});
  console.log(JSON.stringify({scheduleCount:schedule.length,blocked,contactEq:row.contact_id===scope.contactId,runStates:grouped(active,'run_state'),taskStates:grouped(active,'task_state'),reasons,chains:chains.filter(chain=>!chain.targetsReleased).map(({runId,run,...safe})=>({...safe,runState:run.state,pauseRequested:run.pause_requested_at!==null}))}));
 }
 const due=helper.probeDueRows(tx,scope.ownerId,Date.now(),true);console.log(JSON.stringify({dueRows:due.length,sampleDueRows:due.filter((row:any)=>row.scope_kind==='contact'&&row.contact_id===scope.contactId).length}));
 await writeFile(join(privateRoot,'stage6-later-blocker-diagnosis.json'),JSON.stringify(plain(details),null,2)+'\n',{mode:0o600});
}finally{db.close();await rm(copy,{recursive:true,force:true});}
