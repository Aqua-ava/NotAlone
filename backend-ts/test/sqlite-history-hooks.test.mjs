import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ContactMetadataLifetime } from '../src/storage/sqlite/deletion/contact-metadata.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

const owner='00000000-0000-4000-8000-000000000092';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function holdNext(f){const gate={entered:deferred(),closeEntered:deferred(),physicalRelease:deferred(),pageRelease:deferred()};f.state.gates.push(gate);f.state.nextGate=gate;return gate;}

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-history-hooks-'))),storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),holders=new ActiveHolders();
 const state={starts:0,stops:[],creates:0,pages:[],closes:0,nextGate:null,gates:[]};
 // 仅外部元数据与历史I/O使用明确的合成替身；授权、HTTP、协调和入库均走正式服务。
 const createMetadata=()=>({account:async()=>({...evidence}),sessions:async()=>['a','b'].map(name=>({externalKey:`friend-${name}`,displayName:`合成${name}`,kind:'private',identityAssurance:'verified'}))});
 const contacts=new ContactMetadataLifetime(storage,owner,holders,createMetadata);await contacts.initialize();
 const createChannel=()=>{
  state.creates++;const gate=state.nextGate;state.nextGate=null;let closed=false;
  return {
   inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-final',continuity:'source-1'}),
   target:async()=>({protocol:'private-history-v1',descriptor:'synthetic-target',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1'}),
   page:async(scope,target,cursor)=>{state.pages.push(scope.token.contact_id);gate?.entered.resolve();if(gate)await gate.pageRelease.promise;return {target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['p'],exhausted:true,records:[{partition:'p',table:'t',localId:'1',serverId:'0',sender:'contact',kind:'text',text:`合成${scope.conversationKey}`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0'}]};},
   close:async()=>{if(closed)return;closed=true;gate?.closeEntered.resolve();if(gate){await gate.physicalRelease.promise;gate.pageRelease.resolve();}state.closes++;},
  };
 };
 const history=new SqliteHistoryService(storage,contacts,createChannel,holders),coordinator=new FirstHistoryCoordinator(contacts,history);
 const server=createServer(async(req,res)=>{if(!await contacts.handle(req,res))res.writeHead(404).end();});
 let listening=false;
 t.after(async()=>{
  for(const gate of state.gates){gate.physicalRelease.resolve();gate.pageRelease.resolve();}
  await coordinator.close();await history.close();await contacts.close();
  if(listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await storage.close();await rm(root,{recursive:true,force:true});
 });
 contacts.setReadStop(async contactId=>{state.stops.push(contactId);await coordinator.stop(contactId);});
 contacts.setReadStart(()=>{state.starts++;coordinator.wake();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));listening=true;
 const request=async(path,method='POST',body={},headers={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};
 };
 coordinator.wake();await coordinator.waitForIdle();
 return {state,storage,contacts,history,coordinator,request};
}
async function connect(f){
 const detected=await f.request('/api/setup/wechat/detect');assert.equal(detected.status,200);assert.equal(detected.body.state,'ready');
 const confirmed=await f.request('/api/setup/wechat/confirm','POST',{candidate_token:detected.body.candidate_token,confirmed:true,mode:'selected',history_authorized:true});assert.equal(confirmed.status,200);
}
async function candidates(f){const response=await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'});assert.equal(response.status,200);return response.body;}
function choice(row){return {locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation};}
async function confirm(f,snapshot,token=snapshot.snapshot_token){return f.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:token,selections:[choice(snapshot.sessions.find(row=>row.username==='friend-a'))],history_authorized:true});}
async function binding(f){return (await f.contacts.directory()).bindings.find(row=>row.status==='active');}

test('正式HTTP失败确认和开启前不派发，唯一确认联系人在enable后自动首次入库', {timeout:10000},async t=>{
 const f=await fixture(t);assert.equal(f.state.creates,0);
 await connect(f);assert.equal(f.state.starts,0);
 assert.equal((await f.request('/api/sync/cli-sessions','GET')).body.error,'metadata_consent_required');
 const snapshot=await candidates(f);assert.equal((await confirm(f,snapshot,'missing-snapshot')).status,409);await f.coordinator.waitForIdle();assert.equal(f.state.starts,0);assert.equal(f.state.creates,0);
 assert.equal((await confirm(f,snapshot)).status,200);await f.coordinator.waitForIdle();assert.equal(f.state.starts,1);assert.equal(f.state.creates,0);
 const selected=await binding(f);assert.equal((await f.contacts.directory()).bindings.length,1);assert.deepEqual((await f.history.read(selected.contact_id)).messages,[]);
 const enabled=await f.request('/api/sync/enable');assert.equal(enabled.status,200);assert.equal(f.state.starts,2);await f.coordinator.waitForIdle();
 const read=await f.history.read(selected.contact_id);assert.equal(read.coverage.phase,'complete');assert.equal(read.messages[0].text,'合成friend-a');assert.equal(read.messages[0].sourceRecordIds.length,1);assert.deepEqual(f.state.pages,[selected.contact_id]);
 assert.equal(enabled.body.probe_available,false);assert.equal(enabled.body.wechat_in_front,false);assert.equal(enabled.body.foreground_phase,'unavailable');assert.equal(enabled.body.body_available,false);
});

test('读取开启后的confirm后台派发不阻塞HTTP，disable等待真实读者释放，重新enable继续', {timeout:10000},async t=>{
 const f=await fixture(t);await connect(f);assert.equal((await f.request('/api/sync/enable')).status,200);await f.coordinator.waitForIdle();assert.equal(f.state.creates,0);
 const gate=holdNext(f),snapshot=await candidates(f);assert.equal((await confirm(f,snapshot)).status,200);await gate.entered.promise;
 const selected=await binding(f);assert.deepEqual((await f.history.read(selected.contact_id)).messages,[]);
 let finished=false;const disabling=f.request('/api/sync/disable').then(response=>{finished=true;return response;});await gate.closeEntered.promise;
 assert.equal(finished,false);assert.equal((await f.contacts.directory()).read_enabled,false);assert.deepEqual(f.state.stops,[undefined]);assert.equal(f.state.starts,2);
 gate.physicalRelease.resolve();const disabled=await disabling;assert.equal(disabled.status,200);assert.equal(disabled.body.foreground_phase,'sync_disabled');await f.coordinator.waitForIdle();assert.deepEqual((await f.history.read(selected.contact_id)).messages,[]);
 assert.equal((await f.request('/api/sync/enable')).status,200);await f.coordinator.waitForIdle();assert.equal((await f.history.coverage(selected.contact_id)).phase,'complete');assert.equal((await f.history.read(selected.contact_id)).messages.length,1);assert.equal(f.state.pages.length,2);assert.equal(f.state.starts,3);
});

test('revoke等待指定联系人读者退出且不发start，开启不会恢复撤销范围，明确重确认才派发', {timeout:10000},async t=>{
 const f=await fixture(t);await connect(f);await f.request('/api/sync/enable');await f.coordinator.waitForIdle();
 const gate=holdNext(f);assert.equal((await confirm(f,await candidates(f))).status,200);await gate.entered.promise;const selected=await binding(f),starts=f.state.starts;
 let finished=false;const revoking=f.request('/api/sync/cli-bindings/revoke','POST',{contact_id:selected.contact_id,binding_id:selected.binding_id,expected_selection_generation:selected.selection_generation}).then(response=>{finished=true;return response;});await gate.closeEntered.promise;
 assert.equal(finished,false);assert.deepEqual(f.state.stops,[selected.contact_id]);assert.equal(f.state.starts,starts);assert.equal((await f.contacts.directory()).bindings[0].status,'revoked');
 gate.physicalRelease.resolve();assert.equal((await revoking).status,200);await f.coordinator.waitForIdle();assert.deepEqual((await f.history.read(selected.contact_id)).messages,[]);
 await f.request('/api/sync/enable');await f.coordinator.waitForIdle();assert.equal(f.state.pages.length,1);assert.equal(await binding(f),undefined);
 const snapshot=await candidates(f);assert.equal((await confirm(f,snapshot,'expired')).status,409);assert.equal(f.state.starts,starts+1);await f.coordinator.waitForIdle();assert.equal(f.state.pages.length,1);
 assert.equal((await confirm(f,snapshot)).status,200);await f.coordinator.waitForIdle();const rebound=await binding(f);assert.equal(rebound.contact_id,selected.contact_id);assert.equal((await f.history.coverage(rebound.contact_id)).phase,'complete');assert.equal((await f.history.read(rebound.contact_id)).messages[0].text,'合成friend-a');assert.equal(f.state.pages.length,2);assert.deepEqual(f.state.stops,[selected.contact_id]);
});
