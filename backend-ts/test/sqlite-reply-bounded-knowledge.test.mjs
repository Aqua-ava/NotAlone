import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';

test('100条真实记忆由模型按需搜索，仅后续请求使用相关完整条目并遵守联系人与本人限额',async t=>{
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n!==1)return;assert.doesNotMatch(JSON.stringify(request),/园艺偏好条目|无关星际课题/);toolResponse(res,'search_relationship_memory',{query:'园艺偏好'});return true;
 },content:memoryReply});
 const contactId=f.ids[0],management=new SqliteMemoryManagement(f.storage,f.owner);
 for(let n=0;n<100;n++)await management.decide({requestKey:`bounded-${n}`,action:'manual',scope:n<90?{scopeKind:'contact',contactId}:{scopeKind:'self',contactId:null},body:n<80?`无关星际课题编号${n}。`:`园艺偏好条目${n}：喜欢种植月季。`});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const started=performance.now();await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'园艺偏好',confirmedContact:true});
 assert.equal(f.requests.length,2);const request=JSON.stringify(f.requests[1]);
 assert.ok(!request.includes('无关星际课题'),'无关记忆不能进入真实provider请求');
 assert.equal((request.match(/园艺偏好条目/g)??[]).length,8);
 const basis=(await service.view(contactId,d.id))[0].candidates[0].basis[0];assert.equal(basis.verification,'actual_input');assert.match(basis.text,/园艺偏好条目/);
 t.diagnostic(`100条记忆；实际输入8条；provider请求${request.length}字符；生成${Math.round(performance.now()-started)}ms`);
});

test('真实发布L2初始只有目录，按冻结版本读取完整段落并保留L3完整陈述',async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const f=await documentFixture(t,{registryModule:new URL('./fixtures/sqlite-reply-candidates/document-registry.mjs',import.meta.url).href,sceneBody:'场景专有正文：合成园艺需要耐心照料。'});
 await f.extraction.start('bounded-documents');await f.extraction.waitForIdle();
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},items=await f.storage.execute('fixture.knowledge',scope);
 const directory=items.find(item=>item.projection?.kind==='directory');
 assert.ok(directory,'场景必须使用目录投影');assert.equal(directory.projection.blockCount,1);
 assert.match(directory.text,/长期园艺偏好/);assert.ok(!JSON.stringify(directory,(_key,value)=>typeof value==='bigint'?String(value):value).includes('场景专有正文'));
 const body=await f.storage.execute('fixture.readDocument',{...scope,item:directory,range:{startBlock:1,blockCount:1}});
 assert.match(body.text,/场景专有正文/);assert.equal(body.projection.kind,'blocks');assert.ok(body.sources.length);
 const profile=items.find(item=>item.projection?.kind==='profile');assert.match(profile.text,/事实：联系人长期喜欢合成园艺。/);
 assert.equal(await f.storage.execute('fixture.requireDocument',{...scope,item:body}),true);
 const {projection:legacyProjection,...legacy}=body;void legacyProjection;
 assert.equal(await f.storage.execute('fixture.requireDocument',{...scope,item:legacy}),true,'旧identity没有projection仍按完整正文复核');
 await assert.rejects(f.storage.execute('fixture.readDocument',{...scope,item:directory,range:{startBlock:0,blockCount:1}}),{code:'reply_document_range_invalid'});
 await f.management.decide({requestKey:'invalidate-document',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'新的合成资料。'});
 // 整个发布集合与版本资格仍按原合同复核；修订变化不将旧内容换成新正文。
 await assert.rejects(f.storage.execute('fixture.requireDocument',{...scope,item:{...body,text:'伪造正文'}}),{code:'document_knowledge_stale'});
});

