/** 仅供合成官方profile验收；不进入产品profile。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {createServer} from 'node:http';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/model-provider.ts';
import {createExtractionModelCaller,ExtractionModelError,extractionUnconfirmedRequests,recordExtractionModelReceipt} from '../src/extraction-model.ts';
export const name='extraction-model-synthetic';export const inject=['llm','appReady'];
export function apply(ctx:Context) {
 const providerOptions={connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never};
 const provider=installModelProvider(ctx,{...providerOptions,provider:'synthetic-route'});
 const wrongProvider=installModelProvider(ctx,{...providerOptions,provider:'undeclared-route'});
 const permit={path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!};
 const caller=createExtractionModelCaller({ctx,provider,permit});
 const wrongCaller=createExtractionModelCaller({ctx,provider:wrongProvider,permit});
 const server=createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(Buffer.concat(parts).toString());
  let callbacks=0,checks=0;
  try {
   if(input.op==='unconfirmed') {res.end(JSON.stringify({ids:await extractionUnconfirmedRequests(permit,input)}));return;}
   if(input.op==='record') {await recordExtractionModelReceipt(permit,input.receipt);res.end('{}');return;}
   const controller=new AbortController();
   const result=await (input.wrongLedger?wrongCaller:caller).call({...input,binding:{provider:input.wrongLedger?'undeclared-route':'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},profile:{context_window_tokens:8192,safety_margin_tokens:512},messages:[{role:'user',content:[{type:'text',text:input.oversized?'合成'.repeat(10000):input.providerStatus?`FAIL_${input.providerStatus}`:'合成'}]}],signal:controller.signal,requireCurrent:async()=>{checks++;if(input.cancelBeforeDispatch&&checks===3)controller.abort();if(input.revokeBeforeDispatch&&checks>=3)throw new Error('synthetic_source_stale');if(input.lateInvalid&&checks>=4)throw new Error('synthetic_source_stale');},validateOutput:async blocks=>{if(input.validationReject)throw Object.assign(new Error('synthetic_validation_rejected'),{failure_kind:'invalid_output'});},costForUsage:()=>({status:'known',amount:'0.0001',currency:'CNY',pricing_version:'synthetic-v1'}),onReceipt:async()=>{callbacks++;if(input.receiptCallbackFailure)throw new Error('synthetic_receipt_callback_failed');}});
   res.end(JSON.stringify({...result,callbacks,checks}));
  }catch(error){res.end(JSON.stringify({error:error instanceof ExtractionModelError?error.code:input.receiptCallbackFailure?'synthetic_receipt_callback_failed':'extraction_model_source_stale',receipt:error instanceof ExtractionModelError?error.receipt:null,retryable:error instanceof ExtractionModelError?error.retryable:false,provider_failure:error instanceof ExtractionModelError?error.provider_failure:null,callbacks,checks}));}
 });
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`EXTRACTION_MODEL_READY http://127.0.0.1:${a.port}\n`);}));
 ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await provider.dispose();await wrongProvider.dispose();});
}
