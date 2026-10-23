import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { dimensionSourcesCurrent, candidateDigest } from '../src/contact-overview-dimensions.ts';

// Python基线只负责生成合成持久证据；被测读取从独立PG复核完整窗口。
const python = join(homedir(), 'miniconda3/envs/NotAlone/bin/python');
function seed(fixture, ids) {
 const script = `import sys,json,psycopg
from uuid import UUID
from dataclasses import replace
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.persistence.memory_correction import candidate_from_row
from notalone.memory.dimension_evidence import DimensionEvidence,EvidenceMessage,TextSpan,MessageSpan,TextAlignment
from notalone.memory.evidence_binding import candidate_digest,window_digest,content_digest,source_state_digest
with psycopg.connect(sys.argv[1],row_factory=dict_row) as c:
 owner,contact,source,message,ref,candidate=map(UUID,sys.argv[2:])
 c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')",(owner,))
 c.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成联系人')",(contact,owner))
 c.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'manual','合成资料',%s,1)",(source,owner,contact,'a'*64))
 text='喜欢清淡😀食物'
 c.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text',%s,'2026-10-01T01:02:03.123456Z')",(message,owner,contact,text))
 raw={'time_iso':'2026-10-01T01:02:03.123456+00:00','float':1.0,'large':9007199254740993}
 c.execute("INSERT INTO public.message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,%s,'source_document',%s,'line:1',%s)",(ref,message,owner,contact,source,Jsonb(raw)))
 row=c.execute("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status,confidence) VALUES(%s,%s,%s,%s,'preference',%s,'confirmed',1.0) RETURNING *",(candidate,owner,contact,text,[message])).fetchone()
 value=candidate_from_row(row)
 timestamp=c.execute('SELECT occurred_at FROM public.message WHERE id=%s',(message,)).fetchone()['occurred_at']
 snapshots=[dict(source_ref_id=str(ref),source_id=str(source),source_kind='source_document',locator='line:1',raw_payload=raw,source_content_sha256='a'*64)]
 msg=EvidenceMessage(message,content_digest(text),len(text),'contact','text',timestamp,((ref,source),),'text',source_state_digest(snapshots))
 span=TextSpan(0,len(text),content_digest(text))
 evidence=DimensionEvidence(value.scope,candidate_digest(value),window_digest(value.scope,(msg,)),(msg,),paraphrase=(TextAlignment(span,MessageSpan(message,span)),))
 c.execute('UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s',(Jsonb(evidence.to_payload()),candidate))
`;
 execFileSync(python,['-c',script,`host=/tmp dbname=${fixture.client.database}`,...ids],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000});
}

test('合成PG：候选完整维度绑定保留Unicode与微秒，候选/窗口/来源改变即失效', async () => {
 const fixture = await createStorageFixture(), ids=Array.from({length:6},()=>randomUUID());
 try {
  seed(fixture,ids);
  const read=async()=> (await fixture.client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE id=$1',[ids[5]])).rows[0].value;
  const candidate=await read();
  assert.equal(candidateDigest(candidate),candidate.dimension_evidence.candidate_sha256);
  assert.equal(await dimensionSourcesCurrent(fixture.client,candidate),true);
  assert.equal(await dimensionSourcesCurrent(fixture.client,{...candidate,text_content:'不同内容'}),false);
  assert.equal(await dimensionSourcesCurrent(fixture.client,{...candidate,contact_id:randomUUID()}),false);
  await fixture.client.query("UPDATE public.message_source_ref SET raw_payload=raw_payload || '{\"changed\":true}' WHERE id=$1",[ids[4]]);
  assert.equal(await dimensionSourcesCurrent(fixture.client,await read()),false);
 } finally { await fixture.close(); }
});

test('合成PG：旧编译器六类有限语义证明逐项重绑定，摘要篡改和来源变更均失效', async () => {
 const fixture=await createStorageFixture();
 try {
  const cases=JSON.parse(execFileSync(python,[new URL('./contact-overview-bounded-fixture.py',import.meta.url).pathname,`host=/tmp dbname=${fixture.client.database}`],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend',import.meta.url).pathname+':'+new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:20000}));
  for(const entry of cases) {
   const candidate=(await fixture.client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE id=$1',[entry.id])).rows[0].value;
   assert.equal(await dimensionSourcesCurrent(fixture.client,candidate),true,entry.rule+'/'+entry.variant);
   if(entry.variant==='conditional_plan') {
    const shifted=structuredClone(candidate);
    shifted.valid_at=shifted.valid_at.replace(/(?:\.0+)?([+-]\d\d:\d\d|Z)$/,'.000001$1');
    assert.notEqual(shifted.valid_at,candidate.valid_at);
    shifted.dimension_evidence.candidate_sha256=candidateDigest(shifted,4);
    assert.equal(await dimensionSourcesCurrent(fixture.client,shifted),false,'重算摘要不能以毫秒舍入隐藏计划起点微秒变更');
   }
   const unproven=structuredClone(candidate);
   unproven.dimension_evidence.semantic_basis=null;
   assert.equal(await dimensionSourcesCurrent(fixture.client,unproven),true,'合法v4可保存未取得语义信用的完整正文来源');
   const swapped=structuredClone(candidate);
   swapped.subject=candidate.subject==='self'?'contact':'self';
   swapped.dimension_evidence.candidate_sha256=candidateDigest(swapped,4);
   assert.equal(await dimensionSourcesCurrent(fixture.client,swapped),false,'重算候选摘要不能把作者改为另一方');
   const forged=structuredClone(candidate);
   forged.dimension_evidence.semantic_basis.rule_set_sha256='0'.repeat(64);
   assert.equal(await dimensionSourcesCurrent(fixture.client,forged),false,'拒绝伪造规则摘要');
   const changed=structuredClone(candidate);
   changed.dimension_evidence.target_message_ids=[];
   assert.equal(await dimensionSourcesCurrent(fixture.client,changed),false,'拒绝空目标');
   await fixture.client.query("UPDATE public.message_source_ref SET raw_payload=raw_payload || '{\"changed\":true}' WHERE message_id=$1",[candidate.source_ids[0]]);
   assert.equal(await dimensionSourcesCurrent(fixture.client,candidate),false,'撤下来源世代已变证明');
  }
 } finally {await fixture.close();}
});

test('合成PG：旧v1/v2语义全文重解析保留到家、借物、请托、条件计划及完整引句',async()=>{
 const fixture=await createStorageFixture();
 try {
  const cases=JSON.parse(execFileSync(python,[new URL('./contact-overview-legacy-fixture.py',import.meta.url).pathname,`host=/tmp dbname=${fixture.client.database}`],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend',import.meta.url).pathname+':'+new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:20000}));
  for(const entry of cases){
   const candidate=(await fixture.client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE id=$1',[entry.id])).rows[0].value;
   assert.equal(await dimensionSourcesCurrent(fixture.client,candidate),true,entry.claim);
   const forged=structuredClone(candidate);
   forged.dimension_evidence.semantic_basis.atoms[0].roles.actor=true;
   assert.equal(await dimensionSourcesCurrent(fixture.client,forged),false,'拒绝篡改语义角色');
   const changed=structuredClone(candidate);
   changed.text_content+='未经来源支持的新主张';
   changed.dimension_evidence.candidate_sha256=candidateDigest(changed);
   assert.equal(await dimensionSourcesCurrent(fixture.client,changed),false,'重算摘要不能支持新增主张');
  }
 }finally{await fixture.close();}
});