function toolResponse(res,name,args){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
function memoryReply(request){
 const material=JSON.stringify(request).match(/实际输入材料\[(\d+)\] memory/);
 return JSON.stringify({candidates:[{parts:['合成建议'],basis:[material?Number(material[1]):1]}]});
}
async function publishedReplyFixture(t,options={}){
 const f=await fixture(t,{synchronizeHistory:false,registryModule:new URL('./fixtures/sqlite-reply-candidates/document-registry.mjs',import.meta.url).href,...options});
 await f.contacts.setReading(true);
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const docs=await documentFixture(t,{baseFixture:{...f,service:f.history,saved:[{contact_id:f.ids[0]}],target:{descriptor:'synthetic-target-a'}},sceneBody:'场景专有正文：合成园艺需要耐心照料。',...options.documents});
 const run=await docs.extraction.start('bounded-provider-documents');await docs.extraction.waitForIdle();
 const state=await docs.extraction.read(run.runId);assert.equal((await docs.documents.read({scopeKind:'contact',contactId:f.ids[0]})).documents.length,(options.documents?.sceneCount??1)+1,JSON.stringify(await docs.documents.readTask(state.tasks.find(task=>task.contactId===f.ids[0]).taskId)));
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 return {...f,docs,contactId,discussionId:d.id,service,turns};
}
test('真实provider工具轮次只开放固定目录读取并追加真实正文材料与候选依据',async t=>{
 let itemNo;
 const f=await publishedReplyFixture(t,{onRequest:async(_req,res,request,n)=>{
  if(n!==1)return;
  assert.ok(request.tools.some(tool=>tool.name==='read_relationship_document'));
  const input=JSON.stringify(request);assert.ok(!input.includes('场景专有正文'));
  itemNo=Number(input.match(/\[(\d+)\] document\\n【主题目录】/)[1]);
  toolResponse(res,'read_relationship_document',{itemNo,startBlock:1,blockCount:1});return true;
 },content:request=>{
  const input=JSON.stringify(request);assert.match(input,/场景专有正文/);
  const material=Number(input.match(/实际输入材料\[(\d+)\]/)[1]);
  return JSON.stringify({candidates:[{parts:['照顾合成园艺的建议。'],basis:[material]}]});
 }});
 await f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true});
 assert.equal(f.requests.length,2);
 const view=await f.service.view(f.contactId,f.discussionId),basis=view.flatMap(row=>row.candidates)[0].basis;
 assert.match(basis[0].text,/场景专有正文/);assert.ok(basis[0].itemNo>itemNo);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId});
 assert.equal(actual.filter(row=>row.text_body.includes('场景专有正文')).length,1);
});

test('无效材料编号和第三次正文预算拒绝不会污染本轮，仍可用已读资料生成',async t=>{
 let itemNos;
 const f=await publishedReplyFixture(t,{documents:{sceneCount:2},onRequest:async(_req,res,request,n)=>{
  if(n===5)return;
  if(n===1)itemNos=[...JSON.stringify(request).matchAll(/\[(\d+)\] document\\n【主题目录】/g)].map(match=>Number(match[1]));
  toolResponse(res,'read_relationship_document',{itemNo:n===1?999:itemNos[n===3?1:0],startBlock:1,blockCount:1});return true;
 },content:request=>{
  const input=JSON.stringify(request);assert.equal((input.match(/资料读取被拒绝/g)??[]).length,2);
  return JSON.stringify({candidates:[{parts:['合成有限资料建议。'],basis:[Number(input.match(/实际输入材料\[(\d+)\]/)[1])]}]});
 }});
 await f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true});
 assert.equal(f.requests.length,5);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId});assert.equal(actual.filter(row=>row.text_body.includes('场景专有正文')).length,2);
 assert.equal((await f.service.view(f.contactId,f.discussionId)).flatMap(row=>row.candidates).length,1);
});

test('取消后的迟到正文工具请求不追加资料也不继续出站',async t=>{
 const controller=new AbortController();
 const f=await publishedReplyFixture(t,{onRequest:async(_req,res,request)=>{
  const itemNo=Number(JSON.stringify(request).match(/\[(\d+)\] document\\n【主题目录】/)[1]);
  controller.abort();toolResponse(res,'read_relationship_document',{itemNo,startBlock:1,blockCount:1});return true;
 }});
 await assert.rejects(f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true,signal:controller.signal}),{code:'discussion_generation_cancelled'});
 assert.equal(f.requests.length,1);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId});assert.ok(actual.every(row=>!row.text_body.includes('场景专有正文')));
 assert.equal((await f.service.view(f.contactId,f.discussionId)).flatMap(row=>row.candidates).length,0);
});

