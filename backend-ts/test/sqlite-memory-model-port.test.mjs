import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteExtractionModelPort} from '../src/memory/sqlite/model-port.ts';
import {createServer} from 'node:http';
import {createServer as createPermitSocketServer} from 'node:net';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash,randomFillSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {startModelHost} from '../src/platform/models/model-host.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import sharp from 'sharp';

for(const stop of ['调用取消','端口关闭'])test(`排队等待后台许可时${stop}会结束模型调用，不挂住停读`,{timeout:4000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-memory-permit-cancel-'));
 const path=join(directory,'p.sock'),sockets=new Set(),queued=Promise.withResolvers(),operations=[];let queuedSocket;
 const server=createPermitSocketServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  const lines=createInterface({input:socket});
  lines.on('line',line=>{
   const request=JSON.parse(line);operations.push(request.op);
   if(request.op==='unconfirmed_requests')socket.write(JSON.stringify({state:'unconfirmed_requests',request_ids:[],next_cursor:null})+'\n');
   else if(request.op==='acquire'){queuedSocket=socket;queued.resolve();}
  });
  socket.on('close',()=>lines.close());
 });
 server.listen(path);await once(server,'listening');
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
 let physicalCalls=0;
 const port=createSqliteExtractionModelPort({ctx:{llm:{prepareCall:async config=>({config,stream(){throw Error('排队期间不得发送模型请求');}})}},configuration,
  provider:{beginCall(){physicalCalls++;throw Error('排队期间不得预约模型请求');}},permit:{path,token:'synthetic-only'},authorizePurpose:async()=>{}});
 const controller=new AbortController();
 const invocation=port.invoke({purpose:'extraction',system:'合成提取要求',user:'合成聊天',tool:{name:'DirectMemoryExtractionOutput'}},
  {requestId:randomUUID(),attemptId:randomUUID(),scope:{owner_id:randomUUID(),contact_id:randomUUID()},
   claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'extract_memory',worker_id:randomUUID(),lease_generation:1},
   signal:controller.signal,requireCurrent:async()=>{},onReceipt:async()=>{throw Error('未获许可不能生成回执');}});
 const outcome=invocation.then(()=>({unexpectedSuccess:true}),error=>({error}));
 await queued.promise;
 const disconnected=once(queuedSocket,'close');
 const closing=stop==='端口关闭'?port.close():undefined;if(stop==='调用取消')controller.abort();
 await disconnected;
 let timer;
 const result=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),800);})]);
 clearTimeout(timer);
 assert.equal(result.timedOut,undefined,'取消已经关闭许可连接，但等待许可的模型调用仍未退出');
 assert.equal(result.unexpectedSuccess,undefined);
 assert.match(result.error.code,/^extraction_model_(cancelled|ack_unknown)$/);
 await (closing??port.close());
 assert.equal(physicalCalls,0);assert.deepEqual(operations,['unconfirmed_requests','acquire']);
});

test('未配置模型不会建立提取端口或静默选择其他供应商',()=>{
  assert.throws(()=>createSqliteExtractionModelPort({configuration:{status:'unavailable',code:'reply_model_unconfigured'}}),
    error=>error.code==='extraction_model_unconfigured');
});

test('未声明图片能力的模型在授权和HTTP前阻碍，不把实际图片降成占位文字',async()=>{
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
 configuration.provider.connection.models=configuration.provider.connection.models.map(model=>({...model,inputModalities:['text']}));
 let authorized=false;
 const port=createSqliteExtractionModelPort({ctx:{},configuration,provider:{},permit:{path:'/unused-synthetic-permit',token:'synthetic-only'},
  authorizePurpose:async()=>{authorized=true;}});
 const request={purpose:'extraction',system:'合成',user:'合成图片',tool:{name:'DirectMemoryExtractionOutput'},images:[{id:'synthetic',mimeType:'image/png',dataBase64:'eA=='}]};
 await assert.rejects(port.prepare(request,{scope:{owner_id:randomUUID(),contact_id:randomUUID()},signal:new AbortController().signal,requireCurrent:async()=>{}}),{code:'extraction_model_image_unsupported'});
 assert.equal(authorized,false);await port.close();
});

test('自有provider释放失败可重试同一端口，业务停止信号不恢复',async()=>{
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});let disposals=0;
 const port=createSqliteExtractionModelPort({ctx:{llm:{registerAdapter:()=>async()=>{if(++disposals===1)throw Error('合成adapter释放失败');}}},configuration,permit:{path:'/unused-synthetic-permit',token:'synthetic-only'},resolveUserId:()=> 'synthetic-anonymous',authorizePurpose:async()=>{}});
 await assert.rejects(port.close(),/合成adapter释放失败/);await port.close();await port.close();assert.equal(disposals,2);
 await assert.rejects(port.prepare({}, {signal:new AbortController().signal,requireCurrent:async()=>{},scope:{owner_id:randomUUID(),contact_id:randomUUID()}}),{code:'extraction_model_closed'});
});

