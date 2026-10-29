import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
const owner='00000000-0000-4000-8000-000000000001';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/discussion-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const identity=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await identity.initialize();await identity.confirmAccount((await identity.detectAccount()).candidate_token);
 const snap=await identity.candidates(true);await identity.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));
 const ids=(await identity.directory()).contacts.map(c=>c.contact_id);let now=1_000_000;
 return {storage,root,identity,ids,service:new SqliteDiscussionService(storage,owner,()=>now),advance:ms=>now+=ms};
}
test('联系人讨论隔离、回看不切换，超过十二小时仅显式请求分段，明确继续刷新旧段',async t=>{
 const {service,ids,advance}=await fixture(t);
 assert.equal((await service.list(ids[0])).currentDiscussionId,null);
 const first=await service.newDiscussion(ids[0]);const other=await service.newDiscussion(ids[1]);
 advance(12*60*60*1000+1);
 assert.equal((await service.list(ids[0])).currentDiscussionId,first.id);
 assert.equal((await service.view(ids[0],first.id)).discussion.id,first.id);
 const segmented=await service.forRequest(ids[0]);assert.equal(segmented.segmented,true);assert.notEqual(segmented.discussion.id,first.id);
 await service.continueDiscussion(ids[0],first.id);
 assert.equal((await service.forRequest(ids[0])).discussion.id,first.id);
 assert.equal((await service.list(ids[1])).currentDiscussionId,other.id);
 await assert.rejects(service.view(ids[1],first.id),{code:'discussion_unavailable'});
 assert.equal((await service.view(ids[0],first.id)).entries.length,0);
});

test('正常讨论HTTP复用目录与继续入口，认证前不读正文且响应不暴露文件定位',async t=>{
 const {createServer}=await import('node:http');const {SqliteDiscussionHttp}=await import('../src/reply/sqlite/http.ts');
 const {service,ids}=await fixture(t);const http=new SqliteDiscussionHttp(service,req=>req.headers.authorization==='Bearer synthetic');
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const root=`http://127.0.0.1:${server.address().port}/api/contacts/${ids[0]}/assistant-sessions`;
 assert.equal((await fetch(root)).status,401);
 const request=async(path='',method='GET',body)=>{const res=await fetch(root+path,{method,headers:{Authorization:'Bearer synthetic','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const made=await request('','POST',{});assert.equal(made.status,200);
 const list=await request();assert.equal(list.body.current_session_id,made.body.session_id);
 const view=await request(`/${made.body.session_id}`);assert.equal(view.body.mode,'sqlite');assert.deepEqual(view.body.entries,[]);assert.equal(JSON.stringify(view.body).includes('managed_locator'),false);
 assert.equal((await request(`/${made.body.session_id}/resume`,'POST',{})).body.session_id,made.body.session_id);
 assert.equal((await request('','POST',{owner_id:'other'})).status,400);
});
