import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { launchDsh } from '../src/launch.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';

test('官方profile启动失败保留脱敏阶段诊断，清理临时home且成功重试清除旧诊断', {timeout:30000}, async t => {
  const {writeFile} = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-diagnostic-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
  const databaseId=storage.status.databaseId;await storage.close();
  const infoPath=path.join(root,'managed/sqlite-backend.info'),envFilePath=path.join(root,'private-synthetic.env');
  const secret='synthetic-credential-must-not-be-retained';
  const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
    envFilePath,infoPath,businessHome:root,environment:{},
    sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts']}};
  for(const stage of ['configuration','storage']) {
    await writeFile(envFilePath,`NOTALONE_DEEPSEEK_API_KEY=${secret}\nNOTALONE_BACKGROUND_PROCESSING=${stage==='configuration'?secret:'manual'}\n`,{mode:0o600});
    const host=await launchDsh({...config,sqlite:{...config.sqlite,expectedDatabaseId:stage==='storage'?'wrong-synthetic-instance':databaseId}},()=>true);
    t.after(()=>host.terminate());
    const lock=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8'));
    assert.equal(await host.waitForExit(10000),true);
    const raw=await readFile(infoPath+'.startup-diagnostic.json','utf8'),diagnostic=JSON.parse(raw);
    assert.equal(diagnostic.stage,stage);
    assert.equal(diagnostic.cause,stage==='configuration'?'configuration_invalid':'storage_mismatch');
    assert.deepEqual(Object.keys(diagnostic).sort(),['cause','recordedAt','stage','version']);
    assert.ok(Buffer.byteLength(raw)<=512);
    for(const privateValue of [secret,envFilePath,root,databaseId])assert.ok(!raw.includes(privateValue));
    await assert.rejects(access(lock.home),{code:'ENOENT'});
    await assert.rejects(access(infoPath+'.dsh-lock'),{code:'ENOENT'});
  }
  const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());
  const info=await handshake(host,infoPath);
  await assert.rejects(access(infoPath+'.startup-diagnostic.json'),{code:'ENOENT'});
  await fetch(`http://${info.address}/api/runtime/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`}});
  assert.equal(await host.waitForExit(10000),true);
  await assert.rejects(access(infoPath+'.startup-diagnostic.json'),{code:'ENOENT'});
});

async function handshake(host, infoPath) {
  const until = Date.now() + 15000;
  while (Date.now() < until && host.isRunning()) {
    try { return Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1)];})); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    await delay(50);
  }
  assert.fail('官方 SQLite 联系人宿主未在有界时间内就绪');
}

test('认证停读先接纳，等待在途请求排空后由原状态接口确认退出', {timeout:20000},async t=>{
 const {request:httpRequest}=await import('node:http');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-shutdown-confirm-')));
 let host,pendingRequest;
 t.after(async()=>{pendingRequest?.destroy();await host?.terminate();await rm(root,{recursive:true,force:true});});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info');
 host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
  envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
  sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts']}},()=>true);
 const info=await handshake(host,infoPath),base=`http://${info.address}`,headers={Authorization:`Bearer ${info.token}`};
 const request=(route,method='GET')=>fetch(base+route,{method,headers,signal:AbortSignal.timeout(1500)});
 const ready=await (await request('/api/runtime/status')).json();assert.equal(ready.shutdownProtocol,'poll-v1');
 assert.equal((await fetch(base+'/api/runtime/shutdown/begin',{method:'POST'})).status,401);
 const continued=Promise.withResolvers(),response=Promise.withResolvers();
 pendingRequest=httpRequest(base+'/api/setup/credentials',{method:'POST',headers:{...headers,'Content-Length':'2',Expect:'100-continue'}},res=>{res.resume();res.on('end',()=>response.resolve(res.statusCode));});
 pendingRequest.on('error',error=>{continued.reject(error);response.reject(error);});
 void response.promise.catch(()=>{});pendingRequest.once('continue',()=>continued.resolve());pendingRequest.flushHeaders();await continued.promise;pendingRequest.write('{');
 for(let i=0;i<2;i++){
  const accepted=await request('/api/runtime/shutdown/begin','POST');assert.equal(accepted.status,202);assert.equal((await accepted.json()).state,'stopping');
 }
 const stopping=await (await request('/api/runtime/status')).json();assert.equal(stopping.state,'stopping');assert.equal(stopping.shutdownFailed,false);
 assert.equal((await request('/api/contacts')).status,503,'停读过程中拒绝新的业务读取');
 pendingRequest.end('}');assert.equal(await response.promise,400);
 let stopped=false;
 for(let i=0;i<30;i++){
  const status=await (await request('/api/runtime/status')).json();
  if(status.state==='stopped'){stopped=true;break;}
  await delay(20);
 }
 assert.equal(stopped,true,'只接受原认证状态接口的真实stopped');
 assert.equal(await host.waitForExit(5000),true);await assert.rejects(access(infoPath),{code:'ENOENT'});
});

