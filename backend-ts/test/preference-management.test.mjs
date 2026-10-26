import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {PreferenceService} from '../src/preferences/preference-service.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
export async function fixture(t){
 const f=await createStorageFixture(); const owner=randomUUID(),contact=randomUUID(),other=randomUUID();
 await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
 await f.client.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$4),($1,$3,$4)',[owner,contact,other,'合成联系人']);
 const storage=await HostStorage.open({...f.options,environment:{NOTALONE_OWNER_ID:owner}});
 const service=new PreferenceService(storage);
 t.after(async()=>{await storage.close();await f.close();});
 const call=(method,path='',body)=>service.handle(method,new URL('http://localhost/api/expression-preferences'+path),body);
 return {...f,owner,contact,other,storage,service,call};
}
const save=(text='长期简洁')=>({operation_key:randomUUID(),text,scope:{contact_id:null,reply_mode:null},origin:{kind:'manual'},confirm_long_term:true});
test('明确保存与同键重放保持同一偏好身份和修订',async t=>{
 const f=await fixture(t),body=save();
 const first=await f.call('POST','',body);
 assert.equal(first.preference.text,'长期简洁');assert.equal(first.preference.revision,1);
 assert.deepEqual(await f.call('POST','',body),first);
 assert.deepEqual(await f.call('GET'),{preferences:[first.preference]});
 await assert.rejects(f.call('POST','',{...body,text:'不同正文'}),e=>e.status===409);
});
test('目录范围与修改CAS保留，禁止一次性要求和布尔修订',async t=>{
 const f=await fixture(t),body=save('🙂'.repeat(512));body.scope.contact_id=f.contact;
 const item=(await f.call('POST',`?contact_id=${f.contact}`,body)).preference;
 assert.deepEqual(await f.call('GET'),{preferences:[]});assert.deepEqual(await f.call('GET',`?contact_id=${f.other}`),{preferences:[]});
 await assert.rejects(f.call('GET',`/${item.preference_id}`),e=>e.status===404);
 for(const change of [{confirm_long_term:false},{text:'🙂'.repeat(513)},{owner_id:f.owner}])await assert.rejects(f.call('POST','',{...save(),...change}),e=>e.status===400);
 const edit={operation_key:randomUUID(),expected_revision:1,text:'修改后',scope:{contact_id:null,reply_mode:null},confirm_long_term:true};
 await assert.rejects(f.call('PATCH',`/${item.preference_id}?contact_id=${f.contact}`,{...edit,expected_revision:true}),e=>e.status===400);
 const updated=await f.call('PATCH',`/${item.preference_id}?contact_id=${f.contact}`,edit);assert.equal(updated.preference.revision,2);
 assert.deepEqual(await f.call('PATCH',`/${item.preference_id}?contact_id=${f.contact}`,edit),updated);
 await assert.rejects(f.call('PATCH',`/${item.preference_id}?contact_id=${f.contact}`,{...edit,operation_key:randomUUID()}),e=>e.status===409);
});
test('删除擦除旧操作正文摘要，同删除键可重试且创建旧键不可复活',async t=>{
 const f=await fixture(t),body=save(),item=(await f.call('POST','',body)).preference;
 const removal={operation_key:randomUUID(),expected_revision:1};
 assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,removal),{state:'deleted'});
 assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,removal),{state:'deleted'});
 assert.deepEqual(await f.call('GET'),{preferences:[]});
 await assert.rejects(f.call('POST','',body),e=>e.status===410);
 await assert.rejects(f.call('DELETE',`/${item.preference_id}`,{...removal,operation_key:randomUUID()}),e=>e.status===410);
 const row=(await f.client.query('SELECT text_content,source_ids FROM expression_preference WHERE id=$1',[item.preference_id])).rows[0];assert.deepEqual(row,{text_content:null,source_ids:[]});
 const old=(await f.client.query('SELECT input_digest FROM expression_preference_operation WHERE operation_key=$1',[body.operation_key])).rows[0];assert.equal(old.input_digest,null);
});
test('Python已保存ASCII摘要可重放，微秒时间不被JS截断',async t=>{
 const f=await fixture(t),body=save('简短🙂'),id=randomUUID();
 await f.client.query("INSERT INTO expression_preference(id,owner_id,text_content,confirmed_operation_key,origin_kind,confirmed_at,updated_at) VALUES($1,$2,$3,$4,'manual','2026-10-23T01:02:03.123456Z','2026-10-23T01:02:03.123456Z')",[id,f.owner,body.text,body.operation_key]);
 await f.client.query("INSERT INTO expression_preference_operation(owner_id,operation_key,preference_id,kind,input_digest,result_revision) VALUES($1,$2,$3,'save',$4,1)",[f.owner,body.operation_key,id,'b1a714647f84d83f100550dcc82791e4752f5950f604b6f7e2ed453caa047236']);
 const result=await f.call('POST','',body);assert.equal(result.preference.preference_id,id);assert.equal(result.preference.confirmed_at,'2026-10-23T01:02:03.123456+00:00');
});
test('消息偏好保存来源集，禁止跨联系人搬移且来源失效立即不可读',async t=>{
 const f=await fixture(t),source=randomUUID(),message=randomUUID();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','合成.jsonl',$4,1)",[source,f.owner,f.contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,'user','text','合成原句')",[message,f.owner,f.contact]);
 await f.client.query("INSERT INTO message_source_ref(owner_id,contact_id,message_id,source_document_id,source_kind,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document','line:1','{}')",[f.owner,f.contact,message,source]);
 const body={...save(),scope:{contact_id:f.contact,reply_mode:null},origin:{kind:'message',id:message}};
 const item=(await f.call('POST',`?contact_id=${f.contact}`,body)).preference;assert.deepEqual(item.source_ids,[source,message].sort());
 await assert.rejects(f.call('PATCH',`/${item.preference_id}?contact_id=${f.contact}`,{operation_key:randomUUID(),expected_revision:1,text:'修改',scope:{contact_id:null,reply_mode:null},confirm_long_term:true}),e=>e.status===409);
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[source]);
 assert.deepEqual(await f.call('GET',`?contact_id=${f.contact}`),{preferences:[]});
 await assert.rejects(f.call('GET',`/${item.preference_id}?contact_id=${f.contact}`),e=>e.status===410);
 await assert.rejects(f.call('POST',`?contact_id=${f.contact}`,{...body,operation_key:randomUUID()}),e=>e.status===409);
});
test('prepare快照遵循范围优先与码点预算，修改使旧快照失效',async t=>{
 const {selectApplicablePreferences,validatePreferenceSnapshot,lockPreferenceOwner}=await import('../src/preferences/preference-service.ts');
 const f=await fixture(t);for(let i=0;i<5;i++)await f.call('POST','',save('🙂'.repeat(512)));
 const specific=save('联系人优先');specific.scope={contact_id:f.contact,reply_mode:'rewrite_draft'};await f.call('POST',`?contact_id=${f.contact}`,specific);
 const snapshot=await f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);return selectApplicablePreferences(c,f.owner,f.contact,'rewrite_draft');});
 assert.equal(snapshot.preferences[0].text,'联系人优先');assert.equal(snapshot.preferences.length,3);assert.equal(snapshot.revision,6);
 await f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);await validatePreferenceSnapshot(c,f.owner,f.contact,'rewrite_draft',snapshot);});
 await f.call('POST','',save('新明确偏好'));
 await assert.rejects(f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);await validatePreferenceSnapshot(c,f.owner,f.contact,'rewrite_draft',snapshot);}),e=>e.status===409);
});
test('删除偏好递归撤销已发布Skill并重试失败文件擦除',async t=>{
 const {mkdir,writeFile,rm,symlink,readFile,access}=await import('node:fs/promises');const {join}=await import('node:path');
 const {SkillLibrary}=await import('../src/skills/skill-library.ts');const {SkillFiles}=await import('../src/skills/skill-files.ts');
 const f=await fixture(t),item=(await f.call('POST','',save())).preference;
 const path=join(f.directory,'synthetic-skill');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: synthetic-skill\ndescription: "合成"\n---\n\n仅合成策略');
 const files=new SkillFiles(join(f.directory,'skills')),library=new SkillLibrary(f.storage,files);
 const imported=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 const version=(await f.client.query('SELECT id FROM reply_skill_version WHERE skill_id=$1',[imported.skill_id])).rows[0].id,draft=randomUUID();
 await f.client.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,status,dependency_ids,batch_key) VALUES($1,$2,$3,$4,'create','published',$5,'synthetic')",[draft,f.owner,f.contact,imported.skill_id,[item.preference_id]]);
 await f.client.query('UPDATE reply_skill_version SET review_origin=true WHERE id=$1',[version]);
 await f.client.query("INSERT INTO reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids) VALUES($1,$2,$3,$4,$5,'owner',$6)",[version,f.owner,f.contact,draft,imported.skill_id,[item.preference_id]]);
 const working=join(f.directory,'skills',f.owner,'synthetic-skill'),external=join(f.directory,'external');await mkdir(external);await writeFile(join(external,'keep'),'合成外部');await rm(working,{recursive:true});await symlink(external,working);
 const body={operation_key:randomUUID(),expected_revision:1};await assert.rejects(f.call('DELETE',`/${item.preference_id}`,body),e=>e.status===503);
 await assert.rejects(f.call('GET',`/${item.preference_id}`),e=>e.status===410);
 assert.equal((await f.client.query('SELECT status FROM reply_skill_version WHERE id=$1',[version])).rows[0].status,'deleted');
 assert.equal(await readFile(join(external,'keep'),'utf8'),'合成外部');
 await rm(working);assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,body),{state:'deleted'});
 await assert.rejects(access(join(f.directory,'skills','.versions',f.owner,imported.skill_id,version)));
});
test('实际使用回执复验与偏好删除同事务撤回复键',async t=>{
 const {selectApplicablePreferences,captureReplyPreferences,requireCapturedReplyPreferences,lockPreferenceOwner}=await import('../src/preferences/preference-service.ts');
 const f=await fixture(t),item=(await f.call('POST','',save())).preference,request=randomUUID(),key=randomUUID();
 await f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at) VALUES($1,$2,$3,$4,$5,'合成输入','running',1,now()+interval '1 minute')",[request,f.owner,f.contact,randomUUID(),key]);
 const snapshot=await f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);const s=await selectApplicablePreferences(c,f.owner,f.contact,'rewrite_draft');await captureReplyPreferences(c,f.owner,f.contact,request,'rewrite_draft',s);await requireCapturedReplyPreferences(c,f.owner,f.contact,request,'rewrite_draft',s);return s;});
 await f.call('DELETE',`/${item.preference_id}`,{operation_key:randomUUID(),expected_revision:1});
 assert.equal((await f.client.query('SELECT 1 FROM reply_request WHERE id=$1',[request])).rowCount,0);
 assert.equal((await f.client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND idempotency_key=$2',[f.owner,key])).rowCount,1);
 await assert.rejects(f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);await requireCapturedReplyPreferences(c,f.owner,f.contact,request,'rewrite_draft',snapshot);}),e=>e.status===409);
});
test('owner隔离与并发修改只有一个CAS获胜，存储故障完整回滚后可重试',async t=>{
 const f=await fixture(t),body=save(),item=(await f.call('POST','',body)).preference;
 const other=randomUUID();await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[other,'另一合成用户']);
 const otherStorage=await HostStorage.open({...f.options,environment:{NOTALONE_OWNER_ID:other}});t.after(()=>otherStorage.close());const otherService=new PreferenceService(otherStorage);
 await assert.rejects(otherService.handle('GET',new URL(`http://local/api/expression-preferences/${item.preference_id}`)),e=>e.status===404);
 const edit=text=>({operation_key:randomUUID(),expected_revision:1,text,scope:{contact_id:null,reply_mode:null},confirm_long_term:true});
 const outcomes=await Promise.allSettled([f.call('PATCH',`/${item.preference_id}`,edit('甲')),f.call('PATCH',`/${item.preference_id}`,edit('乙'))]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.status,409);
 const removal={operation_key:randomUUID(),expected_revision:2};
 await f.client.query("CREATE FUNCTION synthetic_preference_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER synthetic_preference_fault BEFORE UPDATE ON expression_preference FOR EACH ROW EXECUTE FUNCTION synthetic_preference_fault()");
 await assert.rejects(f.call('DELETE',`/${item.preference_id}`,removal),e=>e.status===503);assert.equal((await f.call('GET',`/${item.preference_id}`)).preference.revision,2);
 await f.client.query('DROP TRIGGER synthetic_preference_fault ON expression_preference');assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,removal),{state:'deleted'});
});
test('Python空白规范与大修订无损保留，不丢失原UUID或静默舍入',async t=>{
 const f=await fixture(t),item=(await f.call('POST','',save('\u0085简短\u001c'))).preference;assert.equal(item.text,'简短');
 const bom=(await f.call('POST','',save('\ufeff保留'))).preference;assert.equal(bom.text,'\ufeff保留');
 await f.client.query('UPDATE expression_preference SET revision=9007199254740993 WHERE id=$1',[item.preference_id]);
 assert.equal((await f.call('GET',`/${item.preference_id}`)).preference.revision,9007199254740993n);
 await assert.rejects(f.call('DELETE',`/${item.preference_id}`,{operation_key:randomUUID(),expected_revision:9007199254740993}),e=>e.status===400);
 const edit={operation_key:randomUUID(),expected_revision:9007199254740993n,text:'大修订修改',scope:{contact_id:null,reply_mode:null},confirm_long_term:true};
 const updated=await f.call('PATCH',`/${item.preference_id}`,edit);assert.equal(updated.preference.revision,9007199254740994n);assert.deepEqual(await f.call('PATCH',`/${item.preference_id}`,edit),updated);
 await f.client.query('UPDATE expression_preference_state SET revision=9007199254740993 WHERE owner_id=$1',[f.owner]);
 const {selectApplicablePreferences,validatePreferenceSnapshot,lockPreferenceOwner}=await import('../src/preferences/preference-service.ts');
 await f.storage.businessTransaction(async c=>{await lockPreferenceOwner(c,f.owner);const snapshot=await selectApplicablePreferences(c,f.owner,f.contact,'rewrite_draft');assert.equal(snapshot.revision,9007199254740993n);await validatePreferenceSnapshot(c,f.owner,f.contact,'rewrite_draft',snapshot);});
 const removed={operation_key:randomUUID(),expected_revision:9007199254740994n};assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,removed),{state:'deleted'});assert.deepEqual(await f.call('DELETE',`/${item.preference_id}`,removed),{state:'deleted'});
 assert.equal((await f.client.query('SELECT revision FROM expression_preference WHERE id=$1',[item.preference_id])).rows[0].revision,'9007199254740995');
});
test('偏好删除沿真实助手continuation擦除准备与派生输入，损坏携入令整笔回滚',async t=>{
 const f=await fixture(t),item=(await f.call('POST','',save())).preference,session=randomUUID(),binding=randomUUID();
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,f.owner,f.contact]);
 async function generation(dependencies,parent=null){
  const turn=randomUUID(),input=randomUUID(),key=randomUUID(),request=randomUUID();
  const payload={content:{type:'reply_to_message',text:'合成输入'},...(parent?{continuation:{version:1,scope:'this_assistant_session_only',submission:{expected_input_version_id:parent.input,idempotency_key:key,displayed_group:{session_id:session}}}}:{})};
  await f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at)VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')",[request,f.owner,f.contact,binding,key]);
  await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload,dependency_ids,reply_request_id,prepared_context)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[turn,session,f.owner,f.contact,input,key,binding,'a'.repeat(64),JSON.stringify(payload),dependencies,request,JSON.stringify({synthetic:'准备副本'})]);
  await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[input,session,f.owner,f.contact,binding,turn]);
  await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);return {input,turn,request};
 }
 const root=await generation([item.preference_id]),child=await generation([],root),bad=randomUUID();
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'candidate_carry',$6)",[bad,session,f.owner,f.contact,binding,JSON.stringify({type:'candidate_carry'})]);
 const removal={operation_key:randomUUID(),expected_revision:1};await assert.rejects(f.call('DELETE',`/${item.preference_id}`,removal),e=>e.status===503);assert.equal((await f.call('GET',`/${item.preference_id}`)).preference.revision,1);
 await f.client.query('DELETE FROM assistant_session_input WHERE id=$1',[bad]);await f.call('DELETE',`/${item.preference_id}`,removal);
 const rows=(await f.client.query('SELECT state,input_payload,prepared_context FROM assistant_session_turn WHERE id=ANY($1::uuid[])',[[root.turn,child.turn]])).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='redacted'&&r.input_payload===null&&r.prepared_context===null));
 assert.equal((await f.client.query('SELECT 1 FROM reply_request WHERE id=ANY($1::uuid[])',[[root.request,child.request]])).rowCount,0);
 assert.equal((await f.client.query('SELECT current_input_version_id FROM assistant_session WHERE id=$1',[session])).rows[0].current_input_version_id,null);
});
