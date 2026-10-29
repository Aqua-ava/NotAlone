import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {launchDsh} from '../src/launch.ts';

async function ready(host,infoPath){
 const until=Date.now()+15000;
 while(Date.now()<until&&host.isRunning()){
  try{return Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await delay(50);
 }
 assert.fail('讨论正式profile未在有界时间内就绪');
}

test('讨论正式profile从同一SQLite读取真实用户发言，重开与明确继续不启动模型',{timeout:45000},async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-profile-11-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const skillPackageRoot=path.join(root,'user-skills');await mkdir(skillPackageRoot);
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;
 let closed=false;t.after(async()=>{if(!closed)await storage.close();});
 const ownerId=await storage.execute('identity.resolveOwner',{proposedOwnerId:randomUUID(),at:Date.now()});
 const contacts=new SqliteContactService(storage,ownerId,{account:async()=>({externalKey:'profile-account',identityScheme:'wechat.account.v1',sourceGeneration:'profile-source',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人'+externalKey,kind:'private',identityAssurance:'verified'}))});
 const detected=await contacts.detectAccount();await contacts.confirmAccount(detected.candidate_token);await contacts.setReading(true);
 const candidates=await contacts.candidates(true);await contacts.confirm(candidates.snapshot_token,candidates.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
 const ids=(await contacts.directory()).contacts.map(row=>row.contact_id),service=new SqliteDiscussionService(storage,ownerId);
 const first=await service.newDiscussion(ids[0]),other=await service.newDiscussion(ids[1]);
 const requestKey=randomUUID(),confirmationId=await contacts.manualConfirm(ids[0],requestKey);
 await service.begin(ids[0],requestKey,'用于正式profile回看的合成用户发言',{kind:'manual',confirmationId},first.id);
 await contacts.close();await storage.close();closed=true;
 const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(root,'unused.env'),
  infoPath:path.join(root,'managed/sqlite-backend.info'),businessHome:root,environment:{},
  sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','skills','discussions'],skillPackageRoot}};
 for(let reopen=0;reopen<2;reopen++){
  const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());const info=await ready(host,config.infoPath);
  const request=async(route,method='GET',body)=>{const response=await fetch('http://'+info.address+route,{method,headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  const prefix='/api/contacts/'+ids[0]+'/assistant-sessions';
  const view=await request(prefix+'/'+first.id);assert.equal(view.status,200);assert.equal(view.data.mode,'sqlite');
  assert.equal(view.data.entries[0].text,'用于正式profile回看的合成用户发言');assert.equal(view.data.entries[0].role,'user');assert.equal(view.data.runtime_recovery,'none');
  assert.equal((await request('/api/contacts/'+ids[1]+'/assistant-sessions/'+first.id)).status,404);
  assert.deepEqual((await request('/api/contacts/'+ids[1]+'/assistant-sessions/'+other.id)).data.entries,[]);
  const created=await request(prefix,'POST',{});assert.equal(created.status,200);assert.notEqual(created.data.session_id,first.id);
  assert.equal((await request(prefix+'/'+first.id+'/resume','POST',{})).status,200);
  assert.equal((await request(prefix)).data.current_session_id,first.id);
  const unavailable=await request(prefix+'/'+first.id+'/entries','POST',{request_key:randomUUID(),text:'无模型配置时不发送',confirmed_contact:true});
  assert.equal(unavailable.status,409);assert.equal(unavailable.data.error,'discussion_model_unavailable');
  assert.equal((await request(prefix+'/'+first.id)).data.entries.length,1);
  const state=await request('/api/runtime/status');assert.equal(state.data.ownership.discussions,'typescript');assert.equal(state.data.ownership.replies,'unavailable');
  assert.equal((await request('/api/runtime/shutdown','POST')).status,200);assert.equal(await host.waitForExit(15000),true);
 }
});
