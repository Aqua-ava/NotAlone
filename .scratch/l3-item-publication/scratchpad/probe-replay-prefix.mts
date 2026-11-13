/** 只读副本上的恢复验证前缀；恢复态只在内存投影，不执行SQL写入。 */
import{DatabaseSync}from'node:sqlite';import{readFile,writeFile}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{memoryDocumentsReplayActions}from'../../../backend-ts/src/memory/sqlite/documents/replay.ts';
const root=(await readFile('/tmp/notalone-image-reliability-location','utf8')).trim(),scope=JSON.parse(await readFile(root+'/stage6-scope.json','utf8'));
const db=new DatabaseSync(process.argv[2],{readOnly:true});const statement=(sql:string)=>{const s=db.prepare(sql);s.setReadBigInts(true);return s;};
const selected=statement("SELECT task_id FROM memory_document_later_schedule WHERE owner_id=? AND contact_id=? AND generation=6 AND stage='document_profile'").get(scope.ownerId,scope.contactId) as any;if(!selected)throw Error('probe_target_missing');
const task=statement('SELECT run_id FROM processing_task WHERE owner_id=? AND id=?').get(scope.ownerId,selected.task_id) as any;
let reads=0,writes=0,shadow=false;const boundary=Symbol('validated');
const project=(sql:string,p:any[],row:any)=>shadow&&row&&/FROM processing_run\b/.test(sql)&&!sql.includes('JOIN')&&p.includes(task.run_id)?{...row,...('state'in row?{state:'pending'}:{}),...('intent_revision'in row?{intent_revision:row.intent_revision+1n}:{})}:row;
const tx:any={get(sql:string,p:any[]=[]){reads++;return project(sql,p,statement(sql).get(...p));},all(sql:string,p:any[]=[]){reads++;return statement(sql).all(...p).map(row=>project(sql,p,row));},run(sql:string,p:any[]=[]){writes++;if(writes===1&&sql.startsWith("UPDATE processing_run SET state='pending'")){shadow=true;return {changes:1n};}throw boundary;}};
const start=performance.now();let result:any;
try{memoryDocumentsReplayActions[0]!.execute(tx,{ownerId:scope.ownerId,taskId:selected.task_id},{runtimeId:randomUUID()} as any);result={passed:false,code:'probe_boundary_missing'};}catch(e){result=e===boundary?{passed:true,code:'validated_to_new_attempt_write'}:{passed:false,code:(e as any)?.code??'probe_failed'};}
result={...result,elapsedMs:Math.round(performance.now()-start),sqlReads:reads,physicalWrites:0,realModelCalls:0};db.close();await writeFile(root+'/l3-partial-replay-prefix-probe.json',JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
