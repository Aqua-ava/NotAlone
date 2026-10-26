/** 官方profile验收：真实共享ModelHost，loopback原SDK；台账观察仅用于运行器边界。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createExplorationRuntime,type ExplorationRuntimeContext} from '../src/reply/exploration/exploration-runtime.ts';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {startModelHost} from '../src/platform/models/model-host.ts';
import type {ModelLedgerReceipt} from '../src/platform/models/model-ledger.ts';
export const name='notalone-exploration-runtime-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','appReady'];
export async function apply(ctx:Context){
 const home=process.env.HOME!,records:ModelLedgerReceipt[]=[],reservations:ModelLedgerReceipt[]=[];
 const host=await startModelHost({runtimeEnvironment:{},businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'synthetic.env')});
 const provider=installModelProvider(ctx,{provider:'notalone-exploration-test',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never});
 const controllers=new Set<AbortController>();let current=true;
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/health'){res.end(JSON.stringify({records,reservations,permits:host.arbiter.snapshot()}));return;}
  if(req.url==='/cancel'){for(const c of controllers)c.abort();res.end('{}');return;}
  if(req.url==='/revoke'){current=false;res.end('{}');return;}
  const controller=new AbortController();controllers.add(controller);
  try{
   let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
   const context:ExplorationRuntimeContext={owner_id:'10000000-0000-4000-8000-000000000001',contact_id:'20000000-0000-4000-8000-000000000001',request_id:body.request_id??randomUUID(),input:{scene:'initiate_conversation',purpose_hint:'了解最近近况',correction:'',requirements:'',answer:'',confirmed_intent:'',skill_mode:'auto'},evidence:[{evidence_id:'source-a',text:'最近有空吗'}],skill:body.skill??null};
   const runtime=createExplorationRuntime({ctx,provider,arbiter:host.arbiter,ledger:{reserve:async receipt=>{reservations.push(structuredClone(receipt));},record:async receipt=>{records.push(structuredClone(receipt));}},model:{provider:'notalone-exploration-test',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',physical_limit:2,deadline_ms:body.deadline_ms??8000,warning_ratio:0.8,budgetProfile:{context_window_tokens:body.exceeded?300:65536,safety_margin_tokens:128}}});
   const ports={requireCurrent:async()=>{if(!current)throw Error('exploration_context_invalidated');},validateSkill:async()=>{if(body.invalidSkill)throw Error('exploration_skill_invalidated');}};
   let selected:string|null=null;
   if(body.auto)selected=await runtime.selectSkill(context,{owner_id:context.owner_id,contact_id:context.contact_id,entries:body.empty?[]:[{version_id:'60000000-0000-4000-8000-000000000001',name:'合成策略',description:'帮助澄清联系目的'}]},ports,controller.signal);
   const result=await runtime.explore({...context,skill:selected?{version_id:selected,content:'合成策略只作本轮辅助，不确认意愿'}:context.skill},ports,controller.signal);
   res.end(JSON.stringify({selected,result}));
  }catch(error){res.statusCode=422;res.end(JSON.stringify({error:error instanceof Error?error.message:'exploration_failed'}));}
  finally{controllers.delete(controller);}
 });
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${a.port}\n`);}));
 ctx.effect(()=>async()=>{ready();await host.close(async()=>{for(const c of controllers)c.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});await provider.dispose();});
}
