import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const contact='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const candidate='33333333-3333-4333-8333-333333333333',requestKey='44444444-4444-4444-8444-444444444444';
const source=contactId=>({contactId,messageId:candidate,recordId:requestKey,acceptedRevision:'1',quote:'合成来源原话'});
const item=(id,sources)=>({id,scopeKind:'self',contactId:null,verificationState:'verified',body:'本人合成候选',state:'pending',stateRevision:'0',eventId:requestKey,sources,contributingContactIds:[contact]});
async function fixture(t,handle){
 const root=await mkdtemp(path.join(tmpdir(),'notalone-memory-manager-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'controller.mjs');await build({entryPoints:['src/main/memory/sqlite-management.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(pathToFileURL(output));const calls=[],invalidations=[];
 const state={selectedContactId:contact,scopeRevision:1};let generation=1;
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>generation,requestJson:async r=>{calls.push(r);return {generation,data:await handle(r)};}},()=>invalidations.push(true),{getState:()=>state});
 return {controller,calls,invalidations,state,change:()=>{generation++;controller.synchronize();}};
}
const scope={scopeKind:'self',contactId:null},read={scope,displayContactId:contact,scopeRevision:1};
test('当前联系人页面不得读取全局本人主题与概览',async t=>{
 const f=await fixture(t,async()=>{throw new Error('本人全局概览不应请求');});
 await assert.rejects(f.controller.readDocuments(read));assert.equal(f.calls.length,0);
});
test('主进程保留记忆时间资格并对缺失状态保守处理',async t=>{
 let timeStatus='needs_revalidation';
 const version=()=>({mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus,versionNo:'1',body:'待核验时间的合成记忆',formationKind:'correction',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]});
 const f=await fixture(t,async()=>({candidates:[],memories:[{id:candidate,scopeKind:'self',contactId:null,headRevision:'1',state:'active',manualProtection:false,current:version(),versions:[version()],decisions:[]}]}));
 assert.equal((await f.controller.read(read)).view.memories[0].current.timeStatus,'needs_revalidation');
 timeStatus=undefined;assert.equal((await f.controller.read(read)).view.memories[0].current.timeStatus,'invalid');
});
test('来源聊天时间经主进程校验并保留，缺失未知不回退决定时间且非法值不发布',async t=>{
 let timing={sentAt:'1700000000123',timePrecision:'millisecond'};
 const sourceWithTime=()=>({...source(contact),...timing});
 const version=()=>({mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'1',body:'合成时间来源记忆',formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[sourceWithTime()],contributingContactIds:[contact]});
 const f=await fixture(t,async()=>({candidates:[item(candidate,[sourceWithTime()]),item(other,[{...source(other),sentAt:'1800000000000',timePrecision:'second'}])],memories:[{id:candidate,scopeKind:'self',contactId:null,headRevision:'1',state:'active',manualProtection:false,current:version(),versions:[version()],decisions:[{id:requestKey,action:'accept',actorKind:'user',createdAt:'1800000000000',expectedHeadRevision:null,expectedVersionNo:null,outcome:'applied'}]}]}));
 for(const value of [{sentAt:'1700000000123',timePrecision:'millisecond'},{sentAt:'1700000000000',timePrecision:'second'},{sentAt:null,timePrecision:null},{}]){
  timing=value;const view=(await f.controller.read(read)).view;assert.deepEqual(view.candidates.map(value=>value.id),[candidate]);
  for(const sources of [view.candidates[0].sources,view.memories[0].current.sources,view.memories[0].versions[0].sources]){
   assert.equal(sources[0].sentAt,value.sentAt??null);assert.equal(sources[0].timePrecision,value.timePrecision??null);
  }
 }
 for(const value of [{sentAt:'invalid',timePrecision:'second'},{sentAt:1700000000000,timePrecision:'second'},{sentAt:'-1',timePrecision:'second'},{sentAt:'253402300800000',timePrecision:'second'},{sentAt:'1700000000000',timePrecision:null},{sentAt:null,timePrecision:'second'},{sentAt:'1700000000000',timePrecision:'day'}]){
  timing=value;await assert.rejects(f.controller.read(read),{message:'记忆资料或范围已变化，请重新读取。'});
 }
});

