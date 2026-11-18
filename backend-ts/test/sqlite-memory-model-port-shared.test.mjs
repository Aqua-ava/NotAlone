import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createSqliteExtractionModelPort} from '../src/memory/sqlite/model-port.ts';
import {createSqliteAdjudicationModelPort} from '../src/memory/sqlite/management/model-port.ts';
import {createSqliteDocumentsModelPort} from '../src/memory/sqlite/documents/model-port.ts';

// 三个记忆模型端口共用的凭据校验与关闭语义；错误码前缀各自保持不变。
const ownerId=randomUUID();
const idle=()=>({signal:new AbortController().signal,requireCurrent:async()=>{}});
const ports={
  extraction:{closed:'extraction_model_closed',credentials:'extraction_model_credentials_unavailable',
    create:configuration=>createSqliteExtractionModelPort({ctx:{},configuration,provider:{},permit:{},authorizePurpose:async()=>{}}),
    request:()=>({purpose:'extraction',system:'合成',user:'合成聊天',tool:{name:'DirectMemoryExtractionOutput'}}),
    scope:()=>({owner_id:ownerId,contact_id:randomUUID()})},
  adjudication:{closed:'adjudication_model_closed',credentials:'adjudication_model_credentials_unavailable',
    create:configuration=>createSqliteAdjudicationModelPort({ctx:{},configuration,provider:{},permit:{},authorizePurpose:async()=>{}}),
    request:()=>({purpose:'adjudication',system:'合成',user:'合成候选',validateOutput:()=>{},
      tool:{name:'BatchMemoryAdjudicationOutput',description:'合成裁决',parameters:{title:'BatchMemoryAdjudicationOutput',type:'object'}}}),
    scope:()=>({owner_id:ownerId,contact_id:null})},
  documents:{closed:'document_model_closed',credentials:'document_model_credentials_unavailable',
    create:configuration=>createSqliteDocumentsModelPort({ctx:{},configuration,provider:{},permit:{},ownerId}),
    request:()=>({system:'合成',user:'合成',messages:[],tools:[{name:'synthetic'}],validateOutput:()=>{}}),
    scope:()=>({owner_id:ownerId,contact_id:null})},
};
const configured=resolveAuth=>{
  const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  if(resolveAuth)configuration.provider.resolveAuth=resolveAuth;
  return configuration;
};

for(const [name,port] of Object.entries(ports))test(`${name}端口：鉴权头缺失、空白或含换行时以本端口错误码拒绝，合法头放行`,async()=>{
  const headersOf=headers=>async()=>({headers});
  for(const resolveAuth of [async()=>null,async()=>({}),headersOf({}),headersOf({'x-other':'value'}),headersOf({'x-api-key':'   '}),
    headersOf({authorization:'Bearer a\nb'}),headersOf({'X-Api-Key':'k\r'}),headersOf({authorization:7})]) {
    const instance=port.create(configured(resolveAuth));
    try{await assert.rejects(instance.prepare(port.request(),{scope:port.scope(),...idle()}),{code:port.credentials});}
    finally{await instance.close();}
  }
  for(const header of ['X-API-Key','Authorization']) {
    const instance=port.create(configured(async()=>({headers:{[header]:'synthetic-secret'}})));
    try{
      const prepared=await instance.prepare(port.request(),{scope:port.scope(),...idle()});
      assert.match(prepared.configurationId,/^[a-f0-9]{64}$/);assert.ok(prepared.maxInputTokens>0);
    }finally{await instance.close();}
  }
});

for(const [name,port] of Object.entries(ports))test(`${name}端口：close() 先取消并排空在途调用再完成，幂等，之后拒绝新调用`,async()=>{
  const release=Promise.withResolvers(),started=Promise.withResolvers();
  const instance=port.create(configured(async()=>({headers:{authorization:'synthetic-secret'}})));
  const input={scope:port.scope(),signal:new AbortController().signal,requireCurrent:async()=>{started.resolve();await release.promise;}};
  // 提取端口只追踪 invoke，其余端口也追踪 prepare；统一用 invoke 的首步阻塞在 requireCurrent。
  const call=instance.invoke(port.request(),{...input,requestId:randomUUID(),attemptId:randomUUID(),claim:{},onReceipt:async()=>{}});
  const outcome=call.then(()=>({ok:true}),error=>({error}));
  await started.promise;
  let closed=false;const closing=instance.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'在途调用未结束前 close() 不能完成');
  release.resolve();await closing;
  assert.equal(closed,true);
  const result=await outcome;
  assert.equal(result.ok,undefined,'关闭后在途调用不得成功');
  await instance.close();
  await assert.rejects(instance.prepare(port.request(),{scope:port.scope(),...idle()}),{code:port.closed});
});
