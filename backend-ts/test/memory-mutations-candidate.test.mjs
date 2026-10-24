import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { captureSnapshot, sha } from '../src/contact-overview-evidence.ts';
import { candidateActionBody, mutateMemoryCandidate } from '../src/memory-mutations-candidate.ts';
import { mutateMemory } from '../src/memory-mutations.ts';
import { protectCandidate } from '../src/memory-mutations-protection.ts';
import { candidatePayload } from '../src/memory-candidate-projection.ts';

test('候选入口保留精确字段与整数版本合同', () => {
  for (const body of [{expected_revision:true},{previous_memory_id:randomUUID(),expected_revision:1.5},{previous_memory_id:randomUUID(),expected_revision:1,extra:1}])
    assert.throws(() => candidateActionBody('apply-update',body),{status:400});
  const id=randomUUID();
  assert.throws(() => candidateActionBody('confirm',{correction_decision_ids:[id,id.toUpperCase()]}),{status:400});
  assert.deepEqual(candidateActionBody('confirm',{}),{});
});

test('真实合成PG：确认、self路由、丢弃、更新CAS、幂等、来源变化和隔离', async () => {
  const f=await createStorageFixture(), c=f.client, owner=randomUUID(), contact=randomUUID(), other=randomUUID();
  const backup=join(f.directory,'synthetic-backup');
  const run=async(action,id,body={})=>{
    await c.query('BEGIN');
    try {const value=await mutateMemoryCandidate(c,owner,contact,action,id,body,{beforeErase:()=>rm(backup,{force:true})});await c.query('COMMIT');return value;}
    catch(error){await c.query('ROLLBACK');throw error;}
  };
  const seed=async(subject='contact',text='合成偏好')=>{
    const source=randomUUID(),message=randomUUID(),id=randomUUID();
    await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,sha(source)]);
    await c.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,$4,'text',$5)",[message,owner,contact,subject==='self'?'user':'contact',text]);
    await c.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{synthetic:true}]);
    const evidence=await captureSnapshot(c,owner,[message],[message],contact);
    await c.query("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,subject,source_ids,correction_evidence) VALUES($1,$2,$3,$4,'preference',$5,$6,$7)",[id,owner,contact,text,subject,[message],evidence]);
    return {id,source,message};
  };
  try {
    await c.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
    await c.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3),($4,$2,$3)',[contact,owner,'同名合成联系人',other]);
    const first=await seed();
    const confirmed=await run('confirm',first.id);
    assert.equal(confirmed.adoption_method,'manual');
    assert.equal((await run('confirm',first.id)).id,confirmed.id);
    await c.query('BEGIN');
    await assert.rejects(mutateMemoryCandidate(c,owner,other,'confirm',first.id,{}),{status:404});
    await c.query('ROLLBACK');
    const next=await seed('contact','更新的合成偏好');
    await assert.rejects(run('apply-update',next.id,{previous_memory_id:confirmed.id,expected_revision:2}),{status:409});
    const changed=await run('apply-update',next.id,{previous_memory_id:confirmed.id,expected_revision:1});
    assert.equal(changed.revision,2);assert.equal(changed.supersedes_memory_id,confirmed.id);
    assert.deepEqual(changed.source_ids,[first.message,next.message]);
    assert.equal(changed.version_evidence.previous.memory_id,confirmed.id);
    assert.equal((await run('apply-update',next.id,{previous_memory_id:confirmed.id,expected_revision:1})).id,changed.id);
    const late=await seed();
    await assert.rejects(run('apply-update',late.id,{previous_memory_id:confirmed.id,expected_revision:1}),{status:409});
    const self=await seed('self','本人合成偏好');
    const own=await run('confirm',self.id);
    assert.equal(own.contact_id,undefined);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM public.owner_memory WHERE id=$1',[own.id])).rows[0].n,1);
    const atomic=await seed('contact','原子提交故障');
    await c.query(`CREATE FUNCTION public.synthetic_candidate_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id::text=TG_ARGV[0] AND NEW.status='confirmed' THEN RAISE EXCEPTION '合成提交故障'; END IF; RETURN NEW; END $$`);
    await c.query(`CREATE TRIGGER synthetic_candidate_fault BEFORE UPDATE ON public.memory_candidate FOR EACH ROW EXECUTE FUNCTION public.synthetic_candidate_fault('${atomic.id}')`);
    await assert.rejects(run('confirm',atomic.id),{code:'P0001'});
    assert.equal((await c.query('SELECT count(*)::int AS n FROM public.confirmed_memory WHERE source_candidate_id=$1',[atomic.id])).rows[0].n,0);
    assert.equal((await c.query('SELECT status FROM public.memory_candidate WHERE id=$1',[atomic.id])).rows[0].status,'pending');
    await c.query('DROP TRIGGER synthetic_candidate_fault ON public.memory_candidate');
    assert.equal((await run('confirm',atomic.id)).status,'active');
    const rejected=await seed('contact','被拒绝的合成偏好');
    await writeFile(backup,'合成备份正文');
    await c.query('BEGIN');
    await assert.rejects(mutateMemoryCandidate(c,owner,contact,'discard',rejected.id,{}),{status:503});
    await c.query('ROLLBACK');
    assert.equal((await c.query('SELECT status FROM public.memory_candidate WHERE id=$1',[rejected.id])).rows[0].status,'pending');
    assert.equal((await run('discard',rejected.id)).status,'rejected');
    await assert.rejects(stat(backup),{code:'ENOENT'});
    assert.equal((await run('discard',rejected.id)).status,'rejected');
    const fingerprint=(await c.query('SELECT status,adoption_method FROM public.confirmed_memory WHERE source_candidate_id=$1',[rejected.id])).rows[0];
    assert.deepEqual(fingerprint,{status:'deleted',adoption_method:'auto'});
    await assert.rejects(run('confirm',rejected.id),{status:409});
    const stale=await seed('contact','来源被改写');
    await c.query("UPDATE public.message SET text_content='新世代' WHERE id=$1",[stale.message]);
    await assert.rejects(run('confirm',stale.id),{status:409});
    assert.equal((await c.query('SELECT count(*)::int AS n FROM public.confirmed_memory WHERE source_candidate_id=$1',[stale.id])).rows[0].n,0);
    await c.query('BEGIN');
    const corrected=await mutateMemory(c,owner,{level:'contact',contactId:contact},'correct',changed.id,{text:'人工明确修正'});
    await c.query('COMMIT');
    const oldCopy=randomUUID();
    await c.query(`INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,subject,source_ids,correction_evidence)
      SELECT $2,owner_id,contact_id,text_content,category,subject,source_ids,correction_evidence FROM public.memory_candidate WHERE id=$1`,[next.id,oldCopy]);
    await assert.rejects(run('confirm',oldCopy),{status:409});
    const reviewed=await seed('contact','修正之后的新依据');
    const reviewRow=(await c.query('SELECT to_jsonb(m) AS value FROM public.memory_candidate m WHERE id=$1',[reviewed.id])).rows[0].value;
    const protection=await protectCandidate(c,reviewRow);
    const payload=await candidatePayload(c,reviewRow);
    assert.ok(protection.decisionIds.length>=2);
    assert.deepEqual(payload.correction_review.map(r=>r.decision_id),protection.decisionIds);
    assert.ok(payload.correction_review.some(r=>r.corrected_text==='人工明确修正'));
    await assert.rejects(run('confirm',reviewed.id),{status:409});
    await assert.rejects(run('confirm',reviewed.id,{correction_decision_ids:[randomUUID()]}),{status:409});
    const accepted=await run('confirm',reviewed.id,{correction_decision_ids:protection.decisionIds});
    assert.equal(accepted.status,'active');
    assert.equal((await c.query('SELECT status FROM public.confirmed_memory WHERE id=$1',[corrected.id])).rows[0].status,'active');
    assert.equal((await run('confirm',reviewed.id,{correction_decision_ids:protection.decisionIds})).id,accepted.id);
  } finally {await f.close();}
});
