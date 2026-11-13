/** 真实旧 Python 与官方 DSH profile 的本机采集；不授予外部供应商执行能力。 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir,homedir,platform,arch,totalmem,cpus} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {captureSource,freezeSource,verifyFrozenSource} from './source-snapshot.mjs';
import {observePlugin} from './observe-plugin.mjs';
import {captureDependencies} from './dependencies.mjs';
import {verifyPersistedOutput} from './complete-output.mjs';
import {createLocalForwarder} from './local-provider.mjs';
import {replyComparisonCollectorBinding,auditReplyRuntimeSources} from '../../../backend-ts/src/reply-comparison-sources.ts';
import {freezeProblemBudgetConfiguration,captureEvaluationRuntime,freezeEvaluationRuntime,verifyEvaluationRuntime,fixedBudgetConfiguration} from './execution-snapshot.mjs';

const HERE=fileURLToPath(new URL('.',import.meta.url));
const ROOT=resolve(HERE,'../../..');
const BASE='3c168296e9e8edaa43b8b323ff693e790e709069';
const PYTHON=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const digest=value=>sha(canonical(value));
const inputFields=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const inputFor=member=>Object.fromEntries(inputFields.filter(key=>key in member).map(key=>[key,member[key]]));

function modelPayload(body){
 const found=[];
 const visit=value=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object'){if(Array.isArray(value.evidence)&&value.fidelity_contract)found.push(value);for(const [key,item]of Object.entries(value))if(key!=='evidence')visit(item);}else if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const a=value.indexOf('{'),b=value.lastIndexOf('}');if(a>=0&&b>a){try{visit(JSON.parse(value.slice(a,b+1)));}catch{}}}}};
 visit(body);assert.equal(found.length,1,'实际 SDK 请求必须含唯一原业务 payload');return found[0];
}

/** 不把未声明作者的冻结文字伪装成聊天消息；统一走明确手动输入。 */
export function projectCase(member){
 const context=Object.fromEntries(['available_facts','current_message','recent_context'].filter(key=>key in member).map(key=>[key,member[key]]));
 const strategy=Object.fromEntries(['unknowns','allowed_changes'].map(key=>[key,member[key]]));
 return {type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:member.current_intent,
  user_instruction:canonical(strategy),include_relationship_context:true,context_text:canonical(context),excluded_message_ids:[]};
}

async function frozenMaterials(){
 const manifestText=await readFile(join(ROOT,'.scratch/dsh-ts-migration/baseline/material-manifest.json'),'utf8');
 const datasetText=await readFile(join(ROOT,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'utf8');
 const manifest=JSON.parse(manifestText),dataset=JSON.parse(datasetText);
 for(const material of manifest.materials){
  const bytes=material.source_ref==='migration-comparison-v1-new-synthetic'?await readFile(join(ROOT,material.path)):execFileSync('git',['show',`${BASE}:${material.path}`],{cwd:ROOT,maxBuffer:8*1024*1024});
  assert.equal(sha(bytes),material.sha256,`冻结材料改变：${material.path}`);
 }
 return {manifestText,datasetText,manifest,cases:dataset.cases};
}

function startPython(frozenSource,evaluationRoot,localOnly){
 const child=spawn(PYTHON,[join(evaluationRoot,'collector/old-arm.py'),frozenSource],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:homedir(),NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1',NOTALONE_BUDGET_REPOSITORY:ROOT,NOTALONE_COMPARISON_LOCAL_ONLY:localOnly?'1':'0'},stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');
 const lines=createInterface({input:child.stdout}),pending=[];let stderr='';
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 lines.on('line',line=>{const next=pending.shift();if(next){try{next.resolve(JSON.parse(line));}catch(error){next.reject(error);}}});
 child.on('exit',code=>{for(const next of pending.splice(0))next.reject(Error(`旧管线退出 ${code}: ${stderr.slice(-1500)}`));});
 return {child,invoke(data){return new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(data)+'\n');});},async close(){if(child.exitCode===null&&child.signalCode===null)child.stdin.end();await exited;assert.equal(child.exitCode,0,stderr);}};
}

