/** 历史来源与每轮生成共用同连接助手守卫；绑定资格由各自真实入口提供。 */
import {ReplyAssistantGuards,type ReplyAssistantPorts} from './reply-assistant-guards.ts';
import {requireCurrentReplyMemory} from '../context/reply-context-guards.ts';
import * as sources from './reply-source-guards.ts';
import {ReplyStoreError} from './reply-store.ts';
import type {createReplySkillGuards} from './reply-skill-guards.ts';
export function createReplyAssistantGuards(savedSkill:ReturnType<typeof createReplySkillGuards>,requireActiveBinding:ReplyAssistantPorts['requireActiveBinding']) {
 const ports:ReplyAssistantPorts={...sources,requireCurrentReplyMemory,
  requireReplySourcesCurrent:(client,scope,id,historical)=>sources.requireReplySourcesCurrent(client,scope,id,historical,(c,s,r)=>assistant.requireReplyDiscussionById(c,s,r)),
  readReplyBasisChanges:(client,scope,id)=>sources.readReplyBasisChanges(client,scope,id,savedSkill.savedSkillPolicyChange),
  requireSavedSkillPolicy:savedSkill.requireSavedSkillPolicy,requireActiveBinding,
  navigationDependencyIds:context=>{const ids=context.snapshot.navigation_dependency_ids;if(!Array.isArray(ids))throw new ReplyStoreError('reply_context_invalidated');return ids as string[];},
 };
 const assistant=new ReplyAssistantGuards(ports);return {assistant,ports};
}
