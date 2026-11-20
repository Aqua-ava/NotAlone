import {modelToolResponse,modelTextResponse} from './fixtures/model-tool-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,realpath,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Llm from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {createDshRuntime} from '../src/reply/sqlite/dsh-runtime.ts';
import {runSingleDiscussionTurn} from '../src/reply/sqlite/generation.ts';

async function fixture(t,reply){
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-generation-')));
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const requests=[],actions=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
  if(reply)return reply(req,res);
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'这是实际环回模型返回的合成讨论发言。'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 const connection=resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}});
 const provider=installModelProvider(ctx,{provider:'synthetic-official',connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});
 const arbiter=new ModelPermitArbiter();let driver,savedBoundary;
 t.after(async()=>{await driver?.close().catch(()=>{});await provider.dispose();await ctx.fiber.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 const attempt={ownerId:'00000000-0000-4000-8000-000000000001',contactId:'contact-synthetic',discussionId:'discussion-synthetic',requestId:'request-synthetic',attemptId:'attempt-synthetic',leaseToken:'lease-synthetic',dataGeneration:0n,discussionGeneration:0n,sourceRevision:0n};
 // 这里只替换SQLite业务合同及RuntimeManager；DSH、Provider、HTTP/SSE和物理文件均为真实实现。
 const storage={execute:async(name,input)=>{actions.push({name,input:structuredClone(input)});return {};}};
 const runtime={run:async(_attempt,_digest,work,signal)=>{
  driver=await createDshRuntime(ctx,{root});
  try{
   const result=await work({copy:{id:'copy-synthetic',eventBoundary:savedBoundary?JSON.stringify(savedBoundary):null},driver,sessionId:SessionId('session-synthetic'),restoring:!!savedBoundary,signal});
   savedBoundary=(await driver.readHistory(SessionId('session-synthetic'))).boundary;return result;
  }
  finally{await driver.close();}
 }};
 const checks=[];const skillProtection={assertCurrent:async(scope,revision)=>{checks.push({scope,revision});},recordSelection:async()=>{},recordInput:async()=>{}};
 const options={kind:'discussion',runtime,storage,attempt,contextId:'context-synthetic',callId:'call-synthetic',configurationDigest:'synthetic-config',prompt:'这是合成用户发言。',systemPrompt:'请围绕已确认联系人讨论，消息由用户亲自发送。',
  model:{provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off',physical_limit:1,deadline_ms:5000,warning_ratio:0.8,budgetProfile:{context_window_tokens:8192,safety_margin_tokens:512}},
  provider,arbiter,skillProtection,skillRevision:{packages:[],eligible:[]},configurationForRevision:()=>'synthetic-config',assertAuthorized:async()=>{}};
 return {options,requests,actions,checks,arbiter,ctx};
}

test('执行壳独占按需Skill，正文载入后可在两次上限内读取声明资源',async t=>{
 const f=await fixture(t,(_req,res)=>{
  const step=f.requests.length,tool=step<4;
  const content=step===1?{type:'tool_use',id:'skill-call',name:'skill',input:{name:'gentle'}}
   :step<4?{type:'tool_use',id:`resource-call-${step}`,name:'skill_resource',input:{name:'gentle',path:'references/guide.md'}}
   :{type:'text',text:'按实际策略生成的合成候选。'};
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:content},{type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });
 const {writeFile}=await import('node:fs/promises');
 const {SqliteStorage}=await import('../src/storage/sqlite/client.ts');
 const {SqliteContactService}=await import('../src/contacts/sqlite/service.ts');
 const {skillAnchor}=await import('../src/skills/sqlite/library.ts'),{TestSkillLibrary}=await import('./fixtures/sqlite-skills/test-library.mjs');
 const {openSqliteSkillRun}=await import('../src/skills/sqlite/provider.ts');
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-auto-skill-'))),original=path.join(home,'originals');
 await mkdir(path.join(original,'gentle','references'),{recursive:true});
 await writeFile(path.join(original,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 安慰时使用的合成沟通方法\n---\n先回应感受，再说明情况。\n');
 await writeFile(path.join(original,'gentle/references/guide.md'),'这是合成 Skill 的补充资料。\n');
 const database=await SqliteStorage.open({userData:home,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/real-registry.mjs',import.meta.url).href});
 t.after(async()=>{await database.close();await rm(home,{recursive:true,force:true});});
 await new SqliteContactService(database,f.options.attempt.ownerId,{account:async()=>{throw Error('不得读取渠道');},sessions:async()=>[]}).initialize();
 const library=new TestSkillLibrary(database,f.options.attempt.ownerId,original);let item=await library.discover('gentle');item=await library.setEnabled(item.id,item.headRevision,'enabled');await database.execute('fixture.grantSkills',{ownerId:f.options.attempt.ownerId,contactId:f.options.attempt.contactId});
 const selections=[],inputs=[],protection={assertCurrent:async(scope,revision)=>{if(revision)await database.execute('skills.assertRun',{ownerId:scope.ownerId,revision});},recordSelection:async(_scope,value)=>{selections.push(value);},recordInput:async value=>{inputs.push(value);}};
 let ownedRun,opened=0;
 f.options.openSkillRun=async()=>{opened++;return ownedRun=await openSqliteSkillRun(library,{contactId:f.options.attempt.contactId,callId:f.options.callId},protection);};
 const group=await library.groupScope(f.options.attempt.contactId);
 f.options.skillProtection=protection;f.options.skillRevision={packages:[{id:item.id,headRevision:item.headRevision}],eligible:[skillAnchor(item)],group:{contactId:f.options.attempt.contactId,groupId:group.groupId,revision:group.revision}};
 Object.freeze(f.options);
 const result=await runSingleDiscussionTurn(f.options);
 assert.equal(opened,1);await assert.rejects(ownedRun.validateQualification(),'执行壳返回前须释放自己创建的Skill运行');
 assert.equal(result.text,'按实际策略生成的合成候选。');assert.equal(f.requests.length,4);
 assert.deepEqual(f.requests[0].tools.map(tool=>tool.name).sort(),['skill','skill_resource']);
 assert.ok(!JSON.stringify(f.requests[0]).includes('先回应感受，再说明情况。'));
 assert.ok(JSON.stringify(f.requests[1]).includes('先回应感受，再说明情况。'));
 assert.equal(inputs.length,3);assert.deepEqual(inputs.map(input=>input.relativePath),['SKILL.md','references/guide.md','references/guide.md']);assert.ok(selections.at(-1));
 assert.equal(f.actions.filter(a=>a.name==='discussion.dispatchCall').length,4);
 assert.equal(f.actions.filter(a=>a.name==='discussion.settleStep').length,4);
});

test('单次讨论经真实官方DSH/Adapter/环回HTTP后只提交真实assistant事件',async t=>{
 const f=await fixture(t);const result=await runSingleDiscussionTurn(f.options);
 assert.equal(result.text,'这是实际环回模型返回的合成讨论发言。');assert.equal(f.requests.length,1);assert.equal((f.requests[0].tools??[]).length,0);
 const dispatch=f.actions.find(a=>a.name==='discussion.dispatchCall');assert.ok(dispatch);
 assert.equal(JSON.stringify(dispatch.input.requestPayload).includes('这是合成用户发言。'),true);assert.equal('signal' in dispatch.input.requestPayload,false);
 assert.ok(dispatch.input.budget.input_tokens>0);assert.equal(dispatch.input.budget.maxTokens,512);
 const commit=f.actions.find(a=>a.name==='discussion.commitAssistant');assert.equal(commit.input.sessionEvent.type,'assistant/message');
 assert.equal(commit.input.sessionEvent.data.message.content.find(b=>b.type==='text').text,result.text);
 assert.equal(f.actions.some(a=>a.name==='discussion.failCall'),false);assert.equal(f.arbiter.snapshot().foregroundActive,false);assert.ok(f.checks.length>0);
});

test('环回HTTP失败只有一次物理调用，保留unknown结算且不提交助手发言',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'合成失败'}}));});
 await assert.rejects(runSingleDiscussionTurn(f.options),{code:'discussion_generation_failed'});
 assert.equal(f.requests.length,1);assert.equal(f.actions.filter(a=>a.name==='discussion.dispatchCall').length,1);
 assert.equal(f.actions.some(a=>a.name==='discussion.commitAssistant'),false);
 assert.equal(f.actions.find(a=>a.name==='discussion.failCall').input.dispatched,true);
 assert.deepEqual(f.actions.find(a=>a.name==='discussion.failCall').input.failure,
  {kind:'error',code:'SERVER',status:500,dispatch:'authorized_unconfirmed'});
 assert.equal(f.arbiter.snapshot().foregroundActive,false);
});