async function hostObservations(host,id,{wait=true}={}){
 const read=()=>host.output.split('\n').filter(line=>line.startsWith('COLLECTOR_EVENT ')).map(line=>JSON.parse(line.slice(16))).filter(event=>event.request_id===id);
 const complete=events=>events.some(event=>event.type==='business_service_end');
 if(wait&&!complete(read()))await new Promise((resolveReady,reject)=>{
  const finish=error=>{clearTimeout(timer);host.child.stdout.off('data',check);error?reject(error):resolveReady();};
  const check=()=>{if(complete(read()))finish();};
  const timer=setTimeout(()=>finish(Error('真实业务观察结束事件未到达')),5000);host.child.stdout.on('data',check);check();
 });
 const events=read(),first=events.find(e=>e.type==='network_start'),token=events.find(e=>e.type==='model_stream_chunk'&&e.is_token_delta===true);
 const primary_tool_events=host.output.split('\n').filter(line=>line.startsWith('PRIMARY_TOOL_EVENT ')).map(line=>JSON.parse(line.slice(19)));
 return {clock:'node_performance_now_relative',boundary:'request_json_parsed_before_service_generate',wall_started_at:events.find(e=>e.type==='business_service_start')?.wall_at??null,events,primary_tool_events,first_event_ms:first?.at_ms??null,first_token_ms:token?.at_ms??null,first_event_kind:'stream_request_send',token_definition:'@deepseek-ai/dsh-llm/assistant-stream:isTokenDelta',complete_five_phase_partition:true};
}

function completeTiming(raw,{request_sha256,status,persisted}){
 if(!raw||!Array.isArray(raw.events))return null;
 const at=(type,last=false)=>{const values=raw.events.filter(event=>event.type===type).map(event=>event.at_ms).sort((a,b)=>a-b);return values.length?(last?values.at(-1):values[0]):null;};
 const start=at('business_service_start'),queueEnd=at('queue_end'),networkStart=at('network_start'),networkEnd=at('network_end',true),persistStart=at('persistence_start'),persistEnd=at('persistence_end',true),end=at('business_service_end',true);
 for(const value of [start,queueEnd,networkStart,networkEnd,persistStart,persistEnd,end])if(!Number.isFinite(value)||value<0)return null;
 if(!(start===0&&queueEnd<=networkStart&&networkStart<=networkEnd&&networkEnd<=persistStart&&persistStart<=persistEnd&&persistEnd<=end))return null;
 const marker=(name,edge)=>`${name}:${edge}:${request_sha256.slice(0,12)}`;
 const phase=(name,started_ms,ended_ms)=>({started_ms,ended_ms,markers:{start:marker(name,'start'),end:marker(name,'end')}});
 const phases={
  queue:phase('queue',start,queueEnd),
  retrieval:phase('retrieval',queueEnd,networkStart),
  network_model:phase('network_model',networkStart,networkEnd),
  validation:phase('validation',networkEnd,persistStart),
  persistence:phase('persistence',persistStart,persistEnd),
 };
 const overhead=end>persistEnd?[{started_ms:persistEnd,ended_ms:end,kind:'framework_overhead',reason:'原Service在候选保存后完成清理并返回；单独保留，不归入持久化。',markers:{start:marker('overhead','start'),end:marker('overhead','end')}}]:[];
 const rawWall=raw.wall_started_at??raw.wall_start??null;
 const wall=rawWall?new Date(rawWall).toISOString():null;
 const final_persisted_result_ms=status==='succeeded'&&persisted?end:null;
 return {
  started_at:wall,
  raw_wall_started_at:rawWall,raw_wall_started_at_sha256:sha(rawWall),wall_clock_conversion:'ISO8601_parse_to_millisecond_UTC_preserving_original',
  ended_at:wall?new Date(Date.parse(wall)+end).toISOString():null,
  observed_ms:end,
  first_event_ms:raw.first_event_ms,
  first_token_ms:raw.first_token_ms,
  final_persisted_result_ms,
  timing:{schema_version:'reply-latency-v2',clock:'monotonic',observed_ms:end,first_event_ms:raw.first_event_ms,first_token_ms:raw.first_token_ms,
   final_persisted_result_ms,phases,...overhead.length?{overhead}:{},
   diagnostics:{request_sha256,first_event_ms:{observability:raw.first_event_ms===null?'unobservable':'observable',definition:'first_incremental_event',reason:raw.first_event_ms===null?'本轮没有可观测的首事件。':null},
    first_token_ms:{observability:raw.first_token_ms===null?'unobservable':'observable',definition:'first_incremental_token',reason:raw.first_token_ms===null?'本轮没有可观测的首token。':null}}},
 };
}

