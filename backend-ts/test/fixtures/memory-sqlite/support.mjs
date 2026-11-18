import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../../../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../../../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../../../src/history/sqlite/service.ts';
export const owner='00000000-0000-4000-8000-000000000001';
const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
export const record=(id,extra={})=>({partition:'shard-a',table:'table-instance-1',localId:id,serverId:'0',sender:'contact',kind:'text',text:`合成正文${id}`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',...extra});
export async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-history-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',...options});
 // 关闭后偶有晚到的媒体写入使 rmdir 报 ENOTEMPTY（并发或机器繁忙时出现）；清理只重试，不改变任何断言。
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 // 产品默认关闭记忆自动处理；本夹具验证提取与调度行为，创建后明确开启。开关本身由专门用例覆盖。
 if(storage.status.schemaVersion<42){
  // 迁移 42 之前的旧结构夹具没有开关列（正式库总是先迁移再打开）；按开关出现前的行为让旧结构上的提取照常运行。
  const execute=storage.execute.bind(storage);
  storage.execute=(name,input,...rest)=>name==='memoryExtraction.readAutomatic'?Promise.resolve({enabled:true}):execute(name,input,...rest);
 }else if(options.automatic!==false)await storage.execute('memoryExtraction.setAutomatic',{enabled:true});
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{externalKey:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(storage,owner,metadata);await contacts.initialize();
 const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);
 const saved=await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const target={protocol:'private-history-v1',descriptor:'fixed-synthetic-target',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'};
 const channel={inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),target:async()=>target,page:async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('9007199254740993'),record('2',{kind:'voice',text:'不应保存媒体转写'})],completedPartitions:['shard-a'],exhausted:true})};
 const service=new SqliteHistoryService(storage,contacts,channel);
 return {storage,contacts,channel,service,saved:saved.bindings,target,root};
}
export function modelPort(accounting,respond=async request=>({blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]})){
 let calls=0;
 return {close:async()=>{},get calls(){return calls;},prepare:async(_r,i)=>{await i.requireCurrent();return {provider:'synthetic',model:'synthetic',configurationId:'synthetic-v1',maxInputTokens:100000,maxOutputTokens:16,contextWindowTokens:100100,safetyMarginTokens:16};},
 async invoke(request,i){
  const {randomUUID,createHash}=await import('node:crypto');
  await i.requireCurrent();const receipt={attempt_id:i.attemptId,permit_id:randomUUID(),request_id:i.requestId,...i.scope,...(i.scope.contact_id===null?{scope_kind:'owner_memory'}:{}),provider:'synthetic',model:'synthetic',called_at:new Date().toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null},input_budget:{measurement_id:'synthetic-measurement',measurement_kind:'approximate',input_tokens:10,max_output_tokens:16,context_window_tokens:100100,safety_margin_tokens:16,request_sha256:createHash('sha256').update(request.user).digest('hex'),serialized_bytes:Buffer.byteLength(request.user)}};
  await accounting().reserve(receipt,i.claim);calls++;
  const result=await respond(request,i);
  const settled={...receipt,dispatch:'response_observed',outcome:'succeeded',latency_ms:1,usage:{input_tokens:10,output_tokens:1,cache_read_tokens:null,cache_write_tokens:null}};
  await i.onReceipt(settled);await accounting().recordReserved(settled);return result;
 }};
}
