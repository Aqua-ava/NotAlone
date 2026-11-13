import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture} from '../../../backend-ts/test/media-support.mjs';
import {modelPort} from '../../../backend-ts/test/fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../../../backend-ts/src/memory/sqlite/service.ts';
import {ExtractionModelError} from '../../../backend-ts/src/memory/extraction/model.ts';
import {createBuiltinMemoryContentRegistry} from '../../../backend-ts/src/memory/content/builtins.ts';
const require=createRequire(new URL('../../../backend-ts/package.json',import.meta.url)),sharp=require('sharp');
const cleanups:any[]=[],t={after:(fn:any)=>cleanups.push(fn)};
const bytes=await sharp({create:{width:1200,height:1600,channels:3,background:'orange'}}).png().toBuffer();
const adapter={version:'synthetic-review-owner-retry',supports:(kind:string)=>kind==='image',async execute(context:any){
 await context.save({role:'image_display',bytes:(async function*(){yield bytes;})(),expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-review-owner-retry',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-review-image'}};
}};
try{
 const f=await fixture(t,adapter),image=f.messages.find((message:any)=>message.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:'synthetic-owner-retry',goal:'extract'});
 let service:any,broken=true;const receipts=new Map(),sources=new Map();
 const accounting=()=>({...service.accounting,reserve:async(receipt:any,claim:any)=>{receipts.set(receipt.attempt_id,receipt);return service.accounting.reserve(receipt,claim);}});
 const fields=['attribution','body','temporal_and_modality','category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
 const model=modelPort(accounting,async(request:any,input:any)=>{
  if(broken&&request.images?.length){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await service.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt as any,{name:'LlmError',code:'TRANSPORT'});
  }
  const body=JSON.parse(request.user);let value;
  if(request.purpose==='extraction'){
   for(const message of body.messages)sources.set(message.message_id,message);
   const image=body.messages.find((message:any)=>message.content_kind==='image');
   value={scenes:image?[{scene_name:'合成本人资料',memories:[{text:'用户有一个橙色杯子。',subject:'self',category:'common_fact',topic:'other',source_message_ids:[image.message_id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成模型为程序测试提供本人来源结果。',event:null,conditions:null}]}]:[]};
  }else{
   value={results:body.candidates.map((candidate:any,candidate_index:number)=>({candidate_index,verdict:'supported',issues:[],evidence:[{kind:'image',message_id:candidate.source_message_ids[0],quote:null,description:'合成图片中可见橙色杯子，程序测试明确主体为用户。'}],scope_subject:'self',actor_kind:'self',resolution:'explicit',checks:fields.map(field=>({field,verdict:'supported',evidence_indices:[0],explanation:'合成来源支持该字段。'}))}))};
  }
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 });
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:(input:any)=>f.media.readMemoryImage(input)}});t.after(()=>service.close());
 const run=await service.start(randomUUID());await service.waitForIdle(run.runId);const before=await service.read(run.runId);
 const selfTask=before.tasks.find((task:any)=>task.scopeKind==='self');const beforeSelf=await service.trace(selfTask.taskId);
 broken=false;await service.retryImages(run.runId,before.controlVersion,randomUUID());await service.waitForIdle(run.runId);
 const after=await service.read(run.runId),contact=after.tasks.find((task:any)=>task.scopeKind==='contact');
 const contactTrace=await service.trace(contact.taskId),selfTrace=await service.trace(selfTask.taskId);
 const proof={beforeIsolated:before.isolated,beforeSelfState:selfTask.state,beforeSelfOutput:beforeSelf.events.filter((event:any)=>event.kind==='verified_output').length,afterIsolated:after.isolated??0,afterSucceeded:after.succeeded,contactSelfContributions:contactTrace.events.filter((event:any)=>event.kind==='verified_self_contribution').length,selfOutputs:selfTrace.events.filter((event:any)=>event.kind==='verified_output').length,candidates:after.candidates.length};
 console.log(JSON.stringify(proof));
}finally{for(const cleanup of cleanups.reverse())await cleanup();}
