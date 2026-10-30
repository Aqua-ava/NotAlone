import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SkillRunProtection,SkillRunScope,SkillRunRevision,SkillAnchor,SkillInput} from '../../skills/sqlite/contracts.ts';
import type {DiscussionAttempt} from './contracts.ts';
/** 真实调用/联系人/来源与Skill修订的具名短事务边界；原目录从不成为删除目标。 */
export class SqliteDiscussionSkillProtection implements SkillRunProtection {
 private readonly storage:SqliteStorage;private readonly attempt:DiscussionAttempt;private readonly contextId:string;private readonly callId:string;private readonly authorize:(scope:SkillRunScope)=>Promise<void>;
 constructor(options:{storage:SqliteStorage;attempt:DiscussionAttempt;contextId:string;callId:string;authorize:(scope:SkillRunScope)=>Promise<void>}){this.storage=options.storage;this.attempt=options.attempt;this.contextId=options.contextId;this.callId=options.callId;this.authorize=options.authorize;}
 private check(scope:SkillRunScope,signal?:AbortSignal){signal?.throwIfAborted();if(scope.ownerId!==this.attempt.ownerId||scope.contactId!==this.attempt.contactId||scope.callId!==this.callId)throw new StorageFailure('discussion_skill_scope_invalid');return {...this.attempt,contextId:this.contextId,callId:this.callId};}
 async assertCurrent(scope:SkillRunScope,runRevision:SkillRunRevision|null,signal?:AbortSignal){const input=this.check(scope,signal);await this.authorize(scope);signal?.throwIfAborted();await this.storage.execute('discussion.assertSkillCall',{...input,runRevision});signal?.throwIfAborted();}
 async recordSelection(scope:SkillRunScope,selected:SkillAnchor|null,signal?:AbortSignal){const input=this.check(scope,signal);await this.storage.execute('discussion.skillSelection',{...input,selected});signal?.throwIfAborted();}
 async recordInput(input:SkillInput,signal?:AbortSignal){const scope=this.check(input.scope,signal);await this.storage.execute('discussion.skillInput',{...scope,...input});signal?.throwIfAborted();}
}
