import test from 'node:test';
import assert from 'node:assert/strict';
import {watch} from 'node:fs';
import {readFile,writeFile,readdir,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchDsh} from '../src/launch.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {positiveSupplier} from './fixtures/sqlite-memory-profile-supplier.mjs';

/** 一条有界事件等待；就绪依据是握手或真实SQLite提交，不用sleep循环。 */
function changed(directory,probe,accept,{timeoutMs=12000,label='正式SQLite记忆宿主'}={}){
 return new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;
  const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();error?reject(error):resolveValue(value);};
  const load=async()=>{
   if(ended)return;if(running){dirty=true;return;}running=true;
   try{const value=await probe();if(accept(value))finish(null,value);}
   catch(error){if(error.code!=='ENOENT')finish(error);}
   finally{running=false;if(dirty&&!ended){dirty=false;void load();}}
  };
  const watcher=watch(directory,()=>{void load();});
  const timer=setTimeout(()=>finish(new Error(`${label}未在有界时间内达到预期状态`)),timeoutMs);
  void load();
 });
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

test('正式SQLite profile使用唯一模型宿主经认证HTTP完成两联系人和本人固定范围提取核验',{timeout:30000},async t=>{
 const cleanups=[];let host,provider,reopened,info;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)});
 const root=f.root,infoPath=join(root,'managed/sqlite-backend.info'),envFilePath=join(root,'synthetic.env');
 const auditPath=join(root,'synthetic-network.jsonl'),stderrPath=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 t.after(async()=>{
  if(host?.isRunning()){
   if(info)await fetch(`http://${info.address}/api/runtime/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(2000)}).catch(()=>{});
   if(!await host.waitForExit(5000))await host.terminate();
  }
  await reopened?.close();
  if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}
  await f.service.close();await f.contacts.close();for(const cleanup of cleanups.reverse())await cleanup();
  await assert.rejects(access(root),error=>error.code==='ENOENT');
 });
 const contactIds=f.saved.map(binding=>binding.contact_id);
 const expectedByContact=new Map([
  [contactIds[0],{contactText:'我长期住在高雄。',ownerText:'我长期偏好绿茶。',contactBody:'联系人长期住在高雄。',ownerBody:'用户长期偏好绿茶。'}],
  [contactIds[1],{contactText:'我长期住在台南。',ownerText:'我长期偏好红茶。',contactBody:'联系人长期住在台南。',ownerBody:'用户长期偏好红茶。'}],
 ]);
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[
  record('1',{text:expectedByContact.get(scope.token.contact_id).contactText}),
  record('2',{sender:'owner',text:expectedByContact.get(scope.token.contact_id).ownerText}),
 ],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of contactIds)await f.service.synchronize(contactId);
 await f.contacts.setReading(false);const prepared=[],contactForMessage=new Map(),contactForRecord=new Map();
 for(const contactId of contactIds){
  const messages=(await f.service.read(contactId)).messages;assert.equal(messages.length,2);
  for(const message of messages){
   assert.equal(message.contactId,contactId);assert.equal(message.text,expectedByContact.get(contactId)[message.sender==='owner'?'ownerText':'contactText']);
   prepared.push(message);contactForMessage.set(message.id,contactId);
   for(const recordId of message.sourceRecordIds)contactForRecord.set(recordId,contactId);
  }
 }
 const preparedByMessage=new Map(prepared.map(message=>[message.id,message]));
 const messagesForContact=contactId=>prepared.filter(message=>contactForMessage.get(message.id)===contactId);
 const expectedFact=messageId=>{
  const message=preparedByMessage.get(messageId);assert.ok(message,'模型与trace来源必须属于启动前准备的消息');
  const expected=expectedByContact.get(contactForMessage.get(messageId));
  return {subject:message.sender==='owner'?'self':'contact',text:expected[message.sender==='owner'?'ownerBody':'contactBody']};
 };
 const databaseId=f.storage.status.databaseId;
 await f.service.close();await f.contacts.close();await f.storage.close();
 await assert.rejects(f.storage.check(),{code:'worker_failed'});
 // 自有env仅有合成认证；正常官方地址、模型、预算、期限全部沿生产默认配置。
 await writeFile(envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n',{mode:0o600,flag:'wx'});
 await writeFile(auditPath,'',{mode:0o600,flag:'wx'});await writeFile(stderrPath,'',{mode:0o600,flag:'wx'});
 const guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700,flag:'wx'});
 const supplier=positiveSupplier();provider=createServer(supplier.handler);provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const supplierOrigin=`http://127.0.0.1:${provider.address().port}`;
 host=await launchDsh({nodeExecutable:wrapper,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,
  environment:{NOTALONE_SYNTHETIC_PROVIDER_URL:supplierOrigin,NOTALONE_SYNTHETIC_NETWORK_AUDIT:auditPath},
  sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','memory']}},()=>true);
 try{info=await changed(dirname(infoPath),async()=>Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];})),value=>Boolean(value.address&&value.token),{timeoutMs:8000,label:'正式profile握手'});}
 catch(error){throw new Error(`${error.message}; ${await readFile(stderrPath,'utf8').then(text=>text.slice(-1600))}`);}
 const api=async(route,{body,method=body===undefined?'GET':'POST',auth=true,extra={}}={})=>{
  const response=await fetch(`http://${info.address}${route}`,{method,headers:{...(auth?{Authorization:`Bearer ${info.token}`}:{})},...extra,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});
  return {status:response.status,data:await response.json()};
 };
 const launchRecord=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8'));
 const profile=await readFile(join(launchRecord.home,'profiles/notalone/cordis.patch.yml'),'utf8');
 const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 assert.equal(profile,official.replace('PLUGIN_PATH',JSON.stringify(resolve('src/sqlite-host-plugin.ts'))));
 assert.doesNotMatch(profile,/test\/fixtures/,'生产业务宿主未被测试插件替换');
 assert.equal((await api('/api/memory-processing/runs/current',{auth:false})).status,401);
 const state=await api('/api/runtime/status');assert.equal(state.status,200);assert.equal(state.data.runtime,'dsh');assert.equal(state.data.storage,'sqlite');assert.equal(state.data.ownership.memory,'typescript');assert.deepEqual(state.data.capabilities,['contacts','history','memory']);
 const identity=await api('/api/setup/status');assert.equal(identity.data.owner_id,owner);
 const sync=await api('/api/sync/status');assert.equal(sync.status,200);assert.equal(sync.data.sync_enabled,false);assert.equal(sync.data.body_available,false);
 for(const contactId of contactIds){const messages=await api(`/api/contacts/${contactId}/messages`);assert.equal(messages.status,200);assert.equal(messages.data.messages.length,2);}
 const requestKey=randomUUID();const first=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.total,4);
 assert.equal(first.data.inputs.length,prepared.length);assert.deepEqual(new Map(first.data.inputs.map(input=>[input.messageId,input.contactId])),contactForMessage);
 assert.ok(first.data.inputs.every(input=>preparedByMessage.get(input.messageId).sourceRecordIds.includes(input.recordId)&&contactForRecord.get(input.recordId)===input.contactId));
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);
 let runResponse;
 try{runResponse=await changed(join(root,'managed/sqlite/notalone.sqlite-wal'),()=>api(`/api/memory-processing/runs/${first.data.runId}`),value=>value.status!==200||['incomplete','failed','paused','revoked'].includes(value.data.state),{timeoutMs:10000,label:'正式记忆轮次'});}
 catch(error){const observed=await api(`/api/memory-processing/runs/${first.data.runId}`);throw new Error(`${error.message}; ${JSON.stringify({http:observed.status,state:observed.data.state,succeeded:observed.data.succeeded,tasks:observed.data.tasks?.map(task=>({scope:task.scopeKind,state:task.state,error:task.errorCode})),requests:{extraction:supplier.windows.length,verification:supplier.verifications.length},guard:(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),stderr:(await readFile(stderrPath,'utf8')).slice(-1200)})}`);}
 assert.equal(runResponse.status,200);const run=runResponse.data;
 try{await changed(join(root,'managed/sqlite/notalone.sqlite-wal'),()=>api('/api/memory-management?scope_kind=self'),value=>value.status!==200||value.data.memories?.filter(memory=>memory.current?.adoptionMode==='auto').length===2,{timeoutMs:10000,label:'正式08裁决发布'});}catch(error){const trace=await Promise.all(run.tasks.map(task=>api(`/api/memory-processing/tasks/${task.taskId}/events`)));throw new Error(`${error.message}; ${JSON.stringify({self:(await api('/api/memory-management?scope_kind=self')).data,supplierErrors:supplier.errors,adjudications:supplier.adjudications.length,trace:trace.map(value=>({calls:value.data.calls,events:value.data.events?.filter(e=>['adjudication_result','adjudication_failure'].includes(e.kind)).map(e=>e.payload)})),stderr:(await readFile(stderrPath,'utf8')).slice(-2000)})}`);}
 const traces=await Promise.all(run.tasks.map(async task=>({task,trace:(await api(`/api/memory-processing/tasks/${task.taskId}/events`)).data})));
 assert.deepEqual(supplier.errors,[]);assert.equal(run.succeeded,4,JSON.stringify(traces.map(({task,trace})=>({scope:task.scopeKind,state:task.state,errorCode:task.errorCode,calls:trace.calls,events:trace.events?.map(event=>event.kind)}))));assert.equal(run.failed,0);assert.equal(run.unknown,0);assert.equal(run.candidates.length,4);
 assert.deepEqual(run.candidates.filter(candidate=>candidate.scopeKind==='contact').map(candidate=>[candidate.contactId,candidate.body]).sort(),contactIds.map(contactId=>[contactId,expectedByContact.get(contactId).contactBody]).sort());
 assert.deepEqual(run.candidates.filter(candidate=>candidate.scopeKind==='self').map(candidate=>candidate.body).sort(),['用户长期偏好绿茶。','用户长期偏好红茶。'].sort());
 assert.ok(run.candidates.every(candidate=>candidate.origin==='auto'&&candidate.state==='verified_pending_decision'));assert.equal(run.laterStages,'pending');assert.notEqual(run.state,'completed');
 assert.equal(supplier.windows.length,2);assert.equal(supplier.verifications.length,2);
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');
 const extractionContacts=[],verificationContacts=[],extractionOutputs=new Map(),verificationOutputs=new Map();
 for(const {body,payload,output} of supplier.windows){
  assert.equal(body.model,normal.model.model);assert.equal(body.max_tokens,normal.model.maxTokens);
  const contacts=new Set(payload.messages.map(message=>{const prepared=preparedByMessage.get(message.message_id);assert.ok(prepared);assert.equal(message.text,prepared.text);assert.equal(message.sender,prepared.sender==='owner'?'self':'contact');return contactForMessage.get(message.message_id);}));
  assert.equal(contacts.size,1);const [contactId]=contacts;extractionContacts.push(contactId);extractionOutputs.set(contactId,output);
  assert.deepEqual(new Set(payload.messages.map(message=>message.message_id)),new Set(messagesForContact(contactId).map(message=>message.id)));
  assert.deepEqual(new Set(payload.target_message_ids),new Set(payload.messages.map(message=>message.message_id)));
 }
 for(const {body,payload,output} of supplier.verifications){
  assert.equal(body.model,normal.model.model);assert.equal(body.max_tokens,normal.model.maxTokens);assert.equal(body.tools[0].function.strict,true);
  const contacts=new Set(payload.candidates.flatMap(candidate=>{assert.equal(candidate.source_message_ids.length,1);assert.deepEqual({subject:candidate.subject,text:candidate.text},expectedFact(candidate.source_message_ids[0]));return candidate.source_message_ids.map(id=>contactForMessage.get(id));}));
  assert.equal(contacts.size,1);const [contactId]=contacts;verificationContacts.push(contactId);verificationOutputs.set(contactId,output);assert.equal(payload.candidates.length,2);
  assert.deepEqual(new Set(payload.candidates.flatMap(candidate=>candidate.source_message_ids)),new Set(messagesForContact(contactId).map(message=>message.id)));
 }
 assert.deepEqual(extractionContacts.sort(),[...contactIds].sort());assert.deepEqual(verificationContacts.sort(),[...contactIds].sort());
 for(const {task,trace} of traces.filter(item=>item.task.scopeKind==='contact')){
  assert.equal(trace.calls.length,2);assert.ok(trace.calls.every(call=>call.state==='succeeded'));assert.deepEqual(new Set(trace.calls.map(call=>call.purpose)),new Set(['extraction','verification']));
  for(const [purpose,name,expected] of [['extraction','DirectMemoryExtractionOutput',extractionOutputs.get(task.contactId)],['verification','SourceVerificationOutput',verificationOutputs.get(task.contactId)]]){
   assert.ok(expected);const calls=trace.calls.filter(call=>call.purpose===purpose);assert.equal(calls.length,1);
   const returns=trace.events.filter(event=>event.kind==='model_output'&&event.callId===calls[0].callId);assert.equal(returns.length,1);
   const tools=returns[0].payload.blocks.filter(block=>block.type==='tool-call');assert.equal(tools.length,1);assert.equal(tools[0].name,name);assert.deepEqual(JSON.parse(tools[0].arguments),expected);
  }
  assert.ok(trace.events.some(event=>event.kind==='extraction_return'));assert.ok(trace.events.some(event=>event.kind==='verification_return'));
  assert.equal(trace.events.filter(event=>event.kind==='verification').length,2);assert.ok(trace.events.filter(event=>event.kind==='verification').every(event=>event.payload.result.verification_mode==='complete-claim-v1'&&event.payload.result.claim_validation.semantic_support==='supported'));
  assert.ok(expectedByContact.has(task.contactId));assert.ok(trace.events.every(event=>event.sources.every(source=>source.contactId===task.contactId&&contactForRecord.get(source.recordId)===task.contactId)));
  const outputs=trace.events.filter(event=>['verified_output','verified_self_contribution'].includes(event.kind));assert.equal(outputs.length,2);
  assert.deepEqual(outputs.map(event=>[event.kind,event.payload.fact.text]).sort(),[['verified_output',expectedByContact.get(task.contactId).contactBody],['verified_self_contribution',expectedByContact.get(task.contactId).ownerBody]].sort());
  for(const event of outputs){
   const fact=event.payload.fact;assert.equal(fact.source_message_ids.length,1);assert.equal(contactForMessage.get(fact.source_message_ids[0]),task.contactId);assert.deepEqual({subject:fact.subject,text:fact.text},expectedFact(fact.source_message_ids[0]));
   assert.equal(event.payload.contactId,event.kind==='verified_output'?task.contactId:null);assert.deepEqual(new Set(event.sources.map(source=>source.recordId)),new Set(messagesForContact(task.contactId).flatMap(message=>message.sourceRecordIds)));
  }
 }
 const self=traces.find(item=>item.task.scopeKind==='self');assert.equal(self.trace.calls.length,2);assert.deepEqual(new Set(self.trace.calls.map(call=>call.purpose)),new Set(['adjudication','relation_verification']));assert.equal(self.trace.events.filter(event=>event.kind==='verified_output').length,2);
 for(const event of self.trace.events.filter(event=>event.kind==='verified_output')){
  const fact=event.payload.fact;assert.equal(fact.source_message_ids.length,1);assert.equal(fact.subject,'self');assert.equal(event.payload.contactId,null);assert.deepEqual({subject:fact.subject,text:fact.text},expectedFact(fact.source_message_ids[0]));
  const contactId=contactForMessage.get(fact.source_message_ids[0]);assert.ok(event.sources.every(source=>source.contactId===contactId&&contactForRecord.get(source.recordId)===contactId));assert.deepEqual(new Set(event.sources.map(source=>source.recordId)),new Set(messagesForContact(contactId).flatMap(message=>message.sourceRecordIds)));
 }
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,run.runId);assert.equal(supplier.windows.length+supplier.verifications.length+supplier.adjudications.length,6);
 const permits=await readdir(join(root,'model-permits'));assert.equal(permits.length,1,'记忆与已安装讨论所有者共用唯一模型宿主');
 const redirects=(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(redirects.length,6);assert.ok(redirects.every(item=>item.kind==='redirect'&&item.syntheticAuthentication));assert.deepEqual(redirects.map(item=>item.officialPath).sort(),['/anthropic/v1/messages','/anthropic/v1/messages','/anthropic/v1/messages','/anthropic/v1/messages','/beta/chat/completions','/beta/chat/completions'].sort());
 const stop=await api('/api/runtime/shutdown',{method:'POST'});assert.equal(stop.status,200);assert.equal(stop.data.state,'stopped');assert.equal(await host.waitForExit(5000),true);assert.equal(host.isRunning(),false);
 for(const owned of [infoPath,infoPath+'.dsh-lock',launchRecord.home])await assert.rejects(access(owned),error=>error.code==='ENOENT');
 const socketIdentity=createHash('sha256').update(JSON.stringify([resolve(infoPath),resolve(envFilePath)])).digest('hex').slice(0,24);
 await assert.rejects(access(join('/tmp',`na-model-${process.getuid?.()??'local'}-${socketIdentity}`)),error=>error.code==='ENOENT');
 reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:new URL('./fixtures/sqlite-memory-profile-store.mjs',import.meta.url).href});
 assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 const evidence=await reopened.execute('fixture.memoryProfileEvidence',{ownerId:owner,runId:run.runId});assert.equal(evidence.runCount,1);assert.equal(evidence.formalMemoryRows,12);assert.equal(evidence.ownerInputs.length,2);assert.ok(evidence.ownerInputs.every(input=>input.role==='verified_contribution'&&input.consumerScope==='self'&&input.producerScope==='contact'&&input.sameRun&&input.samePayload));assert.equal(evidence.calls.length,6);
 assert.ok(evidence.calls.every(call=>call.state==='succeeded'&&call.settlement==='settled'&&call.model===normal.model.model&&call.maxOutputTokens===normal.model.maxTokens&&call.contextWindowTokens===normal.model.budgetProfile.context_window_tokens&&call.safetyMarginTokens===normal.model.budgetProfile.safety_margin_tokens&&call.serializedBytes>0&&call.inputTokens+call.maxOutputTokens+call.safetyMarginTokens<=call.contextWindowTokens));
 assert.equal(await readFile(envFilePath,'utf8'),'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n');
});

