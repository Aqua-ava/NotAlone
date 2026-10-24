import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {SessionId} from '@deepseek-ai/dsh-session';
import {installModelProvider} from '../src/model-provider.ts';
export const name='model-provider-synthetic-validation';
export const inject=['llm','appReady'];
export function apply(ctx:Context) {
  const connection=resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}});
  const model=installModelProvider(ctx,{provider:'synthetic-official',connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never});
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    const signal=new AbortController(),sessionId=SessionId(randomUUID());
    const binding={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off' as const};
    let reserved=0;
    const call=input.unregistered?undefined:model.beginCall({sessionId,attempt_id:randomUUID(),permit_id:randomUUID(),binding,
      profile:{context_window_tokens:8192,safety_margin_tokens:512},requireCurrent:async()=>{},beforeDispatch:async()=>{reserved++;if(input.cancelBeforeDispatch)signal.abort();}});
    let failure=false;
    try { for await(const chunk of ctx.llm.stream({...binding,sessionId,signal:signal.signal,messages:[{role:'user',content:[{type:'text',text:input.text??'合成'}]}]})){if(chunk.type==='finish'&&chunk.reason.kind!=='stop')failure=true;} }
    catch { failure=true; }
    const observation=call?.observation();call?.close();
    res.setHeader('content-type','application/json');res.end(JSON.stringify({failure,reserved,observation}));
  });
  const ready=ctx.appReady!.onReady(()=>{server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`MODEL_PROVIDER_READY http://127.0.0.1:${address.port}\n`);
  });});
  ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await model.dispose();});
}
