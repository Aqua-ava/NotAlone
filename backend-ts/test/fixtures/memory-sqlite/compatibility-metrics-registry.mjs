import {registry as base} from '../../../src/storage/sqlite/registry.ts';

let latest=null;
const tables=new Set(['source_proof','history_message_quarantine','memory_document_later_schedule','memory_document_later_run_requirement','run_content_input','media_file']);
function targetProbe(sql,values){
 if(/PRAGMA table_info\((processing_run|sync_capture|read_goal)\)/i.test(sql))return true;
 if(!/SELECT 1 FROM sqlite_schema WHERE type='table' AND name/.test(sql))return false;
 return sql.includes('name=?')?tables.has(values?.[0]):sql.includes("name='history_message_quarantine'");
}
const measured=base.actions.map(action=>!action.name.startsWith('memoryExtraction.')||action.mode==='maintenance'?action:{...action,execute(tx,input,lease){
 const metrics={action:action.name,queries:0,schemaProbes:0,targetSchemaProbes:0,migration13Probes:0,frozenContentReads:0,elapsedMs:0},began=performance.now();
 const observed=new Proxy(tx,{get(target,key){
  if(!['get','all','run'].includes(key))return Reflect.get(target,key);
  return (sql,values)=>{
   metrics.queries++;
   if(/sqlite_schema|pragma_table_info|PRAGMA table_info|FROM schema_migration/.test(sql))metrics.schemaProbes++;
   if(/FROM schema_migration WHERE version=13\b/.test(sql))metrics.migration13Probes++;
   if(targetProbe(sql,values))metrics.targetSchemaProbes++;
   if(/^SELECT \* FROM run_content_input WHERE owner_id=/.test(sql))metrics.frozenContentReads++;
   return target[key](sql,values);
  };
 }});
 try{return action.execute(observed,input,lease);}finally{metrics.elapsedMs=performance.now()-began;latest=metrics;}
}});
export const registry={...base,actions:[...measured,
 {name:'compatibility.metrics',mode:'read',retryBusy:false,execute(){return latest;}},
 {name:'compatibility.removeFrozenText',mode:'write',retryBusy:false,execute(tx,{ownerId,runId}){
  tx.run("DELETE FROM run_content_input WHERE owner_id=? AND run_id=? AND content_kind='text'",[ownerId,runId]);return true;
 }},
]};
