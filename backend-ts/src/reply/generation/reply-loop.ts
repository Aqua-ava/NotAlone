/** 官方 Agent/Tool 有界循环。一次输出只作结构/引用校验，不再请求语义复核。 */
import type {AssistantRuntimeLease} from '../runtime/assistant-runtime.ts';
import type {Context} from '@deepseek-ai/cordis';
import {createUserMessage,ReasoningEffortId,LlmError,type StreamChunk,type TokenUsage} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {defineTool,type ToolDefinition,type ToolRunContext} from '@deepseek-ai/dsh-tools';
import {randomUUID} from 'node:crypto';
import {ReplyError,ReplyOutputError,validateReplyCandidates,type ReplyCandidateInput} from './reply-contract.ts';
import {REPLY_EXECUTION_DEADLINE_MS} from './reply-execution-budget.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import {ModelInputBudgetError,type MessagesBudgetProfile,type MessagesBudgetReceipt} from '../../platform/models/model-input-budget.ts';
import type {ModelLedgerReceipt} from '../../platform/models/model-ledger.ts';
import type {ReplySkillSession} from './reply-skill-runtime.ts';
import {restoreReplyEvidenceAliases,type EvidenceAliases} from './reply-evidence-alias.ts';
export interface ReplyLoopInput {
  owner_id:string;contact_id:string;request_id:string;
  provider:string;model:string;maxTokens:number;temperature:number;reasoningEffort:'off'|'low'|'high'|'max';
  prompt:string;system_prompt:string;physical_limit:number;deadline_ms:number;candidate_limit?:1|2|3;
}
export interface ReplyLoopPorts {
  runtime?:AssistantRuntimeLease|null;
  requireCurrent():Promise<void>;
  acquire(signal:AbortSignal):Promise<{id:string;settle():Promise<void>}>;
  provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;
  budgetProfile:MessagesBudgetProfile;
  /** 最终序列化预算通过后、实际出站前，持久保留本次attempt及累计调用数。 */
  reserve(receipt:ModelLedgerReceipt,budget:MessagesBudgetReceipt,physicalLimit:number):Promise<void>;
  record(receipt:ModelLedgerReceipt):Promise<void>;
  skillSession:ReplySkillSession|null;
  /** 保存必须先于官方scope销毁，保证实际读取的Skill/资源仍可在提交事务复验。 */
  persist(candidates:readonly ReplyCandidateInput[],budgets:readonly MessagesBudgetReceipt[],signal:AbortSignal):Promise<void>;
  /** 闭包绑定已确认范围，只包含当前读取时仍有效的证据。 */
  evidenceIds():ReadonlySet<string>;
  aliases:EvidenceAliases;
  tools:readonly ToolDefinition[];
}
const allowed=new Set(['conversation_search','conversation_query','read_file','list_files','read_scenario']);
export function createReplyOutputTool(execute:(args:Record<string,unknown>,execution:ToolRunContext)=>Promise<string>):ToolDefinition{
 return defineTool({name:'ReplyRuntimeOutput',description:'提交有依据的候选，之后结束本轮。本轮候选上限见用户消息中的运行约束；存在明确未知或上下文风险时只提交一条；不得用额外候选补写未知事实、原因、心理、联系间隔或内部考虑。',
  parameters:{used_skill_version_id:{oneOf:[{type:'string'},{type:'null'}],required:true},candidates:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true},basis:{type:'string',required:true},citation_ids:{type:'array',required:true,items:{type:'string'}},risk_notes:{type:'array',required:true,items:{type:'string'}},messages:{type:'array',items:{type:'string'},default:[]}}}}},
  output:{schema:{type:'string'},render:(_args,result)=>[{type:'text',text:result}]},execute});
}
/** 正式生成与无HTTP预检共用真实system/工具schema，避免复制模板后计量漏项。 */
export async function registerReplyAgentSetup(scope:Context,input:Pick<ReplyLoopInput,'system_prompt'|'temperature'>,options:{tools:readonly ToolDefinition[];skillSession:ReplySkillSession|null;signal?:AbortSignal;executeOutput:(args:Record<string,unknown>,execution:ToolRunContext)=>Promise<string>}):Promise<(()=>void)|undefined>{
 if(options.tools.some(tool=>!allowed.has(tool.name))||new Set(options.tools.map(tool=>tool.name)).size!==options.tools.length)throw new ReplyError('reply_tools_invalid',502);
 const dispose=options.skillSession?.mount(scope);
 let selectedContent:string;try{selectedContent=await options.skillSession?.preloadSelected(options.signal)??'';}catch(error){dispose?.();throw error;}
 scope.systemPrompt.section({name:'notalone-reply',order:0,complete:true,interpolate:false,text:input.system_prompt+(options.skillSession?'\n\n本轮受控Skill目录：\n'+options.skillSession.catalogText():'')+(selectedContent?'\n\n'+selectedContent:'')});
 scope.on('agent/request',async(_position,next)=>({...await next(),temperature:input.temperature}));
 for(const tool of options.tools)scope.tools.register(tool);
 scope.tools.register(createReplyOutputTool(options.executeOutput));
 return dispose;
}
export async function generateReplyLoop(ctx:Context,input:ReplyLoopInput,ports:ReplyLoopPorts,outerSignal:AbortSignal):Promise<{candidates:ReplyCandidateInput[];budgets:MessagesBudgetReceipt[];eventCount:number}> {
  if(!Number.isSafeInteger(input.physical_limit)||input.physical_limit<1||!Number.isSafeInteger(input.deadline_ms)||input.deadline_ms<1||input.deadline_ms>REPLY_EXECUTION_DEADLINE_MS)throw new ReplyError('reply_budget_unavailable',502);
  if(ports.tools.some(t=>!allowed.has(t.name))||new Set(ports.tools.map(t=>t.name)).size!==ports.tools.length)throw new ReplyError('reply_tools_invalid',502);
  outerSignal.throwIfAborted();
  // 等待前台不消耗生成期限；整个循环只领取一次全局前台许可。
  const permit=await ports.acquire(outerSignal);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new ReplyError('reply_timeout',504)),input.deadline_ms);
  const signal=AbortSignal.any([outerSignal,controller.signal,...ports.skillSession?[ports.skillSession.runtime.signal]:[]]);
  ctx=ports.runtime?.ctx??ctx;
  const sessionId=ports.runtime?.sessionId??SessionId(randomUUID()),budgets:MessagesBudgetReceipt[]=[],candidateLimit=input.candidate_limit??3;
  let candidates:ReplyCandidateInput[]|null=null,calls=0,failure:unknown=null;
  let lastFinish:string|undefined,completionCallLimit=0;
  let handle:Awaited<ReturnType<Context['agents']['create']>>|undefined;
  let disposeSkill:(()=>void)|undefined;
  const intercept=ctx.on('llm/stream',async function*(options,next):AsyncGenerator<StreamChunk> {
    if(options.sessionId!==sessionId){yield* next();return;}
    let usage:TokenUsage|null=null,started=false,finished=false;
    let call:ReturnType<ReplyLoopPorts['provider']['beginCall']>|undefined;
    const receipt:ModelLedgerReceipt={attempt_id:randomUUID(),permit_id:permit.id,owner_id:input.owner_id,contact_id:input.contact_id,request_id:input.request_id,
      provider:options.provider,model:options.model,called_at:new Date().toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,
      cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
    const start=performance.now();
    try {
      signal.throwIfAborted();await ports.requireCurrent();signal.throwIfAborted();
      if(candidates||++calls>input.physical_limit)throw new ReplyError('reply_budget_exceeded',502);
      if(options.provider!==input.provider||options.model!==input.model||options.maxTokens!==input.maxTokens||options.temperature!==input.temperature||options.reasoningEffort!==input.reasoningEffort)throw new ReplyError('reply_model_configuration_changed',502);
      call=ports.provider.beginCall({sessionId,attempt_id:receipt.attempt_id,permit_id:permit.id,
        binding:{provider:input.provider,model:input.model,maxTokens:input.maxTokens,temperature:input.temperature,reasoningEffort:input.reasoningEffort,stop:options.stop,toolChoice:completionCallLimit?{name:'ReplyRuntimeOutput'}:'any'},
        profile:ports.budgetProfile,requireCurrent:ports.requireCurrent,
        beforeDispatch:async value=>{
          signal.throwIfAborted();
          await ports.reserve(structuredClone(receipt),value.budget,input.physical_limit);
          started=true;budgets.push(value.budget);
        }});
      for await(const chunk of next()) {
        if(chunk.type==='usage')usage=chunk.usage;
        if(chunk.type==='finish') {
          lastFinish=chunk.reason.kind;
          // 官方Adapter的非2xx不会触发accept；仅其可靠HTTP状态能证明响应已观测。
          if((chunk.reason.kind==='error'||chunk.reason.kind==='aborted')&&Number.isInteger(chunk.reason.failure.status)&&chunk.reason.failure.status!>=100&&chunk.reason.failure.status!<=599)receipt.dispatch='response_observed';
          if((chunk.reason.kind==='error'||chunk.reason.kind==='aborted')&&chunk.reason.failure.code==='CONTEXT_WINDOW_EXCEEDED')throw new ReplyError('provider_context_limit',409);
          if(!['stop','tool-calls'].includes(chunk.reason.kind))throw new ReplyError('reply_generation_failed',502);
          receipt.outcome='succeeded';
          finished=true;
        }
        yield chunk;
      }
      if(!finished)throw new ReplyError('reply_generation_failed',502);
    } catch(error) {
      if(error instanceof LlmError&&Number.isInteger(error.failure.status)&&error.failure.status!>=100&&error.failure.status!<=599)receipt.dispatch='response_observed';
      if(error instanceof LlmError&&error.failure.code==='CONTEXT_WINDOW_EXCEEDED')error=new ReplyError('provider_context_limit',409);
      failure=error;receipt.outcome=signal.aborted?'cancelled':'failed';throw error;
    }
    finally {
      receipt.latency_ms=Math.max(0,Math.floor(performance.now()-start));
      if(usage&&[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens??0,usage.cacheWriteTokens??0].every(n=>Number.isSafeInteger(n)&&n>=0))receipt.usage={input_tokens:usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0),output_tokens:usage.outputTokens,cache_read_tokens:usage.cacheReadTokens??0,cache_write_tokens:usage.cacheWriteTokens??0};
      const observation=call?.observation();
      if(observation?.budget_rejection)failure=new ModelInputBudgetError(observation.budget_rejection.code,observation.budget_rejection.receipt);
      if(observation?.dispatch==='http_accepted')receipt.dispatch='http_accepted';
      try{if(started)await ports.record(receipt);}catch(error){failure=error;throw error;}finally{call?.close();}
    }
  });
  const cancel=()=>handle?.agent.cancel({kind:'disposed'});
  signal.addEventListener('abort',cancel,{once:true});
  try {
    const agentOptions={signal,agentOptions:{provider:input.provider,model:input.model,maxTokens:input.maxTokens,reasoningEffort:ReasoningEffortId(input.reasoningEffort)},async setup(scope:Context){
      scope.on('agent/error',event=>{failure??=event.error;});
      scope.on('agent/pre-step',async (_position,next)=>{
        if(candidates||failure)return {kind:'reject'};
        if(completionCallLimit&&calls>=completionCallLimit){failure=new ReplyOutputError('output_missing');return {kind:'reject'};}
        if(calls>=input.physical_limit){failure=new ReplyError('reply_budget_exceeded',502);return {kind:'reject'};}
        signal.throwIfAborted();await ports.requireCurrent();return next();
      });
      scope.tools.guard(exec=>signal.aborted||candidates!==null?'reply_inactive':completionCallLimit&&exec.name!=='ReplyRuntimeOutput'?'reply_output_required':!allowed.has(exec.name)&&exec.name!=='ReplyRuntimeOutput'?'reply_tool_forbidden':undefined);
      scope.on('tools/result',(exec,result)=>{
        if(completionCallLimit&&exec.name!=='ReplyRuntimeOutput')failure??=new ReplyOutputError('output_missing');
        if(exec.name==='ReplyRuntimeOutput'&&result.isError)failure??=new ReplyOutputError('output_schema_invalid');
        return undefined;
      });
      disposeSkill=await registerReplyAgentSetup(scope,input,{signal,tools:ports.tools,skillSession:ports.skillSession,
        async executeOutput(args,exec){
          try {signal.throwIfAborted();await ports.requireCurrent();if(candidates||Object.keys(args).sort().join(',')!=='candidates,used_skill_version_id')throw new ReplyError('reply_candidates_rejected');const validated=validateReplyCandidates(restoreReplyEvidenceAliases(args,ports.aliases),ports.evidenceIds(),candidateLimit);const claim=args.used_skill_version_id;if(!(claim===null||typeof claim==='string'))throw new ReplyError('reply_candidates_rejected');if(ports.skillSession)await ports.skillSession.captureClaim(claim,signal);else if(claim!==null)throw new ReplyError('reply_candidates_rejected');signal.throwIfAborted();candidates=validated;exec.concludeTurn();return '候选已完成结构和引用校验。';}
          catch(error){failure=error instanceof ReplyError&&error.code==='reply_candidates_rejected'?new ReplyOutputError('output_candidates_invalid'):error;throw failure;}
        }});
    }};
    handle=ports.runtime?.resume?await ctx.agents.resume({...agentOptions,resumeSessionId:sessionId}):await ctx.agents.create({...agentOptions,sessionId});
    await ports.skillSession?.validateRegistry(signal);
    signal.throwIfAborted();
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input.prompt}]}));
    await handle.agent.whenIdle();
    signal.throwIfAborted();if(failure)throw failure;
    // 供应商可能忽略any并正常返回普通文本；只补一次指定工具提交，不放宽候选校验或总预算。
    if(!candidates&&lastFinish==='stop'&&calls>0&&calls<input.physical_limit){
      await ports.requireCurrent();signal.throwIfAborted();completionCallLimit=calls+1;
      handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'本轮尚未提交候选。请现在调用 ReplyRuntimeOutput 提交符合本轮要求的候选，保留依据与引用；不要再检索或只返回普通文本。'}]}));
      await handle.agent.whenIdle();
      signal.throwIfAborted();if(failure)throw failure;
    }
    if(!candidates||calls===0)throw new ReplyOutputError('output_missing');
    await ports.requireCurrent();
    await ports.persist(candidates,budgets,signal);
    return {candidates,budgets,eventCount:handle.agent.session.seq};
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',cancel);
    // 保留interceptor直到实际流与agent全部收尾；不得先释放全局许可。
    try {await handle?.dispose();}finally {try{disposeSkill?.();ports.skillSession?.close();}finally{intercept();await permit.settle();}}
  }
}
