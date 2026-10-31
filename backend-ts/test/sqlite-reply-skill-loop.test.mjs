import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
const answer=JSON.stringify({candidates:[{parts:['合成候选仍可编辑。'],basis:[1]}]});
function stream(res,name,args){
 const calls=Array.isArray(name)?name:name?[{name,args}]:[],tool=calls.length>0;
 const content=tool?calls.map(call=>({type:'tool_use',id:randomUUID(),name:call.name,input:call.args})):[{type:'text',text:answer}];
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},...content.flatMap((content_block,index)=>[{type:'content_block_start',index,content_block},{type:'content_block_stop',index}]),{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
}
async function setup(t,onRequest,options={}){
 const f=await fixture(t,{...options,onRequest:async(req,res,request,n)=>{await onRequest(f,res,request,n);return true;}});
 await mkdir(join(f.skillRoot,'gentle/references'),{recursive:true});
 await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 安慰时可用的合成策略\n---\n先回应感受，再参考 references/example.md。\n');
 await writeFile(join(f.skillRoot,'gentle/references/example.md'),'辅助资料的唯一合成教学句。');
 let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId);
 const input={contactId,discussionId:d.id,requestKey:randomUUID(),text:'帮我安慰这位联系人',confirmedContact:true};
 return {...f,service,turns,input,skill,view:async()=>(await service.view(contactId,d.id))[0],trace:async()=>{const v=await service.view(contactId,d.id);return f.discussions.trace(contactId,d.id,v[0].requestId);}};
}
async function addClearSkill(f){
 await mkdir(join(f.skillRoot,'clear/references'),{recursive:true});
 await writeFile(join(f.skillRoot,'clear/SKILL.md'),'---\nname: clear\ndescription: 表达边界时可用的合成策略\n---\n清晰说明边界，参考 references/example.md。\n');
 await writeFile(join(f.skillRoot,'clear/references/example.md'),'clear 的独立合成案例。');
 const skill=await f.library.discover('clear');return f.library.setEnabled(skill.id,skill.headRevision,'enabled');
}

test('正常回复可自动选择正文再按需读取同修订资源，实际输入和逐次用量可回看',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):n===2?stream(res,'skill_resource',{name:'gentle',path:'references/example.md'}):stream(res));
 await f.turns.generate(f.input);const view=await f.view();assert.equal(view.candidates.length,1);assert.equal(view.loadedSkills[0].name,'gentle');
 assert.deepEqual(view.loadedSkills.map(s=>s.relativePath),['SKILL.md','references/example.md']);
 assert.ok(!JSON.stringify(f.requests[0]).includes('辅助资料的唯一合成教学句。'));assert.ok(JSON.stringify(f.requests[2]).includes('辅助资料的唯一合成教学句。'));
 const trace=await f.trace();assert.equal(trace.calls.length,3);assert.ok(trace.calls.every(c=>c.state==='succeeded'&&c.actual_budget_units===11n));
 assert.equal(trace.events.filter(e=>e.kind==='model_request').length,3);assert.deepEqual(f.supplierErrors,[]);
});