test('正文工具读取前原记忆纠错使整轮失败，不返回旧正文或自动换用新版本',async t=>{
 let f;
 f=await publishedReplyFixture(t,{onRequest:async(_req,res,request)=>{
  const itemNo=Number(JSON.stringify(request).match(/\[(\d+)\] document\\n【主题目录】/)[1]);
  const memory=(await f.docs.management.read({scopeKind:'contact',contactId:f.contactId})).memories[0];
  await f.docs.management.decide({requestKey:'bounded-correction',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'纠错后不再支持原场景的合成资料。'});
  toolResponse(res,'read_relationship_document',{itemNo,startBlock:1,blockCount:1});return true;
 }});
 await assert.rejects(f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true}));
 assert.equal(f.requests.length,1);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId});assert.ok(actual.every(row=>!row.text_body.includes('场景专有正文')));
 assert.equal((await f.service.view(f.contactId,f.discussionId)).flatMap(row=>row.candidates).length,0);
});

test('正文追加后删除实际来源，取消迟到候选并清除新增输入与真实调用追踪',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await publishedReplyFixture(t,{onRequest:async(_req,res,request,n)=>{
  if(n===1){toolResponse(res,'read_relationship_document',{itemNo:Number(JSON.stringify(request).match(/\[(\d+)\] document\\n【主题目录】/)[1]),startBlock:1,blockCount:1});return true;}
  assert.match(JSON.stringify(request),/场景专有正文/);entered.resolve();await release.promise;
 },content:JSON.stringify({candidates:[{parts:['迟到合成候选'],basis:[1]}]})});
 const pending=f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'谈谈园艺',confirmedContact:true}),rejected=assert.rejects(pending);
 await entered.promise;
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
 const message=(await f.history.read(f.contactId)).messages[0];
 const op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:message.sourceRecordIds[0]}});
 release.resolve();await rejected;const result=await deletion.advance(op);assert.equal(result.state,'completed',JSON.stringify(result.checks));
 assert.deepEqual(await f.service.view(f.contactId,f.discussionId),[]);
 assert.deepEqual(await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId}),[]);
 assert.equal(f.requests.length,2);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('空suggest不自动召回记忆；模型主动查询后返回超长完整条目且不截断',async t=>{
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n!==2)return;assert.doesNotMatch(JSON.stringify(request),/园艺甲|园艺短条目完整结束/);toolResponse(res,'search_relationship_memory',{query:'园艺'});return true;
 },content:memoryReply}),contactId=f.ids[0];
 const management=new SqliteMemoryManagement(f.storage,f.owner);
 for(const [index,body] of ['工作区动作帮我想想关系背景已启用尚未确认立场。','园艺'+ '甲'.repeat(599),'园艺短条目完整结束。'].entries())await management.decide({requestKey:`query-${index}`,action:'manual',scope:{scopeKind:'contact',contactId},body});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const workspace={action:'suggest',draftText:'',contextText:'',includeRelationshipContext:true};
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'',confirmedContact:true,workspace});
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/工作区动作帮我想想关系背景已启用尚未确认立场。|园艺甲|园艺短条目完整结束/);
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'园艺',confirmedContact:true});
 assert.equal(f.requests.length,3);assert.ok(JSON.stringify(f.requests[2]).includes('园艺'+'甲'.repeat(599)));assert.match(JSON.stringify(f.requests[2]),/园艺短条目完整结束。/);
 assert.equal((await service.view(contactId,d.id)).at(-1).candidates[0].basis[0].verification,'actual_input');
});

