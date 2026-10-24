import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setup} from './reply-assistant-erasure-support.mjs';
import {requireDependencies,requireReplySourcesCurrent,requireGenerationMemoryDependencies,historicalBasisRevision,readReplyBasisChanges,registeredNavigationDependencies} from '../src/reply-source-guards.ts';
const scope=x=>({owner_id:x.owner,contact_id:x.contact});
async function source(x,contact=x.contact){const id=randomUUID();await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[id,x.owner,contact,id.replaceAll('-','').repeat(2)]);return id;}
test('来源必须当时捕获，原来源删除后即使新引用存在也不能续用',async t=>{
 const x=await setup(t),g=await x.generation(),s=await source(x),e=randomUUID();
 await x.f.client.query("INSERT INTO reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids)VALUES($1,$2,$3,$4,$5,0,'message','合成消息',$6)",[g.request,e,x.owner,x.contact,x.binding,JSON.stringify([s])]);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,false),{code:'reply_context_invalidated'});
 await x.f.client.query('INSERT INTO reply_original_source_use(reply_request_id,source_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[g.request,s,x.owner,x.contact]);
 assert.deepEqual(await requireReplySourcesCurrent(x.f.client,scope(x),g.request,false),[s]);
 await x.f.client.query("UPDATE source_document SET status='deleted',file_name=NULL,content_sha256=NULL,record_count=0,deleted_at=now(),deletion_operation_id=NULL,deletion_error_code=NULL WHERE id=$1",[s]);await source(x);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,false),{code:'reply_context_invalidated'});
});
test('本人手录依据复验正文且只有历史审计允许退休版本',async t=>{
 const x=await setup(t),g=await x.generation(),memory=randomUUID();
 await x.f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,source_ids,adoption_method)VALUES($1,$2,'合成本人偏好','preference',$3,'manual')",[memory,x.owner,[x.owner]]);
 await x.f.client.query("INSERT INTO reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids)VALUES($1,$2,$3,$4,$5,0,'owner_memory','合成本人偏好',$6)",[g.request,memory,x.owner,x.contact,x.binding,JSON.stringify([x.owner])]);
 assert.deepEqual(await requireReplySourcesCurrent(x.f.client,scope(x),g.request,false),[]);
 await x.f.client.query("UPDATE owner_memory SET status='invalidated' WHERE id=$1",[memory]);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,false),{code:'reply_context_invalidated'});
 assert.deepEqual(await requireReplySourcesCurrent(x.f.client,scope(x),g.request,true),[]);
 await x.f.client.query("UPDATE owner_memory SET text_content='修改后正文' WHERE id=$1",[memory]);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,true),{code:'reply_context_invalidated'});
});
test('讨论回调缺失失败关闭，循环递归拒绝且不把上一事务缓存当资格',async t=>{
 const x=await setup(t),g=await x.generation();await x.f.client.query("UPDATE reply_request SET context_snapshot='{"+'"assistant_discussion_snapshot":{}'+"}' WHERE id=$1",[g.request]);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,true),{code:'reply_guards_unavailable'});
 const cycle=(client,s,r)=>requireReplySourcesCurrent(client,s,r,true,cycle);
 await assert.rejects(requireReplySourcesCurrent(x.f.client,scope(x),g.request,true,cycle),{code:'reply_context_invalidated'});
 assert.deepEqual(await requireReplySourcesCurrent(x.f.client,scope(x),g.request,true,async()=>{}),[]);
});
test('导航只认当前范围已保存身份，退休记忆可审计却不可生成',async t=>{
 const x=await setup(t),g=await x.generation(),memory=randomUUID();
 await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,status)VALUES($1,$2,$3,'合成偏好','preference',$4,'manual','invalidated')",[memory,x.owner,x.contact,[x.contact]]);
 await requireDependencies(x.f.client,scope(x),[memory],true);
 await assert.rejects(requireDependencies(x.f.client,scope(x),[memory],false),{code:'reply_context_invalidated'});
 await assert.rejects(requireGenerationMemoryDependencies(x.f.client,scope(x),[memory]),{code:'reply_context_invalidated'});
 assert.deepEqual(await registeredNavigationDependencies(x.f.client,scope(x)),[]);
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({navigation_dependency_ids:[memory]})]);
 assert.deepEqual(await registeredNavigationDependencies(x.f.client,scope(x)),[memory]);
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({navigation_dependency_ids:['bad']})]);
 await assert.rejects(registeredNavigationDependencies(x.f.client,scope(x)),{code:'reply_context_invalidated'});
});
test('历史记忆版本摘要保留微秒及中文，与旧Python权威实际计算一致',async t=>{
 const x=await setup(t),memory=randomUUID();await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,created_at)VALUES($1,$2,$3,'喜欢清淡食物','preference',$4,'manual','2026-10-01T01:02:03.123456Z')",[memory,x.owner,x.contact,[x.contact]]);
 const expected=execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',"import sys,psycopg\nfrom uuid import UUID\nfrom psycopg.rows import dict_row\nfrom notalone.persistence.reply_basis_changes import historical_basis_revision_sha256\nfrom notalone.scopes import ContactScope\nwith psycopg.connect('host=/tmp dbname='+sys.argv[1],row_factory=dict_row) as c:\n print(historical_basis_revision_sha256(c,ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),(UUID(sys.argv[4]),)))",x.f.client.database,x.owner,x.contact,memory],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}).trim();
 assert.equal(await historicalBasisRevision(x.f.client,scope(x),[memory]),expected);
});
test('旧结果依据变化按实际修订、生效与退休状态投影',async t=>{
 const x=await setup(t),g=await x.generation(),memory=randomUUID();
 await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)VALUES($1,$2,$3,'合成偏好','preference',$4,'manual')",[memory,x.owner,x.contact,[x.contact]]);
 await x.f.client.query("INSERT INTO reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids,evidence_status,evidence_revision)VALUES($1,$2,$3,$4,$5,0,'confirmed_memory','合成偏好',$6,'active',1)",[g.request,memory,x.owner,x.contact,x.binding,JSON.stringify([x.contact])]);
 const changes=()=>readReplyBasisChanges(x.f.client,scope(x),g.request);
 assert.deepEqual(await changes(),[]);
 await x.f.client.query('UPDATE confirmed_memory SET revision=2 WHERE id=$1',[memory]);
 assert.deepEqual(await changes(),[{evidence_id:memory,kind:'confirmed_memory',reason:'memory_revised'}]);
 await x.f.client.query("UPDATE confirmed_memory SET revision=1,valid_at=now()+interval '1 day' WHERE id=$1",[memory]);
 assert.deepEqual(await changes(),[{evidence_id:memory,kind:'confirmed_memory',reason:'memory_not_yet_valid'}]);
 await x.f.client.query("UPDATE confirmed_memory SET valid_at=NULL,status='invalidated' WHERE id=$1",[memory]);
 assert.deepEqual(await changes(),[{evidence_id:memory,kind:'confirmed_memory',reason:'memory_generation_forbidden'}]);
});
