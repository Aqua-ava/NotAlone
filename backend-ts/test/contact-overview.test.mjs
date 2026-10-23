import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { readContactOverview } from '../src/contact-overview.ts';

test('合成PG：空联系人概览保留原ID和稳定投影，未知范围明确失败', async () => {
  const fixture = await createStorageFixture();
  const owner = randomUUID(), contact = randomUUID();
  try {
    await fixture.client.query('INSERT INTO public.owner (id, display_name) VALUES ($1,$2)', [owner, '合成本人']);
    await fixture.client.query('INSERT INTO public.contact (id, owner_id, display_name) VALUES ($1,$2,$3)', [contact, owner, '合成联系人']);
    const first = await readContactOverview(fixture.client, owner, contact);
    assert.equal(first.contact_id, contact);
    assert.equal(first.scope_kind, 'contact');
    assert.equal(first.memory_revision, 0);
    assert.deepEqual(first.entries, []);
    // 旧 Python 对规范空 manifest 的固定摘要，避免测试重新实现摘要算法。
    assert.equal(first.projection_revision, 'dd7b53d32b023a62cff2f213975b78e7b226a544d2012ea43857b63c610d7597');
    assert.deepEqual(await readContactOverview(fixture.client, owner, contact), first);
    await fixture.client.query("UPDATE public.relationship_overview_projection SET built_at='2026-10-01T00:00:00Z' WHERE owner_id=$1 AND contact_id=$2",[owner,contact]);
    const exactSecond = pythonOverview(fixture,owner,contact);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),exactSecond);
    await assert.rejects(readContactOverview(fixture.client, randomUUID(), contact), { code: 'overview_not_found' });
  } finally { await fixture.close(); }
});

test('合成PG：既有手工关系资料与Python概览逐字段一致，来源失效不会保留投影', async () => {
  const fixture = await createStorageFixture();
  const owner = randomUUID(), contact = randomUUID(), source = randomUUID(), memory = randomUUID();
  try {
    await fixture.client.query('INSERT INTO public.owner (id,display_name) VALUES ($1,$2)', [owner,'合成本人']);
    await fixture.client.query('INSERT INTO public.contact (id,owner_id,display_name) VALUES ($1,$2,$3)', [contact,owner,'合成联系人']);
    await fixture.client.query("INSERT INTO public.source_document (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES ($1,$2,$3,'manual','合成手工来源',$4,1)", [source,owner,contact,'a'.repeat(64)]);
    await fixture.client.query("INSERT INTO public.confirmed_memory (id,owner_id,contact_id,text_content,category,source_ids,adoption_method,created_at) VALUES ($1,$2,$3,'喜欢清淡食物','preference',$4,'manual','2026-10-01T01:02:03.123456Z')", [memory,owner,contact,[source]]);
    const expected = pythonOverview(fixture,owner,contact);
    const actual = await readContactOverview(fixture.client,owner,contact);
    assert.deepEqual(actual,expected);
    assert.equal(actual.entries[0].memory.memory_id,memory);
    assert.equal(actual.entries[0].provenance.kind,'manual_entry');
    const contextMemory = randomUUID(), sourceCandidate = randomUUID();
    await fixture.client.query("INSERT INTO public.owner_memory (id,owner_id,text_content,category,source_ids,adoption_method,valid_at) VALUES ($1,$2,'合成上下文偏好','preference',$3,'manual','2026-10-01T01:02:03.120000Z')",[contextMemory,owner,[owner]]);
    const frozen = {version:1,kind:'generation',message_ids:[],source_ids:[source,contextMemory],source_refs:[],message_digests:{},message_snapshots:{},message_scopes:{},has_memory_context:true};
    await fixture.client.query("INSERT INTO public.memory_candidate (id,owner_id,contact_id,text_content,category,source_ids,correction_evidence) VALUES ($1,$2,$3,'喜欢清淡食物','preference',$4,$5)",[sourceCandidate,owner,contact,[source],frozen]);
    await fixture.client.query('UPDATE public.confirmed_memory SET source_candidate_id=$2 WHERE id=$1',[memory,sourceCandidate]);
    const contextExpected = pythonOverview(fixture,owner,contact);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),contextExpected);
    const correction = `import sys\nfrom uuid import UUID\nfrom notalone.persistence.memory_store import PostgresMemoryStore\nfrom notalone.scopes import ContactScope\nPostgresMemoryStore(sys.argv[1]).correct(scope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),memory_id=UUID(sys.argv[4]),text='偏好清淡且不放辣椒')`;
    execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',correction,`host=/tmp dbname=${fixture.client.database}`,owner,contact,memory],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000});
    const corrected = pythonOverview(fixture,owner,contact);
    assert.equal(corrected.entries.length,2);
    assert.equal(corrected.entries[0].is_latest,false);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),corrected);
    await fixture.client.query("UPDATE public.source_document SET status='delete_requested' WHERE id=$1",[source]);
    const deleted = pythonOverview(fixture,owner,contact);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),deleted);
    assert.deepEqual(deleted.entries,[]);
  } finally { await fixture.close(); }
});

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
function pythonOverview(fixture,owner,contact) {
  const script = `import sys,json\nfrom uuid import UUID\nfrom notalone.persistence.memory_overview import PostgresRelationshipOverviewStore\nfrom notalone.server.memory_overview import overview_payload\nfrom notalone.server.app import _memory_payload\nfrom notalone.scopes import ContactScope\nprint(json.dumps(overview_payload(PostgresRelationshipOverviewStore(sys.argv[1]).read_contact(ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]))),_memory_payload)))`;
  return JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,`host=/tmp dbname=${fixture.client.database}`,owner,contact],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:15000}));
}