test('正式宿主复验预检本人身份，不匹配时保留原库并拒绝业务握手', {timeout:20000},async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-owner-')));let host;
 t.after(async()=>{await host?.terminate();await rm(root,{recursive:true,force:true});});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;
 const ownerId=await storage.execute('identity.resolveOwner',{proposedOwnerId:'00000000-0000-4000-8000-000000000041',at:Date.now()});await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info');
 const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
  envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
  sqlite:{userData:root,expectedDatabaseId:databaseId,expectedOwnerId:'00000000-0000-4000-8000-000000000042',role:'test',capabilities:['contacts']}};
 host=await launchDsh(config,()=>true);assert.equal(await host.waitForExit(5000),true);
 await assert.rejects(access(infoPath),{code:'ENOENT'});
 const diagnostic=JSON.parse(await readFile(infoPath+'.startup-diagnostic.json','utf8'));
 assert.equal(diagnostic.stage,'storage');assert.equal(diagnostic.cause,'storage_mismatch');
 host=await launchDsh({...config,sqlite:{...config.sqlite,expectedOwnerId:ownerId}},()=>true);
 const info=await handshake(host,infoPath),headers={Authorization:`Bearer ${info.token}`};
 const setup=await(await fetch(`http://${info.address}/api/setup/status`,{headers})).json();assert.equal(setup.owner_id,ownerId);
 const status=await(await fetch(`http://${info.address}/api/runtime/status`,{headers})).json();
 assert.deepEqual(status.storageIdentity,{databaseId,ownerId,available:true});
 const {rename,writeFile}=await import('node:fs/promises'),file=path.join(root,'managed/sqlite/notalone.sqlite'),original=file+'.original';
 await rename(file,original);await writeFile(file,'合成替换文件',{mode:0o600});
 try{
  const changed=await(await fetch(`http://${info.address}/api/runtime/status`,{headers})).json();
  assert.equal(changed.state,'running');assert.deepEqual(changed.storageIdentity,{databaseId,ownerId,available:false});
 }finally{await rm(file);await rename(original,file);}
 await fetch(`http://${info.address}/api/runtime/shutdown`,{method:'POST',headers});assert.equal(await host.waitForExit(5000),true);
});

test('预检已有本人在原库缺失时拒绝启动，不静默创建新本人', {timeout:10000},async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-missing-owner-')));let host;
 t.after(async()=>{await host?.terminate();await rm(root,{recursive:true,force:true});});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info'),owner='00000000-0000-4000-8000-000000000041';
 host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
  envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
  sqlite:{userData:root,expectedDatabaseId:databaseId,expectedOwnerId:owner,role:'test',capabilities:['contacts']}},()=>true);
 assert.equal(await host.waitForExit(5000),true);await assert.rejects(access(infoPath),{code:'ENOENT'});
 const diagnostic=JSON.parse(await readFile(infoPath+'.startup-diagnostic.json','utf8'));assert.equal(diagnostic.cause,'storage_mismatch');
 const reopened=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId:databaseId,role:'test'});
 try{assert.equal(await reopened.execute('identity.resolveOwner',{proposedOwnerId:owner,at:1}),owner,'失败启动不能在空本人表插入随机身份');}
 finally{await reopened.close();}
});