test('正式SQLite profile的unknown保持可读和幂等，暂停后关闭排空另一联系人许可等待',{timeout:30000},async t=>{
 const cleanups=[];let host,provider,reopened,info,launchRecord,shutdownAttempted=false;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root;
 const infoPath=join(root,'managed/sqlite-backend.info'),envFilePath=join(root,'synthetic.env');
 const auditPath=join(root,'synthetic-network.jsonl'),stderrPath=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 const socketIdentity=createHash('sha256').update(JSON.stringify([resolve(infoPath),resolve(envFilePath)])).digest('hex').slice(0,24);
 const socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${socketIdentity}`);
 const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
 const api=async(route,{body,method=body===undefined?'GET':'POST',auth=true,timeoutMs=3000}={})=>{
  const response=await fetch(`http://${info.address}${route}`,{method,headers:auth?{Authorization:`Bearer ${info.token}`}:{},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs)});
  return {status:response.status,data:await response.json()};
 };
 t.after(async()=>{
  const forced=Boolean(host?.isRunning());
  if(forced){
   if(info&&!shutdownAttempted)await api('/api/runtime/shutdown',{method:'POST',timeoutMs:2000}).catch(()=>{});
   if(!await host.waitForExit(1000))assert.equal(await host.terminate(),true,'只终止本轮正式profile自有子进程');
  }
  assert.ok(!host?.isRunning());await reopened?.close();
  if(provider?.listening){const closed=once(provider,'close',{signal:AbortSignal.timeout(2000)});provider.closeAllConnections();provider.close();await closed;}
  await f.service.close();await f.contacts.close();
  const socketResidue=await exists(socketDirectory);
  if(socketResidue){
   t.diagnostic(JSON.stringify({phase:'unknown_fixture_cleanup',forced,socketResidue,childStopped:!host?.isRunning(),rootPreserved:true,root,socketDirectory}));
   throw new Error(`synthetic_unknown_socket_residue_preserved: ${socketDirectory}; diagnostic_root: ${root}`);
  }
  for(const cleanup of cleanups.reverse())await cleanup();
  await assert.rejects(access(root),error=>error.code==='ENOENT');
  t.diagnostic(JSON.stringify({phase:'unknown_fixture_cleanup',forced,socketResidue,childStopped:!host?.isRunning(),rootRemoved:true}));
 },{timeout:30000});
 const contactIds=f.saved.map(binding=>binding.contact_id),contactForMessage=new Map();
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:scope.token.contact_id===contactIds[0]?'合成甲长期住在高雄。':'合成乙长期住在台南。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of contactIds){await f.service.synchronize(contactId);for(const message of (await f.service.read(contactId)).messages)contactForMessage.set(message.id,contactId);}
 await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
 await f.service.close();await f.contacts.close();await f.storage.close();await assert.rejects(f.storage.check(),{code:'worker_failed'});
 for(const [path,text] of [[envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'],[auditPath,''],[stderrPath,'']])await writeFile(path,text,{mode:0o600,flag:'wx'});
 const guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700,flag:'wx'});
 const requests=[],supplierErrors=[];let received=0;
 provider=createServer(async(req,res)=>{
  received++;
  try{
   assert.equal(req.url,'/anthropic/v1/messages');assert.equal(req.headers['x-api-key'],'synthetic-only');
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   const payload=JSON.parse(body.messages.find(message=>message.role==='user').content.find(block=>block.type==='text').text);
   requests.push({body,payload});res.destroy();
  }catch(error){supplierErrors.push(error instanceof Error?error.message:'synthetic_unknown_supplier_failed');res.destroy();}
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening',{signal:AbortSignal.timeout(2000)});
 host=await launchDsh({nodeExecutable:wrapper,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,
  environment:{NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`,NOTALONE_SYNTHETIC_NETWORK_AUDIT:auditPath},
  sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','memory']}},()=>true);
 info=await changed(dirname(infoPath),async()=>Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];})),value=>Boolean(value.address&&value.token),{timeoutMs:8000,label:'unknown正式profile握手'});
 launchRecord=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8'));
 const profile=await readFile(join(launchRecord.home,'profiles/notalone/cordis.patch.yml'),'utf8'),official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 assert.equal(profile,official.replace('PLUGIN_PATH',JSON.stringify(resolve('src/sqlite-host-plugin.ts'))));
 assert.equal((await api('/api/memory-processing/runs/current',{auth:false})).status,401);
 assert.equal((await api('/api/runtime/status')).data.state,'running');assert.equal((await api('/api/sync/status')).data.sync_enabled,false);
 const requestKey=randomUUID(),first=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(first.status,200);assert.equal(first.data.total,2);
 assert.deepEqual(new Map(first.data.inputs.map(input=>[input.messageId,input.contactId])),contactForMessage);
 const observed=await changed(join(root,'managed/sqlite/notalone.sqlite-wal'),async()=>{
  const run=await api(`/api/memory-processing/runs/${first.data.runId}`);assert.equal(run.status,200);
  const tasks=await Promise.all(run.data.tasks.filter(task=>task.scopeKind==='contact').map(async task=>({task,trace:await api(`/api/memory-processing/tasks/${task.taskId}/events`)})));
  return {run:run.data,tasks};
 },value=>value.run.unknown===1&&value.tasks.some(item=>item.task.state==='running'&&item.trace.status===200&&item.trace.data.calls.some(call=>call.state==='prepared')),{timeoutMs:10000,label:'unknown与另一联系人许可等待'});
 assert.deepEqual(supplierErrors,[]);assert.equal(requests.length,1);assert.equal(observed.run.succeeded,0);assert.equal(observed.run.candidates.length,0);
 const uncertain=observed.tasks.find(item=>item.task.state==='unknown'),waiting=observed.tasks.find(item=>item.task.state==='running');assert.ok(uncertain);assert.ok(waiting);assert.notEqual(uncertain.task.contactId,waiting.task.contactId);
 assert.equal(uncertain.trace.status,200);assert.equal(uncertain.trace.data.calls.length,1);const call=uncertain.trace.data.calls[0];assert.equal(call.state,'unknown');assert.ok(BigInt(call.reservedBudgetUnits)>0n);assert.equal(call.actualBudgetUnits,null);
 assert.ok(uncertain.trace.data.events.some(event=>event.kind==='model_input'));assert.ok(uncertain.trace.data.events.some(event=>event.kind==='model_failure'));assert.ok(!uncertain.trace.data.events.some(event=>['extraction_return','verification_return','verified_output'].includes(event.kind)));
 assert.equal(waiting.trace.data.calls.length,1);assert.equal(waiting.trace.data.calls[0].state,'prepared');assert.ok(waiting.trace.data.events.some(event=>event.kind==='model_input'));
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');assert.equal(requests[0].body.model,normal.model.model);assert.equal(requests[0].body.max_tokens,normal.model.maxTokens);
 assert.deepEqual(new Set(requests[0].payload.messages.map(message=>contactForMessage.get(message.message_id))),new Set([uncertain.task.contactId]));
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);
 assert.equal((await api(`/api/memory-processing/runs/${first.data.runId}/continue`,{body:{}})).status,200);
 const paused=await api(`/api/memory-processing/runs/${first.data.runId}/pause`,{body:{}});assert.equal(paused.status,200);assert.equal(paused.data.state,'paused');assert.equal(paused.data.unknown,1);
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);assert.equal(requests.length,1,'unknown同key与继续均不盲目重发');
 assert.equal((await readdir(join(root,'model-permits'))).length,1);
 const redirects=(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(redirects.length,1);assert.deepEqual(redirects[0],{kind:'redirect',officialPath:'/anthropic/v1/messages',syntheticAuthentication:true});
 shutdownAttempted=true;const stopped=await api('/api/runtime/shutdown',{method:'POST',timeoutMs:5000}).catch(error=>({status:null,error:error.name}));
 const exited=await host.waitForExit(stopped.status===200?5000:1000),runtime=exited?null:await api('/api/runtime/status').catch(error=>({status:null,error:error.name}));
 const residues={info:await exists(infoPath),lock:await exists(infoPath+'.dsh-lock'),profile:await exists(launchRecord.home),socket:await exists(socketDirectory)};
 t.diagnostic(JSON.stringify({phase:'unknown_normal_shutdown',receivedRequests:received,parsedRequests:requests.length,unknown:observed.run.unknown,waitingCall:waiting.trace.data.calls[0].state,pause:paused.data.state,shutdown:stopped,exited,runtime,residues}));
 assert.equal(stopped.status,200,'正常关闭应有界排空另一联系人许可等待');assert.equal(stopped.data.state,'stopped');assert.equal(exited,true);assert.deepEqual(residues,{info:false,lock:false,profile:false,socket:false});assert.equal(requests.length,1);
 reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 const persisted=await reopened.execute('memoryExtraction.read',{ownerId:owner,runId:first.data.runId});assert.equal(persisted.state,'paused');assert.equal(persisted.unknown,1);assert.equal(persisted.candidates.length,0);
 const persistedUnknown=await reopened.execute('memoryExtraction.trace',{ownerId:owner,taskId:uncertain.task.taskId});assert.equal(persistedUnknown.calls.length,1);assert.equal(persistedUnknown.calls[0].state,'unknown');
 const persistedWaiting=await reopened.execute('memoryExtraction.trace',{ownerId:owner,taskId:waiting.task.taskId});assert.equal(persistedWaiting.calls.length,1);assert.equal(persistedWaiting.calls[0].callId,waiting.trace.data.calls[0].callId);assert.equal(persistedWaiting.calls[0].state,'failed');
 assert.equal(received,1);assert.equal(requests.length,1);assert.deepEqual(supplierErrors,[]);
 const finalRedirects=(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(finalRedirects.length,1);assert.deepEqual(finalRedirects,redirects);
});
