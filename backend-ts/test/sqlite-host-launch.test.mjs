import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { launchDsh } from '../src/launch.ts';

async function handshake(host, infoPath) {
  const until = Date.now() + 15000;
  while (Date.now() < until && host.isRunning()) {
    try { return Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1)];})); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    await delay(50);
  }
  assert.fail('官方 SQLite 联系人宿主未在有界时间内就绪');
}

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
    const status=await (await request('/api/runtime/status')).json();
    assert.equal(status.state,'running');assert.equal(status.runtime,'dsh');assert.equal(status.storage,'sqlite');
    assert.deepEqual(status.capabilities,['contacts']);assert.equal(status.ownership.contacts,'typescript');assert.equal(status.ownership.replies,'unavailable');
    const directory=await (await request('/api/contacts')).json();assert.deepEqual(directory.contacts,[]);
    const setup=await (await request('/api/setup/status')).json();assert.equal(setup.runtime_owner_configured,true);
    if(firstOwner)assert.equal(setup.owner_id,firstOwner);else firstOwner=setup.owner_id;
    assert.equal((await request('/api/reply/generate',{method:'POST'})).status,503);
    const shutdown=await request('/api/runtime/shutdown',{method:'POST'});assert.equal(shutdown.status,200);
    assert.equal((await shutdown.json()).state,'stopped');
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

test('SQLite正式宿主接通显式合成Skill父目录，状态与CAS管理可重开且原件不改',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-sqlite-skills-host-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const skillPackageRoot=path.join(root,'skill-packages');await mkdir(path.join(skillPackageRoot,'gentle'),{recursive:true});
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
   assert.deepEqual(view.skills,[]);let item=(await request('/api/skills/discover',{directory_name:'gentle',confirmed:true})).body.skill;packageId=item.package_id;assert.equal(item.enabled_state,'unknown');
   item=(await request(`/api/skills/${packageId}/enable`,{expected_head_revision:item.head_revision,confirmed:true})).body.skill;assert.equal(item.enabled_state,'enabled');
  }else{assert.equal(view.skills[0].package_id,packageId);assert.equal(view.skills[0].enabled_state,'enabled');}
  assert.equal((await request('/api/contacts/11111111-1111-4111-8111-111111111111/skill-learning',{})).status,503);
  assert.equal((await request('/api/reply/generate',{})).status,503);
  assert.equal(await readFile(path.join(skillPackageRoot,'gentle/SKILL.md'),'utf8'),document);
  await request('/api/runtime/shutdown',{});assert.equal(await host.waitForExit(15000),true);
 }
});
