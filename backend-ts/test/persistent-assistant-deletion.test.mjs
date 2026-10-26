/** 真实生产 Host 删除、同业务目录重启与磁盘检查；只替换供应商网络。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,rm,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
async function fixture(t){
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),session=randomUUID();
 const home=join(f.directory,'host'),info=join(f.directory,'backend.info');let child,exited,output='',gate,readGate;
 const requests=[],releaseGates=new Set();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成删除用户')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成删除联系人')",[contact,owner]);
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default) VALUES($1,$2,$3,true)',[session,owner,contact]);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.client.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_SKILLS_DIR=${f.directory}/skills\nNOTALONE_MANAGED_USER_DATA=${f.directory}\n`,{mode:0o600});
 const readTrigger=join(f.directory,'hold-runtime-read'),closeTrigger=join(f.directory,'fail-commit-close'),closeObserved=join(f.directory,'commit-close-failed'),readPreload=join(f.directory,'read-barrier.mjs');
 await writeFile(readPreload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const original=fs.promises.readFile,originalOpen=fs.promises.open,locks=new Map(),held=[];
 fs.promises.open=async function(path,...args){const handle=await originalOpen.call(this,path,...args);if(String(path).includes('/assistant-runtime/')&&String(path).endsWith('/session.lock')){const count=(locks.get(String(path))??0)+1;locks.set(String(path),count);if(count===2&&fs.existsSync(${JSON.stringify(closeTrigger)})){fs.unlinkSync(${JSON.stringify(closeTrigger)});held.push(handle);handle.close=async()=>{fs.writeFileSync(${JSON.stringify(closeObserved)},'synthetic commit close failure');throw Object.assign(new Error('synthetic commit close failure'),{code:'EIO'});};}}return handle;};
 fs.promises.readFile=async function(path,...args){if(String(path).includes('/assistant-runtime/')&&String(path).endsWith('.jsonl')&&fs.existsSync(${JSON.stringify(readTrigger)})){fs.unlinkSync(${JSON.stringify(readTrigger)});await fetch(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL+'/runtime-read');}return original.call(this,path,...args);};syncBuiltinESMExports();`,{mode:0o600});
 const provider=createServer(async(req,res)=>{
  if(req.url==='/runtime-read'){const held=readGate;readGate=undefined;held.enter();await held.wait;res.end('released');return;}
  let raw='';for await(const part of req)raw+=part;requests.push(JSON.parse(raw));
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'合成已保存候选',basis:'本次合成原句',citation_ids:['c1'],risk_notes:[]}]});
  if(gate){const waiting=gate;gate=undefined;waiting.enter();await waiting.wait;}sendEvents(res,events);
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}await rm(info,{force:true});};
 t.after(async()=>{for(const release of releaseGates)release();await stop();provider.closeAllConnections();await new Promise(r=>provider.close(r));await f.close();});
 const start=async()=>{
  await mkdir(join(home,'profiles/notalone'),{recursive:true});
  await writeFile(join(home,'profiles/notalone/package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(home,'profiles/notalone/cordis.patch.yml'),(await readFile('profile/host.patch.yml','utf8')).replace('PLUGIN_PATH',JSON.stringify(resolve('src/host-plugin.ts'))));
  await writeFile(join(home,'host.json'),JSON.stringify({projectDirectory:resolve('..'),envFilePath:f.envFilePath,infoPath:info,businessHome:f.directory,persistentAssistantHome:f.directory,home,parentPid:process.pid}));
  child=spawn(process.execPath,['--import',resolve('test/main-host-reply-chain-preload.mjs'),'--import',readPreload,resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_HOST_CONFIG:join(home,'host.json'),NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`},stdio:['pipe','pipe','pipe']});
  exited=once(child,'exit');output='';child.stderr.on('data',b=>{output+=b;});child.stdout.on('data',b=>{output+=b;});
  let connection;for(let i=0;i<150&&child.exitCode===null&&child.signalCode===null;i++){try{connection=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(line=>line.split('=')));break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(connection,'生产Host须发布握手：'+output);
  const request=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(`http://${connection.address}${path}`,{method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json',...(path.includes('/assistant-session')?{'X-NotAlone-Manual-Contact':contact}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  const confirmed=await request(`/api/contacts/${contact}/manual-confirmation`,{});assert.ok([200,404].includes(confirmed.status),JSON.stringify(confirmed));return request;
 };
 const directory=join(f.directory,'assistant-runtime',owner,contact,session);
 const seed=async()=>{const runtime=randomUUID();await mkdir(join(directory,runtime,'forks'),{mode:0o700,recursive:true});for(const path of [join(f.directory,'assistant-runtime'),join(f.directory,'assistant-runtime',owner),join(f.directory,'assistant-runtime',owner,contact),directory])await chmod(path,0o700);await writeFile(join(directory,'ownership.json'),JSON.stringify({version:1,owner_id:owner,contact_id:contact,session_id:session}),{mode:0o600});await writeFile(join(directory,runtime,'forks','synthetic.jsonl'),'合成运行正文');await f.client.query("INSERT INTO assistant_runtime_session(owner_id,contact_id,session_id,runtime_session_id,configuration_sha256,state) VALUES($1,$2,$3,$4,$5,'dirty')",[owner,contact,session,runtime,'a'.repeat(64)]);};
 return {...f,owner,contact,session,directory,requests,start,stop,seed,failCommitClose:async()=>{await writeFile(closeTrigger,'synthetic');},closeObserved,holdRead:async()=>{let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);readGate={enter,wait};releaseGates.add(release);await writeFile(readTrigger,'synthetic');return {entered,release};},path:`/api/contacts/${contact}/assistant-sessions/${session}`,input:text=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:text,include_relationship_context:false},skill_disabled:true}),hold:()=>{let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);gate={enter,wait};releaseGates.add(release);return {entered,release};}};
}
test('生产公开会话删除清除归属运行分叉并在同目录重启后保持删除',{timeout:45000},async t=>{
 const f=await fixture(t);await f.seed();let request=await f.start();
 const deleted=await request(f.path,{confirmed:true},'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted));
 await assert.rejects(stat(f.directory),{code:'ENOENT'});
 await f.stop();request=await f.start();assert.equal((await request(f.path)).status,404);assert.equal(f.requests.length,0);
});

test('生产Host删除等待真实在途写者释放，迟到供应商结果及旧键跨重启不复活',{timeout:45000},async t=>{
 const f=await fixture(t);let request=await f.start();
 const first=f.input('合成首轮待删正文'),initial=await request(f.path+'/replies',first);assert.equal(initial.status,200,JSON.stringify(initial));
 assert.ok((await stat(f.directory)).isDirectory(),'本轮显式合成配置保存官方运行档案');
 const gate=f.hold(),input=f.input('合成在途删除正文'),running=request(f.path+'/replies',input);await gate.entered;
 const deleted=await request(f.path,{confirmed:true},'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted));
 gate.release();assert.notEqual((await running).status,200);await assert.rejects(stat(f.directory),{code:'ENOENT'});
 await f.stop();request=await f.start();assert.equal((await request(f.path)).status,404);
 assert.notEqual((await request(f.path+'/replies',input)).status,200);assert.equal(f.requests.length,2);
});

test('生产来源删除清除真实JSONL，清理失败跨重启保留阻断且明确重试可收敛',{timeout:45000},async t=>{
 const f=await fixture(t),source=randomUUID(),message=randomUUID();let request=await f.start();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'d'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成需清除的来源正文',now())",[message,f.owner,f.contact]);
 await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const input={contact_id:f.contact,idempotency_key:randomUUID(),content:{type:'reply_to_message',target_message_id:message,direction:'说明收到'},skill_disabled:true};
 const generated=await request(f.path+'/replies',input);assert.equal(generated.status,200,JSON.stringify(generated));
 const marker=join(f.directory,'ownership.json'),identity=await readFile(marker,'utf8');
 await writeFile(marker,'{"version":1,"unverified":true}');
 const accepted=await request(`/api/contacts/${f.contact}/sources/${source}`,undefined,'DELETE');assert.equal(accepted.status,202,JSON.stringify(accepted));
 const operation=accepted.body.task_id;assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');
 assert.ok((await stat(f.directory)).isDirectory(),'未知归属目录不得删除');
 assert.doesNotMatch(JSON.stringify((await request(f.path)).body),/合成需清除的来源正文|合成已保存候选/);
 await f.stop();request=await f.start();assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');
 const before=f.requests.length;assert.notEqual((await request(f.path+'/replies',f.input('失败期间不得恢复或出站'))).status,200);assert.equal(f.requests.length,before);
 await writeFile(marker,identity);await request('/api/deletions/'+operation+'/retry',{confirmed:true});
 const completed=(await request('/api/deletions/'+operation)).body;assert.equal(completed.status,'succeeded');assert.equal(completed.contact_id,undefined);assert.equal(completed.target_id,undefined);await assert.rejects(stat(f.directory),{code:'ENOENT'});
 await f.stop();request=await f.start();assert.notEqual((await request(f.path+'/replies',input)).status,200);assert.equal(f.requests.length,before);
});

test('删除等待真实官方恢复读档结束，等待期间阻断新恢复与出站',{timeout:45000},async t=>{
 const f=await fixture(t),request=await f.start();assert.equal((await request(f.path+'/replies',f.input('合成读取前档案'))).status,200);
 const gate=await f.holdRead(),prepared=request(f.path+'/replies/prepare',f.input('合成被阻塞恢复'));await gate.entered;
 let finished=false;const removing=request(f.path,{confirmed:true},'DELETE').then(value=>{finished=true;return value;});
 let running=false;for(let i=0;i<40;i++){const operations=(await request('/api/deletions')).body.operations;if(operations.some(operation=>operation.status==='running')){running=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(running,true,'删除操作进入持久屏障');assert.equal(finished,false,'read未完成前不可报告物理清盘成功');assert.ok((await stat(f.directory)).isDirectory());
 const before=f.requests.length;assert.notEqual((await request(f.path+'/replies/prepare',f.input('删除期间的新恢复'))).status,200);assert.equal(f.requests.length,before);
 gate.release();assert.notEqual((await prepared).status,200);assert.equal((await removing).status,200);await assert.rejects(stat(f.directory),{code:'ENOENT'});assert.equal(f.requests.length,before);
});

async function backup(f){
 const managed=join(f.directory.split('/assistant-runtime/')[0],'managed');
 const home=f.directory.split('/assistant-runtime/')[0],folder=join(home,'updates',randomUUID());
 await mkdir(managed,{mode:0o700});await mkdir(folder,{mode:0o700,recursive:true});await chmod(join(home,'updates'),0o700);
 await writeFile(join(managed,'state.json'),JSON.stringify({formatVersion:1,bootstrapComplete:true}),{mode:0o600});
 const identity=(await f.client.query('SELECT system_identifier::text,d.oid,d.datname,d.datdba FROM pg_catalog.pg_control_system(),pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()')).rows[0];
 const fingerprint=createHash('sha256').update(JSON.stringify([identity.system_identifier,identity.oid,identity.datname,identity.datdba])).digest('hex');
 await writeFile(join(folder,'checkpoint.json'),JSON.stringify({format_version:1,target_fingerprint:fingerprint,phase:'complete',restore_verified:true,connection_gate:false}),{mode:0o600});
 const path=join(folder,'database.dump');await writeFile(path,'合成应用管理恢复副本',{mode:0o600});return path;
}

test('会话级联后清盘失败保留公开operation，离线重启可明确重试并清除受管恢复副本',{timeout:45000},async t=>{
 const f=await fixture(t);let request=await f.start();assert.equal((await request(f.path+'/replies',f.input('合成必须彻底删除正文'))).status,200);
 const recovery=await backup(f),marker=join(f.directory,'ownership.json'),identity=await readFile(marker,'utf8');await writeFile(marker,'unverified');
 const accepted=await request(f.path,{confirmed:true},'DELETE');assert.equal(accepted.status,202,JSON.stringify(accepted));const operation=accepted.body.operation_id;
 assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');
 const pending=(await request(`/api/deletions?contact_id=${f.contact}&scope_kind=discussion`)).body.operations;assert.equal(pending[0].target_id,f.session);assert.equal(pending[0].contact_id,f.contact);assert.equal((await request(`/api/deletions?contact_id=${randomUUID()}&scope_kind=discussion`)).body.operations.length,0);
 assert.equal((await request(f.path)).status,404);assert.ok((await stat(f.directory)).isDirectory());await assert.rejects(stat(recovery),{code:'ENOENT'});
 await f.stop();await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.client.database}\nNOTALONE_OWNER_ID=${f.owner}\nNOTALONE_SKILLS_DIR=${f.directory.split('/assistant-runtime/')[0]}/skills\n`);request=await f.start();
 assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');assert.equal(f.requests.length,1);
 await writeFile(marker,identity);await request('/api/deletions/'+operation+'/retry',{confirmed:true});assert.equal((await request('/api/deletions/'+operation)).body.status,'succeeded');await assert.rejects(stat(f.directory),{code:'ENOENT'});assert.equal(f.requests.length,1);
});

test('生产联系人删除清理其全部运行目录和恢复副本，保留无关联系人档案及用户另存目录',{timeout:45000},async t=>{
 const f=await fixture(t),request=await f.start();assert.equal((await request(f.path+'/replies',f.input('合成联系人第一段'))).status,200);
 const next=(await request(`/api/contacts/${f.contact}/assistant-sessions`,{}));assert.equal(next.status,200,JSON.stringify(next));
 const nextPath=`/api/contacts/${f.contact}/assistant-sessions/${next.body.session_id}`;assert.equal((await request(nextPath+'/replies',f.input('合成联系人第二段'))).status,200);
 const home=f.directory.split('/assistant-runtime/')[0],unmanaged=join(home,'用户另存资料');await mkdir(unmanaged,{mode:0o700});await writeFile(join(unmanaged,'keep.txt'),'合成用户另存');
 const other=randomUUID(),otherSession=randomUUID();await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'无关联系人')",[other,f.owner]);await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[otherSession,f.owner,other]);
 const otherDirectory=join(home,'assistant-runtime',f.owner,other,otherSession);await mkdir(otherDirectory,{mode:0o700,recursive:true});await writeFile(join(otherDirectory,'keep.txt'),'合成无关运行正文');
 const recovery=await backup(f),accepted=await request(`/api/contacts/${f.contact}`,{confirmed:true,confirm_contact_id:f.contact},'DELETE');assert.equal(accepted.status,202,JSON.stringify(accepted));
 assert.equal((await request('/api/deletions/'+accepted.body.operation_id)).body.status,'succeeded');await assert.rejects(stat(f.directory),{code:'ENOENT'});await assert.rejects(stat(join(home,'assistant-runtime',f.owner,f.contact,next.body.session_id)),{code:'ENOENT'});await assert.rejects(stat(recovery),{code:'ENOENT'});
 assert.equal(await readFile(join(otherDirectory,'keep.txt'),'utf8'),'合成无关运行正文');assert.equal(await readFile(join(unmanaged,'keep.txt'),'utf8'),'合成用户另存');
 await f.stop();await f.start();assert.equal(f.requests.length,2);assert.ok((await stat(otherDirectory)).isDirectory());
});

test('来源闭包清理显式携入的跨会话存档，保留无关业务讨论及其运行档案',{timeout:45000},async t=>{
 const f=await fixture(t),request=await f.start(),source=randomUUID(),message=randomUUID();
 const independent=await request(f.path+'/replies',f.input('合成无关讨论应长期保留'));assert.equal(independent.status,200,JSON.stringify(independent));
 const sourceSession=(await request(`/api/contacts/${f.contact}/assistant-sessions`,{})).body.session_id,sourcePath=`/api/contacts/${f.contact}/assistant-sessions/${sourceSession}`;
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'e'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成仅来源会话可用正文',now())",[message,f.owner,f.contact]);
 await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const generated=await request(sourcePath+'/replies',{contact_id:f.contact,idempotency_key:randomUUID(),content:{type:'reply_to_message',target_message_id:message,direction:'说明收到'},skill_disabled:true});assert.equal(generated.status,200,JSON.stringify(generated));
 const candidate=generated.body.candidates[0].candidate_id,selection=await request(sourcePath+'/selections',{candidate_id:candidate,version_id:candidate,selection_key:randomUUID()});assert.equal(selection.status,200,JSON.stringify(selection));
 const carry=await request(sourcePath+'/new-with-candidate',{expected_selection_id:selection.body.selection_id,candidate_id:candidate,version_id:candidate});assert.equal(carry.status,200,JSON.stringify(carry));
 const childPath=`/api/contacts/${f.contact}/assistant-sessions/${carry.body.session_id}`,child=await request(childPath+'/replies',f.input('合成携入后继续要求'));assert.equal(child.status,200,JSON.stringify(child));
 const accepted=await request(`/api/contacts/${f.contact}/sources/${source}`,undefined,'DELETE');assert.equal((await request('/api/deletions/'+accepted.body.task_id)).body.status,'succeeded');
 const home=f.directory.split('/assistant-runtime/')[0];for(const session of [sourceSession,carry.body.session_id])await assert.rejects(stat(join(home,'assistant-runtime',f.owner,f.contact,session)),{code:'ENOENT'});
 assert.ok((await stat(f.directory)).isDirectory());assert.match(JSON.stringify((await request(f.path)).body),/合成无关讨论应长期保留/);
 assert.doesNotMatch(JSON.stringify((await request(sourcePath)).body),/合成仅来源会话可用正文|合成已保存候选/);assert.doesNotMatch(JSON.stringify((await request(childPath)).body),/合成携入后继续要求|合成已保存候选/);
 await f.stop();const restarted=await f.start();assert.match(JSON.stringify((await restarted(f.path)).body),/合成无关讨论应长期保留/);assert.equal(f.requests.length,3);
});

test('来源删除在备份核验失败前持久封禁恢复出站，重启保留并明确重试收敛',{timeout:45000},async t=>{
 const f=await fixture(t),source=randomUUID(),message=randomUUID();let request=await f.start();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'d'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成备份失败前必须阻断的来源正文',now())",[message,f.owner,f.contact]);
 await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const initial=await request(f.path+'/replies',{contact_id:f.contact,idempotency_key:randomUUID(),content:{type:'reply_to_message',target_message_id:message,direction:'说明收到'},skill_disabled:true});assert.equal(initial.status,200,JSON.stringify(initial));
 const independent=(await request(`/api/contacts/${f.contact}/assistant-sessions`,{})).body.session_id,independentPath=`/api/contacts/${f.contact}/assistant-sessions/${independent}`;
 assert.equal((await request(independentPath+'/replies',f.input('合成无关讨论及档案保持'))).status,200);
 const home=f.directory.split('/assistant-runtime/')[0],unknown=join(home,'updates','unverified');await mkdir(unknown,{mode:0o700,recursive:true});await chmod(join(home,'updates'),0o700);await writeFile(join(unknown,'keep.txt'),'合成未知恢复目录');
 const accepted=await request(`/api/contacts/${f.contact}/sources/${source}`,undefined,'DELETE'),operation=accepted.body.task_id;
 assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');const before=f.requests.length;
 const blocked=await request(f.path+'/replies',f.input('清理未完成不得恢复旧来源'));assert.notEqual(blocked.status,200);assert.equal(blocked.body.error,'reply_deletion_pending');assert.equal(f.requests.length,before,'失败后不能再次把旧历史外发');
 await f.stop();request=await f.start();assert.notEqual((await request(f.path+'/replies',f.input('重启仍不可外发'))).status,200);assert.equal(f.requests.length,before);
 assert.equal(await readFile(join(unknown,'keep.txt'),'utf8'),'合成未知恢复目录');assert.match(JSON.stringify((await request(independentPath)).body),/合成无关讨论及档案保持/);const independentDirectory=join(home,'assistant-runtime',f.owner,f.contact,independent);assert.ok((await stat(independentDirectory)).isDirectory());
 await rm(unknown,{recursive:true});await request('/api/deletions/'+operation+'/retry',{confirmed:true});assert.equal((await request('/api/deletions/'+operation)).body.status,'succeeded');await assert.rejects(stat(f.directory),{code:'ENOENT'});assert.ok((await stat(independentDirectory)).isDirectory());
 assert.equal((await request(independentPath+'/replies',f.input('清理后无关讨论可以继续'))).status,200);assert.equal(f.requests.length,before+1);assert.doesNotMatch(JSON.stringify(f.requests.at(-1)),/合成备份失败前必须阻断的来源正文/);
});

test('兼容公开生成无turn时联系人删除仍取消并等待真实供应商轮',{timeout:45000},async t=>{
 const f=await fixture(t);await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-delete','friend-delete')",[randomUUID(),f.owner,f.contact]);
 const request=await f.start(),gate=f.hold();let settled=false;
 const running=request('/api/reply/generate',f.input('合成无turn在途正文')).then(value=>{settled=true;return value;});await gate.entered;
 try{const accepted=await request(`/api/contacts/${f.contact}`,{confirmed:true,confirm_contact_id:f.contact},'DELETE');assert.equal((await request('/api/deletions/'+accepted.body.operation_id)).body.status,'succeeded');assert.equal(settled,true,'删除成功前须取消并等已授权的临时轮释放');assert.notEqual((await running).status,200);}finally{gate.release();await running;}
});

test('提交写句柄真实关闭失败保留占用，当前删除不得成功且真实重启可收敛',{timeout:45000},async t=>{
 const f=await fixture(t);let request=await f.start();await f.failCommitClose();
 const generated=await request(f.path+'/replies',f.input('合成提交句柄关闭失败'));assert.notEqual(generated.status,200);assert.equal(await readFile(f.closeObserved,'utf8'),'synthetic commit close failure','必须命中官方提交屏障自有锁句柄');
 const accepted=await request(f.path,{confirmed:true},'DELETE');assert.equal(accepted.status,202,'未确认释放的写者不能被算成清盘完成');const operation=accepted.body.operation_id;assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');assert.ok((await stat(f.directory)).isDirectory());
 await f.stop();request=await f.start();assert.equal((await request('/api/deletions/'+operation)).body.status,'failed');await request('/api/deletions/'+operation+'/retry',{confirmed:true});assert.equal((await request('/api/deletions/'+operation)).body.status,'succeeded');await assert.rejects(stat(f.directory),{code:'ENOENT'});assert.equal(f.requests.length,1);
});

for(const kind of ['source','account'])test(`兼容无turn临时轮按${kind}删除范围取消并结算`,{timeout:45000},async t=>{
 const f=await fixture(t),source=randomUUID();await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-scope','friend-scope')",[randomUUID(),f.owner,f.contact]);
 if(kind==='source')await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,f.owner,f.contact,'a'.repeat(64)]);
 const request=await f.start(),gate=f.hold();let settled=false;const running=request('/api/reply/generate',f.input('合成范围临时轮')).then(value=>{settled=true;return value;});await gate.entered;
 try{const accepted=kind==='source'?await request(`/api/contacts/${f.contact}/sources/${source}`,undefined,'DELETE'):await request('/api/account',{confirmed:true,confirm_scope:'account'},'DELETE');
 const operation=accepted.body.operation_id??accepted.body.task_id;assert.equal((await request('/api/deletions/'+operation)).body.status,'succeeded');assert.equal(settled,true);assert.notEqual((await running).status,200);assert.equal(f.requests.length,1);}finally{gate.release();await running;}
});

test('讨论级删除不取消同联系人无关联的兼容临时轮',{timeout:45000},async t=>{
 const f=await fixture(t);await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-independent','friend-independent')",[randomUUID(),f.owner,f.contact]);
 const request=await f.start(),gate=f.hold();let settled=false;const running=request('/api/reply/generate',f.input('合成独立临时轮')).then(value=>{settled=true;return value;});await gate.entered;
 try{const deleted=await request(f.path,{confirmed:true},'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted));assert.equal(settled,false,'无关联临时轮不属于该讨论删除范围');gate.release();assert.equal((await running).status,200);assert.equal(f.requests.length,1);}finally{gate.release();await running;}
});
