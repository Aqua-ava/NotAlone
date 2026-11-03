import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

let loaded,owned;
after(async()=>{if(owned)await rm(owned,{recursive:true,force:true});});
function modules(){return loaded??=(async()=>{
 owned=await mkdtemp(join(tmpdir(),'notalone-reply-candidate-bridge-'));const outfile=join(owned,'bridge.mjs');
 await build({stdin:{contents:"export * from './src/main/reply/sqlite-discussion-bridge';export * from './src/preload/sqlite-discussion';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});
 return import(pathToFileURL(outfile).href);
})();}
const ids={contact:'11111111-1111-4111-8111-111111111111',other:'22222222-2222-4222-8222-222222222222',session:'33333333-3333-4333-8333-333333333333',candidate:'44444444-4444-4444-8444-444444444444',request:'55555555-5555-4555-8555-555555555555',selection:'66666666-6666-4666-8666-666666666666',skill:'77777777-7777-4777-8777-777777777777',message:'88888888-8888-4888-8888-888888888888'};
const scope={contactId:ids.contact,scopeRevision:1,sessionId:ids.session};
const version=()=>({candidateId:ids.candidate,versionNo:1,origin:'model',parentVersionNo:null,parts:['合成候选第一条','合成候选第二条'],basis:[{itemNo:1,kind:'message',text:'合成同联系人依据',verification:'actual_input'}]});
const pageData=()=>({requests:[{requestId:ids.request,generationState:'committed',coverageWarning:null,sourceState:'available',candidates:[version()],selections:[],loadedSkills:[{packageId:ids.skill,revisionNo:1,relativePath:'SKILL.md',text:'合成实际载入Skill正文'}]}],recentMessages:[{messageId:ids.message,sender:'contact',text:'合成最近聊天',occurredAt:'2026-10-31T10:00:00.000Z',timePrecision:'second',displayPosition:'2',ordering:'unknown'}],coverage:{phase:'complete'}});
function fixture(api){
 let generation=3,selected=ids.contact,scopeRevision=1,confirmed=true;const contactListeners=new Set(),backendListeners=new Set(),requests=[],handlers=new Map(),invocations=[];
 let respond=async()=>({generation,data:pageData()});
 const backend={getConnectionGeneration:()=>generation,onStateChanged:fn=>{backendListeners.add(fn);return()=>backendListeners.delete(fn);},requestJson:request=>{requests.push(request);return respond(request);}};
 const contacts={getState:()=>({directoryPhase:'ready',selectedContactId:selected,scopeRevision,contacts:[{contactId:ids.contact},{contactId:ids.other}]}),onStateChanged:fn=>{contactListeners.add(fn);return()=>contactListeners.delete(fn);}};
 const controller=api.installSqliteDiscussionBridge({handle:(channel,handler,role)=>{assert.equal(role,'helper');handlers.set(channel,handler);},publish:()=>{}},backend,contacts,()=>confirmed);
 const transport={invoke:async(channel,...args)=>{invocations.push({channel,args});return handlers.get(channel)(...args);},on:()=>{},removeListener:()=>{}};
 const bridge=api.createSqliteDiscussionBridge(transport);
 return {controller,bridge,handlers,requests,invocations,respond:fn=>respond=fn,confirm(value,notify=false){confirmed=value;if(notify)controller.synchronize(true);},
  select(){selected=ids.other;++scopeRevision;for(const listener of contactListeners)listener();},
  connection(notify=true){++generation;if(notify)for(const listener of backendListeners)listener();},
 };
}

test('候选preload与主进程将五种操作映射到固定SQLite HTTP路径',{timeout:10000},async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());
 const base=`/api/contacts/${ids.contact}/assistant-sessions/${ids.session}/reply-candidates`;
 f.respond(async request=>({generation:3,data:request.path.endsWith('/edit')?{...version(),versionNo:2,parentVersionNo:1,origin:'manual'}:request.path.endsWith('/select')?{id:ids.selection,candidateId:ids.candidate,versionNo:1,selectionNo:1}:request.path.includes('/versions/')?version():request.method==='POST'?{session_id:ids.session,request_key:ids.request,segmented:false,replayed:false}:pageData()}));
 assert.deepEqual(await f.bridge.candidates.execute({...scope,action:'read'}),pageData());
 const workspace={action:'express',draftText:'本次合成表达要求',tone:'warm',instruction:'简洁些',contextText:'本次补充情况',includeRelationshipContext:true,excludedMessageIds:[ids.message]};
 await f.bridge.candidates.execute({...scope,action:'generate',requestKey:ids.request,text:workspace.draftText,acceptIncomplete:true,workspace});
 assert.equal((await f.bridge.candidates.execute({...scope,action:'edit',candidateId:ids.candidate,versionNo:1,parts:['手改第一条','手改第二条']})).versionNo,2);
 assert.equal((await f.bridge.candidates.execute({...scope,action:'select',candidateId:ids.candidate,versionNo:1})).id,ids.selection);
 assert.deepEqual((await f.bridge.candidates.execute({...scope,action:'version',candidateId:ids.candidate,versionNo:1})).parts,['合成候选第一条','合成候选第二条']);
 assert.deepEqual(f.requests.map(({method,path,body})=>({method,path,body})),[
  {method:'GET',path:base,body:undefined},
  {method:'POST',path:base,body:{request_key:ids.request,text:'本次合成表达要求',confirmed_contact:true,accept_incomplete:true,workspace}},
  {method:'POST',path:`${base}/${ids.candidate}/edit`,body:{version_no:1,parts:['手改第一条','手改第二条']}},
  {method:'POST',path:`${base}/${ids.candidate}/select`,body:{version_no:1}},
  {method:'GET',path:`${base}/${ids.candidate}/versions/1`,body:undefined},
 ]);
 assert.equal(f.invocations.every(call=>call.channel==='sqlite-reply-candidates:execute'),true);
 assert.equal(f.requests.every(request=>request.path.startsWith(base)&&request.timeoutMs===120000&&request.maxResponseBytes===2_000_000),true);
});

test('preload及主进程均拒绝通用owner、路径、SQL字段和额外参数',async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());const read={...scope,action:'read'},handler=f.handlers.get('sqlite-reply-candidates:execute');
 for(const extra of [{ownerId:ids.other},{owner_id:ids.other},{path:'/api/other'},{sql:'SELECT synthetic_secret'},{body:{text:'不应转发'}},{action:'send'}]){
  await assert.rejects(f.bridge.candidates.execute({...read,...extra}),/无效/);
  await assert.rejects(handler({...read,...extra}),/无效/);
 }
 await assert.rejects(f.bridge.candidates.execute(read,'extra'),/无效/);await assert.rejects(handler(read,'extra'),/无效/);
 const workspace={action:'suggest',draftText:'',tone:'original',instruction:'',contextText:'',includeRelationshipContext:false,excludedMessageIds:[]};
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'generate',requestKey:ids.request,text:'伪造的既定立场',acceptIncomplete:false,workspace}),/无效/);
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'generate',requestKey:ids.request,text:'',acceptIncomplete:false,workspace:{...workspace,tone:'firm'}}),/无效/);
 await assert.rejects(f.bridge.candidates.execute({...read,contactId:ids.other}),/失效/);
 assert.equal(f.requests.length,0);assert.equal(f.invocations.length,1,'只有格式合法但范围错误的请求可到达主进程');
});

