import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ReplyPreparation} from '../src/reply/generation/reply-preparation.ts';
import {createReplyGenerationGuards} from '../src/reply/generation/reply-generation-guards.ts';
import {PostgresReplyStore} from '../src/reply/generation/reply-store.ts';
import {PostgresSkillPort} from '../src/skills/skill-port.ts';
import {SkillFiles} from '../src/skills/skill-files.ts';
import {createReplySkillGuards} from '../src/reply/generation/reply-skill-guards.ts';
import {normalizeReplyInput} from '../src/reply/generation/reply-contract.ts';
import {requireReplyScope} from '../src/reply/generation/reply-scope.ts';
import {createEvidenceAliases} from '../src/reply/generation/reply-evidence-alias.ts';
import {replySystemPrompt} from '../src/reply/generation/reply-system-prompt.ts';
async function setup(t,history=false,withDiscussion=false){
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const transaction=async fn=>{await f.client.query('BEGIN');try{const value=await fn(f.client);await f.client.query('COMMIT');return value;}catch(e){await f.client.query('ROLLBACK');throw e;}};
 const command={contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:history},continued_from_candidate_id:null,skill_version_id:null,suggestion:null,allow_incomplete_history:false,skill_disabled:true,scene:null},scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const skillPort=new PostgresSkillPort({read:transaction},`${f.directory}/skills`),savedSkill=createReplySkillGuards({files:new SkillFiles(`${f.directory}/skills`)}),controller=createReplyGenerationGuards({scope,input:command,skillPort,savedSkill});
 if(withDiscussion){const session=randomUUID(),turn=randomUUID(),version=randomUUID(),discussionId=randomUUID();await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,owner,contact]);
  await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,version,command.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(command)).digest('hex'),JSON.stringify({content:command.content})]);
  await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id) VALUES($1,$2,$3,$4,$5,'generation',$6)",[version,session,owner,contact,binding,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,version]);
  await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content) VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)",[discussionId,session,owner,contact,binding,{type:'purpose_exploration',text:'合成完整讨论'.repeat(200)}]);
 }
 const store=new PostgresReplyStore({transaction,guards:controller.guards}),started=await store.start({...scope,idempotency_key:command.idempotency_key,normalized_input:normalizeReplyInput(command),continued_from_candidate_id:null}),request=started.request;
 const service=new ReplyPreparation({transaction,controller,requireCurrent:async client=>{assert.equal(client,f.client);await requireReplyScope(client,scope,command);await store.requireCurrentInTransaction(client,request);}});
 return {f,owner,contact,binding,transaction,command,request,service,store};
}
test('真实prepare读取偏好及完整快照后可经原writer保存',async t=>{
 const x=await setup(t),preference=randomUUID();
 await x.f.client.query("INSERT INTO expression_preference(id,owner_id,text_content,confirmed_operation_key,origin_kind) VALUES($1,$2,'表达简短',$3,'manual')",[preference,x.owner,randomUUID()]);
 const prepared=await x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'0'}));
 assert.equal(prepared.preferences.preferences[0].preference_id,preference);assert.equal(prepared.context.layered_status,'not_allowed');assert.equal(prepared.discussion,null);assert.deepEqual(prepared.storeContext.snapshot.evidence,prepared.context.evidence);assert.ok(Object.hasOwn(prepared.storeContext.snapshot,'owner_layered_scenario_reads'));assert.deepEqual(x.service.scenarioTools(prepared),[]);
 await x.transaction(client=>x.service.validateCurrent(client,prepared));
 await x.store.prepareContext(x.request,prepared.storeContext);const id=randomUUID();
 const saved=await x.store.save(x.request,x.service.finalize(prepared),[{candidate_id:id,text:'那就明天见',basis:'用户本次原句',citation_ids:[prepared.context.evidence[0].evidence_id],risk_notes:[],messages:[{message_id:id,text:'那就明天见'}]}]);assert.equal(saved.candidates.length,1);
});
test('prepare默认双概览且目录修订不一致不能降级继续',async t=>{
 const x=await setup(t,true);
 await assert.rejects(x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'1'})),/Skill目录修订/);
 const p=await x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'0'}));
 assert.ok(p.context.retrieval.contact_overview);assert.ok(p.context.retrieval.owner_overview);assert.equal(p.storeContext.snapshot.retrieval.version,1);assert.deepEqual(p.storeContext.snapshot.navigation_dependency_ids,[]);
 await x.f.client.query('DELETE FROM manual_contact_confirmation WHERE id=$1',[x.binding]);await assert.rejects(x.transaction(client=>x.service.validateCurrent(client,p)));
});
test('实际scenario Tool绑定冻结目录、同事务资格并将回执写入最终快照',async t=>{
 const x=await setup(t,true),memory=randomUUID(),batch=randomUUID(),version=randomUUID(),scenario=randomUUID();
 const {readReplyOwnerOverview}=await import('../src/reply/context/reply-context-overview.ts'),{digest}=await import('../src/memory/overview/evidence/sources.ts');
 await x.f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'清淡饮食','preference','other',$3,'manual')",[memory,x.owner,[x.owner]]);
 const entry=(await readReplyOwnerOverview(x.f.client,x.owner,true)).entries[0],manifest=[{...entry.dependency_manifest,organization_timing_sha256:digest(entry.memory.timing)}];
 await x.f.client.query("UPDATE layered_memory_state SET enabled=true,status='ready',settings_generation=1,organization_generation=1 WHERE owner_id=$1 AND contact_id IS NULL",[x.owner]);
 await x.f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at) VALUES($1,$2,NULL,1,'synthetic','succeeded',$3,'{}',$4,now())",[batch,x.owner,JSON.stringify(manifest),[x.owner,memory]]);
 await x.f.client.query("INSERT INTO scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at) VALUES($1,$2,NULL,$3,$4,1,1,'饮食','合成提示',$5,now())",[version,x.owner,scenario,batch,JSON.stringify([{text:'偏好清淡',references:[{memory_id:memory,revision:1}]}])]);
 await x.f.client.query("INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids) VALUES($1,NULL,1,2,$2,$3)",[x.owner,[version],[x.owner,memory]]);
 const p=await x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'0'}));
 await x.store.prepareContext(x.request,p.storeContext);
 const aliases=createEvidenceAliases(),system=replySystemPrompt(p.context,null,aliases),scenarioAlias=aliases.referenceFor(scenario);
 assert.ok(![x.owner,x.contact,scenario,version,memory].some(id=>system.includes(id)));
 const tools=x.service.scenarioTools(p,aliases);assert.equal(tools.length,1);assert.equal(tools[0].name,'read_scenario');
 const execute=value=>tools[0].execute({scenario_id:value,paragraph_index:0},{signal:new AbortController().signal});
 const first=JSON.parse(await execute(scenarioAlias));assert.equal(first.status,'succeeded');assert.equal(first.document.paragraphs[0].text,'偏好清淡');
 assert.ok(![scenario,version,memory].some(id=>JSON.stringify(first).includes(id)));
 assert.equal(p.storeContext.snapshot.owner_layered_scenario_reads.length,1);assert.equal(p.storeContext.snapshot.tool_calls.at(-1).tool_name,'read_scenario');assert.ok(p.storeContext.snapshot.navigation_dependency_ids.includes(version));
 await x.transaction(client=>x.service.validateCurrent(client,p));
 await x.f.client.query("UPDATE layered_memory_state SET enabled=false WHERE owner_id=$1 AND contact_id IS NULL",[x.owner]);await assert.rejects(execute(scenarioAlias),/整理资料已变化/);
});
test('实际history完成后追加证据与累计预算，重复结算拒绝',async t=>{
 const {ReplyHistory}=await import('../src/reply/generation/reply-history.ts');const x=await setup(t,true),source=randomUUID(),message=randomUUID();
 await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,x.owner,x.contact,source.replaceAll('-','').repeat(2)]);
 await x.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成历史','2026-01-01T01:02:03.123456Z')",[message,x.owner,x.contact]);
 await x.f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,x.owner,x.contact,source]);
 const p=await x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'0'}));
 const history=new ReplyHistory({transaction:x.transaction,scope:p.context.scope,binding_id:x.binding,initial_evidence_ids:p.context.evidence.map(item=>item.evidence_id),prior_budget:p.context.retrieval.source_messages,requireCurrent:client=>x.service.validateCurrent(client,p)});
 assert.equal(JSON.parse(await history.search({query:'合成历史'})).status,'ok');
 const finalized=x.service.finalizeHistory(p,history);assert.ok(finalized.evidence.some(item=>item.evidence_id===message));assert.equal(finalized.snapshot.retrieval.budgets.source_messages.used_calls,1);assert.equal(finalized.snapshot.retrieval.budgets.source_messages.used_count,1);
 await x.transaction(client=>x.service.validateCurrent(client,p));assert.throws(()=>x.service.finalizeHistory(p,history),/已结算/);
});
test('prepare读取真实助手完整讨论且快照参与原提交资格',async t=>{
 const x=await setup(t,false,true),p=await x.transaction(client=>x.service.prepare(client,{request:x.request,command:x.command,skillRevision:'0'}));
 assert.equal(p.discussion.items.length,1);assert.equal(JSON.parse(p.discussion.items[0].text).text,'合成完整讨论'.repeat(200));assert.deepEqual(p.storeContext.snapshot.assistant_discussion_snapshot,p.discussion.snapshot);
 await x.store.prepareContext(x.request,p.storeContext);const id=randomUUID();await x.store.save(x.request,x.service.finalize(p),[{candidate_id:id,text:'明天见',basis:'本次原句',citation_ids:[p.context.evidence[0].evidence_id],risk_notes:[],messages:[{message_id:id,text:'明天见'}]}]);
});
