import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionAdoptionService} from '../src/extraction-adoption-service.ts';
import {ExtractionBatchService} from '../src/extraction-batch-service.ts';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';
import {ExtractionTaskRunner} from '../src/extraction-task-runner.ts';
import {createExtractionPolicyVersion} from '../src/extraction-policy-version.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';
import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../src/retrieval-embedding.ts';

test('显式新任务经正式A→B保留第三人称和忠实未知日期，负向facet不写入且缓存不绕版本/unknown',
 {timeout:30000},async()=>{
  const fixture=await createExtractionFixture(),client=fixture.client;
  const pool=new pg.Pool({host:'/tmp',database:client.connectionParameters.database,max:4});
  try{
    const owner=randomUUID(),contact=randomUUID(),source=randomUUID();
    const examples=[
      {text:'联系人的姐姐阿青长期住在高雄。',source:'我姐姐阿青长期住在高雄。',category:'common_fact',actor:'third_party'},
      {text:'阿青说展演日期还没定。',source:'阿青说展演日期还没定。',category:'recent_state',actor:'third_party'},
      {text:'说话者获悉社区演出已经结束后放松下来。',source:'门口那声短哨，我听成了散场提示，当时一下轻松了。',failure:'unsupported'},
      {text:'阿青已确认活动日期。',source:'阿青还没确认活动日期。',failure:'uncertain'},
      {text:'阿青喜欢周三散步。',source:'阿青喜欢周三散步。',failure:'missing'},
      {text:'联系人的朋友小林喜欢绿茶。',source:'我的朋友小林喜欢绿茶。',failure:'scope'},
    ].map((item,index)=>({...item,id:randomUUID(),occurred:`2026-10-20T02:0${index}:00Z`}));
    await client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
    await client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
    await client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
      VALUES($1,$2,$3,'wechat_jsonl','synthetic-complete-claim.jsonl',$4,$5)`,
      [source,owner,contact,createHash('sha256').update('synthetic-complete-claim').digest('hex'),examples.length]);
    for(const item of examples){
      await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
        VALUES($1,$2,$3,'contact','text',$4,$5)`,[item.id,owner,contact,item.source,item.occurred]);
      await client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
        VALUES($1,$2,$3,'source_document',$4,$5,$6)`,[item.id,owner,contact,source,`synthetic:${item.id}`,{synthetic:true,time_iso:item.occurred}]);
    }
    const identity=await createExtractionPolicyVersion(),policy=identity.newTaskConfig();
    const store=new ExtractionTaskStore(pool,{policyVersion:identity,verificationPolicy:'complete-claim-v1'});
    const taskId=await store.enqueueImport({ownerId:owner,contactId:contact},source,examples.length);
    await client.query("UPDATE background_task_step SET status='succeeded',processed_count=$2,total_count=$2 WHERE task_id=$1 AND step_name IN ('parse','normalize')",[taskId,examples.length]);
    const claim=await store.claim({ownerId:owner,contactId:contact},{taskId,workerId:randomUUID(),leaseMs:20000,supportedSteps:['extract_memory']});
    assert.ok(claim);
    const transaction=async work=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
      catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
    const purposes=[];let pending=[];
    const options={ownerId:owner,transaction,ruleVersion:identity.ruleVersion,policyVersion:identity,
      unconfirmedRequests:async()=>pending,
      model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:4096,temperature:0,reasoningEffort:'off'},
        profile:{context_window_tokens:128000,safety_margin_tokens:512}},
      call:async input=>{
        const name=input.tools[0].name;purposes.push(name);
        let args;
        if(name==='DirectMemoryExtractionOutput')args={scenes:[{scene_name:'虚构机制控制',memories:examples.map(item=>({
          text:item.text,category:item.category??'common_fact',subject:'contact',topic:'other',source_message_ids:[item.id],
          confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,
          speech_act:item.actor==='third_party'?'report':'assertion',assertion_status:item.actor==='third_party'?'reported':'asserted',
          figurative_type:'literal',alternatives:[],interpretation_reason:'仅用于合成机制回归。',event:null,conditions:null,
        }))}]};
        else{
          assert.equal(name,'SourceVerificationOutput');
          const payload=JSON.parse(input.messages[0].content[0].text),facet={verdict:'supported',evidence_indices:[0]};
          args={request_fingerprint:payload.request_fingerprint,results:examples.map((item,candidate_index)=>{
            const part={candidate_span:{start:0,end:[...item.text].length},
              attribution:{...facet,scope_subject:item.failure==='scope'?'self':'contact',actor_kind:item.actor??'contact',resolution:'explicit'},
              arguments_and_relation:{...facet},temporal_and_modality:{...facet}};
            if(['unsupported','uncertain'].includes(item.failure))part.temporal_and_modality.verdict=item.failure;
            if(item.failure==='missing')delete part.arguments_and_relation;
            return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:item.id,quote:item.source}],claim_check:{version:1,parts:[part]}};
          })};
        }
        const blocks=[{type:'tool-call',name,arguments:JSON.stringify(args)}];
        await input.validateOutput(blocks);return {text:'',blocks};
      }};
    const batches=new ExtractionBatchService(options);
    const adoption=new ExtractionAdoptionService({ownerId:owner,taskStore:store,
      adjudicationPort:{async call(){throw new Error('空记忆池无需B模型调用');}},
      embedding:{model:EMBEDDING_MODEL,revision:EMBEDDING_REVISION,embed:async texts=>texts.map(()=>[1,0,0])}});
    let checked=false,staleBResponse;
    const runner=new ExtractionTaskRunner({store,batches,policyVersion:identity,ruleVersion:identity.ruleVersion,
      batchSize:10,contextBefore:0,contextAfter:0,concurrency:1,provider:'synthetic-route',modelName:'synthetic-model',
      adopt:async(input,aResult,signal)=>{
        assert.equal(aResult.accepted.length,2);assert.equal(aResult.rejected_count,4);
        assert.deepEqual(aResult.accepted.map(item=>item.text),examples.slice(0,2).map(item=>item.text));
        assert.ok(aResult.accepted.every(item=>item.verified_source_receipt&&item.dimension_evidence.version===1));
        assert.deepEqual(await batches.run(input,signal),aResult);
        pending=[modelTaskRequestId('extraction',taskId,input.batch_key)];
        await assert.rejects(batches.run(input,signal),/outcome_unknown/);pending=[];
        await client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',
          [taskId,JSON.stringify({...policy,source_stamp:'c'.repeat(64)})]);
        await assert.rejects(batches.run(input,signal),/source_unavailable/);
        try{staleBResponse=await adoption.run({...input,a_result:aResult},signal);}
        catch(error){assert.match(error.code,/source_unavailable/);}
        if(staleBResponse)return staleBResponse;
        assert.equal((await client.query('SELECT count(*)::int n FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows[0].n,0);
        await client.query('UPDATE background_task SET extraction_runtime_config=NULL WHERE id=$1',[taskId]);
        await assert.rejects(batches.run(input,signal),/window_mismatch/);
        await assert.rejects(adoption.run({...input,a_result:aResult},signal),/window_mismatch/);
        await client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1',[taskId,JSON.stringify(policy)]);
        await client.query("UPDATE memory_extraction_trace_event SET payload=jsonb_set(payload,'{task_runtime,source_stamp}',$2::jsonb) WHERE trace_id=$1 AND stage='window'",
          [input.trace_id,JSON.stringify('d'.repeat(64))]);
        await assert.rejects(batches.run(input,signal),/window_mismatch/);
        await assert.rejects(adoption.run({...input,a_result:aResult},signal),/window_mismatch/);
        await client.query("UPDATE memory_extraction_trace_event SET payload=jsonb_set(payload,'{task_runtime,source_stamp}',$2::jsonb) WHERE trace_id=$1 AND stage='window'",
          [input.trace_id,JSON.stringify(identity.sourceStamp)]);
        checked=true;return adoption.run({...input,a_result:aResult},signal);
      }});
    const result=await runner.run(claim,new AbortController().signal);
    assert.equal(result.processedCount,examples.length);
    assert.equal(staleBResponse,undefined,'A后改变task source_stamp时，直接B入口必须拒绝而非完成写入');
    assert.equal(checked,true);
    assert.deepEqual(purposes,['DirectMemoryExtractionOutput','SourceVerificationOutput']);
    const rows=(await client.query('SELECT text_content,adoption_method,event FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 ORDER BY text_content',[owner,contact])).rows;
    assert.deepEqual(rows.map(row=>row.text_content).sort(),examples.slice(0,2).map(item=>item.text).sort());
    assert.ok(rows.every(row=>row.adoption_method==='auto'&&row.event===null));
    assert.equal((await client.query('SELECT count(*)::int n FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows[0].n,2);
    assert.equal((await client.query('SELECT last_message_id FROM memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows[0].last_message_id,examples.at(-1).id);
    const runtime=(await client.query("SELECT payload->'task_runtime' AS runtime FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 AND stage='window'",[owner,contact])).rows[0].runtime;
    assert.equal(runtime.verification_policy,'complete-claim-v1');assert.equal(runtime.source_stamp,identity.sourceStamp);
    assert.equal(runtime.rule_version,identity.resolve(policy).ruleVersion);
    const verifications=(await client.query("SELECT payload->'result' AS result FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 AND stage='verification' ORDER BY position",[owner,contact])).rows;
    assert.equal(verifications.length,6);
    assert.ok(verifications.every(row=>row.result.model_verdict==='supported'&&row.result.verification_mode==='complete-claim-v1'));
  }finally{await pool.end();await fixture.close();}
});
