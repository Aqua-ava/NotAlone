import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {startModelHost} from '../src/model-host.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {runExtractionWithAdoption} from '../src/extraction-adoption-host.ts';

test('A失败不调用B，A成功零候选仍要求一次finalized回执',async()=>{
 const input={owner_id:randomUUID(),contact_id:randomUUID(),trace_id:randomUUID(),
  batch_key:'a'.repeat(64),claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'extract_memory',
   worker_id:randomUUID(),lease_generation:1}};
 const failed={accepted:[],rejected_count:0,extraction_completed:false,failure_kind:'unavailable',
  failure_reason:'合成失败',model_accounting_owner:'typescript',model_call_ids:[],a_execution_id:randomUUID(),
  a_input_sha256:'b'.repeat(64),a_rule_version:'c'.repeat(64),candidate_trace_ids:[]};
 let adoptionCalls=0;
 const failedResult=await runExtractionWithAdoption({run:async()=>failed},
  {run:async()=>{adoptionCalls++;throw new Error('must_not_run');}},input,new AbortController().signal);
 assert.equal(failedResult.adoption,null);assert.equal(adoptionCalls,0);
 const successful={...failed,extraction_completed:true,failure_kind:null,failure_reason:null};
 const receipt={trace_id:input.trace_id,b_execution_id:randomUUID(),stats:{adopted:0,updated:0,merged:0,
  pending:0,skipped_duplicate:0,skipped_deleted:0,skipped_noop:0,failed:0,results:[],usages:[]},receipt:null,watermark:null,cached:false};
 const successfulResult=await runExtractionWithAdoption({run:async()=>successful},
  {run:async()=>{adoptionCalls++;return receipt;}},input,new AbortController().signal);
 assert.equal(successfulResult.adoption,receipt);assert.equal(adoptionCalls,1);
});