test('真实HTTP流中取消先排空SDK，不伪造完成发言或重试',async t=>{
 const received=Promise.withResolvers();
 const f=await fixture(t,(_req,res)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:1,output_tokens:0}}})+'\n\n');received.resolve();
 });
 const controller=new AbortController();f.options.signal=controller.signal;
 const pending=runSingleDiscussionTurn(f.options);await received.promise;controller.abort();
 await assert.rejects(pending,{code:'discussion_generation_cancelled'});
 assert.equal(f.requests.length,1);assert.equal(f.actions.some(a=>a.name==='discussion.commitAssistant'),false);
 assert.equal(f.actions.find(a=>a.name==='discussion.failCall').input.dispatched,true);assert.equal(f.arbiter.snapshot().foregroundActive,false);
});

test('发送前来源资格拒绝时不调用环回模型，不提交助手发言',async t=>{
 const f=await fixture(t);f.options.skillProtection.assertCurrent=async()=>{throw new Error('合成来源失效');};
 await assert.rejects(runSingleDiscussionTurn(f.options),{code:'discussion_generation_failed'});
 assert.equal(f.requests.length,0);assert.equal(f.actions.some(a=>a.name==='discussion.commitAssistant'),false);
 assert.equal(f.actions.find(a=>a.name==='discussion.failCall').input.dispatched,false);assert.equal(f.arbiter.snapshot().foregroundActive,false);
});

