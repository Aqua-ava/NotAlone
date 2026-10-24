import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {HostStorage} from '../src/host-storage.ts';
import {SkillLibrary} from '../src/skill-library.ts';
import {SkillFiles} from '../src/skill-files.ts';

// 从实际模型输入读取可见 evidence，不从数据库或固定 UUID 猜引用。
function modelEvidence(body){
 const found=[];const visit=value=>{if(Array.isArray(value)){for(const item of value)visit(item);}else if(value&&typeof value==='object'){if(Array.isArray(value.evidence))found.push(...value.evidence);for(const [key,item]of Object.entries(value))if(key!=='evidence')visit(item);}else if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const start=value.indexOf('{'),end=value.lastIndexOf('}');if(start>=0&&end>start){try{visit(JSON.parse(value.slice(start,end+1)));}catch{}}}}};visit(body);assert.ok(found.length,'官方模型输入必须包含可见 evidence');return found;
}
test('已认证scope接缝：官方runtime与真实PG完整回复生命周期',{timeout:60000},async t=>{
 const f=await createStorageFixture();
 assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const body=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
 let mode='valid',observedLate,releaseLate,storage,skillStep=0;
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:async()=>{await storage?.close();await f.close();}},(_req,res,requests,events)=>{
  const evidence=modelEvidence(requests.at(-1).body);const id=evidence[0].evidence_id;
  if(mode==='skill'&&skillStep++===0){const path=JSON.stringify(requests.at(-1).body).match(/\/notalone\/reply-skills\/[^"\\ ]+\/SKILL\.md/)?.[0];assert.ok(path,'从实际Skill目录取得受控路径');useTool(events,'read_file',{file_path:path});sendEvents(res,events);return;}
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次原句',citation_ids:[mode==='bad'?randomUUID():id],risk_notes:[]}]});
  if(mode==='late'){releaseLate=()=>sendEvents(res,events);observedLate();return;}sendEvents(res,events);
 });
 // 支持夹具在进程终止后删除合成库，再核验网络边界。
 await t.test('手动确认生成保存并幂等重放，不新增物理调用',async()=>{
  const input=body(),first=await host.request('/generate',{id:randomUUID(),scope,body:input});
  assert.equal(first.candidates.length,1);assert.equal(first.candidates[0].text,'明天见');assert.ok(first.context_receipt.evidence_ids.length);
  const again=await host.request('/generate',{id:randomUUID(),scope,body:input});assert.deepEqual(again,first);assert.equal(host.requests.length,1);
  const rows=(await f.client.query('SELECT dispatch,outcome,input_tokens FROM model_call_receipt')).rows;assert.equal(rows.length,1);assert.equal(rows[0].outcome,'succeeded');assert.ok(rows[0].input_tokens>0);
 });
 await t.test('坏引用拒绝保存且不隐式重试',async()=>{
  mode='bad';const input=body(),before=host.requests.length;
  await assert.rejects(host.request('/generate',{id:randomUUID(),scope,body:input}),/reply_candidates_rejected/);assert.equal(host.requests.length,before+1);
  const count=(await f.client.query('SELECT count(*)::int AS n FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1',[input.idempotency_key])).rows[0].n;assert.equal(count,0);
 });
 await t.test('跨scope输入在出站前拒绝',async()=>{
  mode='valid';const before=host.requests.length;
  await assert.rejects(host.request('/generate',{id:randomUUID(),scope:{...scope,owner_id:randomUUID()},body:body()}));assert.equal(host.requests.length,before);
 });
 await t.test('工作区排除消息时，实际官方请求不注册历史补查工具',async()=>{
  mode='valid';const input={...body(),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'明天见',include_relationship_context:true,excluded_message_ids:[randomUUID()]}};
  await host.request('/generate',{id:randomUUID(),scope,body:input});
  const names=host.requests.at(-1).body.tools.map(tool=>tool.name);
  assert.deepEqual(names,['ReplyRuntimeOutput']);
 });
 await t.test('取消已出站调用，迟到SSE不能保存候选且许可释放',async()=>{
  mode='late';const input=body(),id=randomUUID(),observed=new Promise(resolve=>{observedLate=resolve;});
  const result=host.request('/generate',{id,scope,body:input});const rejected=assert.rejects(result);
  await Promise.race([observed,result.then(()=>{throw Error('取消前意外完成');},error=>{throw error;})]);await host.request('/cancel',{id});releaseLate();await rejected;
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1',[input.idempotency_key])).rows[0].n,0);
  assert.equal((await host.request('/health')).permits.foregroundActive,false);
 });
 await t.test('实际导入Skill经官方read_file读取并在原writer提交真实SkillUse',async()=>{
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);storage=await HostStorage.open(f.options);
  const path=join(f.directory,'synthetic-service-skill');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: synthetic-service-skill\ndescription: 合成表达策略\n---\n\n保留原句明确意愿，使用简短表达。\n');
  const library=new SkillLibrary(storage,new SkillFiles(join(host.home,'skills')));await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
  const entry=(await f.client.query('SELECT v.id FROM reply_skill_version v JOIN reply_skill s ON s.id=v.skill_id WHERE s.owner_id=$1 ORDER BY v.created_at DESC LIMIT 1',[owner])).rows[0];assert.ok(entry);
  mode='skill';const before=host.requests.length,input={...body(),skill_disabled:false,skill_version_id:entry.id},result=await host.request('/generate',{id:randomUUID(),scope,body:input});
  assert.equal(host.requests.length,before+2);assert.equal(result.used_skill.version_id,entry.id);assert.equal(result.used_skill.load_state,'loaded');assert.equal(result.used_skill.selection_method,'user');assert.equal(result.used_skill.version_number,1);assert.match(result.used_skill.execution_view.sha256,/^[a-f0-9]{64}$/);
  const saved=(await f.client.query('SELECT skill_version_id FROM reply_request WHERE id=$1',[result.reply_request_id])).rows[0];assert.equal(saved.skill_version_id,entry.id);
 });
});
