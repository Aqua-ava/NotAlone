import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {fixture as replyFixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

// 每版使用不同的真实像素，避免靠PNG尾部拼字节伪造换图身份。
const imageBytes=revision=>sharp({create:{width:8,height:6,channels:3,background:{r:((revision-1)*97)%256,g:((revision-1)*53)%256,b:255}}}).png().toBuffer();
function imageAdapter(){let revision=0;return {version:'synthetic-memory-image-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',
 async execute(context){
  const bytes=await imageBytes(++revision);
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-memory-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-memory-image'}};
 }};}
function documentItem(value){
 if(typeof value==='string')return Number(value.match(/\[(\d+)\] document\n/u)?.[1])||null;
 if(value&&typeof value==='object')for(const child of Object.values(value)){const result=documentItem(child);if(result)return result;}
 return null;
}
async function imageFixture(t,options={}){
 const f=options.reply?await replyFixture(t,{synchronizeHistory:false,content:request=>{const basis=documentItem(request);assert.ok(basis);return JSON.stringify({candidates:[{parts:['依据合成图片资料生成的候选'],basis:[basis]}]});}}):await fixture(t,options.registryModule?{registryModule:options.registryModule}:{});
 const service=f.service??f.history,saved=f.saved??f.ids.map(contact_id=>({contact_id})),contactId=saved[0].contact_id,records=[],holders=f.holders??new ActiveHolders();
 f.channel.page=async(_scope,target)=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[...records],completedPartitions:['shard-a'],exhausted:true,...(options.incremental?{resumeCursor:'tail-1'}:{})});
 const media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:service,userData:f.root,adapters:[imageAdapter()],holders});
 await media.initialize();t.after(()=>media.close());
 const sync=async(next)=>{records.push(...next);await f.contacts.setReading(true);await service.synchronize(contactId);return (await service.read(contactId)).messages;};
 return {...f,service,saved,contactId,holders,media,sync,replyRequests:f.requests};
}
async function saveImage(f,id='2'){
 const messages=await f.sync([record(id,{kind:'image',text:null,originalType:'3'})]),message=messages.find(item=>item.kind==='image');
 const saved=await f.media.extract(f.contactId,message.id,{requestKey:`save-${id}`,goal:'extract'});
 const file=saved.files[0];return {message,file};
}
test('记忆只读取已冻结的实际图片副本，关闭同步仍可读且跨联系人和错误版本拒绝',async t=>{
 const f=await imageFixture(t),{message,file}=await saveImage(f);
 await f.contacts.setReading(false);
 const snapshot=await f.storage.execute('media.file',{ownerId:owner,contactId:f.contactId,messageId:message.id,fileId:file.fileId});
 let checks=0;
 const input={contactId:f.contactId,messageId:message.id,fileId:file.fileId,sha256:snapshot.digest,mediaGeneration:snapshot.generation,
  mimeType:snapshot.mimeType,byteSize:Number(snapshot.byteSize),signal:new AbortController().signal,requireCurrent:async()=>{checks++;}};
 const actual=await f.media.readMemoryImage(input);
 assert.equal(actual.mimeType,'image/png');assert.deepEqual(Buffer.from(actual.dataBase64,'base64'),await imageBytes(1));
 assert.equal(checks,2,'字节读取前后均复验当前记忆任务');
 await assert.rejects(f.media.readMemoryImage({...input,contactId:f.saved[1].contact_id}));
 await assert.rejects(f.media.readMemoryImage({...input,sha256:'0'.repeat(64)}),{code:'memory_extraction_source_stale'});
 await assert.rejects(f.media.readMemoryImage({...input,mediaGeneration:'999'}),{code:'memory_extraction_source_stale'});
 const aborted=new AbortController();aborted.abort();await assert.rejects(f.media.readMemoryImage({...input,signal:aborted.signal}));
});

