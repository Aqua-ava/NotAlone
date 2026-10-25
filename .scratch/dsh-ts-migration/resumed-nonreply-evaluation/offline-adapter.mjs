/** 独立合成PG与localhost假provider；复用现有官方profile及生产业务接缝。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rm,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir,tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from '../../../backend-ts/test/host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from '../../../backend-ts/test/reply-service-runtime-support.mjs';
import {ExtractionTaskStore} from '../../../backend-ts/src/extraction-task-store.ts';
import {ExtractionTaskRunner} from '../../../backend-ts/src/extraction-task-runner.ts';
import {ROOT,BASELINE,sha} from './runner.mjs';

const execute=promisify(execFile),backend=join(ROOT,'backend-ts');
const HTTP_TOKEN='synthetic-nonreply-token-00000000-00000000';
const id=value=>{const h=sha(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};

async function seed(f,run,owned){
  const c=f.client,{owner_id:owner,contact_id:contact}=run.scope;
  const binding=id(`${run.case_id}:${run.repeat}:binding`),source=id(`${run.case_id}:${run.repeat}:document`);
  await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成评测本人')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成评测联系人')",[contact,owner]);
  await c.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,$3,'wechat','synthetic-nonreply','synthetic-nonreply','active')",[binding,owner,contact]);
  await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic-frozen.jsonl',$4,1)",[source,owner,contact,run.case_sha256]);
  const messages=[];
  if(run.domain==='memory_extraction'){
    for(const [index,[sender,text]]of run.material.messages.entries()){
      const message=id(`${run.case_id}:${run.repeat}:message:${index}`),occurred=new Date(Date.UTC(2026,8,15,0,index)).toISOString();
      assert.ok(['self','contact'].includes(sender),'frozen_sender_invalid');
      await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,$4,'text',$5,$6)",[message,owner,contact,sender==='self'?'user':'contact',text,occurred]);
      await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,$5,$6)",[message,owner,contact,source,`frozen:${index}`,{time_iso:occurred}]);
      messages.push(message);
    }
  }else{
    for(const s of run.material.input.sources){
      const foreign=s.owner_id!==run.material.input.scope.owner_id||s.contact_id!==run.material.input.scope.contact_id;
      const scopedContact=foreign?id(`${run.case_id}:foreign`):contact;
      if(foreign)await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成外部干扰联系人')ON CONFLICT DO NOTHING",[scopedContact,owner]);
      const sid=id(`${run.case_id}:${run.repeat}:${s.source_id}`);
      await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)VALUES($1,$2,$3,'manual','synthetic-frozen-source',$4,1,$5)",[sid,owner,scopedContact,sha(s.text),s.state==='active'?'active':'deleted']);
      // subject标记资料归属；speaker保持未知，不由subject伪造消息说话人。
      if(run.domain!=='skill_learning'){
        const table=s.subject==='owner'?'owner_memory':'confirmed_memory';
        await c.query(`INSERT INTO ${table}(id,owner_id,${table==='confirmed_memory'?'contact_id,':''}text_content,category,topic,source_ids,adoption_method,status,revision)
          VALUES($1,$2,${table==='confirmed_memory'?'$6,':''}$3,'common_fact','other',$4,'manual',$5,1)`,
        [id(`${sid}:memory`),owner,s.text,[sid],s.state==='active'?'active':'deleted',...(table==='confirmed_memory'?[scopedContact]:[])]);
      }else if(!foreign&&s.state==='active'){
        const session=id(`${sid}:session`),input=id(`${sid}:input`);
        await c.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[session,owner,contact]);
        await c.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)",
          [input,session,owner,contact,binding,{type:'purpose_exploration',correction:s.text}]);
        await c.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
      }
    }
  }
  if(run.domain==='memory_extraction'){
    const pool=await import('../../../backend-ts/node_modules/pg/lib/index.js').then(m=>new m.default.Pool({host:'/tmp',database:c.database,max:3}));
    owned.pool=pool;
    const store=new ExtractionTaskStore(pool);
    const task=await store.enqueueImport({ownerId:owner,contactId:contact},source,messages.length);
    await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)',[task,owner,contact]);
    for(const index of run.material.targets)await c.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[task,messages[index],owner,contact]);
    await c.query("UPDATE background_task_step SET status='succeeded',processed_count=$2,total_count=$2 WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task,messages.length]);
    const claim=await store.claim({ownerId:owner,contactId:contact},{taskId:task,workerId:randomUUID(),leaseMs:120000,supportedSteps:['extract_memory']});
    return {source,messages,claim,store,pool};
  }
  const task=randomUUID(),step=randomUUID(),worker=randomUUID();
  await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,organization_generation)VALUES($1,$2,true,1,'stale',0)ON CONFLICT DO NOTHING",[owner,contact]);
  await c.query("UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale' WHERE owner_id=$1 AND contact_id=$2",[owner,contact]);
  if(run.domain.startsWith('l')&&run.arm==='new'){
    await c.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)",[task,owner,contact]);
    await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
    await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status)VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1:profile-tools-v1','[]','{}','active',1,16,$5,$6)",
      [task,owner,contact,`synthetic:${task}`,run.domain==='l3_profile',run.domain==='l3_profile'?'pending':'not_required']);
  }
  return{source,messages,claim:{taskId:task,stepId:step,stepName:'organize_memory',workerId:worker,leaseGeneration:1,ownerId:owner,contactId:contact,messageCount:0,attemptCount:1,sourceDocumentId:source,taskType:'layered_memory',leaseExpiresAt:new Date(Date.now()+120000)}};
}

function fakeReply(_req,res,requests,events){
  events[0].message.model='deepseek-flash';
  const body=requests.at(-1).body,names=(body.tools??[]).map(t=>t.name??t.function?.name);
  const name=names[0];
  const initial=body.messages?.find(message=>message.role==='user')?.content;
  let payload={};
  try{payload=JSON.parse(typeof initial==='string'?initial:initial?.find(block=>block.type==='text')?.text??'{}');}catch{}
  const selected=payload.memories?.[0];
  if(name==='DirectMemoryExtractionOutput')useTool(events,name,{scenes:[]},'offline-empty-extraction');
  else if(name==='SkillLearningProposal')useTool(events,name,{outcome:'no_change'},'offline-no-change');
  // 逐字回显与固定格式只检验传输／引用／事务；不消费oracle，也不构成语义评分。
  else if(names.includes('write')||names.includes('read')){
    if(body.messages.length===1&&selected){
      if(payload.layer==='l3'){
        const text=selected.text.split(/[，。]/u)[0];
        useTool(events,'write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({
          kind:'preference',section:'long_term_preferences',basis:'合成来源逐字片段的机械回显，仅检验合同。',
          temporal_status:'uncertain',uncertainty:'当前状态按合成来源保留，未额外核实。',
          references:[{memory_id:selected.memory_id,revision:selected.revision}],
        })} -->\n${text}`},'offline-profile-write');
      }else useTool(events,'write',{path:'offline-source.md',content:`<!-- META {"topic_key":"offline-source","title":"合成资料","hint":"仅回显本次来源"} -->\n\n${selected.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:selected.memory_id,revision:selected.revision}])} -->`},'offline-scenario-write');
    }else if(names.includes('ProfileProposalComplete'))useTool(events,'ProfileProposalComplete',{},'offline-profile-complete');
    else events[2].delta.text='{"offline":"complete"}';
  }else if(name==='ScenarioVerificationOutput'||name==='ProfileVerificationOutput'){
    const memories=payload.memories??[];
    const results=name==='ScenarioVerificationOutput'
      ?[{scenario_index:0,paragraph_index:0,supported:true,evidence:memories.slice(0,1).map(m=>({memory_id:m.memory_id,quote:m.verbatim_text??m.text}))}]
      :[{entry_index:0,supported:true,evidence:memories.slice(0,1).map(m=>({memory_id:m.memory_id,quote:m.verbatim_text??m.text}))}];
    useTool(events,name,{results},'offline-reference-verification');
  }
  else{res.writeHead(422);res.end('{"error":"offline_unknown_tool"}');return;}
  sendEvents(res,events);
}

async function audit(f,run,physical,started){
  const c=f.client,scope=[run.scope.owner_id,run.scope.contact_id];
  const scalar=async sql=>(await c.query(sql,scope)).rows[0].n;
  const ledgerEntries=await scalar('SELECT count(*)::int n FROM outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2');
  const jobCalls=await scalar('SELECT COALESCE(sum(model_calls_used),0)::int n FROM layered_memory_job WHERE owner_id=$1 AND contact_id=$2');
  const oldOrganization=run.arm==='old'&&run.domain.startsWith('l');
  return{ledger_entries:ledgerEntries,job_model_calls_used:jobCalls,
    persisted_physical_count:oldOrganization?jobCalls:ledgerEntries,
    physical_accounting_basis:oldOrganization?'frozen_python_job_budget':'outbound_ledger',
    trace_count:await scalar('SELECT count(*)::int n FROM memory_extraction_trace WHERE owner_id=$1 AND contact_id=$2'),
    input_message_count:await scalar('SELECT count(*)::int n FROM message WHERE owner_id=$1 AND contact_id=$2'),
    model_receipts:await scalar('SELECT count(*)::int n FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2'),
    physical_observed:physical,external_connections:0,dsh_profile_started:started,
    request_source:'frozen_synthetic_only',source_persistence:'independent_random_test_database'};
}

async function projection(f,run,output){
  const c=f.client,scope=[run.scope.owner_id,run.scope.contact_id];
  const rows=async table=>(await c.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE owner_id=$1 AND contact_id=$2`,scope)).rows.map(r=>r.value);
  const facts=(await rows('confirmed_memory')).map(row=>({text:row.text_content,category:row.category,
    subject:'contact',status:row.status,adoption_method:row.adoption_method,source_ids:row.source_ids}));
  const candidates=(await rows('memory_candidate')).map(row=>({text:row.text_content,category:row.category,
    subject:row.subject??row.fact_subject??null,status:row.status,source_ids:row.source_ids}));
  const drafts=(await rows('skill_draft')).map(row=>({strategy:row.strategy,proposal_kind:row.proposal_kind,status:row.status??null}));
  const state=output?.state??{};
  const references=values=>(values??[]).map(r=>({memory_id:r.memory_id,revision:r.revision}));
  const scenarios=(state.scenarios??[]).map(s=>({title:s.title,hint:s.hint,
    paragraphs:(s.paragraphs??[]).map(p=>({text:p.text,references:references(p.references)}))}));
  const profile=(state.profile?.entries??[]).map(e=>({text:e.text,kind:e.kind,section:e.section,basis:e.basis,
    temporal_status:e.temporal_status,uncertainty:e.uncertainty,references:references(e.references)}));
  return {facts,candidate_facts:candidates,scenarios,profile_entries:profile,
    skill_drafts:drafts,projection_kind:'persisted_business_projection',
    semantic_review_coverage:'提取与核验trace的中性规范化尚未补齐；不能只据持久资料签完整提取质量。'};
}

export async function createOfflineAdapter({plan,directory}){
  assert.equal(plan.old_commit,BASELINE);
  const pin=(await execute('git',['rev-parse','--verify',`${plan.new_commit}^{commit}`],{cwd:ROOT})).stdout.trim();
  const sourcePaths=(await execute('git',['ls-files','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],{cwd:ROOT})).stdout.trim().split('\n');
  const ownFiles=['runner.mjs','material-export.py','offline-adapter.mjs','old-arm.py','blind.mjs','retrieval.mjs'];
  const sourceDigest=async()=>sha(await Promise.all(sourcePaths.map(async path=>[path,sha(await readFile(join(ROOT,path),'utf8'))])));
  const runnerDigest=async()=>sha(await Promise.all(ownFiles.map(async path=>[path,sha(await readFile(new URL(path,import.meta.url),'utf8'))])));
  const initialSource=await sourceDigest(),initialRunner=await runnerDigest();
  const verify=async()=>{
    await execute('git',['diff','--quiet',pin,'--','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],{cwd:ROOT});
    assert.equal(await sourceDigest(),initialSource,'candidate_sources_changed');
    assert.equal(await runnerDigest(),initialRunner,'evaluation_runner_changed');
  };
  await verify();
  const dsh=JSON.parse(await readFile(join(backend,'node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
  assert.equal(dsh.version,'0.2.1-rc.2','dsh_version_changed');
  const lockHash=sha(await readFile(join(backend,'pnpm-lock.yaml'),'utf8'));
  const originalCwd=process.cwd();
  process.chdir(backend);
  const frozen=await mkdtemp(join(tmpdir(),'notalone-nonreply-old-'));
  await execute('git',['archive','--format=tar','--output='+join(frozen,'source.tar'),BASELINE,'backend/src/notalone'],{cwd:ROOT});
  await execute('tar',['-xf',join(frozen,'source.tar'),'-C',frozen]);
  let busy=false,closed=false;
  return{async execute(run){
    assert.ok(!busy&&!closed,'offline_adapter_not_serial');busy=true;
    await verify();
    if(run.material.input?.events?.length||run.domain==='skill_learning'&&run.material.coverage?.kind==='wrong_subject'){
      busy=false;
      return {terminal_status:'unknown',provider_kind:'loopback_fake',physical_calls:0,
        unknown_reason:run.material.input?.events?.length?'frozen_event_injection_not_implemented':'learning_speaker_provenance_adapter_not_verified',
        deterministic_checks:[{id:'frozen_adapter_coverage',status:'unknown'}]};
    }
    const f=await createStorageFixture(),cleanups=[],owned={};
    let fixtureClosed=false,host,prepared,physical=0;
    const closeFixture=async()=>{if(!fixtureClosed){fixtureClosed=true;await f.close();}};
    const t={after:callback=>cleanups.push(callback)};
    try{
      prepared=await seed(f,run,owned);
      if(run.arm==='old'){
        const oldRequests=[];
        const {createServer}=await import('node:http'),{once}=await import('node:events');
        const provider=createServer(async(req,res)=>{
          let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);physical++;
          oldRequests.push({path:req.url,body});
          const toolName=body.tools?.[0]?.function?.name;
          const name=['DirectMemoryExtractionOutput','SkillLearningProposal'].includes(toolName)?toolName:null;
          const args=name==='SkillLearningProposal'?{outcome:'no_change'}:{scenes:[]};
          let payload={};try{payload=JSON.parse(body.messages.find(m=>m.role==='user')?.content??'{}');}catch{}
          const noChange=payload.no_change_target?{sha256:payload.no_change_target,supported:true,reasons:[]}:null;
          res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-only',object:'chat.completion',model:'deepseek-flash',choices:[{index:0,finish_reason:name?'tool_calls':'stop',message:{role:'assistant',content:name?null:JSON.stringify(noChange??(body.messages?.[0]?.content?.includes('长期')?{entries:[]}:{scenarios:[]})),...(name?{tool_calls:[{id:'offline-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{})}}],usage:{prompt_tokens:12,completion_tokens:9}}));
        });
        provider.listen(0,'127.0.0.1');await once(provider,'listening');
        const file=join(frozen,`old-input-${sha(run.run_id).slice(0,12)}.json`);
        await writeFile(file,JSON.stringify({run,prepared:{source:prepared.source,claim:prepared.claim,messages:prepared.messages},
          database:f.client.database,provider:`http://127.0.0.1:${provider.address().port}/v1`,frozen_source:join(frozen,'backend/src')}),{mode:0o600});
        let result;
        try{const out=await execute(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[fileURLToPath(new URL('./old-arm.py',import.meta.url)),file],{
          cwd:ROOT,timeout:60000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,HOME:f.directory,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'}});result=JSON.parse(out.stdout);}
        catch(error){
          const raw=String(error.stderr??error.message),privateLogs=join(homedir(),'.codex/private-diagnostics/dsh-nonreply-20261025');
          await mkdir(privateLogs,{recursive:true,mode:0o700});
          await writeFile(join(privateLogs,`old-error-${sha(run.run_id).slice(0,12)}-${randomUUID()}.txt`),raw,{mode:0o600,flag:'wx'});
          result={terminal_status:'failed',error_code:'old_arm_failed',unknown_reason:'old_arm_exception_preserved_privately',error_sha256:sha(raw)};
        }
        finally{provider.closeAllConnections();await new Promise(done=>provider.close(done));await rm(file,{force:true});}
        const observed=await audit(f,run,physical,false);
        const businessOutput=await projection(f,run,result.output);
        return{...result,provider_kind:'loopback_fake',physical_calls:physical,audit:observed,
          lock_hash:null,config_hash:sha(oldRequests.map(r=>r.body)),
          business_output:businessOutput,projection_status:'captured',
          deterministic_checks:[{id:'durable_physical_count_matches_observation',status:observed.persisted_physical_count===physical?'passed':'failed'}],
          provenance:{source_commit:BASELINE,candidate_commit:pin,material_sha256:run.case_sha256,provider:'loopback_fake',
            runner_sha256:initialRunner,candidate_sources_sha256:initialSource},
          requests:oldRequests.map(r=>({path:r.path,request_sha256:sha(r.body)})),
          unknown_reason:result.unknown_reason??'fake_model_semantics_not_reviewed',
          adaptation_unknowns:run.domain==='memory_extraction'?['extraction_and_verification_blind_trace_normalization_pending']:
            ['raw_source_to_manual_memory_or_discussion_mapping_requires_independent_review','existing_projection_and_skill_version_binding_not_yet_verified','as_of_not_injected']};
      }
      host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:run.scope.owner_id,
        replyToken:HTTP_TOKEN,close:closeFixture},fakeReply,
        {pluginPath:'test/host-reply-runtime-plugin.ts',environment:{NOTALONE_SYNTHETIC_L2:'1',NOTALONE_SYNTHETIC_EXTRACTION:'1'}});
      const http=async(path,body)=>{
        const response=await fetch(host.url+path,{method:'POST',headers:{Authorization:`Bearer ${HTTP_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
        const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error??'business_http_failed'),{code:value.error});return value;
      };
      let output;
      if(run.domain==='memory_extraction'){
        const adopted=new Map();
        const frozenStore={targets:async claim=>({...await prepared.store.targets(claim),contextIds:prepared.messages}),
          fenced:(...args)=>prepared.store.fenced(...args),check:(...args)=>prepared.store.check(...args)};
        const runner=new ExtractionTaskRunner({store:frozenStore,batches:{async run(input){const value=await http('/internal/extraction/run-b',input);adopted.set(input.trace_id,value.adoption);return value.outcome;}},
          async adopt(input){const value=adopted.get(input.trace_id);assert.ok(value,'finalized_adoption_missing');return{watermark:value.watermark};},
          provider:'deepseek',modelName:'deepseek-flash',concurrency:1,batchSize:prepared.messages.length,
          contextBefore:prepared.messages.length,contextAfter:prepared.messages.length});
        output=await runner.run(prepared.claim,new AbortController().signal);
      }else if(run.domain.startsWith('l')){
        const c=prepared.claim;
        output=await http('/internal/layered-memory/run',{scope:run.scope,claim:{task_id:c.taskId,step_id:c.stepId,step_name:'organize_memory',worker_id:c.workerId,lease_generation:1}});
      }else{
        // 复用正式授权入口和唯一Worker，不另建能绕过草稿事务的模型调用路径。
        output=await http(`/api/contacts/${run.scope.contact_id}/skill-learning`,{enabled:true,confirmed:true,operation_key:randomUUID(),expected_revision:0});
        let terminal;
        for(let attempt=0;attempt<50;attempt++){
          terminal=(await f.client.query("SELECT status FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning' ORDER BY created_at DESC LIMIT 1",[run.scope.owner_id,run.scope.contact_id])).rows[0];
          if(!terminal||['succeeded','failed','cancelled'].includes(terminal.status))break;
          await new Promise(done=>setTimeout(done,100));
        }
        assert.ok(!terminal||['succeeded','failed','cancelled'].includes(terminal.status),'learning_task_timeout');
        output={configuration:output,task:terminal??null};
      }
      physical=host.requests.length;
      const observed=await audit(f,run,physical,true);
      await verify();
      const terminalStatus=output?.task?.status==='cancelled'?'cancelled':output?.state?.error_code||output?.task?.status==='failed'?'failed':'succeeded';
      return{terminal_status:terminalStatus,provider_kind:'loopback_fake',physical_calls:physical,output,audit:observed,
        lock_hash:lockHash,config_hash:sha(host.requests.map(r=>r.body)),
        business_output:await projection(f,run,output),projection_status:'captured',
        deterministic_checks:[{id:'durable_physical_count_matches_observation',status:observed.persisted_physical_count===physical?'passed':'failed'}],
        provenance:{source_commit:pin,material_sha256:run.case_sha256,runner_sha256:initialRunner,
          candidate_sources_sha256:initialSource,
          profile_template_sha256:sha(await readFile(join(backend,'profile/cordis.patch.yml'),'utf8')),
          profile_sha256:sha(await readFile(join(host.home,'profiles/notalone/cordis.patch.yml'),'utf8')),
          requests:host.requests.map(r=>({path:r.path,request_sha256:sha(r.body)}))},
        unknown_reason:'fake_model_semantics_not_reviewed',
        adaptation_unknowns:run.domain==='memory_extraction'?['extraction_and_verification_blind_trace_normalization_pending']:
          ['raw_source_to_manual_memory_or_discussion_mapping_requires_independent_review','existing_projection_and_skill_version_binding_not_yet_verified','as_of_not_injected']};
    }catch(error){
      const raw=JSON.stringify({error:String(error.stack??error.message),host_output:host?.output,
        requests:host?.requests,
        profile_batches:await f.client.query('SELECT to_jsonb(b) AS batch FROM layered_profile_batch b WHERE owner_id=$1 AND contact_id=$2',[run.scope.owner_id,run.scope.contact_id]).then(r=>r.rows).catch(()=>null)},null,2),privateLogs=join(homedir(),'.codex/private-diagnostics/dsh-nonreply-20261025');
      await mkdir(privateLogs,{recursive:true,mode:0o700});
      await writeFile(join(privateLogs,`adapter-error-${sha(run.run_id).slice(0,12)}-${randomUUID()}.txt`),raw,{mode:0o600,flag:'wx'});
      return{terminal_status:'failed',provider_kind:'loopback_fake',physical_calls:host?.requests.length??physical,
        error_code:error.code??'offline_business_adapter_failed',unknown_reason:'business_failure_preserved',
        error_sha256:sha(raw),
        audit:await audit(f,run,host?.requests.length??physical,Boolean(host)).catch(()=>null)};
    }finally{
      if(host)await host.stop();
      await owned.pool?.end();
      for(const cleanup of cleanups.reverse())await cleanup();
      await closeFixture();busy=false;
    }
  },async close(){closed=true;await rm(frozen,{recursive:true,force:true});process.chdir(originalCwd);}};
}
