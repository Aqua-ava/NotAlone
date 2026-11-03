import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {watch} from 'node:fs';
import {access,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchDsh} from '../src/launch.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';

/** 以握手或真实提交唤醒，一次有界等待，不轮询。 */
function changed(path,probe,accept,label){
 return new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;
  const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();error?reject(error):resolveValue(value);};
  const load=async()=>{
   if(ended)return;if(running){dirty=true;return;}running=true;
   try{const value=await probe();if(accept(value))finish(null,value);}catch(error){if(error.code!=='ENOENT')finish(error);}
   finally{running=false;if(dirty&&!ended){dirty=false;void load();}}
  };
  const watcher=watch(path,()=>void load()),timer=setTimeout(()=>finish(new Error(`${label}超时`)),8000);void load();
 });
}
function latch(label){
 let release;const promise=new Promise(resolveValue=>{release=resolveValue;});
 return {release,promise,wait:()=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`${label}超时`)),6000);timer.unref();promise.finally(()=>clearTimeout(timer));})])};
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const png=await sharp({create:{width:8,height:8,channels:3,background:'#ef9f4f'}}).png().toBuffer();
function respond(res,model,tool,value){
 const id=randomUUID(),events=[{type:'message_start',message:{id,type:'message',role:'assistant',model,content:[],usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:randomUUID(),name:tool,input:{}}:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(value)}:{type:'text_delta',text:JSON.stringify(value)}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:7}},{type:'message_stop'}];
 res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

