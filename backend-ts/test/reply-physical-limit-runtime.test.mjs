import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {normalizeReplyInput,parseReplyRequest} from '../src/reply/generation/reply-contract.ts';
import {decodePreparedContext} from '../src/reply/generation/reply-prepared-codec.ts';
import {readReplyOwnerOverview} from '../src/reply/context/reply-context-overview.ts';
import {digest} from '../src/memory/overview/contact-overview-evidence.ts';

async function fixture(t){
 const f=await createStorageFixture();
 assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成用户')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const body=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'合成表达',include_relationship_context:true},skill_disabled:true});
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{
  assert.ok(requests.at(-1).body.tools.some(tool=>tool.name==='conversation_search'));
  useTool(events,'conversation_search',{query:`合成查询${requests.length}`},`physical-limit-${requests.length}`);sendEvents(res,events);
 });
 await host.request('/configure-model',{physical_limit:24});
 return {f,owner,contact,binding,scope,body,host};
}
test('官方service服务端上限24：无场景在第9次HTTP前阻断且累计预约不退款',{timeout:60000},async t=>{
 const {f,owner,scope,body,host}=await fixture(t);
 await assert.rejects(host.request('/generate',{id:randomUUID(),scope,body}),/reply_budget_exceeded/);
 assert.equal(host.requests.length,8,'旧生产基础16步只允许8个模型轮；第9次不得发HTTP');
 assert.ok(host.requests.every(request=>!request.body.tools.some(tool=>tool.name==='read_scenario')));
 const receipts=await f.client.query('SELECT outcome,dispatch FROM model_call_receipt WHERE owner_id=$1',[owner]);
 assert.equal(receipts.rows.length,8);assert.ok(receipts.rows.every(row=>row.outcome==='succeeded'&&row.dispatch==='http_accepted'));
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,0);
 await assert.rejects(host.request('/generate',{id:randomUUID(),scope,body}));
 assert.equal(host.requests.length,8,'同请求失败后不退款，不能重新获得8轮额度');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM model_call_receipt WHERE owner_id=$1',[owner])).rows[0].n,8);
});
test('官方service真实一层准备：冻结2次正文预算允许10轮，预检零HTTP且第11次被阻',{timeout:60000},async t=>{
 const {f,owner,contact,binding,scope,body,host}=await fixture(t),memory=randomUUID(),batch=randomUUID(),version=randomUUID(),scenario=randomUUID();
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,'清淡饮食','preference','other',$3,'manual')",[memory,owner,[owner]]);
 const entry=(await readReplyOwnerOverview(f.client,owner,true)).entries[0],manifest=[{...entry.dependency_manifest,organization_timing_sha256:digest(entry.memory.timing)}];
 await f.client.query("UPDATE layered_memory_state SET enabled=true,status='ready',settings_generation=1,organization_generation=1 WHERE owner_id=$1 AND contact_id IS NULL",[owner]);
 await f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at)VALUES($1,$2,NULL,1,'synthetic','succeeded',$3,'{}',$4,now())",[batch,owner,JSON.stringify(manifest),[owner,memory]]);
 await f.client.query("INSERT INTO scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at)VALUES($1,$2,NULL,$3,$4,1,1,'饮食','合成提示',$5,now())",[version,owner,scenario,batch,JSON.stringify([{text:'偏好清淡',references:[{memory_id:memory,revision:1}]}])]);
 await f.client.query('INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids)VALUES($1,NULL,1,2,$2,$3)',[owner,[version],[owner,memory]]);
 const session=randomUUID(),turn=randomUUID(),inputVersion=randomUUID();
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,inputVersion,body.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(body)).digest('hex'),JSON.stringify({content:body.content})]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[inputVersion,session,owner,contact,binding,turn]);
 await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,inputVersion]);
 await host.request('/prepare',{id:randomUUID(),scope,body});assert.equal(host.requests.length,0);
 const frozen=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context;
 const prepared=decodePreparedContext(frozen,body,{owner_id:owner,contact_id:contact},binding);
 assert.equal(prepared.layered_context,null);assert.equal(JSON.parse(prepared.owner_layered_context.payload_json).scenario_read_budget.call_limit,2);
 await assert.rejects(host.request('/generate',{id:randomUUID(),scope,body}),/reply_budget_exceeded/);
 assert.equal(host.requests.length,10);assert.ok(host.requests.every(request=>request.body.tools.some(tool=>tool.name==='read_scenario')));
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM model_call_receipt WHERE owner_id=$1',[owner])).rows[0].n,10);
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,0);
 assert.deepEqual((await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,frozen);
});