test('本人管理仅返回当前联系人独立来源，具名决定不接受跨范围对象',async t=>{
 const f=await fixture(t,async()=>({candidates:[item(candidate,[source(contact)]),item(other,[source(contact),source(other)])],memories:[]}));
 const value=await f.controller.read(read);assert.equal(value.connectionGeneration,1);assert.deepEqual(value.view.candidates.map(c=>c.id),[candidate]);
 const result=await f.controller.decide({...read,connectionGeneration:1,request:{requestKey,action:'accept',candidateIds:[other],candidateRevisions:['0']}});
 assert.equal(result.status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 const count=f.calls.length;f.state.scopeRevision=2;await assert.rejects(f.controller.read(read));assert.equal(f.calls.length,count);
});
test('失效后迟到正文不回填，旧连接决定不出站',async t=>{
 let finish,entered;const pending=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;});
 const f=await fixture(t,async()=>{entered();return pending;});const old=f.controller.read(read);await started;f.change();
 finish({candidates:[item(candidate,[source(contact)])],memories:[]});await assert.rejects(old);assert.equal(f.invalidations.length,1);
 const count=f.calls.length;const stale=await f.controller.decide({...read,connectionGeneration:1,request:{requestKey,action:'accept',candidateIds:[candidate],candidateRevisions:['0']}});
 assert.equal(stale.status,'source_stale');assert.equal(f.calls.length,count);
});
test('修改采纳只提交具名用户决定，携带原候选修订，错误响应区分冲突与来源失效',async t=>{
 const {SqliteMemoryManagementController,BackendRequestFailure}=await (async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'notalone-memory-errors-'));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'errors.mjs');
  await build({stdin:{contents:"export {SqliteMemoryManagementController} from './src/main/memory/sqlite-management';export {BackendRequestFailure} from './src/main/backend/json-client';",resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(output));
 })();
 const calls=[],request={requestKey,action:'edit_accept',candidateIds:[candidate],candidateRevisions:['0'],body:'经用户修改的结论'};
 let code;const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async r=>{calls.push(r);if(r.method==='POST'){if(code)throw new BackendRequestFailure('response',409,code);return {generation:1,data:{decisionId:requestKey,memoryId:candidate,versionNo:'1',action:'edit_accept'}};}return {generation:1,data:{candidates:[item(candidate,[source(contact)])],memories:[]}};}},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 assert.equal((await controller.decide({...read,connectionGeneration:1,request})).status,'applied');
 assert.deepEqual(calls.find(r=>r.method==='POST').body,request);
 code='memory_head_conflict';assert.equal((await controller.decide({...read,connectionGeneration:1,request})).status,'conflict');
 code='memory_source_stale';assert.equal((await controller.decide({...read,connectionGeneration:1,request})).status,'source_stale');
});
test('本人候选和有正文版本按完整贡献过滤，B引句不能掩盖A+B冻结贡献',async t=>{
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'本人合成正式记忆',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};
 const memory=(id,versions)=>({id,scopeKind:'self',contactId:null,headRevision:'1',state:'active',manualProtection:false,current:versions.at(-1),versions,decisions:[]});
 const mixedVersion={...version,contributingContactIds:[other,contact]};
 const f=await fixture(t,async()=>({
  candidates:[{...item(candidate,[source(contact)]),contributingContactIds:[contact]},{...item(other,[source(contact)]),contributingContactIds:[other,contact]}],
  memories:[memory(requestKey,[version]),memory(other,[mixedVersion]),memory(candidate,[mixedVersion,{...version,versionNo:'2',previousVersionNo:'1'}]),memory('55555555-5555-4555-8555-555555555555',[{...version,formationKind:'manual',adoptionMode:'manual',sources:[],contributingContactIds:[]}])],
 }));
 const snapshot=await f.controller.read(read);
 assert.deepEqual(snapshot.view.candidates.map(c=>c.id),[candidate]);
 assert.deepEqual(snapshot.view.memories.map(m=>m.id),[requestKey]);
 assert.deepEqual(snapshot.view.candidates[0].contributingContactIds,[contact]);
 assert.deepEqual(snapshot.view.memories[0].current.contributingContactIds,[contact]);
 const result=await f.controller.decide({...read,connectionGeneration:1,request:{requestKey,action:'accept',candidateIds:[other],candidateRevisions:['0']}});
 assert.equal(result.status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('来源删除保留无正文记忆身份时返回来源失效且不再提交旧编辑',async t=>{
 const v={mergeParents:[],mergeParentCount:0,verificationState:'pending',versionNo:'1',body:null,formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'redacted',provenanceState:'invalidated',decisionId:requestKey,contributingContactIds:[],sources:[]};
 const f=await fixture(t,async r=>{if(r.method==='POST')throw new Error('来源失效不应继续写出');return {candidates:[],memories:[{id:candidate,scopeKind:'contact',contactId:contact,headRevision:'2',state:'invalidated',manualProtection:false,current:null,versions:[v],decisions:[]}]};});
 const result=await f.controller.decide({...read,scope:{scopeKind:'contact',contactId:contact},connectionGeneration:1,request:{requestKey,action:'correct',memoryId:candidate,expectedVersionNo:'1',expectedHeadRevision:'1',body:'迟到旧编辑'}});
 assert.equal(result.status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('主进程保留候选和各版本的来源核验状态，缺失或未知状态不发布',async t=>{
 let candidateState='pending',versionState='pending',parentCount=0;
 const f=await fixture(t,async()=>{
  const v={mergeParents:parentCount===2?[{memoryId:other,versionNo:'1',headRevision:'2'}]:[],mergeParentCount:parentCount,verificationState:versionState,versionNo:'1',body:'待核验正式资料',formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};
  return {candidates:[{...item(candidate,[source(contact)]),verificationState:candidateState}],memories:[{id:requestKey,scopeKind:'self',contactId:null,headRevision:'1',state:'active',manualProtection:false,current:v,versions:[v],decisions:['auto_retire','auto_noop'].map((action,index)=>({id:index?other:requestKey,action,actorKind:'system',createdAt:'1',expectedHeadRevision:'1',expectedVersionNo:'1',outcome:'applied'}))}]};
 });
 const pending=await f.controller.read(read);assert.equal(pending.view.candidates[0].verificationState,'pending');assert.equal(pending.view.memories[0].current.verificationState,'pending');assert.equal(pending.view.memories[0].versions[0].verificationState,'pending');
 candidateState=versionState='verified';parentCount=2;const verified=await f.controller.read(read);assert.equal(verified.view.candidates[0].verificationState,'verified');assert.equal(verified.view.memories[0].current.verificationState,'verified');assert.equal(verified.view.memories[0].current.mergeParentCount,2);assert.deepEqual(verified.view.memories[0].decisions.map(d=>d.action),['auto_retire','auto_noop']);
 assert.equal((await f.controller.decide({...read,connectionGeneration:1,request:{requestKey,action:'auto_noop',memoryId:requestKey,expectedVersionNo:'1',expectedHeadRevision:'1'}})).status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 for(const invalid of [undefined,'unknown',true]){candidateState=invalid;await assert.rejects(f.controller.read(read));}
 candidateState='verified';
 for(const invalid of [undefined,'unknown',true]){versionState=invalid;await assert.rejects(f.controller.read(read));}
 versionState='verified';for(const invalid of [undefined,-1,9,1.5,'2']){parentCount=invalid;await assert.rejects(f.controller.read(read));}
 assert.equal(f.invalidations.length,12);
});

test('撤回资料可沿最新有效历史版本调整保护，旧版CAS、编辑和失效资料仍拒绝',async t=>{
 const v={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'已撤回的原资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};
 let memory={id:candidate,scopeKind:'contact',contactId:contact,headRevision:'3',state:'withdrawn',manualProtection:false,current:null,versions:[v,{...v,versionNo:'2',previousVersionNo:'1'}],decisions:[]};
 const f=await fixture(t,async r=>{if(r.method==='POST'){memory={...memory,manualProtection:r.body.action==='protect',headRevision:String(Number(memory.headRevision)+1)};return {decisionId:requestKey,memoryId:candidate,versionNo:null,action:r.body.action};}return {candidates:[],memories:[memory]};});
 const command={...read,scope:{scopeKind:'contact',contactId:contact},connectionGeneration:1},request={requestKey,action:'protect',memoryId:candidate,expectedVersionNo:'2',expectedHeadRevision:'3'};
 assert.equal((await f.controller.decide({...command,request:{...request,expectedVersionNo:'1'}})).status,'source_stale');
 assert.equal((await f.controller.decide({...command,request})).status,'applied');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.equal((await f.controller.decide({...command,request:{...request,requestKey:other,action:'unprotect',expectedHeadRevision:'4'}})).status,'applied');
 assert.equal((await f.controller.decide({...command,request:{...request,action:'correct',expectedHeadRevision:'5',body:'不应从撤回资料编辑'}})).status,'source_stale');
 memory={...memory,state:'invalidated',versions:memory.versions.map(v=>({...v,body:null,contentState:'redacted',provenanceState:'invalidated'}))};assert.equal((await f.controller.decide({...command,request:{...request,expectedHeadRevision:'5'}})).status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});

test('恢复携带完整当前合并父快照，旧父头冲突、非法DTO和其他动作夹带父快照均不出站',async t=>{
 let parents=[{memoryId:other,versionNo:'1',headRevision:'2'}];
 const f=await fixture(t,async r=>{if(r.method==='POST')return {decisionId:requestKey,memoryId:candidate,versionNo:'3',action:'restore'};const v={mergeParents:parents,mergeParentCount:2,verificationState:'verified',versionNo:'2',body:'合并资料',formationKind:'change',adoptionMode:'auto',previousVersionNo:'1',restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};return {candidates:[],memories:[{id:candidate,scopeKind:'self',contactId:null,headRevision:'2',state:'active',manualProtection:false,current:v,versions:[v],decisions:[]}]};});
 const snapshot=await f.controller.read(read),context={...read,connectionGeneration:1},request={requestKey,action:'restore',memoryId:candidate,expectedVersionNo:'2',expectedHeadRevision:'2',restoredFromVersionNo:'1',expectedMergedParents:snapshot.view.memories[0].current.mergeParents};
 parents=[{...parents[0],headRevision:'4'}];assert.equal((await f.controller.decide({...context,request})).status,'conflict');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 const fresh=await f.controller.read(read),next={...request,requestKey:other,expectedMergedParents:fresh.view.memories[0].current.mergeParents};assert.equal((await f.controller.decide({...context,request:next})).status,'applied');assert.deepEqual(f.calls.find(c=>c.method==='POST').body,next);
 const {expectedMergedParents,...missing}=next;assert.equal((await f.controller.decide({...context,request:missing})).status,'source_stale');
 assert.equal((await f.controller.decide({...context,request:{requestKey,action:'protect',memoryId:candidate,expectedVersionNo:'2',expectedHeadRevision:'2',expectedMergedParents:[]}})).status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 const valid=parents[0];for(const invalid of [undefined,[],[valid,valid],[{...valid,extra:true}],[{...valid,versionNo:'0'}],[{...valid,memoryId:candidate}],Array(8).fill(valid)]){parents=invalid;await assert.rejects(f.controller.read(read));}
});
test('重复终态独立于目标是否仍有效，不冒充采纳或复活已撤销当前版本',async t=>{
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'既有合成正式资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};
 const memory=(id,state)=>({id,scopeKind:'self',contactId:null,headRevision:'1',state,manualProtection:false,current:state==='active'?version:null,versions:[version],decisions:[]});
 const candidates=[{...item(candidate,[source(contact)]),state:'duplicate',body:'对应有效目标的重复候选'},{...item(other,[source(contact)]),state:'duplicate',body:'对应已撤销目标的重复候选'},{...item(requestKey,[source(contact)]),state:'pending'},{...item('55555555-5555-4555-8555-555555555555',[source(contact)]),state:'adopted'}];
 const f=await fixture(t,async()=>({candidates,memories:[memory(candidate,'active'),memory(other,'withdrawn')]}));
 const value=await f.controller.read(read);
 assert.deepEqual(value.view.candidates.map(c=>c.state),['duplicate','duplicate','pending','adopted']);
 assert.equal(value.view.memories.find(m=>m.id===candidate).current.versionNo,'1');
 assert.equal(value.view.memories.find(m=>m.id===other).current,null);
 assert.equal(value.view.memories.find(m=>m.id===other).state,'withdrawn');
});

test('主题资料只读取当前完整发布集合，范围变化后迟到快照不得回填',async t=>{
 const memberId=candidate,publicationId=requestKey;
 const value={scope:{scopeKind:'contact',contactId:contact},status:'processing',publication:{id:publicationId,members:[{documentId:memberId,versionNo:'1'}]},documents:[{id:memberId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'scene',title:'合成园艺',statements:[{text:'联系人喜欢合成园艺。',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memory_id:requestKey,revision:1,level:'contact',provenance_kind:'source_supported',memoryText:'正式合成记忆依据。',timing:{},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null}]}]}]};
 let pending,started,held=false;const wait=new Promise(r=>{pending=r;}),entered=new Promise(r=>{started=r;});
 const f=await fixture(t,async()=>{if(held){started();return wait;}return value;});
 const input={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1};
 const snapshot=await f.controller.readDocuments(input);assert.equal(snapshot.view.status,'processing');assert.equal(snapshot.view.documents[0].statements[0].text,'联系人喜欢合成园艺。');assert.equal(snapshot.view.documents[0].statements[0].references[0].memoryText,'正式合成记忆依据。');
 assert.equal(f.calls[0].path,`/api/memory-documents?scope_kind=contact&contact_id=${contact}`);
 held=true;const old=f.controller.readDocuments(input);await entered;f.change();pending(value);await assert.rejects(old);assert.equal(f.invalidations.length,1);
});

test('主题资料桥拒绝跨范围、半套成员及缺少依据',async t=>{
 const docId=candidate,publicationId=requestKey;
 const doc={id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'profile',title:'长期背景',statements:[{text:'长期合成活动。',kind:'fact',basis:'正式记忆直接支持。',section:'interests',uncertainty:'',temporalStatus:'stable',leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memory_id:requestKey,revision:1,level:'contact',provenance_kind:'source_supported',memoryText:'正式合成记忆依据。'}]}]};
 let response={scope:{scopeKind:'contact',contactId:contact},status:'completed',publication:{id:publicationId,members:[{documentId:docId,versionNo:'1'}]},documents:[doc]};
 const f=await fixture(t,async()=>response),input={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1};
 assert.equal((await f.controller.readDocuments(input)).view.documents.length,1);
 response={...response,status:'needs_revalidation'};
 assert.equal((await f.controller.readDocuments(input)).view.documents.length,1,'本轮待核验时保留仍合法的旧发布集合');
 response={...response,status:'completed'};
 for(const bad of [
  {...response,scope:{scopeKind:'contact',contactId:other}},
  {...response,documents:[{...doc,contactId:other}]},
  {...response,publication:{id:publicationId,members:[]}},
  {...response,publication:null},
  {...response,documents:[{...doc,statements:[{...doc.statements[0],references:[]}]}]},
 ]){response=bad;await assert.rejects(f.controller.readDocuments(input));}
 assert.equal(f.invalidations.length,5);
});

test('正常07→08→09合成处理的真实发布结果通过主进程范围解码',async t=>{
 const {documentFixture}=await import('../../backend-ts/test/fixtures/memory-documents/support.mjs');
 const data=await documentFixture(t);const run=await data.extraction.start('desktop-documents-real');await data.extraction.waitForIdle();
 const raw=await data.documents.read({scopeKind:'contact',contactId:data.contactId});assert.equal(raw.documents.length,2);
 const root=await mkdtemp(path.join(tmpdir(),'notalone-documents-bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'controller.mjs');await build({entryPoints:['src/main/memory/sqlite-management.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(pathToFileURL(output));
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async()=>({generation:1,data:raw})},()=>{},{getState:()=>({selectedContactId:data.contactId,scopeRevision:1})});
 const snapshot=await controller.readDocuments({scope:{scopeKind:'contact',contactId:data.contactId},displayContactId:data.contactId,scopeRevision:1});
 assert.equal(snapshot.view.publication.members.length,2);assert.deepEqual(snapshot.view.documents.map(d=>d.kind).sort(),['profile','scene']);
 assert.ok(snapshot.view.documents.every(d=>d.statements.some(s=>s.text.includes('联系人长期喜欢合成园艺'))));
 assert.deepEqual(await data.storage.check(),{integrity:'ok',foreignKeys:'ok'});assert.ok(run.runId);
});

test('主题只读桥只接受一个范围请求且不暴露发布写入',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'notalone-documents-preload-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'preload.mjs');await build({entryPoints:['src/preload/sqlite-memory-management.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {createSqliteMemoryManagementBridge}=await import(pathToFileURL(output)),calls=[];
 const bridge=createSqliteMemoryManagementBridge({invoke:async(...args)=>{calls.push(args);return {};},on(){},removeListener(){}});
 const input={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1};
 await bridge.readDocuments(input);assert.deepEqual(calls,[['memory:documents-read',input]]);
 await assert.rejects(bridge.readDocuments());await assert.rejects(bridge.readDocuments(input,{}));assert.equal('publish' in bridge,false);assert.equal(calls.length,1);
});

test('主进程保留图片来源类型、固定版本与模型观察，拒绝伪造图像引文',async t=>{
 let quote='';
 const image=()=>({...source(contact),quote,contentKind:'image',contentRef:{file_id:requestKey,sha256:'a'.repeat(64),mime_type:'image/png',media_generation:'0'},description:'日程卡中的每周六练习吉他'});
 const f=await fixture(t,async()=>({candidates:[item(candidate,[image()])],memories:[]}));
 const value=await f.controller.read(read),actual=value.view.candidates[0].sources[0];
 assert.equal(actual.contentKind,'image');assert.equal(actual.contentRef.file_id,requestKey);assert.equal(actual.quote,'');assert.equal(actual.description,'日程卡中的每周六练习吉他');
 quote='把图片描述伪装成原话';await assert.rejects(f.controller.read(read));
});


test('记忆桥只在连接代次变化时撤下资料，同连接资格通知保留快照',async()=>{
 const compiled=await build({stdin:{contents:"export {installSqliteMemoryManagementBridge} from './src/main/memory/sqlite-management';export {installFixedMemoryProcessingBridge} from './src/main/memory/fixed-processing';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const module=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 for(const install of [module.installSqliteMemoryManagementBridge,module.installFixedMemoryProcessingBridge]){
  let generation=1,listener;const events=[];
  const backend={getConnectionGeneration:()=>generation,onStateChanged:fn=>{listener=fn;return()=>{};}};
  const controller=install({handle:()=>{},publish:event=>events.push(event)},backend,{getState:()=>({selectedContactId:contact,scopeRevision:1})});
  listener({phase:'connected'});listener({phase:'connected'});assert.equal(events.length,0);
  generation=undefined;listener({phase:'connecting'});assert.equal(events.length,1);
  listener({phase:'connecting'});assert.equal(events.length,1);
  generation=2;listener({phase:'connected'});assert.equal(events.length,2);
  listener({phase:'connected'});assert.equal(events.length,2);
  controller.synchronize();assert.equal(events.length,3,'来源失效不受连接去重影响');
 }
});