test('显式SQLite联系人使用官方DSH最小profile，认证、关闭和重开不启动PG或模型', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'notalone-sqlite-host-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const storage = await SqliteStorage.open({userData:root,intent:'create',role:'test'});
  const databaseId=storage.status.databaseId;await storage.close();
  const infoPath=path.join(root,'managed/sqlite-backend.info');
  const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
    envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
    sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts']}};
  let firstOwner;
  for(let attempt=0;attempt<2;attempt++) {
    const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());
    const info=await handshake(host,infoPath);
    const url=`http://${info.address}`;
    const request=(route,options={})=>fetch(url+route,{...options,headers:{Authorization:`Bearer ${info.token}`,...options.headers}});
    assert.equal((await fetch(url+'/api/runtime/status')).status,401);
    assert.equal((await request('/api/runtime/status',{headers:{Origin:'http://localhost'}})).status,401);
    assert.equal((await fetch(url+'/api/events',{headers:{Accept:'text/event-stream'}})).status,401);
    assert.equal((await fetch(url+'/api/ledger/summary')).status,401);
    assert.equal((await request('/api/events')).status,406);
    assert.equal((await request('/api/events',{method:'POST',headers:{Accept:'text/event-stream'}})).status,405);
    const firstEvents=await request('/api/events',{headers:{Accept:'text/event-stream'}});
    assert.equal(firstEvents.status,200);assert.match(firstEvents.headers.get('content-type')??'',/^text\/event-stream/);
    const firstReader=firstEvents.body.getReader();
    assert.match(new TextDecoder().decode((await firstReader.read()).value),/: connected/);
    await firstReader.cancel();
    const nextEvents=await request('/api/events',{headers:{Accept:'text/event-stream'}});
    assert.equal(nextEvents.status,200);const nextReader=nextEvents.body.getReader();
    assert.match(new TextDecoder().decode((await nextReader.read()).value),/: connected/);
    const status=await (await request('/api/runtime/status')).json();
    assert.equal(status.state,'running');assert.equal(status.runtime,'dsh');assert.equal(status.storage,'sqlite');
    assert.deepEqual(status.capabilities,['contacts']);assert.equal(status.ownership.contacts,'typescript');assert.equal(status.ownership.replies,'unavailable');
    const directory=await (await request('/api/contacts')).json();assert.deepEqual(directory.contacts,[]);
    const setup=await (await request('/api/setup/status')).json();assert.equal(setup.runtime_owner_configured,true);
    if(firstOwner)assert.equal(setup.owner_id,firstOwner);else firstOwner=setup.owner_id;
    const usageResponse=await request('/api/ledger/summary');assert.equal(usageResponse.status,200);
    const usage=await usageResponse.json();assert.equal(usage.schema_version,1);assert.equal(usage.total_calls,0);
    assert.equal(usage.total_attempts,0);assert.equal(usage.total_input_tokens,0);assert.deepEqual(usage.recent,[]);
    assert.equal((await request('/api/ledger/summary?unexpected=1')).status,400);
    assert.equal((await request('/api/ledger/summary',{method:'POST'})).status,405);
    assert.equal((await request('/api/reply/generate',{method:'POST'})).status,503);
    const shutdown=await request('/api/runtime/shutdown',{method:'POST'});assert.equal(shutdown.status,200);
    assert.equal((await shutdown.json()).state,'stopped');
    assert.deepEqual(await nextReader.read(),{done:true,value:undefined});
    assert.equal(await host.waitForExit(15000),true);
    await assert.rejects(access(infoPath),{code:'ENOENT'});await assert.rejects(access(infoPath+'.dsh-lock'),{code:'ENOENT'});
  }
});

