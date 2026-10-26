/** 仅用于合成物理预算验收，不进入产品 profile。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {createServer} from 'node:http';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {createL2ScenarioModel} from '../src/memory/scenarios/model.ts';

export const name='diagnostic-scenario-budget-synthetic';
export const inject=['llm','appReady'];
export function apply(ctx:Context) {
 const provider=installModelProvider(ctx,{provider:'synthetic-route',
  connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),
  resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-diagnostic' as never});
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
  const selectedProvider=input.legacyObservation?{...provider,beginCall:(...args:Parameters<typeof provider.beginCall>)=>{
   const call=provider.beginCall(...args);
   return {...call,observation:()=>{const value=call.observation();delete value.before_dispatch_started;return value;}};
  }}:provider;
  const model=createL2ScenarioModel({ctx,provider:selectedProvider,permit:{path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!}});
  try {
   const result=await model.call({...input,
    binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:8192,safety_margin_tokens:512},system:'合成整理',tools:[],
    messages:[{role:'user',content:[{type:'text',text:'合成 L2/L3'}]}],signal:new AbortController().signal,requireCurrent:async()=>{}});
   res.end(JSON.stringify(result));
  }catch(error){res.end(JSON.stringify({error:error&&typeof error==='object'&&'code'in error?error.code:'synthetic_scenario_failed'}));}
 });
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
  const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`DIAGNOSTIC_SCENARIO_READY http://127.0.0.1:${address.port}\n`);
 }));
 ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await provider.dispose();});
}
