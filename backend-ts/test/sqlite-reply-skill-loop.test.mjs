import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
const answer=JSON.stringify({candidates:[{parts:['合成候选仍可编辑。'],basis:[1]}]});
const searchTools=['search_relationship_history','search_relationship_memory'],skillTools=[...searchTools,'skill','skill_resource'];
function stream(res,name,args){
 const calls=Array.isArray(name)?name:name?[{name,args}]:[],tool=calls.length>0;
 const content=tool?calls.map(call=>({type:'tool_use',id:randomUUID(),name:call.name,input:call.args})):[{type:'text',text:answer}];
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},...content.flatMap((content_block,index)=>[{type:'content_block_start',index,content_block},{type:'content_block_stop',index}]),{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
}
function toolNames(request){return (request.tools??[]).map(tool=>tool.name);}
async function setup(t,onRequest,options={}){
 const f=await fixture(t,{...options,inProcessModel:true,onRequest:async(req,res,request,n)=>{await onRequest(f,res,request,n);return true;}});
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

async function addScaleSkills(f,count=91,bodyPadding=0){
 for(let index=1;index<=count;index++){
  const name=`bulk-${String(index).padStart(3,'0')}`;
  await mkdir(join(f.skillRoot,name),{recursive:true});
  const padding='a'.repeat(bodyPadding);
  await writeFile(join(f.skillRoot,name,'SKILL.md'),`---\nname: ${name}\ndescription: 第${index}个合成规模化回复策略\n---\n这是第${index}个合成规模化策略正文。${padding.slice(0,bodyPadding)}\n`);
 }
 return f.library.refresh();
}

test('正常候选先给官方简介目录，模型按需加载正文后才进入下一次请求',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):stream(res));
 await addClearSkill(f);
 await f.turns.generate(f.input);
 const first=JSON.stringify(f.requests[0]),next=JSON.stringify(f.requests[1]),view=await f.view(),trace=await f.trace();
 assert.equal(f.requests.length,2);assert.equal(trace.calls.length,2);
 assert.match(first,/available_skills/);assert.match(first,/安慰时可用的合成策略/);assert.match(first,/表达边界时可用的合成策略/);
 assert.doesNotMatch(first,/先回应感受|清晰说明边界|<skill_instructions>/);
 assert.deepEqual(toolNames(f.requests[0]).sort(),skillTools);
 assert.match(next,/先回应感受/);assert.doesNotMatch(next,/清晰说明边界|辅助资料的唯一合成教学句/);
 assert.deepEqual(view.loadedSkills.map(skill=>[skill.name,skill.relativePath]),[['gentle','SKILL.md']]);
 assert.deepEqual(view.preloadedSkills,[]);
 const inputs=trace.events.filter(event=>event.kind==='skill_input').map(event=>JSON.parse(event.payload));
 assert.equal(inputs.length,1);assert.equal(inputs[0].name,'gentle');assert.equal(inputs[0].preload,undefined);
 assert.deepEqual(f.supplierErrors,[]);
});

test('模型可并行按需加载多个Skill，输入只记录实际读取的修订',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,[{name:'skill',args:{name:'gentle'}},{name:'skill',args:{name:'clear'}}]):stream(res));await addClearSkill(f);
 await f.turns.generate(f.input);
 const first=JSON.stringify(f.requests[0]),next=JSON.stringify(f.requests[1]),view=await f.view(),trace=await f.trace();
 assert.equal(f.requests.length,2);assert.equal(trace.calls.length,2);
 assert.match(first,/available_skills/);assert.doesNotMatch(first,/先回应感受|清晰说明边界/);
 assert.match(next,/先回应感受/);assert.match(next,/清晰说明边界/);
 assert.deepEqual(view.loadedSkills.map(skill=>skill.name).sort(),['clear','gentle']);assert.deepEqual(view.preloadedSkills,[]);
 const inputs=trace.events.filter(event=>event.kind==='skill_input').map(event=>JSON.parse(event.payload));
 assert.equal(inputs.length,2);assert.ok(inputs.every(item=>item.name&&item.preload===undefined&&item.loaded.manifestDigest&&item.loaded.contentDigest&&item.loaded.headRevision));
 assert.deepEqual(f.supplierErrors,[]);
});

