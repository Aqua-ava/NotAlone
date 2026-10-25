/** 独立合成接口探针；仅在根明确归还运行窗口后执行。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url)), repo=process.cwd();
const arm=process.argv.includes('--base-red')?'base':'candidate';
const sha=b=>createHash('sha256').update(b).digest('hex');
const results=[];
const publicError=error=>String(error?.message??error).split(repo).join('<repo>').replace(/\/Users\/[^\s:]+/g,'<local-path>').slice(0,2000);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function port(value){const bus=new EventEmitter();return {value,bus,getState(){return this.value;},onStateChanged(fn){bus.on('change',fn);return()=>bus.off('change',fn);},emit(){bus.emit('change',this.value);}};}
function until(bus,predicate,label,ms=7000){
 if(predicate())return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const check=()=>{if(!predicate())return;clearTimeout(timer);bus.off('change',check);resolve();};
  const timer=setTimeout(()=>{bus.off('change',check);reject(new Error('有界观察未满足：'+label));},ms);
  bus.on('change',check);check();
 });
}
async function check(name,fn){
 const start=performance.now();
 try{const detail=await fn();results.push({name,state:'passed',elapsed_ms:performance.now()-start,...detail});}
 catch(error){results.push({name,state:'failed',elapsed_ms:performance.now()-start,error:publicError(error)});}
}
async function main(){
 assert.ok(process.argv.includes('--runtime-window-authorized'),'运行窗口尚未显式归还');
 const input=JSON.parse(await readFile(path.join(here,'frozen-sources.json'),'utf8'));
 const binding=JSON.parse(await readFile(path.join(here,'prepared-binding.json'),'utf8'));
 assert.equal(sha(await readFile(path.join(here,'frozen-sources.json'))),binding.frozen_source_bundle_sha256);
 assert.equal(sha(await readFile(path.join(repo,'.scratch/dsh-ts-migration/final-storage-review-input-v1/manifest.json'))),input.input_manifest_sha256);
 for(const item of binding.external_readonly_dependencies)assert.equal(sha(await readFile(path.join(repo,item.path))),item.sha256,'依赖变更：'+item.path);
 const sources={...input.sources,...(arm==='base'?input.baseline_overrides:{})};
 for(const [name,file] of Object.entries(sources))assert.equal(sha(Buffer.from(file.content)),file.sha256,'冻结源码变更：'+name);
 const require=createRequire(path.join(repo,'desktop/package.json'));
 const {build,stop}=require('esbuild');
 let output;
 try{output=await build({stdin:{contents:`
 export { PureTsSync } from './backend-ts/src/pure-ts-sync.ts';
 export { SyncPriorityController } from './desktop/src/main/sync/priority.ts';
 export { JsonClient } from './desktop/src/main/backend/json-client.ts';`,resolveDir:repo},
  bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',
  nodePaths:[path.join(repo,'backend-ts/node_modules'),path.join(repo,'desktop/node_modules')],
  banner:{js:`import { createRequire as _createRequire } from 'node:module'; const require=_createRequire(${JSON.stringify(path.join(repo,'backend-ts/package.json'))});`},
  plugins:[{name:'frozen-review-input',setup(build){
   build.onResolve({filter:/^\./},args=>{
    const importer=args.namespace==='frozen-review-input'?args.importer:path.relative(repo,args.importer||path.join(repo,'entry.ts'));
    const key=path.posix.normalize(path.posix.join(path.posix.dirname(importer),args.path));
    const found=[key,key+'.ts',key+'.tsx',key+'.js',key+'.json',key+'/index.ts'].find(name=>sources[name]);
    if(!found)throw new Error('冻结依赖缺失：'+key);
    return {path:found,namespace:'frozen-review-input'};
   });
   build.onLoad({filter:/.*/,namespace:'frozen-review-input'},args=>({contents:sources[args.path].content,
    loader:args.path.endsWith('.tsx')?'tsx':args.path.endsWith('.json')?'json':'ts',resolveDir:path.join(repo,path.dirname(args.path))}));
  }}]});}finally{stop();}
 // 编译服务已退出；运行中的产品代码不得启动任何进程或访问外部网络。
 for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>{throw new Error('探针禁止启动进程');};
 syncBuiltinESMExports();
 globalThis.fetch=()=>{throw new Error('探针禁止fetch');};
 const {PureTsSync,SyncPriorityController,JsonClient}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
 const owner='20000000-0000-4000-8000-000000000001', a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',c='10000000-0000-4000-8000-000000000003';
 const coverages=Array.from({length:337},(_,i)=>({binding_id:`30000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,contact_id:a,phase:i<7?'incomplete':'complete',failure_code:i<7?'local_history_missing':null,message_count:0,non_text_count:0,page_count:1,last_cursor:null,watermark_at:null,started_at:null,completed_at:null,updated_at:null}));
 const raw={enabled:true,phase:'active',bound_count:337,history_coverages:coverages,priority_contact_id:null,priority_last_success_at:null};
 const trace={commands:[],status:0,identity:0,contactQueries:0,published:0,hint:null,forced:undefined,drained:0};
 const storage={runtimeOwnerId:owner,
  async businessTransaction(work){return work({async query(sql,params){assert.match(sql,/SELECT external_id,status/);assert.deepEqual(params,[owner]);trace.identity++;return {rows:[{external_id:'synthetic_spec_account',status:'active'}]};}});},
  async businessReadTransaction(work){return work({async query(sql,params){assert.match(sql,/SELECT DISTINCT contact_id/);assert.deepEqual(params,[owner]);trace.contactQueries++;return {rows:[]};}});}};
 const incremental={
  async execute(method,url,body,assertCurrent,signal){assertCurrent();if(signal.aborted)return {status:503,body:{error:'runtime_stopping'}};assert.equal(method,'POST');assert.equal(url,'/api/runtime/sync-incremental/priority');assert.equal(body.owner_id,owner);assert.equal(body.account_scope,'synthetic_spec_account');assert.equal(body.channel,'wechat');assert.deepEqual(Object.keys(body).sort(),['account_scope','channel','owner_id','priority_contact_id']);trace.commands.push(structuredClone(body));if(trace.forced)return trace.forced;trace.hint=body.priority_contact_id;return {status:200,body:raw};},
  async status(assertCurrent){assertCurrent();trace.status++;return raw;},async invalidateAndDrain(){trace.drained++;}};
 const sync=await PureTsSync.create(storage,incremental,{publish(){trace.published++;}});
 const handle=(method,url,body,signal=new AbortController().signal)=>sync.handle(method,new URL(url,'http://localhost'),body,signal);
 await check('精确小ACK只表示登记且不投影读取成功',async()=>{
  const before={status:trace.status,contacts:trace.contactQueries,published:trace.published};
  const result=await handle('POST','/api/sync/priority?response=ack',{contact_id:a});
  assert.deepEqual(result,{status:200,body:{accepted:true,contact_id:a}});
  assert.deepEqual({status:trace.status,contacts:trace.contactQueries,published:trace.published},before);
  assert.equal(trace.hint,a);assert.equal(raw.priority_last_success_at,null);assert.equal(raw.priority_contact_id,null);
  return {ack_bytes:Buffer.byteLength(JSON.stringify(result.body)),history_rows:coverages.length};
 });
 if(arm==='base'){await sync.close();return;}
 await check('无参POST和GET保留同一大状态',async()=>{
  const post=await handle('POST','/api/sync/priority',{contact_id:b}),get=await handle('GET','/api/sync/status',undefined);
  assert.equal(post.status,200);assert.deepEqual(post.body,get.body);assert.equal(post.body.cli_history_coverages.length,337);
  const bytes=Buffer.byteLength(JSON.stringify(get.body));assert.ok(bytes>16384);assert.equal(get.body.cli_priority_last_success_at,null);
  return {legacy_state_bytes:bytes};
 });
 await check('拒绝非精确ACK查询及身份注入且不登记',async()=>{
  const before=trace.commands.length;
  for(const url of ['/api/sync/priority?response=ack&extra=1','/api/sync/priority?response=ack&response=ack','/api/sync/enable?response=ack'])assert.equal((await handle('POST',url,{contact_id:a})).status,400);
  for(const body of [{contact_id:a,owner_id:'foreign'},{contact_id:a,account_scope:'foreign'},null,[],{contact_id:'synthetic-invalid'}])assert.equal((await handle('POST','/api/sync/priority?response=ack',body)).status,400);
  assert.equal((await handle('GET','/api/sync/priority?response=ack',undefined)).status,404);
  assert.equal(trace.commands.length,before);
 });
 await check('登记失败与运行身份缺失不能回成功ACK',async()=>{
  trace.forced={status:409,body:{error:'sync_scope_mismatch'}};
  assert.deepEqual(await handle('POST','/api/sync/priority?response=ack',{contact_id:a}),trace.forced);
  trace.forced=undefined;storage.runtimeOwnerId=undefined;
  try{assert.deepEqual(await handle('POST','/api/sync/priority?response=ack',{contact_id:a}),{status:503,body:{error:'sync_unavailable'}});}
  finally{storage.runtimeOwnerId=owner;}
 });
 async function fixture(){
  const bus=new EventEmitter(),arrivals=[],completed=[],failures=[],optionsLog=[],gates=[];
  const control={mode:'normal',gate:undefined,mismatch:false,epoch:11,active:0,maxActive:0};
  const contacts=port({directoryPhase:'ready',contacts:[a,b,c].map(contactId=>({contactId})),selectedContactId:a});
  const syncPort=port({phase:'ready',report:{enabled:true}}),backendPort=port({});
  const tasks=new Set(),sockets=new Set();
  const server=createServer((req,res)=>{
   const cancelled=new AbortController(),abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
   const task=(async()=>{
    assert.equal(req.headers.authorization,'Bearer synthetic_spec_token');
    let text='';for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):undefined;
    const record={path:req.url,contact_id:body?.contact_id};arrivals.push(record);bus.emit('change');
    const mode=control.mode,gate=control.gate;
    if(gate&&(!gate.used)){gate.used=true;gates.push(gate);await gate.promise;}
    const result=await handle(req.method,req.url,body,cancelled.signal);
    const wire=mode==='large'?{padding:'合'.repeat(17000)}:result.body;
    if(!res.destroyed){res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify(wire));}
   })().catch(error=>{if(cancelled.signal.aborted)return;if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_probe_failed'}));}failures.push({kind:'fixture',message:publicError(error)});bus.emit('change');}).finally(()=>{req.off('aborted',abort);res.off('close',abort);tasks.delete(task);});tasks.add(task);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new JsonClient({port:server.address().port,token:'synthetic_spec_token'});
  const backend={getConnectionGeneration:()=>control.epoch,onStateChanged:fn=>backendPort.onStateChanged(fn),async requestJson(opts){
   optionsLog.push({path:opts.path,timeoutMs:opts.timeoutMs,maxResponseBytes:opts.maxResponseBytes});
   control.active++;control.maxActive=Math.max(control.maxActive,control.active);const epoch=control.epoch;
   try{const value=await client.perform(opts);const generation=control.mismatch?(control.mismatch=false,epoch-1):epoch;completed.push({contact_id:opts.body.contact_id,generation});return {generation,data:value.data};}
   catch(error){failures.push({kind:error.kind,code:error.code??null,contact_id:opts.body.contact_id});throw error;}
   finally{control.active--;bus.emit('change');}
  }};
  let coordinator;
  return {bus,arrivals,completed,failures,control,optionsLog,contacts,syncPort,
   start(){coordinator=new SyncPriorityController(backend,contacts,syncPort);},
   select(id){contacts.value.selectedContactId=id;contacts.emit();},
   hold(){const gate=deferred();control.gate=gate;return gate;},
   refresh(){syncPort.emit();},generation(){control.epoch++;backendPort.emit();},
   async close(){for(const gate of gates)gate.resolve();control.gate?.resolve();control.mode='normal';try{await coordinator?.dispose();}finally{client.cancelPending();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...tasks]);}},
  };
 }
 async function scenario(name,work){await check(name,async()=>{const f=await fixture();try{return await work(f);}finally{await f.close();}});}
 await scenario('初始清除在途只串行登记最后选择',async f=>{
  const gate=f.hold();f.start();await until(f.bus,()=>f.arrivals.length===1,'初始clear到达');f.select(b);f.select(c);assert.equal(f.arrivals.length,1);gate.resolve();
  await until(f.bus,()=>f.completed.some(row=>row.contact_id===c),'最新选择完成');await turn();
  assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null,c]);assert.equal(f.control.maxActive,1);
  assert.ok(f.optionsLog.every(row=>row.path==='/api/sync/priority?response=ack'&&row.timeoutMs===2000&&row.maxResponseBytes===16384));
  f.select('10000000-0000-4000-8000-000000009999');await until(f.bus,()=>f.completed.at(-1)?.contact_id===null,'目录外选择只清除');
  return {sequence:f.arrivals.map(row=>row.contact_id),max_parallel:f.control.maxActive,timeout_ms:2000,max_bytes:16384};
 });
 await scenario('超16KB回执仍拒绝且后续刷新不跳过clear',async f=>{
  f.control.mode='large';f.start();await until(f.bus,()=>f.failures.length===1,'大响应拒绝');await turn();
  assert.equal(f.failures[0].code,'response_too_large');assert.equal(f.control.epoch,11);assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null]);
  f.control.mode='normal';f.select(c);await until(f.bus,()=>f.completed.some(row=>row.contact_id===c),'大响应后恢复');
  assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null,null,c]);return {failure:f.failures[0].code,generation_unchanged:true};
 });
 await scenario('两秒网络期限失效后按最新选择重新clear',async f=>{
  const gate=f.hold(),start=performance.now();f.start();await until(f.bus,()=>f.failures.length===1,'原两秒期限触发');await turn();
  const elapsed=performance.now()-start;assert.equal(f.failures[0].kind,'connection');assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null]);
  gate.resolve();f.select(c);await until(f.bus,()=>f.completed.some(row=>row.contact_id===c),'超时后新目标完成');
  assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null,null,c]);return {observed_timeout_ms:elapsed,timeout_config_ms:2000};
 });
 await scenario('在途代际撤销后新代际重新clear且采用最新目标',async f=>{
  const gate=f.hold();f.start();await until(f.bus,()=>f.arrivals.length===1,'旧代际clear到达');f.select(b);f.generation();f.select(c);
  await until(f.bus,()=>f.completed.some(row=>row.contact_id===c&&row.generation===12),'新代际登记完成');
  gate.resolve();await turn();assert.equal(trace.hint,c);assert.equal(f.control.maxActive,1);assert.ok(f.failures.some(row=>row.kind==='cancelled'));
  assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null,null,c]);return {new_generation:12,old_request_cancelled:true,max_parallel:f.control.maxActive};
 });
 await scenario('错代际响应不确认为clear，显式关闭只登记null',async f=>{
  f.control.mismatch=true;f.start();await until(f.bus,()=>f.completed.length===1,'错代际回执到达');await turn();assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null]);
  f.refresh();await until(f.bus,()=>f.completed.some(row=>row.contact_id===a&&row.generation===11),'正确代际重试');assert.deepEqual(f.arrivals.map(row=>row.contact_id),[null,null,a]);
  f.syncPort.value={phase:'ready',busy:'disable',report:{enabled:true}};f.syncPort.emit();f.select(c);await until(f.bus,()=>f.completed.at(-1)?.contact_id===null,'关闭清除');await turn();
  assert.equal(f.arrivals.at(-1).contact_id,null);return {mismatched_receipt_ignored:true,disable_cleared:true};
 });
 assert.equal(trace.published,0);assert.equal(raw.priority_last_success_at,null);assert.equal(raw.priority_contact_id,null);
 await sync.close();assert.equal(trace.drained,1);
}
try{await main();}catch(error){results.push({name:'运行器前置或收尾',state:'failed',error:publicError(error)});}
const failed=results.filter(row=>row.state!=='passed').length;
console.log(JSON.stringify({schema_version:'independent-priority-interface-probe-v1',arm,state:failed?'failed':'passed',total:results.length,failed,results,scope:{synthetic_loopback_http:true,database:false,real_app:false,wechat:false,model_calls:0,product_host_starts:0,scope_store:'explicit_test_double_not_database_proof'}},null,2));
process.exitCode=failed?2:0;
