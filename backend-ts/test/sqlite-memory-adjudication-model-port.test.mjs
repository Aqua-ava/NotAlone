import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSqliteAdjudicationModelPort} from '../src/memory/sqlite/management/model-port.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {startModelHost} from '../src/platform/models/model-host.ts';
import {validateModelLedgerReceipt} from '../src/platform/models/model-ledger.ts';

const tools={adjudication:'BatchMemoryAdjudicationOutput',relation_verification:'BatchMemoryRelationVerificationOutput',merge_verification:'MergedMemoryVerificationOutput'};
const request=(purpose='adjudication')=>({purpose,system:'合成裁决提示',user:'合成候选',
  tool:{name:tools[purpose],description:'合成裁决',parameters:{title:tools[purpose],type:'object',properties:{}}},validateOutput:()=>{}});
const input=()=>({scope:{owner_id:randomUUID(),contact_id:null},signal:new AbortController().signal,requireCurrent:async()=>{}});

test('裁决端口要求已配置模型和宿主共享provider，不注册新provider',()=>{
  assert.throws(()=>createSqliteAdjudicationModelPort({configuration:{status:'unavailable',code:'reply_model_unconfigured'}}),{code:'adjudication_model_unconfigured'});
  const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  assert.throws(()=>createSqliteAdjudicationModelPort({configuration,authorizePurpose:async()=>{}}),{code:'adjudication_model_configuration_invalid'});
});

test('prepare限定真实purpose与schema，所有目的共用相同预算身份，关闭不释放共享provider',async()=>{
  const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  let disposed=0,authorized=0,current=0;
  const port=createSqliteAdjudicationModelPort({ctx:{},configuration,provider:{dispose:()=>{disposed++;}},permit:{path:'/synthetic-unused',token:'synthetic-only'},authorizePurpose:async()=>{authorized++;}});
  const context={...input(),requireCurrent:async()=>{current++;}};
  const prepared=await Promise.all(Object.keys(tools).map(purpose=>port.prepare(request(purpose),context)));
  assert.equal(new Set(prepared.map(value=>value.configurationId)).size,1);
  assert.match(prepared[0].configurationId,/^[a-f0-9]{64}$/);assert.ok(prepared[0].maxInputTokens>0);
  for(const invalid of [{...request(),purpose:'extraction'},{...request(),tool:{...request().tool,name:tools.merge_verification}}])
    await assert.rejects(port.prepare(invalid,context),{code:'adjudication_model_purpose_invalid'});
  for(const invalid of [{...request(),tool:{...request().tool,parameters:{title:'Other',type:'object'}}},{...request(),validateOutput:undefined}])
    await assert.rejects(port.prepare(invalid,context),{code:'adjudication_model_schema_invalid'});
  assert.equal(authorized,3);assert.equal(current,3);
  await port.close();await port.close();assert.equal(disposed,0);
  await assert.rejects(port.prepare(request(),context),{code:'adjudication_model_closed'});
});

