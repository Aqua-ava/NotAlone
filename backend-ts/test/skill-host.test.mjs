/** 真实PG与固定loopback RPC；不运行模型，不从scratch加载产品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {HostStorage} from '../src/host-storage.ts';
import {SkillHost} from '../src/skill-host.ts';
async function fixture(t){const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());const {owner_id:owner}=await storage.initializeOwner('合成用户');const root=join(f.directory,'skills'),host=new SkillHost(storage,root);t.after(()=>host.close());return {f,storage,owner,root,host};}
async function activate(host,port=1){let configuration;const calls=[];await host.transfer({control:async(path,method,body)=>{calls.push(path);if(path.endsWith('/activate')){configuration=body;return {state:'remote',active_requests:0};}return {state:'stopped',active_requests:0};}},port);return {configuration,calls};}
test('私有同步认证owner/精确响应并由原Python Remote实际同步目录',async t=>{
 const x=await fixture(t);const server=createServer((req,res)=>{void x.host.privateHttp(req,res).then(done=>{if(!done){res.writeHead(404);res.end();}});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,{configuration,calls}=await activate(x.host,port);assert.deepEqual(calls,['/api/runtime/skill-management/stop','/api/runtime/skill-management/status','/api/runtime/skill-management/activate']);
 const endpoint=`http://127.0.0.1:${port}/api/runtime/skill-management/synchronize`;
 const request=(token,owner=x.owner)=>fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({owner_id:owner})});
 assert.equal((await request('public-token')).status,401);assert.equal((await request(configuration.token,randomUUID())).status,400);
 const packageRoot=join(x.root,x.owner,'gentle-reply');await mkdir(packageRoot,{recursive:true});await writeFile(join(packageRoot,'SKILL.md'),'---\nname: gentle-reply\ndescription: "合成目录"\n---\n\n先核实。\n');
 const script="import sys,json;from uuid import UUID;from notalone.persistence.skill_management_remote import RemoteSkillManagement;c=json.load(sys.stdin);r=RemoteSkillManagement(port=c['port'],internal_token=c['token'],owner_id=UUID(c['owner_id']));print(r.synchronize());r.close()";
 const child=spawn(process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script],{env:{PATH:'/usr/bin:/bin',PYTHONPATH:resolve('../backend/src'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);const exit=once(child,'exit');child.stdin.end(JSON.stringify(configuration));assert.equal((await exit)[0],0,errors);assert.ok(Number(output)>0);
 assert.equal((await x.f.client.query('SELECT name FROM reply_skill WHERE owner_id=$1',[x.owner])).rows[0].name,'gentle-reply');
 const response=await request(configuration.token),body=await response.text();assert.equal(response.status,200);assert.equal(response.headers.get('transfer-encoding'),null);assert.equal(Number(response.headers.get('content-length')),Buffer.byteLength(body));
 await x.host.close();assert.equal((await request(configuration.token)).status,503);
});
test('未排空或activate失败保持不可用，无请求fallback',async t=>{
 const x=await fixture(t);let activated=false;
 await assert.rejects(x.host.transfer({control:async(path)=>{if(path.endsWith('/stop'))return {state:'python',active_requests:0};activated=true;return {};}},1),{code:'skill_handoff_failed'});assert.equal(activated,false);assert.throws(()=>x.host.enter(),{code:'skill_unavailable'});
 await assert.rejects(x.host.transfer({control:async(path)=>{if(path.endsWith('/activate'))throw Error('synthetic_ack_lost');return {state:'stopped',active_requests:0};}},1));assert.throws(()=>x.host.enter(),{code:'skill_unavailable'});
});
test('关闭排空既有管理租约，晚发布断言失效',async t=>{
 const x=await fixture(t);await activate(x.host);const lease=x.host.enter();let done=false;const closing=x.host.close().then(()=>done=true);await Promise.resolve();assert.equal(done,false);assert.throws(lease.assertCurrent,{code:'skill_unavailable'});assert.throws(()=>x.host.enter(),{code:'skill_unavailable'});lease.finish();await closing;assert.equal(done,true);
});

test('管理C守卫复用真实讨论快照与来源，同事务拒异owner/篡改/删除',async t=>{
 const {setup}=await import('./reply-assistant-erasure-support.mjs');const {fingerprint}=await import('../src/reply-assistant-erasure.ts');
 const x=await setup(t),source=randomUUID(),discussion=randomUUID(),g=await x.generation();
 await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,x.owner,x.contact,'d'.repeat(64)]);
 const content={type:'purpose_exploration',text:'合成讨论'};
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7)",[discussion,x.session,x.owner,x.contact,x.binding,JSON.stringify(content),[source]]);
 const snap={version:1,scope:{owner_id:x.owner,contact_id:x.contact},session_id:x.session,request_key:g.key,current_input_version_id:g.input,current_turn_id:g.turn,current_payload_sha256:fingerprint(['a'.repeat(64),g.payload,x.binding]),records:[{kind:'discussion_input',input_version_id:discussion,payload_sha256:fingerprint([content,x.binding,[source]]),turn_id:null,candidate_id:null,version_id:null}]};
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({assistant_discussion_snapshot:snap})]);
 const storage=await HostStorage.open({...x.f.options,environment:{NOTALONE_OWNER_ID:x.owner}});t.after(()=>storage.close());const host=new SkillHost(storage,join(x.f.directory,'skills'));t.after(()=>host.close());
 const requireSources=host.library.options.requireDiscussionDependencies;
 await assert.rejects(requireSources(x.f.client,x.owner,x.contact,g.request),{code:'reply_context_invalidated'},'缺原始来源使用回执须拒绝');
 await x.f.client.query('INSERT INTO reply_original_source_use(reply_request_id,source_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[g.request,source,x.owner,x.contact]);
 await x.f.client.query('BEGIN');try{await x.f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${x.owner}`]);assert.deepEqual(await requireSources(x.f.client,x.owner,x.contact,g.request),[source]);}finally{await x.f.client.query('ROLLBACK');}
 await assert.rejects(requireSources(x.f.client,randomUUID(),x.contact,g.request),{code:'reply_context_invalidated'});
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({assistant_discussion_snapshot:{...snap,current_payload_sha256:'0'.repeat(64)}})]);
 await assert.rejects(requireSources(x.f.client,x.owner,x.contact,g.request));
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({assistant_discussion_snapshot:snap})]);
 await x.f.client.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[source]);
 await assert.rejects(requireSources(x.f.client,x.owner,x.contact,g.request),{code:'reply_context_invalidated'});
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_request')).rows[0].n,1,'管理核验不能创建占位回复');
});

test('真实删除事务在close后晚返回必须回滚，原版本/文件仍在',async t=>{
 const x=await fixture(t);await activate(x.host);
 const packageRoot=join(x.f.directory,'late-skill');await mkdir(packageRoot);await writeFile(join(packageRoot,'SKILL.md'),'---\nname: late-skill\ndescription: "合成晚删除"\n---\n\n保留正文。\n');
 const imported=await x.host.library.importPackage(x.owner,packageRoot);
 const transaction=x.storage.businessTransaction.bind(x.storage);let arrived,release;const entered=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
 // 在真实owner锁取得后暂停同一client，模拟删除过程中关闭；不改资格或伪造提交。
 x.storage.businessTransaction=operation=>transaction(async client=>{
  const query=client.query.bind(client);let once=false;
  const observe=async(...args)=>{const result=await query(...args);if(!once&&String(args[0]).includes('pg_advisory_xact_lock')){once=true;arrived();await gate;}return result;};
  return operation(new Proxy(client,{get(target,property,receiver){return property==='query'?observe:Reflect.get(target,property,receiver);}}));
 });
 const lease=x.host.enter();const deleting=x.host.library.delete(x.owner,imported.skill_id,lease.assertCurrent).finally(lease.finish);
 await entered;const closed=x.host.close();release();await assert.rejects(deleting,{code:'skill_unavailable'});await closed;
 assert.equal((await x.f.client.query('SELECT status FROM reply_skill WHERE id=$1',[imported.skill_id])).rows[0].status,'active');
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_skill_file_cleanup')).rows[0].n,0);
 x.storage.businessTransaction=transaction;
});

test('托管备份归属异常阻止Skill删除并保持409与原版本',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open({...f.options,environment:{NOTALONE_MANAGED_USER_DATA:f.directory}});t.after(()=>storage.close());const {owner_id:owner}=await storage.initializeOwner('合成用户');
 const host=new SkillHost(storage,join(f.directory,'skills'));t.after(()=>host.close());
 const source=join(f.directory,'backup-skill');await mkdir(source);await writeFile(join(source,'SKILL.md'),'---\nname: backup-skill\ndescription: "合成备份"\n---\n\n保留原正文。\n');
 const imported=await host.library.importPackage(owner,source);await mkdir(join(f.directory,'updates'),{mode:0o700});await writeFile(join(f.directory,'updates','unrecognized.txt'),'合成不属于可擦除档案');
 await assert.rejects(host.library.delete(owner,imported.skill_id),{code:'update_backup_cleanup_required',status:409});
 assert.equal((await f.client.query('SELECT status FROM reply_skill WHERE id=$1',[imported.skill_id])).rows[0].status,'active');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_skill_file_cleanup')).rows[0].n,0);
});
test('activate已安装远端但控制ACK未返回时，固定owner私有同步已就绪而公开仍停收',async t=>{
 const x=await fixture(t),server=createServer((req,res)=>{void x.host.privateHttp(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 await x.host.transfer({control:async(path,method,body)=>{
  if(!path.endsWith('/activate'))return {state:'stopped',active_requests:0};
  assert.throws(()=>x.host.enter(),{code:'skill_unavailable'});
  const script="import sys,json;from uuid import UUID;from notalone.persistence.skill_management_remote import RemoteSkillManagement;c=json.load(sys.stdin);r=RemoteSkillManagement(port=c['port'],internal_token=c['token'],owner_id=UUID(c['owner_id']));print(r.synchronize());r.close()";
  const child=spawn(process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script],{env:{PATH:'/usr/bin:/bin',PYTHONPATH:resolve('../backend/src'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);const exit=once(child,'exit');child.stdin.end(JSON.stringify(body));assert.equal((await exit)[0],0,errors);
  assert.throws(()=>x.host.enter(),{code:'skill_unavailable'});return {state:'remote',active_requests:0};
 }},server.address().port);
 const lease=x.host.enter();lease.finish();assert.equal(x.host.status().owner,'typescript');
});