const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
function contentSupplier({imageFact=false,imageTopic='other'}={}){
 const normal=supplier(),messages=new Map(),requests=[];
 return {requests,async respond(request,input){
  requests.push(request);const body=JSON.parse(request.user);
  if(request.purpose==='extraction'){
   for(const message of body.messages)messages.set(message.message_id,message);
   const response=await normal.respond({...request,user:JSON.stringify({...body,messages:body.messages.filter(message=>message.text_representation!=='image'&&message.content_kind!=='image'&&body.target_message_ids.includes(message.message_id))})},input);
   const image=body.messages.find(message=>message.content_kind==='image'&&body.target_message_ids.includes(message.message_id));
   if(!imageFact||!image)return response;
   const value=JSON.parse(response.blocks[0].arguments);
   value.scenes[0].memories.push({text:'聊天图片中有一个蓝色杯子。',subject:'contact',category:'common_fact',topic:imageTopic,source_message_ids:[image.message_id],
    confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],
    interpretation_reason:'仅保留合成图片中的可见物体，不推断归属。',event:null,conditions:null});
   const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
  }
  if(!request.images?.length)return normal.respond(request,input);
  const facet={verdict:'supported',evidence_indices:[0],explanation:'合成来源明确支持该事实。'};
  const value={results:body.candidates.map((candidate,candidate_index)=>{
   const message=messages.get(candidate.source_message_ids[0]);
   const evidence=message.content_kind==='image'?{kind:'image',message_id:message.message_id,quote:null,description:'合成图片中可见一个蓝色杯子。'}:
    {kind:'text',message_id:message.message_id,quote:message.text,description:null};
   return {candidate_index,verdict:'supported',issues:[],evidence:[evidence],
    scope_subject:candidate.subject==='self'?'self':'contact',actor_kind:candidate.subject==='self'?'self':'contact',resolution:'explicit',
    checks:['attribution','body','temporal_and_modality',...fields].map(field=>({field,...facet}))};
  })};
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 }};
}
async function memoryFixture(t,options){
 const f=await imageFixture(t,options),supplied=contentSupplier(options),failures=[];let extraction;
 const model=modelPort(()=>extraction.accounting,async(request,input)=>{try{return await supplied.respond(request,input);}catch(error){failures.push(String(error));throw error;}});
 extraction=new SqliteMemoryExtraction(f.storage,owner,model,f.holders,undefined,undefined,undefined,
  {registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>extraction.close());const management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'contact',contactId:f.contactId};
 const extract=async key=>{const run=await extraction.start(key);await extraction.waitForIdle(run.runId);const done=await extraction.read(run.runId);
  assert.ok(done.tasks.filter(task=>task.scopeKind==='contact').every(task=>task.state==='succeeded'),JSON.stringify({tasks:done.tasks,failures}));
  await management.importRun(run.runId);return run;};
 const accept=async body=>{const candidate=(await management.read(scope)).candidates.find(item=>item.body===body);
  assert.ok(candidate,body);return management.decide({requestKey:`accept-${body}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});};
 return {...f,extraction,management,scope,extract,accept,requests:supplied.requests};
}
for(const action of ['clear','replace'])test(`图片${action==='clear'?'清除':'替换'}后擦除实际看过旧图的记忆与追踪，同联系人独立文字保留`,async t=>{
 const f=await memoryFixture(t);
 await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);
 const oldRun=await f.extract('independent-text');const oldMemory=await f.accept('联系人长期喜欢合成园艺。');
 const {message,file}=await saveImage(f);
 await f.sync([record('3',{text:'我长期喜欢合成木雕。'})]);
 const imageRun=await f.extract('mixed-image-text');const imageMemory=await f.accept('联系人长期喜欢合成木雕。');
 const imageTask=imageRun.tasks.find(task=>task.scopeKind==='contact'),oldTask=oldRun.tasks.find(task=>task.scopeKind==='contact');
 assert.ok(f.requests.some(request=>request.images?.some(image=>image.id===file.fileId&&image.dataBase64)),'模型实际输入包含受管图片字节');
 assert.ok((await f.extraction.trace(imageTask.taskId)).events.some(event=>event.kind==='model_input'));
 const saved=action==='clear'?await f.media.clear(f.contactId,message.id,'clear-memory-image'):
  await f.media.extract(f.contactId,message.id,{requestKey:'replace-memory-image',goal:'extract'});
 if(action==='clear'){assert.equal(saved.state,'cleared');assert.deepEqual(saved.files,[]);}else assert.notEqual(saved.files[0].fileId,file.fileId);
 const after=await f.management.read(f.scope);
 assert.equal(after.memories.find(memory=>memory.id===oldMemory.memoryId).current.body,'联系人长期喜欢合成园艺。');
 assert.equal(after.memories.find(memory=>memory.id===imageMemory.memoryId).current,null);
 await assert.rejects(f.extraction.trace(imageTask.taskId),{code:'memory_extraction_not_found'});
 assert.ok((await f.extraction.trace(oldTask.taskId)).events.some(event=>event.kind==='model_input'));
 assert.equal((await f.service.read(f.contactId)).messages.length,3,'清媒体不删除原消息占位或其他消息');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际图片证据可采纳为记忆，清除图片同时擦除图片引用和记忆正文',async t=>{
 const f=await memoryFixture(t,{imageFact:true}),{message,file}=await saveImage(f);
 const run=await f.extract('image-evidence-memory'),adopted=await f.accept('聊天图片中有一个蓝色杯子。');
 const before=await f.management.read(f.scope),memory=before.memories.find(item=>item.id===adopted.memoryId);
 assert.equal(memory.current.sources[0].contentKind,'image');assert.equal(memory.current.sources[0].contentRef.file_id,file.fileId);
 assert.equal(memory.current.sources[0].quote,'','图片证据不伪造文字引句或字符范围');
 const originalDigest=createHash('sha256').update(await imageBytes(1)).digest('hex'),sent=f.requests.flatMap(request=>request.images??[]).find(image=>image.id===file.fileId);
 assert.equal(memory.current.sources[0].contentRef.sha256,originalDigest,'图片依据始终保留原始受管文件摘要');
 assert.equal(sent.sourceSha256,originalDigest);assert.equal(sent.mimeType,'image/jpeg');assert.equal((await sharp(Buffer.from(sent.dataBase64,'base64')).metadata()).format,'jpeg');
 assert.notEqual(createHash('sha256').update(Buffer.from(sent.dataBase64,'base64')).digest('hex'),originalDigest,'发送版本与来源身份分别记量');
 await f.media.clear(f.contactId,message.id,'clear-direct-image-evidence');
 const after=(await f.management.read(f.scope)).memories.find(item=>item.id===adopted.memoryId);
 assert.equal(after.current,null);assert.ok(after.versions.every(version=>version.body===null&&version.sources.length===0));
 await assert.rejects(f.extraction.trace(run.tasks.find(task=>task.scopeKind==='contact').taskId),{code:'memory_extraction_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const queue of ['history','incremental'])test(`替换图片后${queue==='history'?'历史':'增量'}自动队列会重新处理新文件版本`,async t=>{
 const f=await memoryFixture(t,{imageFact:true,incremental:queue==='incremental'});let message,file;
 if(queue==='history')({message,file}=await saveImage(f));
 else{
  await f.sync([record('1',{text:'我长期喜欢合成园艺。'})]);await f.extract('incremental-image-baseline');await f.accept('联系人长期喜欢合成园艺。');
  const token=await f.contacts.eligibility(f.contactId),coverage=await f.service.coverage(f.contactId);
  await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
   page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:[record('2',{kind:'image',text:null,originalType:'3'})]},
   at:Date.now()-60*60_000,runtimeToken:f.storage.status.runtimeId});
  message=(await f.service.read(f.contactId)).messages.find(item=>item.kind==='image');
  file=(await f.media.extract(f.contactId,message.id,{requestKey:'incremental-save',goal:'extract'})).files[0];
 }
 await f.extract(`before-${queue}-image-upgrade`);await f.accept('聊天图片中有一个蓝色杯子。');
 const upgraded=await f.media.extract(f.contactId,message.id,{requestKey:`replace-${queue}-image`,goal:'extract'});
 assert.notEqual(upgraded.files[0].fileId,file.fileId);
 const now=Date.now()+30*60_000,due=queue==='history'?await f.extraction.dueHistoryContacts(now):await f.extraction.dueContacts(now);
 assert.ok(due.includes(f.contactId),'旧图依赖擦除后，新图必须进入原有自动队列');
 const run=queue==='history'?await f.extraction.startHistoryBatch(f.contactId,'history-image-upgrade-auto',now):await f.extraction.startContact(f.contactId,'incremental-image-upgrade-auto',now);
 assert.ok(run);await f.extraction.waitForIdle(run.runId);
 assert.equal((await f.extraction.read(run.runId)).succeeded,1);
 assert.ok(f.requests.some(request=>request.images?.some(image=>image.id===upgraded.files[0].fileId)),'重处理实际使用新图片版本');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const action of ['clear','replace'])test(`在途图文模型被${action==='clear'?'清图':'换图'}中止，排空后不保留旧图追踪或重发未知调用`,{timeout:10000},async t=>{
 const f=await imageFixture(t),{message}=await saveImage(f);let extraction,entered;
 const ready=new Promise(resolve=>{entered=resolve;});let aborted=false;
 const port=modelPort(()=>extraction.accounting,async(request,input)=>{
  assert.equal(request.images.length,1);entered();
  await new Promise((resolve,reject)=>{const abort=()=>{aborted=true;reject(input.signal.reason);};
   input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();});
  throw new Error('合成模型不应在删除后继续');
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,port,f.holders,undefined,undefined,undefined,
  {registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>extraction.close());
 const run=await extraction.start('inflight-image-memory');await ready;
 const result=action==='clear'?await f.media.clear(f.contactId,message.id,'clear-inflight-image'):
  await f.media.extract(f.contactId,message.id,{requestKey:'replace-inflight-image',goal:'extract'});
 await extraction.waitForIdle();assert.equal(aborted,true);
 if(action==='clear'){assert.equal(result.state,'cleared');assert.deepEqual(result.files,[]);}else assert.equal(result.files.length,1);
 await assert.rejects(extraction.trace(run.tasks.find(task=>task.scopeKind==='contact').taskId),{code:'memory_extraction_not_found'});
 assert.ok(!(await extraction.dueHistoryContacts(Date.now()+60*60_000)).includes(f.contactId),'未知派发不能通过换图进入自动重发队列');
 assert.equal(port.calls,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('图片记忆无旧资料时可自动采纳，后续图文关系比较保留带类型来源并安静待确认',async t=>{
 const f=await memoryFixture(t,{imageFact:true}),{file}=await saveImage(f),run=await f.extract('automatic-image-memory');
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,undefined,f.holders);t.after(()=>adjudication.close());
 await adjudication.publishRun(run.runId);
 const initial=await f.management.read(f.scope),memory=initial.memories.find(item=>item.current?.body==='聊天图片中有一个蓝色杯子。');
 assert.ok(memory);assert.equal(memory.current.adoptionMode,'auto');assert.equal(memory.current.versionNo,'1');
 await f.sync([record('3',{text:'我长期喜欢合成木雕。'})]);const next=await f.extract('image-relation-pending');
 await adjudication.publishRun(next.runId);
 const after=await f.management.read(f.scope),retained=after.memories.find(item=>item.id===memory.id);
 assert.equal(retained.current.versionNo,'1');assert.equal(retained.current.body,memory.current.body);
 assert.equal(after.candidates.find(item=>item.body==='联系人长期喜欢合成木雕。').state,'pending');
 const trace=await f.extraction.trace(next.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.ok(trace.events.some(event=>event.kind==='adjudication_result'&&event.payload.reason==='memory_media_relation_pending'));
 const imageSources=[];const visit=value=>{if(!value||typeof value!=='object')return;if(value.content_kind==='image'&&value.content_ref)imageSources.push(value);for(const child of Object.values(value))visit(child);};
 for(const event of trace.events.filter(item=>item.kind==='adjudication_basis'))visit(event.payload);
 assert.ok(imageSources.length);assert.ok(imageSources.every(source=>source.text===null&&source.content_ref.file_id===file.fileId&&source.observation.kind==='model_observation'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('图片记忆与文字候选主题不同时不拦截自动裁决，主题相同才保留待确认',async t=>{
 const f=await memoryFixture(t,{imageFact:true,imageTopic:'travel'});await saveImage(f);const run=await f.extract('automatic-image-memory-topic');
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,undefined,f.holders);t.after(()=>adjudication.close());
 await adjudication.publishRun(run.runId);
 const initial=await f.management.read(f.scope),imageMemory=initial.memories.find(item=>item.current?.body==='聊天图片中有一个蓝色杯子。');
 assert.ok(imageMemory);
 await f.sync([record('3',{text:'我长期喜欢合成木雕。'})]);const next=await f.extract('image-topic-differs');
 await adjudication.publishRun(next.runId);
 const after=await f.management.read(f.scope),retained=after.memories.find(item=>item.id===imageMemory.id);
 assert.equal(retained.current.versionNo,'1');assert.equal(retained.current.body,imageMemory.current.body,'图片记忆不被改动');
 const wood=after.memories.find(item=>item.current?.body==='联系人长期喜欢合成木雕。');
 assert.ok(wood,'主题不同的文字候选应自动采纳');assert.equal(wood.current.adoptionMode,'auto');
 assert.equal(after.candidates.filter(item=>item.state==='pending').length,0);
 const trace=await f.extraction.trace(next.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.ok(!trace.events.some(event=>event.kind==='adjudication_result'&&event.payload.reason==='memory_media_relation_pending'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

function documentSupplier(){return async request=>{
 const payload=JSON.parse(request.messages[0].content[0].text),memory=payload.memories[0],names=request.tools.map(item=>item.name);
 const tool=(name,args)=>({blocks:[{type:'tool-call',name,arguments:JSON.stringify(args)}]});
 if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
 if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
 if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'synthetic-image.md',content:`<!-- META ${JSON.stringify({topic_key:'synthetic-image',title:'合成图片资料',hint:'可追溯的图片观察'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
 if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'合成正式记忆直接记载图片观察。',temporal_status:'historical',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
 throw new Error('未知合成文档请求');
};}

test('图片来源沿正式记忆、场景文档、回复及受管运行记录完整删除',{timeout:20000},async t=>{
 const f=await memoryFixture(t,{imageFact:true,reply:true}),{message}=await saveImage(f);
 const run=await f.extract('image-documents-reply');await f.accept('聊天图片中有一个蓝色杯子。');
 const documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>f.extraction.accounting,documentSupplier()),f.holders);t.after(()=>documents.close());
 await documents.publishRun(run.runId);const before=await documents.read(f.scope);
 assert.ok(before.publication?.members.length,'正常文档阶段已发布图片派生资料');
 const reply=new SqliteReplyCandidateService(f.storage,owner),turns=new SqliteReplyTurns({...f,service:reply,authorize:async()=>{}});t.after(()=>turns.close());
 const discussion=await f.discussions.newDiscussion(f.contactId);
 await turns.generate({contactId:f.contactId,discussionId:discussion.id,requestKey:'image-document-reply',text:'参考图片资料写一句',confirmedContact:true});
 const candidate=(await reply.view(f.contactId,discussion.id))[0].candidates[0];
 assert.equal(candidate.basis[0].kind,'document');assert.equal(candidate.basis[0].verification,'actual_input');
 assert.equal(f.replyRequests.length,1,'实际DSH请求只发给本机合成供应商');
 const cleared=await f.media.clear(f.contactId,message.id,'clear-image-with-document-reply');assert.equal(cleared.state,'cleared');
 assert.equal((await documents.read(f.scope)).publication,null);
 assert.ok((await reply.view(f.contactId,discussion.id)).every(entry=>entry.candidates.length===0));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

const imageLaterRegistry=new URL('./fixtures/memory-documents/image-later-registry.mjs',import.meta.url).href;
async function imageLaterFixture(t,key){
 const f=await memoryFixture(t,{imageFact:true,registryModule:imageLaterRegistry}),saved=await saveImage(f);
 const run=await f.extract(key);await f.accept('聊天图片中有一个蓝色杯子。');
 const requests=[],respond=documentSupplier();
 const documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>f.extraction.accounting,async request=>{requests.push(request);return respond(request);}),f.holders);t.after(()=>documents.close());
 await documents.enrollRun(run.runId);return {...f,...saved,documents,documentRequests:requests};
}

test('图片L1记忆经独立L2与L3轮次冻结原图身份，文字文档请求不发送图片，正式清图覆盖全部派生来源',{timeout:20000},async t=>{
 const f=await imageLaterFixture(t,'image-later-documents-closure'),schedule=await f.documents.readSchedule(f.scope);
 const jobs=await f.documents.runDueStages(schedule.scene.dueAt);
 assert.equal(jobs.length,2,JSON.stringify(jobs));assert.deepEqual(jobs.map(job=>job.stage),['document_scene','document_profile']);
 assert.ok(jobs.every(job=>job.state==='succeeded'));assert.equal((await f.documents.read(f.scope)).publication.members.length,2);
 const inputs=await f.storage.execute('fixture.imageLaterInputs',{ownerId:owner});assert.equal(inputs.length,2);
 for(const input of inputs){
  assert.equal(input.content_kind,'image');assert.equal(input.plugin_id,'notalone.image');assert.equal(input.plugin_version,'1');assert.equal(input.message_id,f.message.id);
  const identity=JSON.parse(input.identity_json);assert.equal(identity.fileId,f.file.fileId);assert.equal(identity.sha256,createHash('sha256').update(await imageBytes(1)).digest('hex'));
  assert.equal(identity.mimeType,'image/png');assert.equal(identity.byteSize,(await imageBytes(1)).length);assert.ok(/^\d+$/.test(identity.mediaGeneration));
  assert.equal(await f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:input.run_id}),true);
 }
 assert.ok(f.documentRequests.length>0);
 for(const request of f.documentRequests){assert.equal(request.images,undefined);assert.ok(!JSON.stringify(request).includes((await imageBytes(1)).toString('base64')));assert.ok(request.messages.every(message=>!Array.isArray(message.content)||message.content.every(block=>block.type!=='image')));}
 await f.media.clear(f.contactId,f.message.id,'clear-image-later-documents');
 assert.equal((await f.documents.read(f.scope)).publication,null);assert.deepEqual(await f.storage.execute('fixture.imageLaterInputs',{ownerId:owner}),[]);
 for(const job of jobs)await assert.rejects(f.extraction.trace(job.taskId),{code:'memory_extraction_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('独立文档轮已冻结图片后复验当前原图摘要，摘要变化不能沿旧身份继续',{timeout:20000},async t=>{
 const f=await imageLaterFixture(t,'image-later-current-digest'),schedule=await f.documents.readSchedule(f.scope);
 const job=await f.storage.execute('memoryDocuments.claimDue',{ownerId:owner,now:schedule.scene.dueAt});assert.ok(job.runId,JSON.stringify(job));
 assert.equal(await f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:job.runId}),true);
 await f.storage.execute('fixture.imageLaterDigestChange',{ownerId:owner,fileId:f.file.fileId});
 await assert.rejects(f.storage.execute('fixture.imageLaterRevalidate',{ownerId:owner,runId:job.runId}),{code:'memory_content_source_stale'});
 assert.equal(f.documentRequests.length,0,'当前图身份不符时尚未调用文档模型');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('后续文档来源已失去可冻结内容时不留下preparing半轮或发起模型调用',{timeout:20000},async t=>{
 const f=await imageLaterFixture(t,'image-later-missing-snapshot'),schedule=await f.documents.readSchedule(f.scope);
 const observed=await f.storage.execute('fixture.imageLaterMissingSnapshot',{ownerId:owner,now:schedule.scene.dueAt});
 assert.deepEqual(observed.result,{failed:true,errorCode:'memory_content_source_stale'});assert.equal(observed.after,observed.before);
 assert.equal(f.documentRequests.length,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
