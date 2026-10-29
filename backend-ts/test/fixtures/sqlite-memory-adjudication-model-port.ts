import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createSqliteAdjudicationModelPort,type SqliteAdjudicationModelPurpose} from '../../src/memory/sqlite/management/model-port.ts';
import {resolveHostReplyConfiguration} from '../../src/host/host-reply-config.ts';
import {installModelProvider} from '../../src/platform/models/model-provider.ts';

export const name='sqlite-memory-adjudication-model-port-synthetic';
export const inject=['llm','appReady'];
const toolNames={adjudication:'BatchMemoryAdjudicationOutput',relation_verification:'BatchMemoryRelationVerificationOutput',merge_verification:'MergedMemoryVerificationOutput'} as const;
export function apply(ctx:Context) {
  const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  if(base.status!=='configured')throw new Error('synthetic_configuration_unavailable');
  let deny=false,credentials=true,current=true,sharedCalls=0,disposals=0;
  const configuration={...base,model:{...base.model,maxTokens:512,
    budgetProfile:{context_window_tokens:131072,safety_margin_tokens:4096}},provider:{...base.provider,
    connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),
    resolveAuth:async()=>({headers:credentials?{'x-api-key':'synthetic-only'}:{}})}};
  const registered=installModelProvider(ctx,{...configuration.provider,resolveUserId:()=> 'synthetic-anonymous' as never});
  const sharedProvider={...registered,beginCall(input:Parameters<typeof registered.beginCall>[0]){
    if('purpose' in input)throw new Error('synthetic_provider_purpose_disguised');
    sharedCalls++;return registered.beginCall(input);
  },async dispose(){disposals++;await registered.dispose();}};
  const createPort=()=>createSqliteAdjudicationModelPort({ctx,configuration,provider:sharedProvider,
    permit:{path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!},
    authorizePurpose:async()=>{if(deny)throw new Error('synthetic_purpose_denied');}});
  const port=createPort();
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    deny=Boolean(input.deny);credentials=!input.noCredentials;current=true;
    const purpose=(input.purpose??'adjudication') as SqliteAdjudicationModelPurpose;
    const toolName=toolNames[purpose];
    const request={purpose,system:'合成裁决提示',user:input.oversized?'合成'.repeat(300000):input.wait?'合成待关闭':'合成候选',
      tool:{name:input.toolName??toolName,description:'合成裁决',parameters:input.parameters??{title:toolName,type:'object',properties:{}}},
      validateOutput:()=>{if(input.invalidOutput)throw Object.assign(new Error('synthetic_invalid_output'),{failure_kind:'invalid_output'});}};
    let checks=0;
    const context={...input.context,signal:new AbortController().signal,
      requireCurrent:async()=>{checks++;if(!current||input.revokeBeforeDispatch&&checks>=4)throw new Error('synthetic_scope_deleted');},
      onReceipt:async()=>{if(input.lateDeletion)current=false;}};
    try{
      if(input.close){await port.close();res.end(JSON.stringify({closed:true,disposals}));return;}
      if(input.sharedProbe){const probe=createPort();try{const result=await probe.invoke(request,context);res.end(JSON.stringify({...result,sharedCalls,disposals}));}finally{await probe.close();}return;}
      if(input.prepare){res.end(JSON.stringify(await port.prepare(request,context)));return;}
      const result=await port.invoke(request,context);res.end(JSON.stringify({...result,sharedCalls,checks}));
    }catch(error){res.end(JSON.stringify({error:error&&typeof error==='object'&&'code'in error?error.code:error instanceof Error?error.message:'synthetic_unknown',
      ...((error as any)?.receipt?{receipt:(error as any).receipt}:{})}));}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`SQLITE_ADJUDICATION_MODEL_PORT_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await port.close();await registered.dispose();});
}
