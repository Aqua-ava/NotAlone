// 独立 Spec 反证探针：只导入固定 archive，随机合成库，绝不读取项目配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile, writeFile, access} from 'node:fs/promises';
import {basename} from 'node:path';

const own = new URL('./', import.meta.url);
const state = JSON.parse(await readFile(new URL('private-state.json', own), 'utf8'));
const archive = state.archive;
const moduleAt = name => import(pathToFileURL(resolve(archive, 'backend-ts', name)));
const pg = createRequire(resolve(archive, 'backend-ts/package.json'))('pg');
const {createExtractionFixture} = await moduleAt('test/extraction-fixture.mjs');
const {ExtractionTaskStore} = await moduleAt('src/extraction-task-store.ts');
const {ExtractionTaskRunner} = await moduleAt('src/extraction-task-runner.ts');
const {ExtractionBatchService} = await moduleAt('src/extraction-batch-service.ts');
const {ExtractionAdoptionService} = await moduleAt('src/extraction-adoption-service.ts');
const {createExtractionPolicyVersion} = await moduleAt('src/extraction-policy-version.ts');
const {HostStorage} = await moduleAt('src/host-storage.ts');
const {EMBEDDING_MODEL, EMBEDDING_REVISION} = await moduleAt('src/retrieval-embedding.ts');
const results = {pin: state.pin, real_model_calls: 0, app_runs: 0, probes: [], cleanup: []};
let fixture, pool, client, identity;
const signal = () => new AbortController().signal;

async function transaction(work) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value; }
  catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
async function addSource(owner, contact, examples) {
  const source = randomUUID();
  await client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','synthetic-spec.jsonl',$4,$5)`,
    [source,owner,contact,createHash('sha256').update(source).digest('hex'),examples.length]);
  for (const [index, item] of examples.entries()) {
    item.id ??= randomUUID();
    item.at ??= `2026-10-20T03:${String(index).padStart(2,'0')}:00Z`;
    await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
      VALUES($1,$2,$3,'contact','text',$4,$5) ON CONFLICT DO NOTHING`,[item.id,owner,contact,item.source,item.at]);
    await client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
      VALUES($1,$2,$3,'source_document',$4,$5,$6)`,[item.id,owner,contact,source,`spec:${item.id}`,{synthetic:true,time_iso:item.at}]);
  }
  return source;
}
async function scenario(examples) {
  const owner = randomUUID(), contact = randomUUID();
  await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  const source = await addSource(owner,contact,examples);
  const store = new ExtractionTaskStore(pool,{policyVersion:identity,verificationPolicy:'complete-claim-v1'});
  const task = await store.enqueueImport({ownerId:owner,contactId:contact},source,examples.length);
  await client.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claim = await store.claim({ownerId:owner,contactId:contact},{taskId:task,workerId:randomUUID(),leaseMs:45000,supportedSteps:['extract_memory']});
  assert.ok(claim);
  return {owner,contact,source,store,task,claim,examples};
}
function extractionFact(item) {
  const refs = [{message_id:item.id,char_start:0,char_end:[...item.source].length}];
  const event = item.bad === 'event' ? {version:1,stage:'planned',stage_evidence:refs,
    occurrence_start:'2026-11-01T00:00:00Z',occurrence_end:null,occurrence_evidence:refs} : null;
  return {text:item.text,category:item.category ?? 'common_fact',subject:item.subject ?? 'contact',topic:item.topic ?? 'other',
    source_message_ids:[item.id],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,
    speech_act:item.actor === 'third_party' ? 'report' : 'assertion',
    assertion_status:item.actor === 'third_party' ? 'reported' : 'asserted',figurative_type:'literal',
    alternatives:[],interpretation_reason:'独立虚构 Spec 探针。',event,
    conditions:item.bad === 'condition' ? {version:1,items:[{text:'天气允许',evidence:refs}]} : null};
}
function makeA(s, override) {
  const calls = [];
  const batches = new ExtractionBatchService({ownerId:s.owner,transaction,ruleVersion:identity.ruleVersion,policyVersion:identity,
    unconfirmedRequests:async () => [],
    model:{binding:{provider:'synthetic-spec',model:'synthetic-spec',maxTokens:4096,temperature:0,reasoningEffort:'off'},
      profile:{context_window_tokens:128000,safety_margin_tokens:512}},
    call:async input => {
      const name = input.tools[0].name; calls.push(name);
      if (override) return override(input, name);
      let args;
      if (name === 'DirectMemoryExtractionOutput') args = {scenes:[{scene_name:'独立合成检验',memories:s.examples.map(extractionFact)}]};
      else {
        assert.equal(name,'SourceVerificationOutput');
        const payload = JSON.parse(input.messages[0].content[0].text);
        args = {request_fingerprint:payload.request_fingerprint,results:s.examples.map((item,candidate_index) => {
          const facet = () => ({verdict:'supported',evidence_indices:[0]});
          const part = {candidate_span:{start:0,end:[...item.text].length},
            attribution:{...facet(),scope_subject:'contact',actor_kind:item.actor ?? 'contact',resolution:'explicit'},
            arguments_and_relation:facet(),temporal_and_modality:facet()};
          if (item.bad === 'facet') delete part.temporal_and_modality;
          if (item.bad === 'uncertain') part.arguments_and_relation.verdict = 'uncertain';
          return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:item.id,quote:item.source}],claim_check:{version:1,parts:[part]}};
        })};
      }
      const blocks = [{type:'tool-call',name,arguments:JSON.stringify(args)}];
      await input.validateOutput(blocks);
      return {text:'',blocks};
    }});
  return {batches,calls};
}
function makeB(s) {
  return new ExtractionAdoptionService({ownerId:s.owner,taskStore:s.store,
    adjudicationPort:{async call(){throw new Error('本探针空池不应调用 B 模型');}},
    embedding:{model:EMBEDDING_MODEL,revision:EMBEDDING_REVISION,
      embed:async texts => texts.map(text => {
        const i = s.examples.findIndex(item=>item.text===text);
        return Array.from({length:12},(_,index)=> index === Math.max(0,i) ? 1 : 0);
      })}});
}
function runner(s,a,adopt) {
  return new ExtractionTaskRunner({store:s.store,batches:a.batches,policyVersion:identity,ruleVersion:identity.ruleVersion,
    batchSize:10,contextBefore:0,contextAfter:0,concurrency:1,provider:'synthetic-spec',modelName:'synthetic-spec',adopt});
}
async function counts(s) {
  const row = (await client.query(`SELECT
    (SELECT count(*)::int FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2) candidates,
    (SELECT count(*)::int FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2) memories,
    (SELECT count(*)::int FROM memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2) watermarks,
    (SELECT count(*)::int FROM memory_processing_receipt WHERE owner_id=$1 AND contact_id=$2) receipts`,[s.owner,s.contact])).rows[0];
  return row;
}

