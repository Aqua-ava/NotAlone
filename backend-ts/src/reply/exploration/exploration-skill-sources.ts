/** 探索Skill沿历史实际回复的绑定复验讨论来源；不借当前请求绑定扩大许可。 */
import {SkillFiles} from '../../skills/skill-files.ts';
import {createReplySkillGuards} from '../generation/reply-skill-guards.ts';
import {createReplyAssistantGuards} from '../generation/reply-assistant-factory.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import type {SkillDiscussionValidator} from '../../skills/skill-source-proof.ts';
export function createExplorationSkillSourceValidator(skillsRoot:string):SkillDiscussionValidator {
 const files=new SkillFiles(skillsRoot);
 const requireDiscussionDependencies:SkillDiscussionValidator=async(client,owner,contact,request)=>{
  const saved=createReplySkillGuards({files,requireDiscussionDependencies});
  const {assistant}=createReplyAssistantGuards(saved,async(connection,scope)=>{
   if(scope.owner_id!==owner||scope.contact_id!==contact)throw new ReplyStoreError('reply_context_invalidated');
   const row=(await connection.query(`SELECT request.conversation_binding_id AS id FROM reply_request request
    WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3 AND (
     EXISTS(SELECT 1 FROM conversation_binding binding WHERE binding.id=request.conversation_binding_id
      AND binding.owner_id=request.owner_id AND binding.contact_id=request.contact_id AND binding.status='active')
     OR EXISTS(SELECT 1 FROM manual_contact_confirmation manual WHERE manual.id=request.conversation_binding_id
      AND manual.owner_id=request.owner_id AND manual.contact_id=request.contact_id))`,[request,owner,contact])).rows[0];
   if(!row)throw new ReplyStoreError('reply_context_invalidated');return row.id;
  });
  const dependencies=await assistant.requireReplyDiscussionById(client,{owner_id:owner,contact_id:contact},request);
  if(dependencies===null)throw new ReplyStoreError('reply_context_invalidated');return dependencies;
 };
 return requireDiscussionDependencies;
}