export async function collectLocal({vendorForward,vendorForwardFactory,executionPolicy,full=false,pairStart=0,pairEnd=null,caseId='paired-decline',repeat=1,marker='原业务响应采集',riskNotes=['合成验收：仅按本次意图表达，不补充未提供事实。'],onReady,onRecord,problemBudget,onSupplierArrival,sourceCommit,localOnly=false,localFaults={}}={}){
 if(executionPolicy!==undefined)assert.match(sourceCommit??'',/^[a-f0-9]{40}$/,'explicit_source_commit_required');
 if(localOnly&&(vendorForward!==undefined||vendorForwardFactory!==undefined||problemBudget!==undefined))throw Error('local_provider_boundary_invalid');
 if(localOnly)vendorForward=createLocalForwarder(localFaults);
 if(typeof vendorForward!=='function'&&typeof vendorForwardFactory!=='function'||vendorForward!==undefined&&vendorForwardFactory!==undefined)throw Error('vendor_forward_required');
 if(process.env.NOTALONE_DEEPSEEK_API_KEY!==undefined)throw Error('credential_not_removed_before_spawn');
 const budgetConfiguration=localOnly?null:freezeProblemBudgetConfiguration(problemBudget,{python:PYTHON,moduleRoot:join(ROOT,'backend/src'),repositoryRoot:ROOT});
 const dependenciesBefore=await captureDependencies(ROOT,PYTHON);
 const evaluationSource=await captureEvaluationRuntime({collectorRoot:HERE,moduleRoot:budgetConfiguration?.moduleRoot??join(ROOT,'backend/src'),executionPolicy});
 process.chdir(join(ROOT,'backend-ts'));
 const materials=await frozenMaterials(),sourceBefore=await captureSource(ROOT,sourceCommit),temporary=await mkdtemp(join(tmpdir(),'notalone-reply-paired-'));
 const originalSourceFiles={...sourceBefore.manifest.files};
 const supportPath='backend-ts/test/reply-service-runtime-support.mjs',support=sourceBefore.bytes.get(supportPath).toString('utf8'),seam="requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });";
 assert.equal(support.split(seam).length,2,'vendor_raw_capture_seam_changed');
 sourceBefore.bytes.set(supportPath,Buffer.from(support.replace(seam,"requests.push({ path: req.url, raw_utf8: raw, body: JSON.parse(raw) });")));
 sourceBefore.manifest.files={...sourceBefore.manifest.files,[supportPath]:sha(sourceBefore.bytes.get(supportPath))};
 sourceBefore.manifest.vendor_support_raw_capture_only=true;
 sourceBefore.manifest.matches_commit_tree=false;sourceBefore.manifest.modified_or_deleted_paths=[supportPath];
 sourceBefore.manifest.observation_adaptations=[{path:supportPath,before_sha256:originalSourceFiles[supportPath],after_sha256:sourceBefore.manifest.files[supportPath],kind:'wire_utf8_observation_only'}];
 const candidateRoot=join(temporary,'fixed-candidate'),evaluationRoot=join(temporary,'fixed-evaluation'),fixedBudget=localOnly?null:fixedBudgetConfiguration(budgetConfiguration,evaluationRoot);
 const cleanups=[],t={after(fn){cleanups.push(fn);}};
 let python,provider,fixture,host,fixtureClosed=false;
 async function closeFixture(){if(fixture&&!fixtureClosed){await fixture.close();fixtureClosed=true;}}
 const calls=[];let current=null;
 async function captureCatalog(body,requestHash,requestHashKind){
  const payload=modelPayload(body),request=(await fixture.client.query('SELECT id,owner_id,contact_id,conversation_binding_id FROM reply_request WHERE idempotency_key=$1',[current.body.idempotency_key])).rows[0];
  assert.ok(request,'实际请求必须已经持久化');
  for(const key of ['owner_id','contact_id','conversation_binding_id'])assert.equal(request[key],current.scope[key]);
  // 只保留供应商响应前观察；v2 catalog须等待完成后的真实PG来源。
  return {payload,sources:payload.evidence,request_id:request.id,captured_at:new Date().toISOString(),attempt_id:randomUUID()};
 }
 function captureLegacyAttempt(call,snapshot,collectorBinding){
  const payload=modelPayload(call.request),expected=projectCase(current.member);
  assert.equal(payload.draft_text,expected.draft_text);assert.equal(payload.context_text,expected.context_text);assert.equal(payload.user_instruction,expected.user_instruction);
  const entries=payload.evidence.map(source=>{
   const stored=snapshot.find(row=>row.evidence_id===source.evidence_id);
   assert.ok(stored,'legacy_source_missing');
   assert.equal(stored.kind,source.kind,'legacy_source_kind');assert.equal(stored.evidence_text,source.text,'legacy_source_text');
   for(const key of ['owner_id','contact_id','conversation_binding_id'])assert.equal(stored[key],current.scope[key],'legacy_source_scope');
   return {...structuredClone(source),text_sha256:sha(source.text),case_fields:source.kind==='user_draft'?['current_intent']:source.kind==='user_current_chat'?Object.keys(JSON.parse(expected.context_text)):[],origin:source.kind==='user_purpose'?'explicit_workspace_action':'frozen_case_manual_input',source_ids:[],not_confirmed_memory:true};
  });
  const catalog={schema_version:'reply-runtime-source-catalog-v1',case_id:current.case_id,repeat:current.repeat,arm:'old',case_sha256:digest(current.member),input_sha256:digest(inputFor(current.member)),request_sha256:call.request_sha256,request_hash_kind:call.request_hash_kind,scope:current.scope,request_id:call.request_id,entries,strategy_fields:{payload_field:'user_instruction',fields:JSON.parse(payload.user_instruction),citable:false},covered_input_fields:Object.keys(inputFor(current.member)).sort(),oracle_fields_excluded:['forbidden_additions','tags','split'],captured_at:call.captured_at,capture_boundary:'request_received_before_supplier_response',stored_evidence_verified_after_completion:false};
  return {attempt_id:call.attempt_id,attempt_id_kind:call.attempt_identity_kind,request:{body:call.request,hash_kind:call.request_hash_kind,sha256:call.request_sha256,raw_utf8:call.raw_utf8},response_started_at:call.response_started_at,catalog,catalog_sha256:digest(catalog),source_binding:collectorBinding};
 }

 try{
  await mkdir(join(temporary,'catalogs'));
  await freezeSource(sourceBefore,candidateRoot);
  await freezeEvaluationRuntime(evaluationSource,evaluationRoot);
  if(vendorForwardFactory){vendorForward=await vendorForwardFactory({collectorRoot:join(evaluationRoot,'collector')});assert.equal(typeof vendorForward,'function','vendor_forward_factory_result');}
  await symlink(join(ROOT,'backend-ts/node_modules'),join(candidateRoot,'backend-ts/node_modules'),'dir');
  const {createStorageFixture}=await import(pathToFileURL(join(candidateRoot,'backend-ts/test/host-storage-fixture.mjs')));
  const {startReplyServiceHost,sendEvents,useTool}=await import(pathToFileURL(join(candidateRoot,'backend-ts/test/reply-service-runtime-support.mjs')));
  const {captureReplyRuntimeSourceAttempt:captureFixedAttempt}=await import(pathToFileURL(join(candidateRoot,'backend-ts/src/reply-comparison-sources.ts')));
  const {createReplyComparisonPlan}=await import(pathToFileURL(join(candidateRoot,'backend-ts/src/reply-comparison.ts')));
  createReplyComparisonPlan(materials.manifestText,materials.datasetText);
  process.chdir(join(candidateRoot,'backend-ts'));
  const tar=join(temporary,'old.tar');await writeFile(tar,execFileSync('git',['archive',BASE,'backend/src','backend/pyproject.toml'],{cwd:ROOT,maxBuffer:40*1024*1024}));
  execFileSync('tar',['-xf',tar,'-C',temporary]);await rm(tar);
  const frozenSource=join(temporary,'backend/src');
  const legacyBudgetFiles=Object.fromEntries(await Promise.all(['__init__.py','problem_budget.py'].map(async name=>['notalone/'+name,sha(await readFile(join(frozenSource,'notalone',name)))])));
  // 用现有经验证的合成宿主；本轮显式策略只改生成插件的输出与对应容量。
  assert.equal(sha(await readFile(join(frozenSource,'notalone/problem_budget.py'))),evaluationSource.files['budget-modules/notalone/problem_budget.py'],'problem_budget_runtime_version_mismatch');
  let pluginSource=observePlugin(sourceBefore.bytes.get('backend-ts/test/reply-service-runtime-plugin.ts').toString('utf8'))
   .replaceAll("'../src/","'"+join(candidateRoot,'backend-ts/src/'));
  const pluginBeforeControls=sha(pluginSource),policy=evaluationSource.execution_policy;
  assert.equal(pluginSource.split('maxTokens:256').length,3,'output_control_plugin_seam_changed');
  pluginSource=pluginSource.replaceAll('maxTokens:256','maxTokens:'+(policy?.controls.max_output_tokens??4096));
  if(policy){assert.equal(pluginSource.split('context_window_tokens:65536,safety_margin_tokens:128').length,2,'capacity_control_plugin_seam_changed');pluginSource=pluginSource.replace('context_window_tokens:65536,safety_margin_tokens:128','context_window_tokens:'+policy.capacity.context_window_tokens+',safety_margin_tokens:'+policy.capacity.safety_margin_tokens);}
  const pluginControlAdaptation={path:'generated/collector-plugin.ts',before_sha256:pluginBeforeControls,after_sha256:sha(pluginSource),kind:'explicit_output_and_capacity_controls'};
  const serviceProvider='ctx,transaction,provider,arbiter';assert.equal(pluginSource.split(serviceProvider).length,2,'预算接缝源码已变化');
  if(!localOnly)pluginSource="import {withProblemBudgetProvider} from "+JSON.stringify(join(evaluationRoot,'collector/bridge.mjs'))+";\n"+pluginSource.replace(serviceProvider,'ctx,transaction,provider:withProblemBudgetProvider(provider,'+JSON.stringify(fixedBudget)+'),arbiter');
  const pluginPath=join(temporary,'collector-plugin.ts');await writeFile(pluginPath,pluginSource);
  await symlink(join(ROOT,'backend-ts/node_modules'),join(temporary,'node_modules'),'dir');
  fixture=await createStorageFixture();
  async function receiveVendor(arm,path,raw,res){
   try{
    await onSupplierArrival?.({arm});assert.equal(current.arm,arm);
    const body=JSON.parse(raw),captured=await captureCatalog(body,sha(raw),'wire_utf8_sha256');
    const call={case_id:current.case_id,repeat:current.repeat,arm,attempt_id:captured.attempt_id,attempt_identity_kind:'collector_http_observation_not_ledger_id',request_sha256:sha(raw),request:body,raw_utf8:raw,request_hash_kind:'wire_utf8_sha256',request_id:captured.request_id,captured_at:captured.captured_at,response_model:null,response_fingerprint:null,usage:null,supplier_received_at:new Date().toISOString()};
    calls.push(call);await vendorForward({arm,path,raw,body,res,call,cancel:()=>host.request('/cancel',{id:current.id})});
   }catch(error){
    const rejected=calls.at(-1);if(rejected)rejected.collector_rejection=error instanceof Error?error.message:String(error);
    if(!(error instanceof Error)||error.message!=='vendor_upstream_failed')vendorForward.close?.('collector_guard_rejected');
    if(!res.headersSent){res.statusCode=502;res.setHeader('content-type','application/json');res.end('{"error":"vendor_boundary_rejected"}');}else res.destroy();
   }
  }
  provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;await receiveVendor('old',req.url,raw,res);});provider.listen(0,'127.0.0.1');await once(provider,'listening');
  python=startPython(frozenSource,evaluationRoot,localOnly);
  host=await startReplyServiceHost(t,{name:fixture.client.database,user:fixture.client.user,close:closeFixture},async(_req,res,requests)=>{const request=requests.at(-1);await receiveVendor('new',request.path,request.raw_utf8,res);},{pluginPath});
  await host.request('/configure-model',{physical_limit:24});
  await onReady?.();
  const collectorBinding=replyComparisonCollectorBinding(ROOT,process.argv.slice(2));
  assert.equal(collectorBinding.source_commit,sourceBefore.manifest.base_commit,'collector_commit_must_match_fixed_tree');
  const oldFiles=execFileSync('git',['ls-tree','-r','--name-only',BASE,'--','backend/src','backend/pyproject.toml'],{cwd:ROOT,encoding:'utf8'}).trim().split('\n').sort();
  const legacySourceFiles=Object.fromEntries(oldFiles.map(name=>[name,sha(execFileSync('git',['show',BASE+':'+name],{cwd:ROOT,maxBuffer:8*1024*1024}))]));
  for(const [name,hash]of Object.entries(legacySourceFiles))assert.equal(sha(await readFile(join(temporary,name))),hash,'legacy_source_before_execution');
  const legacyProfile={schema_version:'reply-legacy-execution-profile-v1',source_commit:BASE,source_files_sha256:digest(legacySourceFiles),runner_sha256:evaluationSource.files['collector/old-arm.py'],primary_sha256:evaluationSource.files['collector/primary.json'],collector_adaptations:['streaming_configuration_retains_original_SDK_binding','observed_context_uses_frozen_synthetic_source_ids',...policy?['explicit_execution_policy_output_control']:[]],controls:JSON.parse(evaluationSource.bytes.get('collector/primary.json')).controls,streaming_transport:'loopback_httpx_original_SDK_no_retry',context_id_source:'frozen_synthetic_primary_input_before_execution'};
  const oldBinding={source_commit:BASE,source_tree_sha256:digest(legacySourceFiles),workspace_clean:true,argv_sha256:digest([BASE,evaluationSource.files['collector/old-arm.py']])};
  const plan=createReplyComparisonPlan(materials.manifestText,materials.datasetText),selected=full?plan.slice(pairStart,pairEnd??plan.length):plan.filter(pair=>pair.case_id===caseId&&pair.repeat===repeat),records=[];
  assert.ok(selected.length,'未找到冻结case');
  for(const pair of selected){const member=materials.cases.find(c=>c.case_id===pair.case_id);
   for(const arm of pair.order==='AB'?['old','new']:['new','old']){
    const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),key=randomUUID();
    await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成成对用户')",[owner]);
    await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成成对联系人')",[contact,owner]);
    await fixture.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
    const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
    const body={contact_id:contact,idempotency_key:key,content:projectCase(member),skill_disabled:true};
    const wallStart=new Date().toISOString();current={...pair,arm,scope,body,member,started_at:wallStart};const before=calls.length,start=performance.now();let actual,partialObservations=null;
    if(arm==='old')actual=await python.invoke({database:fixture.client.database,scope,body,problem_budget:budgetConfiguration?.budget??null,local_only:localOnly,provider:`http://127.0.0.1:${provider.address().port}`});
    else{let id=null;try{id=randomUUID();current.id=id;const result=await host.request('/generate',{id,scope,body});actual={status:'succeeded',result};partialObservations=await hostObservations(host,id);}catch(error){actual={status:'failed',error:String(error)};if(id)partialObservations=await hostObservations(host,id,{wait:false});}}
    const outer_observed_ms=performance.now()-start;
    const terminalReceipt=(await fixture.client.query('SELECT r.id AS request_id,r.state AS request_state,a.state AS attempt_state,a.failure_reason FROM reply_request r LEFT JOIN reply_attempt a ON a.reply_request_id=r.id AND a.number=r.attempt WHERE r.idempotency_key=$1',[key])).rows[0]??null;
    if(actual.status==='failed'&&['user_cancelled','reply_cancelled'].includes(terminalReceipt?.failure_reason))actual={...actual,status:'cancelled'};
    const observedCalls=calls.slice(before),physical=observedCalls.filter(call=>Number.isSafeInteger(call.upstream_send_ordinal)),persisted=(await fixture.client.query(`SELECT c.id AS candidate_id,c.reply_request_id,c.owner_id,c.contact_id,c.conversation_binding_id,c.candidate_text AS text,c.basis,c.risk_notes,c.message_group AS messages,COALESCE((SELECT json_agg(k.evidence_id ORDER BY k.ordinal) FROM reply_candidate_citation k WHERE k.candidate_id=c.id),'[]') AS citation_ids FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1 ORDER BY c.ordinal`,[key])).rows;
    let source_storage_receipt=null;const attempts=[];
    if(actual.status==='succeeded'){
     assert.equal(persisted.length,actual.result.candidates.length);assert.ok(physical.length>=1&&physical.length<=8);
     const snapshot=(await fixture.client.query('SELECT evidence_id,kind,evidence_text,owner_id,contact_id,conversation_binding_id,source_ids FROM reply_context_evidence WHERE reply_request_id=$1 ORDER BY ordinal',[actual.result.reply_request_id])).rows;
     for(const call of physical){
      const attempt=arm==='new'?captureFixedAttempt({member,body:call.request,request:{request_id:call.request_id,hash_kind:'wire_utf8_sha256',sha256:call.request_sha256,raw_utf8:call.raw_utf8},scope,case_id:pair.case_id,repeat:pair.repeat,arm,attempt_id:call.attempt_id,started_at:wallStart,captured_at:call.captured_at,response_started_at:call.response_started_at,persisted_sources:snapshot,collector_binding:collectorBinding}).attempt:captureLegacyAttempt(call,snapshot,oldBinding);
      call.source_catalog=attempt.catalog;call.source_catalog_sha256=attempt.catalog_sha256;attempts.push(attempt);
     }
     for(const entry of physical[0].source_catalog.entries){const stored=snapshot.find(e=>e.evidence_id===entry.evidence_id);assert.ok(stored);assert.equal(stored.kind,entry.kind);assert.equal(stored.evidence_text,entry.text);assert.equal(stored.owner_id,owner);assert.equal(stored.contact_id,contact);assert.equal(stored.conversation_binding_id,binding);assert.deepEqual(stored.source_ids,[]);}
     const requestSnapshot=(await fixture.client.query('SELECT id,owner_id,contact_id,conversation_binding_id,skill_id,skill_version_id,skill_name,skill_selection_method,skill_selection_reason,skill_load_state,skill_loaded_resources FROM reply_request WHERE id=$1 AND state=\'completed\'',[actual.result.reply_request_id])).rows[0];
     assert.ok(requestSnapshot,'必须真实读到completed请求');
     const output=verifyPersistedOutput(actual.result,persisted,requestSnapshot,scope);
     source_storage_receipt={catalog_sha256:physical[0].source_catalog_sha256,request_id:actual.result.reply_request_id,scope,snapshot_sha256:digest(snapshot),snapshot,candidate_snapshot:persisted,request_snapshot:requestSnapshot,output,output_sha256:digest(output),observed_at:new Date().toISOString(),verified_after_completion:true};
    }
    const runtimeSources={schema_version:'reply-runtime-sources-v1',scope,request_id:terminalReceipt?.request_id??null,
     attempts:actual.status==='succeeded'?attempts:physical.map(call=>({attempt_id:call.attempt_id,attempt_id_kind:call.attempt_identity_kind,request:{body:call.request,hash_kind:call.request_hash_kind,sha256:call.request_sha256,raw_utf8:call.raw_utf8},response_started_at:call.response_started_at??null,captured_at:call.captured_at,source_incomplete_reason:'terminal_not_successful_no_completion_mapping'})),persistence:source_storage_receipt};
    const output=source_storage_receipt?.output??null;
    const rawTiming=partialObservations??actual.partial_observations??null;
    const requestSha=physical.length===1?physical[0].request_sha256:null;
    const measuredTiming=requestSha?completeTiming(rawTiming,{request_sha256:requestSha,status:actual.status,persisted:source_storage_receipt!==null}):null;
    const started_at=measuredTiming?.started_at??wallStart;
    const ended_at=measuredTiming?.ended_at??new Date(Date.parse(started_at)+outer_observed_ms).toISOString();
    const observed_ms=measuredTiming?.observed_ms??outer_observed_ms;
    const knownUsage=physical.every(call=>call.usage!==null);
    const knownCost=physical.length>0&&physical.every(call=>Number.isFinite(call.cost?.amount));
    const sum=(key)=>knownUsage?physical.reduce((total,call)=>total+call.usage[key],0):null;
    records.push({...pair,arm,blind_id:randomUUID(),case_sha256:digest(member),input_sha256:digest(inputFor(member)),synthetic_scope_id:digest(scope),scope,body,output,
     started_at,ended_at,observed_ms,latency_ms:measuredTiming?.observed_ms??null,logical_calls:1,physical_calls:physical.length,actual_model:physical.at(-1)?.response_model??null,model_fingerprint:null,
     request_sha256:requestSha,
     usage:knownUsage?{input_tokens:sum('input_tokens'),output_tokens:sum('output_tokens'),reasoning_tokens:sum('reasoning_tokens'),cache_hit_tokens:sum('cache_hit_tokens'),cache_miss_tokens:sum('cache_miss_tokens')}:null,
     cost:knownCost?{amount:physical.reduce((total,call)=>total+call.cost.amount,0),currency:physical[0].cost.currency,price_snapshot_sha256:physical[0].cost.price_snapshot_sha256}:null,
     timing:measuredTiming?.timing??null,first_event_ms:measuredTiming?.first_event_ms??null,first_token_ms:measuredTiming?.first_token_ms??null,final_persisted_result_ms:measuredTiming?.final_persisted_result_ms??null,
     timing_clock_observation:measuredTiming?{raw_wall_started_at:measuredTiming.raw_wall_started_at,raw_wall_started_at_sha256:measuredTiming.raw_wall_started_at_sha256,normalized_wall_started_at:measuredTiming.started_at,conversion:measuredTiming.wall_clock_conversion}:null,
     timing_unknown_reasons:measuredTiming?[]:['该次运行缺少完整阶段边界或单物理请求绑定，保留未知。'],
     actual,terminal_receipt:terminalReceipt,persisted_candidates:persisted,collector_attempts:observedCalls,physical_attempts:physical,source_storage_receipt,partial_observations:partialObservations??actual.partial_observations??null,
     runtime_sources:runtimeSources,
     deterministic_checks:{status:actual.status==='succeeded'?'passed':'failed',source_binding_sha256:digest(inputFor(member)),output_sha256:output?digest(output):null,runtime_sources_sha256:digest(runtimeSources)},reviews:[]});
    const record=records.at(-1);record.commit=arm==='old'?BASE:collectorBinding.source_commit;
    record.source_audit=actual.status==='succeeded'?auditReplyRuntimeSources(member,{...record,terminal_status:'succeeded'},output,'model_run'):{status:'undetermined',reason:actual.error??'terminal_not_successful'};
    if(actual.status==='succeeded'&&record.source_audit.status!=='verified')throw Error('source_audit_rejected:'+record.source_audit.reason);
    await onRecord?.(record);
   }
  }
  const profile=await readFile(join(host.home,'profiles/notalone/cordis.patch.yml'));
  await verifyFrozenSource(sourceBefore.manifest,candidateRoot);
  await verifyEvaluationRuntime(evaluationSource,evaluationRoot);
  for(const [name,hash]of Object.entries(legacyBudgetFiles))assert.equal(sha(await readFile(join(frozenSource,name))),hash,'legacy_budget_runtime_bytes_changed: '+name);
  for(const [name,hash]of Object.entries(legacySourceFiles))assert.equal(sha(await readFile(join(temporary,name))),hash,'legacy_source_after_execution');
  const workspaceAfter=await captureSource(ROOT);
  const workspaceChanged=digest(workspaceAfter.manifest.files)!==digest(originalSourceFiles);
  assert.equal(workspaceChanged,false,'execution_source_changed_during_capture');
  const dependenciesAfter=await captureDependencies(ROOT,PYTHON);assert.deepEqual(dependenciesAfter,dependenciesBefore,'runtime_dependency_version_or_entry_changed');
  return {schema_version:'reply-local-paired-collector-v1',protocol_version:'migration-comparison-v1',source_capture_version:'production_v2_actual_wire_pg',evidence_kind:localOnly?'localhost_fake_provider_actual_business_pipelines':'official_deepseek_full_comparison_v1',synthetic_only:true,real_model_quality_verified:false,production_switch_approved:false,
   ...policy?{execution_policy:policy,execution_policy_sha256:evaluationSource.execution_policy_sha256}:{},
   projection_version:'public-dto-three-channel-v2',planned:96,received:records.length,source_bindings:{dependencies_before:dependenciesBefore,dependencies_after:dependenciesAfter,dependency_snapshot_equal:true,old_commit:BASE,new_commit:sourceBefore.manifest.base_commit,
    manifest_sha256:sha(materials.manifestText),dataset_sha256:sha(materials.datasetText),dsh_commit:'687f282e8625c6b8d11ff58211a90524be2e4317',
    executed_profile:{raw_utf8:profile.toString('utf8')},old_profile:legacyProfile,old_profile_sha256:digest(legacyProfile),legacy_source_files:legacySourceFiles,collector_binding:collectorBinding,lock_sha256:sourceBefore.manifest.files['backend-ts/pnpm-lock.yaml'],python_lock_sha256:null,profile_sha256:sha(profile),collector_plugin_sha256:sha(pluginSource),new_source_files:sourceBefore.manifest.files,new_source_sha256:digest(sourceBefore.manifest.files),candidate_source_manifest:sourceBefore.manifest,candidate_execution:'fixed_source_copy_verified_before_and_after',workspace_commit_after:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),workspace_changed_during_execution:workspaceChanged,fixed_git_source_changed_during_execution:false,
    collector_source_files:Object.fromEntries(Object.entries(evaluationSource.files).filter(([name])=>name.startsWith('collector/')).map(([name,hash])=>[name.slice(10),hash])),evaluation_runtime_files:evaluationSource.files,evaluation_runtime_original_files:evaluationSource.original_files,evaluation_control_adaptations:[...evaluationSource.control_adaptations,pluginControlAdaptation],legacy_budget_runtime_files:legacyBudgetFiles,evaluation_runtime_sha256:digest(evaluationSource.files),evaluation_runtime_execution:'fixed_old_script_bridge_and_problem_budget_package_verified_before_and_after',controller_execution:'loaded_ESM_entry_snapshot_and_frozen_support_fixture_migrations_and_product_source'},
   environment:{os:platform(),arch:arch(),cpu:cpus()[0]?.model,memory_bytes:totalmem(),node:process.version,power_mode:null},
   arms_configuration_equal:false,configuration_unknown_reasons:['供应商协议分别为原OpenAI Chat与官方DSH Anthropic适配，工具schema/提示词需要另行做语义等价核验','实际usage缺失保留null；本机fake与真实采集明确区分，质量资格另行评审'],
   problem_budget:localOnly?{external_execution_enabled:false,ledger_created:false}:{problem_id:budgetConfiguration.budget.problem_id,round:budgetConfiguration.budget.round,ledger_path_redacted:true,external_execution_enabled:true,dispatch_boundary:'one_existing_problem_budget_reservation_before_each_physical_attempt'},
   records,cleanup:{own_database_dropped:true,own_profile_removed:true,own_python_exited:true}};
 }finally{
  const errors=[];
  const release=[async()=>{if(python)await python.close();},async()=>{if(provider){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}},...cleanups,closeFixture,()=>rm(temporary,{recursive:true,force:true})];
  for(const cleanup of release){try{await cleanup();}catch(error){errors.push(error);}}
  process.chdir(join(ROOT,'backend-ts'));
  if(errors.length)throw new AggregateError(errors,'成对采集清理或边界验证失败');
 }
}
