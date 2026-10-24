import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {mutateMemory} from '../src/memory-mutations.ts';

test('合成PG记忆写入：同文修正重放、迟到删除冲突及删除版本正文闭包',async()=>{
 const fixture=await createStorageFixture(); const c=fixture.client;
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),id=randomUUID();
 try {
 await c.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成手录',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'旧资料','common_fact',$4,'manual')",[id,owner,contact,[source]]);
 const scope={level:'contact',contactId:contact};
 async function run(action,memory,body={}) {await c.query('BEGIN');try{const result=await mutateMemory(c,owner,scope,action,memory,body,{beforeErase:async()=>{}});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}}
 const first=await run('correct',id,{text:'修正资料',conditions:{version:1,items:[{text:'仅工作日',evidence:[]}]}});
 assert.deepEqual(first.conditions,{version:1,items:[{text:'仅工作日',evidence:[],source_supported:false}]});
 assert.equal(first.adoption_method,'manual');assert.equal(first.revision,2);assert.notEqual(first.id,id);
 assert.equal((await run('correct',id,{text:'修正资料'})).id,first.id);
 await assert.rejects(run('correct',id,{text:'另一个修正'}),{status:409});
 await assert.rejects(run('delete',id),{status:409});
 assert.equal((await run('delete',first.id)).status,'deleted');
 assert.equal((await run('delete',first.id)).status,'deleted');
 const rows=(await c.query('SELECT text_content,status FROM public.confirmed_memory WHERE owner_id=$1',[owner])).rows;
 assert.deepEqual(rows.map(r=>r.text_content),['已删除的资料','已删除的资料']);
 }finally{await fixture.close();}
});

test('合成PG本人资料：保留手录根来源、原版重试冲突及范围隔离',async()=>{
 const f=await createStorageFixture(),c=f.client,owner=randomUUID(),other=randomUUID(),id=randomUUID();
 const scope={level:'owner'};
 const run=async(action,key,body={})=>{await c.query('BEGIN');try{const result=await mutateMemory(c,owner,scope,action,key,body,{beforeErase:async()=>{}});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}};
 try {
 await c.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成本人'),($2,'其他用户')",[owner,other]);
 await c.query("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,'本人旧资料','common_fact',$3,'manual')",[id,owner,[owner]]);
 const changed=await run('correct',id,{text:'本人修正资料',change_kind:'state_changed'});
 assert.deepEqual(changed.source_ids,[owner]);assert.equal(changed.revision,2);assert.equal(changed.supersedes_memory_id,id);
 await assert.rejects(run('correct',id,{text:'本人修正资料',change_kind:'state_changed'}),{status:409});
 await assert.rejects(mutateMemory(c,other,scope,'correct',changed.id,{text:'越界修改'}),{status:404});
 await assert.rejects(run('revert-auto-update',changed.id,{expected_revision:2}),{status:409});
 await assert.rejects(run('delete',id),{status:409});
 assert.equal((await run('delete',changed.id)).status,'deleted');
 assert.equal((await c.query("SELECT count(*)::int AS n FROM public.owner_memory WHERE owner_id=$1 AND text_content<>'已删除的资料'",[owner])).rows[0].n,0);
 }finally{await f.close();}
});

test('合成PG来源撤销先提交后，修正失败且不留人工新版本',async()=>{
 const f=await createStorageFixture(),c=f.client,owner=randomUUID(),contact=randomUUID(),source=randomUUID(),id=randomUUID();
 try {
 await c.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成手录',$4,1)",[source,owner,contact,'b'.repeat(64)]);
 await c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'原资料','common_fact',$4,'manual')",[id,owner,contact,[source]]);
 await c.query("UPDATE public.source_document SET status='delete_requested' WHERE id=$1",[source]);
 await c.query('BEGIN');
 await assert.rejects(mutateMemory(c,owner,{level:'contact',contactId:contact},'correct',id,{text:'迟到修正'}),{status:404});
 await c.query('ROLLBACK');
 assert.equal((await c.query('SELECT count(*)::int AS n FROM public.confirmed_memory WHERE supersedes_memory_id=$1',[id])).rows[0].n,0);
 }finally{await f.close();}
});

