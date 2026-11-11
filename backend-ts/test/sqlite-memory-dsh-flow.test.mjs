import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

test('官方DSH经真实SQLite许可、认证HTTP和正常提取端口完成固定轮次，同key不重发且保留完整无产出追踪',{timeout:25000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-sqlite-memory-dsh-flow-'));
 const token=randomBytes(24).toString('base64url');let child,exited,provider,url,log='';const requests=[];let hangNext=false;const dispatched=Promise.withResolvers();
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){
   if(url)await fetch(`${url}/__fixture/stop`,{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});
   else child.kill('SIGTERM');
  }
  await exited;
  if(provider){provider.closeAllConnections();await new Promise(resolveClose=>provider.close(resolveClose));}
  await rm(directory,{recursive:true,force:true});
 });
 provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;requests.push({headers:req.headers,body:JSON.parse(raw)});
  if(hangNext){hangNext=false;dispatched.resolve();return;}
  const events=[{type:'message_start',message:{id:`synthetic-${requests.length}`,type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'tool_use',id:`synthetic-tool-${requests.length}`,name:'DirectMemoryExtractionOutput',input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"scenes":[]}'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 // 正式 sqlite.patch 尚无 llm；测试明确补此公开服务，仅替换业务宿主插件。
 const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 const missingLlm=!official.includes("name: '@deepseek-ai/dsh-llm'");
 const patch=official.replace('PLUGIN_PATH',JSON.stringify(resolve('test/fixtures/sqlite-memory-dsh-flow.ts')))+(missingLlm?"    - id: sqlite-memory-test-llm\n      name: '@deepseek-ai/dsh-llm'\n":'');
 await writeFile(join(profile,'cordis.patch.yml'),patch);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
   NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,NOTALONE_SYNTHETIC_HTTP_TOKEN:token},stdio:['ignore','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',value=>{log+=value;});
 const ready=await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error(log.slice(-1500))),10000);
  child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_MEMORY_DSH_READY (\{[^\n]+\})/);if(match){clearTimeout(timer);resolveReady(JSON.parse(match[1]));}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1500)));});
 });url=ready.url;
 const api=async(path,{body,method=body===undefined?'GET':'POST',auth=true}={})=>{
  const response=await fetch(`${url}${path}`,{method,headers:{...(auth?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
 };
 assert.equal((await api('/api/memory-processing/runs/current',{auth:false})).status,401);
 const requestKey=randomUUID();const first=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(first.status,200,JSON.stringify(first.data));
 assert.equal(first.data.total,2);assert.equal(first.data.inputs.length,2);assert.deepEqual(new Set(first.data.inputs.map(input=>input.contactId)),new Set(ready.contactIds));
 const replay=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(replay.status,200);assert.equal(replay.data.runId,first.data.runId);
 const idle=await api('/__fixture/wait',{method:'POST'});assert.equal(idle.status,200,JSON.stringify(idle.data));assert.deepEqual(idle.data.integrity,{integrity:'ok',foreignKeys:'ok'});assert.equal(idle.data.readingEnabled,false);
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');assert.deepEqual(idle.data.normalModel,normal.model);
 const done=await api(`/api/memory-processing/runs/${first.data.runId}`);assert.equal(done.status,200);const traces=await Promise.all(done.data.tasks.filter(task=>task.scopeKind==='contact').map(async task=>({task,trace:(await api(`/api/memory-processing/tasks/${task.taskId}/events`)).data})));
 assert.equal(done.data.succeeded,2,JSON.stringify({supplierRequests:requests.length,traces:traces.map(({task,trace})=>({task,calls:trace.calls,events:trace.events.filter(event=>event.kind!=='model_input')})),logs:log.slice(-1000)}));assert.equal(done.data.candidates.length,0);assert.equal(done.data.failed,0);assert.equal(done.data.unknown,0);assert.equal(done.data.laterStages,'pending');assert.notEqual(done.data.state,'completed');
 assert.equal(requests.length,2);assert.ok(requests.every(request=>request.headers['x-api-key']==='synthetic-only'&&request.body.model===normal.model.model&&request.body.max_tokens===normal.model.maxTokens));
 for(const task of done.data.tasks.filter(task=>task.scopeKind==='contact')){
  const trace=await api(`/api/memory-processing/tasks/${task.taskId}/events`);assert.equal(trace.status,200);assert.equal(trace.data.calls.length,1);
  const call=trace.data.calls[0];assert.equal(call.state,'succeeded');assert.ok(BigInt(call.reservedBudgetUnits)>BigInt(normal.model.maxTokens));assert.equal(call.actualBudgetUnits,'10');
  assert.ok(trace.data.events.some(event=>event.kind==='model_input'&&event.payload.system&&event.payload.tool.name==='DirectMemoryExtractionOutput'));
  assert.ok(trace.data.events.some(event=>event.kind==='model_output'&&event.payload.blocks.some(block=>block.type==='tool-call')));
  assert.ok(trace.data.events.some(event=>event.kind==='stage_result'&&event.payload.outcome==='no_new_memory'));
  assert.ok(trace.data.events.every(event=>event.sources.length===1&&event.sources[0].contactId===task.contactId));
 }
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);assert.equal(requests.length,2);
 // 精确取消在真实SQLite预约成功之后、官方adapter进入fetch之前，不把它记成未知或占住许可。
 assert.equal((await api('/__fixture/add-message',{method:'POST'})).status,200);
 assert.equal((await api('/__fixture/cancel-next',{method:'POST'})).status,200);
 const cancelled=await api('/api/memory-processing/runs',{body:{request_key:randomUUID()}});assert.equal(cancelled.data.total,1);
 await api('/__fixture/wait',{method:'POST'});
 const cancelledDone=await api(`/api/memory-processing/runs/${cancelled.data.runId}`);assert.equal(cancelledDone.data.failed,1);assert.equal(cancelledDone.data.unknown,0);assert.equal(requests.length,2,'确定未到fetch的取消不产生第三次网络调用');
 const cancelledTask=cancelledDone.data.tasks.find(task=>task.scopeKind==='contact');
 const cancelledTrace=await api(`/api/memory-processing/tasks/${cancelledTask.taskId}/events`);assert.equal(cancelledTrace.data.calls.length,1);assert.equal(cancelledTrace.data.calls[0].state,'failed');
 const dispatchProof=await api('/__fixture/dispatch-proof');assert.deepEqual(dispatchProof.data.pending,[[],[]]);
 const cancellationReceipt=dispatchProof.data.receipts.find(receipt=>receipt.attemptId===cancelledTrace.data.calls[0].callId);assert.equal(cancellationReceipt.dispatch,'not_sent');assert.equal(cancellationReceipt.outcome,'cancelled');
 const resumedCancellation=await api(`/api/memory-processing/runs/${cancelled.data.runId}/continue`,{body:{action_version:cancelledDone.data.controlVersion,operation_id:randomUUID()}});assert.equal(resumedCancellation.status,200);
 await api('/__fixture/wait',{method:'POST'});assert.equal((await api(`/api/memory-processing/runs/${cancelled.data.runId}`)).data.succeeded,1);assert.equal(requests.length,3,'取消回执已释放许可，随后同一固定任务可正常调用一次');
 // 未观察到响应的真实已派发调用，关闭后在同一SQLite和ModelHost重建端口。
 assert.equal((await api('/__fixture/add-message',{method:'POST'})).status,200);hangNext=true;
 const interrupted=await api('/api/memory-processing/runs',{body:{request_key:randomUUID()}});assert.equal(interrupted.status,200);assert.equal(interrupted.data.total,1);
 await dispatched.promise;assert.equal(requests.length,4);assert.equal((await api('/__fixture/restart-model',{method:'POST'})).status,200);
 const uncertain=await api(`/api/memory-processing/runs/${interrupted.data.runId}`);assert.equal(uncertain.data.succeeded,0);assert.equal(uncertain.data.unknown,1);
 const unknownTask=uncertain.data.tasks.find(task=>task.scopeKind==='contact');const unknownTrace=await api(`/api/memory-processing/tasks/${unknownTask.taskId}/events`);
 assert.equal(unknownTrace.data.calls.length,1);assert.equal(unknownTrace.data.calls[0].state,'unknown');assert.ok(BigInt(unknownTrace.data.calls[0].reservedBudgetUnits)>0n);assert.equal(unknownTrace.data.calls[0].actualBudgetUnits,null);
 await api(`/api/memory-processing/runs/${interrupted.data.runId}/continue`,{body:{}});await api('/__fixture/wait',{method:'POST'});assert.equal(requests.length,4);
 const next=await api('/api/memory-processing/runs',{body:{request_key:randomUUID()}});assert.equal(next.status,200);await api('/__fixture/wait',{method:'POST'});
 const stillUnknown=await api(`/api/memory-processing/runs/${next.data.runId}`);assert.equal(stillUnknown.data.succeeded,0);assert.equal(stillUnknown.data.unknown,1);assert.equal(requests.length,4,'新请求和手动继续均不能盲重发已派发未知效果');
 await api('/__fixture/stop',{method:'POST'});const [code,signal]=await exited;assert.equal(code,0,log.slice(-1500));assert.equal(signal,null);
 await assert.rejects(access(ready.businessRoot),error=>error.code==='ENOENT');
});

const verificationFields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
function positiveSupplier(){
 const windows=[],verifications=[],messages=new Map(),errors=[];
 const fact=message=>{const subject=message.sender==='self'?'self':'contact';return {text:message.text.replace(/^我/,subject==='self'?'用户':'联系人'),subject,category:'common_fact',topic:'other',source_message_ids:[message.message_id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'保留合成原句明确陈述。',event:null,conditions:null};};
 const handler=async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   if(req.url==='/beta/chat/completions'){
    assert.equal(req.headers.authorization,'Bearer synthetic-only');assert.equal(body.stream,false);
    assert.equal(body.tools[0].function.name,'SourceVerificationOutput');assert.equal(body.tools[0].function.strict,true);
    const payload=JSON.parse(body.messages.find(message=>message.role==='user').content);verifications.push({body,payload});
    const facet=()=>({verdict:'supported',evidence_indices:[0]});
    const output={results:payload.candidates.map((candidate,candidate_index)=>{
     const message=messages.get(candidate.source_message_ids[0]);assert.ok(message);
     return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],claim_check:{version:2,field_checks:Object.fromEntries(verificationFields.map(field=>[field,facet()])),parts:[{candidate_span:{start:0,end:[...candidate.text].length},attribution:{...facet(),scope_subject:candidate.subject,actor_kind:candidate.subject,resolution:'explicit',subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:candidate.subject==='self'?2:3}}]},arguments_and_relation:facet(),temporal_and_modality:facet()}]}};
    })};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`synthetic-v-${verifications.length}`,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:`synthetic-v-tool-${verifications.length}`,type:'function',function:{name:'SourceVerificationOutput',arguments:JSON.stringify(output)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:9,prompt_cache_hit_tokens:0}}));return;
   }
   assert.equal(req.headers['x-api-key'],'synthetic-only');assert.equal(body.tools[0].name,'DirectMemoryExtractionOutput');
   const user=body.messages.find(message=>message.role==='user').content.find(block=>block.type==='text').text;
   const payload=JSON.parse(user);windows.push({body,payload});for(const message of payload.messages)messages.set(message.message_id,message);
   const output={scenes:[{scene_name:'合成长期资料',memories:payload.messages.map(fact)}]};
   const events=[{type:'message_start',message:{id:`synthetic-e-${windows.length}`,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:`synthetic-e-tool-${windows.length}`,name:'DirectMemoryExtractionOutput',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(output)}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
   res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }catch(error){errors.push(error instanceof Error?error.message:'synthetic_supplier_failed');res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_supplier_contract_failed'}));}
 };
 return {handler,windows,verifications,errors};
}