test('模型未选用任何Skill时只发送简介，不记录任何正文载入',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await addClearSkill(f);await f.turns.generate(f.input);
 const first=JSON.stringify(f.requests[0]),view=await f.view(),trace=await f.trace();
 assert.equal(f.requests.length,1);assert.match(first,/available_skills/);assert.match(first,/安慰时可用的合成策略/);assert.match(first,/表达边界时可用的合成策略/);
 assert.doesNotMatch(first,/先回应感受|清晰说明边界/);assert.deepEqual(view.loadedSkills,[]);assert.deepEqual(view.preloadedSkills,[]);
 assert.equal(trace.events.filter(event=>event.kind==='skill_input').length,0);assert.equal(view.skillWarning,null);
});


test('没有eligible Skill时仍只调用一次模型且不暴露Skill工具',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await f.library.setEnabled(f.skill.id,f.skill.headRevision,'disabled');
 await f.turns.generate(f.input);
 const request=JSON.stringify(f.requests[0]),view=await f.view();
 assert.equal(f.requests.length,1);assert.deepEqual(toolNames(f.requests[0]).sort(),searchTools);
 assert.ok(!request.includes('<skill_content'));assert.ok(!request.includes('available_skills'));
 assert.deepEqual(view.loadedSkills,[]);assert.equal(view.skillWarning,null);assert.equal((await f.trace()).calls.length,1);
});

test('92个默认启用Skill的简介目录准备P95和最大值保持秒级', {timeout:90_000}, async t=>{
 let firstAt=0;
 const f=await setup(t,(_f,res)=>{if(!firstAt)firstAt=performance.now();stream(res);});
 // 规模化用例只发送简介目录，正文未被模型选用时不得进入输入。
 f.model.budgetProfile.context_window_tokens=1_000_000;
 const catalog=await addScaleSkills(f);
 assert.equal(catalog.length,92);
 const run=async label=>{
  firstAt=0;const before=f.requests.length,started=performance.now();
  await f.turns.generate({...f.input,requestKey:randomUUID(),text:label});
  const added=f.requests.length-before;
  if(added!==1){
   const trace=await f.trace();
   t.diagnostic(JSON.stringify({label,physicalRequests:added,requests:f.requests.slice(before).map(request=>({tools:toolNames(request),hasCatalog:JSON.stringify(request).includes('available_skills')})),calls:trace.calls.map(call=>({state:call.state,settlement:call.settlement_state})),events:trace.events.map(event=>event.kind)}));
  }
  assert.equal(added,1,`${label}未选用Skill时只允许一次物理请求`);
  assert.ok(firstAt>0);return firstAt-started;
 };
 // 预热不计入门禁；20 个有效样本使 nearest-rank P95 具有统计意义，而不是退化为最大值。
 for(let index=1;index<=2;index++)await run(`第${index}次合成规模化预热请求`);
 const samples=[];
 for(let index=1;index<=20;index++)samples.push(await run(`第${index}次合成规模化候选请求`));
 const sorted=[...samples].sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1],max=sorted.at(-1);
 t.diagnostic(JSON.stringify({skills:catalog.length,samplesMs:samples.map(value=>+value.toFixed(1)),p95Ms:+p95.toFixed(1),maxMs:+max.toFixed(1)}));
 assert.equal(f.requests.length,22,'未选用Skill的简介目录不得增加物理模型调用');
 assert.ok(p95<=1000,`简介目录准备 P95 ${p95.toFixed(1)}ms 超过 1000ms`);
 assert.ok(max<=2000,`简介目录准备 max ${max.toFixed(1)}ms 超过 2000ms`);
 const view=await f.view(),trace=await f.trace();
 assert.deepEqual(view.preloadedSkills,[]);assert.deepEqual(view.loadedSkills,[]);
 assert.equal(trace.events.filter(event=>event.kind==='skill_input').length,0);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/合成规模化策略正文|先回应感受/);
 t.diagnostic(`first_request_bytes=${Buffer.byteLength(JSON.stringify(f.requests[0]),'utf8')}`);
});