import {captureSnapshot} from '../src/contact-overview-evidence.ts';
import {overviewRecordDigest} from '../src/contact-overview-memory.ts';
test('合成PG自动撤销：复验原窗口与CAS、恢复原ID并擦新版，来源失效不复活',async()=>{
 const f=await createStorageFixture(),c=f.client,owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID();
 const scope={level:'contact',contactId:contact};
 const run=async(id,revision)=>{await c.query('BEGIN');try{const result=await mutateMemory(c,owner,scope,'revert-auto-update',id,{expected_revision:revision});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}};
 try {
 await c.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'c'.repeat(64)]);
 await c.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,'contact','text','合成来源证据')",[message,owner,contact]);
 await c.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{synthetic:true}]);
 const frozen=await captureSnapshot(c,owner,[message],[],contact);frozen.ordered_message_ids=[message];
 async function seed(){
 const old=randomUUID(),next=randomUUID();
 await c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'原自动资料','common_fact',$4,'auto')",[old,owner,contact,[message]]);
 const previous=(await c.query('SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE id=$1',[old])).rows[0].value;
 await c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,revision,supersedes_memory_id) VALUES($1,$2,$3,'新自动资料','common_fact',$4,'auto',2,$5)",[next,owner,contact,[message],old]);
 const current=(await c.query('SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE id=$1',[next])).rows[0].value;
 const proof={version:1,previous:{memory_id:old,revision:1,adoption_method:'auto',valid_at:null,invalid_at:null,record_sha256:overviewRecordDigest(previous)},current:{memory_id:next,revision:2,record_sha256:overviewRecordDigest(current)},previous_window:frozen,current_window:frozen};
 await c.query("UPDATE public.confirmed_memory SET status='invalidated',revision=2 WHERE id=$1",[old]);
 await c.query('UPDATE public.confirmed_memory SET version_evidence=$2 WHERE id=$1',[next,proof]);return{old,next};
 }
 const pair=await seed();await assert.rejects(run(pair.next,1),{status:409});
 const restored=await run(pair.next,2);assert.equal(restored.id,pair.old);assert.equal(restored.revision,3);assert.equal(restored.status,'active');assert.equal(restored.adoption_method,'auto');
 assert.equal((await c.query('SELECT text_content FROM public.confirmed_memory WHERE id=$1',[pair.next])).rows[0].text_content,'已删除的资料');
 await assert.rejects(run(pair.next,2),{status:409});
 const stale=await seed();await c.query("UPDATE public.source_document SET status='delete_requested' WHERE id=$1",[source]);
 await assert.rejects(run(stale.next,2),{status:409});
 assert.equal((await c.query('SELECT status FROM public.confirmed_memory WHERE id=$1',[stale.old])).rows[0].status,'invalidated');
 }finally{await f.close();}
});

import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
test('合成PG纠错快照：TS与既有Python冻结合同逐字段一致',async()=>{
 const f=await createStorageFixture(),c=f.client,owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),candidate=randomUUID(),id=randomUUID();
 try{
 await c.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'d'.repeat(64)]);
 await c.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成🙂证据','2026-10-01T01:02:03.123456Z')",[message,owner,contact]);
 await c.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{synthetic:true}]);
 const frozen=await captureSnapshot(c,owner,[message],[message],contact);
 await c.query("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status,correction_evidence) VALUES($1,$2,$3,'原合成记忆','common_fact',$4,'confirmed',$5)",[candidate,owner,contact,[message],frozen]);
 await c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method) VALUES($1,$2,$3,'原合成记忆','common_fact',$4,$5,'auto')",[id,owner,contact,[message],candidate]);
 await c.query('BEGIN');
 const updated=await mutateMemory(c,owner,{level:'contact',contactId:contact},'correct',id,{text:'纠正🙂合成记忆'});
 await c.query('COMMIT');
 const actual=(await c.query('SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND record_id=$2',[owner,id])).rows[0].evidence;
 const late=randomUUID();
 await c.query("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status,correction_evidence) VALUES($1,$2,$3,'原合成记忆','common_fact',$4,'pending',$5)",[late,owner,contact,[message],frozen]);
 const lateScript=`import sys,json\nfrom uuid import UUID\nfrom notalone.persistence.memory_store import PostgresMemoryStore\nfrom notalone.memory.models import AdoptionMethod\nfrom notalone.memory.correction import MemoryCorrectionConflictError\nfrom notalone.scopes import ContactScope\ntry:\n PostgresMemoryStore(sys.argv[1]).confirm(scope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),candidate_id=UUID(sys.argv[4]),adoption_method=AdoptionMethod.AUTO)\nexcept MemoryCorrectionConflictError:\n print(json.dumps({'rejected':True}))\nelse:\n raise AssertionError('旧自动写入错误覆盖人工决定')`;
 const legacyResult=JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',lateScript,`host=/tmp dbname=${c.database}`,owner,contact,late],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:15000}));
 assert.deepEqual(legacyResult,{rejected:true});
 assert.equal((await c.query('SELECT count(*)::int AS n FROM public.confirmed_memory WHERE source_candidate_id=$1',[late])).rows[0].n,0);
 assert.equal((await c.query('SELECT status FROM public.confirmed_memory WHERE id=$1',[updated.id])).rows[0].status,'active');

 await c.query('DELETE FROM public.memory_correction_decision WHERE owner_id=$1 AND record_id=$2',[owner,id]);
 const script=`import sys,json,psycopg\nfrom uuid import UUID\nfrom psycopg.rows import dict_row\nfrom notalone.persistence.memory_correction import record_decision,candidate_from_row\nfrom notalone.scopes import ContactScope\nwith psycopg.connect(sys.argv[1],row_factory=dict_row) as c:\n candidate=c.execute('SELECT * FROM public.memory_candidate WHERE id=%s',(UUID(sys.argv[5]),)).fetchone()\n record_decision(c,scope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),record_kind='contact_memory',record_id=UUID(sys.argv[4]),rejected_text='原合成记忆',corrected_text='纠正🙂合成记忆',replacement_memory_id=UUID(sys.argv[6]),source_ids=(UUID(sys.argv[7]),),candidate=candidate_from_row(candidate),change_kind='error_correction')\n print(json.dumps(c.execute('SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s AND record_id=%s',(UUID(sys.argv[2]),UUID(sys.argv[4]))).fetchone()['evidence']))`;
 const expected=JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,`host=/tmp dbname=${c.database}`,owner,contact,id,candidate,updated.id,message],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:15000}));
 assert.deepEqual(actual,expected);
 assert.equal(actual.message_snapshots[message].text_length,5);
 }finally{await f.close();}
});
