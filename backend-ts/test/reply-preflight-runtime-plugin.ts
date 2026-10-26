/** 只验证官方Agent序列化；模型端点只作零HTTP哨兵。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {preflightReplyAgent,fitPreparedReplyBudget} from '../src/reply/generation/reply-preflight.ts';
import {registerReplyAgentSetup} from '../src/reply/generation/reply-loop.ts';
export const name='notalone-reply-preflight-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export function apply(ctx:Context){
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');try{
   let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);let disposal:(()=>void)|undefined,checks=0,executed=0;
   if(input.fit){
     const steps:string[]=[],state={context:{owner_layered_context:'本人背景'.repeat(2000),layered_context:'联系人背景'.repeat(50)}};
     const result=await fitPreparedReplyBudget(state,{frozen:!!input.frozen,signal:AbortSignal.timeout(3000)},async selected=>{
       steps.push(selected.context.owner_layered_context?'full':selected.context.layered_context?'contact':'none');
       return preflightReplyAgent(ctx,{binding:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',toolChoice:'any'},profile:{context_window_tokens:4096,safety_margin_tokens:128},prompt:'当前用户全文不得截断',requireCurrent:async()=>{},validateRegistry:async()=>{},async setup(scope){await registerReplyAgentSetup(scope,{system_prompt:'完整系统提示'+(selected.context.owner_layered_context??'')+(selected.context.layered_context??''),temperature:0},{tools:[],skillSession:null,executeOutput:async()=>{throw Error('不应执行');}});}},AbortSignal.timeout(3000));
     });res.end(JSON.stringify({steps,status:(result.state.context as Record<string,unknown>).owner_layered_status,receipt:result.budget}));return;
   }
   const tools=[defineTool({name:'conversation_search',description:'完整工具描述'.repeat(input.largeTool?2000:1),parameters:{query:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,result)=>[{type:'text',text:result}]},async execute(){executed++;throw Error('预检不应执行工具');}})];
   try{
     const receipt=await preflightReplyAgent(ctx,{binding:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',toolChoice:'any'},profile:{context_window_tokens:input.exceeded?100:65536,safety_margin_tokens:128},prompt:'完整合成用户输入',requireCurrent:async()=>{checks++;},validateRegistry:async()=>{},async setup(scope){disposal=await registerReplyAgentSetup(scope,{system_prompt:'完整合成系统上下文',temperature:0},{tools,skillSession:null,executeOutput:async()=>{executed++;throw Error('预检不应提交候选');}});}},AbortSignal.timeout(3000));
     res.end(JSON.stringify({receipt,checks,executed}));
   }finally{disposal?.();}
 }catch(error){res.statusCode=422;res.end(JSON.stringify({error:error instanceof Error?error.message:'failed'}));}});
 const ready=ctx.appReady!.onReady(()=>{server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${a.port}\n`);});});
 ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
}
