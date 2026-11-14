import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {documentFixture} from './fixtures/memory-documents/support.mjs';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const registryModule=new URL('./fixtures/sqlite-reply-candidates/read-validation-registry.mjs',import.meta.url).href;
const skillRun={packages:[],eligible:[]},configurationDigest='c'.repeat(64);
const budget={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,input_tokens:12,serialized_bytes:128,measurement_kind:'approximate',measurement_id:'synthetic-estimate',request_sha256:'a'.repeat(64)};
async function publishedFixture(t){
 const f=await documentFixture(t,{registryModule,sceneCount:3});
 await f.extraction.start('candidate-read-validation');await f.extraction.waitForIdle();
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents.length,4);
 const discussion=await new SqliteDiscussionService(f.storage,f.owner).newDiscussion(f.contactId),candidates=new SqliteReplyCandidateService(f.storage,f.owner);
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:discussion.id};
 return {...f,scope,candidates};
}
async function commitCandidates(f,candidateCount){
 const requestKey=randomUUID(),confirmationId=await f.storage.execute('identity.manualConfirm',{...f.scope,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await f.candidates.begin({...f.scope,requestKey,text:'园艺',identity:{kind:'manual',confirmationId}});
 const input={...attempt,contextId:randomUUID(),callId:randomUUID(),copyId:randomUUID(),configurationDigest};
 await f.storage.execute('reply.freezeInput',{...input,skillRun,items:[],queryText:'园艺',at:Date.now()});
 await f.storage.execute('discussion.prepareCall',{...input,operationId:randomUUID(),provider:budget.provider,requestKey:input.callId,inputSeal:'b'.repeat(64),model:budget.model,configurationId:configurationDigest,inputCap:1024,outputCap:512});
 await f.storage.execute('runtime.prepare',{...input,sdkInstanceId:randomUUID(),locator:input.copyId});
 const files=new ManagedFiles(f.root);files.prepareArea('runtime');await mkdir(join(f.root,'managed/runtime-copies',input.copyId),{mode:0o700});
 await f.storage.execute('runtime.attach',{...input,address:files.capture('runtime',input.copyId,'directory')});await f.storage.execute('runtime.incorporate',input);
 // 外部供应商仅以合成响应事件代替；资料、来源、候选提交及回看使用正式 SQLite 动作。
 await f.storage.execute('reply.dispatchCall',{...input,skillRun,budget,requestPayload:{messages:['园艺合成请求']}});
 await f.storage.execute('discussion.settleStep',{...input,usage:{inputTokens:5,outputTokens:3},reason:'stop'});
 const text=JSON.stringify({candidates:Array.from({length:candidateCount},(_,index)=>({parts:[`园艺合成候选${index+1}`],basis:[1]}))});
 await f.storage.execute('reply.commitCandidates',{...input,skillRun,text,sessionEvent:{type:'assistant/message',seq:1,data:{message:{source:{provider:budget.provider,model:budget.model},content:[{type:'text',text}]},usage:{inputTokens:5,outputTokens:3},interrupted:false}}});
 return input;
}

for(const candidateCount of [1,3,5])test(`正式候选回看${candidateCount}个说法与多轮请求共享资料时，完整核验不随候选和历史重复`,async t=>{
 const f=await publishedFixture(t),measurements=[];
 for(let requestCount=1;requestCount<=4;requestCount++){
  await commitCandidates(f,candidateCount);
  if(![1,2,4].includes(requestCount))continue;
  const result=await f.storage.execute('fixture.measureCandidateRead',{...f.scope,action:'view'});
  assert.equal(result.value.length,requestCount);assert.ok(result.value.every(row=>row.sourceState==='available'&&row.candidates.length===candidateCount));
  const {value,...metrics}=result;measurements.push({requestCount,...metrics});t.diagnostic(JSON.stringify({candidateCount,requestCount,...metrics}));
 }
 const candidate=(await f.candidates.view(f.contactId,f.scope.discussionId)).at(-1).candidates[0];
 const version=await f.storage.execute('fixture.measureCandidateRead',{...f.scope,action:'version',candidateId:candidate.candidateId,versionNo:1});
 assert.deepEqual(version.value.parts,candidate.parts);
 assert.ok(measurements[0].verificationInputReads>0,'回看仍核对真实记忆的模型验证凭据');
 for(const result of measurements){
  assert.ok(result.dependencyChecks<=result.requestCount,`完整请求依赖应每轮核验一次，实际${result.dependencyChecks}次`);
  assert.ok(result.contextChecks<=result.requestCount,`冻结输入应每轮核验一次，实际${result.contextChecks}次`);
  assert.equal(result.verificationInputReads,measurements[0].verificationInputReads,'相同冻结资料的证明不能随历史请求重新读取');
 }
 assert.equal(version.dependencyChecks,1,'版本回看使用相同的完整依赖复用入口');
 assert.equal(version.verificationInputReads,measurements[0].verificationInputReads,'版本入口不重复核验同一冻结资料');
});

test('已验证候选在同一动作写入修订、删除、撤权或结清派生状态后重新拒绝，下一动作也重新核验',async t=>{
 const f=await publishedFixture(t);await commitCandidates(f,3);
 for(const mutation of ['revision','delete','revoke','flush']){
  const checked=await f.storage.execute('fixture.recheckCandidateRead',{...f.scope,mutation});
  assert.deepEqual(checked,{before:3,after:0,restored:3},`${mutation}不能沿用写入前资格`);
 }
 assert.deepEqual(await f.storage.execute('fixture.writeDuringCandidateValidation',f.scope),{before:3,after:0,restored:3},'验证期间写入后不能登记写入前成功');
 const memory=(await f.management.read({scopeKind:'contact',contactId:f.contactId})).memories[0];
 await f.management.decide({requestKey:'candidate-read-correction',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'纠正后的合成资料不再支持园艺候选。'});
 assert.ok((await f.candidates.view(f.contactId,f.scope.discussionId)).every(row=>row.candidates.length===0),'跨动作纠错后不能恢复原候选');
});

test('完整冻结快照及归属分别核验，失败不会借用同动作已有的成功',async t=>{
 const f=await publishedFixture(t);await commitCandidates(f,3);
 const failures=await f.storage.execute('fixture.checkFrozenCandidateIdentity',{...f.scope,otherContactId:f.saved[1].contact_id,otherOwnerId:randomUUID()});
 assert.equal(failures.length,8);assert.ok(failures.every(code=>typeof code==='string'&&code.length));
});

for(const mutation of ['revision','delete','revoke'])test(`候选回看成功后，下一动作的来源${mutation}使列表、版本和输入正文重新失效`,async t=>{
 const f=await publishedFixture(t);await commitCandidates(f,3);
 const rows=await f.candidates.view(f.contactId,f.scope.discussionId),candidate=rows[0].candidates[0];
 await f.storage.execute('fixture.invalidateCandidateReadSource',{...f.scope,mutation});
 assert.ok((await f.candidates.view(f.contactId,f.scope.discussionId)).every(row=>row.candidates.length===0));
 await assert.rejects(f.candidates.version({...f.scope,candidateId:candidate.candidateId,versionNo:1}),{code:'reply_source_unavailable'});
 await assert.rejects(f.candidates.inputMaterials({...f.scope,requestId:rows[0].requestId,offset:0}),{code:'reply_source_unavailable'});
});
