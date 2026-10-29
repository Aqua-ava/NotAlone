import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

test('官方DSH经真实SQLite许可、认证HTTP和正常提取端口完成固定轮次，同key不重发且保留完整无产出追踪',{timeout:25000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-sqlite-memory-dsh-flow-'));
 const token=randomBytes(24).toString('base64url');let child,exited,provider,url,log='';const requests=[];let hangNext=false;const dispatched=Promise.withResolvers();
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){
   if(url)await fetch(`${url}/__fixture/stop`,{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});
   else child.kill('SIGTERM');
  }
  await exited;
  if(provider){provider.closeAllConnections();await new Promise(resolveClose=>provider.close(resolveClose));}
  await rm(directory,{recursive:true,force:true});
 });
 provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;requests.push({headers:req.headers,body:JSON.parse(raw)});
  if(hangNext){hangNext=false;dispatched.resolve();return;}
  const events=[{type:'message_start',message:{id:`synthetic-${requests.length}`,type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:3,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'tool_use',id:`synthetic-tool-${requests.length}`,name:'DirectMemoryExtractionOutput',input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"scenes":[]}'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 // 正式 sqlite.patch 尚无 llm；测试明确补此公开服务，仅替换业务宿主插件。
 const official=await readFile(new URL('../profile/sqlite.patch.yml',import.meta.url),'utf8');
 const missingLlm=!official.includes("name: '@deepseek-ai/dsh-llm'");
 const patch=official.replace('PLUGIN_PATH',JSON.stringify(resolve('test/fixtures/sqlite-memory-dsh-flow.ts')))+(missingLlm?"    - id: sqlite-memory-test-llm\n      name: '@deepseek-ai/dsh-llm'\n":'');
 await writeFile(join(profile,'cordis.patch.yml'),patch);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
   NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,NOTALONE_SYNTHETIC_HTTP_TOKEN:token},stdio:['ignore','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',value=>{log+=value;});
 const ready=await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error(log.slice(-1500))),10000);
  child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_MEMORY_DSH_READY (\{[^\n]+\})/);if(match){clearTimeout(timer);resolveReady(JSON.parse(match[1]));}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1500)));});
 });url=ready.url;
 const api=async(path,{body,method=body===undefined?'GET':'POST',auth=true}={})=>{
  const response=await fetch(`${url}${path}`,{method,headers:{...(auth?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
 };
 assert.equal((await api('/api/memory-processing/runs/current',{auth:false})).status,401);
 const requestKey=randomUUID();const first=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(first.status,200,JSON.stringify(first.data));
 assert.equal(first.data.total,2);assert.equal(first.data.inputs.length,2);assert.deepEqual(new Set(first.data.inputs.map(input=>input.contactId)),new Set(ready.contactIds));
 const replay=await api('/api/memory-processing/runs',{body:{request_key:requestKey}});assert.equal(replay.status,200);assert.equal(replay.data.runId,first.data.runId);
 const idle=await api('/__fixture/wait',{method:'POST'});assert.equal(idle.status,200,JSON.stringify(idle.data));assert.deepEqual(idle.data.integrity,{integrity:'ok',foreignKeys:'ok'});assert.equal(idle.data.readingEnabled,false);
 const normal=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(normal.status,'configured');assert.deepEqual(idle.data.normalModel,normal.model);
 const done=await api(`/api/memory-processing/runs/${first.data.runId}`);assert.equal(done.status,200);const traces=await Promise.all(done.data.tasks.filter(task=>task.scopeKind==='contact').map(async task=>({task,trace:(await api(`/api/memory-processing/tasks/${task.taskId}/events`)).data})));
 assert.equal(done.data.succeeded,2,JSON.stringify({supplierRequests:requests.length,traces:traces.map(({task,trace})=>({task,calls:trace.calls,events:trace.events.filter(event=>event.kind!=='model_input')})),logs:log.slice(-1000)}));assert.equal(done.data.candidates.length,0);assert.equal(done.data.failed,0);assert.equal(done.data.unknown,0);assert.equal(done.data.laterStages,'pending');assert.notEqual(done.data.state,'completed');
 assert.equal(requests.length,2);assert.ok(requests.every(request=>request.headers['x-api-key']==='synthetic-only'&&request.body.model===normal.model.model&&request.body.max_tokens===normal.model.maxTokens));
 for(const task of done.data.tasks.filter(task=>task.scopeKind==='contact')){
  const trace=await api(`/api/memory-processing/tasks/${task.taskId}/events`);assert.equal(trace.status,200);assert.equal(trace.data.calls.length,1);
  const call=trace.data.calls[0];assert.equal(call.state,'succeeded');assert.ok(BigInt(call.reservedBudgetUnits)>BigInt(normal.model.maxTokens));assert.equal(call.actualBudgetUnits,'10');
  assert.ok(trace.data.events.some(event=>event.kind==='model_input'&&event.payload.system&&event.payload.tool.name==='DirectMemoryExtractionOutput'));
  assert.ok(trace.data.events.some(event=>event.kind==='model_output'&&event.payload.blocks.some(block=>block.type==='tool-call')));
  assert.ok(trace.data.events.some(event=>event.kind==='stage_result'&&event.payload.outcome==='no_new_memory'));
  assert.ok(trace.data.events.every(event=>event.sources.length===1&&event.sources[0].contactId===task.contactId));
 }
 assert.equal((await api('/api/memory-processing/runs',{body:{request_key:requestKey}})).data.runId,first.data.runId);assert.equal(requests.length,2);
 // 未观察到响应的真实已派发调用，关闭后在同一SQLite和ModelHost重建端口。
 assert.equal((await api('/__fixture/add-message',{method:'POST'})).status,200);hangNext=true;
 const interrupted=await api('/api/memory-processing/runs',{body:{request_key:randomUUID()}});assert.equal(interrupted.status,200);assert.equal(interrupted.data.total,1);
 await dispatched.promise;assert.equal(requests.length,3);assert.equal((await api('/__fixture/restart-model',{method:'POST'})).status,200);
 const uncertain=await api(`/api/memory-processing/runs/${interrupted.data.runId}`);assert.equal(uncertain.data.succeeded,0);assert.equal(uncertain.data.unknown,1);
 const unknownTask=uncertain.data.tasks.find(task=>task.scopeKind==='contact');const unknownTrace=await api(`/api/memory-processing/tasks/${unknownTask.taskId}/events`);
 assert.equal(unknownTrace.data.calls.length,1);assert.equal(unknownTrace.data.calls[0].state,'unknown');assert.ok(BigInt(unknownTrace.data.calls[0].reservedBudgetUnits)>0n);assert.equal(unknownTrace.data.calls[0].actualBudgetUnits,null);
 await api(`/api/memory-processing/runs/${interrupted.data.runId}/continue`,{body:{}});await api('/__fixture/wait',{method:'POST'});assert.equal(requests.length,3);
 const next=await api('/api/memory-processing/runs',{body:{request_key:randomUUID()}});assert.equal(next.status,200);await api('/__fixture/wait',{method:'POST'});
 const stillUnknown=await api(`/api/memory-processing/runs/${next.data.runId}`);assert.equal(stillUnknown.data.succeeded,0);assert.equal(stillUnknown.data.unknown,1);assert.equal(requests.length,3,'新请求和手动继续均不能盲重发已派发未知效果');
 await api('/__fixture/stop',{method:'POST'});const [code,signal]=await exited;assert.equal(code,0,log.slice(-1500));assert.equal(signal,null);
 await assert.rejects(access(ready.businessRoot),error=>error.code==='ENOENT');
});
