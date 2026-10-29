import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteExtractionModelPort} from '../src/memory/sqlite/model-port.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {startModelHost} from '../src/platform/models/model-host.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

test('未配置模型不会建立提取端口或静默选择其他供应商',()=>{
  assert.throws(()=>createSqliteExtractionModelPort({configuration:{status:'unavailable',code:'reply_model_unconfigured'}}),
    error=>error.code==='extraction_model_unconfigured');
});

test('自有provider释放失败可重试同一端口，业务停止信号不恢复',async()=>{
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});let disposals=0;
 const port=createSqliteExtractionModelPort({ctx:{llm:{registerAdapter:()=>async()=>{if(++disposals===1)throw Error('合成adapter释放失败');}}},configuration,permit:{path:'/unused-synthetic-permit',token:'synthetic-only'},resolveUserId:()=> 'synthetic-anonymous',authorizePurpose:async()=>{}});
 await assert.rejects(port.close(),/合成adapter释放失败/);await port.close();await port.close();assert.equal(disposals,2);
 await assert.rejects(port.prepare({}, {signal:new AbortController().signal,requireCurrent:async()=>{},scope:{owner_id:randomUUID(),contact_id:randomUUID()}}),{code:'extraction_model_closed'});
});

test('官方DSH和真实ModelHost端口：用途、凭据、最终预算、未知禁重发与迟到资格', {timeout:25000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'na-sqlite-model-port-'));
  let host,child,exited,provider,failReceipt=false,rejectHTTP=false,requests=0;
  const reserved=new Map();
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await exited;await host?.shutdown();
    if(provider){provider.closeAllConnections();await new Promise(resolveClose=>provider.close(resolveClose));}
    await rm(directory,{recursive:true,force:true});
  });
  host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,
    infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting:{
      reserve:async receipt=>{assert.ok(receipt.input_budget.serialized_bytes>0);reserved.set(receipt.request_id,receipt);},
      recordReserved:async receipt=>{assert.ok(reserved.has(receipt.request_id));if(failReceipt)throw new Error('synthetic_ack_failure');reserved.delete(receipt.request_id);},
      unconfirmedRequests:async()=>[...reserved.keys()].sort(),
    }});
  provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests++;
    assert.equal(req.headers['x-api-key'],'synthetic-only');
    if(rejectHTTP){rejectHTTP=false;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'合成供应商原始正文不进入安全元数据'}}));return;}
    const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:3,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成输出'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
    res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve('test/fixtures/sqlite-memory-model-port.ts'))}\n`);
  child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
    cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
      NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,
      NOTALONE_MODEL_PERMIT_SOCKET:host.permit.path,NOTALONE_MODEL_PERMIT_TOKEN:host.permit.token},stdio:['ignore','pipe','pipe']});
  exited=once(child,'exit');let log='';child.stderr.on('data',value=>log+=value);
  const url=await new Promise((ready,reject)=>{
    const timer=setTimeout(()=>reject(new Error(log.slice(-1500))),10000);
    child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_MODEL_PORT_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if(match){clearTimeout(timer);ready(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1500)));});
  });
  const context={scope:{owner_id:randomUUID(),contact_id:randomUUID()},
    claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'extract_memory',worker_id:randomUUID(),lease_generation:1}};
  const call=async(body={})=>await(await fetch(url,{method:'POST',body:JSON.stringify({context:{...context,requestId:randomUUID(),attemptId:randomUUID()},...body})})).json();
  const prepared=await call({prepare:true});assert.equal(prepared.maxOutputTokens,512);assert.equal(prepared.maxInputTokens,126464);
  assert.match(prepared.configurationId,/^[a-f0-9]{64}$/);assert.equal(requests,0);
  const success=await call();assert.equal(success.text,'合成输出');assert.equal(success.receipt.outcome,'succeeded');assert.equal(requests,1);assert.equal(success.sharedCalls,1);
  const denied=await call({deny:true});assert.equal(denied.error,'synthetic_purpose_denied');assert.equal(requests,1);
  const noCredentials=await call({noCredentials:true});assert.equal(noCredentials.error,'extraction_model_credentials_unavailable');assert.equal(requests,1);
  const oversized=await call({oversized:true});assert.equal(oversized.error,'extraction_model_budget_exceeded');assert.equal(requests,1);
  const late=await call({lateDeletion:true});assert.equal(late.error,'synthetic_scope_deleted');assert.equal(requests,2);
  rejectHTTP=true;const authentication=await call();assert.equal(authentication.error,'extraction_model_call_failed');assert.deepEqual(authentication.providerFailure,{name:'LlmFailure',code:'AUTH',status:401});assert.equal(authentication.dispatch,'response_observed');assert.equal(authentication.outcome,'failed');assert.doesNotMatch(JSON.stringify(authentication),/合成供应商原始正文/);assert.equal(requests,3);
  const shared=await call({sharedProbe:true});
  assert.equal(shared.text,'合成输出');assert.equal(shared.sharedCalls,5);assert.equal(requests,4);
  // 未知许可必须保守占用；先验证临时端口关闭，再由原端口派发，不能靠新scope绕过未知占用。
  failReceipt=true;
  const unknownContext={...context,requestId:randomUUID(),attemptId:randomUUID()};
  const unknown=await call({context:unknownContext});assert.equal(unknown.error,'extraction_model_ack_unknown');assert.equal(requests,5,'关闭另一个提取端口后原端口仍复用宿主provider');
  const retried=await call({context:{...unknownContext,attemptId:randomUUID()}});assert.equal(retried.error,'extraction_model_recovery_unknown');assert.equal(requests,5);
  assert.equal((await call({close:true})).closed,true);
  assert.equal((await call()).error,'extraction_model_closed');assert.equal(requests,5);
});