test('固定候选的独立完整链与破坏式边界', {timeout:120000}, async t => {
  fixture = await createExtractionFixture(); client = fixture.client;
  pool = new pg.Pool({host:'/tmp',database:client.connectionParameters.database,max:4});
  identity = await createExtractionPolicyVersion({rootDirectory:resolve(archive,'backend-ts/src')});
  results.source_stamp = identity.sourceStamp;
  const ownedDatabase = client.connectionParameters.database;
  assert.match(ownedDatabase,/^notalone_ts_host_[a-f0-9]{32}_test$/);
  await writeFile(new URL('private-owned-resources.json',own),JSON.stringify({database:ownedDatabase,directory:fixture.directory,pid:process.pid}),{mode:0o600});
  try {
    const run = (name,work) => !process.env.SPEC_ONLY || name.includes(process.env.SPEC_ONLY) ? t.test(name,work) : Promise.resolve();
    await run('新快照经真实 Runner/A/B：shared 正例及事件/条件/缺 facet/uncertain 的零写入',async () => {
      const s = await scenario([
        {source:'我姐姐阿萝平常在花莲工作。',text:'联系人的姐姐阿萝平常在花莲工作。',actor:'third_party',topic:'work'},
        {source:'我们两个人都喜欢雨后散步。',text:'双方都喜欢雨后散步。',subject:'shared',actor:'shared',category:'preference',topic:'health'},
        {source:'秋游时间还没有确定。',text:'秋游时间还没有确定。',category:'recent_state',topic:'travel'},
        {source:'计划去听音乐会。',text:'计划在十一月一日听音乐会。',bad:'event'},
        {source:'天气允许就去植物园。',text:'天气允许就去植物园。',bad:'condition'},
        {source:'周末会修理台灯。',text:'周末会修理台灯。',bad:'facet'},
        {source:'可能去看海。',text:'会去看海。',bad:'uncertain'},
      ]);
      const a = makeA(s), b = makeB(s);
      let sawA;
      const r = await runner(s,a,async(input,out,abort) => {
        sawA = out;
        assert.equal(out.accepted.length,3); assert.equal(out.rejected_count,4);
        assert.deepEqual(await a.batches.run(input,abort),out);
        const cancelled = new AbortController();cancelled.abort(new Error('synthetic_cancel_priority'));
        await assert.rejects(a.batches.run(input,cancelled.signal),/synthetic_cancel_priority/);
        return b.run({...input,a_result:out},abort);
      }).run(s.claim,signal());
      assert.equal(r.processedCount,7);
      assert.deepEqual(a.calls,['DirectMemoryExtractionOutput','SourceVerificationOutput']);
      assert.ok(sawA.accepted.every(f=>f.verified_source_receipt && f.dimension_evidence.version===1));
      const persisted = (await client.query('SELECT text_content,adoption_method,event,conditions FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2',[s.owner,s.contact])).rows;
      assert.deepEqual(persisted.map(x=>x.text_content).sort(),s.examples.slice(0,3).map(x=>x.text).sort());
      assert.ok(persisted.every(x=>x.adoption_method==='auto' && x.event===null && x.conditions===null));
      assert.equal((await counts(s)).receipts,7);
      const watermark=(await client.query('SELECT last_message_id FROM memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2',[s.owner,s.contact])).rows[0];
      assert.equal(watermark.last_message_id,s.examples.at(-1).id);
      results.probes.push({name:'runner_mixed_facets',status:'passed',calls:a.calls.length,accepted:3,rejected:4,processed:7,shared:true,unknown_date:true,cache_no_extra_calls:true,cancel_error_preserved:true});
      await s.store.complete(s.claim,r.processedCount,r.totalCount);
    });

    await run('B 在真实写事务中被改策略：整个候选事务回滚，恢复后才写入',async () => {
      const s = await scenario([{source:'我喜欢看云。',text:'联系人喜欢看云。',category:'preference'}]);
      const a = makeA(s), b = makeB(s);
      const originalFence = s.store.fenced.bind(s.store);
      let injected = false, injectionEnabled = false;
      s.store.fenced = (claim,work) => originalFence(claim,async c => {
        const query = c.query;
        c.query = async function(...args) {
          const answer = await query.apply(c,args);
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
          if (injectionEnabled && !injected && /INSERT\s+INTO\s+(?:public\.)?memory_candidate\b/i.test(sql)) {
            injected = true;
            await query.call(c,'UPDATE background_task SET extraction_runtime_config=NULL WHERE id=$1',[s.task]);
          }
          return answer;
        };
        try { return await work(c); } finally { c.query=query; }
      });
      await runner(s,a,async(input,out,abort) => {
        assert.deepEqual(Object.keys(input.claim).sort(),['task_id','step_id','step_name','worker_id','lease_generation'].sort());
        injectionEnabled = true;
        await assert.rejects(b.run({...input,a_result:out},abort),error => /window_mismatch/.test(error.code));
        assert.equal(injected,true);
        assert.deepEqual(await counts(s),{candidates:0,memories:0,watermarks:0,receipts:0});
        assert.deepEqual((await client.query('SELECT extraction_runtime_config config FROM background_task WHERE id=$1',[s.task])).rows[0].config,identity.newTaskConfig());
        injectionEnabled = false;
        const result = await b.run({...input,a_result:out},abort);
        results.probes.push({name:'b_write_transaction_policy_change',status:'passed',injected_at:'memory_candidate insert',rolled_back_candidates:0,rolled_back_memories:0,watermark_advanced:false,claim_keys:5,restored_run_succeeded:true});
        return result;
      }).run(s.claim,signal());
    });

    await run('真实 unknown 回执和旧 stamp：原任务失败后换来源建新任务也不能重放同一消息',async () => {
      const s = await scenario([{source:'我周日读书。',text:'联系人周日读书。'}]);
      const a = makeA(s,async (input) => {
        const ledger=randomUUID(),attempt=randomUUID();
        await client.query("INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at) VALUES($1,$2,$3,'synthetic-spec','synthetic-spec','run_failed',now())",[ledger,s.owner,s.contact]);
        await client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,dispatch,outcome,cost_status)
          VALUES($1,$2,$3,$4,$5,$6,'synthetic-spec','synthetic-spec',now(),'http_accepted','unknown','unknown')`,[attempt,s.owner,s.contact,input.request_id,randomUUID(),ledger]);
        await input.onReceipt({attempt_id:attempt,request_id:input.request_id,permit_id:randomUUID(),ledger_entry_id:ledger,provider:'synthetic-spec',model:'synthetic-spec',called_at:new Date().toISOString(),dispatch:'http_accepted',outcome:'unknown',cost_status:'unknown'});
        await client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[s.task,JSON.stringify({...identity.newTaskConfig(),source_stamp:'f'.repeat(64)})]);
        throw Object.assign(new Error('synthetic_unknown_after_dispatch'),{code:'synthetic_unknown_after_dispatch'});
      });
      let runError;
      try {await runner(s,a,async()=>{throw new Error('unknown 不得进 B');}).run(s.claim,signal());}
      catch(error) {runError = error;}
      assert.ok(runError);
      console.log('UNKNOWN_DIAGNOSTIC',JSON.stringify({code:runError.code,message:runError.message,
        calls:a.calls,receipts:(await client.query('SELECT outcome,dispatch FROM model_call_receipt WHERE owner_id=$1',[s.owner])).rows}));
      assert.equal(await s.store.fail(s.claim,'synthetic_unknown_after_dispatch',true),'failed');
      assert.equal((await client.query('SELECT outcome FROM memory_processing_receipt WHERE message_id=$1',[s.examples[0].id])).rows[0].outcome,'unknown');
      const source2 = await addSource(s.owner,s.contact,s.examples);
      const fresh = await s.store.enqueueImport({ownerId:s.owner,contactId:s.contact},source2,1);
      assert.notEqual(fresh,s.task);
      await client.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[fresh]);
      const claim = await s.store.claim({ownerId:s.owner,contactId:s.contact},{taskId:fresh,workerId:randomUUID(),leaseMs:45000});
      assert.ok(claim);
      const freshState = await s.store.targets(claim);
      assert.deepEqual(freshState.targetIds,[]);
      assert.equal(a.calls.length,1);
      assert.equal((await counts(s)).memories,0);
      results.probes.push({name:'unknown_new_task_same_message',status:'passed',calls:1,unknown_receipt_preserved:true,fresh_task_targets:0,memories:0});
    });

    await run('旧 NULL/v1 冲突重入保持原策略，116 的新增约束不改变宿主只读兼容结果',async () => {
      const owner=randomUUID(),contact=randomUUID(),scope={ownerId:owner,contactId:contact};
      await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成旧本人')",[owner]);
      await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成旧联系人')",[contact,owner]);
      const legacy=new ExtractionTaskStore(pool),current=new ExtractionTaskStore(pool,{policyVersion:identity,verificationPolicy:'complete-claim-v1'});
      const configurations=[null,{version:1,mode:'legacy',rule_set_sha256:null},{version:1,mode:'bounded-runtime-v1',rule_set_sha256:'a'.repeat(64)}];
      for (const config of configurations) {
        const source=await addSource(owner,contact,[]),id=await legacy.enqueueImport(scope,source,0);
        await client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[id,config===null?null:JSON.stringify(config)]);
        assert.equal(await current.enqueueImport(scope,source,0),id);
        assert.deepEqual((await client.query('SELECT extraction_runtime_config config FROM background_task WHERE id=$1',[id])).rows[0].config,config);
        for (const invalid of [{...identity.newTaskConfig(),extra:true},{...identity.newTaskConfig(),source_stamp:null}]) {
          await assert.rejects(client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[id,JSON.stringify(invalid)]),error=>error.code==='23514');
        }
      }
      const host=await HostStorage.open(fixture.options);
      try {assert.deepEqual(await host.compatibility(),{code:'ready'});} finally {await host.close();}
      assert.equal((await client.query('SELECT count(*)::int n FROM notalone_schema_migration')).rows[0].n,116);
      await identity.assertCurrent();
      results.probes.push({name:'legacy_conflict_and_116_host_compatibility',status:'passed',old_configs_preserved:3,invalid_v2_rejected:6,migrations:116,host_code:'ready'});
    });
  } finally {
    await pool.end();await fixture.close();
    const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
    try {
      const databaseAbsent=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[ownedDatabase])).rowCount===0;
      assert.equal(databaseAbsent,true);
      const directoryAbsent=await access(fixture.directory).then(()=>false,()=>true);
      assert.equal(directoryAbsent,true);
      results.cleanup.push({database:ownedDatabase,absent:true,directory:`$TMP_ROOT/${basename(fixture.directory)}`,directory_absent:directoryAbsent,pid:process.pid});
    } finally {await admin.end();}
    await writeFile(new URL('probe-results.json',own),JSON.stringify(results,null,2)+'\n',{mode:0o600});
  }
});
