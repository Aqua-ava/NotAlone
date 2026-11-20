import test from 'node:test';
import assert from 'node:assert/strict';
import {watch} from 'node:fs';
import {access,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchDsh} from '../src/launch.ts';
import {waitForHostReady} from './host-readiness-support.mjs';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';

/** 异步日志独立于业务响应；等候实际文件事件，不把返回200误当成已刷盘。 */
function diagnosticRecordsWhen(root,accept){
 return new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;
  const finish=(error,rows)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();error?reject(error):resolveValue(rows);};
  const load=async()=>{
   if(ended)return;if(running){dirty=true;return;}running=true;
   try{const rows=await readDiagnosticRecords(root);if(accept(rows))finish(null,rows);}catch(error){finish(error);}
   finally{running=false;if(dirty&&!ended){dirty=false;void load();}}
  };
  const watcher=watch(join(root,'logs'),()=>{void load();}),timer=setTimeout(()=>finish(new Error('正式profile诊断刷盘超时')),2000);
  void load();
 });
}
const diagnosticTrace='94444444-4444-4444-8444-444444444444';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

test('正式SQLite profile经共享模型和认证HTTP生成编辑选稿，双联系人隔离且重开回看不调用供应商',{timeout:30000},async t=>{
 const cleanups=[];let host,info,supplier,reopened;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root;
 const infoPath=join(root,'managed/sqlite-backend.info'),envFilePath=join(root,'synthetic.env');
 const auditPath=join(root,'synthetic-network.jsonl'),stderrPath=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 const socketIdentity=createHash('sha256').update(JSON.stringify([resolve(infoPath),resolve(envFilePath)])).digest('hex').slice(0,24);
 const socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${socketIdentity}`);
 const api=async(route,{body,method=body===undefined?'GET':'POST',auth=true,trace=diagnosticTrace}={})=>{
  const response=await fetch(`http://${info.address}${route}`,{method,headers:auth?{Authorization:`Bearer ${info.token}`,'X-Trace-Id':trace}:{},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,data:await response.json()};
 };
 t.after(async()=>{
  if(host?.isRunning()){
   if(info)await api('/api/runtime/shutdown',{method:'POST'}).catch(()=>{});
   if(!await host.waitForExit(5000))assert.equal(await host.terminate(),true,'只终止本轮自有profile子进程');
  }
  assert.ok(!host?.isRunning());await reopened?.close();
  if(supplier?.listening){const closed=once(supplier,'close',{signal:AbortSignal.timeout(2000)});supplier.closeAllConnections();supplier.close();await closed;}
  await f.service.close();await f.contacts.close();
  await assert.rejects(access(socketDirectory),error=>error.code==='ENOENT','共享模型socket必须真实释放后才清测试目录');
  for(const cleanup of cleanups.reverse())await cleanup();
  await assert.rejects(access(root),error=>error.code==='ENOENT');
 });
 const ids=f.saved.map(binding=>binding.contact_id),texts=['我长期喜欢合成园艺。','合成乙已确认周末休息。'];
 const memoryText='正式L1工具专有正文：合成园艺需要先确认月季的养护安排。';
 await f.contacts.setReading(true);
 f.channel.page=async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1',{text:texts[ids.indexOf(scope.token.contact_id)]}),record('2',{kind:'voice',text:'媒体占位不得作为正文输入'})],completedPartitions:['shard-a'],exhausted:true});
 for(const id of ids){await f.service.synchronize(id);assert.equal((await f.service.coverage(id)).phase,'complete');}
 await new SqliteMemoryManagement(f.storage,owner).decide({requestKey:'profile-on-demand-memory',action:'manual',scope:{scopeKind:'contact',contactId:ids[0]},body:memoryText});
 await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
 await f.service.close();await f.contacts.close();await f.storage.close();
 // 只提供合成认证；模型、预算、用途与官方供应商地址保持正常配置。
 for(const [path,text] of [[envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'],[auditPath,''],[stderrPath,'']])await writeFile(path,text,{mode:0o600,flag:'wx'});
 const guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700,flag:'wx'});
 const requests=[],supplierErrors=[],output=JSON.stringify({candidates:[{parts:['合成正式候选','第二条'],basis:[1]}]});
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');
 supplier=createServer((req,res)=>{void(async()=>{
  assert.equal(req.url,'/anthropic/v1/messages');assert.equal(req.headers['x-api-key'],'synthetic-only');
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
  assert.equal(body.model,normal.model.model);assert.equal(body.max_tokens,normal.model.maxTokens);
  if(requests.length===1){
   assert.deepEqual(body.tools.map(tool=>tool.name).sort(),['search_relationship_history','search_relationship_memory']);
   const wire=JSON.stringify(body);assert.ok(!wire.includes(memoryText));
   const events=[{type:'message_start',message:{id:randomUUID(),model:body.model,usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'search_relationship_memory',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({query:'园艺'})}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
   res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));return;
  }
  if(requests.length===2)assert.ok(JSON.stringify(body).includes(memoryText));
  else{assert.deepEqual(body.tools.map(tool=>tool.name).sort(),['search_relationship_history','search_relationship_memory']);assert.ok(!JSON.stringify(body).includes(memoryText));}
  const bodyOutput=requests.length===2?JSON.stringify({candidates:[{parts:['合成正式候选','第二条'],basis:[Number(JSON.stringify(body).match(/实际输入材料\[(\d+)\] memory/)[1])]}]}):output;
  const events=[{type:'message_start',message:{id:randomUUID(),type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:bodyOutput}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
  res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 })().catch(error=>{supplierErrors.push(error.message);res.destroy();});});
 supplier.listen(0,'127.0.0.1');await once(supplier,'listening',{signal:AbortSignal.timeout(2000)});
 const start=async()=>{
  host=await launchDsh({nodeExecutable:wrapper,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,
   environment:{NOTALONE_DIAGNOSTIC_ROOT:root,NOTALONE_DIAGNOSTIC_LEVEL:'debug',NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${supplier.address().port}`,NOTALONE_SYNTHETIC_NETWORK_AUDIT:auditPath},
   sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','discussions']}},()=>true);
  try{info=await waitForHostReady(host,infoPath);}catch(error){throw new Error(`${error.message}; ${(await readFile(stderrPath,'utf8')).slice(-1600)}`);}
  const launch=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8'));
  const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
  assert.equal(await readFile(join(launch.home,'profiles/notalone/cordis.patch.yml'),'utf8'),official.replace('PLUGIN_PATH',JSON.stringify(resolve('src/sqlite-host-plugin.ts'))));
  return launch.home;
 };
 const stop=async home=>{
  const stopped=await api('/api/runtime/shutdown',{method:'POST'});assert.equal(stopped.status,200);assert.equal(stopped.data.state,'stopped');
  assert.equal(await host.waitForExit(5000),true);assert.equal(host.isRunning(),false);
  for(const path of [infoPath,infoPath+'.dsh-lock',home,socketDirectory])await assert.rejects(access(path),error=>error.code==='ENOENT');
 };
 let home=await start();
 const state=await api('/api/runtime/status');assert.equal(state.status,200);assert.equal(state.data.storage,'sqlite');assert.equal(state.data.ownership.discussions,'typescript');
 const ledgerTrace=randomUUID();assert.equal((await api('/api/ledger/summary',{trace:ledgerTrace})).status,200);
 assert.equal((await api('/api/ledger/summary',{trace:'synthetic-private-trace'})).status,200,'原未包裹路由仍保留既有响应，非法头不进入诊断');
 const paths=[],sessionIds=[],versions=[];
 for(const [index,id] of ids.entries()){
  const created=await api(`/api/contacts/${id}/assistant-sessions`,{body:{}});assert.equal(created.status,200,JSON.stringify(created.data));sessionIds.push(created.data.session_id);
  const path=`/api/contacts/${id}/assistant-sessions/${created.data.session_id}/reply-candidates`;paths.push(path);
  assert.equal((await api(path,{auth:false})).status,401);
  const text=index?'帮我回应合成乙。':'帮我回应合成甲。';
  const request={request_key:randomUUID(),text,confirmed_contact:true,workspace:{action:'express',draftText:text,contextText:'',includeRelationshipContext:true}};
  const generated=await api(path,{body:request});assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(generated.data.session_id,created.data.session_id);
  const records=await diagnosticRecordsWhen(root,rows=>rows.some(row=>row.event==='reply.state_changed'&&row.traceId===diagnosticTrace&&row.toState==='completed')&&rows.some(row=>row.event==='sql.summary'&&row.traceId===ledgerTrace));
  const phases=records.filter(row=>row.event==='reply.state_changed'&&row.traceId===diagnosticTrace);
  for(const phase of ['queued','generating','saving','completed'])assert.ok(phases.some(row=>row.toState===phase),`正常profile缺少${phase}诊断`);
  assert.ok(records.some(row=>row.event==='sql.summary'&&row.traceId===ledgerTrace),'正常未包裹域的认证HTTP须把合法trace传入真实SQLite');assert.doesNotMatch(JSON.stringify(records),/synthetic-private-trace/);
  const discussion=await api(`/api/contacts/${id}/assistant-sessions/${created.data.session_id}`);
  assert.equal(discussion.data.runtime_recovery,'unchecked');
  assert.deepEqual(discussion.data.entries.map(entry=>entry.role),['user']);
  const read=await api(path);assert.equal(read.status,200);assert.equal(read.data.requests.length,1);
  const version=read.data.requests[0].candidates[0];versions.push({requestId:read.data.requests[0].requestId,...version});
  assert.equal(version.versionNo,1);assert.deepEqual(version.parts,['合成正式候选','第二条']);assert.equal(version.basis[0].verification,'actual_input');assert.ok(version.basis[0].text.includes(index?texts[index]:memoryText));
  const wire=JSON.stringify(requests[index?2:0]);assert.ok(wire.includes(texts[index]));assert.ok(!wire.includes(texts[1-index]));assert.ok(!wire.includes('媒体占位不得作为正文输入'));
  assert.equal((await api(path,{body:request})).data.replayed,true);assert.equal(requests.length,index+2);
 }
 const first=versions[0],edited=await api(`${paths[0]}/${first.candidateId}/edit`,{body:{version_no:1,parts:['我修改后的合成正式候选','第二条仍保留']}});
 assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.versionNo,2);assert.equal(edited.data.parentVersionNo,1);assert.equal(edited.data.basis[0].verification,'inherited_unverified');
 const chosen=await api(`${paths[0]}/${first.candidateId}/select`,{body:{version_no:2}});assert.equal(chosen.status,200);assert.equal(chosen.data.versionNo,2);
 const original=await api(`${paths[0]}/${first.candidateId}/versions/1`);assert.deepEqual(original.data.parts,first.parts);
 assert.equal((await api(`${paths[1]}/${first.candidateId}/versions/1`)).status,409);
 assert.equal((await api(`${paths[1]}/${first.candidateId}/select`,{body:{version_no:2}})).status,409);
 assert.equal(requests.length,3);assert.deepEqual(supplierErrors,[]);
 assert.equal((await readdir(join(root,'model-permits'))).length,1,'正常profile仅有一个共享模型宿主');
 await stop(home);home=await start();
 for(const [index,path] of paths.entries()){
  const reopenedView=await api(path);assert.equal(reopenedView.status,200);const row=reopenedView.data.requests[0];
  assert.equal(row.requestId,versions[index].requestId);assert.equal(row.candidates[0].versionNo,index===0?2:1);
  if(index===0){assert.deepEqual(row.candidates[0].parts,edited.data.parts);assert.equal(row.selections.at(-1).id,chosen.data.id);assert.equal(row.selections.at(-1).versionNo,2);}
 }
 assert.equal(requests.length,3,'重开回看不发起模型调用');
 await stop(home);
 const audit=(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 assert.equal(audit.length,3);assert.ok(audit.every(item=>item.kind==='redirect'&&item.syntheticAuthentication&&item.officialPath==='/anthropic/v1/messages'));
 reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});
 assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 const discussions=new SqliteDiscussionService(reopened,owner);
 for(const [index,version] of versions.entries()){
  const trace=await discussions.trace(ids[index],sessionIds[index],version.requestId);assert.equal(trace.calls.length,index?1:2);assert.equal(trace.calls[0].state,'succeeded');
  assert.ok(trace.events.some(event=>event.kind==='model_request'));assert.ok(trace.events.some(event=>event.kind==='assistant_message'));
 }
});