test('正式SQLite profile的图文后台在途时前台已到共享供应商，来源图片和统一台账保持隔离',{timeout:30000},async t=>{
 const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root;
 const [frontContact,backContact]=f.saved.map(binding=>binding.contact_id);
 const frontText='合成甲下周一见面。',backText='合成乙家中的橘猫照片。';
 const infoPath=join(root,'managed/sqlite-backend.info'),envFilePath=join(root,'synthetic.env');
 const auditPath=join(root,'synthetic-network.jsonl'),stderrPath=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 const socketIdentity=createHash('sha256').update(JSON.stringify([resolve(infoPath),resolve(envFilePath)])).digest('hex').slice(0,24);
 const socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${socketIdentity}`);
 const backgroundArrived=latch('后台图文到达供应商'),foregroundArrived=latch('前台在后台释放前到达供应商'),releaseBackground=latch('后台放行'),releaseForeground=latch('前台放行');
 let host,info,supplier,media,reopened;
 const requests=[],supplierErrors=[];
 const api=async(route,{body,method=body===undefined?'GET':'POST'}={})=>{
  const response=await fetch(`http://${info.address}${route}`,{method,headers:{Authorization:`Bearer ${info.token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)});
  return {status:response.status,data:await response.json()};
 };
 t.after(async()=>{
  releaseBackground.release();releaseForeground.release();
  if(host?.isRunning()){
   if(info)await api('/api/runtime/shutdown',{method:'POST'}).catch(()=>{});
   if(!await host.waitForExit(5000))assert.equal(await host.terminate(),true);
  }
  assert.ok(!host?.isRunning());await reopened?.close();
  if(supplier?.listening){supplier.closeAllConnections();await new Promise(done=>supplier.close(done));}
  await media?.close();await f.service.close();await f.contacts.close();
  await assert.rejects(access(socketDirectory),error=>error.code==='ENOENT');
  for(const cleanup of cleanups.reverse())await cleanup();
  await assert.rejects(access(root),error=>error.code==='ENOENT');
 });
 f.channel.page=async(scope,_target,cursor)=>({target:f.target.descriptor,cursorIn:cursor,cursorOut:null,records:scope.token.contact_id===frontContact?[record('1',{text:frontText})]:[record('1',{text:backText}),record('2',{kind:'image',text:null,originalType:'3'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [frontContact,backContact])await f.service.synchronize(contactId);
 const frontMessages=(await f.service.read(frontContact)).messages,backMessages=(await f.service.read(backContact)).messages,image=backMessages.find(message=>message.kind==='image');
 const adapter={version:'synthetic-concurrency-image-v1',supports:kind=>kind==='image',async execute(context){
  await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'thumbnail',qualityProof:null})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-concurrency-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-concurrency-image'}};
 }};
 media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.service,userData:root,adapters:[adapter]});await media.initialize();
 const savedImage=await media.extract(backContact,image.id,{requestKey:randomUUID(),goal:'extract'}),file=savedImage.files[0];
 await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
 await media.close();await f.service.close();await f.contacts.close();await f.storage.close();
 // 仅供应商网络为合成替身；人工模式固定显式单联系人任务，背景容量1故意饱和。
 await writeFile(envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_BACKGROUND_PROCESSING=manual\nNOTALONE_EXTRACTION_BATCH_CONCURRENCY=1\n',{mode:0o600,flag:'wx'});
 for(const path of [auditPath,stderrPath])await writeFile(path,'',{mode:0o600,flag:'wx'});
 const guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700,flag:'wx'});
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');
 supplier=createServer((req,res)=>{void(async()=>{
  assert.equal(req.url,'/anthropic/v1/messages');assert.equal(req.headers['x-api-key'],'synthetic-only');
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),background=Boolean(body.tools?.some(tool=>tool.name==='DirectMemoryExtractionOutput'));
  assert.equal(body.model,normal.model.model);assert.equal(body.max_tokens,normal.model.maxTokens);
  requests.push({background,body});
  if(background){backgroundArrived.release(body);await releaseBackground.promise;respond(res,body.model,'DirectMemoryExtractionOutput',{scenes:[]});}
  else{assert.ok(!body.tools?.length);foregroundArrived.release(body);await releaseForeground.promise;respond(res,body.model,null,{candidates:[{parts:['合成甲周一见。'],basis:[1]}]});}
 })().catch(error=>{supplierErrors.push(error.message);res.destroy();});});
 supplier.listen(0,'127.0.0.1');await once(supplier,'listening',{signal:AbortSignal.timeout(2000)});
 host=await launchDsh({nodeExecutable:wrapper,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,environment:{NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${supplier.address().port}`,NOTALONE_SYNTHETIC_NETWORK_AUDIT:auditPath},sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','discussions','memory']}},()=>true);
 try{info=await changed(dirname(infoPath),async()=>Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];})),value=>Boolean(value.address&&value.token),'正式profile握手');}
 catch(error){throw new Error(`${error.message}; ${(await readFile(stderrPath,'utf8')).slice(-1800)}`);}
 const launch=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8'));
 assert.equal(await readFile(join(launch.home,'profiles/notalone/cordis.patch.yml'),'utf8'),(await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8')).replace('PLUGIN_PATH',JSON.stringify(resolve('src/sqlite-host-plugin.ts'))));
 const status=await api('/api/runtime/status');assert.equal(status.data.runtime,'dsh');assert.equal(status.data.storage,'sqlite');
 const started=await api(`/api/memory-processing/contacts/${backContact}/history`,{body:{request_key:randomUUID()}});assert.equal(started.status,200,JSON.stringify(started.data));
 let background;try{background=await backgroundArrived.wait();}catch(error){throw new Error(`${error.message}; ${JSON.stringify({started:started.data,current:(await api('/api/memory-processing/runs/current')).data,trace:(await api(`/api/memory-processing/tasks/${started.data.run.tasks[0].taskId}/events`)).data.events?.filter(event=>event.kind==='model_failure'),supplierErrors,audit:await readFile(auditPath,'utf8'),stderr:(await readFile(stderrPath,'utf8')).slice(-2200)})}`);}
 const created=await api(`/api/contacts/${frontContact}/assistant-sessions`,{body:{}});assert.equal(created.status,200,JSON.stringify(created.data));
 const sessionId=created.data.session_id,path=`/api/contacts/${frontContact}/assistant-sessions/${sessionId}/reply-candidates`;
 const requestStartedAt=performance.now();
 const generatedPromise=api(path,{body:{request_key:randomUUID(),text:'请回应合成甲下周见面。',confirmed_contact:true}});void generatedPromise.catch(()=>{});
 const foreground=await foregroundArrived.wait(),heldArrivalMs=performance.now()-requestStartedAt;
 assert.equal(requests.length,2,'后台尚未结算时前台实际已到供应商');
 assert.deepEqual(requests.map(request=>request.background),[true,false]);
 const wire=JSON.stringify(foreground);assert.ok(wire.includes(frontText));assert.ok(!wire.includes(backText));assert.ok(!wire.includes(image.id));assert.ok(!wire.includes(png.toString('base64')));
 const content=background.messages.find(message=>message.role==='user').content,payload=JSON.parse(content.find(block=>block.type==='text').text);
 assert.deepEqual(new Set(payload.messages.map(message=>message.message_id)),new Set(backMessages.map(message=>message.id)));
 assert.ok(payload.messages.some(message=>message.text===backText));assert.ok(!JSON.stringify(payload).includes(frontText));assert.ok(frontMessages.every(message=>!JSON.stringify(payload).includes(message.id)));
 assert.equal(payload.messages.find(message=>message.message_id===image.id).image_id,file.fileId);
 const images=content.filter(block=>block.type==='image');assert.equal(images.length,1);assert.equal(images[0].source.type,'base64');assert.equal(images[0].source.data,png.toString('base64'));
 const permits=await readdir(join(root,'model-permits'));assert.equal(permits.length,1,'图文背景和前台只有一个模型宿主');
 const journal=JSON.parse(await readFile(join(root,'model-permits',permits[0],'state.json'),'utf8'));
 assert.deepEqual(journal.active.map(permit=>permit.kind).sort(),['background','foreground']);
 releaseForeground.release();const generated=await generatedPromise;assert.equal(generated.status,200,JSON.stringify(generated.data));
 const viewed=await api(path);assert.equal(viewed.status,200);const request=viewed.data.requests[0];assert.deepEqual(request.candidates[0].parts,['合成甲周一见。']);assert.ok(request.candidates[0].basis.some(basis=>basis.text.includes(frontText)));
 releaseBackground.release();
 const run=await changed(join(root,'managed/sqlite/notalone.sqlite-wal'),()=>api(`/api/memory-processing/runs/${started.data.run.runId}`),value=>value.status!==200||value.data.tasks.some(task=>task.scopeKind==='contact'&&['succeeded','failed','unknown'].includes(task.state)),'后台图文任务结算');
 assert.equal(run.status,200);const task=run.data.tasks.find(task=>task.scopeKind==='contact');assert.equal(task.contactId,backContact);assert.equal(task.state,'succeeded',JSON.stringify(task));
 const trace=(await api(`/api/memory-processing/tasks/${task.taskId}/events`)).data;
 assert.equal(trace.calls.length,1);assert.equal(trace.calls[0].purpose,'extraction');assert.equal(trace.calls[0].state,'succeeded');
 assert.ok(trace.events.some(event=>event.kind==='image_inputs'&&event.payload.images.some(manifest=>manifest.id===file.fileId)));
 assert.ok(trace.events.every(event=>event.sources.every(source=>source.contactId===backContact&&backMessages.some(message=>message.sourceRecordIds.includes(source.recordId)))));
 assert.deepEqual(new Set(trace.events.flatMap(event=>event.sources.map(source=>source.recordId))),new Set(backMessages.flatMap(message=>message.sourceRecordIds)));
 assert.deepEqual(supplierErrors,[]);
 const shutdown=await api('/api/runtime/shutdown',{method:'POST'});assert.equal(shutdown.status,200);assert.equal(await host.waitForExit(5000),true);
 reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:new URL('./fixtures/sqlite-reply-background-concurrency-store.mjs',import.meta.url).href});
 assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 const frontTrace=await new SqliteDiscussionService(reopened,owner).trace(frontContact,sessionId,request.requestId);assert.equal(frontTrace.calls.length,1);assert.equal(frontTrace.calls[0].state,'succeeded');
 const ledger=await reopened.execute('fixture.replyBackgroundConcurrencyEvidence',{ownerId:owner});assert.equal(ledger.length,2);
 assert.deepEqual(ledger.map(call=>[call.purpose,call.contactId]).sort(),[['discussion',frontContact],['extraction',backContact]].sort());
 assert.equal(new Set(journal.active.map(permit=>permit.id)).size,2);assert.equal(new Set(ledger.map(call=>call.id)).size,2);
 for(const call of ledger){assert.equal(call.state,'succeeded');assert.equal(call.settlement,'settled');assert.equal(call.provider,normal.model.provider);assert.equal(call.model,normal.model.model);assert.ok((call.receipt.input_budget??call.receipt.inputBudget).serialized_bytes>0);}
 const frontCall=ledger.find(call=>call.purpose==='discussion'),backCall=ledger.find(call=>call.purpose==='extraction');
 assert.equal(frontCall.id,frontTrace.calls[0].id);assert.equal(backCall.id,trace.calls[0].callId);assert.notEqual(frontCall.receipt.inputBudget.request_sha256,backCall.receipt.input_budget.request_sha256);assert.equal(backCall.receipt.permit_id,journal.active.find(permit=>permit.kind==='background').id);assert.equal(frontCall.stepAttemptId,null);assert.equal(backCall.replyAttemptId,null);
 const audit=(await readFile(auditPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(audit.length,2);assert.ok(audit.every(item=>item.kind==='redirect'&&item.syntheticAuthentication));
 t.diagnostic(JSON.stringify({foregroundSupplierArrivalWhileBackgroundHeldMs:Number(heldArrivalMs.toFixed(3)),backgroundCapacity:1,ledgerCalls:2,note:'实测诊断值，不构成性能保证；背景保持未结算直至前台先完成。'}));
});
