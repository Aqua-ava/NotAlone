/** 正式 DSH profile 的合成候选插件；只替换本机联络渠道和模型传输。 */
import type {Context} from '@deepseek-ai/cordis';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {SqliteStorage} from '../../../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../../../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../../../src/history/sqlite/service.ts';
import {SqliteSkillLibrary} from '../../../src/skills/sqlite/library.ts';
import {SqliteDiscussionService} from '../../../src/reply/sqlite/service.ts';
import {SqliteDiscussionRuntime} from '../../../src/reply/sqlite/runtime.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {SqliteReplyCandidateService} from '../../../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../../../src/reply/sqlite/candidates/turns.ts';
import {installModelProvider} from '../../../src/platform/models/model-provider.ts';
import {ModelPermitArbiter} from '../../../src/platform/models/model-permits.ts';
import {resolveHostReplyConfiguration} from '../../../src/host/host-reply-config.ts';
const owner='00000000-0000-4000-8000-000000000001';
const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
export const name='notalone-skill-precall-profile-fixture';
export const inject=['skills','llm'];
export async function apply(ctx:Context):Promise<void>{
 const root=process.env.NOTALONE_PRECALL_PROFILE_DIR!;if(!root)throw new Error('profile fixture directory missing');
 const cleanups:Array<()=>Promise<void>>=[];
 ctx.effect(()=>async()=>{for(const cleanup of cleanups.reverse())await cleanup();});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});cleanups.push(()=>storage.close());
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>[{externalKey:'synthetic-contact',displayName:'合成联系人',kind:'private',identityAssurance:'verified'}]} as const;
 const contacts=new SqliteContactService(storage,owner,metadata);await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const candidate=await contacts.candidates(true);await contacts.confirm(candidate.snapshot_token,candidate.sessions.map(session=>({locator:session.username,observed_display_name:session.display_name,expected_selection_generation:session.selection_generation})));
 const contactId=(await contacts.directory()).contacts[0].contact_id;
 const channel={
  inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),
  target:async scope=>({protocol:'private-history-v1',descriptor:`synthetic-target-${scope.conversationKey}`,partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'}),
  page:async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'合成正式 profile 聊天。',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['shard-a'],exhausted:true}),
 } as const;
 const holders=new ActiveHolders(),history=new SqliteHistoryService(storage,contacts,channel as any,holders);cleanups.push(()=>history.close());
 await contacts.setReading(true);await history.synchronize(contactId);
 const skillRoot=join(root,'user-skills');await mkdir(join(skillRoot,'gentle'),{recursive:true});
 await writeFile(join(skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成 profile 策略\n---\n先回应感受，再说明情况。\n');
 const library=new SqliteSkillLibrary(storage,owner,skillRoot);cleanups.push(()=>library.close());
 let skill=await library.discover('gentle');skill=await library.setEnabled(skill.id,skill.headRevision,'enabled');
 {const group=await library.createGroup('合成分组',[skill.id]);await library.assignContactGroup(contactId,group.id,null);}
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});if(configuration.status!=='configured')throw new Error('synthetic host configuration unavailable');
 const connection=resolveAdapterOptions({baseURL:process.env.NOTALONE_PRECALL_PROVIDER_URL!,thinking:configuration.provider.connection.defaults.thinking,maxTokens:configuration.model.maxTokens,retryPolicy:{mode:'normal',maxRetries:0}});
 const provider=installModelProvider(ctx,{provider:'synthetic-official',connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});cleanups.push(()=>provider.dispose());
 const model={...configuration.model,provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off' as const,physical_limit:1,deadline_ms:5000,warning_ratio:0.8,budgetProfile:{context_window_tokens:8192,safety_margin_tokens:512}};
 const discussions=new SqliteDiscussionService(storage,owner),runtime=new SqliteDiscussionRuntime({storage,ownerId:owner,userData:root,ctx,holders});cleanups.push(()=>runtime.close());await runtime.initialize();
 const service=new SqliteReplyCandidateService(storage,owner),turns=new SqliteReplyTurns({storage,service,discussions,runtime,model,provider,arbiter:new ModelPermitArbiter(),library,authorize:async()=>{}});cleanups.push(()=>turns.close());
 const discussion=await discussions.newDiscussion(contactId),startedAt=performance.now();
 await turns.generate({contactId,discussionId:discussion.id,requestKey:crypto.randomUUID(),text:'请帮我写一条合成回复',confirmedContact:true});
 const view=(await service.view(contactId,discussion.id))[0],trace=await discussions.trace(contactId,discussion.id,view.requestId);
 console.log(`PRECALL_PROFILE_RESULT ${JSON.stringify({startedAt,finishedAt:performance.now(),loadedSkills:view.loadedSkills.map(skill=>({name:skill.name,relativePath:skill.relativePath,origin:skill.origin,revisionNo:skill.revisionNo})),preloadedSkills:view.preloadedSkills,selectionEvents:trace.events.filter(event=>event.kind==='skill_selection').length,inputEvents:trace.events.filter(event=>event.kind==='skill_input').length,candidates:view.candidates.length,skillWarning:view.skillWarning})}`);
}
