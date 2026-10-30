import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,realpath,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Llm from '@deepseek-ai/dsh-llm';
import Skills from '@deepseek-ai/dsh-skill';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {SqliteStorage} from '../../../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../../../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../../../src/history/sqlite/service.ts';
import {SqliteSkillLibrary} from '../../../src/skills/sqlite/library.ts';
import {SqliteDiscussionService} from '../../../src/reply/sqlite/service.ts';
import {SqliteDiscussionRuntime} from '../../../src/reply/sqlite/runtime.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {installModelProvider} from '../../../src/platform/models/model-provider.ts';
import {ModelPermitArbiter} from '../../../src/platform/models/model-permits.ts';

export const owner='00000000-0000-4000-8000-000000000001';
const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};

/** 仅外部渠道和供应商使用合成边界；存储、来源、DSH与预算沿真实实现。 */
export async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-reply-candidates-')));
 let storage,runtime,provider,history,ctx,server,closing;
 const close=()=>closing??=(async()=>{
  await history?.close();
  await runtime?.close();
  await provider?.dispose();
  await ctx?.fiber.dispose();
  if(server?.listening){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  await storage?.close();
  await rm(root,{recursive:true,force:true});
 })();
 t.after(close);
 // 默认正式注册表；知识消费者测试可显式替换外部发布者边界。
 storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',...(options.registryModule?{registryModule:options.registryModule}:{})});
 const metadata={
  account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),
  sessions:async()=>['a','b'].map((externalKey,index)=>({externalKey,displayName:index?'合成乙':'合成甲',kind:'private',identityAssurance:'verified'})),
 };
 const contacts=new SqliteContactService(storage,owner,metadata);
 await contacts.initialize();
 await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snapshot=await contacts.candidates(true);
 await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(session=>({locator:session.username,observed_display_name:session.display_name,expected_selection_generation:session.selection_generation})));
 const ids=(await contacts.directory()).contacts.map(contact=>contact.contact_id);
 const holders=new ActiveHolders();
 const channel={
  inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),
  target:async scope=>({protocol:'private-history-v1',descriptor:`synthetic-target-${scope.conversationKey}`,partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'}),
  page:async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:`合成会话${scope.conversationKey}的已保存聊天`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['shard-a'],exhausted:true}),
 };
 history=new SqliteHistoryService(storage,contacts,channel,holders);
 if(options.synchronizeHistory!==false){
  await contacts.setReading(true);
  for(const contactId of ids)await history.synchronize(contactId);
 }
 const messages=await Promise.all(ids.map(async contactId=>(await history.read(contactId)).messages));
 ctx=new Context();
 await ctx.plugin(Loader);await ctx.plugin(Llm);await ctx.plugin(Skills);
 const requests=[],supplierErrors=[];
 server=createServer((req,res)=>{void (async()=>{
  let body='';for await(const part of req)body+=part;
  const request=JSON.parse(body);requests.push(request);
  if(options.onRequest&&await options.onRequest(req,res,request,requests.length)===true)return;
  const content=typeof options.content==='function'?await options.content(request,requests.length):options.content??`实际环回返回的合成候选${requests.length}`;
  if(typeof content!=='string')throw new TypeError('合成供应商正文必须是字符串');
  const events=[
   {type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},
   {type:'message_stop'},
  ];
  res.setHeader('content-type','text/event-stream');
  res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 })().catch(error=>{supplierErrors.push(error);res.destroy(error);});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 provider=installModelProvider(ctx,{provider:'synthetic-official',connection:resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});
 const model={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off',physical_limit:1,deadline_ms:5000,warning_ratio:0.8,budgetProfile:{context_window_tokens:8192,safety_margin_tokens:512}};
 const skillRoot=join(root,'user-skills');await mkdir(skillRoot,{mode:0o700});
 const discussions=new SqliteDiscussionService(storage,owner,options.clock??Date.now);
 runtime=new SqliteDiscussionRuntime({storage,ownerId:owner,userData:root,ctx,holders,fault:options.runtimeFault});await runtime.initialize();
 const arbiter=new ModelPermitArbiter(),library=new SqliteSkillLibrary(storage,owner,skillRoot);
 return {root,storage,contacts,ids,discussions,runtime,model,provider,arbiter,library,requests,owner,ctx,holders,history,channel,messages,skillRoot,supplierErrors,close};
}