test('官方DSH和真实ModelHost端口：用途、凭据、最终预算、未知禁重发与迟到资格', {timeout:25000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'na-sqlite-model-port-'));
  let host,child,exited,provider,failReceipt=false,rejectHTTP=false,requests=0;const payloads=[];
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
    let raw='';for await(const chunk of req)raw+=chunk;requests++;payloads.push({path:req.url,body:JSON.parse(raw)});
    if(req.url==='/strict/chat/completions')assert.equal(req.headers.authorization,'Bearer synthetic-only');
    else assert.equal(req.headers['x-api-key'],'synthetic-only');
    if(rejectHTTP){rejectHTTP=false;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'合成供应商原始正文不进入安全元数据'}}));return;}
    if(req.url==='/strict/chat/completions'){
      res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'synthetic-invalid-json',type:'function',function:{name:'SourceVerificationOutput',arguments:'{"results":[PRIVATE_SYNTHETIC_BROKEN'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:2}}));return;
    }
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
  const invalid=await call({verification:true,invalidOutput:true});
  assert.equal(invalid.error,'extraction_model_validation_failed');assert.equal(invalid.outcome,'failed');assert.equal(invalid.dispatch,'response_observed');assert.equal(requests,5);
  assert.deepEqual(invalid.rejection,{originalBytes:invalid.rejection.originalBytes,originalBlockCount:1,truncated:false,
    capturedHash:createHash('sha256').update('{"results":[PRIVATE_SYNTHETIC_BROKEN').digest('hex'),enumerable:false,publicHasRaw:false});
  assert.ok(invalid.rejection.originalBytes>0);assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE_SYNTHETIC_BROKEN|rejectedOutput/);
  failReceipt=false;
  const png=await sharp({create:{width:8,height:6,channels:4,background:{r:255,g:0,b:0,alpha:1}}}).png().toBuffer();
  const imageId=randomUUID(),images=[{id:imageId,mimeType:'image/png',dataBase64:png.toString('base64')}];
  const imageExtraction=await call({images});assert.equal(imageExtraction.receipt.outcome,'succeeded');assert.equal(requests,6);
  const imageVerification=await call({images,verification:true});assert.equal(imageVerification.receipt.outcome,'succeeded');assert.equal(requests,7);
  assert.deepEqual(imageExtraction.imageInputs,imageVerification.imageInputs);
  const manifest=imageExtraction.imageInputs[0];assert.equal(manifest.id,imageId);
  assert.equal(manifest.sourceSha256,createHash('sha256').update(png).digest('hex'));
  assert.deepEqual({width:manifest.width,height:manifest.height,frame:manifest.frame},{width:8,height:6,frame:0});
  const extractionImage=payloads[5].body.messages[0].content.find(block=>block.type==='image');
  assert.equal(extractionImage.source.type,'base64');assert.equal(extractionImage.source.media_type,'image/png');
  const actual=Buffer.from(extractionImage.source.data,'base64');
  assert.equal(createHash('sha256').update(actual).digest('hex'),manifest.requestSha256);
  const verificationImage=payloads[6].body.messages[1].content.find(block=>block.type==='image_url');
  assert.equal(verificationImage.image_url.url,'data:image/png;base64,'+extractionImage.source.data);
  assert.deepEqual(payloads.slice(5).map(payload=>payload.path),['/anthropic/v1/messages','/strict/chat/completions'],'图文调用不能产生Files API上传或额外HTTP重试');
  const malformed=await call({images:[{...images[0],dataBase64:Buffer.from('合成损坏图片').toString('base64')}]});
  assert.ok(malformed.error);assert.equal(requests,7,'坏图片在任何HTTP前失败');
  const noisy=await sharp(randomFillSync(Buffer.alloc(256*256*3)),{raw:{width:256,height:256,channels:3}}).png().toBuffer();
  const imageBudget=await call({images:[{id:randomUUID(),mimeType:'image/png',dataBase64:noisy.toString('base64')}]});
  assert.equal(imageBudget.receipt.outcome,'succeeded');assert.equal(requests,8);
  assert.ok(imageBudget.receipt.input_budget.serialized_bytes>131072,'完整实体仍包含所有真实图片字节');
  assert.ok(imageBudget.receipt.input_budget.input_tokens<131072,'base64字节由已核对尺寸的视觉token替代，不能冒充文字token');
  const repeated=await call({images:[...images,{...images[0],id:randomUUID()}]});assert.equal(requests,9);
  assert.equal(repeated.receipt.outcome,'succeeded');assert.equal(repeated.imageInputs.length,2);
  assert.equal(payloads[8].body.messages[0].content.filter(block=>block.type==='image').length,2,'同图在不同消息出现时分别保留所属引用');
  // 未知许可必须保守占用；先验证临时端口关闭，再由原端口派发，不能靠新scope绕过未知占用。
  failReceipt=true;
  const unknownContext={...context,requestId:randomUUID(),attemptId:randomUUID()};
  const unknown=await call({context:unknownContext});assert.equal(unknown.error,'extraction_model_ack_unknown');assert.equal(requests,10,'关闭另一个提取端口后原端口仍复用宿主provider');
  const retried=await call({context:{...unknownContext,attemptId:randomUUID()}});assert.equal(retried.error,'extraction_model_recovery_unknown');assert.equal(requests,10);
  assert.equal((await call({close:true})).closed,true);
  assert.equal((await call()).error,'extraction_model_closed');assert.equal(requests,10);
});