test('官方DSH与唯一ModelHost：三种裁决purpose、owner/contact回执、预算、资格与关闭排空', {timeout:25000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'na-sqlite-adjudication-port-'));
  let host,child,exited,provider,requests=0,failReceipt=false;
  const reserved=new Map(),receipts=[],claims=[];
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await exited;await host?.shutdown();
    if(provider){provider.closeAllConnections();await new Promise(resolveClose=>provider.close(resolveClose));}
    await rm(directory,{recursive:true,force:true});
  });
  host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,
    infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting:{
      reserve:async(receipt,claim)=>{validateModelLedgerReceipt(receipt);assert.ok(receipt.input_budget.serialized_bytes>0);reserved.set(receipt.request_id,receipt);claims.push(claim);},
      recordReserved:async receipt=>{validateModelLedgerReceipt(receipt);assert.ok(reserved.has(receipt.request_id));if(failReceipt)throw new Error('synthetic_ack_failure');reserved.delete(receipt.request_id);receipts.push(receipt);},
      unconfirmedRequests:async()=>[...reserved.keys()].sort(),
    }});
  provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests++;
    assert.equal(req.headers['x-api-key'],'synthetic-only');
    const body=JSON.parse(raw);assert.equal(body.tools.length,1);assert.ok(Object.values(tools).includes(body.tools[0].name));
    const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:3,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成裁决输出'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
    res.setHeader('content-type','text/event-stream');
    if(raw.includes('合成待关闭')){res.write(`event: message_start\ndata: ${JSON.stringify(events[0])}\n\n`);provider.emit('synthetic-wait');return;}
    res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve('test/fixtures/sqlite-memory-adjudication-model-port.ts'))}\n`);
  child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
    cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',
      NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`,
      NOTALONE_MODEL_PERMIT_SOCKET:host.permit.path,NOTALONE_MODEL_PERMIT_TOKEN:host.permit.token},stdio:['ignore','pipe','pipe']});
  exited=once(child,'exit');let log='';child.stderr.on('data',value=>log+=value);
  const url=await new Promise((ready,reject)=>{
    const timer=setTimeout(()=>reject(new Error(log.slice(-1500))),10000);
    child.stdout.on('data',value=>{log+=value;const match=log.match(/SQLITE_ADJUDICATION_MODEL_PORT_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);ready(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1500)));});
  });
  const scope={owner_id:randomUUID(),contact_id:null};
  const claim={task_id:randomUUID(),step_id:randomUUID(),step_name:'adjudicate_memory',worker_id:randomUUID(),lease_generation:1};
  const context=()=>({scope,claim,requestId:randomUUID(),attemptId:randomUUID()});
  const call=async(body={})=>await(await fetch(url,{method:'POST',body:JSON.stringify({context:context(),...body})})).json();
  const prepared=await call({prepare:true});assert.equal(prepared.maxOutputTokens,512);assert.equal(prepared.maxInputTokens,126464);assert.equal(requests,0);
  for(const purpose of Object.keys(tools)){
    const success=await call({purpose,context:{...context(),claim:{...claim,step_name:purpose}}});
    assert.equal(success.text,'合成裁决输出');assert.equal(success.receipt.outcome,'succeeded');
    assert.equal(success.receipt.contact_id,null);assert.equal(success.receipt.scope_kind,'owner_memory');
    assert.ok(success.checks>=4);assert.equal(claims.at(-1).step_name,purpose);
  }
  const contact=await call({context:{...context(),scope:{...scope,contact_id:randomUUID()}}});
  assert.equal(contact.receipt.scope_kind,'contact');assert.match(contact.receipt.contact_id,/^[a-f0-9-]{36}$/);
  assert.equal(requests,4);assert.equal(receipts.length,4);assert.equal(reserved.size,0);
  assert.equal((await call({purpose:'extraction'})).error,'adjudication_model_purpose_invalid');
  assert.equal((await call({toolName:tools.merge_verification})).error,'adjudication_model_purpose_invalid');
  assert.equal((await call({parameters:{title:'Other',type:'object'}})).error,'adjudication_model_schema_invalid');
  assert.equal((await call({deny:true})).error,'synthetic_purpose_denied');
  assert.equal((await call({noCredentials:true})).error,'adjudication_model_credentials_unavailable');
  assert.equal((await call({oversized:true})).error,'extraction_model_budget_exceeded');
  assert.equal((await call({revokeBeforeDispatch:true})).error,'extraction_model_call_failed');assert.equal(requests,4);
  const invalidOutput=await call({invalidOutput:true});assert.equal(invalidOutput.error,'extraction_model_validation_failed');assert.equal(invalidOutput.receipt.outcome,'failed');assert.equal(requests,5);
  assert.equal((await call({lateDeletion:true})).error,'synthetic_scope_deleted');assert.equal(requests,6);
  const waiting=once(provider,'synthetic-wait',{signal:AbortSignal.timeout(5000)}),pending=call({wait:true});await waiting;
  const closed=await call({close:true});assert.equal(closed.closed,true);assert.equal(closed.disposals,0);
  const cancelled=await pending;assert.equal(cancelled.error,'extraction_model_cancelled');
  assert.equal((await call()).error,'adjudication_model_closed');
  const shared=await call({sharedProbe:true});assert.equal(shared.text,'合成裁决输出');assert.equal(shared.disposals,0);
  assert.equal(requests,8);assert.equal(shared.receipt.scope_kind,'owner_memory');
  failReceipt=true;const unknownContext=context();
  assert.equal((await call({sharedProbe:true,context:unknownContext})).error,'extraction_model_ack_unknown');assert.equal(requests,9);
  assert.equal((await call({sharedProbe:true,context:{...unknownContext,attemptId:randomUUID()}})).error,'extraction_model_recovery_unknown');assert.equal(requests,9);
});
