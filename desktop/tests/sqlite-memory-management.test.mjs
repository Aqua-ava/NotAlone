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
const item=(id,sources)=>({id,scopeKind:'self',contactId:null,body:'本人合成候选',state:'pending',stateRevision:'0',eventId:requestKey,sources,contributingContactIds:[contact]});
async function fixture(t,handle){
 const root=await mkdtemp(path.join(tmpdir(),'notalone-memory-manager-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'controller.mjs');await build({entryPoints:['src/main/memory/sqlite-management.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(pathToFileURL(output));const calls=[],invalidations=[];
 const state={selectedContactId:contact,scopeRevision:1};let generation=1;
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>generation,requestJson:async r=>{calls.push(r);return {generation,data:await handle(r)};}},()=>invalidations.push(true),{getState:()=>state});
 return {controller,calls,invalidations,state,change:()=>{generation++;controller.synchronize();}};
}
const scope={scopeKind:'self',contactId:null},read={scope,displayContactId:contact,scopeRevision:1};
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
 const version={versionNo:'1',body:'本人合成正式记忆',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:requestKey,sources:[source(contact)],contributingContactIds:[contact]};
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
 const v={versionNo:'1',body:null,formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'redacted',provenanceState:'invalidated',decisionId:requestKey,contributingContactIds:[],sources:[]};
 const f=await fixture(t,async r=>{if(r.method==='POST')throw new Error('来源失效不应继续写出');return {candidates:[],memories:[{id:candidate,scopeKind:'contact',contactId:contact,headRevision:'2',state:'invalidated',manualProtection:false,current:null,versions:[v],decisions:[]}]};});
 const result=await f.controller.decide({...read,scope:{scopeKind:'contact',contactId:contact},connectionGeneration:1,request:{requestKey,action:'correct',memoryId:candidate,expectedVersionNo:'1',expectedHeadRevision:'1',body:'迟到旧编辑'}});
 assert.equal(result.status,'source_stale');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
