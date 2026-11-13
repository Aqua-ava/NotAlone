/** 副本只读对照；首写屏障，超25秒有界停止。 */
import{DatabaseSync}from'node:sqlite';import{readFile,writeFile}from'node:fs/promises';
import{memoryDocumentsPublicationActions}from'../../../backend-ts/src/memory/sqlite/documents/publication.ts';
import{withSourceMemo}from'../../../backend-ts/src/memory/sqlite/documents/basis.ts';
const root=(await readFile('/tmp/notalone-image-reliability-location','utf8')).trim(),scope=JSON.parse(await readFile(root+'/stage6-scope.json','utf8'));
const db=new DatabaseSync(process.argv[2],{readOnly:true});const statements=new Map<string,any>();
function statement(sql:string){let s=statements.get(sql);if(!s){s=db.prepare(sql);s.setReadBigInts(true);statements.set(sql,s);}return s;}
if(statement('PRAGMA quick_check').get().quick_check!=='ok')throw Error('snapshot_invalid');
const selected=statement("SELECT task_id FROM memory_document_later_schedule WHERE owner_id=? AND contact_id=? AND generation=6 AND stage='document_profile'").get(scope.ownerId,scope.contactId) as any;
const target=process.argv[3]??'publish',action=memoryDocumentsPublicationActions.find(a=>a.name==='memoryDocuments.'+target)!;
const task=statement('SELECT run_id FROM processing_task WHERE owner_id=? AND id=?').get(scope.ownerId,selected.task_id);
const results:any[]=[];
for(const memo of [false,true]){
 const start=performance.now();let reads=0;const boundary=Symbol(),budget=Symbol();
 const tick=()=>{reads++;if(performance.now()-start>25000)throw budget;};
 const tx:any={get(sql:string,p:any[]=[]){tick();return statement(sql).get(...p);},all(sql:string,p:any[]=[]){tick();return statement(sql).all(...p);},run(){throw boundary;}};
 let result:any;try{const work=()=>action.execute(tx,{ownerId:scope.ownerId,taskId:selected.task_id,runId:task.run_id},{} as any);memo?withSourceMemo(work):work();result={passed:false,code:'boundary_missing'};}
 catch(e){result=e===boundary?{passed:true,code:'validated_to_first_write'}:e===budget?{passed:false,code:'prefix_exceeded_25s'}:{passed:false,code:(e as any)?.code??'probe_failed'};}
 results.push({...result,memo,elapsedMs:Math.round(performance.now()-start),sqlReads:reads,physicalWrites:0,realModelCalls:0});
}
db.close();const label=process.argv[4]??'comparison';if(!/^[a-z]+$/.test(label))throw Error('label_invalid');await writeFile(root+'/l3-'+target+'-prefix-'+label+'.json',JSON.stringify(results),{mode:0o600});console.log(JSON.stringify({action:target,results}));
