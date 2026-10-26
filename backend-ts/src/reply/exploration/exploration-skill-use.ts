/** 固定探索版本不等于用户手选；候选使用来历只取已确认的原B业务记录。 */
import type {Client} from 'pg';
import type {ReplyRequestInput} from '../generation/reply-contract.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import type {SkillUse} from '../../skills/skill-port.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import {parseExplorationInput} from './exploration-contract.ts';
export async function exploredSkillUse(client:Client,scope:VerifiedReplyScope,input:ReplyRequestInput,use:SkillUse|null):Promise<SkillUse|null>{
 if(!input.suggestion||use===null)return use;
 const ref=input.suggestion;
 const row=(await client.query(`SELECT skill_version_id,input_payload,state,selection_id FROM reply_exploration
  WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND input_version_id=$4 FOR SHARE`,[scope.owner_id,scope.contact_id,ref.task_id,ref.input_version])).rows[0];
 if(!row||!['selected','confirmed'].includes(row.state)||row.selection_id!==ref.suggestion_id||row.skill_version_id!==use.version_id||row.skill_version_id!==input.skill_version_id||row.input_payload?.skill_selection_complete!==undefined&&row.input_payload.skill_selection_complete!==true)throw new ReplyStoreError('exploration_stale');
 const original=parseExplorationInput(row.input_payload);
 if(!['auto','user'].includes(original.skill_mode))throw new ReplyStoreError('exploration_stale');
 return {...use,selection_method:original.skill_mode as 'auto'|'user',selection_reason:original.skill_mode==='auto'
  ?'方向探索根据当前已许可目录自动选择该版本；候选沿用同一固定版本并实际读取。'
  :'用户在方向探索明确选择该版本；候选沿用同一固定版本并实际读取。'};
}
