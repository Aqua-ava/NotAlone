import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {launchDsh} from '../src/launch.ts';

test('SQLite 正式宿主提供模型设置，保存后重开生效且不泄露密钥',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-setup-model-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const infoPath=path.join(root,'managed/sqlite-backend.info'),envFilePath=path.join(root,'model.env');
 await writeFile(envFilePath,'UNRELATED=keep\n',{mode:0o600});
 const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,environment:{},sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','discussions','memory']}};
 async function start(){
  const host=await launchDsh(config,()=>true);t.after(()=>host.terminate());let info;
  for(let i=0;i<200&&host.isRunning();i++){try{info=Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const k=line.indexOf('=');return [line.slice(0,k),line.slice(k+1)];}));break;}catch(e){if(e.code!=='ENOENT')throw e;await delay(50);}}
  assert.ok(info,'宿主没有就绪');const request=async(route,body)=>{const res=await fetch(`http://${info.address}`+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${info.token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};};
  return {host,request};
 }
 let running=await start();let result=await running.request('/api/setup/status');
 assert.equal(result.status,200);assert.equal(result.data.initialized,true);assert.equal(result.data.owner_configured,true);assert.equal(result.data.credentials_configured,false);assert.equal(result.data.runtime_owner_configured,true);
 result=await running.request('/api/setup/official-deepseek',{api_key:'synthetic-rejected-key',confirm_official_defaults:false});assert.equal(result.status,400);
 result=await running.request('/api/setup/credentials',{provider:'deepseek',api_key:'synthetic-test-key',extra:true});assert.equal(result.status,400);
 result=await running.request('/api/setup/credentials',{provider:'deepseek',api_key:'synthetic-test-key'});assert.equal(result.status,200);assert.equal(result.data.configured,true);assert.doesNotMatch(JSON.stringify(result),/synthetic-test-key/);
 result=await running.request('/api/setup/status');assert.equal(result.data.runtime_configuration_pending,true);assert.doesNotMatch(JSON.stringify(result),/synthetic-test-key/);
 assert.match(await readFile(envFilePath,'utf8'),/UNRELATED=keep/);assert.equal((await stat(envFilePath)).mode&0o777,0o600);
 await running.request('/api/runtime/shutdown',{});assert.equal(await running.host.waitForExit(15000),true);
 running=await start();result=await running.request('/api/setup/status');assert.equal(result.data.credentials_configured,true);assert.equal(result.data.runtime_configuration_pending,false);
 await running.request('/api/runtime/shutdown',{});assert.equal(await running.host.waitForExit(15000),true);
});

test('模型设置拒绝环境覆盖、无效密钥与符号链接，保留原文件',async t=>{
 const {SqliteModelSetup}=await import('../src/host/sqlite-model-setup.ts');
 const {symlink}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-setup-guard-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const location=path.join(root,'model.env');await writeFile(location,'UNRELATED=kept\nNOTALONE_DEEPSEEK_API_KEY=old-synthetic\n',{mode:0o600});
 const existing=await readFile(location,'utf8');
 const overridden=await SqliteModelSetup.open(location,{NOTALONE_DEEPSEEK_API_KEY:'external-synthetic'});
 assert.equal(overridden.status().runtime_configuration_environment_override,true);
 await assert.rejects(overridden.save('new-synthetic',false),{code:'configuration_environment_override'});
 const disabled=await SqliteModelSetup.open(location,{NOTALONE_DISABLE_DOTENV:'1'});
 await assert.rejects(disabled.save('new-synthetic',false),{code:'configuration_environment_override'});
 const setup=await SqliteModelSetup.open(location,{});
 await assert.rejects(setup.save('invalid\ninjection',false),{code:'setup_request_invalid'});
 assert.equal(await readFile(location,'utf8'),existing);
 const link=path.join(root,'link.env');await symlink(location,link);await assert.rejects(SqliteModelSetup.open(link,{}));
});

test('官方配置必须明确选择，保存时保留其他配置，重开读取新快照',async t=>{
 const {SqliteModelSetup}=await import('../src/host/sqlite-model-setup.ts');
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-setup-official-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const location=path.join(root,'model.env');await writeFile(location,'OTHER=value\nNOTALONE_DEEPSEEK_MODEL=custom\nNOTALONE_DEEPSEEK_BASE_URL=https://example.invalid\n',{mode:0o600});
 const setup=await SqliteModelSetup.open(location,{});assert.equal(setup.status().official_deepseek_defaults,false);
 await setup.save('synthetic-new-key',false);assert.equal(setup.status().official_deepseek_defaults,false);
 await setup.save('synthetic-official-key',true);assert.equal(setup.status().runtime_configuration_pending,true);
 const saved=await readFile(location,'utf8');assert.match(saved,/OTHER=value/);assert.doesNotMatch(saved,/example\.invalid|synthetic-new-key/);
 const restarted=await SqliteModelSetup.open(location,{});assert.equal(restarted.status().official_deepseek_defaults,true);assert.equal(restarted.status().runtime_configuration_pending,false);
});