test('SQLite官方profile随父宿主EOF退出并清理握手和临时home', async t => {
  const { spawn } = await import('node:child_process');
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'notalone-sqlite-parent-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const storage = await SqliteStorage.open({userData:root,intent:'create',role:'test'});
  const databaseId=storage.status.databaseId;await storage.close();
  const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
    envFilePath:path.join(root,'unused.env'),infoPath:path.join(root,'managed/sqlite-backend.info'),businessHome:root,environment:{},
    sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts']}};
  const script=`import {launchDsh} from ${JSON.stringify(new URL('../src/launch.ts',import.meta.url).href)};const host=await launchDsh(JSON.parse(process.argv[1]),()=>true);process.send({pid:host.pid});`;
  const parent=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');});
  const pid=await new Promise((resolve,reject)=>{parent.once('message',message=>resolve(message.pid));parent.once('exit',()=>reject(new Error('合成父宿主提前退出')));});
  const running=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
  t.after(()=>{if(running())process.kill(pid,'SIGTERM');});
  await handshake({isRunning:running},config.infoPath);
  const record=JSON.parse(await readFile(config.infoPath+'.dsh-lock','utf8'));
  const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
  const until=Date.now()+15000;
  while(running()&&Date.now()<until)await delay(50);
  assert.equal(running(),false);
  await assert.rejects(access(config.infoPath),{code:'ENOENT'});
  await assert.rejects(access(record.home),{code:'ENOENT'});
});

test('SQLite正式宿主默认核验启用外置Skill，CAS停用再启用可重开且原件不改',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-sqlite-skills-host-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const skillPackageRoot=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-sqlite-skill-originals-')));t.after(()=>rm(skillPackageRoot,{recursive:true,force:true}));
 await mkdir(path.join(skillPackageRoot,'gentle'),{recursive:true});
 const document='---\nname: gentle\ndescription: 用于合成表达\n---\n先回应感受。\n说明情况。\n保留选择。\n';await writeFile(path.join(skillPackageRoot,'gentle/SKILL.md'),document);
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});const databaseId=storage.status.databaseId;await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info');
 const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
  sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','skills'],skillPackageRoot}};
 let packageId;
 for(let attempt=0;attempt<2;attempt++){
  const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());const info=await handshake(host,infoPath);
  const request=async(route,body)=>{const res=await fetch(`http://${info.address}`+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json()};};
  const status=(await request('/api/runtime/status')).body;assert.deepEqual(status.capabilities,['contacts','skills']);assert.equal(status.ownership.skills,'typescript');assert.equal(status.ownership.skillLearning,'unavailable');
  let view=(await request('/api/skills')).body;assert.equal(view.mode,'minimal');
  if(!attempt){
   assert.equal(view.skills.length,1);const automatic=view.skills[0];
   assert.equal(automatic.name,'gentle');assert.equal(automatic.enabled_state,'enabled');assert.equal(automatic.verification_state,'verified');
   assert.equal(automatic.current_revision_no,'1');assert.equal(automatic.revisions.length,1);
   let item=automatic;packageId=item.package_id;
   assert.equal(packageId,automatic.package_id);assert.equal(item.head_revision,automatic.head_revision);assert.equal(item.enabled_state,'enabled');
   item=(await request(`/api/skills/${packageId}/disable`,{expected_head_revision:item.head_revision,confirmed:true})).body.skill;
   assert.equal(item.enabled_state,'disabled');
   item=(await request(`/api/skills/${packageId}/enable`,{expected_head_revision:item.head_revision,confirmed:true})).body.skill;
   assert.equal(item.enabled_state,'enabled');assert.equal(item.verification_state,'verified');assert.equal(item.current_revision_no,'1');
  }else{assert.equal(view.skills[0].package_id,packageId);assert.equal(view.skills[0].enabled_state,'enabled');}
  assert.equal((await request('/api/reply/generate',{})).status,503);
  assert.equal(await readFile(path.join(skillPackageRoot,'gentle/SKILL.md'),'utf8'),document);
  await request('/api/runtime/shutdown',{});assert.equal(await host.waitForExit(15000),true);
 }
});