test('官方DSH和SQLite正常E/V经strict环回传输产出两位联系人及本人资料，保留typed贡献与预算并排空关闭',{timeout:25000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-sqlite-memory-dsh-positive-'));const token=randomBytes(24).toString('base64url');
 let child,exited,provider,url,log='';const supplier=positiveSupplier();
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){if(url)await fetch(`${url}/__fixture/stop`,{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});else child.kill('SIGTERM');}
  await exited;if(provider){provider.closeAllConnections();await new Promise(resolveClose=>provider.close(resolveClose));}
  await rm(directory,{recursive:true,force:true});await assert.rejects(access(directory),error=>error.code==='ENOENT');
 });
 provider=createServer(supplier.handler);provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 const patch=official.replace('PLUGIN_PATH',JSON.stringify(resolve('test/fixtures/sqlite-memory-dsh-flow.ts')))+(!official.includes("name: '@deepseek-ai/dsh-llm'")?"    - id: sqlite-memory-test-llm\n      name: '@deepseek-ai/dsh-llm'\n":'');
 await writeFile(join(profile,'cordis.patch.yml'),patch);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,NOTALONE_SYNTHETIC_HTTP_TOKEN:token,NOTALONE_SYNTHETIC_MEMORY_FLOW:'verified'},stdio:['ignore','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',value=>{log+=value;});
 const ready=await new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error(log.slice(-1200))),10000);child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_MEMORY_DSH_READY (\{[^\n]+\})/);if(match){clearTimeout(timer);resolveReady(JSON.parse(match[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1200)));});});url=ready.url;
 const api=async(path,{body,method=body===undefined?'GET':'POST',auth=true}={})=>{const response=await fetch(`${url}${path}`,{method,headers:{...(auth?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
 assert.equal((await api('/api/memory-processing/runs/current',{auth:false})).status,401);
 const requestKey=randomUUID();const first=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(first.status,200);assert.equal(first.data.total,4);assert.equal(first.data.inputs.length,4);
 const replay=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(replay.data.runId,first.data.runId);
 const idle=await api('/__fixture/wait',{method:'POST'});assert.equal(idle.status,200);assert.equal(idle.data.readingEnabled,false);assert.deepEqual(idle.data.integrity,{integrity:'ok',foreignKeys:'ok'});
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');assert.deepEqual(idle.data.normalModel,normal.model);
 const done=await api(`/api/memory-processing/runs/${first.data.runId}`);const traces=await Promise.all(done.data.tasks.map(async task=>({task,trace:(await api(`/api/memory-processing/tasks/${task.taskId}/events`)).data})));
 assert.deepEqual(supplier.errors,[]);assert.equal(done.data.succeeded,4,JSON.stringify(traces.map(({task,trace})=>({state:task.state,errorCode:task.errorCode,calls:trace.calls,events:trace.events.map(event=>event.kind)}))));assert.equal(done.data.failed,0);assert.equal(done.data.unknown,0);assert.equal(done.data.candidates.length,4);
 assert.deepEqual(done.data.candidates.filter(candidate=>candidate.scopeKind==='contact').map(candidate=>candidate.body).sort(),['联系人长期住在高雄。','联系人长期住在台南。'].sort());
 assert.deepEqual(done.data.candidates.filter(candidate=>candidate.scopeKind==='contact').map(candidate=>[candidate.contactId,candidate.body]).sort(),[[ready.contactIds[0],'联系人长期住在高雄。'],[ready.contactIds[1],'联系人长期住在台南。']].sort());
 assert.deepEqual(done.data.candidates.filter(candidate=>candidate.scopeKind==='self').map(candidate=>candidate.body).sort(),['用户长期偏好绿茶。','用户长期偏好红茶。'].sort());
 assert.ok(done.data.candidates.every(candidate=>candidate.origin==='auto'&&candidate.state==='verified_pending_decision'));assert.equal(done.data.laterStages,'pending');assert.notEqual(done.data.state,'completed');
 assert.equal(supplier.windows.length,2);assert.equal(supplier.verifications.length,2);
 const contactForMessage=new Map(first.data.inputs.map(input=>[input.messageId,input.contactId]));
 for(const {body,payload} of supplier.windows){assert.equal(new Set(payload.messages.map(message=>contactForMessage.get(message.message_id))).size,1);assert.equal(payload.messages.length,2);assert.deepEqual(new Set(payload.target_message_ids),new Set(payload.messages.map(message=>message.message_id)));assert.equal(body.model,normal.model.model);assert.equal(body.max_tokens,normal.model.maxTokens);}
 for(const {body,payload} of supplier.verifications){assert.equal(new Set(payload.candidates.flatMap(candidate=>candidate.source_message_ids).map(id=>contactForMessage.get(id))).size,1);assert.equal(body.max_tokens,normal.model.maxTokens);assert.equal(body.model,normal.model.model);}
 for(const {task,trace} of traces.filter(item=>item.task.scopeKind==='contact')){
  assert.equal(trace.calls.length,2);assert.deepEqual(new Set(trace.calls.map(call=>call.purpose)),new Set(['extraction','verification']));assert.ok(trace.calls.every(call=>call.state==='succeeded'&&BigInt(call.reservedBudgetUnits)>BigInt(normal.model.maxTokens)));assert.deepEqual(trace.calls.map(call=>call.actualBudgetUnits).sort(),['10','14']);
  assert.ok(trace.events.some(event=>event.kind==='extraction_return'));assert.ok(trace.events.some(event=>event.kind==='verification_return'));
  const verified=trace.events.filter(event=>event.kind==='verification');assert.equal(verified.length,2);assert.ok(verified.every(event=>event.payload.result.verification_mode==='complete-claim-v1'&&event.payload.result.verdict==='supported'&&event.payload.result.claim_validation.semantic_support==='supported'));
  assert.ok(trace.events.every(event=>event.sources.every(source=>source.contactId===task.contactId)));assert.ok(trace.events.some(event=>event.kind==='verified_self_contribution'));
 }
 const own=traces.find(item=>item.task.scopeKind==='self');assert.equal(own.trace.calls.length,0);assert.equal(own.trace.events.filter(event=>event.kind==='verified_output').length,2);assert.ok(done.data.candidates.filter(candidate=>candidate.scopeKind==='self').every(candidate=>own.trace.events.some(event=>event.eventId===candidate.id&&event.attemptId===candidate.attemptId)));
 const proof=await api('/__fixture/proof');assert.equal(proof.status,200);assert.equal(proof.data.ownerInputs.length,2);assert.ok(proof.data.ownerInputs.every(input=>input.role==='verified_contribution'&&input.consumerScope==='self'&&input.producerScope==='contact'&&input.sameRun&&input.samePayload));assert.equal(proof.data.formalMemoryRows,0);
 assert.equal(proof.data.callBudgets.length,4);assert.ok(proof.data.callBudgets.every(call=>call.maxOutputTokens===normal.model.maxTokens&&call.contextWindowTokens===normal.model.budgetProfile.context_window_tokens&&call.safetyMarginTokens===normal.model.budgetProfile.safety_margin_tokens&&call.serializedBytes>0&&call.inputTokens+call.maxOutputTokens+call.safetyMarginTokens<=call.contextWindowTokens));
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);assert.equal(supplier.windows.length+supplier.verifications.length,4);
 await api('/__fixture/stop',{method:'POST'});const [code,signal]=await exited;assert.equal(code,0,log.slice(-1000));assert.equal(signal,null);await assert.rejects(access(ready.businessRoot),error=>error.code==='ENOENT');
});
