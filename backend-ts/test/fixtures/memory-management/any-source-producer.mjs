import {createExtractionPolicyVersion} from '../../../src/memory/extraction/policy-version.ts';
import {runExtractionFlow} from '../../../src/memory/extraction/flow.ts';
import {prepareSourceVerification,assertCompleteClaimAdmission} from '../../../src/memory/extraction/verification/complete-claim.ts';
import {supplier} from './supplier.mjs';
import {modelPort,owner} from '../memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';

/** 合成旧producer的any依赖元数据；提取与核验回复均经真实许可账本和协议校验，未伪造采纳结果。 */
export async function anySourceProducer(t,storage,contactId){
 const version=await createExtractionPolicyVersion(),external=supplier();let extraction;
 const port=modelPort(()=>extraction.accounting,external.respond);extraction=new SqliteMemoryExtraction(storage,owner,port);t.after(()=>extraction.close());await extraction.initialize();
 const run=await storage.execute('memoryExtraction.start',{ownerId:owner,requestKey:'any-source-producer',policyConfig:version.newTaskConfig()});
 const task=(await extraction.read(run.runId)).tasks.find(t=>t.contactId===contactId),batch=await storage.execute('memoryExtraction.claim',{ownerId:owner,runId:run.runId,taskId:task.taskId});
 const signal=new AbortController().signal,inputNos=batch.rows.map(r=>Number(r.input_no)),requireCurrent=()=>storage.execute('memoryExtraction.current',{ownerId:owner,attemptId:batch.attemptId});
 const window={owner_id:owner,contact_id:contactId,target_message_ids:batch.rows.filter(r=>r.role==='target').map(r=>r.message_id),messages:batch.rows.map(r=>({message_id:r.message_id,text:r.text_body,sender:r.sender_role==='owner'?'self':'contact',occurred_at:new Date(Number(r.sent_at)).toISOString()}))};
 const record=(kind,payload,extra={})=>storage.execute('memoryExtraction.event',{ownerId:owner,attemptId:batch.attemptId,kind,payload,inputNos,...extra});
 const invoke=async request=>{
  const scope={owner_id:owner,contact_id:contactId},prepared=await port.prepare(request,{scope,signal,requireCurrent});
  const call=await storage.execute('memoryExtraction.prepareCall',{ownerId:owner,attemptId:batch.attemptId,purpose:request.purpose,request:{purpose:request.purpose,system:request.system,user:request.user,tool:request.tool},provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens,inputNos});
  const result=await port.invoke(request,{requestId:call.requestId,attemptId:call.callId,scope,claim:batch.claim,signal,requireCurrent,onReceipt:receipt=>storage.execute('memoryExtraction.receipt',{receipt})});
  await record('model_output',{blocks:result.blocks},{callId:call.callId});return {...result,callId:call.callId};
 };
 const parsed=[];
 await runExtractionFlow({window,signal,verificationPolicy:version.resolve(version.newTaskConfig()).verification,max_retries:0,requireCurrent,
  record:async e=>{if(e.stage==='parse'&&e.payload.status==='accepted')parsed.push({fact:e.payload.after,trace:e.candidate_trace_id});await record(e.stage,{...e.payload,candidateTraceId:e.candidate_trace_id??null});},
  invoke:request=>{if(request.purpose==='verification')throw Object.assign(new Error('合成旧producer在核验前补齐依赖元数据'),{code:'extraction_model_unavailable'});return invoke(request);}});
 const source=parsed.find(p=>p.fact.subject==='contact'),fact={...source.fact,requires_all_sources:false,source_message_ids:window.messages.map(m=>m.message_id)};
 const prepared=prepareSourceVerification({window,facts:[fact],policy:version.resolve(version.newTaskConfig()).verification,requireCurrent});
 const inputEventId=await record('verification_input',{window,facts:[fact],candidate_trace_ids:[source.trace],policy_fingerprint:prepared.fingerprint});
 const reply=await invoke(prepared.request),checked=(await prepared.decode(reply.blocks)).items[0];
 if(!checked.admitted)throw new Error('合成any候选未通过真实核验');
 const accepted={...fact,event:checked.result.event,conditions:checked.result.conditions};assertCompleteClaimAdmission(window,accepted,checked.result);
 const eventId=await record('verification',{status:'validated',result:checked.result,before:fact,disposition:'continue',candidateTraceId:source.trace,verificationInputEventId:inputEventId},{callId:reply.callId});
 await storage.execute('memoryExtraction.finish',{ownerId:owner,attemptId:batch.attemptId,inputNos,outcome:{accepted:[accepted],verification:[{fact:accepted,result:checked.result}],candidate_trace_ids:[source.trace],extraction_completed:true,failure_kind:null,rejected_count:0},verificationRefs:[{eventId,candidateTraceId:source.trace,policyFingerprint:prepared.fingerprint,callId:reply.callId,inputEventId}]});
 await storage.execute('memoryExtraction.claim',{ownerId:owner,runId:run.runId,taskId:task.taskId});await storage.execute('memoryExtraction.settleRun',{ownerId:owner,runId:run.runId});
 return run;
}
