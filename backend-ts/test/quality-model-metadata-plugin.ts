/** 仅验证provider的strict实体计数；本机假HTTP，不是质量执行或产品caller。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {installModelProvider} from '../src/model-provider.ts';

export const name='quality-provider-metadata-only';
export const inject=['llm','appReady'];
export function apply(ctx:Context){
  const baseURL=process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!;
  const provider=installModelProvider(ctx,{provider:'synthetic-route',
    connection:resolveAdapterOptions({baseURL,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),
    resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-quality' as never,
    strictVerificationEndpoint:`${baseURL.replace(/\/anthropic$/,'')}/beta/chat/completions`});
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);
    let characters:number|undefined;
    const call=provider.beginStrictVerificationCall({sessionId:SessionId(randomUUID()),attempt_id:randomUUID(),permit_id:randomUUID(),
      binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
      profile:{context_window_tokens:32000,safety_margin_tokens:512},requireCurrent:async()=>{},beforeDispatch:async value=>{
        characters=value.request_entity_characters;
        if(input.limit!==undefined&&(characters===undefined||characters>input.limit))throw new Error('synthetic_entity_limit');
      }});
    let code='ok';
    try{await call.send({system:'合成中文😀',user:input.text,tool:{name:'SourceVerificationOutput',description:'合成核验',
      parameters:{type:'object',properties:{results:{type:'array',items:{type:'string'}}},required:['results']}},signal:new AbortController().signal});}
    catch(error){code=error instanceof Error?error.message:'synthetic_failed';}
    finally{call.close();}
    res.end(JSON.stringify({code,characters}));
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`QUALITY_MODEL_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.on('dispose',async()=>{ready();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await provider.dispose();});
}