test('真实SQLite Skill库经官方scoped provider载入，选择事实与真实请求输入可区分',async t=>{
 const {writeFile,readFile}=await import('node:fs/promises');
 const {SqliteStorage}=await import('../src/storage/sqlite/client.ts');
 const {SqliteContactService}=await import('../src/contacts/sqlite/service.ts');
 const {skillAnchor}=await import('../src/skills/sqlite/library.ts'),{TestSkillLibrary}=await import('./fixtures/sqlite-skills/test-library.mjs');
 const {openSqliteSkillRun}=await import('../src/skills/sqlite/provider.ts');
 const f=await fixture(t,(_req,res)=>f.requests.length===1?modelToolResponse(res,'skill',{name:'gentle'}):modelTextResponse(res,'使用实际载入方法的合成讨论。'));const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-skill-')));
 const original=path.join(home,'originals');await mkdir(path.join(original,'gentle'),{recursive:true});
 const document='---\nname: gentle\ndescription: 合成沟通方法\n---\n先回应感受，再说明情况。\n';
 const file=path.join(original,'gentle/SKILL.md');await writeFile(file,document);
 const database=await SqliteStorage.open({userData:home,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/real-registry.mjs',import.meta.url).href});
 t.after(async()=>{await database.close();await rm(home,{recursive:true,force:true});});
 await new SqliteContactService(database,f.options.attempt.ownerId,{account:async()=>{throw Error('本测试不得读取渠道');},sessions:async()=>[]}).initialize();
 const library=new TestSkillLibrary(database,f.options.attempt.ownerId,original);let item=await library.discover('gentle');item=await library.setEnabled(item.id,item.headRevision,'enabled');await database.execute('fixture.grantSkills',{ownerId:f.options.attempt.ownerId,contactId:f.options.attempt.contactId});
 const selected=[],loaded=[];
 const protection={
  assertCurrent:async(scope,revision)=>{assert.equal(scope.callId,f.options.callId);if(revision)await database.execute('skills.assertRun',{ownerId:scope.ownerId,revision});},
  recordSelection:async(scope,anchor)=>{selected.push({scope,anchor});},
  recordInput:async input=>{await database.execute('skills.assertRun',{ownerId:input.scope.ownerId,revision:input.runRevision});await database.execute('skills.assertRevision',{ownerId:input.scope.ownerId,anchor:input.loaded});loaded.push(structuredClone(input));},
 };
 f.options.openSkillRun=()=>openSqliteSkillRun(library,{contactId:f.options.attempt.contactId,callId:f.options.callId},protection);
 assert.equal(selected.length,0);assert.equal(loaded.length,0);
 const group=await library.groupScope(f.options.attempt.contactId);
 f.options.skillProtection=protection;f.options.skillRevision={packages:[{id:item.id,headRevision:item.headRevision}],eligible:[skillAnchor(item)],group:{contactId:f.options.attempt.contactId,groupId:group.groupId,revision:group.revision}};
 await runSingleDiscussionTurn(f.options);
 assert.equal(loaded.length,1);assert.equal(loaded[0].relativePath,'SKILL.md');
 assert.equal(JSON.stringify(f.requests[0]).includes('先回应感受，再说明情况。'),false);
 assert.equal(JSON.stringify(f.requests[1]).includes('先回应感受，再说明情况。'),true);assert.equal(selected.length,2);
 assert.equal(JSON.stringify(f.requests[0]).includes(original),false);assert.equal(await readFile(file,'utf8'),document);
});

test('明确后续讨论使用真实持久会话resume，仅提交本次新assistant事件',async t=>{
 const f=await fixture(t);const first=await runSingleDiscussionTurn(f.options);
 const second=await runSingleDiscussionTurn({...f.options,callId:'call-second',attempt:{...f.options.attempt,requestId:'request-second',attemptId:'attempt-second'},prompt:'这是第二次合成要求。'});
 assert.equal(f.requests.length,2);assert.ok(second.sessionEvent.seq>first.sessionEvent.seq);
 assert.equal(f.actions.filter(a=>a.name==='discussion.commitAssistant').length,2);
 assert.equal(JSON.stringify(f.requests[1]).includes('这是第二次合成要求。'),true);
 assert.equal(JSON.stringify(f.requests[1]).includes(first.text),true);
 assert.equal(f.arbiter.snapshot().foregroundActive,false);
});

test('模型已返回后来源失效阻止迟到助手提交，保留真实物理尝试结算',async t=>{
 const f=await fixture(t);let checks=0;
 const original=f.options.storage.execute;
 f.options.storage.execute=async(name,input)=>{
  if(name==='discussion.dispatchCall')checks++;
  return original(name,input);
 };
 f.options.skillProtection.assertCurrent=async()=>{
  if(checks&&f.requests.length)throw new Error('合成来源在模型返回前失效');
 };
 await assert.rejects(runSingleDiscussionTurn(f.options));
 assert.equal(f.requests.length,1);assert.equal(f.actions.some(a=>a.name==='discussion.commitAssistant'),false);
 assert.equal(f.actions.find(a=>a.name==='discussion.failCall').input.dispatched,true);
 assert.equal(f.arbiter.snapshot().foregroundActive,false);
});