test('联系人、连接换代或显式来源失效均取消在途候选读取并拒绝迟到正文',async()=>{
 const api=await modules();
 for(const invalidate of [f=>f.select(),f=>f.connection(),f=>f.controller.synchronize(true)]){
  const f=fixture(api),gate=Promise.withResolvers();f.respond(()=>gate.promise);
  const pending=f.bridge.candidates.execute({...scope,action:'read'}),rejected=assert.rejects(pending,error=>/失效/.test(error.message)&&!error.message.includes('合成候选正文'));
  assert.equal(f.requests.length,1);invalidate(f);assert.equal(f.requests[0].signal.aborted,true);
  gate.resolve({generation:3,data:pageData()});await rejected;f.controller.close();
 }
 const f=fixture(api),gate=Promise.withResolvers();f.respond(()=>gate.promise);
 const pending=f.bridge.candidates.execute({...scope,action:'read'}),rejected=assert.rejects(pending,/失效/);
 f.connection(false);gate.resolve({generation:3,data:pageData()});await rejected;f.controller.close();
});

test('已知失败按安全中文状态映射，未知错误不将供应商正文带入IPC',async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());
 const input={...scope,action:'generate',requestKey:ids.request,text:'仅用于本次的合成要求',acceptIncomplete:false};
 for(const [code,expected] of [
  ['reply_history_syncing','历史状态已变化，请重新读取当前会话后重试。'],
  ['reply_history_incomplete','历史状态已变化，请重新读取当前会话后重试。'],
  ['reply_model_unavailable','现有模型配置尚未就绪。'],
  ['discussion_call_unknown','已有模型调用结果未知，请先核对原请求，不能换请求重发。'],
  ['discussion_request_conflict','本次输入或设置已改变，请用新请求重新生成。'],
  ['reply_input_invalid','本次工作区设置无效，请检查本次想法和背景内容。'],
  ['reply_input_stale','资料版本已变化，请重新读取。'],
  ['reply_source_unavailable','本次候选来源已失效，请重新读取。'],
  ['skill_run_invalidated','本次Skill资格已失效，请重新读取。'],
  ['history_source_not_available','本次候选来源已失效，请重新读取。'],
  ['synthetic_provider_unknown','候选结果尚未确认，请保留原请求重试核对。'],
 ]){
  f.respond(async()=>{throw Object.assign(new Error('合成供应商私密正文与诊断'),{code});});
  await assert.rejects(f.bridge.candidates.execute(input),error=>{assert.equal(error.message,expected);assert.equal(error.message.includes('供应商'),false);assert.equal(error.message.includes('私密正文'),false);return true;});
 }
 assert.equal(f.requests.every(request=>request.body.request_key===ids.request),true);
});