test('正常DSH运行中账号DELETE真实compact并公开复核，Skill元数据清除而原目录保留',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 for(const withSkill of [false,true]){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-delete-host-')));
  let host;
  t.after(async()=>{await host?.terminate();await rm(root,{recursive:true,force:true});});
  const skillPackageRoot=path.join(root,'skill-packages');
  const document='---\nname: gentle\ndescription: 合成删除验收\n---\n先回应，再说明。\n';
  if(withSkill){await mkdir(path.join(skillPackageRoot,'gentle'),{recursive:true});await writeFile(path.join(skillPackageRoot,'gentle/SKILL.md'),document);}
  const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});const databaseId=storage.status.databaseId;
  let seededContact,remainingContact,oldReadToken;
  if(withSkill){
   const ownerId='00000000-0000-4000-8000-000000000051';
   const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[
    {externalKey:'synthetic-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},
    {externalKey:'synthetic-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
   const seed=new SqliteContactService(storage,ownerId,metadata);await seed.initialize();
   const candidate=await seed.detectAccount();await seed.confirmAccount(candidate.candidate_token);await seed.setReading(true);
   const snapshot=await seed.candidates(true);
   await seed.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
   const directory=await seed.directory();seededContact=directory.contacts[0].contact_id;remainingContact=directory.contacts[1].contact_id;
   oldReadToken=await seed.eligibility(seededContact);await seed.close();
  }
  await storage.close();
  const infoPath=path.join(root,'managed/sqlite-backend.info');
  host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,
   envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{},
   sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:withSkill?['contacts','skills']:['contacts'],...(withSkill?{skillPackageRoot}:{})}},()=>true);
  const info=await handshake(host,infoPath);
  const request=(route,method='GET',body,extra={})=>fetch(`http://${info.address}`+route,{method,headers:{Authorization:`Bearer ${info.token}`,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const ownerId=(await (await request('/api/setup/status')).json()).owner_id;
  assert.equal((await request('/api/deletions')).status,200);
  assert.equal((await request('/api/deletions?owner_id=other')).status,400);
  assert.equal((await request('/api/runtime/status?unused=1')).status,400);
  assert.equal((await request('/api/deletions?contact_id=11111111-1111-4111-8111-111111111111&scope_kind=discussion')).status,200);
  assert.equal((await request('/api/tasks/status?contact_id=11111111-1111-4111-8111-111111111111&task_id=11111111-1111-4111-8111-111111111111')).status,503);
  const source=await request('/api/contacts/11111111-1111-4111-8111-111111111111/sources/22222222-2222-4222-8222-222222222222','DELETE');
  assert.equal(source.status,404);assert.equal((await source.json()).error,'identity_not_found');
  const discussion=await request('/api/contacts/11111111-1111-4111-8111-111111111111/assistant-sessions/22222222-2222-4222-8222-222222222222','DELETE',{confirmed:true});
  assert.equal(discussion.status,400);assert.equal((await discussion.json()).error,'discussion_deletion_scope_invalid');
  if(withSkill){
   const discovered=await (await request('/api/skills')).json();let item={skill:discovered.skills[0]};
   assert.equal(typeof item.skill.package_id,'string');
   const enabled=await request(`/api/skills/${item.skill.package_id}/enable`,'POST',{expected_head_revision:item.skill.head_revision,confirmed:true});
   assert.equal(enabled.status,200);
   const contactReceipt=await request(`/api/contacts/${seededContact}`,'DELETE',{confirmed:true,confirm_contact_id:seededContact},{'Idempotency-Key':'synthetic-contact-delete'});
   assert.equal(contactReceipt.status,202);
   const contactOperation=(await contactReceipt.json()).operation_id;
   const contactState=await (await request(`/api/deletions/${contactOperation}`)).json();assert.equal(contactState.state,'completed');
   const remaining=(await (await request('/api/contacts')).json()).contacts;assert.deepEqual(remaining.map(c=>c.contact_id),[remainingContact]);
   assert.equal((await (await request('/api/skills')).json()).skills.length,1);
  }
  await access(infoPath);await assert.rejects(access(path.join(root,'managed/sqlite/backend.info')),{code:'ENOENT'});
  assert.equal((await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'})).status,400);
  const receipt=await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'},{'Idempotency-Key':'synthetic-account-delete'});
  assert.equal(receipt.status,202);const accepted=await receipt.json();
  const state=await (await request(`/api/deletions/${accepted.operation_id}`)).json();
  assert.equal(state.state,'completed');assert.equal(state.status,'succeeded');
  assert.equal(state.checks.find(c=>c.kind==='sqlite_pages_wal').result,'passed');
  assert.equal(state.checks.find(c=>c.kind==='sqlite_pages_wal').proof,'checkpoint_vacuum_verified');
  assert.ok(state.checks.every(c=>c.result!=='blocked'));
  if(withSkill)assert.equal(state.checks.find(c=>c.domain==='skill_metadata'&&c.kind==='database_rows').result,'passed');
  assert.equal(JSON.stringify(state).includes('managed/'),false);
  const runtime=await (await request('/api/runtime/status')).json();assert.equal(runtime.state,'running');assert.equal(host.isRunning(),true);
  assert.deepEqual(runtime.deletion_scopes,['source','contact','contact_history','account','media_result_clear','media_result_replace','discussion']);assert.equal(runtime.ownership.deletion,'typescript');
  await access(infoPath);
  assert.equal((await (await request('/api/deletions')).json()).operations.length,withSkill?2:1);
  assert.equal((await (await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'},{'Idempotency-Key':'synthetic-account-delete'})).json()).operation_id,accepted.operation_id);
  if(withSkill){
   assert.equal(await readFile(path.join(skillPackageRoot,'gentle/SKILL.md'),'utf8'),document);
   const late=await request('/api/skills');assert.equal(late.status,409);
  }
  await request('/api/runtime/shutdown','POST');assert.equal(await host.waitForExit(15000),true);
  const reopened=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId:databaseId,role:'test'});
  try{
   assert.equal((await reopened.execute('deletion.status',{ownerId,operationId:accepted.operation_id})).state,'completed');
   if(oldReadToken){
    const validator=new SqliteContactService(reopened,ownerId,{account:async()=>{throw new Error('不得读渠道');},sessions:async()=>{throw new Error('不得读渠道');}});
    await assert.rejects(validator.validate(oldReadToken),{code:'read_not_authorized'});
   }
  }
  finally{await reopened.close();}
 }
});

test('SQLite宿主开放前台观察入口，关闭同步时不运行探针且返回暂停',async t=>{
 const {writeFile,chmod}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-foreground-host-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const probe=path.join(root,'probe');await writeFile(probe,'#!/bin/sh\nexit 99\n');await chmod(probe,0o700);
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info'),config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(root,'unused.env'),infoPath,businessHome:root,environment:{NOTALONE_SYNC_PROBE:probe},sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history']}};
 const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());const info=await handshake(host,infoPath),headers={Authorization:`Bearer ${info.token}`,'content-type':'application/json'};
 const recovery=`http://${info.address}/api/sync/foreground/permission-restored`;
 assert.equal((await fetch(recovery,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(recovery,{headers})).status,405);
 assert.equal((await fetch(recovery,{method:'POST',headers,body:'{"contact":"injected"}'})).status,400);
 const recovered=await fetch(recovery,{method:'POST',headers,body:'{}'});assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),{ok:true});
 assert.equal((await fetch(`http://${info.address}/api/sync/foreground/observe`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(`http://${info.address}/api/sync/foreground/observe`,{headers})).status,405);
 assert.equal((await fetch(`http://${info.address}/api/sync/foreground/observe`,{method:'POST',headers,body:'{"contact":"injected"}'})).status,400);
 const response=await fetch(`http://${info.address}/api/sync/foreground/observe`,{method:'POST',headers,body:'{}'});
 assert.equal(response.status,200);const value=await response.json();assert.equal(value.phase,'paused');assert.equal(value.reason,'sync_disabled');
 await fetch(`http://${info.address}/api/runtime/shutdown`,{method:'POST',headers});assert.equal(await host.waitForExit(15000),true);
});
