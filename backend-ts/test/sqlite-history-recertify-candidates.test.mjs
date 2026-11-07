import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fixture,owner,record} from './sqlite-clear-support.mjs';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';
import {recertifyCandidateCountsSql,recertifyCandidateIdsSql,recertifyCandidateStateSql} from '../src/history/sqlite/recertify-candidates.ts';

const registryModule=new URL('./fixtures/history/candidates-registry.mjs',import.meta.url).href;
async function setup(t){
 const f=await fixture(t,{registryModule});
 f.state.pageRecords=[record('shard-a','1'),record('shard-a','2',{kind:'image',text:null,originalType:'3'}),record('shard-a','3',{kind:'image',text:null,originalType:'3'})];
 await f.current.history.synchronize(f.contactA);
 f.state.pageRecords=[record('shard-b','1')];
 await f.current.history.synchronize(f.contactB);
 for(const contactId of [f.contactA,f.contactB])await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(contactId)});
 return f;
}
async function serve(t,f,{withRecertify=true}={}){
 const http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,withRecertify?f.current.recertify:undefined);
 const server=createServer((request,response)=>{void http.handle(request,response).then(handled=>{if(!handled){response.writeHead(404);response.end('{}');}});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return `http://127.0.0.1:${server.address().port}`;
}
const asText=value=>JSON.stringify(value);

test('候选聚合只含仍被围栏且有有效授权的联系人，只返回 ID、围栏/资格与计数', {timeout:20000}, async t=>{
 const f=await setup(t),candidates=await f.current.recertify.candidates();
 assert.equal(candidates.read_enabled,true);assert.equal(candidates.fenced_total,2);
 assert.equal(candidates.total,2);assert.equal(candidates.with_unsaved_images,1);
 assert.deepEqual(candidates.contacts.map(row=>Object.keys(row).sort()),[
  ['contact_id','eligible','fenced','image_message_count','image_unsaved_count','stored_message_count'],
  ['contact_id','eligible','fenced','image_message_count','image_unsaved_count','stored_message_count']]);
 assert.deepEqual(Object.keys(candidates).sort(),['contacts','fenced_total','image_unsaved_total','message_total','read_enabled','total','with_unsaved_images']);
 // 排序：未保存图片降序，其次消息数升序；同图数时短历史先修。
 assert.equal(candidates.contacts[0].contact_id,f.contactA);
 assert.equal(candidates.contacts[0].stored_message_count,3);assert.equal(candidates.contacts[0].image_message_count,2);assert.equal(candidates.contacts[0].image_unsaved_count,2);
 assert.equal(candidates.contacts[1].contact_id,f.contactB);assert.equal(candidates.contacts[1].stored_message_count,1);assert.equal(candidates.contacts[1].image_unsaved_count,0);
 assert.equal(candidates.message_total,4);assert.equal(candidates.image_unsaved_total,2);
 // 不含名称与正文（联系人目录里的合成名称、消息正文均不能出现在响应中）。
 assert.ok(!asText(candidates).includes('合成'));assert.ok(!asText(candidates).includes('shard'));
 const single=await f.current.recertify.candidates(f.contactA);
 assert.equal(single.contacts.length,1);assert.equal(single.contacts[0].fenced,true);assert.equal(single.contacts[0].eligible,true);assert.equal(single.contacts[0].image_unsaved_count,2);
});

test('候选排除已撤销授权、非激活与同步关闭的联系人，单联系人复核返回真实围栏与资格', {timeout:20000}, async t=>{
 const f=await setup(t);
 await f.current.storage.execute('fixture.candidateMutation',{ownerId:owner,contactId:f.contactB,kind:'revoke'});
 let list=await f.current.recertify.candidates();
 assert.deepEqual(list.contacts.map(row=>row.contact_id),[f.contactA]);assert.equal(list.fenced_total,2);assert.equal(list.total,1);
 assert.deepEqual(await f.current.recertify.candidates(f.contactB),{read_enabled:true,fenced_total:1,contacts:[{contact_id:f.contactB,fenced:true,eligible:false,stored_message_count:1,image_message_count:0,image_unsaved_count:0}],total:0,with_unsaved_images:0,message_total:1,image_unsaved_total:0});
 await f.current.storage.execute('fixture.candidateMutation',{ownerId:owner,contactId:f.contactB,kind:'delete-contact'});
 list=await f.current.recertify.candidates();
 assert.equal(list.fenced_total,1);
 assert.deepEqual(await f.current.recertify.candidates(f.contactB),{read_enabled:true,fenced_total:0,contacts:[],total:0,with_unsaved_images:0,message_total:0,image_unsaved_total:0});
 await f.current.storage.execute('fixture.candidateMutation',{ownerId:owner,contactId:f.contactA,kind:'unfence'});
 assert.deepEqual((await f.current.recertify.candidates(f.contactA)).contacts.map(row=>({fenced:row.fenced,eligible:row.eligible})),[{fenced:false,eligible:true}]);
 await f.current.storage.execute('fixture.candidateMutation',{ownerId:owner,contactId:f.contactB,kind:'disable-read'});
 const disabled=await f.current.recertify.candidates();
 assert.equal(disabled.read_enabled,false);assert.equal(disabled.contacts.length,0);assert.equal(disabled.fenced_total,0);
});

test('候选聚合只读 HTTP 路径固定：GET 带可选精确 contact_id，拒绝写入与多余查询', {timeout:20000}, async t=>{
 const f=await setup(t),base=await serve(t,f);
 let response=await fetch(`${base}/api/history/recertify/candidates`);
 assert.equal(response.status,200);const list=await response.json();
 assert.equal(list.total,2);assert.equal(response.headers.get('cache-control'),'no-store');
 response=await fetch(`${base}/api/history/recertify/candidates?contact_id=${f.contactB}`);
 assert.equal(response.status,200);assert.deepEqual((await response.json()).contacts.map(row=>row.contact_id),[f.contactB]);
 assert.equal((await fetch(`${base}/api/history/recertify/candidates?contact_id=not-a-uuid`)).status,400);
 assert.equal((await fetch(`${base}/api/history/recertify/candidates?contact_id=${f.contactB}&contact_id=${f.contactA}`)).status,400);
 assert.equal((await fetch(`${base}/api/history/recertify/candidates?limit=1`)).status,400);
 assert.equal((await fetch(`${base}/api/history/recertify/candidates`,{method:'POST',body:'{}'})).status,405);
 const unavailable=await serve(t,f,{withRecertify:false});
 assert.equal((await fetch(`${unavailable}/api/history/recertify/candidates`)).status,503);
});

test('候选查询使用现有索引，不扫描消息、媒体或授权表', {timeout:20000}, async t=>{
 const f=await setup(t);
 const plan=sql=>f.current.storage.execute('fixture.explain',{sql,params:[owner]});
 const list=await plan(recertifyCandidateIdsSql);
 assert.ok(list.some(row=>/SEARCH c USING INDEX sqlite_autoindex_contact_1/.test(row.detail)),asText(list));
 assert.ok(list.some(row=>/message_contact_display/.test(row.detail)),asText(list));
 for(const row of list)assert.ok(!/\bSCAN (message|media_file|read_grant|binding_verification|channel_account|channel_conversation|conversation_binding)\b/.test(row.detail),row.detail);
 const state=await f.current.storage.execute('fixture.explain',{sql:recertifyCandidateStateSql,params:[owner,f.contactA]});
 for(const row of state)assert.ok(!/\bSCAN (message|media_file|read_grant|source_proof)\b/.test(row.detail),row.detail);
 const counts=await f.current.storage.execute('fixture.explain',{sql:recertifyCandidateCountsSql,params:[owner,f.contactA]});
 assert.ok(counts.some(row=>/SEARCH m USING INDEX message_contact_display/.test(row.detail)),asText(counts));
 for(const row of counts)assert.ok(!/\bSCAN (message|media_file)\b/.test(row.detail),row.detail);
});

test('候选聚合耗时随被围栏联系人数近似线性，而非联系人×消息二次增长', {timeout:60000}, async t=>{
 const durations={};
 for(const count of [10,100,300]){
  const f=await fixture(t,{registryModule});
  const created=await f.current.storage.execute('fixture.fencedContacts',{ownerId:owner,count});
  assert.equal(created.length,count);
  const started=performance.now();
  const list=await f.current.recertify.candidates();
  durations[count]=performance.now()-started;
  assert.equal(list.total,count);assert.equal(list.with_unsaved_images,count);
  assert.equal(list.message_total,count*2);assert.equal(list.image_unsaved_total,count);
 }
 // 每人固定 2 条合成消息；若查询按联系人重算大范围相关子查询，300 位会相对 100 位呈二次增长。
 assert.ok(durations[300]<1500,`300 位候选耗时 ${durations[300].toFixed(1)}ms`);
 assert.ok(durations[300]<=Math.max(300,durations[100]*3),`10/100/300 位耗时 ${asText(durations)}`);
});