test('合成PG：冻结消息引用保留原始依据，引用世代变化撤下旧资料', async () => {
  const fixture = await createStorageFixture();
  const owner = randomUUID(), contact = randomUUID(), source = randomUUID(), message = randomUUID(), candidate = randomUUID(), memory = randomUUID();
  try {
    await fixture.client.query('INSERT INTO public.owner (id,display_name) VALUES ($1,$2)',[owner,'合成用户']);
    await fixture.client.query('INSERT INTO public.contact (id,owner_id,display_name) VALUES ($1,$2,$3)',[contact,owner,'合成联系人']);
    await fixture.client.query("INSERT INTO public.source_document (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES ($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'b'.repeat(64)]);
    await fixture.client.query("INSERT INTO public.message (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES ($1,$2,$3,'contact','text','合成原话：喜欢清淡食物','2026-10-01T01:02:03.123456Z')",[message,owner,contact]);
    await fixture.client.query("INSERT INTO public.message_source_ref (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES ($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-10-01T01:02:03.123456+00:00',synthetic:1}]);
    await fixture.client.query(`UPDATE public.message_source_ref SET raw_payload=raw_payload || '{"synthetic_float":1.0,"synthetic_large":9007199254740993,"synthetic_small":0.00001,"synthetic_exp":10000000000000000.0,"\ue000":1,"𐀀":2}'::jsonb WHERE message_id=$1`,[message]);
    const script = `import sys,psycopg\nfrom uuid import UUID\nfrom psycopg.rows import dict_row\nfrom psycopg.types.json import Jsonb\nfrom notalone.persistence.correction_evidence import capture_message_snapshot\nwith psycopg.connect(sys.argv[1],row_factory=dict_row) as c:\n owner,contact,message,candidate,memory=map(UUID,sys.argv[2:])\n frozen=capture_message_snapshot(c,owner_id=owner,contact_id=contact,message_ids={message},source_ids=(message,))\n frozen['kind']='generation'\n c.execute(\"INSERT INTO public.memory_candidate (id,owner_id,contact_id,text_content,category,source_ids,status,correction_evidence) VALUES (%s,%s,%s,'喜欢清淡食物','preference',%s,'confirmed',%s)\",(candidate,owner,contact,[message],Jsonb(frozen)))\n c.execute(\"INSERT INTO public.confirmed_memory (id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method,created_at) VALUES (%s,%s,%s,'喜欢清淡食物','preference',%s,%s,'manual','2026-10-02T00:00:00Z')\",(memory,owner,contact,[message],candidate))`;
    execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,`host=/tmp dbname=${fixture.client.database}`,owner,contact,message,candidate,memory],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000});
    const expected = pythonOverview(fixture,owner,contact);
    assert.equal(expected.entries.length,1);
    assert.equal(expected.entries[0].provenance.kind,'source_supported');
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),expected);
    const versionScript = `import sys,psycopg\nfrom uuid import UUID,uuid4\nfrom psycopg.rows import dict_row\nfrom psycopg.types.json import Jsonb\nfrom notalone.persistence.memory_versions import raw_memory,version_record_digest\nfrom notalone.persistence.correction_evidence import capture_message_snapshot\nwith psycopg.connect(sys.argv[1],row_factory=dict_row) as c:\n owner,contact,message,memory=map(UUID,sys.argv[2:])\n c.execute("UPDATE public.confirmed_memory SET adoption_method='auto' WHERE id=%s",(memory,))\n old=c.execute('SELECT * FROM public.confirmed_memory WHERE id=%s',(memory,)).fetchone()\n new_id=uuid4()\n c.execute("INSERT INTO public.confirmed_memory (id,owner_id,contact_id,text_content,category,source_ids,adoption_method,supersedes_memory_id,created_at) VALUES (%s,%s,%s,'偏好清淡食物','preference',%s,'auto',%s,'2026-10-03T00:00:00Z')",(new_id,owner,contact,[message],memory))\n new=c.execute('SELECT * FROM public.confirmed_memory WHERE id=%s',(new_id,)).fetchone()\n frozen=capture_message_snapshot(c,owner_id=owner,contact_id=contact,message_ids={message},source_ids=(message,))\n window={**{k:frozen[k] for k in ('version','message_ids','source_ids','source_refs','message_digests','message_snapshots','message_scopes')},'ordered_message_ids':[str(message)]}\n evidence={'version':1,'previous':{'memory_id':str(memory),'revision':1,'adoption_method':'auto','valid_at':None,'invalid_at':None,'record_sha256':version_record_digest(raw_memory(old))},'current':{'memory_id':str(new_id),'revision':1,'record_sha256':version_record_digest(raw_memory(new))},'previous_window':window,'current_window':window}\n c.execute("UPDATE public.confirmed_memory SET status='invalidated',revision=2,invalid_at='2026-10-03T00:00:00Z' WHERE id=%s",(memory,))\n c.execute('UPDATE public.confirmed_memory SET version_evidence=%s WHERE id=%s',(Jsonb(evidence),new_id))`;
    execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',versionScript,`host=/tmp dbname=${fixture.client.database}`,owner,contact,message,memory],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000});
    const versioned=pythonOverview(fixture,owner,contact);
    assert.equal(versioned.entries[1].memory.can_revert_auto_update,true);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),versioned);
    const conflictScript = `import sys,psycopg\nfrom uuid import UUID,uuid4\nfrom psycopg.rows import dict_row\nfrom psycopg.types.json import Jsonb\nfrom notalone.persistence.memory_versions import raw_memory,version_record_digest\nfrom notalone.persistence.correction_evidence import capture_message_snapshot\nwith psycopg.connect(sys.argv[1],row_factory=dict_row) as c:\n owner,contact,message=map(UUID,sys.argv[2:])\n row=c.execute("SELECT * FROM public.confirmed_memory WHERE owner_id=%s AND contact_id=%s AND status='active'",(owner,contact)).fetchone()\n frozen=capture_message_snapshot(c,owner_id=owner,contact_id=contact,message_ids={message},source_ids=(message,))\n evolution={'version':1,'kind':'unresolved_conflict','explanation':'合成待核反证','related_versions':[{'memory_id':str(row['id']),'revision':1}],'evidence_message_ids':[str(message)],'source_supported':True,'claim_changed':True,'condition_changed':False,'proof':{'scope':{'owner_id':str(owner),'contact_id':str(contact)},'sources':frozen,'parents':[{'subject':'contact','memory_id':str(row['id']),'revision':1,'invalid_at':None,'record_sha256':version_record_digest(raw_memory(row))}]}}\n c.execute("INSERT INTO public.memory_candidate (id,owner_id,contact_id,text_content,category,source_ids,evolution) VALUES (%s,%s,%s,'合成反证','preference',%s,%s)",(uuid4(),owner,contact,[message],Jsonb(evolution)))`;
    execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',conflictScript,`host=/tmp dbname=${fixture.client.database}`,owner,contact,message],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000});
    const conflict=pythonOverview(fixture,owner,contact);
    assert.equal(conflict.entries[1].memory.evolution.kind,'unresolved_conflict');
    assert.equal(conflict.entries[1].memory.can_revert_auto_update,true);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),conflict);
    await fixture.client.query("UPDATE public.confirmed_memory SET text_content='合成旧版本改动' WHERE id=$1",[memory]);
    const changedVersion=pythonOverview(fixture,owner,contact);
    assert.equal(changedVersion.entries[1].memory.can_revert_auto_update,false);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),changedVersion);
    await fixture.client.query("UPDATE public.message_source_ref SET raw_payload=raw_payload || '{\"synthetic\":2}' WHERE message_id=$1",[message]);
    const stale = pythonOverview(fixture,owner,contact);
    assert.deepEqual(stale.entries,[]);
    assert.deepEqual(await readContactOverview(fixture.client,owner,contact),stale);
  } finally { await fixture.close(); }
});

