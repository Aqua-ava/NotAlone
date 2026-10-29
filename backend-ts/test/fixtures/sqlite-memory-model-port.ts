import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createSqliteExtractionModelPort} from '../../src/memory/sqlite/model-port.ts';
import {resolveHostReplyConfiguration} from '../../src/host/host-reply-config.ts';
import {DIRECT_EXTRACTION_SCHEMA} from '../../src/memory/extraction/prompts.ts';

export const name='sqlite-memory-model-port-synthetic';
export const inject=['llm','appReady'];
export function apply(ctx:Context) {
  const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  if(base.status!=='configured')throw new Error('synthetic_configuration_unavailable');
  let deny=false,credentials=true,current=true;
  const configuration={...base,model:{...base.model,maxTokens:512,
    budgetProfile:{context_window_tokens:131072,safety_margin_tokens:4096}},provider:{...base.provider,
    connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:512,
      retryPolicy:{mode:'normal',maxRetries:0}}),
    resolveAuth:async()=>({headers:credentials?{'x-api-key':'synthetic-only'}:{}})}};
  const port=createSqliteExtractionModelPort({ctx,configuration,
    permit:{path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!},
    resolveUserId:()=> 'synthetic-anonymous' as never,
    authorizePurpose:async()=>{if(deny)throw new Error('synthetic_purpose_denied');}});
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    deny=Boolean(input.deny);credentials=!input.noCredentials;current=true;
    const request={purpose:'extraction' as const,system:'合成提取提示',user:input.oversized?'合成'.repeat(300000):'合成消息',
      tool:{name:DIRECT_EXTRACTION_SCHEMA.title,description:'合成提取',parameters:DIRECT_EXTRACTION_SCHEMA},
      validateOutput:()=>{}};
    const context={...input.context,signal:new AbortController().signal,
      requireCurrent:async()=>{if(!current)throw new Error('synthetic_scope_deleted');},
      onReceipt:async()=>{if(input.lateDeletion)current=false;}};
    try{
      if(input.close){await port.close();res.end(JSON.stringify({closed:true}));return;}
      if(input.prepare){res.end(JSON.stringify(await port.prepare(request,context)));return;}
      const result=await port.invoke(request,context);
      res.end(JSON.stringify({text:result.text,receipt:result.receipt}));
    }catch(error){res.end(JSON.stringify({error:error&&typeof error==='object'&&'code'in error?error.code:
      error instanceof Error?error.message:'synthetic_unknown',...((error as any)?.provider_failure?{providerFailure:(error as any).provider_failure}:{}),...((error as any)?.receipt?{dispatch:(error as any).receipt.dispatch,outcome:(error as any).receipt.outcome}:{})}));}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`SQLITE_MODEL_PORT_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await port.close();});
}