test('同次回复可组合多个 Skill，分别读取同名案例并在候选与调用依据中保留所有实际输入',async t=>{
 const names=['gentle','clear'];
 const f=await setup(t,(_f,res,_request,n)=>n===1
  ?stream(res,names.map(name=>({name:'skill',args:{name}})))
  :n===2?stream(res,names.map(name=>({name:'skill_resource',args:{name,path:'references/example.md'}}))):stream(res));
 const clear=await addClearSkill(f);
 await f.turns.generate(f.input);
 const view=await f.view();assert.equal(view.candidates.length,1);assert.equal(view.skillWarning,null);
 assert.deepEqual(view.loadedSkills.map(skill=>[skill.name,skill.relativePath]),[
  ['gentle','SKILL.md'],['clear','SKILL.md'],['gentle','references/example.md'],['clear','references/example.md'],
 ]);
 assert.equal(view.loadedSkills[2].text,'辅助资料的唯一合成教学句。');assert.equal(view.loadedSkills[3].text,'clear 的独立合成案例。');
 assert.equal(view.loadedSkills[2].packageId,f.skill.id);assert.equal(view.loadedSkills[3].packageId,clear.id);
 assert.ok(!JSON.stringify(f.requests[0]).includes('清晰说明边界，参考'));
 assert.ok(JSON.stringify(f.requests[1]).includes('先回应感受，再参考'));assert.ok(JSON.stringify(f.requests[1]).includes('清晰说明边界，参考'));
 assert.ok(JSON.stringify(f.requests[2]).includes('辅助资料的唯一合成教学句。'));assert.ok(JSON.stringify(f.requests[2]).includes('clear 的独立合成案例。'));
 const trace=await f.trace();assert.equal(trace.calls.length,3);assert.equal(trace.events.filter(event=>event.kind==='skill_input').length,4);
 assert.deepEqual(trace.events.filter(event=>event.kind==='skill_selection').map(event=>JSON.parse(event.payload).selected?.packageId??null),[null,f.skill.id,clear.id]);
 assert.equal(await f.turns.configurationFor(f.input.contactId,f.input.discussionId),(await f.storage.execute('runtime.inventory',{ownerId:f.owner}))[0].configurationDigest);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});assert.deepEqual(f.supplierErrors,[]);
});

test('已组合多个 Skill 后任一版本失效，降级清除所有旧正文、案例目录和实际输入',async t=>{
 const f=await setup(t,async(f,res,_request,n)=>{
  if(n===1)stream(res,['gentle','clear'].map(name=>({name:'skill',args:{name}})));
  else if(n===2){await unlink(join(f.skillRoot,'clear/SKILL.md'));stream(res,'skill_resource',{name:'gentle',path:'references/example.md'});}
  else stream(res);
 });
 await addClearSkill(f);await f.turns.generate(f.input);
 const view=await f.view();assert.equal(view.candidates.length,1);assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);
 assert.equal(f.requests.length,3);assert.ok(JSON.stringify(f.requests[1]).includes('清晰说明边界'));
 const fallback=JSON.stringify(f.requests[2]);for(const text of ['gentle','clear','先回应感受','清晰说明边界','references/example.md','tool_result'])assert.ok(!fallback.includes(text));
 const trace=await f.trace();assert.ok(!trace.events.some(event=>event.kind==='skill_input'||event.kind==='skill_selection'));
 assert.equal(trace.events.filter(event=>event.kind==='model_request').length,1);assert.equal(trace.calls.length,3);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});assert.deepEqual(f.supplierErrors,[]);
});

test('Skill在模型选中后缺失时清理旧会话与失效载荷，再用无Skill上下文继续',async t=>{
 const f=await setup(t,async(f,res,_request,n)=>{if(n===1){await unlink(join(f.skillRoot,'gentle/SKILL.md'));stream(res,'skill',{name:'gentle'});}else stream(res);});
 await f.turns.generate(f.input);const view=await f.view();assert.equal(view.candidates.length,1);assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);
 assert.equal(f.requests.length,2);const fallback=JSON.stringify(f.requests[1]);assert.ok(!fallback.includes('available_skills'));assert.ok(!fallback.includes('gentle'));assert.ok(!fallback.includes('tool_result'));
 const trace=await f.trace();assert.equal(trace.calls.length,2);assert.ok(trace.events.some(e=>e.kind==='skill_unavailable'));assert.ok(!trace.events.some(e=>e.kind==='skill_input'));
 const copies=await f.storage.execute('runtime.inventory',{ownerId:f.owner});assert.equal(copies.length,1);assert.equal(copies[0].state,'ready');assert.equal(copies[0].configurationDigest,await f.turns.configurationFor(f.input.contactId,f.input.discussionId));
 assert.equal((await readdir(join(f.root,'managed/runtime-copies'))).length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('模型可不选择Skill，候选不展示策略名称或不可用提示',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await f.turns.generate(f.input);const view=await f.view();assert.equal(view.candidates.length,1);assert.deepEqual(view.loadedSkills,[]);assert.equal(view.skillWarning,null);assert.equal(f.requests.length,1);
});


test('资源部分加载后失效会销毁包含旧正文的会话，降级请求不含旧Skill或工具结果',async t=>{
 const f=await setup(t,async(f,res,_request,n)=>{if(n===1)stream(res,'skill',{name:'gentle'});else if(n===2){await writeFile(join(f.skillRoot,'gentle/references/example.md'),'替换后的不可信资料。');stream(res,'skill_resource',{name:'gentle',path:'references/example.md'});}else stream(res);});
 await f.turns.generate(f.input);const view=await f.view();assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);assert.equal(f.requests.length,3);
 const last=JSON.stringify(f.requests.at(-1));assert.ok(!last.includes('先回应感受'));assert.ok(!last.includes('references/example.md'));assert.ok(!last.includes('tool_result'));
 const trace=await f.trace();assert.equal(trace.calls.length,3);assert.ok(!trace.events.some(e=>e.payload.includes('先回应感受')));assert.equal(trace.events.filter(e=>e.kind==='model_request').length,1);
});