test('合成PG：旧生产提取测试夹具的事件阶段与全部概览指纹保持一致', async () => {
  const fixture = await createStorageFixture();
  try {
    const seeded = JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('./contact-overview-fixture.py',import.meta.url).pathname,`host=/tmp dbname=${fixture.client.database}`],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:[new URL('../../backend/src',import.meta.url).pathname,new URL('../../backend',import.meta.url).pathname].join(':')},encoding:'utf8',timeout:60000}));
    assert.equal(seeded.overview.entries.length,1);
    assert.equal(seeded.overview.entries[0].memory.event.stage,'planned');
    assert.deepEqual(await readContactOverview(fixture.client,seeded.owner,seeded.contact),seeded.overview);
  } finally { await fixture.close(); }
});

test('合成PG：有限语义资料的条件支持和来源投影与旧概览一致', async () => {
  const fixture=await createStorageFixture();
  try {
    const environment={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:[new URL('../../backend/src',import.meta.url).pathname,new URL('../../backend',import.meta.url).pathname].join(':')};
    const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python'), url=`host=/tmp dbname=${fixture.client.database}`;
    execFileSync(python,[new URL('./contact-overview-bounded-fixture.py',import.meta.url).pathname,url],{env:environment,timeout:20000});
    const cases=JSON.parse(execFileSync(python,[new URL('./contact-overview-bounded-overview-fixture.py',import.meta.url).pathname,url],{env:environment,encoding:'utf8',timeout:20000}));
    for(const entry of cases) {
      const expected=pythonOverview(fixture,entry.owner,entry.contact);
      assert.equal(expected.entries.length,1);
      if(entry.conditions) assert.equal(expected.entries[0].memory.conditions.items[0].source_supported,true);
      assert.deepEqual(await readContactOverview(fixture.client,entry.owner,entry.contact),expected);
    }
  } finally {await fixture.close();}
});