test('固定合成容量标定：15个场景、8条画像和两次大段正文仍受完整provider预算约束',async t=>{
 let directoryNos;
 const f=await publishedReplyFixture(t,{documents:{sceneCount:15,sceneBody:'园艺场景完整段落。'+'合'.repeat(1735)+'。',profileBodies:Array.from({length:8},(_,n)=>`园艺画像完整陈述${n}：`+'成'.repeat(120)+'。')},
  onRequest:async(_req,res,request,n)=>{
   if(n===1)directoryNos=[...JSON.stringify(request).matchAll(/\[(\d+)\] document\\n【主题目录】/g)].map(match=>Number(match[1]));
   if(n===1){toolResponse(res,'search_relationship_memory',{query:'园艺'});return true;}
   if(n>3)return;toolResponse(res,'read_relationship_document',{itemNo:directoryNos[n-2],startBlock:1,blockCount:1});return true;
  },content:JSON.stringify({candidates:[{parts:['有界合成建议。'],basis:[1]}]})});
 const {resolveHostReplyConfiguration}=await import('../src/host/host-reply-config.ts');
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');
 // 容量标定复用正式容量、执行期限及安全余量；供应商仍是本机替身，输出固定为512。
 f.model.budgetProfile=normal.model.budgetProfile;f.model.deadline_ms=normal.model.deadline_ms;
 for(let n=0;n<8;n++)await f.docs.management.decide({requestKey:`capacity-${n}`,action:'manual',scope:n<5?{scopeKind:'contact',contactId:f.contactId}:{scopeKind:'self',contactId:null},body:`园艺偏好${n}：`+'植'.repeat(n<5?100:60)+'。'});
 await f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'园艺',confirmedContact:true}).catch(error=>{t.diagnostic(JSON.stringify({requests:f.requests.length,supplierErrors:f.supplierErrors.map(e=>e.message)}));throw error;});
 assert.equal(f.requests.length,4);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId}),documents=actual.filter(row=>row.kind==='document').map(row=>({text:row.text_body,projection:JSON.parse(row.identity_json).projection}));
 assert.equal(documents.filter(row=>row.projection.kind==='directory').length,12);
 const profile=documents.find(row=>row.projection.kind==='profile');assert.ok(profile.text.length<=1200);assert.equal(profile.projection.statementNos.length,7);assert.match(profile.text,/成。/);
 assert.equal(documents.filter(row=>row.projection.kind==='blocks').length,2);
 assert.equal(actual.filter(row=>row.kind==='memory').length,8);
 const budgets=await f.storage.execute('fixture.budgets',{ownerId:f.owner});assert.equal(budgets.length,4);
 assert.ok(budgets.every(b=>b.input_tokens+b.maxTokens+b.safety_margin_tokens<=b.context_window_tokens));
 t.diagnostic('完整provider预算：'+JSON.stringify(budgets.map(b=>({tokens:b.input_tokens,bytes:b.serialized_bytes,context:b.context_window_tokens,output:b.maxTokens,margin:b.safety_margin_tokens}))));
 t.diagnostic('实际资料：'+JSON.stringify({directory:12,profileStatements:profile.projection.statementNos.length,profileChars:profile.text.length,documentReads:2,documentChars:documents.filter(row=>row.projection.kind==='blocks').map(row=>row.text.length),memory:actual.filter(row=>row.kind==='memory').length}));
});


test('正文工具后Skill降级把保留正文重新放入物理请求，读取预算不随降级重置',async t=>{
 let f,directoryNos,bodyNo;
 f=await publishedReplyFixture(t,{documents:{sceneCount:2},onRequest:async(_req,res,request,n)=>{
  const wire=JSON.stringify(request);
  if(n===1){directoryNos=[...wire.matchAll(/\[(\d+)\] document\\n【主题目录】/g)].map(match=>Number(match[1]));toolResponse(res,'read_relationship_document',{itemNo:directoryNos[n===2?1:0],startBlock:1,blockCount:1});return true;}
  if(n===2){bodyNo=Number(wire.match(/实际输入材料\[(\d+)\]/)[1]);toolResponse(res,'read_relationship_document',{itemNo:directoryNos[n===2?1:0],startBlock:1,blockCount:1});return true;}
  if(n===3){await unlink(join(f.skillRoot,'gentle/SKILL.md'));toolResponse(res,'skill',{name:'gentle'});return true;}
  if(n===4){assert.match(wire,/场景专有正文/,'降级后的物理请求必须包含保留正文');toolResponse(res,'read_relationship_document',{itemNo:directoryNos[n===2?1:0],startBlock:1,blockCount:1});return true;}
 },content:request=>{
  const wire=JSON.stringify(request);assert.match(wire,/场景专有正文/);assert.match(wire,/资料读取被拒绝/,'降级不能重置已用两次的正文预算');
  return JSON.stringify({candidates:[{parts:['合成有限资料回复。'],basis:[bodyNo]}]});
 }});
 await mkdir(join(f.skillRoot,'gentle'),{recursive:true});await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成安慰策略\n---\n温和回应。\n');
 const skill=await f.library.discover('gentle');await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 await f.turns.generate({contactId:f.contactId,discussionId:f.discussionId,requestKey:randomUUID(),text:'园艺',confirmedContact:true});
 assert.equal(f.requests.length,5);
 const view=(await f.service.view(f.contactId,f.discussionId))[0];assert.equal(view.skillWarning,'回复策略暂不可用');
 assert.equal(view.candidates[0].basis[0].verification,'actual_input');assert.equal(view.candidates[0].basis[0].itemNo,bodyNo);
 assert.match(view.candidates[0].basis[0].text,/场景专有正文/);
 const actual=await f.storage.execute('fixture.input',{ownerId:f.owner,discussionId:f.discussionId});
 assert.equal(actual.filter(row=>JSON.parse(row.identity_json).projection?.kind==='blocks').length,2);
 assert.match(JSON.stringify(f.requests.at(-1)),/场景专有正文/);
});


