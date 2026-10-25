import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {startModelHost} from '../src/model-host.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';

const execute=promisify(execFile);
test('官方profile→私有HTTP→原Python B：A未知恢复不重发、保留TS供应商、唯一账本和真实水位',{timeout:30000},async t=>{
 const db=await createExtractionFixture(),c=db.client,directory=await mkdtemp(join(tmpdir(),'na-extraction-production-'));
 let host,child,childExit,provider,requests=0;const purposes=[],accountingFailures=[];
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');if(childExit)await childExit;await host?.shutdown();if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}await db.close();await rm(directory,{recursive:true,force:true});});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
 const text='我喜欢绿茶。';
 await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成')",[owner]);
 await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成')",[contact,owner]);
 await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,'2026-01-01T00:00:00.123456Z')",[message,owner,contact,text]);
 await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-01-01T08:00:00.123456+08:00'}]);
 await c.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,$4,'import','running','extract_memory',1)",[task,owner,contact,source]);
 await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 const dsn=(await readFile(db.envFilePath,'utf8')).match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
 const transaction=async work=>{await c.query('BEGIN');try{const v=await work(c);await c.query('COMMIT');return v;}catch(error){await c.query('ROLLBACK');throw error;}};
 const accounting=createHostModelAccounting({transaction,provider:'deepseek',typescriptProvider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>host?.unconfirmedPermitIds()??[]});
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting:{...accounting,reserve:async(...args)=>{try{return await accounting.reserve(...args);}catch(error){accountingFailures.push(error.code??error.message);throw error;}}}});
 provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;requests++;const input=JSON.parse(raw);
  const strict=req.url==='/beta/chat/completions',name=input.tools[0]?.function?.name??input.tools[0]?.name;purposes.push(name);
  const args=name==='DirectMemoryExtractionOutput'?{scenes:[{scene_name:'饮食偏好',memories:[{text,category:'preference',subject:'contact',topic:'other',source_message_ids:[message],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话明确表达偏好'}]}]}:
   {results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:text}]}]};
  if(strict){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-strict',object:'chat.completion',
   choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
    {id:'synthetic-strict-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],
   usage:{prompt_tokens:5,completion_tokens:2,prompt_cache_hit_tokens:1,prompt_cache_miss_tokens:4}}));return;}
  const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 const plugin=join(directory,'production-plugin.mjs'),src=resolve('src'),dep=resolve('node_modules/pg/lib/index.js');
 await writeFile(plugin,`
import {createServer} from 'node:http';
import pg from ${JSON.stringify(dep)};
import {resolveAdapterOptions} from ${JSON.stringify(resolve('node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'))};
import {installModelProvider} from ${JSON.stringify(join(src,'model-provider.ts'))};
import {createExtractionModelCaller,extractionUnconfirmedRequests} from ${JSON.stringify(join(src,'extraction-model.ts'))};
import {ExtractionBatchService} from ${JSON.stringify(join(src,'extraction-batch-service.ts'))};
import {createExtractionBatchHttp} from ${JSON.stringify(join(src,'extraction-batch-http.ts'))};
export const name='extraction-production-synthetic';export const inject=['llm','appReady'];
export function apply(ctx){
 const provider=installModelProvider(ctx,{provider:'synthetic-route',strictVerificationEndpoint:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL.replace(/\\/anthropic$/,'')+'/beta/chat/completions',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});
 const permit={path:process.env.NOTALONE_MODEL_PERMIT_SOCKET,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN};
 const caller=createExtractionModelCaller({ctx,provider,permit}),pool=new pg.Pool({host:'/tmp',database:process.env.NOTALONE_SYNTHETIC_DSN.match(/dbname=([^ ]+)/)[1],user:process.env.NOTALONE_SYNTHETIC_PG_USER,max:4});
 const transaction=async work=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
 const service=new ExtractionBatchService({ownerId:process.env.NOTALONE_SYNTHETIC_OWNER,transaction,ruleVersion:process.env.NOTALONE_SYNTHETIC_RULE,
  model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},profile:{context_window_tokens:128000,safety_margin_tokens:512}},
  call:async input=>{try{return await caller.call({...input,costForUsage:()=>({status:'known',amount:'0.0001',currency:'CNY',pricing_version:'synthetic-v1'})});}catch(error){process.stderr.write('MODEL_FAILURE '+error.code+' '+error.cause?.message+' receipt='+JSON.stringify(error.receipt)+'\\n');throw error;}},unconfirmedRequests:scope=>extractionUnconfirmedRequests(permit,scope)});
 const http=createExtractionBatchHttp({token:'synthetic-private-token-00000000000000',execute:async(input,signal)=>{try{return await service.run(input,signal);}catch(error){process.stderr.write('A_FAILURE '+(error.code??error.name)+' '+error.message+' '+error.stack+'\\n');throw error;}}});
 const server=createServer((req,res)=>{void http.handle(req,res);});
 const ready=ctx.appReady.onReady(()=>server.listen(0,'127.0.0.1',()=>process.stdout.write('EXTRACTION_PRODUCTION_READY http://127.0.0.1:'+server.address().port+'\\n')));
 ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise(done=>server.close(done));await provider.dispose();await pool.end();});
}
`);
 await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(plugin)}\n`);
 const rule=createHash('sha256');for(const file of ['extraction-protocol.ts','extraction-protocol-calendar.ts','extraction-protocol-contract.ts','extraction-flow.ts','extraction-evidence.ts','extraction-arguments.ts','extraction-verification-diagnostics.ts','deepseek-strict-verification.ts','extraction-prompts.ts'])rule.update(await readFile(join(src,file)));
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',...host.pythonEnvironment,NOTALONE_SYNTHETIC_DSN:dsn,NOTALONE_SYNTHETIC_PG_USER:c.connectionParameters.user,NOTALONE_SYNTHETIC_OWNER:owner,NOTALONE_SYNTHETIC_RULE:rule.digest('hex'),NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},stdio:['ignore','pipe','pipe']});childExit=once(child,'exit');let log='';child.stderr.on('data',chunk=>log+=chunk);
 const url=await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error(log.slice(-1200))),10000);child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/EXTRACTION_PRODUCTION_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);done(match[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1200)));});});
 const runPython=async mode=>{try{return JSON.parse((await execute(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,[resolve('../backend/tests/support/extraction_production_a.py'),mode,dsn,owner,contact,source,JSON.stringify(claim),url],{env:{...process.env,...host.pythonEnvironment,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:resolve('../backend/src')},timeout:20000,maxBuffer:1024*1024})).stdout);}catch(error){throw new Error((error.stderr??'').slice(-1600)+'\n'+log.split('\n').filter(line=>/^(MODEL_FAILURE|A_FAILURE)/.test(line)).join('\n')+'\nrequests='+requests);}};
 const lost=await runPython('lost');assert.equal(lost.extracted,1,log.split('\n').filter(line=>/^(MODEL_FAILURE|A_FAILURE)/.test(line)).join('\n')+'\naccounting='+accountingFailures);assert.equal(lost.watermark,null);assert.equal(requests,2);
 const first=await runPython('run');assert.equal(first.stats.processed_messages,1);assert.equal(first.stats.extracted,1);assert.equal(first.stats.adopted,1);assert.equal(first.watermark,message);assert.equal(requests,2,'A回包未消费后的新trace必须复用同一A执行');
 assert.deepEqual(purposes,['DirectMemoryExtractionOutput','SourceVerificationOutput']);
 assert.deepEqual((await c.query(`SELECT payload->>'transport' transport,jsonb_typeof(payload->'wire_schema') wire_schema
  FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2
  AND stage='model_request' AND payload->>'purpose'='verification'`,[owner,contact])).rows,
  [{transport:'deepseek-strict-chat-completions-beta',wire_schema:'object'}]);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,2);
 assert.deepEqual((await c.query('SELECT DISTINCT provider FROM model_call_receipt')).rows.map(row=>row.provider),['synthetic-route']);
 assert.equal((await c.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,2,'原Python E不能重复记账');
 assert.equal((await c.query('SELECT count(*)::int n FROM memory_candidate')).rows[0].n,1);
 assert.equal((await c.query("SELECT count(*)::int n FROM confirmed_memory WHERE adoption_method='auto'")).rows[0].n,1);
 assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE stage='batch_end' AND payload?'typescript_a_receipt'")).rows[0].n,1);
 const second=await runPython('run');assert.equal(second.stats.processed_messages,0);assert.equal(second.watermark,message);assert.equal(requests,2);
});
