import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFixture} from './fixtures/memory-documents/support.mjs';

for(const repairedSupported of [true,false])test(`主题段落核验失败仅修正一次并独立复核，第二次${repairedSupported?'通过才发布':'失败保持受阻'}`,async t=>{
 const invented='联系人每天都完成合成园艺活动。';let f,verificationCalls=0,repairCalls=0,allCalls=[];
 const tool=(name,args)=>({blocks:[{type:'tool-call',id:`synthetic-scene-repair-${allCalls.length}`,name,arguments:JSON.stringify(args)}]});
 f=await documentFixture(t,{sceneBody:invented,documentRespond:async(request,input)=>{
  allCalls.push({request,claim:input.claim});
  const payload=JSON.parse(request.messages[0].content[0].text),names=request.tools.map(tool=>tool.name);
  if(names.includes('ScenarioVerificationOutput')){
   verificationCalls++;const supported=verificationCalls>1&&repairedSupported;
   if(verificationCalls===2)assert.equal(payload.proposal.scenarios[0].paragraphs[0].text,payload.memories[0].text);
   return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported,evidence:[{memory_id:payload.memories[0].memory_id,quote:payload.memories[0].text}]})))});
  }
  if(payload.verification_feedback){
   repairCalls++;assert.equal(payload.verification_feedback.code,'l2_scenario_verification_rejected');
   assert.equal(payload.verification_feedback.verification.results[0].supported,false);
   assert.equal(payload.verification_feedback.proposal[0].paragraphs[0].text,invented);
   assert.deepEqual(names,['read','write','edit']);assert.match(request.system,/不得删除.*被拒段落/);
   if(request.messages.length===1)return tool('edit',{path:'garden-0.md',edits:[{oldText:invented,newText:payload.memories[0].text}]});
   return {blocks:[]};
  }
  return f.respond(request,input);
 }});
 const started=await f.extraction.start(`synthetic-scene-repair-${repairedSupported}`);await f.extraction.waitForIdle(started.runId);
 const task=(await f.extraction.read(started.runId)).tasks.find(task=>task.contactId===f.contactId),state=await f.documents.readTask(task.taskId);
 assert.equal(verificationCalls,2,'拒绝之后应走一次有界修正并独立复核');assert.equal(repairCalls,2,'修正只走一段正常工具回合');
 const sceneCalls=allCalls.filter(call=>call.claim.step_name==='document_scene');
 assert.equal(sceneCalls.length,6);assert.equal(new Set(sceneCalls.map(call=>call.claim.step_id)).size,1,'修正沿用原步骤、来源快照和预算身份');
 assert.equal(f.receipts.length,allCalls.length,'每次真实模型调用均经正式许可预约');
 const view=await f.documents.read({scopeKind:'contact',contactId:f.contactId});
 if(repairedSupported){assert.equal(state.outcome,'completed');assert.ok(view.publication);assert.ok(JSON.stringify(view.documents).includes('联系人长期喜欢合成园艺。'));assert.ok(!JSON.stringify(view.documents).includes(invented));}
 else{assert.equal(state.outcome,'incomplete');assert.equal(state.stages[0].status,'failed');assert.equal(state.stages[0].errorCode,'l2_scenario_verification_rejected');assert.equal(view.publication,null);}
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
