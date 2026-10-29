/** 正式宿主关闭后的只读关系投影；不替换业务写入，不制造成功记录。 */
import {registry as base} from '../../src/storage/sqlite/registry.ts';
export const registry={...base,actions:[...base.actions,{name:'fixture.memoryProfileEvidence',mode:'read',retryBusy:false,execute(tx,input){
 const {ownerId,runId}=input;
 const ownerInputs=tx.all(`SELECT x.role,e.id AS event_id,source.id AS producer_event_id,rt.scope_kind AS consumer_scope,
  pt.scope_kind AS producer_scope,rt.run_id=pt.run_id AS same_run,e.payload=source.payload AS same_payload
  FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id
  JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  JOIN processing_task rt ON rt.owner_id=s.owner_id AND rt.id=s.task_id
  JOIN execution_event source ON source.owner_id=x.owner_id AND source.id=x.producer_event_id
  JOIN step_attempt pa ON pa.owner_id=source.owner_id AND pa.id=source.step_attempt_id
  JOIN processing_step ps ON ps.owner_id=pa.owner_id AND ps.id=pa.step_id
  JOIN processing_task pt ON pt.owner_id=ps.owner_id AND pt.id=ps.task_id
  WHERE x.owner_id=? AND rt.run_id=? AND x.producer_event_id IS NOT NULL`,[ownerId,runId]).map(row=>({
   role:row.role,eventId:row.event_id,producerEventId:row.producer_event_id,consumerScope:row.consumer_scope,
   producerScope:row.producer_scope,sameRun:row.same_run===1n,samePayload:row.same_payload===1n}));
 const calls=tx.all(`SELECT c.*,o.purpose FROM model_call c
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE c.owner_id=? AND t.run_id=?`,[ownerId,runId]).map(row=>{
   const receipt=JSON.parse(String(row.receipt)),budget=receipt.input_budget;
   return {state:row.state,purpose:row.purpose,provider:row.provider,model:row.model,settlement:row.settlement_state,
    inputTokens:budget?.input_tokens??null,maxOutputTokens:budget?.max_output_tokens??null,
    contextWindowTokens:budget?.context_window_tokens??null,safetyMarginTokens:budget?.safety_margin_tokens??null,
    serializedBytes:budget?.serialized_bytes??null};
  });
 let formalMemoryRows=0;
 for(const table of ['memory_candidate','memory','memory_version'])if(tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",[table]))formalMemoryRows+=Number(tx.get(`SELECT count(*) AS n FROM ${table} WHERE owner_id=?`,[ownerId]).n);
 return {ownerInputs,calls,formalMemoryRows,runCount:Number(tx.get('SELECT count(*) AS n FROM processing_run WHERE owner_id=?',[ownerId]).n)};
}}]};