test('来源状态更新使派生文档失效时初始召回省略，旧冻结文档仍拒绝使用',async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs'),{record}=await import('./fixtures/memory-sqlite/support.mjs');
 const f=await documentFixture(t,{registryModule:new URL('./fixtures/sqlite-reply-candidates/document-registry.mjs',import.meta.url).href});
 await f.extraction.start('bounded-stale-documents');await f.extraction.waitForIdle();
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},before=await f.storage.execute('fixture.knowledge',scope);
 assert.equal(before.length,2);const directory=before.find(item=>item.projection?.kind==='directory');
 f.channel.page=async(_scope,target)=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。',status:'2'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 assert.deepEqual(await f.storage.execute('fixture.knowledge',scope),[],'省略失效发布集合，不阻断可用聊天的回复');
 await assert.rejects(f.storage.execute('fixture.requireDocument',{...scope,item:directory}),{code:'document_knowledge_stale'});
 await assert.rejects(f.storage.execute('fixture.readDocument',{...scope,item:directory,range:{startBlock:1,blockCount:1}}),{code:'document_knowledge_stale'});
});

test('模型显式查询后才计算语义，同义记忆可召回，语义模型缺失或失败仍以词法继续生成',async t=>{
 const query='想去徒步';
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n%2===0)return;assert.doesNotMatch(JSON.stringify(request),/他喜欢爬山|公司报销流程/);toolResponse(res,'search_relationship_memory',{query});return true;
 },content:memoryReply}),contactId=f.ids[0];
 const management=new SqliteMemoryManagement(f.storage,f.owner);
 for(const [index,body] of ['他喜欢爬山。','公司报销流程复杂。'].entries())await management.decide({requestKey:`semantic-${index}`,action:'manual',scope:{scopeKind:'contact',contactId},body});
 const workspace={action:'express',draftText:'想去徒步',contextText:'',includeRelationshipContext:true};
 const embed=async texts=>texts.map(text=>/徒步|爬山/.test(text)?[1,0]:[0,1]);
 const run=async options=>{
  const before=f.requests.length,queries=[];
  const measuredEmbed=options.embed?async texts=>{assert.equal(f.requests.length,before+1,'语义评分只能在初次provider请求返回工具调用后运行');queries.push(texts[0]);return options.embed(texts);}:undefined;
  const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},...(measuredEmbed?{embed:measuredEmbed}:{})});t.after(()=>turns.close());
  await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:workspace.draftText,confirmedContact:true,workspace});
  assert.equal(f.requests.length,before+2);assert.deepEqual(queries,measuredEmbed?[query]:[]);
  return JSON.stringify(f.requests[before+1]);
 };
 const withSemantics=await run({embed});
 assert.ok(withSemantics.includes('他喜欢爬山'),'语义相近的记忆应被补充');assert.ok(!withSemantics.includes('公司报销流程'),'语义无关的记忆不进入');
 assert.ok(!(await run({})).includes('他喜欢爬山'),'未装配语义模型时退回词法');
 assert.ok(!(await run({embed:async()=>{throw new Error('模型未准备');}})).includes('他喜欢爬山'),'语义模型失败时退回词法且不阻断生成');
});