test('92个Skill目录只按需读取一包，三次候选页的实际资源仍可分页查询', {timeout:30_000}, async t=>{
 const resources=[{name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},{name:'skill_resource',args:{name:'gentle',path:'references/example.md'}}];
 const f=await setup(t,(_f,res,_request,n)=>n%3===1?stream(res,'skill',{name:'gentle'}):n%3===2?stream(res,resources):stream(res));
 f.model.budgetProfile.context_window_tokens=3_000_000;
 await addScaleSkills(f);
 await writeFile(join(f.skillRoot,'gentle/references/example.md'),'分页合成资料。'+'line '.repeat(153000));
 for(let index=1;index<=3;index++)await f.turns.generate({...f.input,requestKey:randomUUID(),text:`第${index}次合成规模化候选请求`});
 assert.equal(f.requests.length,9);
 const view=await f.view();
 assert.deepEqual(view.preloadedSkills,[]);assert.equal(view.loadedSkills.length,3);
 assert.deepEqual([...new Set(view.loadedSkills.map(skill=>skill.name))],['gentle']);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/合成规模化策略正文|先回应感受/);

 const {SqliteReplyCandidateHttp}=await import('../src/reply/sqlite/candidates/http.ts');
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service:f.service,authorize:req=>req.headers.authorization==='Bearer synthetic'});
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/contacts/${f.input.contactId}/assistant-sessions/${f.input.discussionId}/reply-candidates`;
 const read=target=>new Promise((resolve,reject)=>{const req=httpRequest(target,{headers:{authorization:'Bearer synthetic'}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
 const pageResponse=await read(base),wire=pageResponse.body;
 assert.equal(pageResponse.status,200,pageResponse.body);assert.ok(Buffer.byteLength(wire,'utf8')<2_000_000,`候选页应为最近窗口和Skill身份，实际 ${Buffer.byteLength(wire,'utf8')} bytes`);
 const page=JSON.parse(wire);assert.equal(page.requests.length,3);assert.equal(page.hasMoreRequests,false);
 assert.ok(page.requests.every(request=>request.loadedSkills.length===3&&request.loadedSkills.every(skill=>!Object.hasOwn(skill,'text'))));
 const details=await read(`${base}/${view.requestId}/skills?offset=0`),detailWire=details.body;
 assert.equal(details.status,200);assert.ok(Buffer.byteLength(detailWire,'utf8')<2_000_000);
 const detailBody=JSON.parse(detailWire);assert.equal(detailBody.total,3);assert.ok(detailBody.items.some(skill=>skill.text.includes('分页合成资料。')));
 assert.ok(detailBody.nextOffset>0&&detailBody.nextOffset<detailBody.total,'详情页必须真正跨页');
 const next=await read(`${base}/${view.requestId}/skills?offset=${detailBody.nextOffset}`),nextBody=JSON.parse(next.body);
 assert.equal(next.status,200);assert.equal(nextBody.nextOffset,null);assert.equal(detailBody.items.length+nextBody.items.length,detailBody.total);
});

test('257个eligible Skill只提供简介，不再受批量预加载256包上限限制', {timeout:30_000}, async t=>{
 const f=await setup(t,(_f,res)=>stream(res));f.model.budgetProfile.context_window_tokens=1_000_000;
 const catalog=await addScaleSkills(f,256);assert.equal(catalog.length,257);
 await f.turns.generate({...f.input,requestKey:randomUUID()});
 const first=JSON.stringify(f.requests[0]),view=await f.view();
 assert.equal(f.requests.length,1);assert.deepEqual(toolNames(f.requests[0]).sort(),skillTools);
 assert.match(first,/bulk-256/);assert.doesNotMatch(first,/合成规模化策略正文|先回应感受/);
 assert.equal(view.skillWarning,null);assert.deepEqual(view.loadedSkills,[]);assert.deepEqual(view.preloadedSkills,[]);
});


test('显式selectedPackageId只预加载指定单包并保持优先',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await addClearSkill(f);
 await f.turns.generate({...f.input,selectedPackageId:f.skill.id});
 const request=JSON.stringify(f.requests[0]),trace=await f.trace();
 assert.equal(f.requests.length,1);assert.match(request,/先回应感受/);assert.doesNotMatch(request,/清晰说明边界/);
 const inputs=trace.events.filter(event=>event.kind==='skill_input').map(event=>JSON.parse(event.payload));
 assert.deepEqual(inputs.map(item=>item.loaded.packageId),[f.skill.id]);
 assert.equal(inputs[0].preload.origin,'explicit');assert.ok(!toolNames(f.requests[0]).includes('skill'));
 assert.deepEqual((await f.view()).preloadedSkills.map(skill=>[skill.name,skill.origin]),[['gentle','explicit']]);
});

test('skill_resource先加载正文再读取两份资源，未请求资源不进入前两次输入',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):n===2?stream(res,[
  {name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},
  {name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},
 ]):stream(res));
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace();
 assert.equal(f.requests.length,3);assert.deepEqual(toolNames(f.requests[0]).sort(),skillTools);
 assert.equal(view.loadedSkills.filter(skill=>skill.relativePath==='references/example.md').length,2);
 assert.equal(view.loadedSkills.filter(skill=>skill.relativePath==='SKILL.md').length,1);assert.deepEqual(view.preloadedSkills,[]);
 assert.ok(view.loadedSkills.every(skill=>skill.origin===null&&skill.catalogRevision===null));
 assert.equal(trace.calls.length,3);assert.equal(trace.events.filter(event=>event.kind==='skill_input').length,3);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/先回应感受|辅助资料的唯一合成教学句/);
 assert.doesNotMatch(JSON.stringify(f.requests[1]),/辅助资料的唯一合成教学句/);assert.match(JSON.stringify(f.requests[2]),/辅助资料的唯一合成教学句/);
});


test('skill_resource第三次读取硬拒绝并整体降级为无Skill请求',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):n===2?stream(res,[
  {name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},
  {name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},
  {name:'skill_resource',args:{name:'gentle',path:'references/example.md'}},
 ]):stream(res));
 await f.turns.generate(f.input);
 const view=await f.view();assert.equal(f.requests.length,3);
 assert.deepEqual(f.requests.map(request=>toolNames(request).sort()),[skillTools,skillTools,searchTools]);
 assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);assert.deepEqual(view.preloadedSkills,[]);
 const fallback=JSON.stringify(f.requests[2]);for(const text of ['gentle','先回应感受','references/example.md','tool_result'])assert.ok(!fallback.includes(text));
});


test('目录核验失败整体无Skill降级，首次且唯一物理调用不含残缺正文',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await unlink(join(f.skillRoot,'gentle/SKILL.md'));
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace(),request=JSON.stringify(f.requests[0]);
 assert.equal(f.requests.length,1);assert.equal(trace.calls.length,1);assert.equal(view.skillWarning,'回复策略暂不可用');
 assert.deepEqual(view.loadedSkills,[]);assert.ok(!request.includes('gentle'));assert.ok(!request.includes('先回应感受'));
 assert.ok(!trace.events.some(event=>['skill_input','skill_selection'].includes(event.kind)));
 assert.ok(trace.events.some(event=>event.kind==='skill_unavailable'));
});

test('按需读取的Skill正文超出完整请求预算时撤下，未发送超限正文并干净降级',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):stream(res));
 // 显式固定容量，初始目录可发送，加载完整正文后仍必须触发预算降级。
 f.model.budgetProfile.context_window_tokens=12000;
 await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 安慰时可用的合成策略\n---\n'+('超长合成策略正文'.repeat(400))+'\n');
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace();assert.equal(f.requests.length,2);assert.equal(trace.calls.length,2);
 assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);
 assert.doesNotMatch(JSON.stringify(f.requests),/超长合成策略正文/);assert.doesNotMatch(JSON.stringify(f.requests[1]),/available_skills|gentle|tool_result/);
 assert.equal(trace.events.filter(event=>event.kind==='model_request').length,1,'被撤下的Skill上下文只保留无正文调用回执');
});


test('Skill在按需加载后失效时清除已读正文并以无Skill上下文继续',async t=>{
 const f=await setup(t,async(f,res,_request,n)=>{if(n===1)stream(res,'skill',{name:'gentle'});else if(n===2){await unlink(join(f.skillRoot,'gentle/SKILL.md'));stream(res,'skill_resource',{name:'gentle',path:'references/example.md'});}else stream(res);});
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace();assert.equal(f.requests.length,3);assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);
 assert.match(JSON.stringify(f.requests[1]),/先回应感受/);
 const fallback=JSON.stringify(f.requests[2]);for(const text of ['gentle','先回应感受','references/example.md','tool_result'])assert.ok(!fallback.includes(text));
 assert.ok(!trace.events.some(event=>['skill_input','skill_selection'].includes(event.kind)));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('请求取消在目录准备或首次模型调用前阻止候选提交',async t=>{
 const controller=new AbortController();const f=await setup(t,(_f,res)=>stream(res));controller.abort();
 await assert.rejects(f.turns.generate({...f.input,signal:controller.signal}));assert.equal(f.requests.length,0);assert.deepEqual((await f.view())?.candidates??[],[]);
});


test('目录准备后当前修订在发送前变化时整体降级，唯一物理调用不含旧正文',{timeout:6000},async t=>{
 const f=await setup(t,(_f,res)=>stream(res));const original=f.provider.beginCall.bind(f.provider);let changed=false;
 f.provider.beginCall=call=>original({...call,beforeDispatch:async value=>{if(!changed){changed=true;await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 安慰时可用的合成策略\n---\n已变化的合成正文。\n');}return call.beforeDispatch(value);}});
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace(),wire=JSON.stringify(f.requests[0]);
 assert.equal(f.requests.length,1);assert.equal(trace.calls.length,1);assert.equal(view.skillWarning,'回复策略暂不可用');assert.deepEqual(view.loadedSkills,[]);
 assert.ok(!wire.includes('先回应感受'));assert.ok(!wire.includes('已变化的合成正文'));assert.ok(!wire.includes('available_skills'));
});

test('模型超时发生在简介目录首请求时自动放弃且成本仍未知，不自动重送',{timeout:6000},async t=>{
 const f=await setup(t,async()=>new Promise(()=>{}));f.model.deadline_ms=1000;
 await assert.rejects(f.turns.generate(f.input),error=>error?.code==='discussion_generation_timeout');
 assert.equal(f.requests.length,1);assert.deepEqual((await f.view())?.candidates??[],[]);
 const trace=await f.trace();assert.equal(trace.calls.length,1);assert.equal(trace.calls[0].state,'failed');assert.equal(trace.calls[0].settlement_state,'unknown');
 const status=await f.service.status(f.input.contactId,f.input.discussionId,f.input.requestKey);assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.retryable,true);assert.equal(status.errorCode,'discussion_generation_timeout');
});

test('关闭候选运行会中止简介目录的在途首请求并拒绝迟到正文',{timeout:6000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await setup(t,async(_f,res)=>{entered.resolve();await release.promise;stream(res);});
 const pending=f.turns.generate(f.input);await entered.promise;assert.equal(f.requests.length,1);
 await f.turns.close();await assert.rejects(pending);assert.deepEqual((await f.view())?.candidates??[],[]);
 release.resolve();assert.equal(f.supplierErrors.length>=0,true);
});


test('停用 Skill 不进入简介目录，也不阻断其余 eligible Skill',async t=>{
 const f=await setup(t,(_f,res,_request,n)=>n===1?stream(res,'skill',{name:'gentle'}):stream(res));const clear=await addClearSkill(f);await f.library.setEnabled(clear.id,clear.headRevision,'disabled');
 await f.turns.generate(f.input);
 const first=JSON.stringify(f.requests[0]),next=JSON.stringify(f.requests[1]),view=await f.view();
 assert.equal(f.requests.length,2);assert.match(first,/安慰时可用的合成策略/);assert.doesNotMatch(first,/表达边界时可用的合成策略|先回应感受|清晰说明边界/);
 assert.match(next,/先回应感受/);assert.doesNotMatch(next,/清晰说明边界/);
 assert.deepEqual(view.loadedSkills.map(skill=>skill.name),['gentle']);assert.deepEqual(view.preloadedSkills,[]);assert.equal(view.skillWarning,null);
});


test('已启用 Skill 来源资格失效时整体无 Skill 降级并保留可解释状态',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await f.library.requireVerification(f.skill.id,f.skill.headRevision);
 await f.turns.generate(f.input);
 const view=await f.view(),trace=await f.trace(),wire=JSON.stringify(f.requests[0]);
 assert.equal(f.requests.length,1);assert.equal(trace.calls.length,1);assert.equal(view.skillWarning,'回复策略暂不可用');
 assert.deepEqual(view.loadedSkills,[]);assert.deepEqual(view.preloadedSkills,[]);assert.ok(!wire.includes('先回应感受'));
 assert.ok(trace.events.some(event=>event.kind==='skill_unavailable'));
});

test('按需加载路径仍保持调用预算和单一运行副本',async t=>{
 const f=await setup(t,(_f,res)=>stream(res));await f.turns.generate(f.input);
 const copies=await f.storage.execute('runtime.inventory',{ownerId:f.owner});
 assert.equal(copies.length,1);assert.equal(copies[0].state,'ready');
 assert.equal(copies[0].configurationDigest,await f.turns.configurationFor(f.input.contactId,f.input.discussionId));
 assert.equal((await readdir(join(f.root,'managed/runtime-copies'))).length,1);
});


test('按需加载循环最多五次模型调用，达到上限后不创建第六次请求',async t=>{
 const f=await setup(t,(_f,res)=>stream(res,'skill',{name:'gentle'}));
 await assert.rejects(f.turns.generate(f.input),error=>error?.code==='discussion_call_limit');
 assert.equal(f.requests.length,5);assert.deepEqual((await f.view())?.candidates??[],[]);
 assert.equal((await f.trace()).calls.length,5);
});