test('最近聊天投影只接受当前联系人范围内的有限文字材料',async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());
 f.respond(async()=>({generation:3,data:{...pageData(),recentMessages:[{messageId:ids.message,sender:'other',text:'越权联系人消息',occurredAt:null,timePrecision:null,displayPosition:'1',ordering:'unknown'}]}}));
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'read'}),/候选结果尚未确认/);assert.equal(f.requests.length,1);
});


test('前台确认失效时主进程拒绝候选操作并撤销在途读取，不能仅靠页面按钮门禁',async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());f.confirm(false);
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'read'}),/请先确认本次联系人/);assert.equal(f.requests.length,0);
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'generate',requestKey:ids.request,text:'不能绕过当前确认',acceptIncomplete:false}),/请先确认本次联系人/);assert.equal(f.requests.length,0);
 f.confirm(true);const gate=Promise.withResolvers();f.respond(()=>gate.promise);const pending=f.bridge.candidates.execute({...scope,action:'read'}),rejected=assert.rejects(pending,/请先确认本次联系人/);
 f.confirm(false,true);assert.equal(f.requests[0].signal.aborted,true);gate.resolve({generation:3,data:pageData()});await rejected;
});


test('候选状态沿固定只读路径返回无正文进度，拒绝夹带私密字段',async t=>{
 const f=fixture(await modules());t.after(()=>f.controller.close());
 const status={requestKey:ids.request,phase:'preparing',sent:false,errorCode:null,retryable:false,startedAt:1000,finishedAt:null};
 f.respond(async()=>({generation:3,data:status}));
 assert.deepEqual(await f.bridge.candidates.execute({...scope,action:'status',requestKey:ids.request}),status);
 assert.equal(f.requests[0].method,'GET');
 assert.equal(f.requests[0].path,`/api/contacts/${ids.contact}/assistant-sessions/${ids.session}/reply-candidates/status?request_key=${ids.request}`);
 assert.equal(f.requests[0].timeoutMs,8000);assert.equal(f.requests[0].maxResponseBytes,4096);
 f.respond(async()=>({generation:3,data:{...status,text:'不应进入IPC的合成私密正文'}}));
 await assert.rejects(f.bridge.candidates.execute({...scope,action:'status',requestKey:ids.request}),/候选结果尚未确认/);
});
