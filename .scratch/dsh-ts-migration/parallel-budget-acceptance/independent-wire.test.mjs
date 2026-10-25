/** 独立组合验收：合成 PG、既有实际 caller、本机 HTTP；不接触产品资料或外部服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createWriteStream} from 'node:fs';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startModelHost} from '../../../backend-ts/src/model-host.ts';
import {createHostModelAccounting,modelTaskRequestId} from '../../../backend-ts/src/host-model-accounting.ts';
import {bindDiagnosticProblemBudget} from '../../../backend-ts/src/diagnostic-problem-budget.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../../backend-ts/package.json',import.meta.url));
const pg=require('pg');
const resultPath=new URL('./independent-wire-result.json',import.meta.url);
const {log_dir:logDir}=JSON.parse(await readFile(new URL('./runtime.json',import.meta.url),'utf8'));
const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const controlEnv={PATH:process.env.PATH,PYTHONPATH:join(root,'backend/src'),NOTALONE_DISABLE_DOTENV:'1'};
function control(ledger,...args) {
 return JSON.parse(execFileSync(python,['-m','notalone.experiments.problem_budget','--ledger',ledger,...args],
  {env:controlEnv,timeout:10000,stdio:['ignore','pipe','pipe']}).toString());
}
function check(result){assert.equal(result.receipt?.outcome,'succeeded');}

test('Python 预留、失败、取消、跨进程重启和真实 L2/L3 共用八次；第九次零 HTTP',{timeout:45000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-independent-budget-'));await chmod(directory,0o700);
 const ledger=join(directory,'problem.sqlite'),summary={test:'mixed-python-ts-physical-boundary',passed:false,steps:[]};
 const name=`notalone_independent_${randomUUID().replaceAll('-','')}_test`;
 const admin=new pg.Client({host:'/tmp',database:'postgres'}),client=new pg.Client({host:'/tmp',database:name});
 const children=[];let host,provider,created=false,connected=false;
 t.after(async()=>{
  for(const child of children)await child.stop();
  await host?.shutdown();
  if(provider){provider.closeAllConnections();await new Promise(r=>provider.close(r));}
  if(connected)await client.end();
  if(created)await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();await rm(directory,{recursive:true,force:true});
  summary.cleanup='own children, host, HTTP, synthetic PG and ledger removed';
  await writeFile(resultPath,JSON.stringify(summary,null,2)+'\n');
 });
 control(ledger,'create','--problem','independent-synthetic-problem','--calls','8','--minutes','30');
 control(ledger,'start','--round','r1','--hypothesis','只核验原总账与物理边界组合');
 execFileSync(python,['-c','import sys; from notalone.problem_budget import ProblemBudget; ProblemBudget(sys.argv[1]).reserve("r1")',ledger],
  {env:controlEnv,timeout:10000,stdio:['ignore','pipe','pipe']});
 await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
 await client.connect();connected=true;
 const migrations=join(root,'backend/database/migrations');
 for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await client.query(await readFile(join(migrations,file),'utf8'));
 const owner=(await client.query("INSERT INTO owner(display_name) VALUES('合成验收') RETURNING id")).rows[0].id;
 const contact=(await client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成验收') RETURNING id",[owner])).rows[0].id;
 await client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status) VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 async function task(kind,step){
  const id=(await client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'running',$4,0) RETURNING id",[owner,contact,kind,step])).rows[0].id;
  const worker=randomUUID(),stepId=(await client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,$2,1,'running',$3,1,1,now()+interval '5 minutes') RETURNING id",[id,step,worker])).rows[0].id;
  return {task_id:id,step_id:stepId,step_name:step,worker_id:worker,lease_generation:1};
 }
 const claim=await task('observation','extract_memory'),batchKey='b'.repeat(64),trace=randomUUID();
 await client.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)',[trace,owner,contact,randomUUID(),batchKey]);
 await client.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),trace,owner,contact,{task_runtime:claim}]);
 const transaction=async work=>{
  const c=new pg.Client({host:'/tmp',database:name});await c.connect();
  try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}
 };
 const accounting=createHostModelAccounting({transaction,provider:'synthetic',typescriptProvider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>host?.unconfirmedPermitIds()??[]});
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,infoPath:join(directory,'host-info'),envFilePath:join(directory,'synthetic-env'),accounting});
 const requests=[];
 provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  requests.push(req.url);
  if(raw.includes('FAIL_503')){res.writeHead(503);res.end('{}');return;}
  if(req.url==='/beta/chat/completions'){
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'synthetic',type:'function',function:{name:'SourceVerificationOutput',arguments:JSON.stringify({results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[],proof:null}]})}}]}}],usage:{prompt_tokens:3,completion_tokens:1}}));return;
  }
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 async function start(label,scenario=false){
  const home=join(directory,label),profile=join(home,'profiles/notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  const plugin=join(root,'backend-ts/test',scenario?'diagnostic-scenario-budget-plugin.ts':'extraction-model-plugin.ts');
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(plugin)}\n`);
  const child=spawn(process.execPath,[join(root,'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,
   env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',...host.pythonEnvironment,
    NOTALONE_PROBLEM_BUDGET:ledger,NOTALONE_PROBLEM_ROUND:'r1',NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit'),log=createWriteStream(join(logDir,`${label}.log`),{mode:0o600});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  const running={stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;await new Promise(r=>log.end(r));}};
  children.push(running);
  const url=await new Promise((done,reject)=>{
   let output='';const timer=setTimeout(()=>reject(new Error('synthetic_child_not_ready')),10000);
   child.stdout.on('data',v=>{output+=v;const found=output.match(/(?:EXTRACTION_MODEL|DIAGNOSTIC_SCENARIO)_READY (http:\/\/127\.0\.0\.1:\d+)/);if(found){clearTimeout(timer);done(found[1]);}});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('synthetic_child_exited_before_ready'));});
  });
  return {...running,call:async(extra={})=>{
   const response=await fetch(url,{method:'POST',body:JSON.stringify({request_id:modelTaskRequestId('extraction',claim.task_id,batchKey),owner_id:owner,contact_id:contact,claim,attempt_id:randomUUID(),...extra})});
   return response.json();
  }};
 }
 function counts(label){const used=control(ledger,'status').used;summary.steps.push({label,reservations:used,http_requests:requests.length});return used;}
 assert.equal(counts('python-only-reservation'),1);assert.equal(requests.length,0);
 const first=await start('independent-first');
 assert.ok((await first.call({wrongLedger:true})).error);assert.equal(counts('pg-rejected'),2);assert.equal(requests.length,0);
 const cancelled=await first.call({cancelBeforeDispatch:true});assert.equal(cancelled.receipt?.dispatch,'not_sent');assert.equal(cancelled.receipt?.outcome,'cancelled');assert.equal(counts('cancelled-after-reservation'),3);assert.equal(requests.length,0);
 assert.equal((await first.call({providerStatus:503})).receipt?.outcome,'failed');assert.equal(counts('http-503'),4);assert.equal(requests.length,1);
 check(await first.call({system:'合成核验',tools:[{name:'SourceVerificationOutput',description:'核验',parameters:{type:'object',properties:{supported:{type:'boolean'}}}}]}));
 assert.equal(counts('strict-http'),5);assert.equal(requests.length,2);
 check(await first.call());assert.equal(counts('messages-http'),6);assert.equal(requests.length,3);
 await first.stop();
 const layered=await task('layered_memory','organize_memory'),batch=randomUUID();
 await client.query('INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,$2,true,1)',[owner,contact]);
 await client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status) VALUES($1,$2,$3,1,'synthetic','synthetic','{}','{}','active',1,16,true,'pending')",[layered.task_id,owner,contact]);
 await client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES($1,$2,$3,1,$4,'running','[]','[]','{}',now(),$5)",[batch,owner,contact,randomUUID(),layered.task_id]);
 const second=await start('independent-restart-new-directory',true);
 assert.ok((await second.call({claim:layered,batch_id:batch})).receipt_id);assert.equal(counts('l2-after-restart'),7);assert.equal(requests.length,4);
 await client.query("UPDATE layered_memory_batch SET status='succeeded' WHERE id=$1",[batch]);
 const profile=randomUUID();
 await client.query("INSERT INTO layered_profile_batch(id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,scenario_version_ids,input_manifest,input_payload,dependency_ids,created_at) VALUES($1,$2,$3,1,0,$4,$5,$6,$7,'running',now()+interval '5 minutes','{}','[]','{}','{}',now())",[profile,owner,contact,randomUUID(),randomUUID(),batch,layered.task_id]);
 assert.ok((await second.call({claim:layered,batch_id:profile})).receipt_id);assert.equal(counts('l3-last-reservation'),8);assert.equal(requests.length,5);
 const ninth=await second.call({claim:layered,batch_id:profile});assert.ok(ninth.error);assert.equal(counts('ninth-denied'),8);assert.equal(requests.length,5);
 await second.stop();assert.equal(host.unconfirmedPermitIds().length,0);
 const receipts=(await client.query('SELECT count(*)::int n,count(DISTINCT permit_id)::int permits,count(*) FILTER (WHERE outcome=\'unknown\')::int unknown FROM model_call_receipt')).rows[0];
 assert.equal(receipts.n,6);assert.equal(receipts.permits,6);assert.equal(receipts.unknown,0);
 const ledgerBytes=await readFile(ledger);
 for(const marker of [owner,contact,'FAIL_503','SourceVerificationOutput','合成核验',`http://127.0.0.1:${provider.address().port}`])assert.equal(ledgerBytes.includes(Buffer.from(marker)),false);
 summary.ledger_contains_payload_or_scope_canaries=false;
 summary.receipts=receipts;summary.physical_requests_by_endpoint={messages:requests.filter(p=>p!=='/beta/chat/completions').length,strict:requests.filter(p=>p==='/beta/chat/completions').length};
 summary.ninth_http_delta=0;summary.unconfirmed_permits=0;summary.child_processes=2;summary.passed=true;
});

test('缺省兼容与半配置拒绝在预算模块边界可独立复核',()=>{
 assert.equal(bindDiagnosticProblemBudget({}),null);
 for(const env of [{NOTALONE_PROBLEM_ROUND:'r1'},{NOTALONE_PROBLEM_BUDGET:'/unavailable/synthetic.sqlite'},
  {NOTALONE_PROBLEM_ROUND:'r1',NOTALONE_PROBLEM_BUDGET:''},{NOTALONE_PROBLEM_ROUND:' ',NOTALONE_PROBLEM_BUDGET:'/unavailable/synthetic.sqlite'}])
  assert.throws(()=>bindDiagnosticProblemBudget(env),error=>error.code==='problem_budget_binding_invalid');
});
