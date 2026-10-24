/** 官方profile集成；可显式选择临时副本用于接线草案诊断。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,symlink,readFile,writeFile,appendFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {request as rawRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {start} from './contact-context-support.mjs';
const root=resolve(new URL('../../',import.meta.url).pathname);
const evidence=join(root,'.scratch/dsh-ts-migration/incremental-sync');
async function digestTree(directory){
  const files=[];
  async function walk(path){for(const e of await readdir(path,{withFileTypes:true})){if(e.name==='__pycache__')continue;const p=join(path,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())files.push(p);}}
  await walk(directory);const hash=createHash('sha256');for(const p of files.sort())hash.update(relative(directory,p)).update(await readFile(p));return hash.digest('hex');
}
async function overlay(t){
  const directory=await mkdtemp(join(tmpdir(),'notalone-incremental-profile-'));
  try {
  for(const part of ['backend/src','backend/database/migrations','backend-ts/src','backend-ts/profile']){
    const source=join(root,part),before=await digestTree(source);await mkdir(join(directory,part,'..'),{recursive:true});
    await cp(source,join(directory,part),{recursive:true,filter:p=>!p.includes('__pycache__')});
    assert.equal(await digestTree(source),before,'复制期间源文件有变更，停止验证');assert.equal(await digestTree(join(directory,part)),before);
  }
  await cp(join(root,'backend-ts/package.json'),join(directory,'backend-ts/package.json'));
  await symlink(join(root,'backend-ts/node_modules'),join(directory,'backend-ts/node_modules'),'dir');
  for(const patch of ['host-plugin.integration.patch','drafts/app.incremental-events.patch','drafts/cli_sync.history-only.patch','drafts/factory.incremental-remote.patch','drafts/full_sync_engine.incremental-remote.patch','drafts/command.incremental-remote.patch']){
    try{execFileSync('git',['apply','--check',join(evidence,patch)],{cwd:directory,stdio:'pipe'});}
    catch(error){execFileSync('git',['apply','--reverse','--check',join(evidence,patch)],{cwd:directory,stdio:'pipe'});continue;}
    execFileSync('git',['apply',join(evidence,patch)],{cwd:directory,stdio:'pipe'});
  }
  for(const name of ['incremental_remote.py','incremental_events.py'])await cp(join(evidence,'drafts',name),join(directory,'backend/src/notalone/front_sync',name));
  if(process.env.NOTALONE_TEST_INCREMENTAL_DIAGNOSTICS==='1'){
    const source=join(directory,'backend/src/notalone/server/sync_host.py'),log=join(directory,'sync-failure.txt');
    const code=await readFile(source,'utf8');
    await writeFile(source,code.replace('            self._record_heartbeat_failure("sync_cycle_failed")',`            import traceback\n            from pathlib import Path\n            Path(${JSON.stringify(log)}).write_text(traceback.format_exc())\n            self._record_heartbeat_failure("sync_cycle_failed")`));
    const appPath=join(directory,'backend/src/notalone/server/app.py'),appCode=await readFile(appPath,'utf8');
    await writeFile(appPath,appCode.replace('        except Exception:\n            return _internal_error(\n                method=method,\n                path=path,\n                error_code="cli_binding_revoke_failed",',`        except Exception:\n            import traceback\n            from pathlib import Path\n            Path(${JSON.stringify(log)}).write_text(traceback.format_exc())\n            return _internal_error(\n                method=method,\n                path=path,\n                error_code="cli_binding_revoke_failed",`));
    const scopePath=join(directory,'backend-ts/src/wechat-scope-api.ts'),scopeCode=await readFile(scopePath,'utf8');
    await writeFile(scopePath,`import {writeFileSync as writeDiagnostic} from 'node:fs';\n`+scopeCode.replace('    } catch (error) {',`    } catch (error) {writeDiagnostic(${JSON.stringify(log)},String((error as Error).stack));`));
    t.after(async()=>{try{t.diagnostic(await readFile(log,'utf8'));}catch{}});
  }
  return directory;
  } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
}
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await delay(100);}throw new Error(`等待失败：${label}`);}
async function fixture(t){
  const isolated=process.env.NOTALONE_TEST_INCREMENTAL_OVERLAY==='1';
  const project=isolated?await overlay(t):root,f=await createStorageFixture();
  t.after(async()=>{for(const host of f.hosts??[])await host.terminate();await f.close();if(isolated)await rm(project,{recursive:true,force:true});});
  const owner=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const control=join(f.directory,'control.json'),log=join(f.directory,'commands.jsonl'),secrets=join(f.directory,'internal-fixture.json'),executable=join(f.directory,'synthetic-cli');
  await writeFile(control,JSON.stringify({incremental:false}));await writeFile(log,'');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,parent:process.ppid,hang:state.hang===true})+'\\n');
if(process.env.NOTALONE_SYNC_INCREMENTAL_TOKEN)fs.writeFileSync(${JSON.stringify(secrets)},JSON.stringify({token:process.env.NOTALONE_SYNC_INCREMENTAL_TOKEN}),{mode:0o600});
const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成联系人',chat_type:'private'}]});
else if(args.includes('--follow'))setInterval(()=>{},1000);
else if(args[0]==='tail'&&state.hang&&!args.includes('--history')){process.on('SIGTERM',()=>{emit({events:[{type:'message',cursor:'late-3',message:{id:{local_id:3,talker:args[1]},kind:'text',text:'合成迟到消息',is_from_me:false,create_time:1792803603}}],cursor:'late-3',freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history:false}});process.exit(0);});setInterval(()=>{},1000);}
else if(args[0]==='tail'){
 const history=args.includes('--history'),cursor=args.includes('--cursor')?args[args.indexOf('--cursor')+1]:null;
 const messages=history?(cursor?[]:[{id:1,cursor:'history-1',text:'合成既有历史'}]):state.incremental&&cursor!=='incremental-2'?[{id:2,cursor:'incremental-2',text:'合成增量'}]:[];
 emit({events:messages.map(m=>({type:'message',cursor:m.cursor,message:{id:{local_id:m.id,talker:args[1]},kind:'text',text:m.text,is_from_me:false,create_time:1792803600+m.id}})),cursor:messages.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history}});
}else process.exit(2);`,{mode:0o700});
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_WECHAT_CLI=${executable}\n`);
  const app=await start(t,f,{},project);
  return {...f,owner,app,control,log,secrets,async commands(){return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}};
}
test('官方profile：公开开关、原消息事件、历史唯一写者与私有认证', {timeout:90000},async t=>{
  const f=await fixture(t);
  const runtime=await f.app.request('/api/runtime/status');assert.equal(runtime.data.runtime,'dsh');
  await until(async()=>(await f.app.request('/api/sync/status')).status===200,'启动状态恢复',15000);
  const confirmed=await f.app.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:true});if(confirmed.status!==200){t.diagnostic(JSON.stringify({sync:await f.app.request('/api/sync/status'),bindings:await f.app.request('/api/sync/cli-bindings'),commands:await f.commands()}));}assert.equal(confirmed.status,200,JSON.stringify(confirmed));
  const bindings=await f.app.request('/api/sync/cli-bindings'),binding=bindings.data.bindings[0];assert.ok(binding);
  const abort=new AbortController();t.after(()=>abort.abort());let events='',eventError=null;
  const eventReader=fetch(`http://${f.app.connection.address}/api/events`,{headers:{Authorization:`Bearer ${f.app.connection.token}`},signal:abort.signal}).then(async response=>{assert.equal(response.status,200);for await(const chunk of response.body)events+=Buffer.from(chunk).toString('utf8');}).catch(error=>{if(!abort.signal.aborted)eventError=error;});
  t.after(async()=>{abort.abort();await eventReader;});
  const on=await f.app.request('/api/sync/enable',{});assert.equal(on.status,200,JSON.stringify(on));
  const history=await until(async()=>{const r=await f.app.request(`/api/contacts/${binding.contact_id}/messages`);return r.data.messages?.length===1?r.data.messages[0]:null;},'既有历史');
  await writeFile(f.control,JSON.stringify({incremental:true}));
  assert.equal((await f.app.request('/api/sync/check',{})).status,200);
  const messages=await until(async()=>{const r=await f.app.request(`/api/contacts/${binding.contact_id}/messages`);return r.data.messages?.length===2?r.data.messages:null;},'增量入库');
  await until(async()=>events.includes('message.created')&&events.includes(messages.find(m=>m.message_id!==history.message_id)?.message_id??'not-found'),'原事件总线');
  assert.equal(eventError,null);
  assert.ok(!events.includes('合成增量'),'通知不得携带正文');
  const commands=await f.commands(),tails=commands.filter(v=>v.args[0]==='tail'&&!v.args.includes('--follow'));
  assert.ok(tails.some(v=>v.args.includes('--history')&&v.parent===runtime.data.legacyPid),'历史只有Python读取');
  assert.ok(tails.some(v=>!v.args.includes('--history')&&v.parent===runtime.data.pid),'增量只有TS读取');
  assert.ok(!tails.some(v=>v.args.includes('--history')&&v.parent===runtime.data.pid||!v.args.includes('--history')&&v.parent===runtime.data.legacyPid));
  const internal=JSON.parse(await readFile(f.secrets,'utf8')).token;
  const payload={owner_id:f.owner,channel:'wechat',account_scope:'synthetic-account'};
  for(const route of ['cycle','status','events'])assert.equal((await f.app.request(`/api/runtime/sync-incremental/${route}`,payload)).status,401);
  assert.equal((await f.app.request('/api/runtime/sync-incremental/status',payload,internal)).status,200);
  const origin=await fetch(`http://${f.app.connection.address}/api/runtime/sync-incremental/status`,{method:'POST',headers:{Authorization:`Bearer ${internal}`,Origin:'','Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(origin.status,401);
  const traversal=await new Promise((resolve,reject)=>{const req=rawRequest(`http://${f.app.connection.address}`,{method:'POST',path:'/api/sync/../runtime/sync-incremental/status',headers:{Authorization:`Bearer ${internal}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(payload));});assert.equal(traversal,400);
  const disabled=await f.app.request('/api/sync/disable',{});assert.equal(disabled.status,200,JSON.stringify(disabled));
  const before=(await f.commands()).length;assert.equal((await f.app.request('/api/sync/check',{})).status,200);assert.equal((await f.commands()).length,before);
  const revoked=await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:binding.contact_id,binding_id:binding.binding_id});assert.equal(revoked.status,200,JSON.stringify(revoked));
  assert.equal((await f.app.request('/api/sync/cli-bindings')).data.bindings.length,0);
});

for(const action of ['disable','revoke','shutdown'])test(`官方profile：挂起增量读取时${action}排空且不保存迟到消息`,{timeout:30000},async t=>{
  const f=await fixture(t);
  await until(async()=>(await f.app.request('/api/sync/status')).status===200,'宿主启动',15000);
  const confirmed=await f.app.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:true});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed));
  const binding=(await f.app.request('/api/sync/cli-bindings')).data.bindings[0];
  assert.equal((await f.app.request('/api/sync/enable',{})).status,200);
  await until(async()=>(await f.app.request(`/api/contacts/${binding.contact_id}/messages`)).data.messages?.length===1,'历史完成');
  await writeFile(f.control,JSON.stringify({incremental:true,hang:true}));
  const checking=f.app.request('/api/sync/check',{}).catch(error=>({error:String(error)}));
  await until(async()=>(await f.commands()).some(v=>v.hang&&v.args[0]==='tail'&&!v.args.includes('--history')),'增量tail已进入挂起');
  const started=Date.now();
  if(action==='revoke'){
    const result=await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:binding.contact_id,binding_id:binding.binding_id});
    assert.equal(result.status,200,JSON.stringify(result));
    assert.equal((await f.app.request('/api/sync/cli-bindings')).data.bindings.length,0);
    assert.equal((await f.app.request('/api/sync/disable',{})).status,200);
  } else if(action==='disable'){
    const result=await f.app.request('/api/sync/disable',{});
    assert.equal(result.status,200,JSON.stringify(result));
  } else {
    await f.app.host.terminate();
    assert.equal(f.app.host.isRunning(),false);
  }
  const controlElapsed=Date.now()-started;
  await checking;
  t.diagnostic(JSON.stringify({action,controlElapsed,totalElapsed:Date.now()-started}));
  assert.ok(Date.now()-started<5000,'关闭/撤销必须有界排空');
  const persisted=await f.client.query('SELECT count(*)::int AS count FROM message WHERE owner_id=$1 AND contact_id=$2',[f.owner,binding.contact_id]);
  assert.equal(persisted.rows[0].count,1,'挂起增量不得保存或恢复授权');
});
