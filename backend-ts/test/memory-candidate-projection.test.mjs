import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { captureSnapshot } from '../src/contact-overview-evidence.ts';
import { candidatePayload,listMemoryCandidates } from '../src/memory-candidate-projection.ts';

const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const environment={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend',import.meta.url).pathname+':'+new URL('../../backend/src',import.meta.url).pathname};
function oracle(f,rows) {
  const script=`import sys,json\nfrom uuid import UUID\nfrom notalone.persistence.memory_store import PostgresMemoryStore\nfrom notalone.scopes import ContactScope\nfrom notalone.server.app import _memory_candidate_payload\ns=PostgresMemoryStore(sys.argv[1])\nprint(json.dumps([_memory_candidate_payload(s.get_candidate(scope=ContactScope(UUID(r['owner_id']),UUID(r['contact_id'])),candidate_id=UUID(r['id']))) for r in json.loads(sys.argv[2])]))`;
  return JSON.parse(execFileSync(python,['-c',script,`host=/tmp dbname=${f.client.database}`,JSON.stringify(rows)],{env:environment,encoding:'utf8',timeout:20000}));
}

test('真实合成PG：候选DTO逐字段对照Python，有限依据、失效投影和范围', async()=>{
  const f=await createStorageFixture(),c=f.client;
  try {
    const cases=JSON.parse(execFileSync(python,[new URL('./contact-overview-bounded-fixture.py',import.meta.url).pathname,`host=/tmp dbname=${c.database}`],{env:environment,encoding:'utf8',timeout:20000}));
    const rows=(await c.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c ORDER BY id')).rows.map(r=>r.value);
    assert.equal(rows.length,cases.length);
    for(const row of rows) {
      const evidence=await captureSnapshot(c,row.owner_id,row.dimension_evidence.messages.map(m=>m.message_id),row.source_ids,row.contact_id);
      await c.query("UPDATE public.memory_candidate SET correction_evidence=$2,status='pending' WHERE id=$1",[row.id,evidence]);
      row.correction_evidence=evidence;row.status='pending';
    }
    let expected=oracle(f,rows);
    for(let i=0;i<rows.length;i++) assert.deepEqual(await candidatePayload(c,rows[i]),expected[i],cases.find(r=>r.id===rows[i].id).variant);
    const first=rows[0];
    assert.equal((await listMemoryCandidates(c,first.owner_id,first.contact_id)).length,1);
    assert.deepEqual(await listMemoryCandidates(c,first.owner_id,randomUUID()),[]);
    await c.query("UPDATE public.message_source_ref SET raw_payload=raw_payload || '{\"changed\":true}' WHERE owner_id=$1 AND contact_id=$2",[first.owner_id,first.contact_id]);
    expected=oracle(f,[first])[0];
    assert.deepEqual(await candidatePayload(c,first),expected);
    const stale=await candidatePayload(c,first);
    assert.equal(stale.dimension_evidence_source_current,false);
    assert.ok(Object.values(stale.dimension_evidence_dimensions).every(item=>item.state==='stale'));
    await c.query("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE id=$1",[first.id]);
    assert.deepEqual(await listMemoryCandidates(c,first.owner_id,first.contact_id),[],'失去来源世代的pending候选从列表撤下');
  } finally {await f.close();}
});