test('官方DSH ModelHost 三类B调用逐次记账、trace回执与唯一最终提交',{timeout:30000},async t=>{
 const db=await createExtractionFixture(),c=db.client;
 const directory=await mkdtemp(join(tmpdir(),'na-adoption-host-'));
 let host,child,childExit,provider;
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  if(childExit)await childExit;
  await host?.shutdown();
  if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}
  await db.close();
  await rm(directory,{recursive:true,force:true});
 });
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID();
 const target=randomUUID(),targetText='联系人喜欢周三跑步，也喜欢周四游泳';
 const task=randomUUID(),step=randomUUID(),worker=randomUUID();
 await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-adoption-host.jsonl',$4,1)`,[source,owner,contact,'a'.repeat(64)]);
 async function addMessage(id,text,time){
  await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,$5)",
   [id,owner,contact,text,time]);
  await c.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
   VALUES($1,$2,$3,'source_document',$4,$5,$6)`,[id,owner,contact,source,`synthetic:${id}`,{text,time_iso:time}]);
 }
 const parentMessages=[randomUUID(),randomUUID()],parentTexts=['联系人喜欢周三跑步','联系人喜欢周四游泳'];
 const parentMemories=[randomUUID(),randomUUID()];
 for(let index=0;index<2;index++){
  await addMessage(parentMessages[index],parentTexts[index],`2026-01-0${index+1}T00:00:00.123456Z`);
  await c.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
   VALUES($1,$2,$3,$4,'preference','health',$5,'auto','active',1)`,
  [parentMemories[index],owner,contact,parentTexts[index],[parentMessages[index]]]);
 }
 await addMessage(target,targetText,'2026-01-03T00:00:00.123456Z');
 await c.query(`INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
  VALUES($1,$2,$3,$4,'import','running','extract_memory',1)`,[task,owner,contact,source]);
 await c.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
  VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')`,[step,task,worker]);
 await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)',[task,owner,contact]);
 await c.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[task,target,owner,contact]);
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 const dsn=(await readFile(db.envFilePath,'utf8')).match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
 const python=`import sys,json
from uuid import UUID,uuid4
from notalone.scopes import ContactScope
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import _plan_batch
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
scope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]));ids={UUID(sys.argv[4])};claim=json.loads(sys.argv[5])
messages=[m for m in load_contact_messages(scope,sys.argv[1]) if m.message_id in ids]
plan=_plan_batch(batch=messages,messages=messages,message_positions={m.message_id:i for i,m in enumerate(messages)},scope=scope,context_before=0,context_after=0,batch_size=1,provider='deepseek',model_name='synthetic-model',task_metadata={'task_runtime':claim},selection_receipts=(),previous_watermark=None)
trace=PostgresExtractionTraceStore(sys.argv[1]).begin(scope,run_id=uuid4(),batch_key=plan.batch_key,payload=plan.window_payload)
print(json.dumps({'trace_id':str(trace),'batch_key':plan.batch_key}))`;
 const seedTrace=()=>JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',python,dsn,owner,contact,target,JSON.stringify(claim)],{
  env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:resolve('../backend/src')},encoding:'utf8'}));
 const seeded=seedTrace();
 const input={owner_id:owner,contact_id:contact,...seeded,claim};
 const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}};
 let accounting;
 accounting=createHostModelAccounting({transaction,provider:'deepseek',typescriptProvider:'synthetic-route',model:'synthetic-model',
  unconfirmedPermitIds:()=>host?.unconfirmedPermitIds()??[]});
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,
  infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting});
 const requests=[];
 provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=JSON.parse(raw),strict=req.url==='/beta/chat/completions',
   name=body.tools[0]?.function?.name??body.tools[0]?.name;requests.push(name);
  const evidence=[{message_id:parentMessages[0],quote:parentTexts[0]},
   {message_id:parentMessages[1],quote:parentTexts[1]},{message_id:target,quote:targetText}];
  let args;
  if(name==='DirectMemoryExtractionOutput')args={scenes:[{scene_name:'运动偏好',memories:[{text:targetText,category:'preference',
   subject:'contact',topic:'health',source_message_ids:[target],confidence:0.92,risk_flags:[],valid_at:null,invalid_at:null,
   speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成原话直接支持'}]}]};
  else if(name==='SourceVerificationOutput')args={results:[{candidate_index:0,verdict:'supported',issues:[],
   evidence:[{message_id:target,quote:targetText}]}]};
  else if(name==='BatchMemoryAdjudicationOutput')args={decisions:[{candidate_index:0,action:'merge',
   replaced_memory_id:null,merged_memory_ids:parentMemories,merged_text:targetText,duplicate_memory_id:null,
   relation:{kind:'supplement',related_memory_ids:parentMemories,explanation:'两项运动偏好可合并',evidence,
    claim_changed:false,condition_changed:false}}]};
  else if(name==='BatchMemoryRelationVerificationOutput')args={results:[{candidate_index:0,supported:true,
   evidence,claim_changed:false,condition_changed:false}]};
  else if(name==='MergedMemoryVerificationOutput')args={supported:true,text:targetText,evidence};
  else throw new Error(`unexpected_tool:${name}`);
  if(strict){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-strict',object:'chat.completion',
   choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
    {id:'synthetic-strict-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],
   usage:{prompt_tokens:8,completion_tokens:3,prompt_cache_hit_tokens:2,prompt_cache_miss_tokens:6}}));return;}
  const events=[
   {type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:8,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:3}},
   {type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');
  res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 const plugin=join(directory,'adoption-plugin.mjs'),src=resolve('src'),dep=resolve('node_modules/pg/lib/index.js');
 await writeFile(plugin,`
import {createServer} from 'node:http';
import pg from ${JSON.stringify(dep)};
import {resolveAdapterOptions} from ${JSON.stringify(resolve('node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'))};
import {installModelProvider} from ${JSON.stringify(join(src,'model-provider.ts'))};
import {createExtractionModelCaller,extractionUnconfirmedRequests} from ${JSON.stringify(join(src,'extraction-model.ts'))};
import {ExtractionBatchService} from ${JSON.stringify(join(src,'extraction-batch-service.ts'))};
import {ExtractionTaskStore} from ${JSON.stringify(join(src,'extraction-task-store.ts'))};
import {createExtractionAdoptionHost} from ${JSON.stringify(join(src,'extraction-adoption-host.ts'))};
import {createExtractionBatchHttp} from ${JSON.stringify(join(src,'extraction-batch-http.ts'))};
export const name='extraction-adoption-synthetic';export const inject=['llm','appReady'];
export function apply(ctx){
 const provider=installModelProvider(ctx,{provider:'synthetic-route',strictVerificationEndpoint:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL.replace(/\\/anthropic$/,'')+'/beta/chat/completions',connection:resolveAdapterOptions({
  baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL,thinking:'disabled',maxTokens:512,
  retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});
 const permit={path:process.env.NOTALONE_MODEL_PERMIT_SOCKET,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN};
 const caller=createExtractionModelCaller({ctx,provider,permit});
 const pool=new pg.Pool({host:'/tmp',database:process.env.NOTALONE_SYNTHETIC_DB,user:process.env.NOTALONE_SYNTHETIC_PG_USER,max:4});
 const transaction=async work=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
 const store=new ExtractionTaskStore(pool),binding={provider:'synthetic-route',model:'synthetic-model',
  maxTokens:512,temperature:0,reasoningEffort:'off'},profile={context_window_tokens:128000,safety_margin_tokens:512};
 const call=async input=>{try{return await caller.call({...input,costForUsage:()=>({status:'known',amount:'0.0001',currency:'CNY',pricing_version:'synthetic-v1'})});}
  catch(error){process.stderr.write('MODEL_FAILURE '+(error.code??error.name)+' '+error.message+' '+(error.cause?.message??'')+'\\n');throw error;}};
 const batches=new ExtractionBatchService({ownerId:process.env.NOTALONE_SYNTHETIC_OWNER,transaction,ruleVersion:'b'.repeat(64),
  model:{binding,profile},call,unconfirmedRequests:scope=>extractionUnconfirmedRequests(permit,scope)});
 const adoption=createExtractionAdoptionHost({ownerId:process.env.NOTALONE_SYNTHETIC_OWNER,taskStore:store,transaction,call,
  binding,profile,embeddingFactory:async()=>({embed:async texts=>texts.map((_,index)=>[1,index+1,0]),
   close:async()=>{}})});
 const http=createExtractionBatchHttp({token:'synthetic-private-token-00000000000000',
  execute:(input,signal)=>batches.run(input,signal),
  executeWithAdoption:async(input,signal)=>{
   try{
    const outcome=await batches.run(input,signal);
    if(!outcome.extraction_completed||outcome.failure_reason!==null)return {outcome,adoption:null};
    return {outcome,adoption:await adoption.run(input,outcome,signal)};
   }catch(error){process.stderr.write('ADOPTION_FAILURE '+(error.code??error.name)+' '+error.message+'\\n'+String(error.stack)+'\\n');throw error;}
  }});
 const server=createServer((req,res)=>{void http.handle(req,res);});
 const ready=ctx.appReady.onReady(()=>server.listen(0,'127.0.0.1',()=>process.stdout.write(
  'ADOPTION_HOST_READY http://127.0.0.1:'+server.address().port+'\\n')));
 ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise(done=>server.close(done));
  await adoption.close();await pool.end();await provider.dispose();});
}
`);
 await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(plugin)}\n`);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
   ...host.pythonEnvironment,NOTALONE_SYNTHETIC_DB:dsn.match(/dbname=([^ ]+)/)[1],
   NOTALONE_SYNTHETIC_PG_USER:c.connectionParameters.user,
   NOTALONE_SYNTHETIC_OWNER:owner,NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},
  stdio:['ignore','pipe','pipe']});
 childExit=once(child,'exit');let log='';child.stderr.on('data',chunk=>log+=chunk);
 const url=await new Promise((done,reject)=>{
  const timer=setTimeout(()=>reject(new Error(log.slice(-1600))),10000);
  child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/ADOPTION_HOST_READY (http:\/\/127\.0\.0\.1:\d+)/);
   if(match){clearTimeout(timer);done(match[1]);}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1600)));});
 });
 const response=await fetch(`${url}/internal/extraction/run-b`,{method:'POST',
  headers:{authorization:'Bearer synthetic-private-token-00000000000000','content-type':'application/json'},
  body:JSON.stringify(input)});
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body)+'\n'+log.slice(-1600));
 assert.ok(body.adoption,JSON.stringify(body)+'\n'+log.slice(-1600));
 assert.equal(body.adoption.stats.merged,1);
 assert.equal(body.adoption.watermark,target);
 assert.deepEqual(requests,['DirectMemoryExtractionOutput','SourceVerificationOutput',
  'BatchMemoryAdjudicationOutput','BatchMemoryRelationVerificationOutput','MergedMemoryVerificationOutput']);
 assert.deepEqual((await c.query(`SELECT purpose,count(*)::int n FROM memory_extraction_trace_call
  WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 GROUP BY purpose ORDER BY purpose`,[seeded.trace_id,owner,contact])).rows,
  [{purpose:'adjudication',n:1},{purpose:'extraction',n:1},{purpose:'merge_verification',n:1},
   {purpose:'relation_verification',n:1},{purpose:'verification',n:1}]);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,5);
 const requestCounts=(await c.query(`SELECT request_id,count(*)::int n FROM model_call_receipt
  GROUP BY request_id ORDER BY n DESC`)).rows;
 assert.equal(requestCounts.length,4);
 assert.equal(requestCounts[0].n,2,'A提取与来源核验共享原batch身份，但仍是两次物理回执');
 assert.equal(new Set(requestCounts.slice(1).map(row=>row.request_id)).size,3,'三类B调用必须是独立request身份');
 assert.deepEqual((await c.query('SELECT DISTINCT provider FROM model_call_receipt')).rows.map(row=>row.provider),['synthetic-route']);
 assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='batch_end'",
  [seeded.trace_id])).rows[0].n,1);
 assert.equal((await c.query('SELECT status FROM memory_extraction_trace WHERE trace_id=$1',[seeded.trace_id])).rows[0].status,'succeeded');
 assert.equal((await c.query("SELECT count(*)::int n FROM confirmed_memory WHERE status='active' AND merge_parent_ids<>'{}'")).rows[0].n,1);
 assert.equal((await c.query('SELECT last_message_id FROM memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2',
  [owner,contact])).rows[0].last_message_id,target);
 const recoveredTrace=seedTrace();
 const recoveredResponse=await fetch(`${url}/internal/extraction/run-b`,{method:'POST',
  headers:{authorization:'Bearer synthetic-private-token-00000000000000','content-type':'application/json'},
  body:JSON.stringify({...input,...recoveredTrace})});
 const recovered=await recoveredResponse.json();
 assert.equal(recoveredResponse.status,200,JSON.stringify(recovered));
 assert.equal(recovered.adoption.cached,true);
 assert.equal(recovered.adoption.trace_id,recoveredTrace.trace_id);
 assert.equal(requests.length,5,'已finalized B跨新trace只读恢复，不重发任何模型');
 const verifyScript=`import json,sys
from uuid import UUID
from notalone.scopes import ContactScope
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
PostgresExtractionTraceStore(sys.argv[1]).verify_typescript_b_finalization(
    ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),UUID(sys.argv[4]),
    json.loads(sys.argv[5]),task_id=UUID(sys.argv[6]),batch_key=sys.argv[7])
print('verified')`;
 assert.equal(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,
  ['-c',verifyScript,dsn,owner,contact,recoveredTrace.trace_id,JSON.stringify(recovered.adoption),
   task,recoveredTrace.batch_key],
  {env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:resolve('../backend/src')},encoding:'utf8'}).trim(),'verified');
 assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_b_recovered'",
  [recoveredTrace.trace_id])).rows[0].n,1);
 assert.equal(host.arbiter.snapshot().backgroundActive,0);
});