test('Skill失败伴随本次出站授权撤销时停止，不用降级绕过授权',async t=>{
 let revoked=false;
 const f=await setup(t,async(f,res)=>{revoked=true;await unlink(join(f.skillRoot,'gentle/SKILL.md'));stream(res,'skill',{name:'gentle'});});
 await f.turns.close();const turns=new SqliteReplyTurns({...f,service:f.service,authorize:async()=>{if(revoked)throw Error('synthetic authorization revoked');}});t.after(()=>turns.close());
 await assert.rejects(turns.generate(f.input));assert.equal(f.requests.length,1);assert.equal((await f.view()).candidates.length,0);
});

test('请求取消在Skill工具返回前阻止续发与候选提交',async t=>{
 const controller=new AbortController();const f=await setup(t,(_f,res)=>{controller.abort();stream(res,'skill',{name:'gentle'});});
 await assert.rejects(f.turns.generate({...f.input,signal:controller.signal}));assert.equal(f.requests.length,1);assert.equal((await f.view()).candidates.length,0);
});


test('只读helper暂不可用时仅降级Skill，干净上下文继续且记录提示',async t=>{
 const child=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');let unavailable=false;
 const original=child.default.spawnSync;
 const stub=t.mock.method(child.default,'spawnSync',(file,...args)=>unavailable&&String(file).endsWith('/skill-read')?{error:Object.assign(Error('synthetic helper unavailable'),{code:'ENOENT'})}:original(file,...args));syncBuiltinESMExports();
 try{
  const f=await setup(t,(_f,res,_request,n)=>{if(n===1){unavailable=true;stream(res,'skill',{name:'gentle'});}else stream(res);});
  await f.turns.generate(f.input);const view=await f.view();assert.equal(view.skillWarning,'回复策略暂不可用');assert.equal(view.candidates.length,1);assert.deepEqual(view.loadedSkills,[]);assert.equal(f.requests.length,2);
 }finally{stub.mock.restore();syncBuiltinESMExports();}
});

test('合法大资源沿1MiB导入限制和完整模型输入预算参与回复及回看',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):n===2?stream(res,'skill_resource',{name:'gentle',path:'references/example.md'}):stream(res));
 const text='large-resource-template '.repeat(6000);assert.ok(text.length>100000);await writeFile(join(f.skillRoot,'gentle/references/example.md'),text);
 f.model.budgetProfile.context_window_tokens=1_048_576;
 await f.turns.generate(f.input);const view=await f.view();assert.equal(view.candidates.length,1);assert.equal(view.loadedSkills[1].text,text);assert.ok(JSON.stringify(f.requests[2]).includes(text));
});

