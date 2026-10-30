/** 一次明确讨论的执行壳；SQL资格、实际输入及发言提交均走具名业务动作。 */
import type {Context} from '@deepseek-ai/cordis';
import type {AgentHandle} from '@deepseek-ai/dsh-agent';
import {createUserMessage,ReasoningEffortId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import {renderSkillContent} from '@deepseek-ai/dsh-skill';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {SqliteSkillRun} from '../../skills/sqlite/provider.ts';
import type {SkillRunProtection,SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {discussionFinishFailure,type DiscussionFailureEvidence} from './failure.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {REPLY_EXECUTION_DEADLINE_MS} from '../generation/reply-execution-budget.ts';
import type {DiscussionAttempt} from './contracts.ts';
import type {SqliteDiscussionRuntime} from './runtime.ts';

export interface SingleDiscussionTurnOptions {
 runtime:Pick<SqliteDiscussionRuntime,'run'>;storage:Pick<SqliteStorage,'execute'>;
 attempt:DiscussionAttempt;contextId:string;callId:string;configurationDigest:string;
 prompt:string;rebuildPrompt?:string;systemPrompt:string;model:HostReplyModelConfiguration;
 provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;
 skillRun:SqliteSkillRun|null;skillProtection:SkillRunProtection;skillRevision:SkillRunRevision;
 commitAction?:'reply.commitCandidates';signal?:AbortSignal;
}
export interface SingleDiscussionTurnResult {text:string;copyId:string;callId:string;sessionEvent:SessionEvent<'assistant/message'>}
function fail(code='discussion_generation_failed'):never{throw new StorageFailure(code);}
function payload(options:GenerateOptions):object {
 const {signal:unused,...request}=options;void unused;
 // 保存真实DSH请求；不含认证头，也不声称这是适配后的逐字HTTP实体。
 return JSON.parse(JSON.stringify(request)) as object;
}

/** 调用前宿主已prepareCall；准备、取消与失败都不会自动重送模型请求。 */
export async function runSingleDiscussionTurn(options:SingleDiscussionTurnOptions):Promise<SingleDiscussionTurnResult>{
 const {attempt,callId,contextId,model}=options;
 if(!options.prompt.trim()||options.prompt.length>100_000||!options.systemPrompt.trim()
  ||!Number.isSafeInteger(model.deadline_ms)||model.deadline_ms<1||model.deadline_ms>REPLY_EXECUTION_DEADLINE_MS)fail('discussion_input_invalid');
 let dispatched=false,committed=false,failureEvidence:DiscussionFailureEvidence|undefined;
 const scope={ownerId:attempt.ownerId,contactId:attempt.contactId,callId};
 const deadline=new AbortController();let timer:NodeJS.Timeout|undefined;
 let permit:Awaited<ReturnType<ModelPermitArbiter['acquire']>>|undefined;
 const signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
 try{
  permit=await options.arbiter.acquire('foreground',signal);
  timer=setTimeout(()=>deadline.abort(new StorageFailure('discussion_generation_timeout')),model.deadline_ms);
  return await options.runtime.run(attempt,options.configurationDigest,async work=>{
   const combined=AbortSignal.any([signal,work.signal]);
   await options.storage.execute('runtime.incorporate',{...attempt,copyId:work.copy.id,contextId});
   let handle:AgentHandle|undefined,disposeSkill:(()=>void)|undefined;
   let failure:unknown,streamCalls=0,finished=false;
   const requireCurrent=async()=>{
    combined.throwIfAborted();
    await options.storage.execute('runtime.inspect',{...attempt,copyId:work.copy.id});
    await options.skillProtection.assertCurrent(scope,options.skillRevision,combined);
    combined.throwIfAborted();
   };
   const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort};
   const setup=async(agentCtx:Context)=>{
    agentCtx.tools.restrict({allow:[]});agentCtx.tools.guard(()=> 'discussion_tools_forbidden');
    agentCtx.on('agent/error',()=>{failure??=new StorageFailure('discussion_generation_failed');});
    agentCtx.on('agent/request',async(_position,next)=>({...await next(),temperature:model.temperature}));
    agentCtx.on('agent/request-error',async()=>undefined);
    agentCtx.on('agent/pre-step',async(_position,next)=>{
     if(streamCalls||failure)return {kind:'reject'};await requireCurrent();return next();
    });
    agentCtx.on('llm/stream',async function*(request,next):AsyncGenerator<StreamChunk>{
     if(request.sessionId!==work.sessionId){yield* next();return;}
     let call:ReturnType<SingleDiscussionTurnOptions['provider']['beginCall']>|undefined;
     try{
      await requireCurrent();if(++streamCalls!==1)fail('discussion_call_limit');
      if(request.provider!==binding.provider||request.model!==binding.model||request.maxTokens!==binding.maxTokens
       ||request.temperature!==binding.temperature||request.reasoningEffort!==binding.reasoningEffort||request.purpose!==undefined
       ||request.tools?.length)fail('discussion_model_configuration_changed');
      await options.skillRun?.validate(combined);
      const requestPayload=payload(request);
      call=options.provider.beginCall({sessionId:work.sessionId,attempt_id:callId,permit_id:permit!.id,binding,profile:model.budgetProfile,
       requireCurrent,beforeDispatch:async({budget})=>{
        await requireCurrent();await options.skillRun?.validate(combined);
        await options.storage.execute('discussion.dispatchCall',{...attempt,copyId:work.copy.id,callId,contextId,requestPayload,budget,skillRun:options.skillRevision});
       }});
      for await(const chunk of next()){
       combined.throwIfAborted();
       if(chunk.type==='finish'){
        if(chunk.reason.kind!=='stop'){
         failureEvidence=discussionFinishFailure(chunk.reason,call.observation().dispatch);
         fail('discussion_generation_failed');
        }
        finished=true;
       }
       yield chunk;
      }
      if(!finished)fail('discussion_generation_failed');
     }catch(error){failure=error;throw error;}
     finally{
      const observation=call?.observation();
      // 预约回调已进入但未确证结算时仍按可能授权处理；不能因断线猜测未发送。
      dispatched||=!!observation&&(observation.dispatch!=='not_authorized'||observation.before_dispatch_started!==false);
      call?.close();
     }
    });
    let skillText='';
    if(options.skillRun){
     disposeSkill=options.skillRun.mount(agentCtx);await options.skillRun.validate(combined);
     if(options.skillRun.selection){
      const registry=agentCtx.get('skills') as SkillRegistry|undefined;if(!registry)fail('discussion_skill_unavailable');
      const catalog=await registry.snapshot({scope:scopeOf(agentCtx),signal:combined});
      const available=catalog.skills.filter(item=>item.provider==='notalone-sqlite-skills');
      if(!catalog.complete||available.length!==1)fail('discussion_skill_unavailable');
      const loaded=await registry.get(available[0]!.name,{scope:scopeOf(agentCtx),signal:combined});
      if(!loaded||loaded.provider!=='notalone-sqlite-skills'||loaded.path!==available[0]!.path)fail('discussion_skill_unavailable');
      skillText='\n\n'+renderSkillContent(loaded);
     }
    }
    agentCtx.systemPrompt.section({name:'notalone-discussion',order:0,complete:true,interpolate:false,text:options.systemPrompt+skillText});
   };
   const cancel=()=>handle?.agent.cancel({kind:'disposed'});combined.addEventListener('abort',cancel,{once:true});
   try{
    await requireCurrent();
    const agentOptions={signal:combined,agentOptions:{provider:model.provider,model:model.model,maxTokens:model.maxTokens,reasoningEffort:ReasoningEffortId(model.reasoningEffort)},setup};
    handle=work.restoring?await work.driver.resumeAgent({...agentOptions,resumeSessionId:work.sessionId}):await work.driver.createAgent({...agentOptions,sessionId:work.sessionId});
    await requireCurrent();
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:work.restoring?options.prompt:options.rebuildPrompt??options.prompt}]}));
    await handle.agent.whenIdle();combined.throwIfAborted();if(failure)throw failure;
    if(streamCalls!==1||!finished)fail('discussion_generation_failed');
    await requireCurrent();await options.skillRun?.validate(combined);
    await handle.dispose();handle=undefined;
    const history=await work.driver.readHistory(work.sessionId);
    const start=work.copy.eventBoundary?JSON.parse(work.copy.eventBoundary).eventCount as number:0;
    const messages=history.events.slice(start).filter((event):event is SessionEvent<'assistant/message'>=>event.type==='assistant/message');
    if(messages.length!==1)fail('discussion_assistant_event_invalid');
    const event=messages[0]!;
    if(event.data.interrupted||event.data.message.source.provider!==model.provider||event.data.message.source.model!==model.model
     ||event.data.message.content.some(block=>block.type==='tool-call'))fail('discussion_assistant_event_invalid');
    const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
    if(!text.trim()||text.length>100_000)fail('discussion_assistant_event_invalid');
    await requireCurrent();
    await options.storage.execute(options.commitAction??'discussion.commitAssistant',{...attempt,copyId:work.copy.id,callId,contextId,text,sessionEvent:event,skillRun:options.skillRevision});
    committed=true;return {text,copyId:work.copy.id,callId,sessionEvent:event};
   }finally{
    combined.removeEventListener('abort',cancel);
    try{await handle?.dispose();}finally{disposeSkill?.();}
   }
  },signal);
 }catch(error){
  const code=signal.aborted?'discussion_generation_cancelled':error instanceof StorageFailure?error.code:'discussion_generation_failed';
  if(!committed)await options.storage.execute('discussion.failCall',{...attempt,callId,dispatched,code,...(failureEvidence?{failure:failureEvidence}:{})});
  throw new StorageFailure(code);
 }finally{clearTimeout(timer);options.skillRun?.close();permit?.settle();}
}
