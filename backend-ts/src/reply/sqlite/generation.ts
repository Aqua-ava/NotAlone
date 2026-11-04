import {installRelationshipDocumentTool,RELATIONSHIP_DOCUMENT_TOOL} from './document-tool.ts';
/** 一次明确讨论的执行壳；SQL资格、实际输入及发言提交均走具名业务动作。 */
import {createHash,randomUUID} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import type {AgentHandle} from '@deepseek-ai/dsh-agent';
import {createUserMessage,ReasoningEffortId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import {installReplySkillTools,REPLY_MODEL_CALL_LIMIT,ReplySkillUnavailable,isSkillReadFailure} from './skill-loop.ts';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import {renderSkillContent} from '@deepseek-ai/dsh-skill';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {SqliteSkillRun} from '../../skills/sqlite/provider.ts';
import type {SkillRunProtection,SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {discussionFinishFailure,type DiscussionFailureEvidence} from './failure.ts';
import {ModelInputBudgetError} from '../../platform/models/model-input-budget.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {REPLY_EXECUTION_DEADLINE_MS} from '../generation/reply-execution-budget.ts';
import type {DiscussionAttempt} from './contracts.ts';
import type {SqliteDiscussionRuntime} from './runtime.ts';

export interface SingleDiscussionTurnOptions {
 runtime:Pick<SqliteDiscussionRuntime,'run'> & Partial<Pick<SqliteDiscussionRuntime,'discard'>>;storage:Pick<SqliteStorage,'execute'>;
 attempt:DiscussionAttempt;contextId:string;callId:string;configurationDigest:string;
 prompt:string;rebuildPrompt?:string;systemPrompt:string;model:HostReplyModelConfiguration;
 provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;
 skillRun:SqliteSkillRun|null;openSkillRun?:()=>Promise<SqliteSkillRun>;skillProtection:SkillRunProtection;skillRevision:SkillRunRevision;
 commitAction?:'reply.commitCandidates';dispatchAction?:'reply.dispatchCall';onPhase?:(phase:'queued'|'preparing'|'generating'|'saving')=>void;onRuntimeAvailable?:()=>void;
 configurationForRevision?:(revision:SkillRunRevision)=>string;assertAuthorized?:()=>Promise<void>;signal?:AbortSignal;
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
 const {attempt,callId,model}=options;let contextId=options.contextId,skillRevision=options.skillRevision,configurationDigest=options.configurationDigest;
 let fallback=false,totalCalls=0,lastCopyId:string|undefined,lastPhysicalCallId=callId,retainedDocumentPrompt='',budgetRejected=false;
 if(!options.prompt.trim()||options.prompt.length>100_000||!options.systemPrompt.trim()
  ||!Number.isSafeInteger(model.deadline_ms)||model.deadline_ms<1||model.deadline_ms>REPLY_EXECUTION_DEADLINE_MS)fail('discussion_input_invalid');
 let dispatched=false,committed=false,failureEvidence:DiscussionFailureEvidence|undefined;
 const scope={ownerId:attempt.ownerId,contactId:attempt.contactId,callId};
 const deadline=new AbortController();let timer:NodeJS.Timeout|undefined;
 let permit:Awaited<ReturnType<ModelPermitArbiter['acquire']>>|undefined;
 const signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
 try{
  options.onPhase?.('queued');
  permit=await options.arbiter.acquire('foreground',signal);
  options.onPhase?.('preparing');
  timer=setTimeout(()=>deadline.abort(new StorageFailure('discussion_generation_timeout')),model.deadline_ms);
  for(;;){try{return await options.runtime.run(attempt,configurationDigest,async work=>{
   options.onRuntimeAvailable?.();
   lastCopyId=work.copy.id;
   const combined=AbortSignal.any([signal,work.signal]);
   await options.storage.execute('runtime.incorporate',{...attempt,copyId:work.copy.id,contextId});
   let handle:AgentHandle|undefined,disposeSkill:(()=>void)|undefined;
   let failure:unknown,streamCalls=0,finished=false;
   const skillRun=fallback?null:options.skillRun??await options.openSkillRun?.()??null;
   if(skillRun)options.skillRun=skillRun;
   const requireCurrent=async()=>{
    combined.throwIfAborted();
    await options.storage.execute('runtime.assertActive',{...attempt,copyId:work.copy.id});
    if(fallback){await options.assertAuthorized!();await options.storage.execute('discussion.assertSkillCall',{...attempt,contextId,callId,runRevision:skillRevision});}
    else await options.skillProtection.assertCurrent(scope,skillRevision,combined);
    combined.throwIfAborted();
   };
   const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort};
   const allowedToolNames=skillRun?skillRun.preloadOrigin!==null?['skill_resource']:['skill','skill_resource']:[];
   const setup=async(agentCtx:Context)=>{
    const documents=options.commitAction==='reply.commitCandidates'&&await options.storage.execute<boolean>('reply.documentToolAvailable',{...attempt,contextId});
    installReplySkillTools(agentCtx,skillRun,requireCurrent,error=>{failure??=error;},documents);
    if(documents)installRelationshipDocumentTool(agentCtx,range=>options.storage.execute('reply.readDocument',{...attempt,contextId,...range}),requireCurrent,error=>{failure??=error;});
    agentCtx.on('agent/error',()=>{failure??=new StorageFailure('discussion_generation_failed');});
    agentCtx.on('agent/request',async(_position,next)=>({...await next(),temperature:model.temperature}));
    agentCtx.on('agent/request-error',async()=>undefined);
    agentCtx.on('agent/pre-step',async(_position,next)=>{
     if(failure)return {kind:'reject'};if(totalCalls>=REPLY_MODEL_CALL_LIMIT){failure=new StorageFailure('discussion_call_limit');return {kind:'reject'};}await requireCurrent();return next();
    });
    agentCtx.on('llm/stream',async function*(request,next):AsyncGenerator<StreamChunk>{
     if(request.sessionId!==work.sessionId){yield* next();return;}
     let call:ReturnType<SingleDiscussionTurnOptions['provider']['beginCall']>|undefined,dispatchAuthorized=false;
     const physicalCallId=totalCalls===0?callId:randomUUID();let usage:unknown,finishReason:string|undefined;
     try{
      await requireCurrent();if(++totalCalls>REPLY_MODEL_CALL_LIMIT)fail('discussion_call_limit');streamCalls++;finished=false;
      if(request.provider!==binding.provider||request.model!==binding.model||request.maxTokens!==binding.maxTokens
       ||request.temperature!==binding.temperature||request.reasoningEffort!==binding.reasoningEffort||request.purpose!==undefined
       ||request.tools?.some(t=>![...allowedToolNames,...(documents?[RELATIONSHIP_DOCUMENT_TOOL]:[])].includes(t.name)))fail('discussion_model_configuration_changed');
      const requestPayload=payload(request);
      lastPhysicalCallId=physicalCallId;
      call=options.provider.beginCall({sessionId:work.sessionId,attempt_id:physicalCallId,permit_id:permit!.id,binding,profile:model.budgetProfile,
       requireCurrent,beforeDispatch:async({budget})=>{
        await requireCurrent();await skillRun?.validate(combined);
        await options.storage.execute(options.dispatchAction??'discussion.dispatchCall',{...attempt,copyId:work.copy.id,callId,contextId,requestPayload,budget,physicalCallId,skillRun:skillRevision});dispatchAuthorized=true;
        options.onPhase?.('generating');
       }});
      for await(const chunk of next()){
       combined.throwIfAborted();
       if(chunk.type==='usage')usage=chunk.usage;
       if(chunk.type==='finish'){
        finishReason=chunk.reason.kind;
        if(!['stop','tool-calls'].includes(chunk.reason.kind)){
         failureEvidence=discussionFinishFailure(chunk.reason,call.observation().dispatch);
         fail('discussion_generation_failed');
        }
        finished=chunk.reason.kind==='stop';
       }
       yield chunk;
      }
      if(!finishReason)fail('discussion_generation_failed');
      await options.storage.execute('discussion.settleStep',{...attempt,contextId,callId,physicalCallId,usage,reason:finishReason});
     }catch(error){failure=error;throw error;}
     finally{
      const observation=call?.observation();
      // 预算拒绝或本地发送前校验失败都没有取得持久发送授权，不计入物理请求。
      if(observation?.budget_rejection)budgetRejected=true;
      if(!dispatchAuthorized&&observation?.dispatch==='not_authorized'&&totalCalls>0)totalCalls--;
      // 只有持久发送授权已写入或适配器已进入发送后才按可能出站处理。
      dispatched||=dispatchAuthorized||observation?.dispatch==='authorized_unconfirmed'||observation?.dispatch==='http_accepted';
      call?.close();
     }
    });
    let skillText='',skillGuidance='本轮可按需组合多个相关Skill，也可以不用；Skill只影响表达方式，不提供联系人事实，不得覆盖本次意图。静态辅助资料须指定已加载Skill的准确名称和路径，本轮最多读取两份。';
    if(skillRun){
     disposeSkill=skillRun.mount(agentCtx);await skillRun.validate(combined);
     const preloaded=skillRun.preloadedSkills;
     if(preloaded.length){
      skillGuidance='以下回复策略已由宿主在本次请求前预加载，只影响表达方式，不提供联系人事实，不得覆盖本次意图。静态辅助资料须指定已预加载Skill的准确名称和路径，本轮最多读取两份。';
      skillText='\n\n'+preloaded.map(skill=>renderSkillContent({name:skill.name,provider:'notalone-sqlite-skills',resourceBase:{kind:'opaque',description:'仅允许本次修订清单内的只读文字资源'},content:skill.content})).join('\n\n');
     }else if(skillRun.selection){
      const registry=agentCtx.get('skills') as SkillRegistry|undefined;if(!registry)fail('discussion_skill_unavailable');
      const catalog=await registry.snapshot({scope:scopeOf(agentCtx),signal:combined});
      const available=catalog.skills.filter(item=>item.provider==='notalone-sqlite-skills');
      if(!catalog.complete||available.length!==1)fail('discussion_skill_unavailable');
      const loaded=await registry.get(available[0]!.name,{scope:scopeOf(agentCtx),signal:combined});
      if(!loaded||loaded.provider!=='notalone-sqlite-skills'||loaded.path!==available[0]!.path)fail('discussion_skill_unavailable');
      skillText='\n\n'+renderSkillContent(loaded);
     }
    }
    agentCtx.systemPrompt.section({name:'notalone-discussion',order:0,complete:true,interpolate:false,text:options.systemPrompt+' '+skillGuidance+skillText});
   };
   const cancel=()=>handle?.agent.cancel({kind:'disposed'});combined.addEventListener('abort',cancel,{once:true});
   try{
    await requireCurrent();
    const agentOptions={signal:combined,agentOptions:{provider:model.provider,model:model.model,maxTokens:model.maxTokens,reasoningEffort:ReasoningEffortId(model.reasoningEffort)},setup};
    handle=work.restoring?await work.driver.resumeAgent({...agentOptions,resumeSessionId:work.sessionId}):await work.driver.createAgent({...agentOptions,sessionId:work.sessionId});
    await requireCurrent();
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:(work.restoring?options.prompt:options.rebuildPrompt??options.prompt)+retainedDocumentPrompt}]}));
    await handle.agent.whenIdle();combined.throwIfAborted();if(failure)throw failure;
    if(streamCalls<1||!finished)fail('discussion_generation_failed');
    options.onPhase?.('saving');
    await requireCurrent();await skillRun?.validate(combined);
    await handle.dispose();handle=undefined;
    const history=await work.driver.readHistory(work.sessionId);
    const start=work.copy.eventBoundary?JSON.parse(work.copy.eventBoundary).eventCount as number:0;
    const messages=history.events.slice(start).filter((event):event is SessionEvent<'assistant/message'>=>event.type==='assistant/message');
    const finalMessages=messages.filter(e=>!e.data.message.content.some(b=>b.type==='tool-call'));
    if(finalMessages.length!==1)fail('discussion_assistant_event_invalid');
    const event=finalMessages[0]!;
    if(event.data.interrupted||event.data.message.source.provider!==model.provider||event.data.message.source.model!==model.model
     ||event.data.message.content.some(block=>block.type==='tool-call'))fail('discussion_assistant_event_invalid');
    const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
    if(!text.trim()||text.length>100_000)fail('discussion_assistant_event_invalid');
    await options.storage.execute(options.commitAction??'discussion.commitAssistant',{...attempt,copyId:work.copy.id,callId,physicalCallId:lastPhysicalCallId,contextId,text,sessionEvent:event,skillRun:skillRevision});
    committed=true;return {text,copyId:work.copy.id,callId,sessionEvent:event};
   }finally{
    combined.removeEventListener('abort',cancel);
    try{await handle?.dispose();}finally{disposeSkill?.();}
   }
  },signal,options.commitAction==='reply.commitCandidates'||!!options.skillRevision.eligible.length||fallback);}catch(error){
   const skillBudgetFailed=!!options.skillRun?.revision.eligible.length&&(budgetRejected||error instanceof ModelInputBudgetError);
   const skillFailed=skillBudgetFailed||error instanceof ReplySkillUnavailable||isSkillReadFailure(error)||isSkillReadFailure(options.skillRun?.failure);
   if(fallback||!skillFailed||totalCalls>=REPLY_MODEL_CALL_LIMIT||!options.runtime.discard||!options.assertAuthorized||!lastCopyId)throw error;
   signal.throwIfAborted();await options.assertAuthorized();
   if(options.commitAction)await options.storage.execute('reply.assertInputWithoutSkill',{...attempt,contextId});
   await options.runtime.discard(attempt,lastCopyId);
   const dropped=await options.storage.execute<{contextId:string;newRevision:SkillRunRevision;documentInputs?:{itemNo:number;text:string}[]}>(options.commitAction?'reply.dropSkill':'discussion.dropSkill',{...attempt,contextId,callId});
   retainedDocumentPrompt=dropped.documentInputs?.length?'\n\n已读取的实际输入材料（编号保持，用于basis）：\n'+dropped.documentInputs.map(item=>`[${item.itemNo}] document\n${item.text}`).join('\n\n'):'';
   contextId=dropped.contextId;skillRevision=dropped.newRevision;configurationDigest=options.configurationForRevision?.(skillRevision)??createHash('sha256').update(options.configurationDigest+'no-skill').digest('hex');
   options.skillRun?.close();fallback=true;
  }}
 }catch(error){
  const code=deadline.signal.aborted?'discussion_generation_timeout':signal.aborted?'discussion_generation_cancelled':error instanceof StorageFailure?error.code:'discussion_generation_failed';
  if(!committed)await options.storage.execute('discussion.failCall',{...attempt,callId,dispatched,code,...(failureEvidence?{failure:failureEvidence}:{})});
  throw new StorageFailure(code);
 }finally{clearTimeout(timer);options.skillRun?.close();permit?.settle();}
}