test('清理最后文件后中断可从持久意图恢复，失效Skill会话不能重新执行',async t=>{
 const f=await setup(t,async(f,res,_request,n)=>{if(n===1){await unlink(join(f.skillRoot,'gentle/SKILL.md'));stream(res,'skill',{name:'gentle'});}else stream(res);},{runtimeFault:point=>{if(point==='beforeDiscardCommit')throw Error('synthetic crash after erasure');}});
 await assert.rejects(f.turns.generate(f.input));await f.runtime.close();
 const interrupted=await f.storage.execute('runtime.inventory',{ownerId:f.owner});assert.equal(interrupted.length,1);assert.equal(interrupted[0].state,'blocked');assert.ok(interrupted[0].cleanupOperationId.startsWith('skill-discard:'));
 const {SqliteDiscussionRuntime}=await import('../src/reply/sqlite/runtime.ts'),reopened=new SqliteDiscussionRuntime({storage:f.storage,ownerId:f.owner,userData:f.root,ctx:f.ctx,holders:f.holders});
 try{await reopened.initialize();assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId:f.owner}),[]);assert.deepEqual(await readdir(join(f.root,'managed/runtime-copies')),[]);assert.equal((await f.view()).candidates.length,0);assert.equal(f.requests.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});}finally{await reopened.close();}
});


test('Skill在本轮准备和打开provider之间缺失时也可安全降级',async t=>{
 let f,removed=false;
 f=await setup(t,(_f,res)=>stream(res),{runtimeFault:async point=>{if(point==='beforeDirectory'&&!removed){removed=true;await unlink(join(f.skillRoot,'gentle/SKILL.md'));}}});
 await f.turns.generate(f.input);const view=await f.view();assert.equal(view.skillWarning,'回复策略暂不可用');assert.equal(view.candidates.length,1);assert.equal(f.requests.length,1);assert.ok(!JSON.stringify(f.requests[0]).includes('gentle'));
});


test('provider打开后Agent setup读取失败保留故障类别，并从干净上下文继续',async t=>{
 const f=await setup(t,(_f,res)=>stream(res)),{skillAnchor}=await import('../src/skills/sqlite/library.ts'),{openSqliteSkillRun}=await import('../src/skills/sqlite/provider.ts'),{SqliteDiscussionSkillProtection}=await import('../src/reply/sqlite/skill-protection.ts'),{runSingleDiscussionTurn}=await import('../src/reply/sqlite/generation.ts');
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId:f.input.contactId,contextToken:f.input.requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await f.service.begin({...f.input,identity:{kind:'manual',confirmationId}}),callId=randomUUID(),contextId=randomUUID();
 const catalog=await f.library.list(),revision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:catalog.map(skillAnchor)};
 const view=await f.discussions.view(f.input.contactId,f.input.discussionId),items=await f.storage.execute('reply.freezeInput',{...attempt,contextId,skillRun:revision,items:view.entries.map(e=>({kind:'entry',entryId:e.id})),at:Date.now()});assert.equal(items[0].itemNo,1);
 await f.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:f.model.provider,requestKey:callId,inputSeal:'a'.repeat(64),model:f.model.model,configurationId:'b'.repeat(64),inputCap:8192,outputCap:f.model.maxTokens});
 const protection=new SqliteDiscussionSkillProtection({storage:f.storage,attempt,contextId,callId,authorize:async()=>{}}),run=await openSqliteSkillRun(f.library,{contactId:f.input.contactId,callId},protection);
 await unlink(join(f.skillRoot,'gentle/SKILL.md'));
 await runSingleDiscussionTurn({runtime:f.runtime,storage:f.storage,attempt,callId,contextId,configurationDigest:'b'.repeat(64),configurationForRevision:()=> 'c'.repeat(64),prompt:'[1] 合成请求，请只输出JSON候选。',systemPrompt:'只输出JSON候选，basis引用1。',model:f.model,provider:f.provider,arbiter:f.arbiter,skillRun:run,skillProtection:protection,skillRevision:revision,assertAuthorized:async()=>{},commitAction:'reply.commitCandidates'});
 const result=await f.view();assert.equal(result.skillWarning,'回复策略暂不可用');assert.equal(result.candidates.length,1);assert.deepEqual(result.loadedSkills,[]);assert.equal(f.requests.length,1);assert.ok(!JSON.stringify(f.requests[0]).includes('gentle'));
});
