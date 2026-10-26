/** 官方Agent真实请求的零HTTP容量预检；Adapter序列化之后无条件中断。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import {randomUUID} from 'node:crypto';
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createUserMessage,ReasoningEffortId,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {prepareBoundMessagesRequest,measureSerializedMessages,type MessagesBudgetBinding,type MessagesBudgetProfile,type MessagesBudgetReceipt} from '../../platform/models/model-input-budget.ts';
import {ReplyError} from './reply-contract.ts';
type Setup=NonNullable<Parameters<Context['agents']['create']>[0]['setup']>;
export interface ReplyPreflightInput {
 binding:MessagesBudgetBinding;profile:MessagesBudgetProfile;prompt:string;
 /** 必须与正式生成共用实际Agent安装函数，包含system、全部tools及Skill注册。 */
 setup:Setup;
 requireCurrent():Promise<void>;
 validateRegistry():Promise<void>;
}
/** 不领取模型许可、不写调用ledger、不解析凭据，也不进入生产provider。 */
export async function preflightReplyAgent(ctx:Context,input:ReplyPreflightInput,signal:AbortSignal):Promise<MessagesBudgetReceipt>{
 signal.throwIfAborted();
 const sessionId=SessionId(randomUUID()),providerAlias='notalone-preflight-'+randomUUID(),blocked=new Error('reply_preflight_serialized_no_dispatch');
 let receipt:MessagesBudgetReceipt|null=null,failure:unknown=null,calls=0;
 let handle:Awaited<ReturnType<Context['agents']['create']>>|undefined;
 const adapter=new DeepSeekAdapter({
   options:()=>resolveAdapterOptions({baseURL:'http://127.0.0.1:1/anthropic',maxTokens:input.binding.maxTokens,thinking:input.binding.reasoningEffort==='off'?'disabled':'enabled',retryPolicy:{mode:'normal',maxRetries:0}}),
   resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'notalone-preflight-local' as never,
   prepareExtensions:async request=>{
     signal.throwIfAborted();if(request.sessionId!==sessionId||++calls!==1)throw new ReplyError('reply_preflight_invalid',502);
     await input.requireCurrent();signal.throwIfAborted();
     try{receipt=measureSerializedMessages(prepareBoundMessagesRequest(request.body,input.binding).body,input.binding,input.profile);}catch(error){failure=error;throw error;}
     // 绝不返回extension或accept：此处成功也必须停止，不能到达HTTP发送。
     throw blocked;
   },
 });
 const unregister=ctx.llm.registerAdapter([providerAlias],adapter);
 const intercept=ctx.on('llm/stream',async function*(options,next):AsyncGenerator<StreamChunk>{
   if(options.sessionId!==sessionId){yield* next();return;}
   if(options.provider!==providerAlias||options.model!==input.binding.model||options.maxTokens!==input.binding.maxTokens||options.temperature!==input.binding.temperature||options.reasoningEffort!==input.binding.reasoningEffort){failure=new ReplyError('reply_model_configuration_changed',502);throw failure;}
   try{yield* next();}
   catch(error){if(!receipt&&!failure)failure=error;throw error;}
 });
 const cancel=()=>handle?.agent.cancel({kind:'disposed'});signal.addEventListener('abort',cancel,{once:true});
 try{
   await input.requireCurrent();
   handle=await ctx.agents.create({sessionId,signal,agentOptions:{provider:providerAlias,model:input.binding.model,maxTokens:input.binding.maxTokens,reasoningEffort:ReasoningEffortId(input.binding.reasoningEffort)},setup:input.setup});
   await input.validateRegistry();signal.throwIfAborted();
   handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input.prompt}]}));
   await handle.agent.whenIdle();signal.throwIfAborted();
   if(failure)throw failure;if(!receipt||calls!==1)throw new ReplyError('reply_preflight_unavailable',502);
   await input.requireCurrent();signal.throwIfAborted();return receipt;
 }finally{signal.removeEventListener('abort',cancel);try{await handle?.dispose();}finally{intercept();await unregister();}}
}
/** 仅首次准备可按旧顺序省略新增层；每次候选仍通过完整官方Agent序列化。 */
export async function fitPreparedReplyBudget<State extends {context:{owner_layered_context?:unknown;layered_context?:unknown}},Budget>(
 state:State,options:{frozen:boolean;signal:AbortSignal},measure:(state:State)=>Promise<Budget>,
):Promise<{state:State;budget:Budget}>{
 let current=state,last:unknown;
 try{options.signal.throwIfAborted();return {state:current,budget:await measure(current)};}catch(error){if((error as {code?:string})?.code!=='reply_budget_exceeded'||options.frozen)throw error;last=error;}
 for(const side of ['owner_layered','layered'] as const){
   options.signal.throwIfAborted();const field=side+'_context';if(!(current.context as Record<string,unknown>)[field])continue;
   current={...current,context:{...current.context,[field]:null,[side+'_status']:'budget_omitted'}};
   try{return {state:current,budget:await measure(current)};}catch(error){if((error as {code?:string})?.code!=='reply_budget_exceeded')throw error;last=error;}
 }
 throw last;
}
